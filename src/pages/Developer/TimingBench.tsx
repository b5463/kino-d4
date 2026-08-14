// Timing bench. Reports the three metrics separately because only the
// last two decide whether the wigglegram works:
//   GPIO distribution — shared trigger arrival (nearly meaningless alone)
//   VSYNC phase       — where each free-running sensor is in its frame
//   Effective exposure— when the scene was actually recorded

import { useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Led } from '../../components/Led';
import { SegField } from '../../components/fields';
import { Unsupported } from '../../components/Unsupported';
import { getDevice } from '../../app/session';
import { useDeviceStore, supports } from '../../state/deviceStore';
import { claimDevice, releaseDevice, useBlockedBy } from '../../state/deviceBusy';
import {
  benchStamp,
  clearBenchResult,
  putBenchResult,
  useBenchResult,
} from '../../state/benchResults';
import { gradeSkew, usColumn } from '../../protocol/timing';
import type { CamTiming } from '../../protocol/timing';
import { CAM_IDS } from '../../protocol/types';
import type { CamId } from '../../protocol/types';
import { downloadJson } from '../../utils/download';

const OWNER = 'timing';
const LABEL = 'TIMING BENCH';

/** A unit that must keep its real case inside an uppercased caption. */
function Unit({ children }: { children: string }) {
  return <span style={{ textTransform: 'none' }}>{children}</span>;
}

export interface TimingStats {
  runs: number;
  perCam: { cam: CamId; gpio: number; vsync: number; exposure: number }[];
  /** Mean, over the runs, of each run's own max−min. */
  gpioSpread: number;
  vsyncSpread: number;
  exposureSpread: number;
  /** Lowest and highest single-run spread, so the mean can be judged. */
  gpioRange: [number, number];
  vsyncRange: [number, number];
  exposureRange: [number, number];
  vsyncMeasured: boolean;
  frameIntervalUs: number;
  samples: { gpio: number; vsync: number; exposure: number }[];
}

const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const range = (v: number[]): [number, number] => [
  Math.round(Math.min(...v)),
  Math.round(Math.max(...v)),
];
/** max−min of a set of per-camera means. Not the same as the mean of spreads. */
const spread = (v: number[]) => Math.round(Math.max(...v) - Math.min(...v));

export function TimingBench() {
  const state = useDeviceStore();
  const [runs, setRuns] = useState(10);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const blockedBy = useBlockedBy(OWNER);

  // Results outlive the page. A sidebar click used to discard a 50-capture
  // run together with the EXPORT button that would have saved it.
  const entry = useBenchResult<TimingStats>(OWNER);
  const stats = entry?.result ?? null;
  const stamp = benchStamp(entry);

  const hasVsync = supports(state, 'vsyncTelemetry');

  const run = async () => {
    const dev = getDevice();
    if (!dev || running) return;
    if (!claimDevice(OWNER, LABEL)) return;
    setRunning(true);
    setError(null);
    clearBenchResult(OWNER);
    const perCam: Record<CamId, CamTiming[]> = { cam1: [], cam2: [], cam3: [], cam4: [] };
    const samples: TimingStats['samples'] = [];
    let vsyncMeasured = true;
    let frameIntervalUs = 33_333;
    try {
      for (let i = 0; i < runs; i++) {
        setProgress(i + 1);
        const r = await dev.timingTest();
        vsyncMeasured = r.vsyncMeasured;
        frameIntervalUs = r.frameIntervalUs ?? frameIntervalUs;
        for (const c of r.cams) perCam[c.cam].push(c);
        samples.push({ gpio: r.gpioSpreadUs, vsync: r.vsyncSpreadUs, exposure: r.exposureSpreadUs });
      }
      putBenchResult<TimingStats>(OWNER, {
        runs,
        perCam: CAM_IDS.map((cam) => ({
          cam,
          gpio: Math.round(avg(perCam[cam].map((c) => c.gpioUs))),
          vsync: Math.round(avg(perCam[cam].map((c) => c.vsyncPhaseUs))),
          exposure: Math.round(avg(perCam[cam].map((c) => c.exposureUs))),
        })),
        gpioSpread: Math.round(avg(samples.map((s) => s.gpio))),
        vsyncSpread: Math.round(avg(samples.map((s) => s.vsync))),
        exposureSpread: Math.round(avg(samples.map((s) => s.exposure))),
        gpioRange: range(samples.map((s) => s.gpio)),
        vsyncRange: range(samples.map((s) => s.vsync)),
        exposureRange: range(samples.map((s) => s.exposure)),
        vsyncMeasured,
        frameIntervalUs,
        samples,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      releaseDevice(OWNER);
      setRunning(false);
      setProgress(0);
    }
  };

  // Only grade what was actually measured. Computing the grade regardless of
  // `vsyncMeasured` tinted the card green while its value read `—`, leaving
  // colour as the only verdict on the one metric that matters — and saying
  // pass.
  const grade = stats && stats.vsyncMeasured ? gradeSkew(stats.exposureSpread) : null;

  // One unit per column, taken from that column's own values. Switching
  // unit per cell made 139 µs scan as larger than 7.48 ms.
  const gpioCol = usColumn(stats ? stats.perCam.map((r) => r.gpio) : []);
  const vsyncCol = usColumn(stats ? stats.perCam.map((r) => r.vsync) : []);
  const expCol = usColumn(stats ? stats.perCam.map((r) => r.exposure) : []);
  // Cards each hold a single value, so the unit goes in the card label and
  // every number printed on that card uses it.
  const gpioCard = usColumn(stats ? [stats.gpioSpread, stats.gpioRange[1]] : []);
  const vsyncCard = usColumn(stats ? [stats.vsyncSpread, stats.vsyncRange[1], stats.frameIntervalUs] : []);
  const expCard = usColumn(stats ? [stats.exposureSpread, stats.exposureRange[1]] : []);

  // The cards and the table are two different aggregations of the same
  // captures, and subtracting the table used to give a different answer from
  // the card with nothing on screen to explain the gap. Print both.
  const meanSpreads = stats
    ? {
        gpio: spread(stats.perCam.map((r) => r.gpio)),
        vsync: spread(stats.perCam.map((r) => r.vsync)),
        exposure: spread(stats.perCam.map((r) => r.exposure)),
      }
    : null;

  const rangeText = (card: ReturnType<typeof usColumn>, [lo, hi]: [number, number]) =>
    `${card.format(lo)}–${card.format(hi)}`;

  return (
    <Panel
      title="TIMING BENCH"
      actions={
        <>
          {stats && entry ? (
            <Button
              size="sm"
              onClick={() =>
                downloadJson(`kino-timing-${state.info?.serial ?? 'unknown'}-${Date.now()}.json`, {
                  device: state.info?.serial,
                  firmware: state.firmwareLabel,
                  ranAt: new Date(entry.ranAt).toISOString(),
                  staleReason: entry.staleReason,
                  ...stats,
                })
              }
            >
              EXPORT
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            busy={running}
            disabled={!running && blockedBy !== null}
            title={blockedBy ? `${blockedBy} is running` : undefined}
            onClick={() => void run()}
          >
            RUN {runs} CAPTURES
          </Button>
        </>
      }
    >
      <p className="dim" style={{ marginBottom: 2 }}>
        The shared trigger is a timing reference, not proof of synchronized exposure.
      </p>
      <p className="dim" style={{ marginBottom: 6 }}>
        Four free-running OV3660s can share a trigger edge to 100 µs and still record images a whole
        frame interval apart.
      </p>
      <SegField
        label="CAPTURES"
        value={String(runs)}
        options={[
          { value: '10', label: '10' },
          { value: '25', label: '25' },
          { value: '50', label: '50' },
        ]}
        onChange={(v) => setRuns(Number(v))}
      />

      {/* Progress lives here, not in the button label. */}
      <p className="val" role="status" style={{ padding: '6px 0', minHeight: 18 }}>
        {running
          ? `RUNNING ${progress}/${runs} CAPTURES`
          : blockedBy
            ? `${blockedBy} is running.`
            : ''}
      </p>

      {/* Driven by the measurement, not the capability list: firmware can
          advertise VSYNC telemetry and still fail to report it, and the run is
          what decides whether metrics 2 and 3 exist. */}
      {!hasVsync || (stats && !stats.vsyncMeasured) ? (
        <Unsupported
          feature="VSYNC telemetry"
          firmware={state.firmwareLabel}
          note="Only GPIO distribution skew can be measured. That number says nothing about exposure alignment, so VSYNC PHASE and EFFECTIVE EXPOSURE stay blank and ungraded."
        />
      ) : null}

      {stats && meanSpreads ? (
        <>
          <div className="timing-metrics">
            <div className="timing-metric">
              <span className="microlabel">
                1 · GPIO DISTRIBUTION (<Unit>{gpioCard.unit}</Unit>)
              </span>
              <span className="timing-value">{gpioCard.format(stats.gpioSpread)}</span>
              {/* The aggregation is named on the card, because the table
                  below aggregates the same captures the other way round. */}
              <span className="spark-minmax">
                SPREAD, MEAN OF {stats.runs} RUNS · RANGE {rangeText(gpioCard, stats.gpioRange)}
              </span>
              <span className="spark-minmax">trigger edge arrival — not photographic</span>
            </div>
            <div className="timing-metric">
              <span className="microlabel">
                2 · VSYNC PHASE (<Unit>{vsyncCard.unit}</Unit>)
              </span>
              <span className="timing-value">
                {stats.vsyncMeasured ? vsyncCard.format(stats.vsyncSpread) : '—'}
              </span>
              <span className="spark-minmax">
                {stats.vsyncMeasured
                  ? `SPREAD, MEAN OF ${stats.runs} RUNS · RANGE ${rangeText(vsyncCard, stats.vsyncRange)}`
                  : 'not measurable without VSYNC telemetry'}
              </span>
              <span className="spark-minmax">
                frame interval {vsyncCard.format(stats.frameIntervalUs)} {vsyncCard.unit}
              </span>
            </div>
            <div
              className={`timing-metric timing-metric--primary${grade ? ` timing-metric--${grade.state}` : ''}`}
            >
              <span className="microlabel">
                3 · EFFECTIVE EXPOSURE (<Unit>{expCard.unit}</Unit>)
              </span>
              <span className="timing-value">
                {stats.vsyncMeasured ? expCard.format(stats.exposureSpread) : '—'}
              </span>
              <span className="spark-minmax">
                {stats.vsyncMeasured
                  ? `SPREAD, MEAN OF ${stats.runs} RUNS · RANGE ${rangeText(expCard, stats.exposureRange)}`
                  : 'not measurable without VSYNC telemetry'}
              </span>
            </div>
          </div>

          {stats.vsyncMeasured && grade ? (
            <p className={`timing-grade timing-grade--${grade.state}`}>
              <Led state={grade.state} label="" />
              {grade.label}
              <span className="dim"> · {grade.note}</span>
            </p>
          ) : null}

          <p className="microlabel" style={{ paddingTop: 4 }}>
            PER-CAMERA MEAN OF {stats.runs} CAPTURES
          </p>
          <div className="tablewrap" style={{ marginTop: 4 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>CAMERA</th>
                  <th className="num">
                    GPIO vs EARLIEST (<Unit>{gpioCol.unit}</Unit>)
                  </th>
                  <th className="num">
                    VSYNC PHASE (<Unit>{vsyncCol.unit}</Unit>)
                  </th>
                  <th className="num">
                    EFFECTIVE EXPOSURE (<Unit>{expCol.unit}</Unit>)
                  </th>
                </tr>
              </thead>
              <tbody>
                {stats.perCam.map((row) => (
                  <tr key={row.cam}>
                    <td>
                      CAM {row.cam.slice(-1)}
                      {row.cam === 'cam2' ? ' (exposure ref)' : ''}
                    </td>
                    <td className="num">{gpioCol.format(row.gpio)}</td>
                    <td className="num">{stats.vsyncMeasured ? vsyncCol.format(row.vsync) : '—'}</td>
                    <td className="num">{stats.vsyncMeasured ? expCol.format(row.exposure) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Subtracting this table gave a different number from the cards
              above, with nothing on screen to reconcile them. Both numbers
              are printed so the arithmetic can be checked here. */}
          <p className="spark-minmax" style={{ display: 'block', paddingTop: 4 }}>
            SPREAD OF THESE MEANS: GPIO {gpioCol.format(meanSpreads.gpio)} {gpioCol.unit}
            {stats.vsyncMeasured
              ? ` · VSYNC ${vsyncCol.format(meanSpreads.vsync)} ${vsyncCol.unit} · EXPOSURE ${expCol.format(meanSpreads.exposure)} ${expCol.unit}`
              : ''}
          </p>
          <p className="spark-minmax" style={{ display: 'block' }}>
            Never higher than the cards above, which average each run's own spread. Averaging per
            camera first cancels run-to-run jitter.
          </p>

          {/* The two panels do not use different reference conventions — they
              report the same wait, and saying otherwise invented a difference
              to explain a 100 µs jitter gap. */}
          <p className="spark-minmax" style={{ display: 'block', paddingTop: 4 }}>
            GPIO is trigger-edge arrival relative to the earliest camera, so the earliest reads 0.
          </p>
          <p className="spark-minmax" style={{ display: 'block' }}>
            VSYNC PHASE is each sensor's trigger-to-VSYNC wait. SENSOR PHASE measures the same wait
            against CAM2, so the two panels print the same numbers within run-to-run jitter.
          </p>
          <p className="spark-minmax" style={{ display: 'block' }}>
            EFFECTIVE EXPOSURE is that wait against CAM2 plus each camera's own rolling-shutter row
            offset — which is why CAM2 is not zero here.
          </p>
          {stamp ? (
            <p
              className={stamp.stale ? 'notice notice--warn' : 'spark-minmax'}
              style={{ display: 'block', marginTop: 6, marginBottom: 0 }}
            >
              {stamp.text}
            </p>
          ) : null}
          <p className="microlabel" style={{ paddingTop: 4 }}>
            TARGET ≤ 1–2 <Unit>ms</Unit> EFFECTIVE SPREAD
          </p>
        </>
      ) : null}
      {error ? <p className="notice notice--err" style={{ marginTop: 8 }}>{error}</p> : null}
    </Panel>
  );
}
