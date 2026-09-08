import sharp from 'sharp';
import { SHARP_INPUT } from '../images/decode';
import { THUMBNAIL_QUALITY, THUMBNAIL_WIDTH } from '../images/sizes';
import {
  loadAssets,
  loadCapture,
  originalFrames,
  readObject,
  requireCaptureId,
  stillSource,
} from './capture';
import { publishDerived } from './derive';
import type { AssetRow, CaptureRow } from './capture';
import type { JobCtx, JobPayload } from './types';

/**
 * `derived/frames/thumb-cam-03.webp` — one camera's tile.
 *
 * Under `frames/` and carrying the camera number, so it cannot collide with the
 * capture-level `derived/thumb.webp` and a listing of the folder reads as what
 * it is. Two digits, so a rig that ever grows past nine cameras still sorts, and
 * because the API's `dispositionFor` already spells a camera `cam-01`.
 *
 * The camera number, never an array position: a capture that lost camera 2
 * writes `thumb-cam-01`, `thumb-cam-03`, `thumb-cam-04`, and the row's
 * `frame_index` says the same thing. A key built from a position would rename
 * every frame the day a missing camera's upload landed late.
 */
export function frameThumbName(frameIndex: number): string {
  return `frames/thumb-cam-${String(frameIndex).padStart(2, '0')}.webp`;
}

/** THUMBNAIL_WIDTH px of WebP, and the size the encoder actually wrote. */
async function encodeThumb(body: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(body, SHARP_INPUT)
    // EXIF orientation applied before anything else: a camera that reports a
    // rotation and is ignored produces a sideways tile.
    .rotate()
    .resize({ width: THUMBNAIL_WIDTH })
    .webp({ quality: THUMBNAIL_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * The settings that decided these bytes (audit #59), plus which camera they are
 * — so a row that turns up in the wrong cell can be traced without re-rendering
 * it. Null is the capture-level tile.
 */
function thumbProducer(capture: CaptureRow, frameIndex: number | null): Record<string, unknown> {
  return {
    job: 'thumbnail',
    encoder: 'sharp/webp',
    targetWidth: THUMBNAIL_WIDTH,
    quality: THUMBNAIL_QUALITY,
    // `look` is identity only — the P4 baked it into the source JPEG.
    look: capture.look,
    frameIndex,
  };
}

/**
 * `generate-thumbnail` — the feed tile (03 §4).
 *
 * The source is `stillSource`: an uploaded `kino-still` if the device sent one,
 * otherwise the frame at `floor(frameCount / 2)`. The rule is shared with
 * `generate-gallery-still` on purpose — a tile and the still behind it must show
 * the same camera.
 *
 * `plannedJobs` queues it for every capture, device thumb or not: a camera's
 * own ~7 kB JPEG is what the feed shows in the first seconds, and 05 §19 still
 * wants a 720 px WebP behind it.
 *
 * ## Why the width is unconditional
 *
 * `resize({ width })` with no `withoutEnlargement` produces exactly
 * `THUMBNAIL_WIDTH` for any input, including one smaller than that. A thumbnail
 * whose width depended on the source would make every layout that assumes a
 * known tile width a guess, and upscaling a frame that arrived undersized is a
 * far smaller problem than a feed with two tile sizes in it. Height follows the
 * aspect ratio: cropping here would lie about the frame's shape.
 *
 * ## Why a multi-frame capture also gets one thumb per camera, and why here
 *
 * The capture page draws a strip of cells and a 2x2 overview, one box per
 * camera. With only a capture-level thumb the client had nothing per camera to
 * draw with, so it drew the `original-frame` rows: four 1600x1200 JPEGs, ~754 kB
 * over four object fetches, for eight boxes that at their largest are 225 CSS px
 * per strip cell and 450 CSS px per quad cell on a desktop layout (97 px and
 * 195 px are the phone numbers). At 2x DPR the widest of those wants 900 device
 * pixels, so `THUMBNAIL_WIDTH` = 720 is the ceiling being *approached* on a
 * desktop, not one exceeded — and it is still a tenth of the bytes an original
 * frame costs. Substituting the capture-level thumb was tried and reverted,
 * correctly — it is ONE camera's picture (`stillSource`), so all four cells
 * showed the same view. The only honest cheap strip is a real thumb per camera.
 *
 * They are extra work inside this job rather than a job of their own, for two
 * reasons that both come back to 03 §19's idempotency rule — *a job's output
 * must not depend on which job ran first*:
 *
 *  - **One product, one lifecycle.** A second job name means a second
 *    `processing_events` row and a second entry in `plannedJobs`, and therefore
 *    a window in which `nextCaptureStatus` calls a capture `ready` while half
 *    its tiles exist. The capture owes a guest *its tiles*, not "a tile and,
 *    separately, some tiles".
 *  - **A job name is a deploy contract.** `isJobName` refuses a name this build
 *    does not know, so a new name queued by a newer API against a worker that
 *    has not rolled yet fails every capture until it has. Extending a handler
 *    costs no such window.
 *
 * The order-dependence the rule warns about is absent either way: the per-camera
 * thumbs read `original-frame` rows only, and no job writes those. The
 * capture-level thumb keeps `stillSource`, which already excludes the worker's
 * own still for exactly that reason.
 *
 * The capture-level thumb is still written, always, with a null frame index. It
 * is the row the feed tile picks, it is what a client built before this change
 * expects to find, and `assets_capture_role_frame` is `NULLS NOT DISTINCT` so
 * the two kinds sit on the same role without colliding.
 *
 * ## One of those tiles is the capture-level tile
 *
 * `stillSource` picks one of the stored frames, so on a four-frame wiggle the
 * capture-level `thumb.webp` and one camera's tile are the same photograph at
 * the same width and quality — byte-identical output from two encodes. It is
 * encoded once now and the buffer is written under both names: a decode and an
 * encode saved per capture. The ~50 kB is not saved, because
 * `assets.object_key` is unique and the per-camera row cannot point at the
 * capture-level object — see the note inside the handler.
 */
export async function generateThumbnail(payload: JobPayload, ctx: JobCtx): Promise<void> {
  const captureId = requireCaptureId(payload);
  const capture = await loadCapture(ctx.db, captureId);
  const assetRows = await loadAssets(ctx.db, captureId);

  const frames: AssetRow[] = originalFrames(assetRows);
  const source = stillSource(capture, assetRows);
  const perCamera = frames.length >= 2 ? frames : [];

  /*
   * The capture-level tile is encoded first, and one of the per-camera tiles is
   * that same encode (audit #5).
   *
   * `stillSource` picks one of the stored frames — an uploaded `kino-still`
   * first, otherwise the lower median of what is stored — so on a four-frame
   * wiggle the capture-level `thumb.webp` and one camera's tile are the same
   * frame at the same width and quality. Encoding it twice produced two objects
   * with byte-identical contents: a wasted decode and encode per capture, which
   * at a party's rate is a decode per photograph for nothing.
   *
   * So it is encoded once and the buffer is reused. The second **object** is
   * still written, and that is not an oversight: `assets.object_key` is UNIQUE
   * across the table, so two rows cannot name one object, and the per-camera row
   * has to exist — it is what the capture page's strip reads, and its
   * `frame_index` is what says which cell it belongs in. Dropping the duplicate
   * ~50 kB would mean either losing that row or relaxing that constraint, and
   * the constraint is the API's.
   */
  const captureTile = await encodeThumb(await readObject(ctx, source.key));

  for (const frame of perCamera) {
    // `originalFrames` already dropped the null indexes; the check is what makes
    // that readable to the type, not a second filter.
    if (frame.frameIndex === null) continue;

    // The frame the capture-level tile already encoded: same bytes, second key.
    const shared = frame.objectKey === source.key;
    const encoded = shared ? captureTile : await encodeThumb(await readObject(ctx, frame.objectKey));

    await publishDerived(ctx, capture, {
      name: frameThumbName(frame.frameIndex),
      role: 'thumb',
      frameIndex: frame.frameIndex,
      mime: 'image/webp',
      body: encoded.data,
      width: encoded.width,
      height: encoded.height,
      // Silent: the capture-level thumb below announces, and the refetch that
      // announcement triggers reads the whole capture, these rows included. A
      // crash inside this loop leaves the job unfinished and the retry rewrites
      // the same bytes, because the stored frames are its only input.
      announce: false,
      producer: {
        ...thumbProducer(capture, frame.frameIndex),
        // Says that these bytes are the capture-level tile's, so a reader
        // comparing two identical sha256 values does not have to guess why.
        ...(shared ? { sameBytesAs: 'thumb.webp' } : {}),
      },
    });
  }

  // Last, and the one that announces. Written unconditionally: it is the feed
  // tile's row and the one a client built before this change looks for.
  await publishDerived(ctx, capture, {
    name: 'thumb.webp',
    role: 'thumb',
    mime: 'image/webp',
    body: captureTile.data,
    // The dimensions of the bytes that were written, read back off the encoder
    // rather than computed from the request — a row that describes what was
    // asked for instead of what happened is a row that can be wrong.
    width: captureTile.width,
    height: captureTile.height,
    producer: thumbProducer(capture, null),
  });
}
