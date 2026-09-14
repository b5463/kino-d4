// The SCREEN VIEW: just the display, full window, nothing else drawn.
//
// The mode lives in the URL hash so a reload lands back in it and a link
// carries it; nothing here reads the 3D scene, so nothing the scene does —
// a view reset, a pick, an explode — can reach the picture. The functions
// are pure so the sizing can be tested without a window.
import { DISPLAY_H, DISPLAY_W } from './deviceUi';

export const SCREEN_HASH = '#screen';

/** True when the location hash asks for the focused screen. */
export function isScreenFocus(hash: string): boolean {
  return hash === SCREEN_HASH || hash.startsWith(`${SCREEN_HASH}?`) || hash.startsWith(`${SCREEN_HASH}&`);
}

export type ScreenScale = 'fit' | '1x' | '2x';

/**
 * CSS size for the 800x480 panel inside a stage of `stageW` x `stageH`.
 * FIT keeps the 5:3 aspect and fills the stage; 1x and 2x are exact integer
 * scales (pixel work needs pixels), clamped to FIT so the screen never
 * overflows the window on a small display.
 */
export function screenCssSize(stageW: number, stageH: number, scale: ScreenScale): { width: number; height: number; integer: boolean } {
  const fitW = Math.max(1, Math.min(stageW, (stageH * DISPLAY_W) / DISPLAY_H));
  const fit = { width: Math.floor(fitW), height: Math.floor((fitW * DISPLAY_H) / DISPLAY_W), integer: false };
  if (scale === 'fit') return fit;
  const k = scale === '1x' ? 1 : 2;
  if (DISPLAY_W * k > fit.width) return fit;
  return { width: DISPLAY_W * k, height: DISPLAY_H * k, integer: true };
}

/** Seconds since `loadedAt`, as the bar prints it. */
export function loadedAgo(loadedAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - loadedAt) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
