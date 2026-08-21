import sharp from 'sharp';
import { THUMBNAIL_QUALITY, THUMBNAIL_WIDTH } from '../images/sizes';
import { loadAssets, loadCapture, readObject, requireCaptureId, stillSource } from './capture';
import { publishDerived } from './derive';
import type { JobCtx, JobPayload } from './types';

/**
 * `generate-thumbnail` — the feed tile (03 §4).
 *
 * The source is `stillSource`: an uploaded `kino-still` if the device sent one,
 * otherwise the frame at `floor(frameCount / 2)`. The rule is shared with
 * `generate-gallery-still` on purpose — a tile and the still behind it must show
 * the same camera.
 *
 * This job is queued only when the device did *not* upload its own `thumb`
 * (`plannedJobs` in the API), so reaching here means the platform owes the
 * capture a tile.
 *
 * ## Why the width is unconditional
 *
 * `resize({ width })` with no `withoutEnlargement` produces exactly
 * `THUMBNAIL_WIDTH` for any input, including one smaller than that. A thumbnail
 * whose width depended on the source would make every layout that assumes a
 * known tile width a guess, and upscaling a frame that arrived undersized is a
 * far smaller problem than a feed with two tile sizes in it. Height follows the
 * aspect ratio: cropping here would lie about the frame's shape.
 */
export async function generateThumbnail(payload: JobPayload, ctx: JobCtx): Promise<void> {
  const captureId = requireCaptureId(payload);
  const capture = await loadCapture(ctx.db, captureId);
  const assetRows = await loadAssets(ctx.db, captureId);

  const source = stillSource(capture, assetRows);
  const body = await readObject(ctx, source.key);

  const { data, info } = await sharp(body)
    // EXIF orientation applied before anything else: a camera that reports a
    // rotation and is ignored produces a sideways tile.
    .rotate()
    .resize({ width: THUMBNAIL_WIDTH })
    .webp({ quality: THUMBNAIL_QUALITY })
    .toBuffer({ resolveWithObject: true });

  await publishDerived(ctx, capture, {
    name: 'thumb.webp',
    role: 'thumb',
    mime: 'image/webp',
    body: data,
    // The dimensions of the bytes that were written, read back off the encoder
    // rather than computed from the request — a row that describes what was
    // asked for instead of what happened is a row that can be wrong.
    width: info.width,
    height: info.height,
    producer: { job: 'thumbnail', encoder: 'sharp/webp', targetWidth: THUMBNAIL_WIDTH, quality: THUMBNAIL_QUALITY },
  });
}
