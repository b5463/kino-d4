import rateLimit from '@fastify/rate-limit';
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { bearerToken, hashToken } from '../auth/tokens';
import { guestIdOf } from '../captures/reactions';
import { normalizeSlug } from '../rolls/slug';

export const RATE_LIMITS = {
  deviceUpload: { max: 60, timeWindow: '1 minute', groupId: 'device-upload' },
  guestRead: { max: 300, timeWindow: '1 minute', groupId: 'guest-read' },
  /**
   * Media, on its own budget.
   *
   * One gallery screen is one feed request and a tile per capture, and opening a
   * capture is another handful — so a guest who scrolls a 300-photo roll spends
   * hundreds of *media* fetches against a couple of dozen API calls. Sharing one
   * bucket meant the cheap JSON reads were rationed by the expensive image
   * traffic, and a household or a venue behind one NAT address hit 429 on its
   * own photos. Media gets its own, much larger allowance; the JSON reads keep
   * theirs, so exhausting one no longer closes the other.
   *
   * Large, not unlimited: this route signs a URL (or proxies bytes) after three
   * joined rows, so it is not free, and the ceiling is what stops one client
   * turning the bucket into an egress tap.
   */
  assetContent: { max: 3_000, timeWindow: '1 minute', groupId: 'asset-content' },
  /**
   * PIN attempts, keyed by address **and roll** (see `pinAttemptKey` below).
   *
   * It was five a minute per address, and behind the relay every guest at a
   * venue is one address: thirty phones typing the right PIN at the doors is
   * thirty requests a minute from one key, and twenty-five of them got a 429 on
   * a PIN they had typed correctly. Meanwhile a distributed attacker still had
   * five guesses per address per minute against a four-digit PIN, because
   * nothing counted attempts against the roll.
   *
   * So the two halves are now split between two mechanisms. This one is a
   * *request* limit, sized for a crowd (sixty a minute per address per roll) and
   * scoped so a venue cannot exhaust its own budget by succeeding. The
   * brute-force limit is `auth/pinLockout.ts`: ten wrong PINs close that roll's
   * gate for fifteen minutes no matter where they came from — which is the
   * control a botnet cannot spread its way around.
   */
  pinAttempt: { max: 60, timeWindow: '1 minute', groupId: 'pin-attempt' },
  registration: { max: 10, timeWindow: '1 minute', groupId: 'device-registration' },
  /**
   * Roll join, keyed by device token rather than by address (`groupId` renamed
   * from `device-join-ip` to match). Four cameras on one venue uplink share an
   * address but not a credential, and this route is behind `requireDevice`, so
   * there is always a credential to charge it to.
   */
  deviceJoin: { max: 30, timeWindow: '1 minute', groupId: 'device-join' },
  hostCreate: { max: 60, timeWindow: '1 minute', groupId: 'host-create' },
  /**
   * Roll creation from a camera — `hostCreate`'s bucket, keyed by credential
   * rather than by address: four cameras on one venue uplink share an address
   * but not a token.
   *
   * Deliberately the same 60 as the host web rather than the tighter ~10 a rig
   * needs in practice (a roll is started once an event, and a firmware retry that
   * lost its answer will try a handful of times). Two reasons. The property that
   * matters is that the endpoint is *bounded and charged to a credential* — it
   * had no limit at all, which made it the cheapest way to fill the `rolls`
   * table — and past that, the number is a guess about clients that also includes
   * a bench: the acceptance suite creates thirty rolls on one token in a few
   * seconds, and a limit that turns a legitimate test rig into 429s is a limit
   * somebody will disable rather than tune. 60 is still four orders of magnitude
   * below what an abuser wants from an unmetered endpoint.
   */
  deviceCreate: { max: 60, timeWindow: '1 minute', groupId: 'device-create' },
  /**
   * The camera's two reads — a capture's status and its roll list — keyed by
   * credential like every other device route. They were the last unmetered
   * device endpoints, and a status poll is exactly what firmware loops on.
   *
   * A budget of their own rather than `deviceUpload`'s: a capture is a dozen
   * upload calls, and a status poll sharing that 60 would ration the uploads by
   * the polling. 120 is one poll every half second. (The counter is per route —
   * `@fastify/rate-limit` keys its Redis store by method and URL — so each of
   * the two reads gets the full 120; `groupId` names the budget, it does not
   * pool it.)
   */
  deviceRead: { max: 120, timeWindow: '1 minute', groupId: 'device-read' },
  /**
   * Clearing a roll, keyed by the host token. One UPDATE over every capture of
   * the roll plus an audit row per capture; a host does it once, maybe twice
   * when the first answer was lost. Five a minute is generous for a person and
   * a hard stop for a script holding a leaked token.
   */
  hostClear: { max: 5, timeWindow: '1 minute', groupId: 'host-clear' },
} as const;

/** Redis keys never contain a bearer credential, even though the limit is per token. */
function deviceKey(request: FastifyRequest): string {
  const token = bearerToken(request.headers.authorization);
  return token === null ? `ip:${request.ip}` : `token:${hashToken(token)}`;
}

/**
 * The guest's own budget where there is one, the source address otherwise.
 *
 * The cookie id is the better key when it exists: it survives a phone moving
 * from Wi-Fi to cellular mid-gallery, and it stops one visitor on a shared
 * address spending everyone else's allowance. It is signed, so it cannot be
 * invented to buy a fresh bucket — an unsigned or forged value fails
 * `guestIdOf` and falls back to the address, which is the honest fallback:
 * a guest with no cookie has offered nothing to meter but where it came from.
 *
 * Deliberately does NOT mint an id. `ensureGuestId` writes a cookie, and a rate
 * limiter is not a thing that should be handing out browser state — most guests
 * therefore key on their address until they react to something, which is the
 * same behaviour as before this existed.
 */
function guestKey(request: FastifyRequest): string {
  // `@fastify/cookie` decorates `cookies` with null and fills it from its own
  // onRequest hook, so this reads null rather than a jar if the plugin order in
  // `buildServer` ever puts the limiter's hook first. Falling back to the
  // address is the right answer to that, and a great deal better than a
  // TypeError inside a rate limiter — which would 500 every metered route.
  const guestId = request.cookies === null ? null : guestIdOf(request);
  return guestId === null ? `ip:${request.ip}` : `guest:${guestId}`;
}

export const deviceUploadRateLimit = {
  rateLimit: { ...RATE_LIMITS.deviceUpload, keyGenerator: deviceKey },
};

export const guestReadRateLimit = {
  rateLimit: { ...RATE_LIMITS.guestRead, keyGenerator: guestKey },
};
export const assetContentRateLimit = {
  rateLimit: { ...RATE_LIMITS.assetContent, keyGenerator: guestKey },
};
/**
 * Address plus the roll being unlocked.
 *
 * A guest at a venue is metered against the roll they are actually opening, so
 * the party's own traffic cannot be exhausted by anything else on the same
 * uplink, and an attacker cycling rolls from one address gets a fresh bucket
 * per roll — which is fine, because the per-roll lockout in
 * `auth/pinLockout.ts` is what bounds *that*, and it is indifferent to source.
 *
 * The raw `:slug` is normalised so `ABC123` and `abc123` share one bucket
 * rather than two.
 */
function pinAttemptKey(request: FastifyRequest): string {
  const params: unknown = request.params;
  const raw =
    typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>)['slug']
      : undefined;
  const slug = typeof raw === 'string' ? normalizeSlug(raw) : '';
  return `ip:${request.ip}:slug:${slug}`;
}

export const pinAttemptRateLimit = {
  rateLimit: { ...RATE_LIMITS.pinAttempt, keyGenerator: pinAttemptKey },
};
export const registrationRateLimit = { rateLimit: RATE_LIMITS.registration };
/** Charged to the camera's own token; see `RATE_LIMITS.deviceJoin`. */
export const deviceJoinRateLimit = {
  rateLimit: { ...RATE_LIMITS.deviceJoin, keyGenerator: deviceKey },
};
export const hostCreateRateLimit = { rateLimit: RATE_LIMITS.hostCreate };
export const deviceCreateRateLimit = {
  rateLimit: { ...RATE_LIMITS.deviceCreate, keyGenerator: deviceKey },
};
export const deviceReadRateLimit = {
  rateLimit: { ...RATE_LIMITS.deviceRead, keyGenerator: deviceKey },
};
/** `deviceKey` hashes whatever bearer is presented; a host token is one. */
export const hostClearRateLimit = {
  rateLimit: { ...RATE_LIMITS.hostClear, keyGenerator: deviceKey },
};

/** Shared Redis-backed limits, disabled globally and opted into by route. */
export const rateLimitsPlugin = fp(
  async (app) => {
    // Parallel Vitest servers share the development Redis instance. Give each
    // one an isolated namespace so localhost traffic in an unrelated suite
    // cannot exhaust another suite's limits. Deployed replicas deliberately
    // retain one stable namespace and therefore enforce one shared budget.
    const nameSpace =
      app.config.NODE_ENV === 'test'
        ? `kino-rate-limit-test-${process.pid}-${randomUUID()}-`
        : 'kino-rate-limit-';
    await app.register(rateLimit, {
      global: false,
      redis: app.redis,
      nameSpace,
    });
  },
  { name: 'kino-rate-limits', dependencies: ['kino-redis'] },
);
