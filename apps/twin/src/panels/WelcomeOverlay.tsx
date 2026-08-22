import { useSimStore } from '../state/simStore';
import kinoD4Twin from '../assets/kino-d4-twin-light.png';

const BOOT_ORDER = [
  'BOOTING_P4',
  'CAMERA_RAIL_START',
  'CAMERA_NODES_BOOT',
  'STORAGE_MOUNT',
  'NETWORK_INIT',
] as const;

const BOOT_LABEL: Record<(typeof BOOT_ORDER)[number], string> = {
  BOOTING_P4: 'Main controller boots',
  CAMERA_RAIL_START: 'Camera power rail on',
  CAMERA_NODES_BOOT: 'Four camera nodes boot',
  STORAGE_MOUNT: 'SD card mounts',
  NETWORK_INIT: 'Wi-Fi comes up',
};

/**
 * The viewport's start state. Powered off: says what Twin is and offers the
 * one action that starts it. Booting: shows the real boot ladder against the
 * glowing parts behind it. Gone once the simulator is READY.
 */
export function WelcomeOverlay() {
  const running = useSimStore((s) => s.running);
  const bootStage = useSimStore((s) => s.bootStage);
  const powerOn = useSimStore((s) => s.powerOn);

  if (running && bootStage === 'READY') return null;

  if (!running) {
    return (
      <div className="twin-welcome" role="region" aria-label="Getting started">
        <div className="twin-welcome-card">
          <h1 className="twin-welcome-title">
            <img className="twin-welcome-mark" src={kinoD4Twin} alt="KINO D4 twin" />
          </h1>
          <p className="twin-welcome-lead">
            A working 3D copy of the D4 camera. Same protocol, same firmware behavior, no hardware required.
          </p>
          <button type="button" className="twin-btn twin-btn--primary twin-welcome-power" onClick={powerOn}>
            POWER ON
          </button>
          <ol className="twin-welcome-steps">
            <li><strong>POWER ON</strong> boots the simulated camera.</li>
            <li><strong>SHUTTER</strong> fires a four-lens capture. Watch the display on the back.</li>
            <li><strong>Click any part</strong> in the 3D view for its dimensions and state.</li>
          </ol>
          <p className="twin-welcome-note">Drag to orbit. Scroll to zoom. Everything here is simulated and labelled as such.</p>
        </div>
      </div>
    );
  }

  const reached = BOOT_ORDER.indexOf(bootStage as (typeof BOOT_ORDER)[number]);
  return (
    <div className="twin-welcome twin-welcome--boot" role="status" aria-label="Boot progress">
      <div className="twin-welcome-card twin-welcome-card--boot">
        <p className="twin-welcome-boot-title">BOOTING</p>
        <ol className="twin-welcome-bootlist">
          {BOOT_ORDER.map((stage, i) => {
            const state = i < reached ? 'done' : i === reached ? 'now' : 'next';
            return (
              <li key={stage} className={`twin-welcome-bootstep twin-welcome-bootstep--${state}`}>
                <span aria-hidden="true">{state === 'done' ? '✓' : state === 'now' ? '▸' : '·'}</span> {BOOT_LABEL[stage]}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
