// Turns one SYNC_BENCH run into the 02 §10 display model.
//
// Three metrics, always separate, never averaged into a single "sync score":
// GPIO distribution says when the trigger edge arrived, VSYNC phase says where
// each free-running sensor sat in its own frame, effective exposure says when
// the scene was actually recorded. Only the last two decide the photograph.
//
// Nothing here invents a number. `skewStats`, `spreadUs` and `bandForSpreadMs`
// all throw on empty or non-finite input by design, so every metric is
// validated *before* the math runs and anything that fails validation leaves
// with an `unavailableReason` and null figures (04 §13). A throw escaping into
// a React render would unmount the page that was supposed to report the fault.

import type { JobHandle } from '@kino/kdp';
import { bandForSpreadMs, skewStats, spreadUs } from './skewStats';
import type { SkewBand, SkewStats } from './skewStats';

export type SkewMetric = 'gpio' | 'vsync' | 'exposure';

// ---- wire shape (reference device: firmware-contract/commands.md) ----

export interface SyncBenchCamSample {
  cam: string;
  /** Shared trigger edge arrival, µs. `null` when the device could not read it. */
  gpioUs?: number | null;
  /** Trigger-to-VSYNC wait for that sensor, µs. */
  vsyncPhaseUs?: number | null;
  /** Effective scene-capture time, µs. */
  exposureUs?: number | null;
}

export interface SyncBenchTriggerSample {
  trigger: number;
  cams: SyncBenchCamSample[];
}

export interface SyncBenchJobResult {
  triggers?: number;
  frameIntervalUs?: number;
  aligned?: boolean;
  samples?: SyncBenchTriggerSample[];
  /** 04 §13: per-metric reason the device could not measure it. */
  unavailable?: Partial<Record<SkewMetric, string>>;
  /** One reason covering every metric the device returned as null. */
  unavailableReason?: string;
}

// ---- display model ----

export interface SkewCameraRow {
  /** Device id as reported, e.g. `cam3`. */
  cam: string;
  /** `CAM3`. Derived from the run, never from an assumed camera count. */
  label: string;
  /** Mean over the run, µs, rebased so the earliest camera reads 0. */
  offsetUs: number;
}

export interface SkewMetricReport {
  metric: SkewMetric;
  title: string;
  note: string;
  /** Non-null means: print this, print no numbers. */
  unavailableReason: string | null;
  cameras: SkewCameraRow[];
  /** max−min of the per-camera means above, µs. Null when unavailable. */
  spreadUs: number | null;
  band: SkewBand | null;
  /** Each trigger's own spread, summarised over the run. */
  distribution: SkewStats | null;
  /**
   * Band of the p95 single-trigger spread, set only when it is worse than
   * `band`. Averaging per camera cancels run-to-run jitter, so a run can show
   * an EXCELLENT mean spread and still miss one frame in twenty — which is the
   * kind of single reassuring number 02 §10 exists to prevent.
   */
  worstBand: SkewBand | null;
}

export interface SkewReport {
  /** What the UI asked for. The device may return fewer. */
  requestedTriggers: number;
  /** Triggers actually reported. This is what the display counts. */
  triggers: number;
  /** Camera labels in device order. */
  cameras: string[];
  frameIntervalUs: number | null;
  metrics: SkewMetricReport[];
}

/** 02 §10's band table, in the spec's own wording. */
export const SKEW_BANDS: Record<
  SkewBand,
  { label: string; lamp: string; state: 'ok' | 'warn' | 'err'; range: string }
> = {
  excellent: { label: 'EXCELLENT', lamp: '●', state: 'ok', range: '< 0.5 ms' },
  'very-good': { label: 'VERY GOOD', lamp: '●', state: 'ok', range: '0.5–1 ms' },
  good: { label: 'GOOD TARGET', lamp: '●', state: 'ok', range: '1–2 ms' },
  warning: { label: 'WARNING', lamp: '▲', state: 'warn', range: '2–5 ms' },
  poor: { label: 'POOR FOR MOVING SUBJECTS', lamp: '▲', state: 'warn', range: '5–10 ms' },
  fail: { label: 'FAIL', lamp: '×', state: 'err', range: '> 10 ms — not a synchronized capture' },
};

/** Worst first is the order a reader scans; this is the spec's order. */
export const SKEW_BAND_ORDER: SkewBand[] = [
  'excellent',
  'very-good',
  'good',
  'warning',
  'poor',
  'fail',
];

const METRICS: { metric: SkewMetric; key: keyof SyncBenchCamSample; title: string; note: string }[] = [
  {
    metric: 'gpio',
    key: 'gpioUs',
    title: 'GPIO DISTRIBUTION',
    note: 'Trigger edge arrival. Says nothing about exposure.',
  },
  {
    metric: 'vsync',
    key: 'vsyncPhaseUs',
    title: 'VSYNC PHASE',
    note: 'Where each free-running sensor sat in its own frame.',
  },
  {
    metric: 'exposure',
    key: 'exposureUs',
    title: 'EFFECTIVE EXPOSURE',
    note: 'When the scene was actually recorded. This is the one that decides the photograph.',
  },
];

/** `+0.61ms` / `+0.00ms` — 02 §10's per-camera row format. */
export function formatOffsetMs(us: number): string {
  const ms = us / 1000;
  const sign = ms < 0 ? '-' : '+';
  return `${sign}${Math.abs(ms).toFixed(2)}ms`;
}

/** `1.20ms` — the Spread row. A spread carries no sign. */
export function formatSpreadMs(us: number): string {
  return `${(us / 1000).toFixed(2)}ms`;
}

/** `mean 0.42 · median 0.39 · p95 0.88 · max 1.20 ms` */
export function formatDistribution(stats: SkewStats): string {
  const ms = (us: number) => (us / 1000).toFixed(2);
  return `mean ${ms(stats.mean)} · median ${ms(stats.median)} · p95 ${ms(stats.p95)} · max ${ms(stats.max)} ms`;
}

/** `cam3` → `CAM3`. Anything else is printed as the device spelled it. */
function cameraLabel(cam: string): string {
  const m = /^cam(\d+)$/i.exec(cam);
  return m ? `CAM${m[1]}` : cam.toUpperCase();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Every trigger's values for one metric, in camera order — or a reason there
 * is no honest column to compute from.
 *
 * A dropped camera, a null the firmware sent for "measured, unavailable here",
 * and a trigger that reported a different camera set all mean the same thing:
 * the run cannot be summarised without quietly changing what is being
 * summarised. All three land here.
 */
function collect(
  samples: SyncBenchTriggerSample[],
  cams: string[],
  key: keyof SyncBenchCamSample,
  title: string,
): { rows: number[][] } | { reason: string } {
  const rows: number[][] = [];
  for (const sample of samples) {
    if (!Array.isArray(sample.cams) || sample.cams.length !== cams.length) {
      return { reason: `trigger ${sample.trigger} reported a different camera set` };
    }
    const row: number[] = [];
    for (let i = 0; i < cams.length; i += 1) {
      const cam = sample.cams[i];
      const value = cam?.[key];
      if (!isFiniteNumber(value)) {
        return { reason: `the device did not report ${title} for every camera` };
      }
      row.push(value);
    }
    rows.push(row);
  }
  return { rows };
}

function unavailable(
  spec: (typeof METRICS)[number],
  reason: string,
): SkewMetricReport {
  return {
    metric: spec.metric,
    title: spec.title,
    note: spec.note,
    unavailableReason: reason,
    cameras: [],
    spreadUs: null,
    band: null,
    distribution: null,
    worstBand: null,
  };
}

function buildMetric(
  spec: (typeof METRICS)[number],
  samples: SyncBenchTriggerSample[],
  cams: string[],
  result: SyncBenchJobResult,
): SkewMetricReport {
  const declared = result.unavailable?.[spec.metric];
  if (declared) return unavailable(spec, declared);
  if (samples.length === 0 || cams.length === 0) {
    return unavailable(spec, 'the run returned no timing samples');
  }

  const collected = collect(samples, cams, spec.key, spec.title);
  if ('reason' in collected) {
    return unavailable(spec, result.unavailableReason ?? collected.reason);
  }

  try {
    // Per-camera mean over the run, rebased so the earliest camera reads
    // +0.00ms — the convention 02 §10's example prints.
    const means = cams.map((_, i) => {
      let total = 0;
      for (const row of collected.rows) total += row[i];
      return total / collected.rows.length;
    });
    const base = Math.min(...means);
    const cameras: SkewCameraRow[] = cams.map((cam, i) => ({
      cam,
      label: cameraLabel(cam),
      offsetUs: means[i] - base,
    }));

    const spread = spreadUs(means);
    const distribution = skewStats(collected.rows.map((row) => spreadUs(row)));
    const band = bandForSpreadMs(spread / 1000);
    const p95Band = bandForSpreadMs(distribution.p95 / 1000);
    const worse = SKEW_BAND_ORDER.indexOf(p95Band) > SKEW_BAND_ORDER.indexOf(band);

    return {
      metric: spec.metric,
      title: spec.title,
      note: spec.note,
      unavailableReason: null,
      cameras,
      spreadUs: spread,
      band,
      distribution,
      worstBand: worse ? p95Band : null,
    };
  } catch (err) {
    // Belt and braces. The validation above should make this unreachable; if
    // it is ever wrong, the page still has to render, and it renders the fault
    // rather than a number nobody measured.
    return unavailable(
      spec,
      `could not be summarised — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * One bench run → the display model. Never throws: a metric that cannot be
 * summarised comes back with `unavailableReason` set and every figure null.
 */
export function buildSkewReport(
  result: SyncBenchJobResult,
  requestedTriggers: number,
): SkewReport {
  const samples = Array.isArray(result.samples) ? result.samples : [];
  const first = samples[0];
  const cams = Array.isArray(first?.cams) ? first.cams.map((c) => c.cam) : [];

  return {
    requestedTriggers,
    triggers: samples.length,
    cameras: cams.map(cameraLabel),
    frameIntervalUs: isFiniteNumber(result.frameIntervalUs) ? result.frameIntervalUs : null,
    metrics: METRICS.map((spec) => buildMetric(spec, samples, cams, result)),
  };
}

// ---- running the job ----

export interface SkewProgress {
  /** Triggers completed, scaled from the device's 0..1 progress. */
  done: number;
  total: number;
  message: string | null;
}

export interface SkewRunOptions {
  requestedTriggers: number;
  onProgress?: (progress: SkewProgress) => void;
  /**
   * Cancel probe. There is no cancel command in the protocol (04 §15) — a job
   * runs to completion or dies with the session — so cancelling means we stop
   * consuming and discard the result the device will still send.
   */
  stopped?: () => boolean;
}

/**
 * Drive one SYNC_BENCH job to a report. Resolves null when the run was
 * cancelled: the device finished it anyway, but nobody asked for those numbers.
 */
export async function consumeSkewBenchJob(
  handle: JobHandle<SyncBenchJobResult>,
  options: SkewRunOptions,
): Promise<SkewReport | null> {
  const cancelled = () => options.stopped?.() === true;

  if (!cancelled()) {
    for await (const event of handle.progress) {
      if (cancelled()) break;
      options.onProgress?.({
        done: Math.round((event.progress ?? 0) * options.requestedTriggers),
        total: options.requestedTriggers,
        message: event.message ?? null,
      });
    }
  }

  let result: SyncBenchJobResult;
  try {
    result = (await handle.result) ?? {};
  } catch (err) {
    // A run nobody is waiting for does not get to raise an error banner.
    if (cancelled()) return null;
    throw err;
  }
  if (cancelled()) return null;

  return buildSkewReport(result, options.requestedTriggers);
}
