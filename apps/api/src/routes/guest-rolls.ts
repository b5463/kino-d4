import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { guestReadRateLimit } from '../plugins/rateLimits';
import { rollOf } from '../auth/plugins';
import { guestRollView } from '../rolls/rolls';
import { normalizeSlug } from '../rolls/slug';
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
 * two counters, because "somebody is guessing at one roll" and "somebody is
 * sweeping the slug space" are different attacks and one number could not
 * describe both. `request.ip` is the proxy-aware address, same as the rate
 * limiter's fallback key, so both follow `TRUST_PROXY`.
 *
 * ### 1. The miss count, keyed on address **and slug**
 *
 * It used to key on the address alone, and behind the relay every guest at a
 * venue is one address — so ten mistyped codes anywhere on the uplink took the
 * whole party's gallery away for an hour, including the roll they were standing
 * in. Adding the slug to the key makes the lock say what it actually means:
 * "this address has guessed at *this* code ten times". A venue's own slug is
 * never a miss, so a venue can no longer lock itself out of its own roll.
 *
 * ### 2. The sweep count, keyed on the address
 *
 * Splitting the first counter by slug would, on its own, hand an enumerator a
 * fresh budget for every code it tries, so it is not the whole control. The
 * sweep counter is: a hundred unknown slugs from one address in an hour and
 * that address loses the route entirely. The gap between the two numbers is the
 * point — a party where every phone fumbles a code twice produces a handful of
 * misses, while a walk of a six-character alphabet needs thousands.
 *
 * ### What a hit clears, and what it does not
 *
 * A hit clears **every** pair count this address is carrying, not just the one
 * for the slug that was found — which is the whole point of the split. A guest
 * who fumbles a code and then types it right is a guest who was never guessing,
 * and leaving the fumbled code's count standing would penalise exactly the
 * person the per-slug key exists to protect. Clearing only the found slug's own
 * key would be a no-op, since a slug that resolves has no miss count.
 *
 * That needs the missed slugs to be recoverable, so each miss also records its
 * slug in a per-address set (`guestMissIndexKey`). The set carries the same
 * hour as the counts and is dropped with them.
 *
 * The sweep count deliberately survives a hit: an enumerator that happens to
 * know one real slug would otherwise reset its own budget every ninety-nine
 * guesses.
 *
 * While locked, either way, the answer is the **same 404** a miss gets — a
 * distinct 429 would tell the walker exactly when its counter tripped, which is
 * a second oracle on top of the first.
 */

/** Guesses at one slug from one address before that pair is locked. */
const MISS_LIMIT = 10;
/** Unknown slugs from one address, across all slugs, before the address is locked. */
const SWEEP_LIMIT = 100;
/** How long a lock — and the count leading to it — lasts. */
const MISS_TTL_SECONDS = 60 * 60;

export function guestMissKey(ip: string, slug: string): string {
  return `roll-misses:${ip}:${slug}`;
}

export function guestSweepKey(ip: string): string {
  return `roll-sweep:${ip}`;
}

/**
 * The slugs this address has missed, so a later hit can forgive all of them.
 *
 * A set rather than a `SCAN` over `roll-misses:<ip>:*`: `SCAN` on a shared
 * Redis walks every key in the keyspace to answer one 200, which is not
 * something a guest read should ever do.
 */
export function guestMissIndexKey(ip: string): string {
  return `roll-miss-slugs:${ip}`;
}

/** The `:slug` this request is about, canonicalised so casing shares one key. */
function slugOf(request: FastifyRequest): string {
  const params: unknown = request.params;
  const raw =
    typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>)['slug']
      : undefined;
  return typeof raw === 'string' ? normalizeSlug(raw) : '';
}

const notFound = (reply: FastifyReply): FastifyReply =>
  fail(reply, 404, 'ROLL_NOT_FOUND', 'no roll with that slug');

export const guestRollRoutes: FastifyPluginAsync = async (app) => {
  /** Before the slug is even looked up: a locked caller gets the miss answer. */
  const refuseLockedAddress = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> => {
    const [misses, sweep] = await app.redis.mget(
      guestMissKey(request.ip, slugOf(request)),
      guestSweepKey(request.ip),
    );
    if (Number(misses) >= MISS_LIMIT || Number(sweep) >= SWEEP_LIMIT) return notFound(reply);
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
    const slug = slugOf(request);
    const indexKey = guestMissIndexKey(request.ip);

    if (reply.statusCode === 404) {
      const key = guestMissKey(request.ip, slug);
      const misses = await app.redis.incr(key);
      if (misses === 1) await app.redis.expire(key, MISS_TTL_SECONDS);

      // Remembered so a later hit can clear this count too.
      await app.redis.sadd(indexKey, slug);
      await app.redis.expire(indexKey, MISS_TTL_SECONDS);

      const sweepKey = guestSweepKey(request.ip);
      const sweeps = await app.redis.incr(sweepKey);
      if (sweeps === 1) await app.redis.expire(sweepKey, MISS_TTL_SECONDS);
    } else if (reply.statusCode === 200 || reply.statusCode === 401) {
      /**
       * Every count this address was carrying, not just this slug's. Somebody
       * who types a working code was fumbling, not sweeping — and the slug that
       * just resolved has no count of its own to clear, so clearing only that
       * one would forgive nothing at all.
       *
       * The sweep count is untouched on purpose; see the note above.
       */
      const missed = await app.redis.smembers(indexKey);
      const keys = missed.map((code) => guestMissKey(request.ip, code));
      await app.redis.del(indexKey, ...keys);
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
