/**
 * The output sizes and qualities of every image derivative, in one place.
 *
 * They are here rather than inline in each handler because they are a *product*
 * decision that two readers share: a handler writes at these numbers and a test
 * asserts them, and a size that lived only inside the handler would let a
 * "small tidy-up" change what every guest downloads without failing anything.
 *
 * WebP for both stills: it is the format 03 §4's upload priority is built around
 * — a thumbnail has to be small enough to arrive over a party's uplink before
 * anyone loses interest — and it is universally supported by the browsers a PWA
 * runs in.
 */

/** A feed tile. 480 px covers a 2× phone tile without paying for a 3× one. */
export const THUMBNAIL_WIDTH = 480;

/**
 * q70 for a thumbnail. Below the still's quality on purpose: at 480 px the
 * artefacts are invisible and the bytes are what the guest feed spends.
 */
export const THUMBNAIL_QUALITY = 70;

/** The gallery's single-frame view — one tap in from a tile. */
export const GALLERY_STILL_WIDTH = 1280;

/**
 * q82 for the still. This is the image somebody looks *at*, so it is the one
 * place worth spending bytes on; above q85 WebP grows quickly for no visible
 * gain.
 */
export const GALLERY_STILL_QUALITY = 82;

/** One contact-sheet cell's width. The height follows the frame's aspect ratio. */
export const CONTACT_SHEET_CELL_WIDTH = 320;

/** The gap between two cells. Enough to read as a gap at a glance, and no more. */
export const CONTACT_SHEET_GUTTER = 8;

/**
 * JPEG q85 for the sheet, not WebP.
 *
 * A contact sheet is the artifact a host downloads and sends on — into a chat
 * app, a print shop, an email — and JPEG is the format every one of those
 * accepts without a conversation. The stills stay WebP because they are consumed
 * inside the PWA, where the browser is known.
 */
export const CONTACT_SHEET_QUALITY = 85;

/** The colour behind the cells, which is what the gutters show. */
export const CONTACT_SHEET_BACKGROUND = '#101010';
