import { useEffect, useState } from 'react';
import { BroadcastTransport } from '@kino/kdp';
import { Button } from './Button';
import { ConnectionNotice } from './ConnectionNotice';
import { canOpenDemo, PHASE_LABEL, useConnectionStore } from '../state/connectionStore';
import { connectDemo, connectSerial, connectTwin } from '../app/session';
import { useKnownCameras } from '../state/knownCameras';
import { APP_VERSION } from '../app/App';

/** How often ConnectHome re-checks for a Twin tab while disconnected (§10 option 2). */
const TWIN_PROBE_INTERVAL_MS = 3000;

// Disconnected home: one dominant action, honest environment facts below.
export function ConnectHome({ onBringup }: { onBringup?: () => void }) {
  const phase = useConnectionStore((s) => s.phase);
  const error = useConnectionStore((s) => s.error);
  const fault = useConnectionStore((s) => s.fault);
  const serialSupported = useConnectionStore((s) => s.serialSupported);
  const known = useKnownCameras((s) => s.cameras);
  const [twinAvailable, setTwinAvailable] = useState(false);

  const busy = phase === 'requesting-port' || phase === 'connecting' || phase === 'handshaking';
  const offlineReady = typeof navigator !== 'undefined' && navigator.serviceWorker?.controller != null;

  // A Twin tab can open or close at any time, so this re-probes on an
  // interval rather than once — the button appears/disappears without a
  // reload. Runs in every settled home-screen state, error and recovery
  // included: a failed serial connect used to stop the probe for good, and
  // a Twin opened afterwards was never offered again (issue #86). Once a
  // connect attempt starts there is nothing new to learn until it lands
  // back here.
  useEffect(() => {
    if (!canOpenDemo(phase)) return;
    let cancelled = false;
    const check = () => {
      void BroadcastTransport.probe().then((present) => {
        if (!cancelled) setTwinAvailable(present);
      });
    };
    check();
    const timer = setInterval(check, TWIN_PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase]);

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
          {twinAvailable ? (
            <div className="connect-twin">
              <Button disabled={busy} onClick={() => void connectTwin()}>
                CONNECT KINO TWIN
              </Button>
              <p className="connect-twin-hint">Twin tab detected on this origin</p>
            </div>
          ) : null}
          {onBringup ? (
            <Button variant="ghost" disabled={busy} onClick={onBringup}>
              BRING-UP WORKSHEET (OFFLINE)
            </Button>
          ) : null}
        </div>

        <div className="connect-status" role="status">
          {/* A fault gets the banner below instead — repeating its one-line
              summary here would say it twice and explain it once. */}
          {busy ? PHASE_LABEL[phase] : fault || phase === 'recovery' ? '' : error ?? ''}
        </div>

        <ConnectionNotice phase={phase} fault={fault} error={error} />

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
