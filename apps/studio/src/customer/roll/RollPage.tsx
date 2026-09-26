import { useCallback, useEffect, useState } from 'react';
import { KinoUnsupportedError } from '@kino/kdp';
import { getDevice, isSimulated } from '../../app/session';
import { supports, supportsRollUpload, useDeviceStore } from '../../state/deviceStore';
import { putRollLinks, rememberCreatedRoll, rollLinksFor, useRollLinks } from '../../state/rollLinks';
import { getRollServerClient, StubRollServerClient } from '../../roll/RollServerClient';
import { startRoll } from '../../roll/rollOps';
import type { NetworkStatus, RollView, UploadQueueReport } from '../../roll/rollTypes';
import { dayName } from '../copy';
import { ActiveRoll } from './ActiveRoll';
import { joinCodeReady, normaliseJoinCode } from './rollCopy';

const POLL_MS = 4000;

/** What this session knows about a Roll it started that the camera does not report. */
const started = new Map<string, { pin: string | null; downloadsOn: boolean }>();

type Form = 'none' | 'start' | 'join';

/**
 * Roll. No Roll, starting or joining, active. The camera is the truth for
 * whether it is on a Roll; Studio reads it back every four seconds because
 * uploads move on their own.
 */
export function RollPage({ onSetupWifi, onInverted }: { onSetupWifi: () => void; onInverted: (inverted: boolean) => void }) {
  const state = useDeviceStore();
  const supported = supportsRollUpload(state);
  const hasNetwork = supports(state, 'network');
  const hasRoll = supports(state, 'roll');
  const [view, setView] = useState<RollView | null>(state.roll);
  const [queue, setQueue] = useState<UploadQueueReport | null>(state.roll?.queue ?? null);
  const [network, setNetwork] = useState<NetworkStatus | null>(state.network);
  const [form, setForm] = useState<Form>('none');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const linkMap = useRollLinks((s) => s.byRollId);

  const refresh = useCallback(async () => {
    const dev = getDevice();
    if (!dev) return;
    const tolerate = async <T,>(read: () => Promise<T>): Promise<T | null> => {
      try {
        return await read();
      } catch (err) {
        if (err instanceof KinoUnsupportedError) return null;
        throw err;
      }
    };
    try {
      const [v, q, n] = await Promise.all([
        hasRoll ? tolerate(() => dev.rollStatus()) : Promise.resolve(null),
        tolerate(() => dev.uploadQueueStatus()),
        hasNetwork ? tolerate(() => dev.networkStatus()) : Promise.resolve(null),
      ]);
      setView(v);
      setQueue(q);
      setNetwork(n);
    } catch {
      // The status line already says when the link is gone.
    }
  }, [hasRoll, hasNetwork]);

  useEffect(() => {
    if (!supported) return;
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [supported, refresh]);

  const active = view?.active === true && view.roll !== null;
  useEffect(() => {
    onInverted(active);
    return () => onInverted(false);
  }, [active, onInverted]);

  if (!supported) {
    return (
      <section className="c-roll" aria-label="Roll">
        <h1 className="c-40">No Roll on this KINO.</h1>
        <p className="c-quiet" style={{ marginTop: 12 }}>
          This KINO can't send photos to a Roll yet.
        </p>
      </section>
    );
  }

  const withDevice = async (work: (dev: NonNullable<ReturnType<typeof getDevice>>) => Promise<void>) => {
    const dev = getDevice();
    if (!dev) return;
    setBusy(true);
    setNote(null);
    try {
      await work(dev);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setNote(/server|fetch|network|not configured|reach/i.test(text) ? "KINO Roll can't be reached right now. Try again in a minute." : "KINO didn't do that. Try again.");
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const server = getRollServerClient();
  // Guest PIN and downloads are the server's to keep; a camera on its own has neither.
  const serverReal = !(server instanceof StubRollServerClient);
  const allowDeviceOnly = isSimulated() && !serverReal;

  const start = (title: string, pin: string, downloadsOn: boolean) =>
    withDevice(async (dev) => {
      const s = await startRoll(dev, server, { title, pin: pin || undefined, downloadsEnabled: downloadsOn }, { allowDeviceOnly });
      putRollLinks(s.deviceRollId, { guestUrl: s.guestUrl, hostUrl: s.hostUrl, origin: s.deviceOnly ? 'device-only' : 'server' });
      rememberCreatedRoll({ deviceRollId: s.deviceRollId, title, slug: s.slug, guestUrl: s.guestUrl, hostUrl: s.hostUrl, createdAt: new Date().toISOString() });
      if (serverReal) started.set(s.deviceRollId, { pin: pin || null, downloadsOn });
      setForm('none');
    });

  const join = (code: string) =>
    withDevice(async (dev) => {
      setView(await dev.rollJoin(code));
      setForm('none');
    });

  const roll = view?.active === true ? view.roll : null;
  if (roll) {
    const links = rollLinksFor(view, linkMap);
    const known = started.get(roll.rollId) ?? null;
    return (
      <ActiveRoll
        roll={roll}
        queue={queue ?? view?.queue ?? null}
        network={network}
        guestUrl={links.guestUrl ?? roll.guestUrl}
        hostUrl={links.hostUrl}
        downloadsOn={known?.downloadsOn ?? null}
        pin={known?.pin ?? null}
        busy={busy}
        onRetry={() => void withDevice(async (dev) => setQueue((await dev.uploadQueueRetry()).queue))}
        onSetupWifi={onSetupWifi}
        onEnd={() => withDevice(async (dev) => void (await dev.rollLeave()))}
      />
    );
  }

  const noWifi = hasNetwork && network !== null && network.state !== 'connected';

  return (
    <section className="c-roll" aria-label="Roll">
      {form === 'none' ? (
        <>
          <h1 className="c-40">No Roll.</h1>
          <p className="c-quiet" style={{ marginTop: 12 }}>
            A Roll is a shared album for one event. Guests scan a code and the photos arrive there.
          </p>
          {note ? <p className="c-roll-note">{note}</p> : null}
          <div className="c-roll-actions">
            <button type="button" className="c-button" onClick={() => setForm('start')}>
              Start a Roll
            </button>
            <button type="button" className="c-button c-button--outline" onClick={() => setForm('join')}>
              Join a Roll
            </button>
          </div>
          {noWifi ? <p className="c-roll-note">KINO has no Wi-Fi yet. You can start a Roll now and add Wi-Fi when you're at the venue.</p> : null}
        </>
      ) : form === 'start' ? (
        <StartForm busy={busy} note={note} withPin={serverReal} onStart={start} onCancel={() => setForm('none')} />
      ) : (
        <JoinForm busy={busy} note={note} onJoin={join} onCancel={() => setForm('none')} />
      )}
    </section>
  );
}

function StartForm({ busy, note, withPin, onStart, onCancel }: { busy: boolean; note: string | null; withPin: boolean; onStart: (title: string, pin: string, downloadsOn: boolean) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(dayName());
  const [pin, setPin] = useState('');
  const [downloads, setDownloads] = useState(true);
  const pinShort = pin.length > 0 && pin.length < 4;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && title.trim() && !pinShort) void onStart(title.trim().slice(0, 40), pin, downloads);
      }}
    >
      <h1 className="c-40">Start a Roll.</h1>
      <div className="c-roll-form">
        <label>
          <span className="c-field-label">Name</span>
          <input className="c-field" value={title} maxLength={40} disabled={busy} onChange={(e) => setTitle(e.target.value)} />
        </label>
        {withPin ? (
          <>
            <label>
              <span className="c-field-label">Guest PIN, if you want one. Guests type it once.</span>
              <input className="c-field" value={pin} inputMode="numeric" maxLength={12} disabled={busy} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))} />
            </label>
            {pinShort ? <p className="c-13 c-grey">A PIN is at least four digits.</p> : null}
            <div className="c-more-row" role="group" aria-label="Guests can download">
              <span className="c-more-label">Guests can download</span>
              <span className="c-pair">
                <button type="button" className={downloads ? 'c-word c-word--quiet' : 'c-word'} aria-pressed={!downloads} onClick={() => setDownloads(false)}>
                  Off
                </button>
                <span className="c-dot">·</span>
                <button type="button" className={downloads ? 'c-word' : 'c-word c-word--quiet'} aria-pressed={downloads} onClick={() => setDownloads(true)}>
                  On
                </button>
              </span>
            </div>
          </>
        ) : null}
      </div>
      {note ? <p className="c-roll-note">{note}</p> : null}
      {busy ? <p className="c-roll-note">Setting up the Roll…</p> : null}
      <div className="c-roll-actions">
        <button type="submit" className="c-button" disabled={busy || !title.trim() || pinShort}>
          Start
        </button>
        <button type="button" className="c-button c-button--outline" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function JoinForm({ busy, note, onJoin, onCancel }: { busy: boolean; note: string | null; onJoin: (code: string) => Promise<void>; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const ready = joinCodeReady(code);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && ready) void onJoin(code.toLowerCase());
      }}
    >
      <h1 className="c-40">Join a Roll.</h1>
      <div className="c-roll-form">
        <label>
          <span className="c-field-label">The code from the host's screen.</span>
          <input className="c-field c-roll-code-field" value={code} maxLength={48} autoComplete="off" spellCheck={false} disabled={busy} onChange={(e) => setCode(normaliseJoinCode(e.target.value))} />
        </label>
      </div>
      {note ? <p className="c-roll-note">{note}</p> : null}
      <div className="c-roll-actions">
        <button type="submit" className="c-button" disabled={busy || !ready}>
          Join
        </button>
        <button type="button" className="c-button c-button--outline" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
