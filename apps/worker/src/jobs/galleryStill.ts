import sharp from 'sharp';
import { GALLERY_STILL_QUALITY, GALLERY_STILL_WIDTH } from '../images/sizes';
import { derivedCaptureKey } from '../storage/derived';
import {
  loadAssets,
  loadCapture,
  readObject,
  readyAsset,
  requireCaptureId,
  STILL_ROLE,
  stillSource,
} from './capture';
import { publishDerived } from './derive';
import type { JobCtx, JobPayload } from './types';

/** The file this job writes, and therefore the key that is its own output. */
const STILL_NAME = 'still.webp';

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
  const ownKey = derivedCaptureKey(capture.rollId, capture.id, STILL_NAME);
  if (existing !== null && existing.objectKey !== ownKey) return;

  /**
   * Its own previous output is excluded from the source rule, not just from the
   * skip. `stillSource` prefers a `kino-still` over any frame, so a re-run that
   * left its own row in would re-encode a WebP it already encoded — generation
   * loss on every retry, and a still that drifts further from the frame each
   * time. A retry goes back to the frames.
   */
  const source = stillSource(
    capture,
    assetRows.filter((row) => row.objectKey !== ownKey),
  );
  const body = await readObject(ctx, source.key);

  const { data, info } = await sharp(body)
    .rotate()
    .resize({ width: GALLERY_STILL_WIDTH })
    .webp({ quality: GALLERY_STILL_QUALITY })
    .toBuffer({ resolveWithObject: true });

  await publishDerived(ctx, capture, {
    name: STILL_NAME,
    role: STILL_ROLE,
    mime: 'image/webp',
    body: data,
    width: info.width,
    height: info.height,
  });
}
