import { useState } from 'react';
import type { CamId, FocusMode } from '@kino/kdp';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Led } from '../../components/Led';
import type { LedState } from '../../components/Led';
import { useDeviceStore, setDeviceState, supports } from '../../state/deviceStore';
import { getDevice, refreshConfig } from '../../app/session';

const MODES: { mode: FocusMode; label: string; hint: string }[] = [
  { mode: 'party-auto', label: 'PARTY AUTO', hint: 'Autofocus before each capture, then lock' },
  { mode: 'party-fixed', label: 'PARTY FIXED', hint: 'Stored calibrated position for party distance' },
  { mode: 'manual', label: 'MANUAL', hint: 'Direct lens position' },
];

function focusLed(state: string): { led: LedState; label: string } {
  switch (state) {
    case 'locked':
      return { led: 'ok', label: 'LOCKED' };
    case 'searching':
      return { led: 'busy', label: 'SEARCHING' };
    case 'failed':
      return { led: 'err', label: 'FAILED' };
    default:
      return { led: 'off', label: 'IDLE' };
  }
}

/**
 * Focus control (audit #55). Rendered only when the firmware advertises the
 * `autofocus` capability — an OV3660 camera never sees this panel. Every
 * action is the CAMERA_FOCUS command; camera state re-reads after each.
 */
export function FocusPanel() {
  const cameras = useDeviceStore((s) => s.cameras);
  const config = useDeviceStore((s) => s.config);
  // Two sub-capabilities of `autofocus`, each absent-is-no: a firmware can
  // drive AF and still not hold a lock across a capture group, or not take a
  // VCM position directly. The panel shows what the firmware said it does.
  const hasFocusLock = useDeviceStore((s) => supports(s, 'focusLock'));
  const hasManualFocus = useDeviceStore((s) => supports(s, 'manualFocus'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualCam, setManualCam] = useState<CamId>('cam1');
  const [manualPos, setManualPos] = useState(128);

  const afCams = cameras.filter((cam) => cam.focus);
  const mode = config?.wiggle.focusMode ?? 'party-auto';
  // One button, two directions: whichever the cameras are in, the label says
  // what pressing it does.
  const anyLocked = afCams.some((cam) => cam.focus?.locked === true);

  async function run(action: () => Promise<unknown>) {
    const dev = getDevice();
    if (!dev) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      const info = await dev.getCameraInfo();
      setDeviceState({ cameras: info.cameras });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="FOCUS">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {MODES.map((m) => {
          const unsupported = m.mode === 'manual' && !hasManualFocus;
          return (
            <Button
              key={m.mode}
              size="sm"
              variant={mode === m.mode ? 'primary' : 'default'}
              title={unsupported ? 'This firmware does not take a VCM position directly (manualFocus).' : m.hint}
              disabled={busy || unsupported}
              // The mode lives in config (`wiggle.focusMode`), which is what
              // the highlight and the MANUAL slider key on. Re-reading camera
              // info alone left the old mode lit after a successful switch.
              onClick={() =>
                void run(async () => {
                  await getDevice()!.focusMode(m.mode);
                  await refreshConfig();
                })
              }
            >
              {m.label}
            </Button>
          );
        })}
      </div>

      <table className="table" style={{ marginBottom: 8 }}>
        <thead>
          <tr>
            <th>CAM</th>
            <th>STATE</th>
            <th className="num">VCM</th>
            <th className="num">DIST</th>
          </tr>
        </thead>
        <tbody>
          {afCams.map((cam) => {
            const f = cam.focus!;
            const led = focusLed(f.state);
            return (
              <tr key={cam.id}>
                <td>{cam.id.toUpperCase()}</td>
                <td>
                  <Led state={led.led} label={`${led.label}${f.locked ? ' · HELD' : ''}`} />
                </td>
                <td className="num">{f.vcmPosition ?? '—'}</td>
                <td className="num">{f.estimatedDistanceM !== null ? `${f.estimatedDistanceM.toFixed(1)} m` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button size="sm" disabled={busy} onClick={() => void run(() => getDevice()!.focusTrigger())}>
          TRIGGER AF
        </Button>
        {/* The firmware has held and released focus since audit #55 and
            nothing here could ask it to: `focusLock` had no caller and there
            was no unlock sender at all, so a lens stuck on the wrong subject
            could only be freed by changing mode. */}
        {hasFocusLock ? (
          <Button
            size="sm"
            disabled={busy || afCams.length === 0}
            variant={anyLocked ? 'primary' : 'default'}
            title={
              anyLocked
                ? 'Release the focus lock so the next capture can refocus'
                : 'Hold the current lens positions for the capture group'
            }
            onClick={() => void run(() => (anyLocked ? getDevice()!.focusUnlock() : getDevice()!.focusLock(true)))}
          >
            {anyLocked ? 'RELEASE FOCUS' : 'HOLD FOCUS'}
          </Button>
        ) : (
          <span className="dim" title="This firmware does not hold a focus lock across a capture group (focusLock).">
            NO FOCUS LOCK ON THIS FIRMWARE
          </span>
        )}
        <Button size="sm" disabled={busy} onClick={() => void run(() => getDevice()!.focusStoreFixed())}
          title="Persist the current locked positions as the PARTY FIXED calibration">
          STORE AS PARTY FIXED
        </Button>
        {mode === 'manual' && hasManualFocus ? (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select value={manualCam} disabled={busy} onChange={(e) => setManualCam(e.target.value as CamId)}>
              {afCams.map((cam) => (
                <option key={cam.id} value={cam.id}>
                  {cam.id.toUpperCase()}
                </option>
              ))}
            </select>
            <input
              type="range"
              min={0}
              max={255}
              value={manualPos}
              disabled={busy}
              onChange={(e) => setManualPos(Number(e.target.value))}
              aria-label="Manual VCM position"
            />
            <span className="mono">{manualPos}</span>
            <Button size="sm" disabled={busy} onClick={() => void run(() => getDevice()!.focusSet(manualCam, manualPos))}>
              SET
            </Button>
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="warn" style={{ marginTop: 6 }}>
          {error}
        </p>
      ) : null}
    </Panel>
  );
}
