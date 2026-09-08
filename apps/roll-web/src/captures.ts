import type { CaptureAssetSummary, CaptureView } from './api/client';

/**
 * The capture-level asset for the first of these roles that has one.
 *
 * `frameIndex === null` is the filter that makes this mean what it says. A role
 * used to hold at most one derived row; `thumb` now holds the capture-level
 * tile AND one per camera (worker `jobs/thumbnail.ts`), so a bare
 * `find(role === 'thumb')` is "whichever camera the API happened to list
 * first" — a tile that is one of four views rather than the capture's own.
 *
 * One copy. The feed and the display page each carried this function verbatim,
 * which is two places for one rule to drift apart in.
 */
export function assetOf(
  capture: Pick<CaptureView, 'assets'>,
  roles: readonly string[],
): CaptureAssetSummary | undefined {
  for (const role of roles) {
    const asset = capture.assets.find(
      (candidate) => candidate.role === role && candidate.frameIndex === null,
    );
    if (asset !== undefined) return asset;
  }
  return undefined;
}

/**
 * `capturedAt` as milliseconds, parsed once per capture object.
 *
 * `Date.parse` inside a sort comparator is the hot path on this app: at 2,000
 * captures one live arrival cost about 4,000 parses in `compareFeedOrder`
 * alone, and the feed re-derived its day/hour marks with a fresh `new Date`
 * per capture on top of that. Capture objects are immutable — the client
 * builds a new one per wire record — so a `WeakMap` keyed by the object is a
 * correct cache and cannot leak: an entry dies with the capture it describes.
 */
const parsedAt = new WeakMap<object, number>();

export function capturedAtMs(capture: Pick<CaptureView, 'capturedAt'>): number {
  const cached = parsedAt.get(capture);
  if (cached !== undefined) return cached;
  const value = Date.parse(capture.capturedAt);
  parsedAt.set(capture, value);
  return value;
}
