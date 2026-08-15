// Three distinct timing metrics. Collapsing them into one number called
// "trigger skew" hides the only one that affects the photograph.
//
//   1. GPIO DISTRIBUTION SKEW — when the shared SYNC edge reaches each
//      XIAO. Tens/hundreds of µs. Says nothing about exposure.
//   2. VSYNC PHASE SKEW — where each free-running OV3660 sits in its own
//      frame cycle when the trigger arrives. This decides which frame each
//      sensor hands over, so a 100 µs GPIO spread can still mean 10-30 ms
//      between actual images.
//   3. EFFECTIVE EXPOSURE SKEW — when the scene was really recorded,
//      including rolling-shutter row timing. This is what the wigglegram
//      shows.

import type { CamId } from './types';

export interface CamTiming {
  cam: CamId;
  /** Shared trigger edge arrival, µs relative to the earliest camera. */
  gpioUs: number;
  /** Delay from trigger to that sensor's next VSYNC, µs. */
  vsyncPhaseUs: number;
  /** Effective scene-capture time, µs relative to the reference camera. */
  exposureUs: number;
}

export interface TimingResult {
  cams: CamTiming[];
  gpioSpreadUs: number;
  vsyncSpreadUs: number;
  exposureSpreadUs: number;
  /** False when firmware cannot read VSYNC — the other two are then guesses. */
  vsyncMeasured: boolean;
  frameIntervalUs: number;
}

export type TimingGrade = 'excellent' | 'very-good' | 'usable' | 'visible' | 'contaminated' | 'unacceptable';

export interface GradeInfo {
  grade: TimingGrade;
  label: string;
  note: string;
  /** Status lamp mapping. */
  state: 'ok' | 'warn' | 'err';
}

/** Grades effective exposure spread. Bands are the V1 product targets. */
export function gradeSkew(us: number): GradeInfo {
  const ms = us / 1000;
  if (ms < 0.5) return { grade: 'excellent', label: 'EXCELLENT', note: 'Below 0.5 ms', state: 'ok' };
  if (ms < 1) return { grade: 'very-good', label: 'VERY GOOD', note: '0.5–1 ms', state: 'ok' };
  if (ms < 2) return { grade: 'usable', label: 'USABLE', note: '1–2 ms', state: 'ok' };
  if (ms < 5) return { grade: 'visible', label: 'VISIBLE ON FAST SUBJECTS', note: '2–5 ms', state: 'warn' };
  if (ms < 10)
    return { grade: 'contaminated', label: 'MOTION CONTAMINATED', note: '5–10 ms', state: 'warn' };
  return {
    grade: 'unacceptable',
    label: 'NOT ACCEPTABLE',
    note: 'Above 10 ms — not a synchronized capture',
    state: 'err',
  };
}

export function formatUs(us: number): string {
  if (Math.abs(us) >= 1000) return `${(us / 1000).toFixed(2)} ms`;
  return `${Math.round(us)} µs`;
}

/**
 * One unit for a whole column, chosen from its largest value.
 *
 * Per-value switching (`7.48 ms` directly above `139 µs`) defeats the only
 * job these columns have — scanning four rows for the outlier — because the
 * smaller number reads as the larger one. The unit goes in the header and
 * the cells carry bare tabular numbers.
 */
export function usColumn(values: number[]): {
  unit: 'µs' | 'ms';
  format: (us: number) => string;
} {
  const peak = Math.max(0, ...values.map((v) => Math.abs(v)));
  if (peak >= 1000) {
    return { unit: 'ms', format: (us) => (us / 1000).toFixed(2) };
  }
  return { unit: 'µs', format: (us) => String(Math.round(us)) };
}
