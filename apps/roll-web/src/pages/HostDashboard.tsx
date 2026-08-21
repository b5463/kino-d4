import { useCallback, useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import type { HostApi, HostCaptureView, HostRollEvent, HostRollView } from '../api/hostClient';
import { Button, Panel, StatusLamp, ToolbarFrame } from '@kino/design-system';

export interface HostDashboardProps {
  api: HostApi;
  pollMs?: number;
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="host-stat">
      <div className="host-stat-label">{label}</div>
      <strong className="host-stat-value">{value}</strong>
    </div>
  );
}

function GuestQr({ url }: { url: string }) {
  const [source, setSource] = useState('');
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(url, { width: 220, margin: 1 }).then((value) => {
      if (active) setSource(value);
    });
    return () => {
      active = false;
    };
  }, [url]);
  return source === '' ? null : <img className="host-qr" src={source} width={220} height={220} alt="Guest Roll QR code" />;
}

function posterOf(capture: HostCaptureView): string | null {
  return (
    capture.assets.find((asset) => asset.role === 'thumb')?.assetId ??
    capture.assets.find((asset) => asset.role === 'kino-still')?.assetId ??
    capture.assets.find((asset) => asset.role === 'wiggle-preview')?.assetId ??
    null
  );
}

export function HostDashboard({ api, pollMs = 1_000 }: HostDashboardProps) {
  const [roll, setRoll] = useState<HostRollView | null>(null);
  const [captures, setCaptures] = useState<HostCaptureView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportState, setExportState] = useState<string | null>(null);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [pin, setPin] = useState('');

  const refreshCaptures = useCallback(
    async (rollId: string): Promise<void> => {
      const all: HostCaptureView[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.listCaptures(rollId, cursor);
        all.push(...page.items);
        cursor = page.hasMore ? page.nextCursor : undefined;
      } while (cursor !== undefined);
      setCaptures(all);
    },
    [api],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const next = await api.resolveSession();
    setRoll(next);
    setTitle(next.title);
    await refreshCaptures(next.rollId);
  }, [api, refreshCaptures]);

  useEffect(() => {
    void refresh().catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, [refresh]);

  useEffect(() => {
    if (roll === null) return;
    const reconcile = (_event: HostRollEvent): void => {
      void Promise.all([api.getRoll(roll.rollId).then(setRoll), refreshCaptures(roll.rollId)]).catch(
        () => {},
      );
    };
    return api.events(roll.rollId, reconcile);
  }, [api, refreshCaptures, roll?.rollId]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const update = async (
    patch: Parameters<HostApi['updateRoll']>[1],
  ): Promise<HostRollView | null> => {
    if (roll === null) return null;
    const next = await api.updateRoll(roll.rollId, patch);
    setRoll(next);
    setTitle(next.title);
    return next;
  };

  const moderate = async (
    captureId: string,
    action: 'hide' | 'unhide' | 'delete',
  ): Promise<void> => {
    const previous = captures;
    setCaptures((items) =>
      items.map((item) =>
        item.captureId !== captureId
          ? item
          : action === 'delete'
            ? { ...item, deletedAt: new Date().toISOString(), visible: false }
            : { ...item, visible: action === 'unhide' },
      ),
    );
    try {
      const result =
        action === 'hide'
          ? await api.hide(captureId)
          : action === 'unhide'
            ? await api.unhide(captureId)
            : await api.deleteCapture(captureId);
      setCaptures((items) =>
        items.map((item) => (item.captureId === captureId ? { ...item, ...result } : item)),
      );
    } catch (caught) {
      setCaptures(previous);
      throw caught;
    }
  };

  const startExport = async (): Promise<void> => {
    if (roll === null) return;
    setExportUrl(null);
    setExportState('Starting export…');
    const { jobId } = await api.startExport(roll.rollId);
    for (;;) {
      const current = await api.getExport(roll.rollId, jobId);
      setExportState(`Export ${current.status}`);
      if (current.url !== undefined) {
        setExportUrl(current.url);
        return;
      }
      if (current.status === 'failed') throw new Error('The export failed. Try again.');
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };

  if (roll === null) {
    return (
      <main className="roll-shell">
        <h1>Host dashboard</h1>
        <p>{error ?? 'Loading Roll…'}</p>
      </main>
    );
  }

  return (
    <main className="roll-shell">
      <header className="roll-head">
        <div>
          <div className="roll-brand">KINO ROLL · HOST</div>
          <h1>{roll.title}</h1>
          <div className="roll-subhead">{roll.deviceSerial ?? 'WEB CREATED'}</div>
        </div>
        <ToolbarFrame aria-label="Roll status controls">
          <StatusLamp state={roll.status === 'live' ? 'ok' : 'off'} label={roll.status.toUpperCase()} />
          <Button
            disabled={busy || roll.status === 'archived'}
            onClick={() => void run(async () => void (await update({ status: roll.status === 'live' ? 'closed' : 'live' })))}
          >
            {roll.status === 'live' ? 'Close Roll' : 'Reopen Roll'}
          </Button>
        </ToolbarFrame>
      </header>

      {error !== null ? <p className="roll-alert" role="alert">{error}</p> : null}

      <section aria-label="Roll totals" className="host-stats">
        <Stat label="CAPTURES" value={roll.counts.captures} />
        <Stat label="GUESTS" value={roll.guests} />
        <Stat label="PENDING" value={roll.counts.pending} />
        <Stat label="HIDDEN" value={roll.counts.hidden} />
      </section>

      <section className="host-settings">
        <Panel title="Guest link">
          <GuestQr url={roll.guestUrl} />
          <p><a href={roll.guestUrl}>{roll.guestUrl}</a></p>
          <Button
            disabled={busy}
            onClick={() => void run(async () => {
              if (!window.confirm('Regenerate guest link? Old links stop working.')) return;
              const rotated = await api.regenerateSlug(roll.rollId);
              setRoll({ ...roll, slug: rotated.slug, guestUrl: rotated.guestUrl });
            })}
          >Regenerate guest link</Button>
        </Panel>

        <Panel title="Roll settings">
          <form onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void run(async () => void (await update({ title })));
          }}>
            <label htmlFor="host-title">Title</label><br />
            <input id="host-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
            <Button type="submit" disabled={busy || title.trim() === ''}>Rename</Button>
          </form>
          <p>
            <label><input type="checkbox" checked={roll.downloadsEnabled} onChange={(event) => void run(async () => void (await update({ downloadsEnabled: event.target.checked })))} /> Guest downloads</label>
          </p>
          <form onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void run(async () => {
              await update({ pin });
              setPin('');
            });
          }}>
            <label htmlFor="host-pin">{roll.hasPin ? 'Replace PIN' : 'Set PIN'}</label><br />
            <input id="host-pin" type="password" inputMode="numeric" autoComplete="new-password" value={pin} minLength={4} onChange={(event) => setPin(event.target.value)} />
            <Button type="submit" disabled={busy || pin.length < 4}>Save PIN</Button>
            {roll.hasPin ? <Button disabled={busy} onClick={() => void run(async () => void (await update({ pin: null })))}>Remove PIN</Button> : null}
          </form>
        </Panel>

        <Panel title="Download all">
          <Button disabled={busy} onClick={() => void run(startExport)}>Prepare ZIP</Button>
          {exportState !== null ? <p role="status" aria-live="polite" aria-atomic="true">{exportState}</p> : null}
          {exportUrl !== null ? <a className="roll-action" href={exportUrl}>Download ZIP</a> : null}
        </Panel>
      </section>

      <Panel title="Moderation">
        {captures.length === 0 ? <p>No captures yet.</p> : null}
        <div className="host-captures">
          {captures.map((capture) => {
            const poster = posterOf(capture);
            const deleted = capture.deletedAt !== null;
            return (
              <article key={capture.captureId} data-capture-id={capture.captureId} data-muted={!capture.visible || deleted} className="host-capture">
                {poster === null || !capture.visible || deleted ? <div className="host-capture-placeholder">{deleted ? 'In trash' : capture.visible ? 'Processing' : 'Hidden'}</div> : <img className="roll-media" src={api.assetUrl(poster)} alt="" loading="lazy" />}
                <div className="host-capture-meta"><strong>{capture.mode}</strong> · {new Date(capture.capturedAt).toLocaleTimeString()}</div>
                {!capture.visible ? <span>HIDDEN</span> : null}
                {deleted ? <span> · TRASHED</span> : null}
                {!deleted ? (
                  <ToolbarFrame aria-label={`Moderate ${capture.mode} capture`}>
                    <Button size="sm" onClick={() => void run(() => moderate(capture.captureId, capture.visible ? 'hide' : 'unhide'))}>{capture.visible ? 'Hide' : 'Unhide'}</Button>
                    <Button size="sm" variant="danger" onClick={() => void run(() => moderate(capture.captureId, 'delete'))}>Delete</Button>
                  </ToolbarFrame>
                ) : null}
              </article>
            );
          })}
        </div>
      </Panel>
    </main>
  );
}
