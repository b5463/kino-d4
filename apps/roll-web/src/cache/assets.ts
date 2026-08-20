import type { CaptureView, RollApi } from '../api/client';

export const ROLL_ASSET_CACHE = 'kino-roll-assets';

/** Removes every cached URL belonging to a capture hidden or deleted live. */
export async function evictCaptureAssets(capture: CaptureView, api: RollApi): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(ROLL_ASSET_CACHE);
  await Promise.all(capture.assets.map((asset) => cache.delete(api.assetUrl(asset.assetId))));
}
