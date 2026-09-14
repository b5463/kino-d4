import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useSimStore } from '../state/simStore';
import { DISPLAY_H, DISPLAY_W, drawDeviceUi } from '../display/deviceUi';
import { BUTTON, firmwareUi } from '../display/firmwareUi';
import { readDeviceUiState } from '../scene/DisplayScreen';

const REDRAW_MS = 150;

/** "" while the sketch is showing; the firmware version once ui.c is up. */
function useFirmwareStatus(): string {
  const fw = firmwareUi();
  return useSyncExternalStore(
    (cb) => fw.onStatus(cb),
    () => (fw.available() ? `${fw.version ?? '?'}:${fw.variant ?? ''}` : ''),
  );
}

/**
 * Flat inspector view of the on-device display, plus the shutter.
 *
 * Once the simulator is SIM READY the picture is the P4 firmware's own ui.c,
 * built to WebAssembly (firmware/p4/twin_ui) and driven by the same device
 * state Studio reads over KDP. The canvas is the touch panel: press, slide
 * off, lift, exactly as the glass takes it. The SHUTTER button is the body's
 * physical key - from the menu it opens the viewfinder, on the viewfinder it
 * captures - so it works whether or not Studio holds the link, as the key on
 * a camera does. Before SIM READY, and in a build without the module, the
 * sketch in deviceUi.ts draws POWER OFF and the boot ladder as before.
 */
export function DisplayPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bootStage = useSimStore((s) => s.bootStage);
  const studioConnected = useSimStore((s) => s.studioConnected);
  const testCapture = useSimStore((s) => s.testCapture);
  const [shutter, setShutter] = useState<'idle' | 'working' | 'error'>('idle');
  const fw = firmwareUi();
  const status = useFirmwareStatus();
  const live = status !== '';

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const redraw = () => {
      if (fw.available()) ctx.drawImage(fw.screen, 0, 0);
      else drawDeviceUi(ctx, readDeviceUiState());
    };
    redraw();
    const timer = setInterval(redraw, REDRAW_MS);
    const off = fw.onFrame(redraw);
    return () => {
      clearInterval(timer);
      off();
    };
  }, [fw]);

  function point(e: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * DISPLAY_W),
      y: Math.round(((e.clientY - r.top) / r.height) * DISPLAY_H),
    };
  }
  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!fw.available()) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    fw.setTouch(true, p.x, p.y);
  }
  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!fw.available() || e.buttons === 0) return;
    const p = point(e);
    fw.setTouch(true, p.x, p.y);
  }
  function onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>) {
    const p = point(e);
    fw.setTouch(false, p.x, p.y);
  }

  async function fire() {
    if (fw.available()) {
      fw.button(BUTTON.SHUTTER);
      return;
    }
    setShutter('working');
    try {
      await testCapture();
      setShutter('idle');
    } catch {
      setShutter('error');
    }
  }

  const blocked = bootStage !== 'READY' || (!live && (studioConnected || shutter === 'working'));
  const heading = live
    ? `FIRMWARE ui.c ${fw.version ?? ''}${fw.variant === 'placeholder' ? ' · PLACEHOLDER ICONS' : ''}`
    : 'SIMULATED';
  return (
    <section className="twin-tool-panel" aria-label="Device display">
      <div className="twin-panel-heading"><span>DEVICE DISPLAY</span><span>{heading}</span></div>
      <div className="twin-panel-section">
        <canvas
          ref={canvasRef}
          width={DISPLAY_W}
          height={DISPLAY_H}
          className="twin-display-canvas"
          style={{ touchAction: 'none', cursor: live ? 'pointer' : 'default' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-label={live ? 'Touch panel' : 'Device display'}
        />
        {live ? (
          <p className="twin-panel-note">
            The camera's own ui.c, running here. Tap the screen; SHUTTER is the body's key.
            {fw.variant === 'placeholder' ? ' Menu tiles carry placeholder glyphs (THIRD_PARTY_NOTICES.md).' : ''}
          </p>
        ) : (
          <p className="twin-panel-note">Simulated device UI. Same state Studio reads over KDP.</p>
        )}
        <button type="button" className="twin-btn" disabled={blocked} onClick={() => void fire()}>
          {shutter === 'working' ? 'CAPTURING…' : shutter === 'error' ? 'CAPTURE FAILED — RETRY' : 'SHUTTER'}
        </button>
        {bootStage !== 'READY' && <p className="twin-panel-note">Power on and wait for SIM READY.</p>}
        {!live && studioConnected && <p className="twin-panel-note">Studio owns the link. Trigger captures from Studio.</p>}
      </div>
    </section>
  );
}
