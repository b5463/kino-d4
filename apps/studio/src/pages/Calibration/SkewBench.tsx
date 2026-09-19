// Skew Bench — 02 §10's first-class surface.
//
// Three metrics, three sections, never one collapsed "sync score". A metric
// the device could not measure prints the device's reason and no numbers
// (04 §13); it does not print zero, and it does not blank the other two.
//
// The Developer page keeps its own raw timing views. This is the product one:
// it grades against 02 §10's band table wording, not kdp's `gradeSkew`.

import { useState } from 'react';
import { create } from 'zustand';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { SegField } from '../../components/fields';
import { Unsupported } from '../../components/Unsupported';
import { Cmd, KinoUnsupportedError } from '@kino/kdp';
import type { SyncBenchRequest, SyncBenchResponse } from '@kino/kdp';
import { getDevice } from '../../app/session';
import { useDeviceStore } from '../../state/deviceStore';
import { claimDevice, releaseDevice, useBlockedBy } from '../../state/deviceBusy';
import {
  benchStamp,
  clearBenchResult,
  putBenchResult,
  useBenchResult,
} from '../../state/benchResults';
import { openSection } from '../../state/navRequest';
import {
  consumeSkewBenchJob,
  formatDistribution,
  formatOffsetMs,
  formatSpreadMs,
  SKEW_BANDS,
  SKEW_BAND_ORDER,
} from '../../skew/skewReport';
import type { SkewMetricReport, SkewReport, SyncBenchJobResult } from '../../skew/skewReport';
import {
  buildEdgeIntegrityReport,
  EDGE_VERDICT_LABEL,
  isSyncBenchResponse,
} from '../../skew/edgeIntegrity';
import type { EdgeIntegrityReport } from '../../skew/edgeIntegrity';

const OWNER = 'skew';
const LABEL = 'SKEW BENCH';

/**
 * What the shared bench store holds under `skew`. Two shapes, because two
 * peers answer SYNC_BENCH differently (see `startSkewRun`): shipped firmware
 * reports edge counts, the reference device reports timing.
 */
export type SkewBenchResult = SkewReport | EdgeIntegrityReport;

export function isEdgeIntegrityReport(result: SkewBenchResult): result is EdgeIntegrityReport {
  return (result as EdgeIntegrityReport).kind === 'edge-integrity';
}

/**
 * The firmware bounds one SYNC_BENCH call at 1..200 pulses and 20..1000 ms
 * between them (`handle_sync_bench`); a longer run is several calls. 100 is
 * the firmware's own default and the verdict run; 25 is a look before
 * committing to it; 200 is the most one call can do.
 */
export const SYNC_BENCH_MAX_PULSES = 200;
export const SYNC_BENCH_GAP_MS = 100;

const RUN_SIZES = [
  { value: '25', label: '25 QUICK' },
  { value: '100', label: '100 BENCH' },
  { value: '200', label: '200 MAX' },
];

/** The 1..200 range the firmware NACKs outside of. */
export function clampPulses(requested: number): number {
  if (!Number.isFinite(requested)) return 1;
  return Math.min(SYNC_BENCH_MAX_PULSES, Math.max(1, Math.round(requested)));
}

/** How long to wait: the firmware blocks for pulses × gap, plus its own overhead. */
export function syncBenchTimeoutMs(pulses: number, gapMs: number): number {
  return pulses * gapMs + 10000;
}

// ---- the run, which outlives the panel ----

/**
 * A bench run is device work, not component state.
 *
 * Calibration unmounts this panel on a tab switch and a 1000-trigger soak
 * takes minutes. With the run in `useState` that was three bugs at once:
 * coming back showed an idle panel, `useBlockedBy('skew')` reported the link
 * free to its own owner, and `claimDevice('skew')` handed the claim straight
 * back — so a second SYNC_BENCH went out on the same UART while the first was
 * still consuming, the first run's cleanup released the link out from under
 * the second, and whichever finished last wrote its numbers over the other's.
 *
 * So the run lives here, module-level, identified by a token. The panel
 * renders whatever is in flight; a run that is no longer the live one can
 * neither publish a result nor release the link.
 */
export interface SkewRunState {
  /** Identifies the live run. Null when no bench is running. */
  token: number | null;
  requested: number;
  done: number;
  stopping: boolean;
  cancelled: boolean;
  unsupported: boolean;
  error: string | null;
}

export const IDLE_SKEW_RUN: SkewRunState = {
  token: null,
  requested: 0,
  done: 0,
  stopping: false,
  cancelled: false,
  unsupported: false,
  error: null,
};

export const useSkewRun = create<SkewRunState>(() => IDLE_SKEW_RUN);

let nextRunToken = 0;
/** Cancel flag, honoured by the live run only. */
let stopRequested = false;

function isCurrentRun(token: number): boolean {
  return useSkewRun.getState().token === token;
}

/**
 * A finished run publishes only while it is still the live one. Returns false
 * when it has been superseded — its numbers describe a device state that has
 * already been re-measured, and overwriting a newer result with them is how a
 * bench ends up reporting the wrong verdict with a current timestamp.
 */
export function publishSkewRun(token: number, report: SkewBenchResult | null): boolean {
  if (!isCurrentRun(token)) return false;
  if (report) putBenchResult<SkewBenchResult>(OWNER, report);
  else useSkewRun.setState({ cancelled: true });
  return true;
}

/** The shape the reference device answers SYNC_BENCH with (04 §15 job start). */
interface SyncBenchJobStart {
  jobId: string;
  accepted?: boolean;
}

/**
 * Start a bench. Refuses while another one is in flight, whether or not the
 * panel that started it is still mounted.
 *
 * SYNC_BENCH is the one command whose reply shape differs between peers.
 * Shipped firmware blocks in-line for `pulses × gapMs` and answers ONE
 * RESPONSE carrying per-camera edge counts (`SyncBenchResponse`) — no job, no
 * progress, no timing. The reference device on the d4-sim-full profile answers
 * a job start `{jobId, accepted}` and streams timing samples. So the request
 * goes out as a plain `request` with a deadline sized to the run, and the reply
 * decides which model the run is in: a `jobId` is adopted through
 * `client.adoptJob` and consumed as before; anything else is read as the edge
 * report. `startJob` used to be sent unconditionally, which timed out at 3 s
 * against the firmware that ships and then threw JOB_NOT_ACCEPTED.
 */
export async function startSkewRun(requested: number): Promise<void> {
  if (useSkewRun.getState().token !== null) return;
  const client = getDevice()?.client;
  if (!client) return;
  if (!claimDevice(OWNER, LABEL)) return;

  const pulses = clampPulses(requested);
  const gapMs = SYNC_BENCH_GAP_MS;
  const token = (nextRunToken += 1);
  stopRequested = false;
  useSkewRun.setState({ ...IDLE_SKEW_RUN, token, requested: pulses });
  clearBenchResult(OWNER);

  try {
    const request: SyncBenchRequest = { pulses, gapMs, poll: true };
    const reply = await client.request<SyncBenchResponse | SyncBenchJobStart | null>(
      Cmd.SYNC_BENCH,
      request,
      syncBenchTimeoutMs(pulses, gapMs),
    );

    if (reply && typeof (reply as SyncBenchJobStart).jobId === 'string') {
      // Reference device: a job. Attach to the id the reply named; events that
      // arrived while the reply was in flight are held for the handle.
      const handle = client.adoptJob<SyncBenchJobResult>((reply as SyncBenchJobStart).jobId);
      const report = await consumeSkewBenchJob(handle, {
        requestedTriggers: pulses,
        onProgress: (p) => {
          if (isCurrentRun(token)) useSkewRun.setState({ done: p.done });
        },
        stopped: () => stopRequested && isCurrentRun(token),
      });
      publishSkewRun(token, report);
    } else if (isSyncBenchResponse(reply)) {
      // Shipped firmware: the whole run is already over. A cancel pressed
      // while it blocked cannot stop the camera (there is no cancel command);
      // it only means nobody wants the numbers.
      if (stopRequested && isCurrentRun(token)) publishSkewRun(token, null);
      else {
        if (isCurrentRun(token)) useSkewRun.setState({ done: pulses });
        publishSkewRun(token, buildEdgeIntegrityReport(reply, pulses));
      }
    } else {
      throw new Error('SYNC_BENCH answered neither a job start nor an edge report');
    }
  } catch (err) {
    if (isCurrentRun(token)) {
      if (err instanceof KinoUnsupportedError) useSkewRun.setState({ unsupported: true });
      else useSkewRun.setState({ error: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    // Only the current run owns the claim. A superseded run releasing it would
    // hand the link to a third party while a bench is still triggering.
    if (isCurrentRun(token)) {
      releaseDevice(OWNER);
      useSkewRun.setState({ token: null, stopping: false });
    }
  }
}

export function cancelSkewRun(): void {
  const run = useSkewRun.getState();
  if (run.token === null || run.stopping) return;
  stopRequested = true;
  useSkewRun.setState({ stopping: true });
}

/**
 * What the panel shows for a given run state. Pure, so the state a remounted
 * panel lands in is testable without a DOM.
 */
export function skewRunView(
  run: SkewRunState,
  blockedBy: string | null,
): { running: boolean; canStart: boolean; showCancel: boolean; status: string } {
  const running = run.token !== null;
  let status = '';
  if (run.stopping) status = 'Stopping after current pulse…';
  else if (running && run.done === 0) {
    // Shipped firmware answers once, when the run is over: there is no
    // progress to print, only how long the camera will take.
    status = `RUNNING ${run.requested} PULSES · answers in ≈${Math.ceil((run.requested * SYNC_BENCH_GAP_MS) / 1000)} s`;
  } else if (running) status = `RUNNING ${run.done}/${run.requested} PULSES`;
  else if (blockedBy) status = `${blockedBy} is running.`;
  else if (run.cancelled) status = 'Run cancelled. Nothing was recorded.';

  return {
    running,
    canStart: !running && blockedBy === null,
    showCancel: running && !run.stopping,
    status,
  };
}

/** One metric section. Exported so the display can be tested without a device. */
export function SkewMetricCard({ metric, order }: { metric: SkewMetricReport; order?: number }) {
  const band = metric.band ? SKEW_BANDS[metric.band] : null;
  const worst = metric.worstBand ? SKEW_BANDS[metric.worstBand] : null;
  return (
    <section
      className={`skew-metric${band ? ` skew-metric--${band.state}` : ''}`}
      data-metric={metric.metric}
    >
      <span className="microlabel">
        {order ? `${order} · ` : ''}
        {metric.title}
      </span>

      {/* One test, not three. A metric is either fully measured or it prints
          its reason — there is no half-measured state where a `?? 0` could
          put an unmeasured 0.00ms on screen. */}
      {metric.unavailableReason !== null || metric.spreadUs === null || band === null ? (
        <p className="skew-none">
          NOT MEASURABLE — {metric.unavailableReason ?? 'the device reported no figures'}
        </p>
      ) : (
        <>
          <dl className="skew-rows">
            {metric.cameras.map((row) => (
              <div key={row.cam} className="skew-row">
                <dt>{row.label}</dt>
                <dd>{formatOffsetMs(row.offsetUs)}</dd>
              </div>
            ))}
            <div className="skew-row skew-row--spread">
              <dt>Spread</dt>
              <dd>{formatSpreadMs(metric.spreadUs)}</dd>
            </div>
          </dl>

          <p className={`skew-band skew-band--${band.state}`}>
            <span className="skew-lamp" aria-hidden="true">
              {band.lamp}
            </span>
            {band.label}
            <span className="dim" style={{ textTransform: 'none' }}>
              {' '}
              {band.range}
            </span>
          </p>

          {metric.distribution ? (
            <p className="spark-minmax skew-line">{formatDistribution(metric.distribution)}</p>
          ) : null}

          {/* The rows above are per-camera means, which cancel run-to-run
              jitter. When the worst 5 % of single triggers land in a worse
              band, that is the whole point of running 250 of them. */}
          {worst ? (
            <p className="spark-minmax skew-line skew-line--worst">
              worst 5% of triggers {worst.lamp} {worst.label}
            </p>
          ) : null}
        </>
      )}

      <p className="spark-minmax skew-line" style={{ textTransform: 'none' }}>
        {metric.note}
      </p>
    </section>
  );
}

/** Whole-run display. Exported for the same reason as the card above. */
export function SkewReportView({ report }: { report: SkewReport }) {
  const short = report.triggers > 0 && report.triggers < report.requestedTriggers;
  return (
    <>
      <p className="val" style={{ paddingTop: 4 }}>
        {report.triggers} TRIGGERS · {report.cameras.length} CAMERAS
        {report.frameIntervalUs !== null
          ? ` · FRAME INTERVAL ${formatSpreadMs(report.frameIntervalUs)}`
          : ''}
      </p>
      {short ? (
        <p className="spark-minmax" style={{ display: 'block' }}>
          Asked for {report.requestedTriggers}. The device returned {report.triggers} and everything
          below counts those.
        </p>
      ) : null}

      <div className="skew-metrics">
        {report.metrics.map((metric, i) => (
          <SkewMetricCard key={metric.metric} metric={metric} order={i + 1} />
        ))}
      </div>

      <p className="spark-minmax" style={{ display: 'block', textTransform: 'none' }}>
        Camera rows are that camera's mean over the run, relative to the earliest. The distribution
        line is each trigger's own spread.
      </p>
      <p className="spark-minmax" style={{ display: 'block', textTransform: 'none' }}>
        {SKEW_BAND_ORDER.map((b) => `${SKEW_BANDS[b].range} ${SKEW_BANDS[b].label}`).join(' · ')}
      </p>
    </>
  );
}

/**
 * The EDGE INTEGRITY report shipped firmware produces. Per-camera edge
 * accounting and one verdict about the trigger wire — and, in words, that no
 * exposure skew was measured. Exported so it can be asserted without a device.
 */
export function EdgeIntegrityView({ report }: { report: EdgeIntegrityReport }) {
  const verdictState = report.verdict === 'clean' ? 'ok' : report.verdict === 'dirty' ? 'err' : 'warn';
  const short = report.pulses < report.requestedPulses;
  return (
    <>
      <p className="val" style={{ paddingTop: 4 }}>
        EDGE INTEGRITY · {report.pulses} PULSES · {report.gapMs} MS GAP · {report.cameras.length} CAMERAS
      </p>
      {short ? (
        <p className="spark-minmax" style={{ display: 'block' }}>
          Asked for {report.requestedPulses}. The camera fired {report.pulses}
          {report.refusedByCapture > 0 ? ' and stopped when a capture claimed the cameras' : ''}.
        </p>
      ) : null}

      <p className={`skew-band skew-band--${verdictState}`} data-verdict={report.verdict}>
        <span className="skew-lamp" aria-hidden="true">
          {verdictState === 'ok' ? '●' : verdictState === 'err' ? '×' : '▲'}
        </span>
        {EDGE_VERDICT_LABEL[report.verdict]}
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table className="table" data-report="edge-integrity">
          <thead>
            <tr>
              <th>CAM</th>
              <th className="num">ACCEPTED</th>
              <th className="num">RAW</th>
              <th className="num">REJECTED</th>
              <th className="num">EXPECTED</th>
              <th className="num">SHORT BY</th>
              <th>MONOTONIC</th>
              <th>CLEAN</th>
            </tr>
          </thead>
          <tbody>
            {report.cameras.map((cam) => (
              <tr key={cam.cam} data-cam={cam.cam}>
                <td>{cam.label}</td>
                {cam.watched ? (
                  <>
                    <td className="num">{cam.acceptedEdges ?? '—'}</td>
                    <td className="num">{cam.rawEdges ?? '—'}</td>
                    <td className="num">{cam.rejectedEdges ?? '—'}</td>
                    <td className="num">{cam.expected ?? '—'}</td>
                    <td className={`num${(cam.shortBy ?? 0) !== 0 ? ' warn' : ''}`}>
                      {cam.shortBy ?? '—'}
                      {cam.firstBadPulse !== null ? ` (first bad pulse ${cam.firstBadPulse})` : ''}
                    </td>
                    <td>{cam.edgeMonotonic === null ? 'NOT POLLED' : cam.edgeMonotonic ? 'YES' : 'NO'}</td>
                    <td className={cam.clean === false ? 'warn' : undefined}>
                      {cam.clean === null ? '—' : cam.clean ? 'CLEAN' : 'DIRTY'}
                    </td>
                  </>
                ) : (
                  <td colSpan={7} className="dim">
                    NOT WATCHED — the node reported no sync block at the start of the run
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="notice notice--warn" style={{ marginTop: 8, marginBottom: 0 }}>
        {report.notMeasured}
      </p>
      <p className="spark-minmax" style={{ display: 'block', textTransform: 'none' }}>
        ACCEPTED below EXPECTED means the node missed pulses; RAW above EXPECTED means the line rang and
        the dead time absorbed it. None of these figures is a millisecond.
      </p>
    </>
  );
}

/**
 * The metric a one-line verdict should quote: effective exposure decides the
 * photograph, VSYNC phase decides which frame, GPIO decides nothing on its
 * own. Whichever is quoted, the readout names it.
 */
function verdictMetric(report: SkewReport): (SkewMetricReport & { spreadUs: number }) | null {
  for (const metric of ['exposure', 'vsync', 'gpio'] as const) {
    const found = report.metrics.find((m) => m.metric === metric);
    if (found && found.band && found.spreadUs !== null) {
      return found as SkewMetricReport & { spreadUs: number };
    }
  }
  return null;
}

/**
 * Latest verdict, for a status surface that did not measure it. Always names
 * the metric and when it was measured — two panels printing contradictory
 * verdicts with no timestamps is the failure this store exists to prevent.
 */
export function SkewVerdict() {
  const entry = useBenchResult<SkewBenchResult>(OWNER);
  const stamp = benchStamp(entry);
  const result = entry?.result ?? null;

  const open = (
    <Button size="sm" onClick={() => openSection('calibration', 'skew')}>
      {result ? 'OPEN SKEW BENCH' : 'RUN SKEW BENCH'}
    </Button>
  );

  if (!result) {
    return (
      <div className="skew-verdict">
        <p className="dim">
          Sensor sync has not been measured on this camera. GPIO skew in the camera strip is trigger
          distribution, not exposure alignment.
        </p>
        {open}
      </div>
    );
  }

  if (isEdgeIntegrityReport(result)) {
    const state = result.verdict === 'clean' ? 'ok' : result.verdict === 'dirty' ? 'err' : 'warn';
    return (
      <div className="skew-verdict">
        <p className={`skew-band skew-band--${state}`}>
          <span className="skew-lamp" aria-hidden="true">
            {state === 'ok' ? '●' : state === 'err' ? '×' : '▲'}
          </span>
          {EDGE_VERDICT_LABEL[result.verdict]}
        </p>
        <p className="skew-none">EXPOSURE SKEW NOT MEASURED — this firmware counts trigger edges only.</p>
        <p className="spark-minmax" style={{ display: 'block' }}>
          {result.pulses} PULSES
          {stamp ? ` · ${stamp.text}` : ''}
        </p>
        {open}
      </div>
    );
  }

  const report = result;
  const metric = verdictMetric(report);
  const band = metric?.band ? SKEW_BANDS[metric.band] : null;

  return (
    <div className="skew-verdict">
      {band && metric ? (
        <>
          <p className={`skew-band skew-band--${band.state}`}>
            <span className="skew-lamp" aria-hidden="true">
              {band.lamp}
            </span>
            {band.label}
          </p>
          <p className="val">
            {metric.title} SPREAD {formatSpreadMs(metric.spreadUs)}
          </p>
        </>
      ) : (
        <p className="skew-none">
          NOT MEASURABLE —{' '}
          {report.metrics.find((m) => m.unavailableReason !== null)?.unavailableReason ??
            'the run reported no timing metric'}
        </p>
      )}
      <p className="spark-minmax" style={{ display: 'block' }}>
        {report.triggers} TRIGGERS
        {stamp ? ` · ${stamp.text}` : ''}
      </p>
      {open}
    </div>
  );
}

export function SkewBench() {
  const firmwareLabel = useDeviceStore((s) => s.firmwareLabel);
  const [pulses, setPulses] = useState(100);
  const blockedBy = useBlockedBy(OWNER);
  // Whatever is in flight, started by this mount of the panel or a previous
  // one. A remount lands in the running state, not a lying idle one.
  const run = useSkewRun();
  const view = skewRunView(run, blockedBy);

  const entry = useBenchResult<SkewBenchResult>(OWNER);
  const report = entry?.result ?? null;
  const stamp = benchStamp(entry);

  return (
    <Panel
      title="SKEW BENCH"
      actions={
        <>
          {view.showCancel ? (
            <Button size="sm" onClick={cancelSkewRun}>
              CANCEL
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            busy={view.running}
            disabled={!view.running && !view.canStart}
            title={blockedBy ? `${blockedBy} is running` : undefined}
            onClick={() => void startSkewRun(pulses)}
          >
            RUN {view.running ? run.requested : pulses} PULSES
          </Button>
        </>
      }
    >
      <p className="dim" style={{ marginBottom: 2 }}>
        Fires the trigger N times. Shipped firmware answers with per-camera edge counts — whether every
        pulse arrived exactly once — and measures no exposure timing; the reference device also reports
        where each sensor sat, as three metrics kept apart. The shared trigger edge is a reference, not
        proof of synchronized exposure.
      </p>

      <SegField
        label="RUN SIZE"
        value={String(view.running ? run.requested : pulses)}
        options={RUN_SIZES}
        disabled={view.running}
        onChange={(v) => setPulses(Number(v))}
        hint={`One call is 1–${SYNC_BENCH_MAX_PULSES} pulses at ${SYNC_BENCH_GAP_MS} ms; the camera blocks for the whole run and answers once.`}
      />

      <p className="val" role="status" style={{ padding: '6px 0', minHeight: 18 }}>
        {view.status}
      </p>

      {run.stopping ? (
        <p className="spark-minmax" style={{ display: 'block', textTransform: 'none' }}>
          The protocol has no cancel command. The camera finishes the pulses it started; Studio
          stops listening and records nothing.
        </p>
      ) : null}

      {run.unsupported ? (
        <Unsupported
          feature="Skew Bench"
          firmware={firmwareLabel}
          note="This build does not answer SYNC_BENCH, so sensor timing cannot be measured from Studio."
        />
      ) : null}

      {report ? (
        isEdgeIntegrityReport(report) ? (
          <EdgeIntegrityView report={report} />
        ) : (
          <SkewReportView report={report} />
        )
      ) : null}

      {report && stamp ? (
        <p
          className={stamp.stale ? 'notice notice--warn' : 'spark-minmax'}
          style={{ display: 'block', marginTop: 6, marginBottom: 0 }}
        >
          {stamp.text}
        </p>
      ) : null}

      {run.error ? (
        <p className="notice notice--err" style={{ marginTop: 8 }}>
          {run.error}
        </p>
      ) : null}
    </Panel>
  );
}
