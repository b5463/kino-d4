import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { newToken } from '../auth/tokens';
import { newId } from '../ids';
import { devices } from '../db/schema';
import { fail, invalidBody } from './errors';
import { registrationRateLimit } from '../plugins/rateLimits';

/**
 * Studio/account API — device registration (05 §4).
 *
 * There are no accounts to bind a device to (05 §12), so initial registration
 * is intentionally unauthenticated. It is rate-limited in every environment.
 *
 * Development/test use `rotate`, which keeps factory-reset work on a bench
 * convenient. Production fails closed to `first-write-wins`: an existing
 * printed serial returns 409 and its token hash is untouched, so this endpoint
 * cannot take over or brick a deployed device. Recovery is the explicit,
 * operator-controlled maintenance procedure in `infra/README.md`.
 */
const registerBody = z.object({
  serial: z.string().min(1).max(64),
  product: z.string().min(1).max(64),
  hardwareRevision: z.string().min(1).max(64),
  name: z.string().min(1).max(64).optional(),
});

export const studioDeviceRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/studio/devices/register', { config: registrationRateLimit }, async (request, reply) => {
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
