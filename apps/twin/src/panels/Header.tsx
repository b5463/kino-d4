import { profileById } from '@kino/test-fixtures';
import { useState } from 'react';
import { rebootDevice, setFlashEnabled, useSimStore } from '../state/simStore';
import kinoD4Twin from '../assets/kino-d4-twin-light.png';

function simLabel(running: boolean, bootStage: string): string {
  if (!running) return 'SIM OFF';
  if (bootStage === 'READY') return 'SIM READY';
  return 'BOOTING';
}

export function Header() {
  const running = useSimStore((state) => state.running);
  const bootStage = useSimStore((state) => state.bootStage);
  const studioConnected = useSimStore((state) => state.studioConnected);
  const snapshot = useSimStore((state) => state.snapshot);
  const powerOn = useSimStore((state) => state.powerOn);
  const powerOff = useSimStore((state) => state.powerOff);
  const testCapture = useSimStore((state) => state.testCapture);
  const [captureState, setCaptureState] = useState<'idle' | 'working' | 'error'>('idle');
  const [busy, setBusy] = useState<'flash' | 'reboot' | null>(null);

  async function fireShutter() {
    setCaptureState('working');
    try {
      await testCapture();
      setCaptureState('idle');
    } catch {
      setCaptureState('error');
    }
  }

  async function act(kind: 'flash' | 'reboot', run: () => Promise<void>) {
    setBusy(kind);
    try {
      await run();
    } catch {
      /* the device said no (NACK) or the link is owned — state is unchanged */
    } finally {
      setBusy(null);
    }
  }

  const linkBlocked = bootStage !== 'READY' || studioConnected;
  const shutterBlocked = linkBlocked || captureState === 'working';
  const shutterHint = !running
    ? 'Power on first'
    : bootStage !== 'READY'
      ? 'Wait for boot to finish'
      : studioConnected
        ? 'Studio owns the link — capture from Studio'
        : 'Fires a four-lens capture over KDP';

  const flashOn = snapshot?.flashEnabled ?? false;
  /* Gated on the capability, not on the profile's name.
   *
   * This used to test `firmwareProfile === 'd4-m1b'` and say "0.1.0 has no
   * config surface". 0.2.0 has one — SET_CONFIG works — and flash control is
   * still absent for an unrelated reason: no firmware drives the LED yet.
   * Asking the capability keeps the button and its explanation true as each
   * of those changes independently. */
  const profileCaps = profileById(snapshot?.firmwareProfile)?.capabilities;
  const flashUnsupported = profileCaps ? profileCaps.flashControl !== true : false;
  const flashBlocked = linkBlocked || flashUnsupported || busy !== null;
  const flashHint = flashUnsupported
    ? 'This firmware advertises no flashControl capability — the LED has no driver yet'
    : studioConnected
      ? 'Studio owns the link — change flash from Studio'
      : 'SET_CONFIG wiggle.flash over KDP';
  const rebootHint = studioConnected ? 'Studio owns the link — reboot from Studio' : 'KDP REBOOT: answers, then restarts';

  return (
    <header className="twin-header">
      {/* Twin has its own wordmark, so the app name lives in the mark rather
          than in a word beside it. "D4 V1" stays: that is the loaded
          hardware profile revision, not branding. */}
      <img className="twin-header-mark" src={kinoD4Twin} alt="KINO D4 twin" />
      <span className="twin-header-item twin-header-muted">D4 V1</span>

      <button
        type="button"
        className={running ? 'twin-btn twin-header-control' : 'twin-btn twin-btn--primary twin-header-control'}
        onClick={running ? powerOff : powerOn}
      >
        {running ? 'POWER OFF' : 'POWER ON'}
      </button>
      <button
        type="button"
        className="twin-btn twin-header-control"
        disabled={shutterBlocked}
        title={shutterHint}
        onClick={() => void fireShutter()}
      >
        {captureState === 'working' ? 'CAPTURING…' : captureState === 'error' ? 'CAPTURE FAILED — RETRY' : 'SHUTTER'}
      </button>
      <button
        type="button"
        className={flashOn ? 'twin-btn twin-btn--active twin-header-control' : 'twin-btn twin-header-control'}
        disabled={flashBlocked}
        title={flashHint}
        aria-pressed={flashOn}
        onClick={() => void act('flash', () => setFlashEnabled(!flashOn))}
      >
        {busy === 'flash' ? 'FLASH…' : `FLASH ${flashOn ? 'ON' : 'OFF'}`}
      </button>
      <button
        type="button"
        className="twin-btn twin-header-control"
        disabled={linkBlocked || busy !== null}
        title={rebootHint}
        onClick={() => void act('reboot', rebootDevice)}
      >
        {busy === 'reboot' ? 'REBOOTING…' : 'REBOOT'}
      </button>

      <span className="twin-header-item">
        <span className={bootStage === 'READY' ? 'twin-dot twin-dot--ok' : running ? 'twin-dot twin-dot--warn' : 'twin-dot'} aria-hidden="true" />
        {simLabel(running, bootStage)}
        {running && bootStage !== 'READY' ? ` · ${bootStage.replaceAll('_', ' ')}` : ''}
      </span>

      <span className="twin-header-item twin-header-item--last">
        Studio <span className={studioConnected ? 'twin-dot twin-dot--ok' : 'twin-dot'} aria-hidden="true" />{' '}
        {studioConnected ? 'CONNECTED' : 'NOT CONNECTED'}
      </span>
    </header>
  );
}
