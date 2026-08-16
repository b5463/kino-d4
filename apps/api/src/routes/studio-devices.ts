import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { newToken } from '../auth/tokens';
import { newId } from '../ids';
import { devices } from '../db/schema';

/**
 * Studio/account API — device registration (05 §4).
 *
 * This route is unauthenticated, and re-registering an existing serial ROTATES
 * that device's token. Both are V1 decisions taken deliberately: there are no
 * accounts to bind a device to (05 §12), and rotation is how a real device
 * recovers after a factory reset or a lost token.
 *
 * ## The risk this accepts — state it plainly
 *
 * Anyone who can reach this endpoint and supply an **existing** serial takes
 * over that device. Concretely, one unauthenticated POST:
 *
 * - returns a working `kdt_` token for the existing `deviceId`, granting the
 *   caller every roll that device created or joined (`roll_devices`);
 * - **bricks the real device** — its token stops authenticating at once, and
 *   the hardware has no way to notice or re-enrol on its own;
 * - is self-verifying for an attacker: the response echoes the `deviceId`, so a
 *   hit on an existing serial is instantly distinguishable from a new
 *   registration.
 *
 * And serials are neither secret nor unguessable. They are printed on the
 * outside of the device and sequential (`KD4-00001`), so the whole space is
 * walkable — this is enumeration against a counter, not a search.
 *
 * That is a takeover, not merely a rotation. What it is NOT is a reason to
 * refuse rotation on its own: an attacker who can reach this endpoint can also
 * register serials that do not exist yet, pre-claiming the fleet. Blocking
 * re-registration alone would leave real devices bricked after a reset while
 * closing none of that off. The fix is authentication on the endpoint, not a
 * conditional on the write — and that fix is Task 36's, tracked in the task 16
 * report's handoff section (rate limiting AND either a registration secret or
 * first-write-wins serial claiming).
 *
 * Until then this endpoint is the weakest link in the device trust chain, and
 * it should be treated as such in any deployment that is reachable publicly.
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
