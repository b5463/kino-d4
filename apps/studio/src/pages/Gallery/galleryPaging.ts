// What the gallery grid actually maps over.
//
// Pulled out of GalleryPage so the 07 §16 scale case (0 / 60 / 2,000 / 10,000
// metadata rows) can be asserted without a DOM: the grid renders exactly one
// `galleryPageSlice`, so bounding that bounds the render.

import type { CaptureSummary } from '@kino/kdp';

export type GalleryFilter = 'all' | 'wiggle' | 'quad' | 'favorites';
export type GallerySort = 'newest' | 'oldest';

/** Cards per page. One card is one tab stop, so this bounds the run. */
export const GALLERY_PAGE_SIZE = 24;

/**
 * How many rows Studio will pull off the card in one visit. A 10,000-capture
 * card (07 §16) is 100 MEDIA_LIST round trips at the device's 100-row ceiling,
 * and nobody pages to card 7,412 — the header says how many are listed and how
 * many are really there, and the filters work on what was listed.
 */
export const GALLERY_LIST_CAP = 5000;

/** Grow the user-requested index window without ever walking past card total. */
export function nextGalleryListLimit(current: number, total: number, increment = GALLERY_LIST_CAP): number {
  if (!Number.isFinite(current) || !Number.isFinite(total) || !Number.isFinite(increment)) return 0;
  return Math.max(0, Math.min(total, current + Math.max(0, increment)));
}

/** The whole card, filtered and ordered — still every row, not yet a page. */
export function galleryView(
  captures: CaptureSummary[],
  filter: GalleryFilter,
  sort: GallerySort,
): CaptureSummary[] {
  return captures
    .filter((c) => (filter === 'all' ? true : filter === 'favorites' ? c.favorite : c.kind === filter))
    .sort((a, b) => (sort === 'newest' ? b.ts - a.ts : a.ts - b.ts));
}

/** How many pages `visible` needs. Always at least one, even when empty. */
export function galleryPageCount(visible: CaptureSummary[]): number {
  return Math.max(1, Math.ceil(visible.length / GALLERY_PAGE_SIZE));
}

/** Clamp a page index into the range that exists right now. */
export function clampGalleryPage(visible: CaptureSummary[], page: number): number {
  return Math.max(0, Math.min(page, galleryPageCount(visible) - 1));
}

/**
 * One page of cards. The index is clamped rather than trusted: switching the
 * filter while on page 40 must not leave an empty grid under a
 * "SHOWING 961–984" line.
 */
export function galleryPageSlice(visible: CaptureSummary[], page: number): CaptureSummary[] {
  const from = clampGalleryPage(visible, page) * GALLERY_PAGE_SIZE;
  return visible.slice(from, from + GALLERY_PAGE_SIZE);
}
