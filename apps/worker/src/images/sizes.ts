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

/**
 * A feed tile: 720 px on the long edge.
 *
 * Was 480. The guest feed is one photograph per row on a phone, so a tile is
 * the full CSS width — 360 to 430 px — at 2× to 3× DPR, i.e. 720 to 1290
 * device pixels. A 480 px tile was upscaled on every phone and read as a
 * blurred thumbnail; 720 is sharp at 2× and acceptable at 3×. Not larger: the
 * tile still has to arrive over a party's uplink ahead of the still, and at
 * 720 px q82 a 4:3 WebP is ~60–90 kB. Thumbs already written stay at their
 * old size; only new captures get this one.
 *
 * This paragraph used to add that at 3× "the feed offers the 1280 px
 * `kino-still` through `srcset` instead", which was a claim about a client this
 * workspace does not own and cannot check. A browser only picks by DPR when it
 * is given two width-described candidates — `thumb 720w, still 1280w` plus a
 * `sizes` attribute — and until Roll web emits that pair, the tile is the
 * whole story at every DPR. So the 720 has to stand on its own, which is what
 * the numbers above are about.
 */
export const THUMBNAIL_WIDTH = 720;

/**
 * q82 for a thumbnail — the same as the still. At 720 px on a phone the tile
 * IS what the guest looks at until they tap, and q70's ringing on hard edges
 * was visible at 2× DPR. Above q85 WebP grows quickly for no visible gain.
 */
export const THUMBNAIL_QUALITY = 82;

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

/**
 * The social crops (issue #79): story, portrait post, square. 1080 wide is the
 * size every major app renders at; anything larger is recompressed on upload.
 */
export const SOCIAL_9X16 = { role: 'social-9x16', width: 1080, height: 1920 } as const;
export const SOCIAL_4X5 = { role: 'social-4x5', width: 1080, height: 1350 } as const;
export const SOCIAL_1X1 = { role: 'social-1x1', width: 1080, height: 1080 } as const;
export const SOCIAL_FORMATS = [SOCIAL_9X16, SOCIAL_4X5, SOCIAL_1X1] as const;

/**
 * JPEG q85, the contact sheet's reasoning: a social crop exists to leave the
 * app, and JPEG is what every upload dialog accepts without a conversation.
 */
export const SOCIAL_QUALITY = 85;
