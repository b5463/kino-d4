import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, isNotNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { deviceOf } from '../auth/plugins';
import { createRoll } from '../rolls/rolls';
import { SLUG_PATTERN, normalizeSlug } from '../rolls/slug';
import { rollDevices, rolls } from '../db/schema';
import { fail, invalidBody } from './errors';

/**
 * Rolls as the camera sees them (03 §8, 03 §17).
 *
 * Three verbs and no more: start a roll, join one somebody else started, and
 * list the rolls this device is allowed to shoot into. Everything a *host*
 * does — rename, close, set a PIN — is deliberately absent, because a device
 * token must not host-moderate (07 §25). The boot-time check in `authPlugin`
 * enforces the URL half of that; the missing routes are the other half.
 */

/**
 * `.strict()`, here and on every body in this task: an unknown key is a 400,
 * not a silent drop. The field that makes this worth the strictness is
 * `privacy` — it is *derived* from `pin` rather than sent, so a client that
 * posts `privacy: 'pin'` and gets a 201 back would reasonably believe it had
 * locked the roll. Failing loudly is the only honest answer to that.
 */
const createBody = z
  .object({
    title: z.string().trim().min(1).max(120),
    /**
     * A PIN at creation is optional and, when present, is what makes the roll
     * `privacy: 'pin'`. Four characters minimum: see the note in `host-rolls.ts`.
     */
    pin: z.string().min(4).max(64).optional(),
    downloadsEnabled: z.boolean().optional(),
    reactionsEnabled: z.boolean().optional(),
  })
  .strict();

/**
 * Slugs are normalised, then validated before they reach the database. Not for
 * safety — drizzle parameterises — but so a typo answers 400 from a regex
 * instead of a table scan, and so the slug alphabet has exactly one definition.
 *
 * `normalizeSlug` is the same function the two guest-side resolution sites in
 * `auth/plugins.ts` use. A slug is hand-typed here more often than anywhere
 * else (it is read off another camera's screen), so the three sites agreeing on
 * case is the difference between "join failed" and "join worked".
 */
const joinBody = z
  .object({ slug: z.string().transform(normalizeSlug).pipe(z.string().regex(SLUG_PATTERN)) })
  .strict();

/** Which statuses a device is offered as "current". Closed rolls take no uploads. */
const OPEN_STATUS = 'live';

export const deviceRollRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/device/rolls', { preHandler: app.requireDevice }, async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);

    const created = await createRoll(app, parsed.data, deviceOf(request).id);

    // 201: this call always creates. The host token is in this response and in
    // no log line, no other response, and no row — only its sha256 is stored.
    return reply.code(201).send(created);
  });

  /**
   * Joining is what puts a second camera on the same roll. It writes the
   * `roll_devices` row that `requireDeviceRoll` looks for, so it is the only
   * way a device reaches a roll it did not create.
   *
   * Any existing roll may be joined, including a closed one: joining grants
   * *scope*, and whether a capture may actually be uploaded is decided once, at
   * upload time, by `assertRollAcceptsUploads`. Duplicating that decision here
   * would give two places for it to disagree.
   *
   * ## This is the system's sharpest unmetered edge — read before extending it
   *
   * The reply distinguishes 404 from 200, so this route is a slug oracle. What
   * makes it *the* one to fix first is that a hit is not information, it is
   * access: the 200 has already written the `roll_devices` row. There is no
   * second step left to defend.
   *
   * And the entry cost is zero — `POST /api/studio/devices/register` is
   * unauthenticated, so a device token is free. Slug + free token = write scope
   * on somebody else's roll, at whatever rate the network allows.
   *
   * Nothing here is wrong per the spec (03 §9 puts no PIN on device
   * assignment), and the fix is not a check in this handler — it is rate
   * limiting, Task 36, item 1 of the priority list in the README. Anything
   * added here that makes a hit cheaper or more distinguishable makes that
   * worse.
   */
  app.post('/api/device/rolls/join', { preHandler: app.requireDevice }, async (request, reply) => {
    const parsed = joinBody.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);

    const [roll] = await app.db
      .select({ id: rolls.id, title: rolls.title, status: rolls.status })
      .from(rolls)
      .where(eq(rolls.slug, parsed.data.slug))
      .limit(1);
    if (roll === undefined) return fail(reply, 404, 'ROLL_NOT_FOUND', 'no roll with that slug');

    // Idempotent: the composite primary key makes a second join a no-op rather
    // than a duplicate row or a 500.
    await app.db
      .insert(rollDevices)
      .values({ rollId: roll.id, deviceId: deviceOf(request).id })
      .onConflictDoNothing()
      .execute();

    return reply.send({ rollId: roll.id, title: roll.title, status: roll.status });
  });

  /**
   * "Operate on assigned/open Rolls" (03 §17) — the list a camera shows on its
   * touchscreen. Assigned means created-by *or* joined, which is the same OR
   * that `requireDeviceRoll` enforces; open means `live`.
   */
  app.get('/api/device/rolls/current', { preHandler: app.requireDevice }, async (request) => {
    const deviceId = deviceOf(request).id;

    const rows = await app.db
      .select({
        rollId: rolls.id,
        slug: rolls.slug,
        title: rolls.title,
        status: rolls.status,
        downloadsEnabled: rolls.downloadsEnabled,
        createdAt: rolls.createdAt,
      })
      .from(rolls)
      .leftJoin(
        rollDevices,
        and(eq(rollDevices.rollId, rolls.id), eq(rollDevices.deviceId, deviceId)),
      )
      .where(
        and(
          eq(rolls.status, OPEN_STATUS),
          or(eq(rolls.createdByDeviceId, deviceId), isNotNull(rollDevices.deviceId)),
        ),
      )
      .orderBy(desc(rolls.createdAt));

    // No slug-derived guest URL and no host token: a camera needs neither, and
    // the fewer places a host credential travels, the better.
    return { rolls: rows };
  });
};
