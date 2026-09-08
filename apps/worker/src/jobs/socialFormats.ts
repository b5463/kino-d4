import sharp from 'sharp';
import { SHARP_INPUT } from '../images/decode';
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

  /*
   * Decoded once, into raw pixels, and the three crops are taken from those
   * (audit #8).
   *
   * `sharp(body, …)` inside the loop was three decodes of one object: libvips
   * decodes lazily per pipeline, so a new instance over the same Buffer does
   * the JPEG again. At 1600x1200 that is ~15 ms each, three times, for pixels
   * that cannot have changed. `.clone()` is not the answer — it shares an input
   * *stream*, not a decoded buffer.
   *
   * The cost is one raw copy in memory: 1600x1200x3 = 5.76 MB, held while three
   * crops are encoded. The EXIF rotate happens once here too, which also means
   * the three crops cannot disagree about orientation.
   */
  const oriented = await sharp(body, SHARP_INPUT)
    .rotate()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const raw = {
    width: oriented.info.width,
    height: oriented.info.height,
    channels: oriented.info.channels,
  };

  for (const format of SOCIAL_FORMATS) {
    const { data, info } = await sharp(oriented.data, { ...SHARP_INPUT, raw })
      .resize({
        width: format.width,
        height: format.height,
        fit: 'cover',
        position: 'attention',
      })
      /*
       * `mozjpeg` and `progressive` (audit #9).
       *
       * A social crop is 1080 px of a party photo — ~180 kB at q85 baseline.
       * mozjpeg's trellis quantisation and its own quantisation tables give the
       * same q85 in ~10–15 % fewer bytes (~155 kB), at roughly 3x the encode
       * time: ~90 ms instead of ~30 ms, three times, on a job that already
       * spent a round trip fetching the source. Progressive is free and is what
       * makes a 155 kB image readable before it has all arrived, which is the
       * whole life of this file — it exists to be uploaded somewhere.
       */
      .jpeg({ quality: SOCIAL_QUALITY, progressive: true, mozjpeg: true })
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
        encoder: 'sharp/mozjpeg',
        fit: 'cover',
        position: 'attention',
        quality: SOCIAL_QUALITY,
        progressive: true,
      },
    });
  }
}
