import { eq } from 'drizzle-orm';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { FastifyRequest } from 'fastify';
import type { KinoDatabase } from '../plugins/db';
import { guestMayReadRoll } from '../auth/plugins';
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
 */

/** How long a signed URL lives. Long enough to fetch, short enough to be useless if shared. */
export const ASSET_URL_TTL_SECONDS = 60;

/**
 * The redirect itself is cacheable, privately and briefly, so a gallery
 * re-rendering does not re-authorize every tile.
 *
 * Note the tension, which is deliberate and worth stating: this outlives
 * `ASSET_URL_TTL_SECONDS`, so a client replaying a cached redirect after 60 s
 * follows an expired signature and gets a 403 from storage. Browsers follow a
 * 302 immediately, so in practice the window closes long before it matters —
 * but any client that stores redirects must re-request rather than replay.
 */
export const ASSET_CACHE_CONTROL = 'private, max-age=300';

/**
 * The two roles the host's download switch governs (03 §25, "guest: according to
 * host permission"): the untouched camera frame and the processed still. They
 * are the artefacts a guest would *keep*.
 *
 * Thumbnails and wiggle previews are not on this list and never gate: they are
 * how the gallery renders at all, and a roll whose downloads are off is still a
 * roll the guest was invited to look at.
 */
const DOWNLOAD_GATED_ROLES: ReadonlySet<string> = new Set(['original-frame', 'kino-still']);

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
}

export type AssetDelivery =
  | { ok: true; url: string }
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

  // `pinHash` is read into this scope, compared, and never referenced again —
  // the same discipline `guestRollAccess` applies, for the same reason.
  const { pinHash, ...asset } = row;
  if (!guestMayReadRoll(request, { id: asset.rollId, privacy: asset.privacy }, pinHash)) {
    return refuse(401, 'PIN_REQUIRED', 'this roll is PIN protected');
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
  if (attachment && DOWNLOAD_GATED_ROLES.has(asset.role) && !asset.downloadsEnabled) {
    return refuse(403, 'DOWNLOADS_DISABLED', 'the host has turned downloads off for this roll');
  }

  const url = await getSignedUrl(
    deps.s3,
    new GetObjectCommand({
      Bucket: deps.bucket,
      Key: asset.objectKey,
      // Signed in, so a guest cannot flip a viewed asset into a downloaded one
      // by editing the URL: changing either value invalidates the signature.
      ResponseContentDisposition: attachment
        ? dispositionFor(asset.role, asset.frameIndex, asset.objectKey)
        : 'inline',
      ResponseContentType: asset.mime,
    }),
    { expiresIn: ASSET_URL_TTL_SECONDS },
  );

  return { ok: true, url };
}
