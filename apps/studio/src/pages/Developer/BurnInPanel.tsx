// Burn-in: repeated synchronized test shots while logging battery voltage,
// trigger skew and UART transfer rate. Build-sequence step 19 as a tool.

import { useRef, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { SegField } from '../../components/fields';
import { Sparkline } from '../../components/Sparkline';
import { getDevice } from '../../app/session';
import { useDeviceStore } from '../../state/deviceStore';
import { claimDevice, releaseDevice, useBlockedBy } from '../../state/deviceBusy';
import {
  benchStamp,
  clearBenchResult,
  putBenchResult,
  useBenchResult,
} from '../../state/benchResults';
import { usColumn } from '@kino/kdp';
import { downloadJson } from '../../utils/download';

const OWNER = 'burnin';
const LABEL = 'BURN-IN';

/** Bytes per media read, and how many reads make one rate sample. */
const PROBE_CHUNK = 8192;
const PROBE_READS = 3;

// The real 1S Li-ion working range. Fixing the battery axis to it is the
// only way the chart agrees with the SAG readout printed under it.
const CELL_MIN_V = 3.3;
const CELL_MAX_V = 4.2;

interface Sample {
  shot: number;
  t: number;
  batteryV: number;
  skewSpreadUs: number;
  transferKBs: number;
}

export function BurnInPanel() {
  const info = useDeviceStore((s) => s.info);
  const [shots, setShots] = useState(10);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  // The probe search takes over a second on a full card and the panel used to
  // sit on "RUNNING 0/10 SHOTS" through it, which is a count that had not
  // started yet.
  const [stage, setStage] = useState<string>('');
  const [probeMissing, setProbeMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);
  const blockedBy = useBlockedBy(OWNER);

  // A 50-shot run is minutes of bench time. It survives navigation now, and
  // so does the EXPORT LOG button that saves it.
  const entry = useBenchResult<Sample[]>(OWNER);
  const samples = entry?.result ?? [];
  const stamp = benchStamp(entry);

  const run = async () => {
    const dev = getDevice();
    if (!dev || running) return;
    if (!claimDevice(OWNER, LABEL)) return;
    setRunning(true);
    setError(null);
    clearBenchResult(OWNER);
    stopRef.current = false;

    // Pick a transfer-rate probe file once.
    let probeId: string | null = null;
    let probeFile: string | null = null;
    setProbeMissing(false);
    setStage('READING CARD FOR A TRANSFER PROBE FILE…');
    try {
      const list = await dev.mediaList({ limit: 1 });
      if (list.items.length > 0) {
        probeId = list.items[0].id;
        const capInfo = await dev.mediaInfo(probeId);
        probeFile = capInfo.files[0].name;
      }
    } catch {
      // No card / empty card — rate stays 0.
    }
    setStage('');
    setProbeMissing(probeId === null);

    const collected: Sample[] = [];
    try {
      for (let i = 1; i <= shots; i++) {
        if (stopRef.current) break;
        setProgress(i);

        const power = await dev.getPowerStatus();
        const timing = await dev.timingTest();
        // Exposure spread is the metric that matters photographically.
        const spread = timing.exposureSpreadUs;

        let rate = 0;
        if (probeId && probeFile) {
          const t0 = performance.now();
          let got = 0;
          for (let c = 0; c < PROBE_READS; c++) {
            const chunk = await dev.mediaRead(probeId, probeFile, c * PROBE_CHUNK, PROBE_CHUNK);
            got += chunk.length;
          }
          rate = Math.round(got / 1024 / ((performance.now() - t0) / 1000));
        }

        collected.push({
          shot: i,
          t: Date.now(),
          batteryV: power.batteryV,
          skewSpreadUs: spread,
          transferKBs: rate,
        });
        putBenchResult<Sample[]>(OWNER, [...collected]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      releaseDevice(OWNER);
      setRunning(false);
      setProgress(0);
      setStage('');
    }
  };

  const sag =
    samples.length >= 2 ? (samples[0].batteryV - samples[samples.length - 1].batteryV).toFixed(3) : null;

  // One unit for the whole widget, from its own largest value — the same
  // contract the timing columns use.
  const spreadCol = usColumn(samples.map((s) => s.skewSpreadUs));

  return (
    <Panel
      title="BURN-IN"
      actions={
        <>
          {samples.length > 0 && !running && entry ? (
            <Button
              size="sm"
              onClick={() =>
                downloadJson(`kino-burnin-${info?.serial ?? 'unknown'}-${Date.now()}.json`, {
                  device: info?.serial,
                  p4Firmware: info?.p4Firmware,
                  ranAt: new Date(entry.ranAt).toISOString(),
                  staleReason: entry.staleReason,
                  transferProbe: `${PROBE_READS} × ${PROBE_CHUNK / 1024} KB media reads`,
                  samples,
                })
              }
            >
              EXPORT LOG
            </Button>
          ) : null}
          {running ? (
            <Button size="sm" variant="danger" onClick={() => (stopRef.current = true)}>
              STOP
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={blockedBy !== null}
              title={blockedBy ? `${blockedBy} is running` : undefined}
              onClick={() => void run()}
            >
              START {shots} SHOTS
            </Button>
          )}
        </>
      }
    >
      <p className="dim" style={{ marginBottom: 2 }}>
        Repeated synchronized test shots. Logs battery voltage, effective exposure spread and UART
        transfer rate per shot.
      </p>
      <p className="dim" style={{ marginBottom: 6 }}>
        Watch for voltage sag trend and timing outliers.
      </p>
      <SegField
        label="SHOTS"
        value={String(shots)}
        options={[
          { value: '10', label: '10' },
          { value: '25', label: '25' },
          { value: '50', label: '50' },
        ]}
        onChange={(v) => setShots(Number(v))}
      />
      {/* Progress is a status line, not a disabled button's label. */}
      <p className="val" role="status" style={{ padding: '6px 0', minHeight: 18 }}>
        {running
          ? stage || `RUNNING ${progress}/${shots} SHOTS`
          : blockedBy
            ? `${blockedBy} is running.`
            : ''}
      </p>
      {probeMissing ? (
        <p className="notice notice--warn" style={{ marginTop: 0 }}>
          No file on the card to read, so TRANSFER RATE stays 0 for this run.
        </p>
      ) : null}
      {samples.length > 0 ? (
        <>
          <div className="panel-grid" style={{ marginTop: 8 }}>
            <Sparkline
              label="BATTERY"
              unit="V"
              values={samples.map((s) => s.batteryV)}
              format={(v) => v.toFixed(2)}
              color="#48a83e"
              yMin={CELL_MIN_V}
              yMax={CELL_MAX_V}
            />
            <Sparkline
              label="EXPOSURE SPREAD"
              unit={spreadCol.unit}
              values={samples.map((s) => s.skewSpreadUs)}
              format={spreadCol.format}
              color="#f28a2e"
            />
            <Sparkline
              label="TRANSFER RATE"
              unit="KB/s"
              values={samples.map((s) => s.transferKBs)}
              format={(v) => String(Math.round(v))}
            />
          </div>
          {sag ? (
            <p className="val" style={{ marginTop: 8 }}>
              SAG OVER RUN {sag} V · {samples.length} SHOTS
            </p>
          ) : null}
          <p className="spark-minmax" style={{ display: 'block', paddingTop: 4 }}>
            TRANSFER RATE is {PROBE_READS} × {PROBE_CHUNK / 1024} KB media reads, one round-trip
            each. UART LINK streams 256 KB per channel and reads higher at the same baud.
          </p>
          {stamp ? (
            <p
              className={stamp.stale ? 'notice notice--warn' : 'spark-minmax'}
              style={{ display: 'block', marginTop: 6, marginBottom: 0 }}
            >
              {stamp.text}
            </p>
          ) : null}
        </>
      ) : null}
      {error ? <p className="notice notice--err" style={{ marginTop: 8 }}>{error}</p> : null}
    </Panel>
  );
}
