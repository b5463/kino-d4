import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { bearerToken, newToken, timingSafeSecretEqual } from '../auth/tokens';
import { newId } from '../ids';
import { devices } from '../db/schema';
import { fail, invalidBody } from './errors';
import { registrationRateLimit } from '../plugins/rateLimits';

/**
 * Studio/account API — device registration (05 §4).
 *
 * There are no accounts to bind a device to (05 §12), so there is no user
 * identity to check here. What there is instead is a **provisioning secret**:
 * this call mints a device token, which is a credential for the upload API, and
 * an endpoint that mints credentials for anyone who can reach it is a way to
 * fill the platform with cameras nobody built. `PROVISIONING_TOKEN` is what a
 * factory bench presents, and it is compared constant-time.
 *
 * ## The assumption, stated
 *
 * One shared secret proves the caller is *a* provisioning station, never which
 * one. So a leaked bench secret registers devices exactly as the bench does, and
 * rotating it means re-flashing every station. The follow-up is a per-serial
 * HMAC — the station signs the serial with its own key and the API verifies
 * against a station registry — which is deliberately not here: V1 has no table
 * to hold stations, and inventing one to hold a single row would be worse than
 * naming the limitation.
 *
 * Development/test use `rotate`, which keeps factory-reset work on a bench
 * convenient. Production fails closed to `first-write-wins`: an existing
 * printed serial returns 409 and its token hash is untouched, so this endpoint
 * cannot take over or brick a deployed device. Recovery is the explicit,
 * operator-controlled maintenance procedure in `infra/README.md`.
 *
 * The rate limit stays, and it is not redundant: it bounds a caller who *has*
 * the secret, which is the only caller that gets past the gate at all.
 */
const registerBody = z.object({
  serial: z.string().min(1).max(64),
  product: z.string().min(1).max(64),
  hardwareRevision: z.string().min(1).max(64),
  name: z.string().min(1).max(64).optional(),
});

export const studioDeviceRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/studio/devices/register', { config: registrationRateLimit }, async (request, reply) => {
    // Before the body is even parsed: an unauthorized caller learns nothing
    // about which fields this endpoint wants.
    const presented = bearerToken(request.headers.authorization);
    if (presented === null || !timingSafeSecretEqual(presented, app.config.PROVISIONING_TOKEN)) {
      return fail(
        reply,
        401,
        'PROVISIONING_TOKEN_REQUIRED',
        'expected Authorization: Bearer <provisioning token>',
      );
    }

    const parsed = registerBody.safeParse(request.body);
    // Names the offending fields, never their values.
    if (!parsed.success) return invalidBody(reply, parsed.error);

    const { serial, product, hardwareRevision, name } = parsed.data;
    const { token, hash } = newToken('kdt');

    const insert = app.db
      .insert(devices)
      .values({
        id: newId('dev'),
        serial,
        product,
        hardwareRevision,
        name: name ?? null,
        tokenHash: hash,
      })
    const [row] = await (app.config.DEVICE_REGISTRATION_MODE === 'first-write-wins'
      ? insert.onConflictDoNothing({ target: devices.serial }).returning({ id: devices.id })
      : insert
          .onConflictDoUpdate({
            target: devices.serial,
            // `name` is only overwritten when the caller sent one, so re-registering
            // to rotate a token does not silently erase a name set earlier.
            set: {
              tokenHash: hash,
              product,
              hardwareRevision,
              ...(name === undefined ? {} : { name }),
            },
          })
          .returning({ id: devices.id }));

    if (row === undefined) {
      if (app.config.DEVICE_REGISTRATION_MODE === 'first-write-wins') {
        return fail(
          reply,
          409,
          'DEVICE_ALREADY_REGISTERED',
          'this device is already registered; use the recovery procedure',
        );
      }
      return fail(reply, 500, 'REGISTRATION_FAILED', 'device was not stored');
    }

    // 200, not 201: the same call both creates and rotates, and a rotation
    // creates nothing. The token is in this response and nowhere else — the row
    // holds only its sha256 hash, so it can never be read back out.
    return reply.code(200).send({ deviceId: row.id, deviceToken: token });
  });
};
