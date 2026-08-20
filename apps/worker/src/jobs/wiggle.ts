import sharp from 'sharp';
import { clampWiggleFps, wiggleSequence, type LoopMode, type WiggleDirection } from '@kino/media';
import { loadAssets, originalFrames, readObject, type CaptureRow } from './capture';
import type { JobCtx } from './types';

/**
 * What the two wiggle renders share: the geometry, the frame rate, the playback
 * order and the decoded pixels.
 *
 * They share it because a guest can watch the WebP in the feed and then download
 * the MP4, and those two files have to be the same wigglegram — same frames, same
 * order, same crop, same speed. Two handlers each deciding for themselves would
 * drift the moment one of them was tuned.
 *
 * The order itself is not decided here. It comes from `@kino/media`, which is
 * also what Roll web's player and Studio's preview use, so a baked render and a
 * live player cannot disagree (03 §13).
 */

/**
 * 960 px wide — the size a wiggle is watched at.
 *
 * Through `evenPixels` rather than written as a bare `960`, even though 960 is
 * already even: libx264 with `yuv420p` refuses an odd *width* exactly as it
 * refuses an odd height, and a future retune to 961 would then fail at encode
 * time for every capture rather than being quietly corrected here.
 */
export const WIGGLE_WIDTH = evenPixels(960);

/** q75 for the animated WebP: six frames of one scene, so the bytes multiply. */
export const WIGGLE_WEBP_QUALITY = 75;

/**
 * How many times the MP4 repeats the sequence.
 *
 * An MP4 has no loop flag a player is obliged to honour — a share sheet, a chat
 * app or a bare `<video>` may play it exactly once — so the file has to be long
 * enough to read as a wiggle on its own. Four passes of the default bounce is
 * 2.4 s at 10 fps: unmistakably a loop, and small enough to send over a party's
 * uplink.
 */
export const WIGGLE_MP4_LOOPS = 4;

/** x264 CRF 23 — its default, visually transparent for six near-identical frames. */
export const WIGGLE_MP4_CRF = 23;

/**
 * The loop mode and direction a render bakes in.
 *
 * 02 §9's defaults, and for now the *only* values a render can use: nothing in
 * the platform stores per-capture playback settings yet, so a handler that read
 * them from somewhere would be reading a field it invented. When Studio's wiggle
 * page starts persisting them (02 §9) they arrive on the capture and this becomes
 * the fallback rather than the answer.
 */
export const WIGGLE_LOOP_DEFAULT: LoopMode = 'bounce';
export const WIGGLE_DIRECTION_DEFAULT: WiggleDirection = 'ltr';

/**
 * The nearest even number of pixels at or below `value`, and never fewer than 2.
 *
 * libx264 with `yuv420p` subsamples chroma 2×2, so an odd width or height fails
 * to encode outright — and the height of a 960 px-wide render is whatever the
 * source's aspect ratio makes it. A 1600×1200 frame gives 720, but 1600×1201
 * gives 720.6, and rounding that to 721 would produce a `wiggle-webp` that
 * renders and a `wiggle-mp4` that does not exist, for one row of pixels.
 *
 * Down rather than up because cropping a row is invisible and padding one adds a
 * line of invented pixels along an edge. The floor of 2 is for a degenerate
 * source: an image so short that even rounding leaves nothing is not worth a
 * different failure mode.
 */
export function evenPixels(value: number): number {
  const floored = Math.floor(value);
  if (floored < 2) return 2;
  return floored - (floored % 2);
}

/** The frames of one wiggle, decoded once, plus the order they play in. */
export interface WiggleFrames {
  /** Output width in pixels. */
  width: number;
  /** Output height in pixels — even, see `evenPixels`. */
  height: number;
  /** Bytes per pixel in `frames`: RGB, no alpha. */
  channels: 3;
  /** Frames per second (02 §9). */
  fps: number;
  /** Frame delay in milliseconds, which is what a WebP container stores. */
  delayMs: number;
  /** The stored original frames, in camera order, as raw RGB pixels. */
  frames: Buffer[];
  /** Indices into `frames`, in playback order (`@kino/media`). */
  order: number[];
}

/**
 * The frame rate a render bakes in.
 *
 * 10 fps (02 §9's default) for every capture, because — like the loop mode — no
 * per-capture speed is stored yet. It goes through `clampWiggleFps` rather than
 * being written as `10` so that when a stored value does arrive, the range check
 * is already the one `@kino/media` and Studio's slider use.
 */
export function wiggleFpsFor(_capture: CaptureRow): number {
  return clampWiggleFps(undefined);
}

/**
 * Reads a capture's original frames and decodes them to the render geometry.
 *
 * ## Raw pixels, not re-encoded stills
 *
 * Each frame is decoded, oriented, resized and handed on as raw RGB. Both
 * consumers encode from there — sharp straight to animated WebP, ffmpeg from a
 * `rawvideo` pipe — so a frame is compressed exactly once, into the file a guest
 * downloads. Staging JPEGs in between would put a generation of loss inside every
 * wiggle for nothing.
 *
 * ## The sequence runs over the frames that are *stored*
 *
 * Not over `captures.frame_count`. The count is what the device declared, and a
 * render can only show frames it has: with frame 3 of four still uploading, a
 * sequence built from the declared count would index a frame that is not there.
 * Three stored frames bounce as three (`0,1,2,1`), which is a shorter wiggle of
 * the same scene rather than a broken one.
 *
 * Fewer than two stored frames is refused, and refused *retryably* (a plain
 * `Error`, not `UnrecoverableError`): the ordinary cause is a capture whose
 * frames are still arriving, and the next attempt — ten seconds later — is
 * exactly the right response. `MissingCaptureError` from `loadCapture` remains
 * the unrecoverable case, because a deleted capture is not coming back.
 */
export async function loadWiggleFrames(
  ctx: JobCtx,
  capture: CaptureRow,
): Promise<WiggleFrames> {
  const stored = originalFrames(await loadAssets(ctx.db, capture.id));
  if (stored.length < 2) {
    throw new Error(
      `capture ${capture.id} has ${stored.length} stored original frame(s); ` +
        'a wiggle needs at least two frames',
    );
  }

  const sources: Buffer[] = [];
  for (const frame of stored) sources.push(await readObject(ctx, frame.objectKey));

  const height = await renderHeightOf(sources[0]);
  const frames: Buffer[] = [];
  for (const source of sources) {
    frames.push(
      await sharp(source)
        // EXIF orientation first: a rig that reports a rotation and is ignored
        // renders a sideways wiggle.
        .rotate()
        // `cover` with both dimensions fixed, so every frame is exactly the same
        // size. It has to be: the frames become pages of one animation and rows
        // of one raw video stream, and a page of a different height is not a
        // smaller page — it is a corrupt file.
        .resize({ width: WIGGLE_WIDTH, height, fit: 'cover' })
        .removeAlpha()
        .raw()
        .toBuffer(),
    );
  }

  const fps = wiggleFpsFor(capture);

  return {
    width: WIGGLE_WIDTH,
    height,
    channels: 3,
    fps,
    delayMs: Math.round(1000 / fps),
    frames,
    order: wiggleSequence(frames.length, WIGGLE_LOOP_DEFAULT, WIGGLE_DIRECTION_DEFAULT),
  };
}

/** The pages of the animation, concatenated in playback order. */
export function joinPages(frames: WiggleFrames): Buffer {
  const pages: Buffer[] = [];
  for (const index of frames.order) {
    const page = frames.frames[index];
    if (page === undefined) throw new Error(`wiggle sequence names frame ${index}, which is absent`);
    pages.push(page);
  }
  return Buffer.concat(pages);
}

/**
 * The render height, from the first frame's own pixels.
 *
 * Read from the image rather than from `captures.resolution`, for the same reason
 * the contact sheet does: the row is what the device declared and the render has
 * to match what it uploaded. Then forced even — see `evenPixels`.
 */
async function renderHeightOf(source: Buffer | undefined): Promise<number> {
  if (source === undefined) throw new Error('wiggle has no first frame');

  const { width, height, orientation } = await sharp(source).metadata();
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    throw new Error('wiggle frame has no readable dimensions');
  }

  // `metadata()` reports stored dimensions; EXIF orientations 5–8 are displayed
  // a quarter turn round, which is what `.rotate()` will do below.
  const turned = orientation !== undefined && orientation >= 5;
  const shownWidth = turned ? height : width;
  const shownHeight = turned ? width : height;

  return evenPixels(Math.round((WIGGLE_WIDTH * shownHeight) / shownWidth));
}
