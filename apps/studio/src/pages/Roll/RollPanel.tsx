import { useEffect, useId, useRef, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Led } from '../../components/Led';
import { FieldRow, ToggleField } from '../../components/fields';
import type { RollView } from '../../roll/rollTypes';
import type { StartRollOptions } from '../../roll/rollOps';
import type { RollLinkOrigin } from '../../state/rollLinks';

/**
 * Roll lifecycle (02 §17, terminology per 01 §10). The camera is the source of
 * truth for whether it is on a Roll; the public URLs come from whoever created
 * it (the Roll server, or the camera itself on the demo path).
 */

/**
 * Guest QR for the Roll's public URL.
 *
 * The code is painted into a canvas by `qrcode`, imported on demand so the
 * encoder is only pulled in when a Roll is actually live. The URL is printed
 * underneath as text as well: a QR nobody can read out loud is useless over a
 * phone, and a static render (no canvas, no effects) still shows the address.
 */
export function GuestQr({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    void import('qrcode')
      .then(({ default: QRCode }) => {
        if (cancelled) return;
        return QRCode.toCanvas(canvas, url, { width: 176, margin: 1 });
      })
      .then(() => {
        if (!cancelled) setFailed(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setFailed(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="rollqr">
      <canvas ref={canvasRef} width={176} height={176} role="img" aria-label={`Guest QR code for ${url}`} />
      <code className="rollqr-url">{url}</code>
      {failed ? <p className="field-hint field-hint--warn">QR could not be drawn: {failed}</p> : null}
    </div>
  );
}

function StartForm({
  busy,
  onStart,
}: {
  busy: boolean;
  onStart: (opts: StartRollOptions) => Promise<void>;
}) {
  const titleId = useId();
  const pinId = useId();
  const [title, setTitle] = useState('');
  const [pin, setPin] = useState('');
  const [downloadsEnabled, setDownloadsEnabled] = useState(true);

  const canStart = title.trim().length > 0 && !busy;

  const submit = () => {
    if (!canStart) return;
    void onStart({ title: title.trim(), pin: pin.trim() || undefined, downloadsEnabled });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <FieldRow label="ROLL NAME" htmlFor={titleId}>
        <input
          id={titleId}
          type="text"
          className="input"
          value={title}
          maxLength={60}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
        />
      </FieldRow>
      <FieldRow label="GUEST PIN" htmlFor={pinId} hint="Optional. Guests type it once to open the Roll.">
        <input
          id={pinId}
          type="text"
          className="input"
          value={pin}
          maxLength={12}
          inputMode="numeric"
          disabled={busy}
          onChange={(e) => setPin(e.target.value)}
        />
      </FieldRow>
      <ToggleField
        label="GUEST DOWNLOADS"
        checked={downloadsEnabled}
        disabled={busy}
        onChange={setDownloadsEnabled}
      />
      <div className="panel-actions">
        <Button type="submit" variant="primary" busy={busy} disabled={title.trim().length === 0}>
          Start a Roll
        </Button>
      </div>
    </form>
  );
}

function JoinForm({ busy, onJoin }: { busy: boolean; onJoin: (slug: string) => Promise<void> }) {
  const slugId = useId();
  const [slug, setSlug] = useState('');

  const canJoin = slug.trim().length >= 3 && !busy;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canJoin) void onJoin(slug.trim().toLowerCase());
      }}
    >
      <FieldRow label="ROLL CODE" htmlFor={slugId} hint="The code the host read out, e.g. amber-001.">
        <input
          id={slugId}
          type="text"
          className="input"
          value={slug}
          maxLength={48}
          autoCapitalize="none"
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setSlug(e.target.value)}
        />
      </FieldRow>
      <div className="panel-actions">
        <Button type="submit" busy={busy} disabled={slug.trim().length < 3}>
          Join a Roll
        </Button>
      </div>
    </form>
  );
}

export function RollPanel({
  view,
  guestUrl,
  hostUrl,
  origin,
  busy,
  error,
  onStart,
  onJoin,
  onLeave,
}: {
  view: RollView | null;
  /** Public URL for guests — the server's if it published one, else the camera's. */
  guestUrl: string | null;
  /** Host dashboard, only when a Roll server created the Roll. */
  hostUrl: string | null;
  /** Whether the absence of a host dashboard is a fact or just unknown here. */
  origin: RollLinkOrigin;
  busy: boolean;
  error: string | null;
  onStart: (opts: StartRollOptions) => Promise<void>;
  onJoin: (slug: string) => Promise<void>;
  onLeave: () => Promise<void>;
}) {
  const roll = view?.roll ?? null;
  const active = view?.active === true && roll !== null;
  const shownGuestUrl = guestUrl ?? roll?.guestUrl ?? null;

  return (
    <Panel
      title="ROLL"
      actions={active ? <Led state="ok" label="ON A ROLL" /> : <Led state="off" label="NO ROLL" />}
    >
      {error ? <p className="notice notice--err">{error}</p> : null}

      {active && roll ? (
        <>
          <dl>
            <div className="datarow">
              <dt>Roll</dt>
              <dd>{roll.name}</dd>
            </div>
            <div className="datarow">
              <dt>Code</dt>
              <dd>{roll.slug}</dd>
            </div>
            <div className="datarow">
              <dt>Role</dt>
              <dd>{roll.role === 'host' ? 'HOST' : 'GUEST'}</dd>
            </div>
          </dl>
          {shownGuestUrl ? <GuestQr url={shownGuestUrl} /> : null}
          <div className="panel-actions">
            {hostUrl ? (
              <a className="btn" href={hostUrl} target="_blank" rel="noreferrer noopener">
                OPEN HOST DASHBOARD
              </a>
            ) : origin === 'device-only' ? (
              <span className="field-hint">
                No host dashboard — this Roll exists on the camera only.
              </span>
            ) : (
              // The camera is on a Roll this Studio session did not create. It
              // may well be published; claiming otherwise would be a guess.
              <span className="field-hint">Host link not available in this session.</span>
            )}
            <Button variant="danger" busy={busy} onClick={() => void onLeave()}>
              Leave Roll
            </Button>
          </div>
        </>
      ) : (
        <>
          <StartForm busy={busy} onStart={onStart} />
          <hr className="roll-sep" />
          <JoinForm busy={busy} onJoin={onJoin} />
        </>
      )}
    </Panel>
  );
}
