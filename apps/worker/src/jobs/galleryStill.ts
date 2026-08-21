import sharp from 'sharp';
import { GALLERY_STILL_QUALITY, GALLERY_STILL_WIDTH } from '../images/sizes';
import {
  loadAssets,
  loadCapture,
  readObject,
  readyAsset,
  requireCaptureId,
  STILL_ROLE,
  stillSource,
  WORKER_STILL_NAME,
  workerStillKey,
} from './capture';
import { publishDerived } from './derive';
import type { JobCtx, JobPayload } from './types';

/**
 * `generate-gallery-still` — the image behind a tile, one tap in.
 *
 * ## The skip is the interesting part (03 §4)
 *
 * Device previews take priority and workers fill gaps. If a `kino-still` has
 * already arrived, this job writes nothing at all: the device had the whole
 * scene in front of it, its still is already stored under its own key, and
 * overwriting the role with a re-encode of one camera would be a downgrade
 * dressed up as work.
 *
 * The API's `plannedJobs` already declines to queue this job in that case, so
 * this check is the second layer rather than the first — and it is the layer
 * that holds when the still arrives *after* the queue was planned, which is the
 * ordinary case for a device that uploads its previews last.
 *
 * The skip is deliberately narrower than "a kino-still row exists": a still at
 * **this job's own key** is its own previous output, and that must not stop a
 * re-run. Jobs are retryable (03 §19), and a job that refused to repair its own
 * corrupted output would leave the gallery permanently broken with no way to
 * fix it but a manual delete.
 *
 * A skip publishes nothing. There is no new derivative to fetch, and an event
 * that said otherwise would send every subscriber a round trip for a byte they
 * already have.
 */
export async function generateGalleryStill(payload: JobPayload, ctx: JobCtx): Promise<void> {
  const captureId = requireCaptureId(payload);
  const capture = await loadCapture(ctx.db, captureId);
  const assetRows = await loadAssets(ctx.db, captureId);

  const existing = readyAsset(assetRows, STILL_ROLE);
  if (existing !== null && existing.objectKey !== workerStillKey(capture)) return;

  // Its own previous output is excluded from the source rule too, so a retry
  // re-encodes the frame rather than the WebP it wrote last time. That exclusion
  // is `stillSource`'s, not this function's — see the note there; every consumer
  // of the rule needs it, so it is not a filter each caller remembers to apply.
  const source = stillSource(capture, assetRows);
  const body = await readObject(ctx, source.key);

  const { data, info } = await sharp(body)
    .rotate()
    .resize({ width: GALLERY_STILL_WIDTH })
    .webp({ quality: GALLERY_STILL_QUALITY })
    .toBuffer({ resolveWithObject: true });

  await publishDerived(ctx, capture, {
    name: WORKER_STILL_NAME,
    role: STILL_ROLE,
    mime: 'image/webp',
    body: data,
    width: info.width,
    height: info.height,
    producer: { job: 'gallery-still', encoder: 'sharp/jpeg', targetWidth: GALLERY_STILL_WIDTH, quality: GALLERY_STILL_QUALITY },
  });
}
