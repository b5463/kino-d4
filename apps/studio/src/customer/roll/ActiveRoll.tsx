import { useEffect, useRef, useState } from 'react';
import type { NetworkStatus, RollInfo, UploadQueueReport } from '../../roll/rollTypes';
import { ConfirmSheet } from '../Dialog';
import { clock, withThousands } from '../copy';
import { codeSizePx, uploadDetail } from './rollCopy';

/**
 * Active Roll: the one inverted page. It is shown to a room, often a dark
 * one, so the QR sits on a paper tile on ink with the code under it, and
 * the host's facts (the count, the upload state, the PIN if there is one)
 * sit beside it.
 */
export function ActiveRoll({
  roll,
  queue,
  network,
  guestUrl,
  hostUrl,
  downloadsOn,
  pin,
  busy,
  onRetry,
  onSetupWifi,
  onEnd,
}: {
  roll: RollInfo;
  queue: UploadQueueReport | null;
  network: NetworkStatus | null;
  guestUrl: string;
  hostUrl: string | null;
  /** Null when this session does not know (a Roll it did not start). */
  downloadsOn: boolean | null;
  pin: string | null;
  busy: boolean;
  onRetry: () => void;
  onSetupWifi: () => void;
  onEnd: () => Promise<void>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const count = queue?.uploaded ?? 0;
  const [settling, setSettling] = useState(false);
  const lastCount = useRef(count);

  // Settle on the count: the new number drops 4 px into place.
  useEffect(() => {
    if (lastCount.current === count) return;
    lastCount.current = count;
    setSettling(true);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)));
    return () => cancelAnimationFrame(raf);
  }, [count]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    void import('qrcode').then(({ default: QRCode }) => {
      if (cancelled) return;
      return QRCode.toCanvas(canvas, guestUrl, { width: 440, margin: 0, color: { dark: '#191816', light: '#f4f2ec' } });
    });
    return () => {
      cancelled = true;
    };
  }, [guestUrl]);

  const detail = uploadDetail(queue, network);
  const link = hostUrl ?? guestUrl;

  return (
    <section className="c-active" aria-label="Roll">
      <h1 className="c-active-name">{roll.name}</h1>
      <p className="c-active-started">Started {clock(roll.joinedAt)}</p>

      <div className="c-active-left">
        <p className="c-active-scan">Scan to join</p>
        <div className="c-active-tile">
          <canvas ref={canvasRef} width={440} height={440} role="img" aria-label={`Scan to join ${roll.name}`} />
        </div>
        <p className="c-active-code" style={{ '--code-size': `${codeSizePx(roll.slug)}px` } as React.CSSProperties} aria-label={`Roll code ${roll.slug.split('').join(' ')}`}>
          {roll.slug}
        </p>
        <p className="c-active-code-hint">or type this code</p>
      </div>

      <div className="c-active-right">
        <p className="c-active-count" role="status" aria-live="polite">
          <span className={`c-count${settling ? ' is-settling' : ''}`}>{withThousands(count)}</span> {count === 1 ? 'photo' : 'photos'} in the Roll.
        </p>
        <p className="c-active-detail">
          {detail.text}
          {detail.action === 'retry' ? (
            <button type="button" disabled={busy} onClick={onRetry}>
              Try again
            </button>
          ) : null}
          {detail.action === 'wifi' ? (
            <button type="button" onClick={onSetupWifi}>
              Set up Wi-Fi
            </button>
          ) : null}
        </p>
        <div className="c-active-access">
          {pin !== null || downloadsOn !== null ? (
            <p>
              {pin ? `Guest PIN ${pin}` : 'No guest PIN'}
              {downloadsOn !== null ? ` · Downloads ${downloadsOn ? 'on' : 'off'}` : ''}
            </p>
          ) : null}
          <p>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(link)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </p>
        </div>
        <div className="c-active-end">
          <button type="button" className="c-button c-button--outline" disabled={busy} onClick={() => setConfirm(true)}>
            End Roll
          </button>
        </div>
      </div>

      <ConfirmSheet
        open={confirm}
        confirmLabel="End Roll"
        warning
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          void onEnd();
        }}
      >
        <p>End this Roll? Guests keep what's there. KINO stops sending new photos to it.</p>
      </ConfirmSheet>
    </section>
  );
}
