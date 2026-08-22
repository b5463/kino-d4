import sharp from 'sharp';
import {
  alignmentPlan,
  clampWiggleFps,
  hasAnyOffset,
  kdpLoopToMediaLoop,
  wiggleSequence,
  type CamOffset,
  type LoopMode,
  type WiggleDirection,
} from '@kino/media';
import { captureCalibration } from './calibration';
import { loadAssets, originalFrames, readObject, type AssetRow, type CaptureRow } from './capture';
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
 * The loop mode and direction a render bakes in when the capture carries no
 * playback choice of its own.
 *
 * 02 §9's defaults. `captures.playback` (a host's per-capture choice, PATCHed
 * through the API) wins when present — see `wiggleLoopFor` /
 * `wiggleDirectionFor`; these are the fallback, not the answer.
 */
export const WIGGLE_LOOP_DEFAULT: LoopMode = 'bounce';
export const WIGGLE_DIRECTION_DEFAULT: WiggleDirection = 'ltr';

/** `captures.playback` as stored JSON: a host choice, validated by the API's
 * PATCH route but still read defensively — the column is data, not code. */
interface StoredPlayback {
  fps?: unknown;
  loop?: unknown;
  direction?: unknown;
}

function playbackOf(capture: CaptureRow): StoredPlayback {
  const { playback } = capture;
  return typeof playback === 'object' && playback !== null && !Array.isArray(playback)
    ? (playback as StoredPlayback)
    : {};
}

/** The stored loop choice — KDP vocabulary on the row, mapped into
 * `@kino/media`'s — or the 02 §9 default. */
export function wiggleLoopFor(capture: CaptureRow): LoopMode {
  const { loop } = playbackOf(capture);
  return loop === undefined ? WIGGLE_LOOP_DEFAULT : kdpLoopToMediaLoop(loop);
}

export function wiggleDirectionFor(capture: CaptureRow): WiggleDirection {
  const { direction } = playbackOf(capture);
  return direction === 'rtl' ? 'rtl' : WIGGLE_DIRECTION_DEFAULT;
}

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
  /** The capture-time calibration version these frames were decoded under, or
   * null when the capture carries none. Recorded even when `aligned` is false
   * (an all-zero calibration is a real state, not an absent one). */
  calibrationVersion: string | null;
  /** Whether the per-frame rotate + overlap crop was actually applied. */
  aligned: boolean;
  /** The overlap crop in source pixels, when `aligned`. */
  crop: { x: number; y: number; w: number; h: number } | null;
}

/**
 * The frame rate a render bakes in: the capture's stored playback fps when the
 * host set one, 02 §9's default otherwise. Through `clampWiggleFps` either
 * way, so the range check is the one `@kino/media` and Studio's slider use —
 * a stored value outside 5–15 is a stale client, not a broken render.
 */
export function wiggleFpsFor(capture: CaptureRow): number {
  const { fps } = playbackOf(capture);
  return clampWiggleFps(typeof fps === 'number' ? fps : undefined);
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

  const calibration = captureCalibration(capture);
  const offsets = calibration === null ? null : offsetsFor(stored, calibration.cams);
  const aligned = offsets !== null && hasAnyOffset(offsets);

  let height: number;
  let crop: { x: number; y: number; w: number; h: number } | null = null;
  const frames: Buffer[] = [];

  if (aligned) {
    // Calibration path: rotate each frame and cut the common overlap crop at
    // SOURCE resolution, before the resize — the same order Studio's preview
    // uses (@kino/media `alignmentPlan`), so the baked file and the preview
    // are the same photograph. Doing it after the resize would quantise
    // sub-pixel offsets into the 960 px grid and drift the two.
    const decoded: RawFrame[] = [];
    for (const source of sources) decoded.push(await orientedRaw(source));

    const first = decoded[0];
    if (first === undefined) throw new Error('wiggle has no first frame');
    for (const frame of decoded) {
      if (frame.width !== first.width || frame.height !== first.height) {
        throw new Error(
          `wiggle frames disagree about their size (${frame.width}x${frame.height} vs ` +
            `${first.width}x${first.height}); cannot align`,
        );
      }
    }

    const plan = alignmentPlan(first.width, first.height, offsets);
    crop = plan.crop;
    // Height follows the *cropped* geometry, still forced even for x264.
    height = evenPixels((WIGGLE_WIDTH * plan.crop.h) / plan.crop.w);

    for (const [index, frame] of decoded.entries()) {
      const move = plan.perFrame[index] ?? { dx: 0, dy: 0, rotDeg: 0 };
      frames.push(await alignFrame(frame, move, plan.crop, height));
    }
  } else {
    // No capture-time calibration → the path is exactly what it was before
    // alignment existed. Offsets are never invented, and the *current* device
    // calibration is never borrowed — it was measured for a mechanical state
    // this capture may not have had.
    height = await renderHeightOf(sources[0]);
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
  }

  const fps = wiggleFpsFor(capture);

  return {
    width: WIGGLE_WIDTH,
    height,
    channels: 3,
    fps,
    delayMs: Math.round(1000 / fps),
    frames,
    order: wiggleSequence(frames.length, wiggleLoopFor(capture), wiggleDirectionFor(capture)),
    calibrationVersion: calibration?.version ?? null,
    aligned,
    crop,
  };
}

/**
 * The stored frames' offsets, in stored order, from the calibration's
 * `cam<frameIndex>` entries. A camera the calibration does not name is
 * neutral — never backfilled from anywhere else.
 */
function offsetsFor(
  stored: readonly AssetRow[],
  cams: Record<string, { x: number; y: number; rot: number }>,
): CamOffset[] {
  return stored.map((frame) => {
    const entry = cams[`cam${String(frame.frameIndex ?? 0)}`];
    return { x: entry?.x ?? 0, y: entry?.y ?? 0, rot: entry?.rot ?? 0 };
  });
}

/** One frame decoded to EXIF-oriented raw RGB, with its displayed size. */
interface RawFrame {
  data: Buffer;
  width: number;
  height: number;
}

async function orientedRaw(source: Buffer): Promise<RawFrame> {
  const { data, info } = await sharp(source)
    .rotate()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Executes one frame's transform: rotate about the centre, cut the overlap
 * crop, resize to the render geometry.
 *
 * The geometry mirrors Studio's canvas exactly. The canvas draws the frame
 * rotated about its own centre with that centre moved to
 * `(w/2 + dx, h/2 + dy)`, then reads the crop rectangle in canvas
 * coordinates. sharp's `.rotate(deg)` grows the canvas to hold the rotated
 * frame symmetrically about the same centre, so the crop maps into the
 * rotated image at `crop.x − dx + (w′ − w) / 2` (and likewise for y). The
 * extract offsets are rounded to whole pixels — at most half a pixel from
 * the preview, inside the 2 px pad `computeOverlapCrop` already reserves.
 */
async function alignFrame(
  frame: RawFrame,
  move: { dx: number; dy: number; rotDeg: number },
  crop: { x: number; y: number; w: number; h: number },
  renderHeight: number,
): Promise<Buffer> {
  let canvas = frame;
  if (move.rotDeg !== 0) {
    const { data, info } = await sharp(frame.data, {
      raw: { width: frame.width, height: frame.height, channels: 3 },
    })
      // The corners this sweeps in are cut off by the overlap crop, whose
      // rotation slack was computed for exactly this angle.
      .rotate(move.rotDeg, { background: '#000000' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    canvas = { data, width: info.width, height: info.height };
  }

  return sharp(canvas.data, {
    raw: { width: canvas.width, height: canvas.height, channels: 3 },
  })
    .extract({
      left: Math.round(crop.x - move.dx + (canvas.width - frame.width) / 2),
      top: Math.round(crop.y - move.dy + (canvas.height - frame.height) / 2),
      width: crop.w,
      height: crop.h,
    })
    .resize({ width: WIGGLE_WIDTH, height: renderHeight, fit: 'cover' })
    .raw()
    .toBuffer();
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
