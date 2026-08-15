// Skew Bench statistics. Pure functions over timing samples — no I/O, no deps.
//
// 04§13 keeps the three timing metrics separate (GPIO distribution, VSYNC
// phase, effective exposure) and forbids fabricating a metric the device
// could not measure. Nothing here invents a number: every function needs at
// least one real sample and throws otherwise, so a missing metric surfaces as
// SkewRun.unavailableReason instead of a bogus 0 µs / 'excellent' reading.

/** Summary of one metric over a bench run. All values in the sample's own unit (µs). */
export interface SkewStats {
  mean: number;
  median: number;
  p95: number;
  max: number;
  count: number;
}

/** 02§10 / 07§18 quality bands, worst-to-best readable as a fixed ordering. */
export type SkewBand = 'excellent' | 'very-good' | 'good' | 'warning' | 'poor' | 'fail';

/** One bench pass over N triggers for a single metric. */
export interface SkewRun {
  metric: 'gpio' | 'vsync' | 'exposure';
  /**
   * One entry per camera the device reported. The camera count comes from
   * capabilities — never assume four.
   */
  perCameraUs: Array<{ camera: number; offsetsUs: number[] }>;
  /** Set when the device returned null for this metric (04§13). */
  unavailableReason?: string;
}

/**
 * Mean, median, p95 and max over a bench run's samples.
 *
 * p95 is nearest-rank (`sorted[ceil(0.95 * n) - 1]`): it always returns an
 * observed sample rather than an interpolated one, so the reported figure is
 * a measurement that actually happened.
 *
 * @throws if `samplesUs` is empty — there is no honest statistic for no data.
 */
export function skewStats(samplesUs: number[]): SkewStats {
  if (samplesUs.length === 0) {
    throw new Error('skewStats: needs at least one sample');
  }

  const sorted = [...samplesUs].sort((a, b) => a - b);
  const n = sorted.length;

  let total = 0;
  for (const sample of sorted) {
    total += sample;
  }

  const mid = n >> 1;
  const median = n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  return {
    mean: total / n,
    median,
    p95: sorted[Math.ceil(0.95 * n) - 1],
    max: sorted[n - 1],
    count: n,
  };
}

/**
 * Quality band for a spread, per 02§10 and 07§18.
 *
 * Bands are half-open `[lower, upper)` — 0.5 ms is 'very-good', not
 * 'excellent'. The top band is the exception: the spec says ">10 ms" fails,
 * so exactly 10 ms is still 'poor'.
 */
export function bandForSpreadMs(spreadMs: number): SkewBand {
  if (spreadMs < 0.5) return 'excellent';
  if (spreadMs < 1) return 'very-good';
  if (spreadMs < 2) return 'good';
  if (spreadMs < 5) return 'warning';
  if (spreadMs <= 10) return 'poor';
  return 'fail';
}

/**
 * Spread (max - min) across the cameras of one trigger.
 *
 * Works for any camera count; a single camera legitimately spreads 0.
 *
 * @throws if `offsets` is empty — no cameras reported, which is not a 0 µs spread.
 */
export function spreadUs(offsets: number[]): number {
  if (offsets.length === 0) {
    throw new Error('spreadUs: needs at least one camera offset');
  }

  let min = offsets[0];
  let max = offsets[0];
  for (const offset of offsets) {
    if (offset < min) min = offset;
    if (offset > max) max = offset;
  }
  return max - min;
}
