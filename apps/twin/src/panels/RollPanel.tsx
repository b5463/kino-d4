// KINO Roll development bridge panel (issue #75). The physical Milestone 1
// firmware has no Wi-Fi or Roll upload — this panel drives the Twin-side
// stand-in for that future firmware task, over the real Roll API and the
// real device wire contract. Nothing here changes what the virtual device
// claims over KDP: rollUpload stays false on the current-firmware profile.
import { useEffect, useState } from 'react';
import { useSimStore } from '../state/simStore';
import {
  createRoll,
  joinRoll,
  leaveRoll,
  retryUploads,
  sendTestFrame,
  setServerUrl,
  useRollBridge,
} from '../roll/bridge';
import { rollQrCanvas } from '../roll/qr';

export function RollPanel() {
  const running = useSimStore((s) => s.running);
  const bootStage = useSimStore((s) => s.bootStage);
  const snapshot = useSimStore((s) => s.snapshot);
  const bridge = useRollBridge();
  const [title, setTitle] = useState('Twin party');
  const [slug, setSlug] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const guestUrl = bridge.roll?.guestUrl ?? null;
  useEffect(() => {
    if (!guestUrl) {
      setQrDataUrl(null);
      return;
    }
    // The display cache renders asynchronously; poll it until the canvas lands.
    const timer = setInterval(() => {
      const canvas = rollQrCanvas(guestUrl);
      if (canvas) {
        setQrDataUrl(canvas.toDataURL());
        clearInterval(timer);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [guestUrl]);

  async function act(run: () => Promise<void>): Promise<void> {
    setActionError(null);
    try {
      await run();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  const m1b = snapshot?.firmwareProfile === 'd4-m1b';
  const ready = running && bootStage === 'READY';

  return (
    <section className="twin-tool-panel" aria-label="Roll">
      <div className="twin-panel-heading"><span>ROLL</span><span>DEV BRIDGE</span></div>

      <p className="twin-panel-note">
        Development bridge: uploads virtual captures to a real KINO Roll over the device wire contract.
        The physical Milestone 1 firmware has no Roll upload — this stands in for that future milestone
        (docs/roll/ROLL_DEVICE_CONTRACT.md).
      </p>

      <div className="twin-panel-section">
        <span className="twin-field-label">SERVER</span>
        <div className="twin-control-row">
          <input
            className="twin-numeric twin-numeric--wide"
            value={bridge.serverUrl}
            placeholder="same origin (/api via dev proxy)"
            onChange={(e) => setServerUrl(e.target.value)}
            aria-label="Roll server URL"
          />
        </div>
        <div className="twin-control-row">
          <span>API</span>
          <span>{bridge.online ? 'REACHABLE' : 'UNREACHABLE — RETRYING'}</span>
        </div>
      </div>

      {bridge.roll ? (
        <div className="twin-panel-section">
          <span className="twin-field-label">ROLL {bridge.roll.slug}</span>
          <div className="twin-control-row"><span>TITLE</span><span>{bridge.roll.title}</span></div>
          {qrDataUrl ? (
            <img src={qrDataUrl} className="twin-roll-qr" alt={`QR for ${bridge.roll.guestUrl}`} />
          ) : null}
          <div className="twin-control-row">
            {bridge.roll.guestUrl ? (
              <a href={bridge.roll.guestUrl} target="_blank" rel="noreferrer">OPEN GUEST ROLL</a>
            ) : (
              <span>NO GUEST LINK REPORTED</span>
            )}
            {bridge.roll.hostUrl ? <a href={bridge.roll.hostUrl} target="_blank" rel="noreferrer">HOST</a> : null}
          </div>
          <div className="twin-button-grid">
            <button type="button" className="twin-btn" onClick={leaveRoll}>LEAVE ROLL</button>
            <button
              type="button"
              className="twin-btn"
              disabled={!ready}
              title={
                m1b
                  ? 'Milestone 1 path: one CAM1 frame, uploaded as a single still — no fake Wiggle'
                  : 'One CAM1 frame uploaded as a single still (group captures upload automatically)'
              }
              onClick={() => void act(sendTestFrame)}
            >
              SEND TEST FRAME
            </button>
          </div>
          <p className="twin-panel-note">
            {m1b
              ? 'Current firmware: single-camera development ingest only. Group captures need the SIMULATED FUTURE profile.'
              : 'SHUTTER captures upload automatically: thumb first, then all four frames, then complete.'}
          </p>
        </div>
      ) : (
        <div className="twin-panel-section">
          <span className="twin-field-label">CREATE</span>
          <div className="twin-control-row">
            <input className="twin-numeric twin-numeric--wide" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Roll title" />
            <button type="button" className="twin-btn" disabled={bridge.busy || title.trim() === ''} onClick={() => void act(() => createRoll(title.trim()))}>
              CREATE ROLL
            </button>
          </div>
          <span className="twin-field-label">OR JOIN</span>
          <div className="twin-control-row">
            <input className="twin-numeric twin-numeric--wide" value={slug} placeholder="slug, e.g. AMBER-042" onChange={(e) => setSlug(e.target.value)} aria-label="Roll slug" />
            <button type="button" className="twin-btn" disabled={bridge.busy || slug.trim() === ''} onClick={() => void act(() => joinRoll(slug.trim()))}>
              JOIN
            </button>
          </div>
        </div>
      )}

      <div className="twin-panel-section">
        <span className="twin-field-label">UPLOAD QUEUE</span>
        <div className="twin-control-row"><span>QUEUED</span><span>{bridge.queued}</span></div>
        <div className="twin-control-row"><span>RETRYING</span><span>{bridge.failed}</span></div>
        <div className="twin-control-row"><span>UPLOADED</span><span>{bridge.uploaded}</span></div>
        {bridge.failed > 0 ? (
          <button type="button" className="twin-btn" onClick={retryUploads}>RETRY NOW</button>
        ) : null}
        {(actionError ?? bridge.lastError) ? (
          <p className="twin-panel-note twin-panel-note--error">{actionError ?? bridge.lastError}</p>
        ) : null}
        <p className="twin-panel-note">
          Stopping the Roll server never blocks the shutter — captures queue and resume when it returns,
          without duplicates (capture UUID + asset role).
        </p>
      </div>
    </section>
  );
}
