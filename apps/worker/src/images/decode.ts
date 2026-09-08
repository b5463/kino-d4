import type { SharpOptions } from 'sharp';

/**
 * What every `sharp()` in this worker is allowed to decode.
 *
 * The worker decodes bytes that arrived from a camera over the public upload
 * API, so a `sharp()` with default options is a decoder pointed at untrusted
 * input by a process that also holds the database and the bucket. Two of those
 * defaults are worth pinning rather than inheriting, and pinning them at every
 * call site is the point: a default is invisible in review, and it changes with
 * the library.
 *
 * Spread into the options argument of each call — including the raw-pixel and
 * `create` forms, where there is no file to fail on but where an explicit
 * ceiling still bounds what a job may allocate:
 *
 * ```ts
 * sharp(body, SHARP_INPUT)
 * sharp(frame, { ...SHARP_INPUT, raw: { width, height, channels: 3 } })
 * ```
 */

/**
 * 12 megapixels, and the number is sized against what a job *holds*, not
 * against what a sensor might one day produce.
 *
 * ## What the hardware actually makes
 *
 * A D4 frame is 1600×1200 = 1.92 MP. The intermediates are all smaller or
 * barely larger: the animated-WebP strip is six 960×720 pages stacked, i.e.
 * 960×4320 = 4.15 MP (four *source* frames are 7.7 MP, but that is four
 * separate buffers, not one decode); the recap film is 960 px wide, one frame
 * at a time. So 12 MP is 6.2× the real frame and still covers a jump to a 4K
 * sensor (3840×2160 = 8.3 MP) without an edit here.
 *
 * ## Why it came down from 100 MP
 *
 * The ceiling is a per-decode allocation limit, and the aligned wiggle path
 * holds several at once (`jobs/wiggle.ts`): four decoded source frames, four
 * resized frames, and the stacked strip. Raw RGB is 3 bytes per pixel, so:
 *
 * - at 12 MP:  4×36 MB + 4×2.07 MB + 12.4 MB ≈ 165 MB per job.
 * - at 100 MP: one frame is 300 MB, four of them are 1.2 GB, and the job passes
 *   1.5 GB — an OOM kill in a 2 GB container, which takes every other job in
 *   flight with it *and* leaves the killed job's slot wedged behind a lock
 *   BullMQ keeps renewing. That is the exact failure the ceiling exists to
 *   prevent, so a ceiling that permits it is not doing its job.
 *
 * At the real 1600×1200 a wiggle job holds ~45 MB, which is what four
 * concurrent jobs are sized against.
 *
 * Still far below sharp's own default of ~268 MP (0x3FFF²), which is the other
 * number that matters: a decompression bomb is a few KB of file that asks for
 * gigabytes of pixel buffer.
 */
export const MAX_INPUT_PIXELS = 12_000_000;

/**
 * `failOn: 'error'`, one notch down from sharp's `'warning'` default.
 *
 * `'warning'` is the strictest setting there is, and it refuses a *slightly
 * truncated* JPEG outright — the frame decodes, the last few MCU rows are
 * missing, libjpeg says "premature end of data segment", and sharp turns that
 * into a thrown error. On this pipeline that costs five attempts over ten
 * minutes and ends in an `abandoned` row, for a frame that would have produced
 * a perfectly good 720 px tile: the missing bytes are the bottom rows of a
 * 1600×1200 frame, and at 720 px they are a handful of pixels.
 *
 * How a truncated frame gets here at all, given that `complete` verifies the
 * sha256 the device declared: the camera computes that digest over what it
 * wrote to the SD card, and a card that filled or a node that browned out
 * mid-write produces a short file whose digest matches the short file. The
 * upload is then honest and the JPEG is still clipped.
 *
 * `'error'` still refuses everything that is genuinely broken — a corrupt
 * header, a wrong marker, a file that is not an image — so what changes is
 * exactly the salvageable case. `'truncated'` and `'none'` go further and are
 * not taken: those accept a decode that failed halfway, which would publish a
 * half-grey tile as a `ready` asset.
 *
 * Written down rather than inherited because the alternative is a silent
 * behavioural change the day the library's default moves.
 */
export const SHARP_INPUT: SharpOptions = {
  limitInputPixels: MAX_INPUT_PIXELS,
  failOn: 'error',
};
