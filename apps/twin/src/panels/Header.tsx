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
  const [captureState, setCaptureState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');

  async function runTestCapture() {
    setCaptureState('working');
    try {
      await testCapture();
      setCaptureState('done');
    } catch {
      setCaptureState('error');
    }
  }

  return (
    <header className="twin-header">
      <span className="twin-header-item">KINO Twin</span>
      <span className="twin-header-sep">|</span>
      <span className="twin-header-item">D4 V1</span>
      <span className="twin-header-sep">|</span>
      <span className="twin-header-item">
        <span className={bootStage === 'READY' ? 'twin-dot twin-dot--ok' : 'twin-dot'} aria-hidden="true" />
        {simLabel(running, bootStage)}
        {running && bootStage !== 'READY' ? ` · ${bootStage}` : ''}
      </span>
      <button type="button" className="twin-header-action" onClick={running ? powerOff : powerOn}>
        {running ? 'POWER OFF' : 'POWER ON'}
      </button>
      <button
        type="button"
        className="twin-header-action"
        disabled={bootStage !== 'READY' || studioConnected || captureState === 'working'}
        onClick={() => void runTestCapture()}
      >
        {captureState === 'working' ? 'CAPTURING…' : captureState === 'error' ? 'CAPTURE FAILED' : 'TEST CAPTURE'}
      </button>
      <span className="twin-header-sep">|</span>
      <span className="twin-header-item twin-header-item--last">
        Studio <span className={studioConnected ? 'twin-dot twin-dot--ok' : 'twin-dot'} aria-hidden="true" />{' '}
        {studioConnected ? 'CONNECTED' : '—'}
      </span>
    </header>
  );
}
