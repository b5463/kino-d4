import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { guestReadRateLimit } from '../plugins/rateLimits';
import { rollOf } from '../auth/plugins';
import { guestRollView } from '../rolls/rolls';
import { visibleCaptureCount } from '../uploads/uploads';
import { fail } from './errors';

/**
 * The guest's view of a roll (03 §6, 03 §9).
 *
 * No authentication: the secret URL *is* the access control for an unlisted
 * roll, and `guestRollAccess` adds the PIN gate on top for a roll that has one.
 * A guest is anonymous (03 §18) and this route establishes no identity.
 *
 * A **closed** roll still answers 200 here. That is 03 §22 read literally —
 * closing stops uploads, it does not take the gallery away from the people who
 * were at the party. The upload side of that same rule is
 * `assertRollAcceptsUploads`, which Task 18 puts in front of the capture
 * routes.
 *
 * `X-Robots-Tag: noindex, nofollow` is not set here: it is set for the whole
 * `/api/rolls/` space by `robotsPlugin`, so a route added later cannot forget
 * it. See `rolls/robots.ts`.
 *
 * ## Enumeration controls
 *
 * The 404 for an unknown slug makes this route a slug oracle, and the 300/min
 * read bucket alone lets one address test 18 000 codes an hour. So it carries
 * the same second counter the device join route has (`device-rolls.ts`), keyed
 * by client address because a guest has no credential: ten unknown slugs lock
 * that address out for an hour, and a hit clears the count. `request.ip` is
 * the proxy-aware address, same as the rate limiter's fallback key, so it
 * follows `TRUST_PROXY`.
 *
 * While locked the answer is the **same 404** a miss gets — a distinct 429 would
 * tell the walker exactly when its counter tripped, which is a second oracle
 * on top of the first. The cost is honest and named: a venue whose shared
 * address is being used to walk the slug space loses this route for an hour.
 */

/** Unknown slugs before the address is locked; the join route uses the same ten. */
const MISS_LIMIT = 10;
/** How long a lock — and the count leading to it — lasts. */
const MISS_TTL_SECONDS = 60 * 60;

export function guestMissKey(ip: string): string {
  return `roll-misses:${ip}`;
}

const notFound = (reply: FastifyReply): FastifyReply =>
  fail(reply, 404, 'ROLL_NOT_FOUND', 'no roll with that slug');

export const guestRollRoutes: FastifyPluginAsync = async (app) => {
  /** Before the slug is even looked up: a locked address gets the miss answer. */
  const refuseLockedAddress = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> => {
    const misses = Number(await app.redis.get(guestMissKey(request.ip)));
    if (Number.isFinite(misses) && misses >= MISS_LIMIT) return notFound(reply);
    return undefined;
  };

  /**
   * After the lookup: a 404 is a miss, anything that found the roll — 200, or
   * the 401 a PIN roll answers — is a hit and clears the count. `onSend`
   * rather than `onResponse` so the count is updated before the reply leaves,
   * which is what lets a test read it deterministically.
   */
  const countMiss = async (
    request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
  ): Promise<unknown> => {
    const key = guestMissKey(request.ip);
    if (reply.statusCode === 404) {
      const misses = await app.redis.incr(key);
      if (misses === 1) await app.redis.expire(key, MISS_TTL_SECONDS);
    } else if (reply.statusCode === 200 || reply.statusCode === 401) {
      await app.redis.del(key);
    }
    return payload;
  };

  app.get(
    '/api/rolls/:slug',
    {
      config: guestReadRateLimit,
      preHandler: [refuseLockedAddress, app.guestRollAccess],
      onSend: countMiss,
    },
    async (request) => {
      const roll = rollOf(request);
      return guestRollView(roll, await visibleCaptureCount(app.db, roll.id));
    },
  );
};
