import { createHash } from 'node:crypto';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { and, eq, isNull } from 'drizzle-orm';
import type { ASSET_ROLES } from '@kino/schemas';
import { assets } from '../db/schema';
import { newId } from '../ids';
import { publishRollEvent } from '../events/publish';
import { errorFields, log } from '../log';
import type { CaptureRow } from './capture';
import type { DerivedBody, JobCtx } from './types';

/**
 * The last three steps of every image job, as one function.
 *
 * Store the bytes, record the row, announce it. Each handler decides *what* to
 * produce; none of them decides how a derivative is recorded, because the three
 * steps have to happen in this order and a handler that got the order wrong
 * would fail in a way nothing tests:
 *
 * 1. **`putDerived` first.** The row is a promise that the object exists. A row
 *    written before the object is a 404 for every guest who reads the feed in
 *    between, and 05 §19's asset roles are what the PWA fetches by.
 * 2. **Then the row, as an upsert.** Jobs are retryable (03 §19), so a handler
 *    that already ran must land on the *same* row rather than a second one. The
 *    conflict target is the API's `assets_capture_role_frame` — `NULLS NOT
 *    DISTINCT`, which is what makes it cover a capture-level derivative at all,
 *    since its `frame_index` is NULL, and what lets a role hold that row *and*
 *    one per camera at the same time (`DerivedArtifact.frameIndex`).
 * 3. **Then the event.** Announcing a derivative before it is queryable would
 *    send every subscriber to fetch a capture whose asset row is not there yet.
 *
 * A failure at any step leaves the earlier ones in place and the later ones
 * undone, which is exactly what a retry can repair: the object write and the
 * upsert are both idempotent, and a duplicate `processing.completed` costs a
 * guest one redundant fetch.
 *
 * This is also the only place a worker writes an `assets` row. `ctx.db` cannot
 * enforce that (see the note on `JobCtx`), so it is kept true by there being one
 * function to call: nothing here can address a row belonging to an
 * `original-frame`, because the role is supplied by the handler and the object
 * key is built by `putDerived`, which cannot name an original (01 §7).
 */
/**
 * The 05 §19 asset roles, from the package that defines them.
 *
 * Not `string`: the role is what the PWA fetches by, and a typo in one would
 * produce a stored object nothing ever asks for — an asset row that looks
 * perfectly healthy and is invisible. `@kino/schemas` already owns the list, so
 * a role this platform does not have now fails to compile.
 */
export type AssetRole = (typeof ASSET_ROLES)[number];

export interface DerivedArtifact {
  /** The file name inside the capture's `derived/` folder. */
  name: string;
  /** The 05 §19 asset role this artifact fills. */
  role: AssetRole;
  /**
   * The camera this artifact depicts, when it depicts exactly one.
   *
   * Null — the default, and what every derivative was until per-camera tiles —
   * means "this artifact is the capture's", the one row a feed tile picks. A
   * number means "this artifact is CAM n's", and it is the same 1-based camera
   * number the `original-frame` row carries, never a position in an array: a
   * capture that lost camera 2 writes thumbs at 1, 3, 4.
   *
   * The two kinds coexist on one role because `assets_capture_role_frame` is
   * `NULLS NOT DISTINCT`: NULL collides with NULL, 3 collides with 3, and NULL
   * does not collide with 3. A handler that emits both therefore lands on
   * `1 + frames` rows and re-running it lands on the same ones.
   */
  frameIndex?: number | null;
  /**
   * Whether this artifact gets its own `processing.completed`. Default true.
   *
   * The event makes every subscribed guest re-read the whole capture, so a
   * handler that emits five rows would cost fifty phones five refetches of the
   * same document — the traffic this per-camera work exists to remove. A
   * handler emitting a set announces the LAST one and leaves the rest silent:
   * the refetch that the announcement triggers reads all of them, because it
   * reads the capture, not the row.
   *
   * Only safe within one handler, and only when the announced write is the last
   * one. A silent artifact with nothing announced after it is a derivative no
   * live client learns about until it reloads the page.
   */
  announce?: boolean;
  mime: string;
  body: DerivedBody;
  /** Pixel dimensions, or null for something that has none — a JSON document. */
  width?: number | null;
  height?: number | null;
  /**
   * The settings that decided these bytes (audit #59): render constants,
   * fps/loop/quality, encoder — whatever a retune would change. Recorded on
   * the asset row so re-rendering history stays visible in the data.
   */
  producer?: Record<string, unknown>;
}

export interface DerivedResult {
  key: string;
  sha256: string;
  bytes: number;
}

/**
 * Removes the object a derivative just replaced.
 *
 * The case this is for is the device thumb. A camera uploads its own ~7 kB
 * `thumb.jpg` so the feed has something the instant the capture lands, and
 * `generate-thumbnail` is queued anyway (05 §19 wants a 720 px WebP). The
 * worker's `thumb.webp` upserts onto the same `(capture, 'thumb', NULL)` row and
 * rewrites `object_key` — at which point the JPEG is in the bucket with nothing
 * naming it. `assets.object_key` is the only link (05 §6), so once the row moves
 * those bytes are unreachable and, after the capture is purged, undeletable:
 * `eraseCapture` lists the folder rather than the rows precisely because of
 * leaks like this one, but only for a capture that reaches the trash.
 *
 * Three conditions, and each one is a refusal to guess:
 *
 * 1. **The key actually changed.** A re-render onto the same name is the normal
 *    case and deletes nothing.
 * 2. **The old key is inside this capture's own `derived/` folder.** A row that
 *    somehow pointed at an original, or at another capture, is a row this
 *    function has no business acting on — and `guardOriginalWrites` refuses the
 *    delete underneath it either way.
 * 3. **No other asset row names it.** `assets.object_key` is unique, so this can
 *    only be a row written between the read and the upsert; the check costs one
 *    query and is the difference between a cleanup and a data loss.
 *
 * Best effort, always: a failure here is logged and swallowed. The derivative is
 * stored, the row is right, and the guest's tile is live — losing all of that
 * over an orphaned 7 kB object would be the wrong trade.
 */
export async function removeSupersededObject(
  ctx: JobCtx,
  capture: CaptureRow,
  role: AssetRole,
  previousKey: string,
  currentKey: string,
): Promise<void> {
  if (previousKey === currentKey) return;

  const folder = `rolls/${capture.rollId}/captures/${capture.id}/derived/`;
  if (!previousKey.startsWith(folder)) {
    log.warn('superseded object is not in this capture\'s derived folder; left alone', {
      captureId: capture.id,
      role,
      previousKey,
    });
    return;
  }

  try {
    const referencing = await ctx.db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.objectKey, previousKey))
      .limit(1);
    if (referencing.length > 0) return;

    await ctx.s3.send(new DeleteObjectCommand({ Bucket: ctx.bucket, Key: previousKey }));
    log.debug('deleted superseded derivative object', {
      captureId: capture.id,
      role,
      previousKey,
    });
  } catch (err) {
    log.warn('could not delete superseded derivative object', {
      captureId: capture.id,
      role,
      previousKey,
      ...errorFields(err, log.level === 'debug'),
    });
  }
}

export async function publishDerived(
  ctx: JobCtx,
  capture: CaptureRow,
  artifact: DerivedArtifact,
): Promise<DerivedResult> {
  const body = Buffer.isBuffer(artifact.body) ? artifact.body : Buffer.from(artifact.body);
  const sha256 = createHash('sha256').update(body).digest('hex');

  /*
   * Read before the write, because `ON CONFLICT DO UPDATE ... RETURNING` returns
   * the row as it now is: the key being replaced is only visible beforehand.
   * A row that appears between this read and the upsert simply means nothing is
   * superseded as far as this job knows, which is the safe direction to be wrong.
   */
  const frameIndex = artifact.frameIndex ?? null;
  const [existing] = await ctx.db
    .select({ objectKey: assets.objectKey })
    .from(assets)
    .where(
      and(
        eq(assets.captureId, capture.id),
        eq(assets.role, artifact.role),
        // Matched the same way the unique index matches, or the read would find
        // a sibling: a role now holds a capture-level row AND one per camera,
        // and `isNull` on a per-frame write reads the capture-level key and
        // deletes the object underneath the feed tile.
        frameIndex === null ? isNull(assets.frameIndex) : eq(assets.frameIndex, frameIndex),
      ),
    )
    .limit(1);

  const key = await ctx.putDerived(
    capture.rollId,
    capture.id,
    artifact.name,
    body,
    artifact.mime,
  );

  // Producer identity travels with the row (audit #59): the job's settings
  // snapshot, stamped with when these bytes were made. A retry or re-render
  // overwrites it — the row describes the bytes it currently promises.
  const producer = { renderer: 'kino-worker', role: artifact.role, ...(artifact.producer ?? {}) };
  const producedAt = new Date();

  await ctx.db
    .insert(assets)
    .values({
      id: newId('asset'),
      captureId: capture.id,
      role: artifact.role,
      // NULL for a capture-level derivative, a camera number for one that
      // depicts a single frame. The unique index is NULLS NOT DISTINCT
      // precisely so that NULL still collides with NULL.
      frameIndex,
      mime: artifact.mime,
      width: artifact.width ?? null,
      height: artifact.height ?? null,
      bytes: body.length,
      sha256,
      objectKey: key,
      status: 'ready',
      producer,
      producedAt,
    })
    .onConflictDoUpdate({
      target: [assets.captureId, assets.role, assets.frameIndex],
      set: {
        mime: artifact.mime,
        width: artifact.width ?? null,
        height: artifact.height ?? null,
        bytes: body.length,
        sha256,
        objectKey: key,
        status: 'ready',
        producer,
        producedAt,
      },
    });

  if (artifact.announce !== false) {
    await publishRollEvent(ctx.redis, capture.rollId, {
      type: 'processing.completed',
      captureId: capture.id,
      role: artifact.role,
    });
  }

  // After the announcement, not before it: the guest's tile does not wait on
  // housekeeping, and this cannot fail the job in any case.
  if (existing !== undefined) {
    await removeSupersededObject(ctx, capture, artifact.role, existing.objectKey, key);
  }

  return { key, sha256, bytes: body.length };
}
