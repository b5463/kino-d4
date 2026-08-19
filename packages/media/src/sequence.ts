/**
 * Wiggle playback order — the single definition of which frame is shown when.
 *
 * Three programs need this answer and they must give the same one. The worker
 * bakes it into an animated WebP and an MP4 (03 §15), Roll web's player steps
 * through it frame by frame (03 §13), and Studio previews it before the shot is
 * taken (02 §9). A wigglegram whose baked render and whose live player disagree
 * about the order is two different photographs of the same moment, so the order
 * lives in one dependency-free module rather than in three.
 *
 * ## Why this package has no dependencies and no Node built-ins
 *
 * One of its three consumers is a browser PWA and another is an Electron/web
 * Studio. Anything that pulled in `sharp`, `ffmpeg` or `node:*` could not be
 * imported there, and the order would be re-implemented on the client — which is
 * exactly the drift this module exists to prevent. So: integer arithmetic only.
 * The encoders stay in the worker, which is the only place that has bytes.
 */

/** 02 §9's loop modes. */
export const LOOP_MODES = ['bounce', 'sweep', 'once'] as const;

export type LoopMode = (typeof LOOP_MODES)[number];

/** 02 §9's direction: left→right or right→left. */
export type WiggleDirection = 'ltr' | 'rtl';

/** 02 §9's speed range. */
export const WIGGLE_FPS_MIN = 5;
export const WIGGLE_FPS_MAX = 15;
export const WIGGLE_FPS_DEFAULT = 10;

const MODES: ReadonlySet<string> = new Set(LOOP_MODES);

/**
 * The order the frames are shown in, as zero-based indices into the capture's
 * frames in camera order.
 *
 * ## The modes
 *
 * - **`bounce`** (02 §9's default) — out and back, without repeating either end:
 *   `0,1,2,3,2,1` for four frames, which is the spec's `1 → 2 → 3 → 4 → 3 → 2`
 *   (01 §8, 03 §13) zero-indexed. Repeating an end frame (`0,1,2,3,3,2,1,0`)
 *   would stall the swing for two frame periods at each turn, and the D4's
 *   parallax reads as a head movement — a head that pauses at both extremes
 *   looks mechanical. Length is `2n - 2`.
 *
 * - **`sweep`** ("continuous sweep") — one pass, `0..n-1`, length `n`. Looped, it
 *   snaps back from the far frame to the near one; that jump *is* the effect.
 *
 * - **`once`** ("one sweep") — **the same order as `sweep`.** The two differ in
 *   whether playback repeats, not in which frames are shown in which order, and
 *   this function returns order only. Inventing a different order for `once` —
 *   or folding "does it repeat" in here as, say, an empty tail — would put a
 *   playback-control decision inside the frame math, where the player could not
 *   see it. The repeat count belongs to the caller: the WebP render sets the
 *   container's loop flag, and Roll web's player decides whether to restart.
 *
 * ## Direction
 *
 * `rtl` mirrors the *frame indices* (`i → n-1-i`) rather than reversing the
 * array. For `sweep`/`once` the two are identical. For `bounce` they are not,
 * and mirroring is the right one: it starts the swing at the far camera and
 * keeps the shape — `3,2,1,0,1,2` — whereas reversing the array yields
 * `1,2,3,2,1,0`, which is the same cyclic loop entered halfway through a swing.
 * A baked render starts at its first frame, and a static poster frame of a
 * wiggle should be an end of the swing, not the middle of one.
 *
 * ## Frame counts
 *
 * Any whole `frameCount >= 1`. Two frames bounce as `0,1`: the interior of a
 * 2-frame bounce is empty, so out-and-back collapses to the two frames, which
 * still loops correctly. One frame yields `[0]` in every mode — a `single`-mode
 * capture (01 §8) has nothing to wiggle, and returning one frame lets a player
 * show it instead of dividing by zero. Zero frames, a negative count and a
 * fraction all throw: there is no honest sequence for them, and a caller that
 * reached one has a bug in its frame accounting that a silent `[]` would hide
 * until the render came out empty.
 */
export function wiggleSequence(
  frameCount: number,
  loop: LoopMode,
  direction: WiggleDirection,
): number[] {
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    throw new RangeError(
      `wiggle needs a whole frame count of at least 1, got ${String(frameCount)}`,
    );
  }
  if (!MODES.has(loop)) {
    throw new RangeError(`unknown wiggle loop mode: ${JSON.stringify(loop)}`);
  }

  const forward: number[] = [];
  for (let index = 0; index < frameCount; index += 1) forward.push(index);

  // The way back, ends excluded. Empty at one and two frames.
  if (loop === 'bounce') {
    for (let index = frameCount - 2; index > 0; index -= 1) forward.push(index);
  }

  const last = frameCount - 1;
  return direction === 'rtl' ? forward.map((index) => last - index) : forward;
}

/**
 * A frame rate inside 02 §9's 5–15 fps, defaulting to 10.
 *
 * Clamped rather than rejected: the fps on a render request comes from a UI
 * slider or a stored preference, and a value a little outside the range is a
 * stale client, not a reason to leave a capture without a wiggle. A missing or
 * unreadable value takes the default. Rounded to a whole frame rate so the frame
 * delay a container stores in milliseconds is exact.
 */
export function clampWiggleFps(fps: number | null | undefined): number {
  if (typeof fps !== 'number' || !Number.isFinite(fps)) return WIGGLE_FPS_DEFAULT;
  return Math.min(WIGGLE_FPS_MAX, Math.max(WIGGLE_FPS_MIN, Math.round(fps)));
}
