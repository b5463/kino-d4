import rateLimit from '@fastify/rate-limit';
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { bearerToken, hashToken } from '../auth/tokens';
import { guestIdOf } from '../captures/reactions';

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
  pinAttempt: { max: 5, timeWindow: '1 minute', groupId: 'pin-attempt' },
  registration: { max: 10, timeWindow: '1 minute', groupId: 'device-registration' },
  deviceJoin: { max: 30, timeWindow: '1 minute', groupId: 'device-join-ip' },
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
export const pinAttemptRateLimit = { rateLimit: RATE_LIMITS.pinAttempt };
export const registrationRateLimit = { rateLimit: RATE_LIMITS.registration };
export const deviceJoinRateLimit = { rateLimit: RATE_LIMITS.deviceJoin };
export const hostCreateRateLimit = { rateLimit: RATE_LIMITS.hostCreate };
export const deviceCreateRateLimit = {
  rateLimit: { ...RATE_LIMITS.deviceCreate, keyGenerator: deviceKey },
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
