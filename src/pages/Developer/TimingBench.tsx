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

interface Stats {
  runs: number;
  perCam: { cam: CamId; gpio: number; vsync: number; exposure: number }[];
  gpioSpread: number;
  vsyncSpread: number;
  exposureSpread: number;
  exposureWorst: number;
  vsyncMeasured: boolean;
  frameIntervalUs: number;
  samples: { gpio: number; vsync: number; exposure: number }[];
}

const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

export function TimingBench() {
  const state = useDeviceStore();
  const [runs, setRuns] = useState(10);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blockedBy = useBlockedBy(OWNER);

  const hasVsync = supports(state, 'vsyncTelemetry');

  const run = async () => {
    const dev = getDevice();
    if (!dev || running) return;
    if (!claimDevice(OWNER, LABEL)) return;
    setRunning(true);
    setError(null);
    setStats(null);
    const perCam: Record<CamId, CamTiming[]> = { cam1: [], cam2: [], cam3: [], cam4: [] };
    const samples: Stats['samples'] = [];
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
      setStats({
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
        exposureWorst: Math.max(...samples.map((s) => s.exposure)),
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

  const grade = stats ? gradeSkew(stats.exposureSpread) : null;

  // One unit per column, taken from that column's own values. Switching
  // unit per cell made 139 µs scan as larger than 7.48 ms.
  const gpioCol = usColumn(stats ? stats.perCam.map((r) => r.gpio) : []);
  const vsyncCol = usColumn(stats ? stats.perCam.map((r) => r.vsync) : []);
  const expCol = usColumn(stats ? stats.perCam.map((r) => r.exposure) : []);
  // Cards each hold a single value, so the unit goes in the card label and
  // every number printed on that card uses it.
  const gpioCard = usColumn(stats ? [stats.gpioSpread] : []);
  const vsyncCard = usColumn(stats ? [stats.vsyncSpread, stats.frameIntervalUs] : []);
  const expCard = usColumn(stats ? [stats.exposureSpread, stats.exposureWorst] : []);

  return (
    <Panel
      title="TIMING BENCH"
      actions={
        <>
          {stats ? (
            <Button
              size="sm"
              onClick={() =>
                downloadJson(`kino-timing-${state.info?.serial ?? 'unknown'}-${Date.now()}.json`, {
                  device: state.info?.serial,
                  firmware: state.firmwareLabel,
                  ranAt: new Date().toISOString(),
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
      <p className="dim" style={{ marginBottom: 6 }}>
        The shared trigger is a common timing reference, not proof of synchronized exposure. Four
        free-running OV3660s can share a trigger edge to 100 µs and still record images a whole
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

      {!hasVsync ? (
        <Unsupported
          feature="VSYNC telemetry"
          firmware={state.firmwareLabel}
          note="Only GPIO distribution skew can be measured. That number says nothing about exposure alignment."
        />
      ) : null}

      {stats ? (
        <>
          <div className="timing-metrics">
            <div className="timing-metric">
              <span className="microlabel">
                1 · GPIO DISTRIBUTION (<Unit>{gpioCard.unit}</Unit>)
              </span>
              <span className="timing-value">{gpioCard.format(stats.gpioSpread)}</span>
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
                frame interval {vsyncCard.format(stats.frameIntervalUs)} {vsyncCard.unit}
              </span>
            </div>
            <div className={`timing-metric timing-metric--primary timing-metric--${grade?.state}`}>
              <span className="microlabel">
                3 · EFFECTIVE EXPOSURE (<Unit>{expCard.unit}</Unit>)
              </span>
              <span className="timing-value">
                {stats.vsyncMeasured ? expCard.format(stats.exposureSpread) : '—'}
              </span>
              <span className="spark-minmax">
                worst {expCard.format(stats.exposureWorst)} {expCard.unit}
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

          <div className="tablewrap" style={{ marginTop: 8 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>CAMERA</th>
                  <th className="num">
                    GPIO (<Unit>{gpioCol.unit}</Unit>)
                  </th>
                  <th className="num">
                    VSYNC PHASE (<Unit>{vsyncCol.unit}</Unit>)
                  </th>
                  <th className="num">
                    EXPOSURE Δ (<Unit>{expCol.unit}</Unit>)
                  </th>
                </tr>
              </thead>
              <tbody>
                {stats.perCam.map((row) => (
                  <tr key={row.cam}>
                    <td>
                      CAM {row.cam.slice(-1)}
                      {row.cam === 'cam2' ? ' (ref)' : ''}
                    </td>
                    <td className="num">{gpioCol.format(row.gpio)}</td>
                    <td className="num">{stats.vsyncMeasured ? vsyncCol.format(row.vsync) : '—'}</td>
                    <td className="num">{stats.vsyncMeasured ? expCol.format(row.exposure) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Two different references sit in this table. Stating which is
              which stops SENSOR PHASE and TIMING BENCH from looking like
              they contradict each other over CAM2. */}
          <p className="spark-minmax" style={{ display: 'block', paddingTop: 4 }}>
            GPIO and VSYNC PHASE are absolute per-sensor waits from the trigger edge — CAM2 is not
            zero here. EXPOSURE Δ is measured against CAM2. SENSOR PHASE reports frame phase
            against CAM2, so CAM2 is 0 there by definition.
          </p>
          <p className="microlabel" style={{ paddingTop: 4 }}>
            AVERAGE OF {stats.runs} CAPTURES · TARGET ≤ 1–2 <Unit>ms</Unit> EFFECTIVE SPREAD
          </p>
        </>
      ) : null}
      {error ? <p className="notice notice--err" style={{ marginTop: 8 }}>{error}</p> : null}
    </Panel>
  );
}
