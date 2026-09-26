import { BODY_W_MM, bodyGeometry } from '../physical/fieldBody';

/** The Shoot scale on a desktop: cells Ø101 px, pitch 121 px, body 720 × 495. */
export const SHOOT_PX_PER_MM = 5.5;
/** The photograph beside the body at that scale, 4 : 3. */
export const RESULT_W = 456;
const GAP = 56;
const MIN_RESULT = 320;

export interface ShootLayout {
  pxPerMm: number;
  resultW: number;
  /** Too narrow for body and result side by side: the result goes below. */
  stacked: boolean;
}

/**
 * How the body and the result share the content width. At 1232 px (a
 * 1360 window) the body is at full scale with the result beside it; the
 * body gives way first, then the result drops below it. The cells never go
 * below a useful click size because the body never goes below 3.5 px/mm on
 * a side-by-side layout.
 */
export function shootLayout(contentWidth: number): ShootLayout {
  const fullBody = BODY_W_MM * SHOOT_PX_PER_MM;
  if (contentWidth >= fullBody + GAP + RESULT_W - 1) {
    return { pxPerMm: SHOOT_PX_PER_MM, resultW: RESULT_W, stacked: false };
  }
  const shrunk = (contentWidth - GAP - MIN_RESULT) / BODY_W_MM;
  if (shrunk >= 3.5) {
    const pxPerMm = Math.min(SHOOT_PX_PER_MM, shrunk);
    return { pxPerMm, resultW: Math.floor(contentWidth - BODY_W_MM * pxPerMm - GAP), stacked: false };
  }
  return { pxPerMm: Math.min(SHOOT_PX_PER_MM, contentWidth / BODY_W_MM), resultW: Math.min(RESULT_W, contentWidth), stacked: true };
}

/** CSS custom properties the Shoot stage is laid out with. */
export function stageVars(layout: ShootLayout, pitchMm?: number): Record<string, string> {
  const g = bodyGeometry(layout.pxPerMm, pitchMm);
  const scaleX = g.cellXs[0] - g.cellD / 2;
  return {
    '--body-w': `${g.w}px`,
    '--result-w': `${layout.resultW}px`,
    '--bar-x': `${Math.round(g.bar.x)}px`,
    '--scale-x': `${Math.round(scaleX)}px`,
    '--scale-w': `${Math.round(g.cellXs[3] + g.cellD / 2 - scaleX)}px`,
  };
}
