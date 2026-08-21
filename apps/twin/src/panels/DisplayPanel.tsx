import { useEffect, useRef, useState } from 'react';
import { useSimStore } from '../state/simStore';
import { DISPLAY_H, DISPLAY_W, drawDeviceUi } from '../display/deviceUi';
import { readDeviceUiState } from '../scene/DisplayScreen';

const REDRAW_MS = 150;

/**
 * Flat inspector view of the on-device display, plus the shutter. The shutter
 * uses the same raw-KDP test-capture path as the header — no side channel.
 */
export function DisplayPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bootStage = useSimStore((s) => s.bootStage);
  const studioConnected = useSimStore((s) => s.studioConnected);
  const testCapture = useSimStore((s) => s.testCapture);
  const [shutter, setShutter] = useState<'idle' | 'working' | 'error'>('idle');

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const redraw = () => drawDeviceUi(ctx, readDeviceUiState());
    redraw();
    const timer = setInterval(redraw, REDRAW_MS);
    return () => clearInterval(timer);
  }, []);

  async function fire() {
    setShutter('working');
    try {
      await testCapture();
      setShutter('idle');
    } catch {
      setShutter('error');
    }
  }

  const blocked = bootStage !== 'READY' || studioConnected || shutter === 'working';
  return (
    <section className="twin-tool-panel" aria-label="Device display">
      <div className="twin-panel-heading"><span>DEVICE DISPLAY</span><span>SIMULATED</span></div>
      <div className="twin-panel-section">
        <canvas ref={canvasRef} width={DISPLAY_W} height={DISPLAY_H} className="twin-display-canvas" />
        <p className="twin-panel-note">Simulated device UI. Same state Studio reads over KDP.</p>
        <button type="button" className="twin-btn" disabled={blocked} onClick={() => void fire()}>
          {shutter === 'working' ? 'CAPTURING…' : shutter === 'error' ? 'CAPTURE FAILED — RETRY' : 'SHUTTER'}
        </button>
        {bootStage !== 'READY' && <p className="twin-panel-note">Power on and wait for SIM READY.</p>}
        {studioConnected && <p className="twin-panel-note">Studio owns the link. Trigger captures from Studio.</p>}
      </div>
    </section>
  );
}
