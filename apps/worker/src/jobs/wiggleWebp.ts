import sharp from 'sharp';
import { loadCapture, requireCaptureId } from './capture';
import { publishDerived } from './derive';
import { joinPages, loadWiggleFrames, WIGGLE_WEBP_QUALITY } from './wiggle';
import type { JobCtx, JobPayload } from './types';

/**
 * `render-wiggle-webp` — the wigglegram itself, as one file that plays anywhere
 * an image plays (03 §13, 05 §19 role `wiggle-webp`).
 *
 * An animated WebP rather than a video because this is the artifact that has to
 * behave like a photograph: it drops into an `<img>`, it animates in a feed
 * without autoplay policies or a play button, and it is one request. The MP4 is
 * the companion for downloading and sharing on (`render-wiggle-mp4`).
 *
 * ## Why sharp, and not `webpmux`
 *
 * sharp encodes the whole animation in one pass from a single joined raw buffer:
 * the pages are stacked vertically and `raw.pageHeight` tells libwebp where each
 * one ends. That is the same `pageHeight` machinery sharp uses to *read*
 * animations, it honours `loop` and per-frame `delay`, and libwebp gets to reuse
 * the previous page when compressing the next — which is most of why six frames
 * of one scene cost so little. The `webpmux` fallback the plan allowed for is not
 * needed and is not here: it would mean a temp directory, six separately encoded
 * stills, a child process, and an interframe compression opportunity thrown away.
 *
 * ## Loops forever
 *
 * `loop: 0`. There is no state in a wigglegram — no beginning to arrive at and
 * no end to stop on — and a wiggle that halted after one pass would leave the
 * feed full of stills of whichever frame happened to be last.
 */
export async function renderWiggleWebp(payload: JobPayload, ctx: JobCtx): Promise<void> {
  const captureId = requireCaptureId(payload);
  const capture = await loadCapture(ctx.db, captureId);
  const wiggle = await loadWiggleFrames(ctx, capture);

  const { data, info } = await sharp(joinPages(wiggle), {
    raw: {
      width: wiggle.width,
      height: wiggle.height * wiggle.order.length,
      channels: wiggle.channels,
      // What turns one tall image into an animation of `order.length` pages.
      pageHeight: wiggle.height,
    },
  })
    .webp({
      quality: WIGGLE_WEBP_QUALITY,
      loop: 0,
      // One delay per page rather than a single number: the container stores them
      // per frame anyway, and a later variable-speed mode (02 §9's friendly speed
      // labels) writes the same field.
      delay: wiggle.order.map(() => wiggle.delayMs),
    })
    .toBuffer({ resolveWithObject: true });

  await publishDerived(ctx, capture, {
    name: 'wiggle.webp',
    role: 'wiggle-webp',
    mime: 'image/webp',
    body: data,
    width: info.width,
    // `info.height` is the whole stacked image — every page — so the row would
    // claim a 4320 px-tall wiggle. One frame's height is what a client lays out.
    height: wiggle.height,
    producer: {
      job: 'wiggle-webp',
      encoder: 'sharp/webp-anim',
      quality: WIGGLE_WEBP_QUALITY,
      fps: wiggle.fps,
      width: wiggle.width,
      frames: wiggle.order.length,
      // Which calibration these bytes were baked under, and whether the
      // alignment actually moved anything (audit #59). `crop` is in source
      // pixels. `look` is recorded, never applied — the P4 bakes it into the
      // JPEGs before upload; this is identity, not a promise of work done.
      calibrationVersion: wiggle.calibrationVersion,
      aligned: wiggle.aligned,
      ...(wiggle.crop === null ? {} : { crop: wiggle.crop }),
      look: capture.look,
    },
  });
}
