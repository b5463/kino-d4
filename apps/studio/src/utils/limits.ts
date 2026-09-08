// What the camera says it can do, applied.
//
// GET_CAPABILITIES carries a `limits` block — `maxResolution`,
// `maxGalleryPageSize`, the UART baud ceiling — and until now only the
// conformance suite read it. The Wiggle page offered the largest resolution to
// every body regardless, and the gallery asked for a fixed 100 rows per
// MEDIA_LIST. Both are the device's own declared numbers; ignoring them means
// offering a setting the camera will refuse and requesting a page it may
// truncate.

import type { DeviceLimits, Resolution } from '@kino/kdp';

/** Smallest first. Pixel count, so a new entry sorts itself. */
export const RESOLUTIONS: Resolution[] = ['1600x1200', '2048x1536'];

function pixels(res: Resolution): number {
  const [w, h] = res.split('x').map(Number);
  return w * h;
}

/**
 * The resolutions this camera will accept, smallest first.
 *
 * A camera that declares no limits gets the full list: an absent limit is not
 * a limit, and greying out a mode the body never said it lacks would be
 * inventing one. A declared `maxResolution` this build has never heard of is
 * treated the same way, for the 07 §14 reason — an unknown value is inert,
 * not fatal.
 */
export function allowedResolutions(limits: DeviceLimits | null): Resolution[] {
  const max = limits?.maxResolution;
  if (!max || !RESOLUTIONS.includes(max)) return RESOLUTIONS;
  const ceiling = pixels(max);
  return RESOLUTIONS.filter((res) => pixels(res) <= ceiling);
}

/** Studio's own preference for one MEDIA_LIST page. */
export const GALLERY_REQUEST_PAGE = 100;

/**
 * How many rows to ask MEDIA_LIST for.
 *
 * The device's ceiling wins when it declared one; a declared value that is not
 * a positive integer is ignored rather than trusted into a zero-row request
 * that would loop forever.
 */
export function galleryPageRequest(limits: DeviceLimits | null): number {
  const max = limits?.maxGalleryPageSize;
  if (typeof max !== 'number' || !Number.isFinite(max) || max < 1) return GALLERY_REQUEST_PAGE;
  return Math.min(GALLERY_REQUEST_PAGE, Math.floor(max));
}
