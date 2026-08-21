import { useState } from 'react';
import { useSimStore } from '../state/simStore';

function simLabel(running: boolean, bootStage: string): string {
  if (!running) return 'SIM OFF';
  if (bootStage === 'READY') return 'SIM READY';
  return 'BOOTING';
}

export function Header() {
  const running = useSimStore((state) => state.running);
  const bootStage = useSimStore((state) => state.bootStage);
  const studioConnected = useSimStore((state) => state.studioConnected);
  const powerOn = useSimStore((state) => state.powerOn);
  const powerOff = useSimStore((state) => state.powerOff);
  const testCapture = useSimStore((state) => state.testCapture);
  const [captureState, setCaptureState] = useState<'idle' | 'working' | 'error'>('idle');

  async function fireShutter() {
    setCaptureState('working');
    try {
      await testCapture();
      setCaptureState('idle');
    } catch {
      setCaptureState('error');
    }
  }

  const shutterBlocked = bootStage !== 'READY' || studioConnected || captureState === 'working';
  const shutterHint = !running
    ? 'Power on first'
    : bootStage !== 'READY'
      ? 'Wait for boot to finish'
      : studioConnected
        ? 'Studio owns the link — capture from Studio'
        : 'Fires a four-lens capture over KDP';

  return (
    <header className="twin-header">
      <span className="twin-header-brand">KINO TWIN</span>
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
