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
import {
  benchStamp,
  getBenchResult,
  invalidateBench,
  putBenchResult,
  useBenchResult,
} from '../../state/benchResults';
import { formatUs, gradeSkew, usColumn } from '@kino/kdp';
import { formatSigned } from '../../utils/format';
import type { PhaseResult } from '@kino/kdp';

const OWNER = 'phase';
const LABEL = 'SENSOR PHASE';

interface PhaseStats {
  result: PhaseResult;
  /** Spread after each pass, oldest first. */
  history: number[];
}

/**
 * Restarting the sensors changes the thing TIMING BENCH and BURN-IN measured,
 * so their old numbers stop describing this device the moment this succeeds.
 */
function invalidateCaptureBenches(reason: string) {
  invalidateBench(['timing', 'burnin'], reason);
}

export function PhasePanel() {
  const state = useDeviceStore();
  const [busy, setBusy] = useState<'measure' | 'rephase' | 'reset' | null>(null);
  const [step, setStep] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'rephase' | 'reset' | null>(null);
  const blockedBy = useBlockedBy(OWNER);

  // Held in the bench store, so leaving the page does not throw the result
  // away and the panel can print when it was measured.
  const entry = useBenchResult<PhaseStats>(OWNER);
  const result = entry?.result.result ?? null;
  const history = entry?.result.history ?? [];
  const stamp = benchStamp(entry);

  const hasPhase = supports(state, 'phaseCalibration');

  useEffect(() => {
    return onPhaseEvent((e) => {
      if (e.step === 'rephase') {
        setStep(`Restarting ${e.cam.toUpperCase()} with phase offset…`);
        return;
      }
      const snapshot = e as PhaseResult;
      const prior = getBenchResult<PhaseStats>(OWNER)?.result.history ?? [];
      putBenchResult<PhaseStats>(OWNER, {
        result: snapshot,
        history: [...prior, snapshot.spreadUs],
      });
      invalidateCaptureBenches('sensors were re-phased after this run');
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
        const prior = getBenchResult<PhaseStats>(OWNER)?.result.history ?? [];
        putBenchResult<PhaseStats>(OWNER, { result: r, history: [...prior, r.spreadUs] });
        setBusy(null);
        releaseDevice(OWNER);
      } else if (action === 'reset') {
        const r = await dev.resetPhase();
        putBenchResult<PhaseStats>(OWNER, { result: r, history: [r.spreadUs] });
        invalidateCaptureBenches('sensor phase was reset after this run');
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
      <p className="dim" style={{ marginBottom: 2 }}>
        Each sensor free-runs on its own clock.
      </p>
      <p className="dim" style={{ marginBottom: 6 }}>
        Re-phasing restarts them with compensating delays. Repeat until the spread stops improving.
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
          {/* This used to claim a reference convention that differs from
              TIMING BENCH's. It does not: both report the same wait, and the
              two panels agreed to ~100 µs while the note explained a
              difference that was never there. */}
          <p className="spark-minmax" style={{ display: 'block', paddingTop: 4 }}>
            Phase is measured against {result.reference.toUpperCase()}, so{' '}
            {result.reference.toUpperCase()} is 0 by definition.
          </p>
          <p className="spark-minmax" style={{ display: 'block' }}>
            TIMING BENCH's VSYNC PHASE column is the same trigger-to-VSYNC wait. Expect the same
            numbers there, within run-to-run jitter.
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
