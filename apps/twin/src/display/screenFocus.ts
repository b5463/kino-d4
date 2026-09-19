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
/**
 * How big to draw the panel, and why FIT snaps.
 *
 * FIT used to take every pixel the pane offered, which is almost never an
 * integer multiple of 800 x 480 - so the browser resampled the canvas
 * bilinearly, at 0.98x in a narrow pane or 1.5x in a wide one. A 2% rescale is
 * the worst case there is: every edge on the panel picks up a half-pixel of
 * blur and the screen reads as soft when the device itself is pixel-exact.
 *
 * So FIT means "the largest whole multiple that fits" and the picture is
 * nearest-neighbour at every one of them. Only when even 1x will not fit does
 * it fall back to a fractional size, and then it is smoothed on purpose,
 * because nearest-neighbour on a DOWNscale drops whole rows of pixels and
 * loses type outright.
 */
export function screenCssSize(stageW: number, stageH: number, scale: ScreenScale): { width: number; height: number; integer: boolean } {
  const fitW = Math.max(1, Math.min(stageW, (stageH * DISPLAY_W) / DISPLAY_H));
  const whole = Math.floor(fitW / DISPLAY_W);
  if (scale === 'fit') {
    if (whole >= 1) {
      return { width: DISPLAY_W * whole, height: DISPLAY_H * whole, integer: true };
    }
    return { width: Math.floor(fitW), height: Math.floor((fitW * DISPLAY_H) / DISPLAY_W), integer: false };
  }
  const k = scale === '1x' ? 1 : 2;
  if (DISPLAY_W * k > fitW) {
    return { width: Math.floor(fitW), height: Math.floor((fitW * DISPLAY_H) / DISPLAY_W), integer: false };
  }
  return { width: DISPLAY_W * k, height: DISPLAY_H * k, integer: true };
}

/** Seconds since `loadedAt`, as the bar prints it. */
export function loadedAgo(loadedAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - loadedAt) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
