import { useEffect, useId, useRef, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Led } from '../../components/Led';
import { FieldRow, ToggleField } from '../../components/fields';
import type { RollView } from '../../roll/rollTypes';
import type { StartRollOptions } from '../../roll/rollOps';
import type { CreatedRoll, RollLinkOrigin } from '../../state/rollLinks';

/**
 * Copy a host link to the clipboard.
 *
 * The Roll server mints the host token once and cannot re-issue it. Studio is
 * the machine that saw it first, so it is the machine that can hand the
 * operator a second copy — before the dashboard tab that holds the only other
 * one is closed.
 */
function CopyLink({ url, label = 'COPY HOST LINK' }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      onClick={() => {
        void navigator.clipboard
          .writeText(url)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {copied ? 'COPIED' : label}
    </Button>
  );
}

/** Every Roll this machine started, with the host link that came back. */
function CreatedRolls({
  rolls,
  onForget,
}: {
  rolls: CreatedRoll[];
  onForget?: (deviceRollId: string) => void;
}) {
  if (rolls.length === 0) return null;
  return (
    <details className="rolls-created">
      <summary>Rolls started on this machine ({rolls.length})</summary>
      <p className="field-hint">
        The host link cannot be re-issued. This list is the spare copy — it is kept in this browser
        only, and anyone with the link is the host.
      </p>
      <ul className="rolls-created-list">
        {rolls.map((roll) => (
          <li key={roll.deviceRollId}>
            <div className="rolls-created-head">
              <strong>{roll.title}</strong> <code>{roll.slug}</code>
            </div>
            <div className="rolls-created-actions">
              {roll.hostUrl ? (
                <>
                  <a className="btn btn--sm" href={roll.hostUrl} target="_blank" rel="noreferrer noopener">
                    OPEN
                  </a>
                  <CopyLink url={roll.hostUrl} />
                </>
              ) : (
                <span className="field-hint">Camera-only Roll — no host dashboard.</span>
              )}
              {onForget ? (
                <Button size="sm" variant="danger" onClick={() => onForget(roll.deviceRollId)}>
                  FORGET
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

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

  const pinTooShort = pin.length > 0 && pin.length < 4;
  const canStart = title.trim().length > 0 && !pinTooShort && !busy;

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
      {/* The server rejects a PIN shorter than four with a 400, so a 1-3
          character PIN was a form that looked accepted and then failed. */}
      <FieldRow
        label="GUEST PIN"
        htmlFor={pinId}
        hint="Optional. At least 4 digits. Guests type it once to open the Roll."
      >
        <input
          id={pinId}
          type="text"
          className="input"
          value={pin}
          minLength={4}
          maxLength={12}
          inputMode="numeric"
          pattern="[0-9]{4,12}"
          disabled={busy}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
        />
      </FieldRow>
      {pinTooShort ? (
        <p className="field-hint field-hint--warn">A PIN must be at least 4 digits, or empty.</p>
      ) : null}
      <ToggleField
        label="GUEST DOWNLOADS"
        checked={downloadsEnabled}
        disabled={busy}
        onChange={setDownloadsEnabled}
      />
      <div className="panel-actions">
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          disabled={title.trim().length === 0 || pinTooShort}
        >
          Start a Roll
        </Button>
      </div>
    </form>
  );
}

/**
 * Roll codes.
 *
 * Six characters from a Crockford-style alphabet with the look-alikes taken
 * out — no 0/O, no 1/I/L, no U. The field used to hint "e.g. amber-001" and
 * lowercase what was typed before sending it, so it advertised a shape that
 * does not exist and then mangled the shape that does.
 */
export const ROLL_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROLL_CODE_LENGTH = 6;

/** What the host actually read out, whatever the thumbs did to it. */
export function normaliseRollCode(raw: string): string {
  return [...raw.toUpperCase()]
    .filter((character) => ROLL_CODE_ALPHABET.includes(character))
    .join('')
    .slice(0, ROLL_CODE_LENGTH);
}

function JoinForm({ busy, onJoin }: { busy: boolean; onJoin: (slug: string) => Promise<void> }) {
  const slugId = useId();
  const [slug, setSlug] = useState('');

  const canJoin = slug.length === ROLL_CODE_LENGTH && !busy;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canJoin) void onJoin(slug);
      }}
    >
      <FieldRow
        label="ROLL CODE"
        htmlFor={slugId}
        hint="Six characters from the host's screen, e.g. NXVJHK. No O, I, L, U, 0 or 1."
      >
        <input
          id={slugId}
          type="text"
          className="input rollcode"
          value={slug}
          maxLength={ROLL_CODE_LENGTH}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setSlug(normaliseRollCode(e.target.value))}
        />
      </FieldRow>
      <div className="panel-actions">
        <Button type="submit" busy={busy} disabled={slug.length !== ROLL_CODE_LENGTH}>
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
  createdRolls = [],
  onForgetRoll,
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
  /** Rolls this machine started, kept as the operator's spare host links. */
  createdRolls?: CreatedRoll[];
  onForgetRoll?: (deviceRollId: string) => void;
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
              <>
                <a className="btn" href={hostUrl} target="_blank" rel="noreferrer noopener">
                  OPEN HOST DASHBOARD
                </a>
                {/* Copy it now: the dashboard strips the token from the URL on
                    arrival and the server will not mint a second one. */}
                <CopyLink url={hostUrl} />
              </>
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
          <CreatedRolls rolls={createdRolls} onForget={onForgetRoll} />
        </>
      ) : (
        <>
          <StartForm busy={busy} onStart={onStart} />
          <hr className="roll-sep" />
          <JoinForm busy={busy} onJoin={onJoin} />
          <CreatedRolls rolls={createdRolls} onForget={onForgetRoll} />
        </>
      )}
    </Panel>
  );
}
