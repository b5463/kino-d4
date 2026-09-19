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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Cmd, KinoProtocolClient, MockTransport } from '@kino/kdp';
import type { JobHandle, JobProgress, SyncBenchResponse } from '@kino/kdp';
import { MockKinoDevice } from '@kino/test-fixtures';

// SkewBench's only use of the session module is `getDevice()`, and the run
// lifecycle tests need a client they can hold open mid-run. Everything else in
// this file talks to the real protocol stack directly.
//
// The client seam is the pair `startSkewRun` actually uses: `request` (the
// reply decides which model the run is in) and `adoptJob` (only reached when
// that reply named a job).
interface ScriptedClient {
  request: (cmd: number, payload?: unknown, timeoutMs?: number) => Promise<unknown>;
  adoptJob?: (jobId: string) => JobHandle<SyncBenchJobResult>;
}
const session = vi.hoisted(() => ({ client: null as unknown as ScriptedClient | null }));
vi.mock('../src/app/session', () => ({
  getDevice: () => (session.client ? { client: session.client } : null),
}));

import {
  buildSkewReport,
  consumeSkewBenchJob,
  formatDistribution,
  formatOffsetMs,
  formatSpreadMs,
  SKEW_BANDS,
} from '../src/skew/skewReport';
import type { SkewProgress, SyncBenchJobResult } from '../src/skew/skewReport';
import {
  buildEdgeIntegrityReport,
  EDGE_VERDICT_LABEL,
  isSyncBenchResponse,
} from '../src/skew/edgeIntegrity';
import {
  cancelSkewRun,
  clampPulses,
  EdgeIntegrityView,
  IDLE_SKEW_RUN,
  isEdgeIntegrityReport,
  publishSkewRun,
  SkewBench,
  SkewMetricCard,
  SkewReportView,
  skewRunView,
  SkewVerdict,
  startSkewRun,
  syncBenchTimeoutMs,
  useSkewRun,
} from '../src/pages/Calibration/SkewBench';
import type { SkewBenchResult } from '../src/pages/Calibration/SkewBench';
import { getBenchResult, putBenchResult, resetBenchResults } from '../src/state/benchResults';
import { useDeviceBusy } from '../src/state/deviceBusy';
import { clearNavRequest, openSection, useNavRequest } from '../src/state/navRequest';
import type { SkewReport } from '../src/skew/skewReport';

/**
 * What `handle_sync_bench` (firmware/p4/main/kdp_server.c) answers: one
 * RESPONSE after the whole run, per-camera edge counts, nothing timed. Typed
 * against `SyncBenchResponse` because MockKinoDevice's blocking form is not
 * landed at the time of writing — it still answers a job on every profile.
 */
function edgeReply(patch: Partial<SyncBenchResponse> = {}): SyncBenchResponse {
  const cam = (id: 'cam1' | 'cam2' | 'cam3' | 'cam4', accepted = 25, raw = 25) => ({
    cam: id,
    watched: true,
    inputReady: true,
    deadtimeUs: 5000,
    seqBefore: 100,
    seqAfter: 100 + accepted,
    acceptedEdges: accepted,
    rawEdges: raw,
    rejectedEdges: raw - accepted,
    expected: 25,
    shortBy: 25 - accepted,
    extraRaw: raw - 25,
    polledMissed: Math.max(0, 25 - accepted),
    polledExtra: 0,
    firstBadPulse: accepted === 25 ? null : accepted + 1,
    edgeMonotonic: true,
    clean: accepted === 25,
  });
  return {
    ok: true,
    pulses: 25,
    gapMs: 100,
    polled: true,
    refusedByCapture: 0,
    pulseWidthUs: 200,
    cameras: [cam('cam1'), cam('cam2'), cam('cam3'), cam('cam4')],
    ...patch,
  };
}

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

/** A job result the test decides when to settle, so a run can be held open. */
function gate() {
  let resolve!: (r: SyncBenchJobResult) => void;
  const promise = new Promise<SyncBenchJobResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let the microtask queue drain so an in-flight run reaches its await. */
const settle = () => new Promise((r) => setTimeout(r, 0));

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

  it('refuses to summarise a run whose camera order changed mid-way', () => {
    // Same four cameras, same finite values, cam3 and cam4 swapped on the
    // second trigger. Matching by index alone would average cam3's samples
    // into cam4's column and print the result under a CAM3 label.
    const swapped = {
      trigger: 1,
      cams: [
        EXAMPLE.cams[0],
        EXAMPLE.cams[1],
        { ...EXAMPLE.cams[3], cam: 'cam4' },
        { ...EXAMPLE.cams[2], cam: 'cam3' },
      ],
    };
    const report = buildSkewReport({ samples: [EXAMPLE, swapped] }, 25);

    for (const metric of report.metrics) {
      expect(metric.unavailableReason).toMatch(/different order/i);
      expect(metric.spreadUs).toBeNull();
      expect(metric.band).toBeNull();
      expect(metric.cameras).toEqual([]);
    }

    const html = renderToStaticMarkup(<SkewReportView report={report} />);
    expect(html).toContain('NOT MEASURABLE');
    expect(html).not.toMatch(/[+-]\d+\.\d+ms/);
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
    // The firmware's own default and the verdict run, inside its 1..200 bound.
    expect(panel).toContain('RUN 100 PULSES');
    expect(panel).not.toMatch(/\d+\.\d+\s*ms/);

    const verdict = renderToStaticMarkup(<SkewVerdict />);
    expect(verdict).toContain('has not been measured');
    expect(verdict).toContain('RUN SKEW BENCH');
    expect(verdict).not.toMatch(/\d+\.\d+\s*ms/);
  });
});

describe('run lifecycle across an unmount', () => {
  afterEach(() => {
    session.client = null;
    useSkewRun.setState(IDLE_SKEW_RUN);
    useDeviceBusy.setState({ owner: null, label: null });
    resetBenchResults();
  });

  it('keeps a run alive across an unmount and refuses a second one', async () => {
    const held = gate();
    let started = 0;
    session.client = {
      request: async () => {
        started += 1;
        return { jobId: 'job_scripted', accepted: true };
      },
      adoptJob: () =>
        scriptedJob(held.promise, [{ jobId: 'job_scripted', progress: 0.2, message: '40/200 pulses' }]),
    };

    // 1000 is more than one SYNC_BENCH call may fire; the run is clamped to
    // the firmware's 200 and the panel says so.
    const inFlight = startSkewRun(1000);
    await settle();

    // The run is device work: it is still live with no panel mounted.
    const live = useSkewRun.getState();
    expect(live.token).not.toBeNull();
    expect(live.requested).toBe(200);
    expect(live.done).toBe(40);
    expect(useDeviceBusy.getState().owner).toBe('skew');

    // A remounted panel lands in the running state, not a lying idle one, and
    // RUN is not startable.
    const view = skewRunView(useSkewRun.getState(), null);
    expect(view.running).toBe(true);
    expect(view.canStart).toBe(false);
    expect(view.showCancel).toBe(true);
    expect(view.status).toBe('RUNNING 40/200 PULSES');

    // A second bench on the same UART is refused — no new request, no new token.
    await startSkewRun(25);
    expect(started).toBe(1);
    expect(useSkewRun.getState().token).toBe(live.token);
    expect(useSkewRun.getState().requested).toBe(200);

    held.resolve({ triggers: 1, samples: [EXAMPLE] });
    await inFlight;

    // Only now is the link released and the result published.
    expect(useSkewRun.getState().token).toBeNull();
    expect(useDeviceBusy.getState().owner).toBeNull();
    expect(getBenchResult<SkewReport>('skew')).not.toBeNull();
  });

  it('cancels the live run and records nothing', async () => {
    const held = gate();
    session.client = {
      request: async () => ({ jobId: 'job_scripted', accepted: true }),
      adoptJob: () => scriptedJob(held.promise),
    };

    const inFlight = startSkewRun(100);
    await settle();
    cancelSkewRun();
    expect(skewRunView(useSkewRun.getState(), null).status).toBe(
      'Stopping after current pulse…',
    );
    expect(skewRunView(useSkewRun.getState(), null).showCancel).toBe(false);

    held.resolve({ triggers: 1, samples: [EXAMPLE] });
    await inFlight;

    expect(getBenchResult('skew')).toBeNull();
    expect(useSkewRun.getState().cancelled).toBe(true);
    expect(useDeviceBusy.getState().owner).toBeNull();
    expect(skewRunView(useSkewRun.getState(), null).status).toBe(
      'Run cancelled. Nothing was recorded.',
    );
  });

  it('sends the firmware request shape with a deadline sized to the run', async () => {
    const calls: { cmd: number; payload: unknown; timeoutMs: number | undefined }[] = [];
    session.client = {
      request: async (cmd, payload, timeoutMs) => {
        calls.push({ cmd, payload, timeoutMs });
        return edgeReply();
      },
    };
    await startSkewRun(25);
    expect(calls).toEqual([
      { cmd: Cmd.SYNC_BENCH, payload: { pulses: 25, gapMs: 100, poll: true }, timeoutMs: 25 * 100 + 10000 },
    ]);
    expect(clampPulses(1000)).toBe(200);
    expect(clampPulses(0)).toBe(1);
    // 200 pulses at 1000 ms is the firmware's ~200 s maximum; the deadline must outlast it.
    expect(syncBenchTimeoutMs(200, 1000)).toBeGreaterThan(200_000);
  });

  it('reads a blocking edge report and never calls adoptJob for it', async () => {
    let adopted = 0;
    session.client = {
      request: async () => edgeReply(),
      adoptJob: () => {
        adopted += 1;
        return scriptedJob({ triggers: 1, samples: [EXAMPLE] });
      },
    };
    await startSkewRun(25);
    expect(adopted).toBe(0);
    expect(useSkewRun.getState().token).toBeNull();
    expect(useDeviceBusy.getState().owner).toBeNull();

    const entry = getBenchResult<SkewBenchResult>('skew');
    expect(entry).not.toBeNull();
    expect(isEdgeIntegrityReport(entry!.result)).toBe(true);
    const report = entry!.result;
    if (!isEdgeIntegrityReport(report)) throw new Error('expected an edge report');
    expect(report.verdict).toBe('clean');
    expect(report.pulses).toBe(25);
    expect(report.cameras.map((c) => c.label)).toEqual(['CAM1', 'CAM2', 'CAM3', 'CAM4']);
  });

  it('surfaces a refused SYNC_BENCH as an error, not a hung run', async () => {
    session.client = {
      request: async () => {
        throw new Error('BUSY: A capture is running');
      },
    };
    await startSkewRun(25);
    expect(useSkewRun.getState().error).toMatch(/capture is running/);
    expect(useSkewRun.getState().token).toBeNull();
    expect(useDeviceBusy.getState().owner).toBeNull();
  });

  it('does not let a superseded run overwrite a newer result', () => {
    const newer = buildSkewReport({ samples: [EXAMPLE, { ...EXAMPLE, trigger: 1 }] }, 250);
    const older = buildSkewReport({ samples: [EXAMPLE] }, 25);
    putBenchResult<SkewReport>('skew', newer);
    // Token 1's run is over; token 2 is the live one.
    useSkewRun.setState({ ...IDLE_SKEW_RUN, token: 2, requested: 250 });

    expect(publishSkewRun(1, older)).toBe(false);
    expect(getBenchResult<SkewReport>('skew')!.result.triggers).toBe(2);

    // The live run still publishes normally.
    expect(publishSkewRun(2, older)).toBe(true);
    expect(getBenchResult<SkewReport>('skew')!.result.triggers).toBe(1);
  });
});

describe('cross-section nav requests', () => {
  afterEach(() => useNavRequest.setState({ request: null }));

  it('is spent once handled, so a later visit keeps its own tab', () => {
    openSection('calibration', 'skew');
    const request = useNavRequest.getState().request;
    expect(request).toMatchObject({ page: 'calibration', tab: 'skew' });

    // What CalibrationPage's effect does after applying the tab.
    clearNavRequest(request!.nonce);
    expect(useNavRequest.getState().request).toBeNull();

    // A page mounting later sees nothing to act on and keeps its default.
    expect(useNavRequest.getState().request).toBeNull();
  });

  it('does not let a stale handler swallow a newer request', () => {
    openSection('calibration', 'skew');
    const stale = useNavRequest.getState().request!.nonce;
    openSection('calibration', 'calibration');
    const current = useNavRequest.getState().request!;

    clearNavRequest(stale);
    expect(useNavRequest.getState().request).toEqual(current);
  });
});

describe('edge integrity report from shipped firmware', () => {
  it('recognises the blocking reply shape and not a job start', () => {
    expect(isSyncBenchResponse(edgeReply())).toBe(true);
    expect(isSyncBenchResponse({ jobId: 'job_1', accepted: true })).toBe(false);
    expect(isSyncBenchResponse(null)).toBe(false);
  });

  it('reads every watched camera clean as TRIGGER WIRE CLEAN and prints no milliseconds', () => {
    const report = buildEdgeIntegrityReport(edgeReply(), 25);
    expect(report.kind).toBe('edge-integrity');
    expect(report.verdict).toBe('clean');
    expect(report.cameras).toHaveLength(4);
    expect(report.cameras[0]).toMatchObject({
      cam: 'cam1',
      label: 'CAM1',
      watched: true,
      acceptedEdges: 25,
      rawEdges: 25,
      rejectedEdges: 0,
      expected: 25,
      shortBy: 0,
      edgeMonotonic: true,
      clean: true,
    });

    const html = renderToStaticMarkup(<EdgeIntegrityView report={report} />);
    expect(html).toContain(EDGE_VERDICT_LABEL.clean);
    expect(html).toContain('TRIGGER WIRE CLEAN');
    // The one sentence the display must always carry on this firmware.
    expect(html).toMatch(/Exposure skew is not measured by this firmware/);
    expect(html).toContain('vsyncTelemetry false');
    // Edge counts are counts. Nothing here may read as a timing figure.
    expect(html).not.toMatch(/\d+\.\d+\s*ms/);
    expect(html).not.toContain('GOOD TARGET');
  });

  it('calls the wire DIRTY when one camera came up short, naming the pulse', () => {
    const reply = edgeReply();
    reply.cameras[2] = {
      ...reply.cameras[2],
      acceptedEdges: 23,
      seqAfter: 123,
      shortBy: 2,
      polledMissed: 2,
      firstBadPulse: 9,
      clean: false,
    };
    const report = buildEdgeIntegrityReport(reply, 25);
    expect(report.verdict).toBe('dirty');
    expect(report.cameras[2]).toMatchObject({ shortBy: 2, firstBadPulse: 9, clean: false });

    const html = renderToStaticMarkup(<EdgeIntegrityView report={report} />);
    expect(html).toContain('TRIGGER WIRE DIRTY');
    expect(html).toContain('first bad pulse 9');
  });

  it('does not call an unwatched run clean, and says a short run was short', () => {
    const nobody = buildEdgeIntegrityReport(
      edgeReply({ cameras: edgeReply().cameras.map((c) => ({ cam: c.cam, watched: false })) }),
      25,
    );
    expect(nobody.verdict).toBe('unwatched');
    expect(nobody.cameras.every((c) => c.acceptedEdges === null && c.clean === null)).toBe(true);
    expect(renderToStaticMarkup(<EdgeIntegrityView report={nobody} />)).toContain('NOT WATCHED');

    const cut = buildEdgeIntegrityReport(edgeReply({ pulses: 10, refusedByCapture: 1 }), 25);
    const html = renderToStaticMarkup(<EdgeIntegrityView report={cut} />);
    expect(html).toContain('Asked for 25');
    expect(html).toContain('fired 10');
    expect(html).toContain('capture claimed the cameras');
  });

  it('judges an older reply without `clean` by the same rule the firmware uses', () => {
    const reply = edgeReply();
    reply.cameras = reply.cameras.map((c) => {
      const { clean: _clean, shortBy: _shortBy, extraRaw: _extraRaw, ...rest } = c;
      return rest;
    });
    reply.cameras[1] = { ...reply.cameras[1], acceptedEdges: 24 };
    const report = buildEdgeIntegrityReport(reply, 25);
    expect(report.cameras[0]).toMatchObject({ clean: true, shortBy: 0, extraRaw: 0 });
    expect(report.cameras[1]).toMatchObject({ clean: false, shortBy: 1 });
    expect(report.verdict).toBe('dirty');
  });
});

describe('SYNC_BENCH over the protocol stack', () => {
  afterEach(() => {
    session.client = null;
    useSkewRun.setState(IDLE_SKEW_RUN);
    useDeviceBusy.setState({ owner: null, label: null });
    resetBenchResults();
  });

  it('adopts the job the d4-sim-full reference device starts and builds a timing report', async () => {
    const mock = new MockKinoDevice();
    mock.setFirmwareProfile('d4-sim-full');
    transport = new MockTransport(mock);
    await transport.open();
    const client = new KinoProtocolClient(transport);
    session.client = client as unknown as ScriptedClient;

    // The whole path: one `request`, a `{jobId}` reply, `adoptJob`, the job
    // consumed to a report. The trigger count is whatever the reference device
    // fired — at the time of writing its handler reads `triggers`, not
    // `pulses`, so it is not pinned here.
    await startSkewRun(12);

    expect(useSkewRun.getState().error).toBeNull();
    expect(useSkewRun.getState().unsupported).toBe(false);
    const entry = getBenchResult<SkewBenchResult>('skew');
    expect(entry).not.toBeNull();
    const report = entry!.result;
    if (isEdgeIntegrityReport(report)) throw new Error('reference device should answer a job');
    expect(report.triggers).toBeGreaterThan(0);
    expect(report.cameras).toEqual(['CAM1', 'CAM2', 'CAM3', 'CAM4']);
    for (const metric of report.metrics) {
      expect(metric.unavailableReason).toBeNull();
      expect(metric.distribution!.count).toBe(report.triggers);
      expect(metric.spreadUs).toBeGreaterThanOrEqual(0);
    }
    expect(useDeviceBusy.getState().owner).toBeNull();
  });

  it('reads the blocking edge report the shipped-firmware profile answers, with no job', async () => {
    const mock = new MockKinoDevice();
    // 0.4.9..0.4.56: SYNC_BENCH is one blocking RESPONSE of edge counts, the
    // way kdp_server.c answers it; one camera fitted, so three are unwatched.
    mock.setFirmwareProfile('d4-settings-0-4-9');
    transport = new MockTransport(mock);
    await transport.open();
    const client = new KinoProtocolClient(transport);
    session.client = client as unknown as ScriptedClient;

    await startSkewRun(12);

    expect(useSkewRun.getState().error).toBeNull();
    expect(useSkewRun.getState().unsupported).toBe(false);
    const entry = getBenchResult<SkewBenchResult>('skew');
    expect(entry).not.toBeNull();
    const report = entry!.result;
    if (!isEdgeIntegrityReport(report)) throw new Error('shipped firmware answers a blocking edge report');
    expect(report.pulses).toBe(12);
    expect(report.cameras.filter((c) => c.watched).length).toBeGreaterThan(0);
    // The watched node saw every pulse once: the wire is clean. No milliseconds anywhere.
    expect(report.verdict).toBe('clean');
    expect(useDeviceBusy.getState().owner).toBeNull();
  });

  it('still consumes a job handle the classic way', async () => {
    const mock = new MockKinoDevice();
    mock.setFirmwareProfile('d4-sim-full');
    transport = new MockTransport(mock);
    await transport.open();
    const client = new KinoProtocolClient(transport);

    const handle = await client.startJob<SyncBenchJobResult>(Cmd.SYNC_BENCH, { triggers: 12 });
    const report = await consumeSkewBenchJob(handle, { requestedTriggers: 12 });
    expect(report).not.toBeNull();
    expect(report!.cameras).toEqual(['CAM1', 'CAM2', 'CAM3', 'CAM4']);
  });
});
