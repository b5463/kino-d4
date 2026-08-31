import { eq } from 'drizzle-orm';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { FastifyRequest } from 'fastify';
import { ASSET_ROLES } from '@kino/schemas';
import type { KinoDatabase } from '../plugins/db';
import { guestHasRollAccess, guestMayReadRoll, hostTokenPresented } from '../auth/plugins';
import { assets, captures, rolls } from '../db/schema';

/**
 * Asset delivery — the one place in the platform where the rule of 05 §6,
 * "object key is not authorization", is actually enforced.
 *
 * Everything a guest sees names assets by `assetId`. The key never leaves the
 * database, and knowing one would buy nothing anyway: bytes are only ever
 * reachable through a URL this module signs, and it signs one only after the
 * chain **asset → capture → roll** has been walked and every gate on it has
 * answered yes.
 *
 * ## Why the checks cannot be a preHandler
 *
 * `guestRollAccess` keys on `:slug`, and this route has no slug — it is outside
 * `/api/rolls/` because an asset id is the only handle a client is given. The
 * roll therefore has to be *derived* from the asset, which means the query and
 * the gate are one step and both live here rather than in the route file. The
 * PIN rule itself is not re-implemented: `guestMayReadRoll` is the same function
 * the slug-based gate calls, so there is one definition of "may this anonymous
 * request read this roll" and one definition of the cookie format.
 *
 * ## The presigned URL contains the object key. That is not a leak.
 *
 * It cannot not contain it — the key is the path S3 is being asked for. What
 * 05 §6 forbids is treating the key as a credential, and it is not one here:
 * the URL carries a signature over the key, the method, the expiry and the
 * response headers, so possession of the key alone opens nothing. No **API**
 * response body ever contains a key.
 *
 * ## Recorded decision: the redirect discloses the internal rollId
 *
 * Keys are `rolls/<rollId>/captures/<captureId>/...`, so the `Location` header
 * hands a guest the two internal ids that every *body* on the guest surface
 * deliberately withholds — `GET /api/rolls/:slug` returns no id at all, and the
 * feed names captures but never their roll.
 *
 * Accepted for V1, deliberately rather than by accident, because the ids buy
 * nothing on their own: the bucket is private, so the only way to use a key is
 * with a signature this service issues after authorizing the request, and the
 * host routes that take a `rollId` all require a bearer token
 * (`requireHost` / `requireDeviceRoll`). A roll id is 128 random bits, so it is
 * not a handle to anything enumerable either.
 *
 * That reasoning rests on two conditions, and it must be revisited if **either**
 * changes: the bucket stays private, and it is not fronted by a CDN or any other
 * cache that could serve an object by key without a signature. Should either
 * stop holding, the fix is to stop redirecting — proxy the bytes, or sign keys
 * that carry an opaque id instead of the roll prefix.
 */

/** How long a signed URL lives. Long enough to fetch, short enough to be useless if shared. */
export const ASSET_URL_TTL_SECONDS = 60;

/**
 * How long the *redirect* may be cached, privately, so a gallery re-rendering
 * does not re-authorize every tile.
 *
 * **Invariant: cache lifetime must stay strictly below signature lifetime.**
 *
 * This is not a style preference. Browsers and service workers do cache a 302
 * that carries an explicit `Cache-Control`, so a value above
 * `ASSET_URL_TTL_SECONDS` means an `<img>` re-requested inside the cache window
 * replays the stored `Location`, follows an expired signature, and renders a
 * broken tile — for as long as the excess lasts, with nothing on the client able
 * to tell why. Task 28's PWA caches exactly this route, so the failure would be
 * routine rather than theoretical. Five seconds of headroom covers the clock
 * skew between signing here and validating at storage.
 */
export const ASSET_CACHE_MAX_AGE_SECONDS = 55;

export const ASSET_CACHE_CONTROL = `private, max-age=${ASSET_CACHE_MAX_AGE_SECONDS}`;

// Enforced at module load, so a future edit to either number fails the whole
// test suite rather than quietly shipping dead URLs.
if (ASSET_CACHE_MAX_AGE_SECONDS >= ASSET_URL_TTL_SECONDS) {
  throw new Error(
    `asset cache lifetime (${ASSET_CACHE_MAX_AGE_SECONDS}s) must stay below the signed URL's ` +
      `own lifetime (${ASSET_URL_TTL_SECONDS}s), or a cached redirect outlives its signature`,
  );
}

/**
 * The roles the host's download switch does **not** govern — and therefore, by
 * omission, every role it does (03 §25, "guest: according to host permission").
 *
 * The polarity is the point. An allow-list of gated roles is fail-OPEN: five
 * roles are already declared in `ASSET_ROLES` that no worker produces yet
 * (`wiggle-mp4`, `gif`, `contact-sheet`, `enhanced-still`, `enhanced-wiggle`),
 * and the day one of them appears it would be downloadable from a roll whose
 * host had switched downloads off — because nobody remembered to extend a list.
 * Naming the exceptions instead means a new role is gated by default and has to
 * be *argued* onto this list.
 *
 * Same reasoning as `UPLOADABLE_STATUSES` in `rolls/rolls.ts`: the safe reading
 * of an unfamiliar value is "refuse", not "allow because it is not on the
 * deny-list".
 *
 * These two are how the gallery renders at all — a roll whose downloads are off
 * is still a roll the guest was invited to look at.
 */
const NEVER_GATED_ROLES: ReadonlySet<string> = new Set(['thumb', 'wiggle-preview']);

/** Whether the host's download switch governs this role at all. */
function downloadGated(role: string): boolean {
  return !NEVER_GATED_ROLES.has(role);
}

/**
 * Roles whose *only* meaning is a download, so they default to an attachment
 * disposition with no `?download=1` needed.
 *
 * `original-frame` is the whole set. Nothing in the guest UI renders a full-size
 * untouched frame inline; asking for one is asking to keep it, and treating it
 * as an inline view would turn "downloads disabled" into a switch that anyone
 * could walk around by omitting a query parameter. A `kino-still`, by contrast,
 * genuinely is the gallery's own render, so it stays inline by default and is
 * gated only when asked for as a file.
 */
const ALWAYS_ATTACHMENT_ROLES: ReadonlySet<string> = new Set(['original-frame']);

/* ------------------------------------------------ what a guest may fetch -- */

export type AssetRole = (typeof ASSET_ROLES)[number];

/**
 * The roles that are part of the **guest** surface — the pixels a gallery draws
 * and the files a guest may keep.
 *
 * An allow-list, and here the polarity is the opposite way round from
 * `NEVER_GATED_ROLES` above, for a reason that is worth stating because the two
 * sit ten lines apart. That list answers "may this be *downloaded* when the host
 * said no?", where the harm of forgetting a role is a file saved that should not
 * have been. This one answers "may a stranger with a link *see* this at all?",
 * and the role that made it necessary is `metadata`: `extract-metadata` writes a
 * `metadata.json` asset carrying GPS EXIF, device serial and hardware revision,
 * every original frame's object key, and the capture's provenance — and it
 * arrived as an ordinary `ready` asset row, so the feed named its id to guests
 * and delivery signed a URL for it.
 *
 * So the failure directions are not comparable. A new role missing from this
 * list is invisible in the gallery until somebody adds it — a bug a tester finds
 * in a minute. A new *non-pixel* role missing from a deny-list is published to
 * the internet, silently, the day a worker first writes one. The typed element
 * makes the list impossible to leave stale in the other direction too: a role
 * renamed or removed from `ASSET_ROLES` is a compile error here.
 *
 * `metadata` is deliberately absent, and it is the only role absent today.
 */
const GUEST_VISIBLE_ROLES: ReadonlySet<AssetRole> = new Set<AssetRole>([
  'thumb',
  'kino-still',
  'original-frame',
  'wiggle-preview',
  'wiggle-webp',
  'wiggle-mp4',
  'gif',
  'contact-sheet',
  'enhanced-still',
  'enhanced-wiggle',
  'social-9x16',
  'social-4x5',
  'social-1x1',
]);

/**
 * Whether a role belongs on the guest surface at all.
 *
 * Read by `captures/feed.ts` as well as by `deliverAsset`, and that is the point
 * of exporting it: the feed decides which asset ids a guest is *told* about and
 * delivery decides which it may *fetch*, and those two answers disagreeing is
 * how an id ends up published to a 403. One definition, two readers.
 */
export function guestMaySeeRole(role: string): boolean {
  return GUEST_VISIBLE_ROLES.has(role as AssetRole);
}

/** `?download=1`. Accepted spellings are exact, so a stray value is not a download. */
export function wantsDownload(query: unknown): boolean {
  if (typeof query !== 'object' || query === null) return false;
  const raw = (query as Record<string, unknown>)['download'];
  return raw === '1' || raw === 'true';
}

export interface AssetDeliveryDeps {
  db: KinoDatabase;
  s3: S3Client;
  bucket: string;
  mode: 'presigned' | 'proxy';
}

export type AssetDelivery =
  | { ok: true; delivery: 'redirect'; url: string }
  | {
      ok: true;
      delivery: 'proxy';
      objectKey: string;
      mime: string;
      disposition: string;
    }
  | { ok: false; status: number; code: string; message: string };

function refuse(status: number, code: string, message: string): AssetDelivery {
  return { ok: false, status, code, message };
}

/**
 * `attachment; filename="kino-original-frame-cam-01.jpg"`, or `inline`.
 *
 * The extension is taken from the stored key's own suffix rather than re-derived
 * from the mime type: the key was built by `assetObjectKey`, which already
 * refused any mime it does not have an extension for, so this cannot disagree
 * with what is actually stored. The name itself is generated — it is not the
 * key, and it exposes nothing about where the object lives.
 */
function dispositionFor(role: string, frameIndex: number | null, objectKey: string): string {
  const dot = objectKey.lastIndexOf('.');
  const extension = dot < 0 ? 'bin' : objectKey.slice(dot + 1);
  const camera = frameIndex === null ? '' : `-cam-${String(frameIndex).padStart(2, '0')}`;
  return `attachment; filename="kino-${role}${camera}.${extension}"`;
}

/**
 * Resolves an asset to a signed URL, or to the reason it will not be served.
 *
 * The order of the gates is the order of decreasing sensitivity, and it matters:
 * the PIN gate runs before the visibility checks, so a caller who cannot open
 * the roll at all learns only that — never whether a given capture inside it is
 * hidden, deleted or still uploading.
 *
 * In order: is this the host (which exempts every guest rule below), the PIN,
 * whether the role is on the guest surface at all, whether the guest link has
 * been revoked since this request's stamp was issued, the capture's visibility,
 * the asset's readiness, and last the host's download switch.
 */
export async function deliverAsset(
  deps: AssetDeliveryDeps,
  request: FastifyRequest,
  assetId: string,
  download: boolean,
): Promise<AssetDelivery> {
  const [row] = await deps.db
    .select({
      role: assets.role,
      frameIndex: assets.frameIndex,
      mime: assets.mime,
      objectKey: assets.objectKey,
      assetStatus: assets.status,
      captureVisible: captures.visible,
      captureDeletedAt: captures.deletedAt,
      rollId: rolls.id,
      privacy: rolls.privacy,
      pinHash: rolls.pinHash,
      hostTokenHash: rolls.hostTokenHash,
      accessEpoch: rolls.accessEpoch,
      downloadsEnabled: rolls.downloadsEnabled,
    })
    .from(assets)
    .innerJoin(captures, eq(captures.id, assets.captureId))
    .innerJoin(rolls, eq(rolls.id, captures.rollId))
    .where(eq(assets.id, assetId))
    .limit(1);

  if (row === undefined) {
    return refuse(404, 'ASSET_NOT_FOUND', 'no such asset');
  }

  // Both hashes are read into this scope, compared, and never referenced again —
  // the same discipline `guestRollAccess` applies, for the same reason.
  const { pinHash, hostTokenHash, ...asset } = row;

  /**
   * Is this the roll's host? Decided first, because every gate below it is a
   * *guest* rule and the host is subject to none of them: it is the host's own
   * roll, the host's dashboard that fetches `metadata.json`, and the host who
   * revoked the link in the first place.
   */
  const isHost = hostTokenPresented(request, hostTokenHash);

  if (!isHost && !guestMayReadRoll(request, { id: asset.rollId, privacy: asset.privacy }, pinHash)) {
    return refuse(401, 'PIN_REQUIRED', 'this roll is PIN protected');
  }

  /**
   * The engineering record of a capture, not part of what a guest was invited to
   * look at. `metadata.json` carries GPS EXIF, the device serial and hardware
   * revision, and every original frame's object key — so it is refused for the
   * guest audience outright rather than gated behind the downloads switch, which
   * is a question about *photographs*.
   *
   * 404, not 403: a guest that was never told this asset exists (the feed omits
   * the role) should not learn from the refusal that it does. The host, holding
   * the roll token, gets the file.
   */
  if (!isHost && !guestMaySeeRole(asset.role)) {
    return refuse(404, 'ASSET_NOT_FOUND', 'no such asset');
  }

  /**
   * The link this asset was reached through may have been revoked (03 §10). Only
   * meaningful once the host has regenerated at least once — see
   * `guestHasRollAccess`, which owns that reasoning and the gap it leaves.
   *
   * 403 rather than 404: the guest *did* hold a working link, so "this one has
   * been replaced, ask the host for the new one" is both true and actionable,
   * and it discloses nothing a stale link did not already.
   */
  if (!isHost && !guestHasRollAccess(request, { id: asset.rollId, accessEpoch: asset.accessEpoch })) {
    return refuse(
      403,
      'ACCESS_REVOKED',
      'this roll’s guest link was regenerated; open the roll again from its current link',
    );
  }

  // 03 §11. Same answer for hidden and for deleted, and the same answer as for
  // an asset id that was never real: a guest is not told which it was.
  if (!asset.captureVisible || asset.captureDeletedAt !== null) {
    return refuse(404, 'ASSET_NOT_FOUND', 'no such asset');
  }

  if (asset.assetStatus !== 'ready') {
    // The caller is authorized by this point, so there is nothing to hide — and
    // "come back once it has uploaded" is more useful than a bare 404. 409 for
    // the same reason `ROLL_CLOSED` is: the request is fine, the state refuses.
    return refuse(409, 'ASSET_NOT_READY', 'this asset has not finished uploading');
  }

  const attachment = download || ALWAYS_ATTACHMENT_ROLES.has(asset.role);
  if (attachment && downloadGated(asset.role) && !asset.downloadsEnabled) {
    return refuse(403, 'DOWNLOADS_DISABLED', 'the host has turned downloads off for this roll');
  }

  const disposition = attachment
    ? dispositionFor(asset.role, asset.frameIndex, asset.objectKey)
    : 'inline';

  if (deps.mode === 'proxy') {
    return {
      ok: true,
      delivery: 'proxy',
      objectKey: asset.objectKey,
      mime: asset.mime,
      disposition,
    };
  }

  const url = await getSignedUrl(
    deps.s3,
    new GetObjectCommand({
      Bucket: deps.bucket,
      Key: asset.objectKey,
      // Signed in, so a guest cannot flip a viewed asset into a downloaded one
      // by editing the URL: changing either value invalidates the signature.
      ResponseContentDisposition: disposition,
      ResponseContentType: asset.mime,
    }),
    { expiresIn: ASSET_URL_TTL_SECONDS },
  );

  return { ok: true, delivery: 'redirect', url };
}
