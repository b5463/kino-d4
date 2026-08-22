import sharp from 'sharp';
import { SOCIAL_FORMATS, SOCIAL_QUALITY } from '../images/sizes';
import {
  loadAssets,
  loadCapture,
  readObject,
  readyAsset,
  requireCaptureId,
  stillSource,
} from './capture';
import { publishDerived } from './derive';
import type { JobCtx, JobPayload } from './types';

/**
 * `render-social-formats` — the capture as a story (9:16), a portrait post
 * (4:5) and a square (1:1), for pasting straight into a social app (issue #79).
 *
 * One job for all three: they share the source read and the decode, the crops
 * are the cheap part, and a guest who wants one format is about to want the
 * others. Like `render-wiggle-mp4` it is enqueued lazily on first request
 * (`POST .../renders`), never at capture-complete — a party produces hundreds
 * of captures and a handful of social saves.
 *
 * The source follows the same preference the rest of the pipeline has: an
 * `enhanced-still` when the AI pass produced one, otherwise `stillSource`'s
 * rule (device still first, else the middle frame). `position: 'attention'`
 * lets sharp keep the busiest region of the frame when the crop cuts — on a
 * party photo that is the people, which is what a story is of.
 */
export async function renderSocialFormats(payload: JobPayload, ctx: JobCtx): Promise<void> {
  const captureId = requireCaptureId(payload);
  const capture = await loadCapture(ctx.db, captureId);
  const assetRows = await loadAssets(ctx.db, captureId);

  const enhanced = readyAsset(assetRows, 'enhanced-still');
  const sourceKey = enhanced?.objectKey ?? stillSource(capture, assetRows).key;
  const body = await readObject(ctx, sourceKey);

  for (const format of SOCIAL_FORMATS) {
    const { data, info } = await sharp(body)
      .rotate()
      .resize({
        width: format.width,
        height: format.height,
        fit: 'cover',
        position: 'attention',
      })
      .jpeg({ quality: SOCIAL_QUALITY })
      .toBuffer({ resolveWithObject: true });

    await publishDerived(ctx, capture, {
      name: `${format.role}.jpg`,
      role: format.role,
      mime: 'image/jpeg',
      body: data,
      width: info.width,
      height: info.height,
      producer: {
        job: 'social-formats',
        encoder: 'sharp/jpeg',
        fit: 'cover',
        position: 'attention',
        quality: SOCIAL_QUALITY,
      },
    });
  }
}
