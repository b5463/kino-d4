// Skew Bench statistics. Pure functions over timing samples — no I/O, no deps.
//
// 04§13 keeps the three timing metrics separate (GPIO distribution, VSYNC
// phase, effective exposure) and forbids fabricating a metric the device
// could not measure. Nothing here invents a number: every function needs at
// least one real, finite sample and throws otherwise, so a missing metric
// surfaces as SkewRun.unavailableReason instead of a bogus 0 µs / 'excellent'
// reading, and a NaN/undefined hole fails loudly instead of quietly shrinking
// the reported skew.

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
 * Rejects NaN, ±Infinity and undefined holes.
 *
 * A single NaN makes the `(a, b) => a - b` comparator inconsistent, so sort
 * order becomes arbitrary and max/p95 can silently read back a low sample —
 * a 9 ms outlier reported as 'excellent'. Studio compiles with
 * noUncheckedIndexedAccess off, so a missing index reaches these functions as
 * an undefined that arithmetic turns into NaN. Fail loudly instead.
 */
function assertFiniteSamples(values: number[], context: string): void {
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!Number.isFinite(value)) {
      throw new Error(`${context}: value at index ${i} is not a finite number (got ${String(value)})`);
    }
  }
}

/**
 * Mean, median, p95 and max over a bench run's samples.
 *
 * p95 is nearest-rank (`sorted[ceil(0.95 * n) - 1]`): it always returns an
 * observed sample rather than an interpolated one, so the reported figure is
 * a measurement that actually happened.
 *
 * @throws if `samplesUs` is empty — there is no honest statistic for no data.
 * @throws if any sample is not finite — see {@link assertFiniteSamples}.
 */
export function skewStats(samplesUs: number[]): SkewStats {
  if (samplesUs.length === 0) {
    throw new Error('skewStats: needs at least one sample');
  }
  assertFiniteSamples(samplesUs, 'skewStats');

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
 *
 * @throws if `spreadMs` is negative or not finite. A spread is `max - min`,
 * so it is never negative; a signed or garbage value that reaches here is a
 * caller bug, and neither an 'excellent' pass nor a silent 'fail' is an
 * honest answer to it.
 */
export function bandForSpreadMs(spreadMs: number): SkewBand {
  if (!Number.isFinite(spreadMs) || spreadMs < 0) {
    throw new Error(
      `bandForSpreadMs: spread must be a finite, non-negative millisecond value (got ${String(spreadMs)})`,
    );
  }

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
 * @throws if any offset is not finite — a dropped camera must not narrow the
 * spread silently.
 */
export function spreadUs(offsets: number[]): number {
  if (offsets.length === 0) {
    throw new Error('spreadUs: needs at least one camera offset');
  }
  assertFiniteSamples(offsets, 'spreadUs');

  let min = offsets[0];
  let max = offsets[0];
  for (const offset of offsets) {
    if (offset < min) min = offset;
    if (offset > max) max = offset;
  }
  return max - min;
}
