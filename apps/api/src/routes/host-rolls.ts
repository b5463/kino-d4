import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { publicRollColumns, rollOf, type PublicRollRow } from '../auth/plugins';
import { hashPin } from '../auth/pins';
import {
  HOST_ROLL_STATUSES,
  auditRows,
  canTransition,
  createRoll,
  guestUrlFor,
  hostRollView,
  regenerateSlug,
  statusAuditAction,
  type AuditEntry,
  type HostRollView,
} from '../rolls/rolls';
import { rollCaptureCounts } from '../uploads/uploads';
import { countRollViewers } from '../events/viewers';
import { auditEvents, rolls } from '../db/schema';
import { fail, invalidBody } from './errors';

/**
 * The host dashboard's API (03 §10).
 *
 * Every route but creation is authenticated by `requireHost`, whose token is
 * per-roll: there are no accounts in V1 (05 §12), so a host token opens exactly
 * one roll and there is nothing to enumerate. `authPlugin`'s boot check refuses
 * to start if any of these drifts out of `/api/host/`.
 */

/** Same shape and same `.strict()` reasoning as the device create body. */
const createBody = z
  .object({
    title: z.string().trim().min(1).max(120),
    pin: z.string().min(4).max(64).optional(),
    downloadsEnabled: z.boolean().optional(),
    reactionsEnabled: z.boolean().optional(),
  })
  .strict();

/**
 * `pin` is three-valued and the difference matters:
 *
 *   absent  — leave the PIN alone
 *   string  — set or replace it
 *   null    — remove it, returning the roll to `unlisted`
 *
 * `.nullable().optional()` is what encodes that in zod; collapsing the last two
 * would make "clear the PIN" unexpressible.
 *
 * Four characters minimum. The spec asks only for a "short PIN" (03 §9), but
 * this is the one place in the system where a PIN is ever chosen, so it is the
 * only place a floor can be set — and a one-character PIN is 31 guesses, which
 * no amount of scrypt makes acceptable. Rate limiting (Task 36) is the other
 * half of that defence; neither substitutes for the other.
 */
const patchBody = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    pin: z.string().min(4).max(64).nullable().optional(),
    downloadsEnabled: z.boolean().optional(),
    status: z.enum(HOST_ROLL_STATUSES).optional(),
  })
  .strict();

export const hostRollRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Roll creation from the host web (03 §8). Unauthenticated by design: V1 has
   * no accounts, so there is no identity to check — the call *mints* the
   * credential, exactly as device registration does.
   *
   * That means anyone who can reach this endpoint can create rolls, which is a
   * spam/storage-exhaustion surface and not a data-exposure one: a roll created
   * this way is reachable only through the host token in the response, which
   * the caller already holds. Rate limiting is Task 36's, and this route is one
   * of the two that need it most (the other is device registration).
   */
  app.post('/api/host/rolls', async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);

    // No device behind a web-created roll, so `createdByDeviceId` stays null.
    const created = await createRoll(app, parsed.data, null);
    return reply.code(201).send(created);
  });

  app.get('/api/host/rolls/:rollId', { preHandler: app.requireHost('rollId') }, async (request) => {
    const roll = rollOf(request);
    return dashboard(app, roll);
  });

  app.patch(
    '/api/host/rolls/:rollId',
    { preHandler: app.requireHost('rollId') },
    async (request, reply) => {
      const parsed = patchBody.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);

      const { title, pin, downloadsEnabled, status } = parsed.data;
      const roll = rollOf(request);

      // `{}` is a client bug, not a no-op worth a 200: a PATCH that changes
      // nothing is almost always a field name that was spelled wrong — and
      // `.strict()` above turns the misspelling itself into a 400 too.
      if (Object.keys(parsed.data).length === 0) {
        return fail(
          reply,
          400,
          'NO_UPDATE_FIELDS',
          'send at least one of: title, pin, downloadsEnabled, status',
        );
      }

      const patch: Partial<typeof rolls.$inferInsert> = {};
      const audit: AuditEntry[] = [];
      const entry = (action: AuditEntry['action'], target?: string | null): void => {
        audit.push({ rollId: roll.id, actor: 'host', action, target: target ?? null });
      };

      if (title !== undefined && title !== roll.title) {
        patch.title = title;
        // The old title, not the new one — the new one is in the row.
        entry('roll.renamed', roll.title);
      }

      if (pin !== undefined) {
        // Always re-hashes, even for the same PIN. That is load-bearing, not
        // wasteful: the guest cookie is a fingerprint of the stored hash, so a
        // fresh salt invalidates every session issued under the old one — which
        // is precisely what a host rotating a leaked PIN is asking for.
        patch.pinHash = pin === null ? null : await hashPin(pin);
        patch.privacy = pin === null ? 'unlisted' : 'pin';
        // The PIN itself never reaches the audit target, or any other string.
        entry(pin === null ? 'roll.pin-cleared' : 'roll.pin-changed');
      }

      if (downloadsEnabled !== undefined && downloadsEnabled !== roll.downloadsEnabled) {
        patch.downloadsEnabled = downloadsEnabled;
        entry(downloadsEnabled ? 'roll.downloads-enabled' : 'roll.downloads-disabled');
      }

      if (status !== undefined) {
        if (!canTransition(roll.status, status)) {
          return fail(
            reply,
            400,
            'INVALID_STATE',
            `a ${roll.status} roll cannot become ${status}`,
          );
        }
        if (status !== roll.status) {
          patch.status = status;
          // `closedAt` is the timestamp of the *current* closure, so reopening
          // clears it rather than leaving a stale one behind. Archiving keeps
          // whatever closing set, because an archived roll is still closed.
          if (status === 'closed') patch.closedAt = new Date();
          if (status === 'live') patch.closedAt = null;
          entry(statusAuditAction(status));
        }
      }

      const updated = await applyPatch(app, roll, patch, audit);
      return dashboard(app, updated);
    },
  );

  /**
   * Rotates the guest link (03 §10, "regenerate guest slug"). This is the
   * host's answer to a link that leaked: the old slug stops resolving the
   * instant the update lands, so every copy of it 404s.
   */
  app.post(
    '/api/host/rolls/:rollId/regenerate-slug',
    { preHandler: app.requireHost('rollId') },
    async (request) => {
      const slug = await regenerateSlug(app.db, rollOf(request));
      return { slug, guestUrl: guestUrlFor(app.config, slug) };
    },
  );
};

/**
 * The dashboard payload: the roll, its capture counts and its live guest count.
 *
 * One function for both routes so the GET and the PATCH cannot answer with
 * different shapes — a host UI that re-renders from a PATCH response would
 * otherwise lose whichever number the PATCH forgot.
 *
 * The two reads run concurrently: they hit different servers and neither depends
 * on the other, so serialising them would make every dashboard render cost the
 * sum of two round trips instead of the larger one.
 *
 * A Redis failure reports **0 guests** rather than failing the dashboard, and
 * that is an honest degradation rather than a convenient one: the viewer set is
 * maintained only by live SSE connections, which need the same Redis, so if it
 * is unreachable there are no guests connected to count. `/api/healthz` is where
 * the outage itself is visible.
 */
async function dashboard(app: FastifyInstance, roll: PublicRollRow): Promise<HostRollView> {
  const [counts, guests] = await Promise.all([
    rollCaptureCounts(app.db, roll.id),
    countRollViewers(app.redis, roll.id).catch((err: unknown) => {
      app.log.warn({ err, rollId: roll.id }, 'guest count unavailable; reporting zero');
      return 0;
    }),
  ]);
  return hostRollView(app.config, roll, counts, guests);
}

/**
 * Writes the update and its audit rows together, or neither.
 *
 * A transaction because an audit trail that can lose entries when a later
 * statement fails is worse than none — it reads as authoritative while being
 * incomplete. Returns the fresh row through `publicRollColumns`, the same
 * projection `request.roll` uses, so no credential hash can ride back out.
 */
async function applyPatch(
  app: FastifyInstance,
  roll: PublicRollRow,
  patch: Partial<typeof rolls.$inferInsert>,
  audit: readonly AuditEntry[],
): Promise<PublicRollRow> {
  if (Object.keys(patch).length === 0) {
    // Every field matched what was already stored. An audit entry without a
    // corresponding column change would mean the trail is recording something
    // that did not happen — a wiring bug, not a request to serve quietly.
    if (audit.length > 0) throw new Error('audit entries were produced with no row change');
    return roll;
  }

  return app.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(rolls)
      .set(patch)
      .where(eq(rolls.id, roll.id))
      .returning(publicRollColumns);

    if (updated === undefined) {
      // `requireHost` already resolved this row, so it cannot vanish mid-request
      // without something being very wrong. Rolling back is the honest answer.
      throw new Error(`roll ${roll.id} disappeared during update`);
    }
    if (audit.length > 0) await tx.insert(auditEvents).values(auditRows(audit));

    return updated;
  });
}
