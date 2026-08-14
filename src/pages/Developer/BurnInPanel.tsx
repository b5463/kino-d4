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
import { downloadJson } from '../../utils/download';

const OWNER = 'burnin';
const LABEL = 'BURN-IN';

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
  const [samples, setSamples] = useState<Sample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);
  const blockedBy = useBlockedBy(OWNER);

  const run = async () => {
    const dev = getDevice();
    if (!dev || running) return;
    if (!claimDevice(OWNER, LABEL)) return;
    setRunning(true);
    setError(null);
    setSamples([]);
    stopRef.current = false;

    // Pick a transfer-rate probe file once.
    let probeId: string | null = null;
    let probeFile: string | null = null;
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
          for (let c = 0; c < 3; c++) {
            const chunk = await dev.mediaRead(probeId, probeFile, c * 8192, 8192);
            got += chunk.length;
          }
          rate = Math.round(got / 1024 / ((performance.now() - t0) / 1000));
        }

        setSamples((prev) => [
          ...prev,
          { shot: i, t: Date.now(), batteryV: power.batteryV, skewSpreadUs: spread, transferKBs: rate },
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      releaseDevice(OWNER);
      setRunning(false);
      setProgress(0);
    }
  };

  const sag =
    samples.length >= 2 ? (samples[0].batteryV - samples[samples.length - 1].batteryV).toFixed(3) : null;

  return (
    <Panel
      title="BURN-IN"
      actions={
        <>
          {samples.length > 0 && !running ? (
            <Button
              size="sm"
              onClick={() =>
                downloadJson(`kino-burnin-${info?.serial ?? 'unknown'}-${Date.now()}.json`, {
                  device: info?.serial,
                  p4Firmware: info?.p4Firmware,
                  ranAt: new Date().toISOString(),
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
      <p className="dim" style={{ marginBottom: 6 }}>
        Repeated synchronized test shots. Logs battery voltage, effective exposure spread and UART
        transfer rate per shot. Watch for voltage sag trend and timing outliers.
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
          ? `RUNNING ${progress}/${shots} SHOTS`
          : blockedBy
            ? `${blockedBy} is running.`
            : ''}
      </p>
      {samples.length > 0 ? (
        <>
          <div className="panel-grid" style={{ marginTop: 8 }}>
            <Sparkline
              label="BATTERY"
              values={samples.map((s) => s.batteryV)}
              format={(v) => `${v.toFixed(2)} V`}
              color="#48a83e"
              yMin={CELL_MIN_V}
              yMax={CELL_MAX_V}
            />
            <Sparkline
              label="EXPOSURE SPREAD"
              values={samples.map((s) => s.skewSpreadUs)}
              format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} ms` : `${Math.round(v)} µs`)}
              color="#f28a2e"
            />
            <Sparkline
              label="TRANSFER RATE"
              values={samples.map((s) => s.transferKBs)}
              format={(v) => `${Math.round(v)} KB/s`}
            />
          </div>
          {sag ? (
            <p className="val" style={{ marginTop: 8 }}>
              SAG OVER RUN {sag} V · {samples.length} SHOTS
            </p>
          ) : null}
        </>
      ) : null}
      {error ? <p className="notice notice--err" style={{ marginTop: 8 }}>{error}</p> : null}
    </Panel>
  );
}
