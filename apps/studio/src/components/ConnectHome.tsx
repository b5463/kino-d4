import { useEffect, useState } from 'react';
import { BroadcastTransport, TWIN_WS_URL, WebSocketTransport } from '@kino/kdp';
import { Button } from './Button';
import { ConnectionNotice } from './ConnectionNotice';
import { canStartConnection, PHASE_LABEL, useConnectionStore } from '../state/connectionStore';
import { connectSerial, connectTwin } from '../app/session';
import { useKnownCameras } from '../state/knownCameras';
import { APP_VERSION } from '../app/App';
import kinoStudio from '../assets/kino-studio.png';

/** How often ConnectHome re-checks for a Twin tab while disconnected (§10 option 2). */
const TWIN_PROBE_INTERVAL_MS = 3000;

/** Where `npm run preview:all` mounts Twin beside Studio on one origin. */
const TWIN_PATH = '/dev/twin/';

/**
 * The same-origin bridge is a BroadcastChannel, so it only reaches a Twin
 * served from this origin. `preview:all` does that and mounts Studio under
 * /studio/; the Vite dev servers give each app its own port instead, where
 * the relay is the only route. Deciding on the mount path keeps the advice
 * on this screen true in both setups.
 */
function twinIsSameOrigin(): boolean {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/studio/');
}

// Disconnected home: one dominant action, honest environment facts below.
export function ConnectHome({ onWorksheet }: { onWorksheet?: (page: 'bringup' | 'bench') => void }) {
  const phase = useConnectionStore((s) => s.phase);
  const error = useConnectionStore((s) => s.error);
  const fault = useConnectionStore((s) => s.fault);
  const serialSupported = useConnectionStore((s) => s.serialSupported);
  const known = useKnownCameras((s) => s.cameras);
  const [twinAvailable, setTwinAvailable] = useState(false);
  const [twinWsAvailable, setTwinWsAvailable] = useState(false);
  // ?twinWs=ws://host:5179 offers a Twin reached over the WebSocket relay
  // (issue #29) — another browser, container, or machine. In a dev build the
  // default relay address is probed without asking: `npm run dev:all` puts
  // Studio and Twin on different ports, where the relay is the only route,
  // and requiring a query string there made the stack look broken.
  const twinWsUrl =
    (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('twinWs') : null) ??
    (import.meta.env.DEV ? TWIN_WS_URL : null);
  const sameOriginTwin = twinIsSameOrigin();

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
    if (!canStartConnection(phase)) return;
    let cancelled = false;
    const check = () => {
      void BroadcastTransport.probe().then((present) => {
        if (!cancelled) setTwinAvailable(present);
      });
      if (twinWsUrl) {
        void WebSocketTransport.probe(twinWsUrl).then((present) => {
          if (!cancelled) setTwinWsAvailable(present);
        });
      }
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
        <img className="connect-mark" src={kinoStudio} alt="KINO Studio" />

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
          {twinAvailable ? (
            <div className="connect-twin">
              <Button disabled={busy} onClick={() => void connectTwin()}>
                CONNECT KINO TWIN
              </Button>
              <p className="connect-twin-hint">Twin tab detected on this origin</p>
            </div>
          ) : null}
          {twinWsUrl && twinWsAvailable ? (
            <div className="connect-twin">
              <Button disabled={busy} onClick={() => void connectTwin(twinWsUrl)}>
                CONNECT KINO TWIN (BRIDGE)
              </Button>
              <p className="connect-twin-hint">Twin answering over {twinWsUrl}</p>
            </div>
          ) : null}
          {onWorksheet ? (
            <>
              <Button variant="ghost" disabled={busy} onClick={() => onWorksheet('bringup')}>
                BRING-UP WORKSHEET (OFFLINE)
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => onWorksheet('bench')}>
                BENCH WORKSHEET (OFFLINE)
              </Button>
            </>
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
            Edge, or connect a KINO Twin.
          </p>
        ) : (
          <p className="connect-note">Plug in over USB-C and pick the port.</p>
        )}

        {/* Studio has no simulator of its own: Twin is it. With no camera and
            no Twin answering, this screen would otherwise be one disabled
            button and no way forward, so say exactly how to get one. The
            same-origin bridge is a BroadcastChannel, which is why the port
            each app runs on decides which of the two routes applies. */}
        {!twinAvailable && !(twinWsUrl && twinWsAvailable) ? (
          <p className="connect-note">
            No KINO Twin is answering. Twin is the simulated camera — it replaces the old built-in
            demo device.
            {sameOriginTwin ? (
              <>
                {' '}
                Open <a href={TWIN_PATH} target="_blank" rel="noreferrer">{TWIN_PATH}</a> in another
                tab and it appears here within a few seconds.
              </>
            ) : (
              <>
                {' '}
                Studio and Twin are on different ports here, so the same-origin bridge cannot reach
                it. Either serve both from one origin with <code>npm run preview:all</code>, or run{' '}
                <code>npm run twin:relay</code> and open Twin with <code>?ws=1</code>.
              </>
            )}
          </p>
        ) : null}

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
                {cam.demo ? ' (simulated)' : ''}
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
