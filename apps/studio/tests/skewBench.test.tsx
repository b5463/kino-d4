// Skew Bench — the 02 §10 product surface.
//
// Two levels are exercised here and both matter:
//
//  - `buildSkewReport` / `consumeSkewBenchJob` against a scripted JobHandle.
//    A scripted handle is used rather than the mock for the display tests
//    because 02 §10's example data is a fixed set of numbers and the mock's
//    samples are seeded per run — the band boundaries and the `+0.61ms`
//    formatting can only be pinned against numbers this file owns.
//  - one pass over the real protocol stack (MockTransport →
//    KinoProtocolClient → MockKinoDevice), which is what proves
//    `Cmd.SYNC_BENCH` reaches a device and that a real job result survives
//    `buildSkewReport`.
//
// Rendering goes through `react-dom/server`: it needs no DOM and no extra
// dependency, and static markup is enough to assert that a section printed a
// reason instead of a number.

import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Cmd, KinoProtocolClient, MockTransport } from '@kino/kdp';
import type { JobHandle, JobProgress } from '@kino/kdp';
import { MockKinoDevice } from '@kino/test-fixtures';
import {
  buildSkewReport,
  consumeSkewBenchJob,
  formatDistribution,
  formatOffsetMs,
  formatSpreadMs,
  SKEW_BANDS,
} from '../src/skew/skewReport';
import type { SkewProgress, SyncBenchJobResult } from '../src/skew/skewReport';
import { SkewBench, SkewMetricCard, SkewReportView, SkewVerdict } from '../src/pages/Calibration/SkewBench';
import { getBenchResult, putBenchResult, resetBenchResults } from '../src/state/benchResults';
import type { SkewReport } from '../src/skew/skewReport';

/**
 * 02 §10's worked example, µs. GPIO spreads 0.14 ms (excellent); VSYNC
 * spreads 1.20 ms, which is the GOOD TARGET band.
 */
const EXAMPLE = {
  trigger: 0,
  cams: [
    { cam: 'cam1', gpioUs: 0, vsyncPhaseUs: 0, exposureUs: 0 },
    { cam: 'cam2', gpioUs: 90, vsyncPhaseUs: 610, exposureUs: 640 },
    { cam: 'cam3', gpioUs: 140, vsyncPhaseUs: 1200, exposureUs: 1260 },
    { cam: 'cam4', gpioUs: 110, vsyncPhaseUs: 420, exposureUs: 450 },
  ],
};

function scriptedJob(
  result: SyncBenchJobResult | Promise<SyncBenchJobResult>,
  progress: JobProgress[] = [],
): JobHandle<SyncBenchJobResult> {
  return {
    jobId: 'job_scripted',
    progress: (async function* () {
      for (const p of progress) yield p;
    })(),
    result: Promise.resolve(result),
  };
}

let transport: MockTransport | null = null;

afterEach(async () => {
  await transport?.close();
  transport = null;
});

describe('skew report from a bench run', () => {
  it('keeps the three metrics as separate sections', () => {
    const report = buildSkewReport({ samples: [EXAMPLE] }, 25);
    expect(report.metrics.map((m) => m.metric)).toEqual(['gpio', 'vsync', 'exposure']);

    const html = renderToStaticMarkup(<SkewReportView report={report} />);
    expect(html).toContain('GPIO DISTRIBUTION');
    expect(html).toContain('VSYNC PHASE');
    expect(html).toContain('EFFECTIVE EXPOSURE');
    // One spread per metric — never one collapsed number for the run.
    expect(html.match(/Spread/g)).toHaveLength(3);
  });

  it('prints the 02 §10 example offsets and spreads', () => {
    const report = buildSkewReport({ samples: [EXAMPLE] }, 25);
    const [gpio, vsync] = report.metrics;

    expect(gpio.cameras.map((c) => c.label)).toEqual(['CAM1', 'CAM2', 'CAM3', 'CAM4']);
    expect(gpio.cameras.map((c) => formatOffsetMs(c.offsetUs))).toEqual([
      '+0.00ms',
      '+0.09ms',
      '+0.14ms',
      '+0.11ms',
    ]);
    expect(formatSpreadMs(gpio.spreadUs!)).toBe('0.14ms');

    expect(vsync.cameras.map((c) => formatOffsetMs(c.offsetUs))).toEqual([
      '+0.00ms',
      '+0.61ms',
      '+1.20ms',
      '+0.42ms',
    ]);
    expect(formatSpreadMs(vsync.spreadUs!)).toBe('1.20ms');
  });

  it('labels a 1.2 ms VSYNC spread GOOD TARGET', () => {
    const report = buildSkewReport({ samples: [EXAMPLE] }, 25);
    const vsync = report.metrics[1];
    expect(vsync.band).toBe('good');

    const html = renderToStaticMarkup(<SkewMetricCard metric={vsync} />);
    expect(html).toContain('GOOD TARGET');
    // 07 §18 vocabulary only — kdp's gradeSkew calls this band USABLE.
    expect(html).not.toContain('USABLE');
  });

  it('uses the spec band wording across the whole table', () => {
    expect(Object.values(SKEW_BANDS).map((b) => b.label)).toEqual([
      'EXCELLENT',
      'VERY GOOD',
      'GOOD TARGET',
      'WARNING',
      'POOR FOR MOVING SUBJECTS',
      'FAIL',
    ]);
  });

  it('renders an unmeasurable metric as a reason and no numbers', () => {
    const report = buildSkewReport(
      {
        samples: [
          {
            trigger: 0,
            cams: EXAMPLE.cams.map((c) => ({ ...c, exposureUs: null })),
          },
        ],
        unavailable: { exposure: 'no exposure telemetry in this firmware' },
      },
      25,
    );
    const exposure = report.metrics[2];
    expect(exposure.unavailableReason).toBe('no exposure telemetry in this firmware');
    expect(exposure.spreadUs).toBeNull();
    expect(exposure.band).toBeNull();
    expect(exposure.distribution).toBeNull();
    expect(exposure.cameras).toEqual([]);

    const html = renderToStaticMarkup(<SkewMetricCard metric={exposure} />);
    expect(html).toContain('NOT MEASURABLE — no exposure telemetry in this firmware');
    // Nothing that could be read as a measurement.
    expect(html).not.toMatch(/\d+\.\d+\s*ms/);

    // The other two metrics are unaffected — one missing metric must not
    // blank the run.
    expect(report.metrics[0].band).toBe('excellent');
    expect(report.metrics[1].band).toBe('good');
  });

  it('takes the camera count from the run, not from a hard-coded four', () => {
    const report = buildSkewReport(
      {
        samples: [
          {
            trigger: 0,
            cams: [
              { cam: 'cam1', gpioUs: 0, vsyncPhaseUs: 0, exposureUs: 0 },
              { cam: 'cam2', gpioUs: 40, vsyncPhaseUs: 200, exposureUs: 220 },
              { cam: 'cam3', gpioUs: 80, vsyncPhaseUs: 300, exposureUs: 330 },
            ],
          },
        ],
      },
      25,
    );
    expect(report.cameras).toEqual(['CAM1', 'CAM2', 'CAM3']);
    expect(report.metrics[0].cameras).toHaveLength(3);
  });

  it('routes a non-finite sample to the reason path instead of throwing', () => {
    const report = buildSkewReport(
      {
        samples: [
          {
            trigger: 0,
            cams: [
              { cam: 'cam1', gpioUs: 0, vsyncPhaseUs: Number.NaN, exposureUs: 0 },
              { cam: 'cam2', gpioUs: 40, vsyncPhaseUs: 200, exposureUs: 220 },
            ],
          },
        ],
      },
      25,
    );
    expect(report.metrics[1].unavailableReason).toMatch(/vsync/i);
    expect(report.metrics[1].spreadUs).toBeNull();
    expect(report.metrics[0].band).toBe('excellent');
  });

  it('formats the distribution line the way 02 §10 reads it', () => {
    expect(
      formatDistribution({ mean: 420, median: 390, p95: 880, max: 1200, count: 250 }),
    ).toBe('mean 0.42 · median 0.39 · p95 0.88 · max 1.20 ms');
  });

  it('reports no run at all as a reason, not as zero skew', () => {
    const report = buildSkewReport({ samples: [] }, 250);
    expect(report.triggers).toBe(0);
    for (const metric of report.metrics) {
      expect(metric.unavailableReason).toMatch(/no timing samples/i);
      expect(metric.spreadUs).toBeNull();
    }
  });
});

describe('consuming a bench job', () => {
  it('streams progress and reports the trigger count the device returned', async () => {
    const seen: SkewProgress[] = [];
    const handle = scriptedJob(
      { triggers: 2, samples: [EXAMPLE, { ...EXAMPLE, trigger: 1 }] },
      [
        { jobId: 'job_scripted', progress: 0.5, step: 'trigger', message: '1/2 triggers' },
        { jobId: 'job_scripted', progress: 1, step: 'trigger', message: '2/2 triggers' },
      ],
    );

    const report = await consumeSkewBenchJob(handle, {
      requestedTriggers: 250,
      onProgress: (p) => seen.push(p),
    });

    expect(seen.map((p) => p.done)).toEqual([125, 250]);
    expect(report).not.toBeNull();
    // The mock clamps triggers at 200 and real firmware may return fewer than
    // asked for. The display counts what came back.
    expect(report!.triggers).toBe(2);
    expect(report!.requestedTriggers).toBe(250);
  });

  it('stops consuming when the run is cancelled and publishes nothing', async () => {
    const handle = scriptedJob({ triggers: 1, samples: [EXAMPLE] }, [
      { jobId: 'job_scripted', progress: 0.5 },
    ]);
    const report = await consumeSkewBenchJob(handle, {
      requestedTriggers: 25,
      stopped: () => true,
    });
    expect(report).toBeNull();
  });
});

describe('the panel and the verdict it publishes', () => {
  afterEach(() => resetBenchResults());

  // `react-dom/server` reads a zustand store through `getServerSnapshot`,
  // which is the store's *initial* state — a static render can never see a
  // result put into the store by the same test. So the store round trip is
  // asserted through `getBenchResult`, and the rendering of that result is
  // asserted against the views that take it as a prop.
  it('publishes the run for Overview to quote, through the shared bench store', () => {
    putBenchResult<SkewReport>('skew', buildSkewReport({ samples: [EXAMPLE] }, 250));

    const entry = getBenchResult<SkewReport>('skew');
    expect(entry).not.toBeNull();
    expect(entry!.staleReason).toBeNull();

    const html = renderToStaticMarkup(<SkewReportView report={entry!.result} />);
    expect(html).toContain('GOOD TARGET');
    expect(html).toContain('1 TRIGGERS · 4 CAMERAS');
    // 250 asked for, 1 returned — the display counts what came back and says so.
    expect(html).toContain('The device returned 1');
  });

  it('renders the bench panel with no run recorded and no invented numbers', () => {
    const panel = renderToStaticMarkup(<SkewBench />);
    expect(panel).toContain('SKEW BENCH');
    expect(panel).toContain('RUN 250 TRIGGERS');
    expect(panel).not.toMatch(/\d+\.\d+\s*ms/);

    const verdict = renderToStaticMarkup(<SkewVerdict />);
    expect(verdict).toContain('has not been measured');
    expect(verdict).toContain('RUN SKEW BENCH');
    expect(verdict).not.toMatch(/\d+\.\d+\s*ms/);
  });
});

describe('SYNC_BENCH over the protocol stack', () => {
  it('runs a bench against the reference device and builds a report', async () => {
    const mock = new MockKinoDevice();
    transport = new MockTransport(mock);
    await transport.open();
    const client = new KinoProtocolClient(transport);

    const handle = await client.startJob<SyncBenchJobResult>(Cmd.SYNC_BENCH, { triggers: 12 });
    const report = await consumeSkewBenchJob(handle, { requestedTriggers: 12 });

    expect(report).not.toBeNull();
    expect(report!.triggers).toBe(12);
    expect(report!.cameras).toEqual(['CAM1', 'CAM2', 'CAM3', 'CAM4']);
    for (const metric of report!.metrics) {
      expect(metric.unavailableReason).toBeNull();
      expect(metric.distribution!.count).toBe(12);
      expect(metric.spreadUs).toBeGreaterThanOrEqual(0);
    }
  });
});
