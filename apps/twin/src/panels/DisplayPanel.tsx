import { useState, useSyncExternalStore } from 'react';
import { useSimStore } from '../state/simStore';
import { BUTTON, firmwareUi } from '../display/firmwareUi';
import { FirmwareScreenCanvas } from '../display/FirmwareScreenCanvas';
import { SCREEN_HASH } from '../display/screenFocus';

/** "" while the sketch is showing; the firmware version once ui.c is up. */
function useFirmwareStatus(): string {
  const fw = firmwareUi();
  return useSyncExternalStore(
    (cb) => fw.onStatus(cb),
    () => (fw.available() ? (fw.version ?? '?') : ''),
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
 *
 * There is one build of ui.c now. The panel used to say which variant was
 * loaded because there were two - the real one and a second with placeholder
 * menu glyphs, carried while the shell's artwork had a licence question over
 * it. The artwork is gone and so is the variant.
 */
export function DisplayPanel() {
  const bootStage = useSimStore((s) => s.bootStage);
  const studioConnected = useSimStore((s) => s.studioConnected);
  const testCapture = useSimStore((s) => s.testCapture);
  const [shutter, setShutter] = useState<'idle' | 'working' | 'error'>('idle');
  const fw = firmwareUi();
  const status = useFirmwareStatus();
  const live = status !== '';

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
  const heading = live ? `FIRMWARE ui.c ${fw.version ?? ''}` : 'SIMULATED';
  return (
    <section className="twin-tool-panel" aria-label="Device display">
      <div className="twin-panel-heading"><span>DEVICE DISPLAY</span><span>{heading}</span></div>
      <div className="twin-panel-section">
        <FirmwareScreenCanvas className="twin-display-canvas" />
        {live ? (
          <p className="twin-panel-note">
            The camera's own ui.c, running here. Tap the screen; SHUTTER is the body's key.
          </p>
        ) : (
          <p className="twin-panel-note">Simulated device UI. Same state Studio reads over KDP.</p>
        )}
        <div className="twin-button-grid">
          <button type="button" className="twin-btn" disabled={blocked} onClick={() => void fire()}>
            {shutter === 'working' ? 'CAPTURING…' : shutter === 'error' ? 'CAPTURE FAILED — RETRY' : 'SHUTTER'}
          </button>
          <a
            className="twin-btn"
            href={SCREEN_HASH}
            title="Just the display, full window. Nothing else is drawn, so nothing can reset the view."
          >
            SCREEN VIEW
          </a>
        </div>
        {bootStage !== 'READY' && <p className="twin-panel-note">Power on and wait for SIM READY.</p>}
        {!live && studioConnected && <p className="twin-panel-note">Studio owns the link. Trigger captures from Studio.</p>}
      </div>
    </section>
  );
}
