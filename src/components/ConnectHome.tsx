import { Button } from './Button';
import { PHASE_LABEL, useConnectionStore } from '../state/connectionStore';
import { connectDemo, connectSerial } from '../app/session';
import { useKnownCameras } from '../state/knownCameras';
import { APP_VERSION } from '../app/App';

// Disconnected home: one dominant action, honest environment facts below.
export function ConnectHome() {
  const phase = useConnectionStore((s) => s.phase);
  const error = useConnectionStore((s) => s.error);
  const serialSupported = useConnectionStore((s) => s.serialSupported);
  const known = useKnownCameras((s) => s.cameras);

  const busy = phase === 'requesting-port' || phase === 'connecting' || phase === 'handshaking';
  const offlineReady = typeof navigator !== 'undefined' && navigator.serviceWorker?.controller != null;

  return (
    <div className="connect">
      <div className="connect-card">
        <div className="connect-mark">KINO</div>
        <div className="connect-sub">STUDIO</div>

        <div className="connect-cams" aria-hidden="true">
          <span className="connect-cam" />
          <span className="connect-cam" />
          <span className="connect-cam" />
          <span className="connect-cam" />
        </div>

        <div className="connect-actions">
          <Button variant="primary" size="lg" busy={busy} disabled={!serialSupported} onClick={() => void connectSerial()}>
            CONNECT KINO CAMERA
          </Button>
          <Button disabled={busy} onClick={() => void connectDemo()}>
            OPEN DEMO DEVICE
          </Button>
        </div>

        <div className="connect-status" role="status">
          {busy ? PHASE_LABEL[phase] : error ?? ''}
        </div>

        {!serialSupported ? (
          <p className="connect-note">
            No Web Serial in this browser — USB connection is not possible. Use desktop Chrome or
            Edge. The demo device still works.
          </p>
        ) : (
          <p className="connect-note">
            Plug in over USB-C and pick the port. The demo device simulates the full camera without
            hardware.
          </p>
        )}

        <div className="connect-facts">
          <span className="datarow">
            <span className="dim">Web Serial</span>
            <span className="val">{serialSupported ? 'AVAILABLE' : 'NOT AVAILABLE'}</span>
          </span>
          <span className="datarow">
            <span className="dim">Works offline</span>
            <span className="val">{offlineReady ? 'YES — SHELL CACHED' : 'AFTER FIRST VISIT'}</span>
          </span>
          <span className="datarow">
            <span className="dim">KINO Studio</span>
            <span className="val">v{APP_VERSION}</span>
          </span>
          {known.map((cam) => (
            <span key={cam.serial} className="datarow">
              <span className="dim">
                {cam.serial}
                {cam.demo ? ' (demo)' : ''}
              </span>
              <span className="val">
                {cam.hardware} · P4 {cam.p4Firmware} · {new Date(cam.lastSeen).toLocaleDateString()}
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
