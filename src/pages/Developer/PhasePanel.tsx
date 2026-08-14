// Sensor phase alignment. Measures where each OV3660 sits in its own frame
// cycle, then restarts sensors with compensating delays and measures again.
// This is the experiment that decides whether KINO is a synchronized camera.

import { useEffect, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Led } from '../../components/Led';
import { Unsupported } from '../../components/Unsupported';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { getDevice, onPhaseEvent } from '../../app/session';
import { useDeviceStore, supports } from '../../state/deviceStore';
import { claimDevice, releaseDevice, useBlockedBy } from '../../state/deviceBusy';
import { formatUs, gradeSkew, usColumn } from '../../protocol/timing';
import { formatSigned } from '../../utils/format';
import type { PhaseResult } from '../../protocol/types';

const OWNER = 'phase';
const LABEL = 'SENSOR PHASE';

export function PhasePanel() {
  const state = useDeviceStore();
  const [result, setResult] = useState<PhaseResult | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [busy, setBusy] = useState<'measure' | 'rephase' | 'reset' | null>(null);
  const [step, setStep] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'rephase' | 'reset' | null>(null);
  const blockedBy = useBlockedBy(OWNER);

  const hasPhase = supports(state, 'phaseCalibration');

  useEffect(() => {
    return onPhaseEvent((e) => {
      if (e.step === 'rephase') {
        setStep(`Restarting ${e.cam.toUpperCase()} with phase offset…`);
        return;
      }
      const snapshot = e as PhaseResult;
      setResult(snapshot);
      setHistory((h) => [...h, snapshot.spreadUs]);
      setStep('');
      setBusy(null);
      // Re-phase finishes on this event, not when the command returns.
      releaseDevice(OWNER);
    });
  }, []);

  const call = async (action: 'measure' | 'rephase' | 'reset') => {
    const dev = getDevice();
    if (!dev || busy) return;
    if (!claimDevice(OWNER, LABEL)) return;
    setBusy(action);
    setError(null);
    try {
      if (action === 'measure') {
        const r = await dev.measurePhase();
        setResult(r);
        setHistory((h) => [...h, r.spreadUs]);
        setBusy(null);
        releaseDevice(OWNER);
      } else if (action === 'reset') {
        const r = await dev.resetPhase();
        setResult(r);
        setHistory([r.spreadUs]);
        setBusy(null);
        releaseDevice(OWNER);
      } else {
        setStep('Starting re-phase…');
        await dev.rephaseSensors(); // result arrives as a PHASE event
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
      setStep('');
      releaseDevice(OWNER);
    }
  };

  if (!hasPhase) {
    return (
      <Panel title="SENSOR PHASE">
        <Unsupported
          feature="Sensor phase calibration"
          firmware={state.firmwareLabel}
          note="Sensors free-run; effective exposure spread will be up to one frame interval."
        />
      </Panel>
    );
  }

  const grade = result ? gradeSkew(result.spreadUs) : null;
  // One unit for the whole phase column, from that column's own values.
  const phaseCol = usColumn(result ? result.cams.map((c) => c.phaseUs) : []);
  const blocked = blockedBy !== null;

  return (
    <Panel
      title="SENSOR PHASE"
      actions={
        <>
          <Button
            size="sm"
            busy={busy === 'measure'}
            disabled={(busy !== null && busy !== 'measure') || blocked}
            title={blockedBy ? `${blockedBy} is running` : undefined}
            onClick={() => void call('measure')}
          >
            MEASURE
          </Button>
          <Button
            size="sm"
            variant="primary"
            busy={busy === 'rephase'}
            disabled={(busy !== null && busy !== 'rephase') || blocked}
            title={blockedBy ? `${blockedBy} is running` : undefined}
            onClick={() => setConfirm('rephase')}
          >
            RE-PHASE SENSORS
          </Button>
          <Button
            size="sm"
            variant="danger"
            busy={busy === 'reset'}
            disabled={(busy !== null && busy !== 'reset') || blocked}
            title={blockedBy ? `${blockedBy} is running` : undefined}
            onClick={() => setConfirm('reset')}
          >
            RESET
          </Button>
        </>
      }
    >
      <p className="dim" style={{ marginBottom: 6 }}>
        Each sensor free-runs on its own clock. Re-phasing restarts them with compensating delays so
        their frame timelines line up; repeat until the spread stops improving.
      </p>
      {/* Progress is a status line, not a button label. */}
      <p className="val" role="status" style={{ padding: '2px 0 6px', minHeight: 18 }}>
        {step ? step : blockedBy ? `${blockedBy} is running.` : ''}
      </p>

      {result ? (
        <>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>CAMERA</th>
                  <th className="num">
                    FRAME PHASE vs {result.reference.toUpperCase()} (
                    <span style={{ textTransform: 'none' }}>{phaseCol.unit}</span>)
                  </th>
                  <th className="num">% OF FRAME</th>
                </tr>
              </thead>
              <tbody>
                {result.cams.map((c) => (
                  <tr key={c.cam}>
                    <td>
                      CAM {c.cam.slice(-1)}
                      {c.cam === result.reference ? ' (ref)' : ''}
                    </td>
                    <td className="num">{phaseCol.format(c.phaseUs)}</td>
                    {/* Sign kept: the neighbouring column keeps it, and a
                        sensor ahead of the reference is not the same fault
                        as one behind it. */}
                    <td className="num">
                      {formatSigned((c.phaseUs / result.frameIntervalUs) * 100, 1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* CAM2 reads 0 here and non-zero in TIMING BENCH. Different
              references, not a contradiction — say so. */}
          <p className="spark-minmax" style={{ display: 'block', paddingTop: 4 }}>
            Phase is measured against {result.reference.toUpperCase()}, so{' '}
            {result.reference.toUpperCase()} is 0 by definition. TIMING BENCH reports the absolute
            trigger-to-VSYNC wait per sensor, where {result.reference.toUpperCase()} is not zero.
          </p>
          <p className={`timing-grade timing-grade--${grade?.state}`} style={{ marginTop: 8 }}>
            <Led state={grade?.state ?? 'off'} label="" />
            PHASE SPREAD {formatUs(result.spreadUs)}
            <span className="dim"> · {grade?.label}</span>
          </p>
          {history.length > 1 ? (
            <p className="spark-minmax">
              PASSES: {history.map((h) => formatUs(h)).join(' → ')}
            </p>
          ) : null}
        </>
      ) : null}
      {error ? <p className="notice notice--err" style={{ marginTop: 8 }}>{error}</p> : null}

      <ConfirmDialog
        open={confirm === 'rephase'}
        danger
        title="RE-PHASE SENSORS"
        confirmLabel="RE-PHASE"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          void call('rephase');
        }}
      >
        <p>
          Restarts all four OV3660 sensors with new phase offsets. Live preview and metering stop
          for several seconds and any capture in progress is lost. Takes about 3 s.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === 'reset'}
        danger
        title="RESET SENSOR PHASE"
        confirmLabel="RESET"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          void call('reset');
        }}
      >
        <p>
          Discards the measured phase offsets and leaves all four sensors free-running. Effective
          exposure spread goes back to up to one full frame interval until you re-phase.
        </p>
      </ConfirmDialog>
    </Panel>
  );
}
