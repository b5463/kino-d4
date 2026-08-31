import type { CaptureView, RollApi } from '../api/client';

export const ROLL_ASSET_CACHE = 'kino-roll-assets';

/**
 * Removes every cached URL belonging to a capture hidden or deleted live.
 *
 * Both URLs per asset. `?download=1` is a different cache key from the inline
 * one — same bytes, different `Content-Disposition` — so deleting only the
 * inline URL left the saveable copy of a moderated photograph in the cache,
 * still servable offline after the host pulled it.
 */
export async function evictCaptureAssets(capture: CaptureView, api: RollApi): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(ROLL_ASSET_CACHE);
  await Promise.all(
    capture.assets.flatMap((asset) => [
      cache.delete(api.assetUrl(asset.assetId)),
      cache.delete(api.assetUrl(asset.assetId, { download: true })),
    ]),
  );
}
