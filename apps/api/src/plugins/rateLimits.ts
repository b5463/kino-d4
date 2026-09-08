import rateLimit from '@fastify/rate-limit';
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { bearerToken, hashToken, timingSafeHexEqual, tokenScope } from '../auth/tokens';
import { guestIdOf } from '../captures/reactions';
import { normalizeSlug } from '../rolls/slug';
import { devices } from '../db/schema';

export const RATE_LIMITS = {
  /**
   * What a *registered* camera gets on the five upload routes: 120 requests a
   * minute per device credential, per route.
   *
   * It was 60, and 60 throttled a real camera at a real party. The counter is
   * per method-and-route-pattern (`RedisStore.child` prefixes the Redis key
   * with the method and the route URL), so each of the five routes carries its
   * own budget, and what one grouped four-camera capture spends on each of them
   * is:
   *
   * ```text
   *   POST /api/device/rolls/:rollId/captures            1   (the capture row)
   *   POST /api/device/captures/:captureId/assets/init   5   (thumb + 4 frames)
   *   PUT  /api/device/uploads/:uploadId/parts/:partNo   5   (one part each)
   *   POST /api/device/uploads/:uploadId/complete        5
   *   POST /api/device/captures/:captureId/complete      1
   * ```
   *
   * Five assets, not four: `firmware/p4/main/roll_api.c` uploads a THUMB.JPG
   * before the frames (`RQ_STEP_UPLOAD_THUMB`, then one
   * `RQ_STEP_UPLOAD_FRAME` per camera). One part each, not more: `PART_SIZE` is
   * 5 MiB and a bench-measured D4 frame is 92–159 kB with a 7.6 kB thumb
   * (`firmware/HARDWARE_VALIDATION.md`), so every asset is a single part with
   * three orders of magnitude to spare.
   *
   * So the binding route is whichever of the three per-asset ones is busiest —
   * all three at 5 — and the sustained ceiling is `max / 5` captures a minute.
   * At 60 that was 12 a minute, one every 5.0 s. The camera shoots about 20 a
   * minute, and a run at 3 s pacing took 429s on `assets/init` from the 16th
   * capture on. At 120 the ceiling is 24 a minute, one every 2.5 s: faster than
   * the hardware can shoot, and 20 % of headroom over the 3 s target for the
   * firmware's own retries.
   *
   * Not larger, because the ceiling is what stops a leaked device token turning
   * the upload path into free object storage: `MAX_ASSET_BYTES` is 32 MiB and
   * this route budget is the only thing bounding how many of those arrive.
   *
   * The trusted number is handed out only to a credential the `devices` table
   * actually knows — see `deviceUploadMax` and `UNTRUSTED_DEVICE_UPLOAD_MAX`.
   */
  deviceUpload: { max: 120, timeWindow: '1 minute', groupId: 'device-upload' },
  guestRead: { max: 300, timeWindow: '1 minute', groupId: 'guest-read' },
  /**
   * The guest's one **write** that costs server work: `POST
   * /api/rolls/:slug/captures/:captureId/renders`.
   *
   * It carried the 300/min read budget, which is the wrong shape for it entirely.
   * That number is sized for scrolling — a gallery screen is a feed request and a
   * tile per capture — while this route enqueues a render: `render-wiggle-mp4` is
   * the heaviest job in the platform, and `render-social-formats` produces three
   * crops. The `jobKey` dedupe collapses repeats of the *same* capture and role,
   * so it is not a way to run one job a thousand times; walking a roll's captures
   * is, and 300 a minute is 300 MP4 encodes queued by one phone.
   *
   * 20 a minute is sized for the gesture it actually serves: a guest looking at a
   * photograph and tapping Save. Four renderable roles per capture (mp4 plus
   * three social crops) means five captures a minute fully rendered from one
   * phone, which is faster than anyone taps and slower than anyone can walk a
   * roll with. Keyed like the reads, so a phone is metered as itself where it has
   * a guest cookie and as its address otherwise.
   */
  guestRender: { max: 20, timeWindow: '1 minute', groupId: 'guest-render' },
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
   * A budget of their own rather than `deviceUpload`'s: a capture is seventeen
   * upload calls, and a status poll sharing that budget would ration the uploads
   * by the polling. 120 is one poll every half second. (The counter is per route —
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
  /**
   * `PATCH /api/host/rolls/:rollId`, keyed by the host token.
   *
   * Metered because of one field. `pin` re-hashes with scrypt on **every** PATCH
   * that names it — deliberately, so a rotated PIN invalidates every cookie
   * issued under the old salt — and scrypt is priced to be expensive. The
   * verifier pool in `auth/pins.ts` bounds how many run at once, which means an
   * unmetered PATCH loop does not burn the box: it fills that pool, and the queue
   * behind it is shared with `POST /api/rolls/:slug/pin`, so a leaked host token
   * could stall every guest at the door of every roll on the instance.
   *
   * 30 a minute against a host who edits a title, sets a PIN and closes the roll
   * — three or four PATCHes an event, a handful more if they are fiddling. It is
   * two orders of magnitude below what makes the verifier pool a bottleneck.
   */
  hostPatch: { max: 30, timeWindow: '1 minute', groupId: 'host-patch' },
  /**
   * `POST /api/host/rolls/:rollId/regenerate-slug`, keyed by the host token.
   *
   * `hostClear`'s number, for `hostClear`'s reason: it is destructive to
   * everybody else. One call bumps `access_epoch`, which 404s every copy of the
   * old link and refuses every stamp issued under it — so a host who taps it
   * three times has cut their guests off three times and has three links to
   * re-share. A person does this once, twice if the first answer was lost. Five a
   * minute is generous for that and a hard stop for a loop.
   */
  hostRotateSlug: { max: 5, timeWindow: '1 minute', groupId: 'host-rotate-slug' },
  /**
   * `GET /api/host/rolls/:rollId/export/:jobId/content`, keyed by the host token.
   *
   * This is the only route in the API that streams gigabytes: a 300-capture
   * party is roughly four. It holds a socket to storage and a socket to the
   * client for the whole transfer, and nothing about a second concurrent request
   * for the same ZIP is useful — a browser's download manager fetches it once.
   *
   * Six a minute leaves room for the real retry story (a download that failed at
   * 80 % and is started again, a host who moved to a laptop) while making
   * "stream the same 4 GB two hundred times" impossible on one token. Note that
   * the budget bounds *requests*, not bytes: a single stream still runs to
   * completion, which is what a host asked for.
   */
  hostExportDownload: { max: 6, timeWindow: '1 minute', groupId: 'host-export-download' },
  /**
   * `GET /api/host/rolls/:rollId/export/estimate`, keyed by the host token.
   *
   * An aggregate over every ready asset of every live capture of the roll — a
   * scan that grows with the party, on a table that is being written to while it
   * runs. It is deliberately not part of the dashboard payload for exactly that
   * reason, and leaving it unmetered gave back the cost the separation avoided.
   *
   * 30 a minute: the dashboard shows "≈17 GB, 9,400 files" next to a button, so
   * it is read on load and on a manual refresh, not polled.
   */
  hostExportEstimate: { max: 30, timeWindow: '1 minute', groupId: 'host-export-estimate' },
} as const;

/**
 * Redis keys never contain a bearer credential, even though the limit is per
 * token.
 *
 * Per credential and not per address on purpose: behind a tunnel or a venue
 * uplink many clients share one egress address, and four cameras on one uplink
 * share an address but not a token. It hashes whatever bearer is presented — it
 * cannot know whether the token is real, because it runs before authentication —
 * so a route whose allowance is worth stealing decides the *size* of the bucket
 * separately (`deviceUploadMax`).
 */
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

/**
 * What a bearer that is *not* a registered device gets on the upload routes:
 * the old 60 a minute, unchanged.
 *
 * The raised allowance belongs to a valid KINO camera, so it cannot be handed
 * out before the credential has been checked. `deviceKey` keys on the token
 * hash, which is the right key — but it hashes whatever bearer is presented,
 * including a made-up one, so on its own it would give every invented token a
 * fresh 120. Every request metered here is about to be refused by
 * `requireDevice` anyway; 60 is only what bounds the cost of refusing it.
 */
export const UNTRUSTED_DEVICE_UPLOAD_MAX = 60;

/**
 * The upload allowance for this request: 120 for a camera the `devices` table
 * knows, 60 for anything else.
 *
 * Decided here rather than after authentication because the limiter runs on
 * `onRequest`, before the body is parsed — which is the whole point of it on the
 * part route, where a body is 5 MiB. Moving the limiter to `preHandler` so it
 * could read `request.device` would mean buffering those 5 MiB for a request
 * that is about to be refused.
 *
 * The cost is one indexed single-row lookup on `devices.token_hash`, the same
 * one `requireDevice` is about to do; on a table with one row per camera that is
 * cheaper than the Redis round trip beside it. Tokens whose prefix is not `kdt`
 * are answered without touching the database at all. The comparison that decides
 * is the constant-time one, for the same reason it is in `requireDevice`: the
 * answer here is observable in `x-ratelimit-limit`.
 */
async function deviceUploadMax(request: FastifyRequest): Promise<number> {
  const token = bearerToken(request.headers.authorization);
  if (token === null || tokenScope(token) !== 'kdt') return UNTRUSTED_DEVICE_UPLOAD_MAX;

  const presented = hashToken(token);
  const row = await deviceRowFor(request, presented);

  return row !== null && timingSafeHexEqual(row.tokenHash, presented)
    ? RATE_LIMITS.deviceUpload.max
    : UNTRUSTED_DEVICE_UPLOAD_MAX;
}

/**
 * The `devices` row for the bearer this request presented, read **once**.
 *
 * The upload path looked it up twice per request. The limiter reads it in
 * `onRequest` to decide the bucket size, `requireDevice` reads it again in
 * `preHandler` to authenticate — the same index, the same row, the same
 * `token_hash` — and capture-create read it a third time by primary key for the
 * hardware revision it stamps into provenance. On the hottest route in the
 * platform (five inits, five parts and five completes per grouped capture, from
 * four cameras) that is fifteen wasted round trips a photograph on a pool of ten
 * connections.
 *
 * Cached on the request rather than in a process-wide map, deliberately: a
 * cache with a lifetime longer than one request is a cache that can serve a
 * revoked token, and a revoked token must stop working on the next request
 * rather than when something expires. The key is the *presented* hash, so a
 * request cannot be handed a row that belongs to a different credential, and the
 * constant-time comparison that actually grants access still happens at every
 * reader — this only saves the lookup, never the decision.
 */
export async function deviceRowFor(
  request: FastifyRequest,
  tokenHash: string,
): Promise<DeviceCredentialRow | null> {
  const cached = request.deviceRow;
  if (cached !== null && cached.tokenHash === tokenHash) return cached;

  const [row] = await request.server.db
    .select({
      id: devices.id,
      serial: devices.serial,
      product: devices.product,
      hardwareRevision: devices.hardwareRevision,
      tokenHash: devices.tokenHash,
    })
    .from(devices)
    .where(eq(devices.tokenHash, tokenHash))
    .limit(1);

  request.deviceRow = row ?? null;
  return request.deviceRow;
}

export const deviceUploadRateLimit = {
  rateLimit: { ...RATE_LIMITS.deviceUpload, keyGenerator: deviceKey, max: deviceUploadMax },
};

export const guestReadRateLimit = {
  rateLimit: { ...RATE_LIMITS.guestRead, keyGenerator: guestKey },
};
/** The render request's own bucket; see `RATE_LIMITS.guestRender`. */
export const guestRenderRateLimit = {
  rateLimit: { ...RATE_LIMITS.guestRender, keyGenerator: guestKey },
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
/**
 * `deviceKey` hashes whatever bearer is presented; a host token is one.
 *
 * All five host budgets below key on it for that reason: a host route always has
 * a credential, and the address is the wrong key — a venue's own uplink, or a
 * host and their guests behind one NAT, would share a bucket that belongs to a
 * token.
 */
export const hostClearRateLimit = {
  rateLimit: { ...RATE_LIMITS.hostClear, keyGenerator: deviceKey },
};
export const hostPatchRateLimit = {
  rateLimit: { ...RATE_LIMITS.hostPatch, keyGenerator: deviceKey },
};
export const hostRotateSlugRateLimit = {
  rateLimit: { ...RATE_LIMITS.hostRotateSlug, keyGenerator: deviceKey },
};
export const hostExportDownloadRateLimit = {
  rateLimit: { ...RATE_LIMITS.hostExportDownload, keyGenerator: deviceKey },
};
export const hostExportEstimateRateLimit = {
  rateLimit: { ...RATE_LIMITS.hostExportEstimate, keyGenerator: deviceKey },
};

/**
 * The columns of a `devices` row anything on the request path needs: the two
 * that identify the camera, the two that go into a capture's provenance, and the
 * hash that says which credential the row was found by.
 */
export interface DeviceCredentialRow {
  id: string;
  serial: string;
  product: string | null;
  hardwareRevision: string | null;
  tokenHash: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The `devices` row for the bearer on this request, or null before anything
     * has looked one up. Read through `deviceRowFor`, never directly — the cache
     * is only sound because that function keys it on the presented hash.
     */
    deviceRow: DeviceCredentialRow | null;
  }

  interface FastifyInstance {
    /**
     * The Redis key prefix this instance's counters live under.
     *
     * Decorated because a test that wants to expire a window has to address
     * exactly this server's keys: in `NODE_ENV=test` the namespace carries a
     * uuid, and a test that deleted by wildcard would reach into a parallel
     * suite's buckets. The full key is
     * `<nameSpace><METHOD><route pattern>-<key><groupId>`
     * (`RedisStore.child` in `@fastify/rate-limit`).
     */
    rateLimitNameSpace: string;
  }
}

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
    app.decorate('rateLimitNameSpace', nameSpace);
    // Declared here rather than in `authPlugin` because the limiter's
    // `onRequest` hook is the first thing to fill it, and `authPlugin` loads
    // after this one. Declared up front so every request object has the same
    // shape; Fastify deoptimises requests that grow new properties per-request.
    app.decorateRequest('deviceRow', null);
    await app.register(rateLimit, {
      global: false,
      redis: app.redis,
      nameSpace,
    });
  },
  { name: 'kino-rate-limits', dependencies: ['kino-redis'] },
);
