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
 * 100 megapixels.
 *
 * The real article is nowhere near it: a D4 frame is 1600×1200 (1.9 MP), the
 * tallest intermediate anything builds is a four-page wiggle strip at roughly
 * 8 MP, and the recap film is 1080p. So this is more than a decade of sensor
 * headroom and still an order of magnitude below sharp's own default of ~268 MP
 * (0x3FFF²), which is the number that matters here: a decompression bomb is a
 * few KB of file that asks for gigabytes of pixel buffer, and the ceiling is what
 * turns that from an OOM-killed worker — which takes every job in flight with it
 * — into one job that fails and one capture that goes `partial`.
 */
export const MAX_INPUT_PIXELS = 100_000_000;

/**
 * `failOn: 'warning'` is sharp's own default, stated rather than inherited.
 *
 * It is the strict end of the scale: a truncated file or a decoder warning is an
 * error, not something to render half of. That is the right trade for this
 * pipeline — every input either came through `complete`, which verified its
 * sha256 against what the device declared, or was produced by this worker, so a
 * warning means something is genuinely wrong and a half-decoded frame published
 * as a `ready` asset would be worse than a failed job.
 *
 * Written down because the alternative is a silent behavioural change: if the
 * library's default moves to 'truncated', every derivative in the platform
 * quietly starts accepting partial frames.
 */
export const SHARP_INPUT: SharpOptions = {
  limitInputPixels: MAX_INPUT_PIXELS,
  failOn: 'warning',
};
