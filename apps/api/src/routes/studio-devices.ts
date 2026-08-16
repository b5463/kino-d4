import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { newToken } from '../auth/tokens';
import { newId } from '../ids';
import { devices } from '../db/schema';

/**
 * Studio/account API — device registration (05 §4).
 *
 * This route is deliberately unauthenticated. In V1 the trust anchor is
 * **physical possession**: whoever holds the KINO can read its serial off the
 * back and is sitting in front of Studio with it plugged in over USB. There are
 * no accounts to bind a device to (05 §12), so there is nothing stronger to
 * check against, and inventing a shared registration secret would only move the
 * problem into a string shipped inside Studio.
 *
 * The consequence is that **re-registering an existing serial rotates the
 * token** — the row keeps its id, its `token_hash` is replaced, and the previous
 * token stops authenticating immediately. That is the intended behaviour, not a
 * loophole: it is how a device recovers after a factory reset or a lost token,
 * and it follows directly from possession being the anchor. Anyone who can
 * already reach this endpoint with a valid serial could equally register a
 * fresh one, so refusing to rotate would protect nothing while leaving real
 * devices permanently locked out.
 *
 * When accounts arrive, this is the first route to put behind them.
 */
const registerBody = z.object({
  serial: z.string().min(1).max(64),
  product: z.string().min(1).max(64),
  hardwareRevision: z.string().min(1).max(64),
  name: z.string().min(1).max(64).optional(),
});

export const studioDeviceRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/studio/devices/register', async (request, reply) => {
    const parsed = registerBody.safeParse(request.body);
    if (!parsed.success) {
      // Names the offending fields, never their values.
      const fields = parsed.error.issues
        .map((issue) => issue.path.join('.') || '(root)')
        .join(', ');
      return reply.code(400).send({ code: 'INVALID_BODY', message: `invalid or missing: ${fields}` });
    }

    const { serial, product, hardwareRevision, name } = parsed.data;
    const { token, hash } = newToken('kdt');

    const [row] = await app.db
      .insert(devices)
      .values({
        id: newId('dev'),
        serial,
        product,
        hardwareRevision,
        name: name ?? null,
        tokenHash: hash,
      })
      .onConflictDoUpdate({
        target: devices.serial,
        // `name` is only overwritten when the caller sent one, so re-registering
        // to rotate a token does not silently erase a name set earlier.
        set: { tokenHash: hash, product, hardwareRevision, ...(name === undefined ? {} : { name }) },
      })
      .returning({ id: devices.id });

    if (row === undefined) {
      // Unreachable: the upsert always writes a row. Guards the non-null read.
      return reply.code(500).send({ code: 'REGISTRATION_FAILED', message: 'device was not stored' });
    }

    // 200, not 201: the same call both creates and rotates, and a rotation
    // creates nothing. The token is in this response and nowhere else — the row
    // holds only its sha256 hash, so it can never be read back out.
    return reply.code(200).send({ deviceId: row.id, deviceToken: token });
  });
};
