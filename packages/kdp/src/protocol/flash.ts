// Host-side flash overlap math (moved from simulator-engine so Studio's
// flash-timing bench and the Twin share one implementation — audit #56).
// KINO Twin §16: does a synced flash pulse land cleanly inside every cam's
// rolling-shutter readout window, or does it clip mid-frame and band the
// image? Pure and clock-free — VSYNC phase and the flash timing are both
// given as plain numbers, so this is safe to call every frame from a UI.
import type { CamId } from './types';
import { CAM_IDS } from './types';

export interface FlashRisk {
  perCamCoverage: Record<CamId, number>;
  banded: boolean;
}

type UsSegment = [start: number, end: number];

/**
 * The one or two [start, end) segments (both within [0, period)) an arc of
 * length `len` starting at `start` occupies once wrapped onto a circle of
 * size `period` — two segments when the arc crosses the period boundary.
 */
function wrapSegments(start: number, len: number, period: number): UsSegment[] {
  const s = ((start % period) + period) % period;
  const e = s + len;
  if (e <= period) return [[s, e]];
  return [
    [s, period],
    [0, e - period],
  ];
}

function overlapLen(a: UsSegment, b: UsSegment): number {
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
}

/**
 * Coverage per camera = the fraction of that cam's rolling readout window
 * `[phase, phase+readoutUs)` (mod frameIntervalUs) lit by the flash pulse
 * `[flashDelayUs, flashDelayUs+flashDurationUs)` — both wrapped onto the
 * same one-frame circle, since the pulse recurs every frame. `banded` flags
 * a partial hit: full coverage (evenly lit) and no coverage (evenly dark)
 * are both clean; anything strictly between is a visible band.
 */
export function flashBandRisk(
  phasesUs: Record<CamId, number>,
  frameIntervalUs: number,
  /** One window for all four cameras, or a per-camera exposure window
   * (audit #56 — each sensor's own SIMULATED/measured exposure time). */
  readoutUs: number | Record<CamId, number>,
  flashDelayUs: number,
  flashDurationUs: number,
): FlashRisk {
  const flashSegments = wrapSegments(flashDelayUs, flashDurationUs, frameIntervalUs);

  const perCamCoverage = {} as Record<CamId, number>;
  for (const cam of CAM_IDS) {
    const windowUs = typeof readoutUs === 'number' ? readoutUs : readoutUs[cam];
    const readoutSegments = wrapSegments(phasesUs[cam], windowUs, frameIntervalUs);
    let litUs = 0;
    for (const readout of readoutSegments) {
      for (const flash of flashSegments) litUs += overlapLen(readout, flash);
    }
    perCamCoverage[cam] = windowUs === 0 ? 0 : litUs / windowUs;
  }

  const banded = CAM_IDS.some((cam) => perCamCoverage[cam] > 0.05 && perCamCoverage[cam] < 0.95);

  return { perCamCoverage, banded };
}
