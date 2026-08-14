// Calibration procedures beyond sensor matching: physical camera order,
// lens spacing, and flash exposure. Each one is guided, reviewable, and
// writes nothing until the user saves.

import { useRef, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { NumberField, SegField } from '../../components/fields';
import { getDevice, refreshCalibration } from '../../app/session';
import { useDeviceStore } from '../../state/deviceStore';
import { claimDevice, releaseDevice, useBlockedBy } from '../../state/deviceBusy';
import { invalidateBench } from '../../state/benchResults';
import type { CamId, FlashDistance, FlashLevel } from '../../protocol/types';
import { CAM_IDS } from '../../protocol/types';

const POSITION_LABELS = ['LEFT-MOST', 'CENTER-LEFT', 'CENTER-RIGHT', 'RIGHT-MOST'];

const FLASH_OWNER = 'flash-test';
const FLASH_LABEL = 'FLASH TEST';

/** Metres, en dash, lower case. The unit is m, not M. */
const DISTANCE_LABEL: Record<FlashDistance, string> = {
  '0.5-1': '0.5–1 m',
  '1-2': '1–2 m',
  '2-3': '2–3 m',
};

// ---- physical camera order ----

export function OrderPanel() {
  const calibration = useDeviceStore((s) => s.calibration);
  const [step, setStep] = useState<number | null>(null); // which logical cam is blinking
  const [answers, setAnswers] = useState<(number | null)[]>([null, null, null, null]); // logical idx -> physical pos
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  // What the panel showed before CHECK ORDER started, so cancelling puts it
  // back instead of leaving the wizard's half-filled state behind.
  const priorAnswers = useRef<(number | null)[]>([null, null, null, null]);

  const start = async () => {
    priorAnswers.current = answers;
    setAnswers([null, null, null, null]);
    setError(null);
    await blink(0);
  };

  const cancel = () => {
    setStep(null);
    setError(null);
    setAnswers(priorAnswers.current);
  };

  const blink = async (logicalIdx: number) => {
    const dev = getDevice();
    if (!dev) return;
    setStep(logicalIdx);
    try {
      await dev.calibrationBlink(CAM_IDS[logicalIdx]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep(null);
    }
  };

  const answer = async (physicalPos: number) => {
    if (step === null) return;
    const next = [...answers];
    next[step] = physicalPos;
    setAnswers(next);
    if (step < 3) {
      await blink(step + 1);
    } else {
      setStep(null);
    }
  };

  const complete = answers.every((a) => a !== null);

  // No duplicate branch: an already-used position is a disabled button, so a
  // complete set of answers is always a permutation. The error state it
  // guarded was unreachable.
  // answers[logical] = physical position → order[physical] = logical cam
  const order: CamId[] = complete
    ? answers.reduce<CamId[]>((acc, pos, logical) => {
        acc[pos!] = CAM_IDS[logical];
        return acc;
      }, new Array(4).fill('cam1') as CamId[])
    : [];

  const save = async () => {
    const dev = getDevice();
    if (!dev || order.length !== 4) return;
    setBusy(true);
    setError(null);
    try {
      await dev.saveCameraOrder(order as [CamId, CamId, CamId, CamId]);
      // Every per-camera row on the benches now names a different lens.
      invalidateBench(
        ['timing', 'phase', 'burnin'],
        'the camera order was remapped after this run',
      );
      await refreshCalibration();
      setAnswers([null, null, null, null]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="CAMERA ORDER"
      actions={
        step !== null ? (
          <Button size="sm" variant="ghost" onClick={cancel}>
            CANCEL CHECK
          </Button>
        ) : !complete ? (
          <Button onClick={() => void start()}>CHECK ORDER</Button>
        ) : null
      }
    >
      <p className="dim" style={{ marginBottom: 2 }}>
        Checks that logical CAM1–4 matches the physical left-to-right lens row.
      </p>
      <p className="dim" style={{ marginBottom: 8 }}>
        Current map:{' '}
        <span className="val">
          {calibration ? calibration.order.map((c) => c.toUpperCase().replace('CAM', 'C')).join(' · ') : '—'}
        </span>
        {calibration?.orderVerifiedAt
          ? ` (verified ${new Date(calibration.orderVerifiedAt).toLocaleDateString()})`
          : ' (never verified)'}
      </p>

      {step !== null ? (
        <>
          <p className="notice notice--warn">
            <strong>CAM {step + 1}</strong> status LED is strobing. Which lens is it, viewed from
            the front?
          </p>
          <div className="orderwizard-lens">
            {POSITION_LABELS.map((label, pos) => (
              <Button key={label} disabled={answers.includes(pos)} onClick={() => void answer(pos)}>
                {label}
              </Button>
            ))}
          </div>
          <p className="dim" style={{ marginTop: 6 }}>
            CANCEL CHECK abandons the run at {step + 1} of 4 and restores the previous answers.
            Nothing is written to the camera either way.
          </p>
        </>
      ) : null}

      {complete ? (
        <>
          <p className="notice notice--ok" style={{ marginTop: 8 }}>
            New map, left to right:{' '}
            <strong>{order.map((c) => c.toUpperCase().replace('CAM', 'CAM ')).join(' → ')}</strong>
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="primary" busy={busy} onClick={() => setSaveOpen(true)}>
              SAVE ORDER TO KINO
            </Button>
            <Button variant="ghost" onClick={() => setAnswers([null, null, null, null])}>
              DISCARD
            </Button>
          </div>
        </>
      ) : null}
      {error ? <p className="notice notice--err">{error}</p> : null}

      <ConfirmDialog
        open={saveOpen}
        danger
        title="SAVE CAMERA ORDER"
        confirmLabel="WRITE ORDER"
        onCancel={() => setSaveOpen(false)}
        onConfirm={() => {
          setSaveOpen(false);
          void save();
        }}
      >
        <p>
          Rewrites the logical camera map on KINO to{' '}
          <strong>{order.map((c) => c.toUpperCase().replace('CAM', 'CAM ')).join(' → ')}</strong>,
          left to right.
        </p>
        <p>
          Every stored per-camera offset — calibration, phase, lens spacing — is keyed to the old
          map and will apply to a different lens. Re-run calibration after this. A wrong map inverts
          the wigglegram.
        </p>
      </ConfirmDialog>
    </Panel>
  );
}

// ---- lens spacing ----

export function SpacingPanel() {
  const calibration = useDeviceStore((s) => s.calibration);
  const [values, setValues] = useState<[number, number, number, number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fallback is the V1 nominal pitch, matching the guidance below.
  const current = values ?? calibration?.spacingMm ?? [0, 19, 38, 57];
  const dirty = values !== null && JSON.stringify(values) !== JSON.stringify(calibration?.spacingMm);

  const save = async () => {
    const dev = getDevice();
    if (!dev || !values) return;
    setBusy(true);
    setError(null);
    try {
      await dev.saveLensSpacing(values, 'measured');
      await refreshCalibration();
      setValues(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="LENS SPACING"
      actions={
        dirty ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setValues(null)}>
              DISCARD
            </Button>
            <Button size="sm" variant="primary" busy={busy} onClick={() => void save()}>
              SAVE MEASURED
            </Button>
          </>
        ) : null
      }
    >
      <p className="dim" style={{ marginBottom: 8 }}>
        Optical centers in mm from CAM1. Stored in capture metadata. Current values:{' '}
        <span className="val">{calibration?.spacingSource === 'measured' ? 'MEASURED' : 'NOMINAL'}</span>.
      </p>
      <p className="dim" style={{ marginBottom: 2 }}>
        Nominal pitch is about 19 mm: 0 / 19 / 38 / 57 mm, outer baseline near 57 mm.
      </p>
      <p className="dim" style={{ marginBottom: 8 }}>
        More than a few mm off that is a measuring error, not a build tolerance.
      </p>
      {CAM_IDS.map((cam, i) => (
        <NumberField
          key={cam}
          label={`CAM ${i + 1} (mm)`}
          value={current[i]}
          min={0}
          max={200}
          step={0.1}
          disabled={i === 0}
          onChange={(v) => {
            const next = [...current] as [number, number, number, number];
            next[i] = Math.round(v * 10) / 10;
            setValues(next);
          }}
        />
      ))}
      {error ? <p className="notice notice--err">{error}</p> : null}
    </Panel>
  );
}

// ---- flash calibration ----

export function FlashPanel() {
  const calibration = useDeviceStore((s) => s.calibration);
  const [level, setLevel] = useState<FlashLevel | null>(null);
  const [distance, setDistance] = useState<FlashDistance | null>(null);
  const [results, setResults] = useState<{ cam: CamId; clippedPct: number }[] | null>(null);
  const [suggested, setSuggested] = useState<FlashLevel | null>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blockedBy = useBlockedBy(FLASH_OWNER);

  // Same dirty model as LENS SPACING: what the device holds, what the panel
  // is showing, and whether those differ. Selecting HIGH against a stored
  // MEDIUM used to show nothing at all, and CAPTURE TEST then fired at the
  // unsaved level without saying so.
  // Null means the device reported nothing, which is not the same as MEDIUM.
  const storedLevel = calibration?.flash.level ?? null;
  const storedDistance = calibration?.flash.distance ?? null;
  const curLevel = level ?? storedLevel ?? 'medium';
  const curDistance = distance ?? storedDistance ?? '1-2';
  const dirty = curLevel !== storedLevel || curDistance !== storedDistance;

  const discard = () => {
    setLevel(null);
    setDistance(null);
  };

  const runTest = async () => {
    const dev = getDevice();
    if (!dev || testing) return;
    // Fires the flash and captures on all four cameras — same link, same
    // claim as the developer benches.
    if (!claimDevice(FLASH_OWNER, FLASH_LABEL)) return;
    setTesting(true);
    setError(null);
    setResults(null);
    try {
      const res = await dev.flashTest({ level: curLevel, distance: curDistance });
      setResults(res.results);
      setSuggested(res.suggested);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      releaseDevice(FLASH_OWNER);
      setTesting(false);
    }
  };

  const save = async (saveLevel: FlashLevel) => {
    const dev = getDevice();
    if (!dev) return;
    setBusy(true);
    setError(null);
    try {
      await dev.saveFlashCalibration({ level: saveLevel, distance: curDistance });
      // Burn-in logs battery sag per shot, and the flash is the load.
      invalidateBench(['burnin'], 'the flash level was changed after this run');
      await refreshCalibration();
      setLevel(null);
      setDistance(null);
      setResults(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="FLASH"
      actions={
        dirty ? (
          <>
            <Button size="sm" variant="ghost" disabled={busy} onClick={discard}>
              DISCARD
            </Button>
            <Button size="sm" variant="primary" busy={busy} onClick={() => void save(curLevel)}>
              SAVE LEVEL
            </Button>
          </>
        ) : null
      }
    >
      <p className="dim" style={{ marginBottom: 2 }}>
        Fires a test pulse and measures highlight clipping per sensor. Test captures are discarded.
      </p>
      <p className="dim" style={{ marginBottom: 8 }}>
        Stored level:{' '}
        <span className="val">
          {storedLevel && storedDistance
            ? `${storedLevel.toUpperCase()} at ${DISTANCE_LABEL[storedDistance]}`
            : '—'}
        </span>
        {calibration?.flash.calibratedAt
          ? ` (${new Date(calibration.flash.calibratedAt).toLocaleDateString()})`
          : ''}
        {dirty ? <span className="tag" style={{ marginLeft: 8 }}>UNSAVED</span> : null}
      </p>
      <SegField
        label="FLASH LEVEL"
        value={curLevel}
        options={[
          { value: 'low', label: 'LOW' },
          { value: 'medium', label: 'MEDIUM' },
          { value: 'high', label: 'HIGH' },
        ]}
        onChange={(v) => setLevel(v as FlashLevel)}
      />
      <SegField
        label="SUBJECT DISTANCE"
        value={curDistance}
        options={[
          { value: '0.5-1', label: DISTANCE_LABEL['0.5-1'] },
          { value: '1-2', label: DISTANCE_LABEL['1-2'] },
          { value: '2-3', label: DISTANCE_LABEL['2-3'] },
        ]}
        onChange={(v) => setDistance(v as FlashDistance)}
      />
      {dirty ? (
        <p className="notice notice--warn" style={{ marginTop: 8, marginBottom: 0 }}>
          Selected {curLevel.toUpperCase()} at {DISTANCE_LABEL[curDistance]} is not stored on KINO.
          CAPTURE TEST fires at the selected level, not the stored one.
        </p>
      ) : null}
      {/* Read before the click, not after it. */}
      <p className="microlabel" style={{ paddingTop: 8 }}>
        CAPTURE TEST FIRES A BRIGHT FLASH
      </p>
      <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
        <Button
          variant="primary"
          busy={testing}
          disabled={!testing && blockedBy !== null}
          title={blockedBy ? `${blockedBy} is running` : undefined}
          onClick={() => void runTest()}
        >
          CAPTURE TEST
        </Button>
      </div>
      <p className="val" role="status" style={{ padding: '6px 0 0', minHeight: 18 }}>
        {testing ? 'FIRING FLASH · CAPTURING 4 CAMERAS…' : blockedBy ? `${blockedBy} is running.` : ''}
      </p>

      {results ? (
        <div style={{ marginTop: 8 }}>
          <table className="table">
            <thead>
              <tr>
                <th>CAMERA</th>
                <th className="num">HIGHLIGHTS CLIPPED</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.cam}>
                  <td>CAM {r.cam.slice(-1)}</td>
                  <td className="num">{r.clippedPct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          {suggested ? (
            <p className="notice notice--ok" style={{ marginTop: 8, marginBottom: 0 }}>
              Suggested level for {DISTANCE_LABEL[curDistance]}: <strong>{suggested.toUpperCase()}</strong>
              {suggested !== curLevel ? (
                <Button size="sm" busy={busy} style={{ marginLeft: 10 }} onClick={() => void save(suggested)}>
                  APPLY {suggested.toUpperCase()}
                </Button>
              ) : (
                ' — already set.'
              )}
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="notice notice--err" style={{ marginTop: 8 }}>{error}</p> : null}
    </Panel>
  );
}
