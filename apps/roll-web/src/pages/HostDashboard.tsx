import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  HostApi,
  HostCaptureView,
  HostExportEstimate,
  HostRollEvent,
  HostRollView,
} from '../api/hostClient';
import { saveBlob } from '../api/hostClient';
import { ApiError } from '../api/client';
import { Button, Panel, StatusLamp, ToolbarFrame } from '@kino/design-system';
import kinoRoll from '../assets/kino-roll-dark.png';
import { CameraPanel } from '../components/host/CameraPanel';
import { CaptureGrid, type CaptureFilter } from '../components/host/CaptureGrid';
import { StatusStrip } from '../components/host/StatusStrip';
import { CopyHostLink, HostAccessPanel, HostLinkWarning } from '../components/host/HostLink';
import { QrCard } from '../components/host/QrCard';
import '../host.css';

export interface HostDashboardProps {
  api: HostApi;
  pollMs?: number;
  /** The token this dashboard is holding, for rebuilding the host link. */
  token?: string;
  remembered?: boolean;
  onRemember?: (remember: boolean) => void;
  /** Forget the token on this device and go back to the paste form. */
  onSignOut?: () => void;
}

/** How long the trash keeps a capture before the purge. Said out loud, in words. */
export const TRASH_GRACE = '7 days';

/** "≈17 GB" — an estimate, printed as one. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  const step = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3));
  const value = bytes / 1000 ** step;
  return `${value >= 100 || step === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[step] ?? 'B'}`;
}

/**
 * Export job states, in words.
 *
 * The panel printed the raw enum — "Export queued", "Export running" — which
 * is the worker's vocabulary, not a host's.
 */
export function exportWording(status: string): string {
  switch (status) {
    case 'queued':
    case 'pending':
      return 'Queued. The server is getting to it.';
    case 'running':
    case 'processing':
      return 'Building the ZIP. You can leave this page open.';
    case 'done':
    case 'ready':
    case 'completed':
      return 'Ready.';
    case 'failed':
      return 'The export failed. Prepare it again.';
    default:
      return `Export: ${status}`;
  }
}

/**
 * How long a queued export has been queued, in words.
 *
 * Not decoration. The export is handed to a worker over BullMQ, and a
 * deployment whose worker is down (measured on the dev API: a job sat at
 * `queued` for the whole session) leaves this panel saying "Queued. The server
 * is getting to it." for ever. The host is entitled to know that "for ever"
 * has so far been four minutes, and to stop watching.
 */
export function waitedFor(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  // No-break spaces: the line lives in a flex box that wraps, and a plain
  // space let it break between the figure and its unit — "Waiting 0" then "s."
  // on the next line, seen on the dev API at 1440px.
  if (seconds < 60) return `${String(seconds)}\u00a0s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}\u00a0min`;
  return `${String(Math.floor(minutes / 60))}\u00a0h ${String(minutes % 60)}\u00a0min`;
}

/**
 * How long a wait has to be before saying it is worth the words.
 *
 * "Waiting 0 s." next to "Queued. The server is getting to it." is the page
 * talking for the sake of it. The number exists to tell a host that a queued
 * export has been queued for four minutes and the worker is probably down, and
 * it only starts being that after a few seconds.
 */
export const EXPORT_WAIT_FLOOR_MS = 5_000;

/**
 * How long the panel keeps asking about one export before it stops.
 *
 * Ten minutes. A ZIP of a party roll is minutes of work, so this is not a
 * timeout on the job — the job is on the server and unaffected — it is a bound
 * on this page hammering the API once a second for ever about a job whose
 * worker is not running.
 */
export const EXPORT_POLL_LIMIT_MS = 10 * 60_000;

/** A destructive action that asks first, in the panel, with no browser dialog. */
function Confirm({
  open,
  title,
  body,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
  onOpen,
  openLabel,
  openDisabled,
  variant = 'danger',
  size,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onOpen: () => void;
  openLabel: string;
  openDisabled?: boolean;
  variant?: 'danger' | 'default';
  size?: 'sm';
}) {
  if (!open) {
    return (
      <Button variant={variant} size={size} disabled={openDisabled === true || busy} onClick={onOpen}>
        {openLabel}
      </Button>
    );
  }
  return (
    <div className="host-confirm" role="group" aria-label={title}>
      <p>{body}</p>
      <ToolbarFrame aria-label={title}>
        <Button variant="danger-solid" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </ToolbarFrame>
    </div>
  );
}

export function HostDashboard({
  api,
  pollMs = 1_000,
  token,
  remembered = false,
  onRemember,
  onSignOut,
}: HostDashboardProps) {
  const [roll, setRoll] = useState<HostRollView | null>(null);
  const [captures, setCaptures] = useState<HostCaptureView[]>([]);
  /** Keyset cursor for the page after the last one loaded; null means the end. */
  const [capturesCursor, setCapturesCursor] = useState<string | null>(null);
  const loadingMoreRef = useRef(false);
  /**
   * Whether this dashboard is still on screen.
   *
   * The export poller is an unbounded loop with a sleep in it, so it is the
   * one thing here that can outlive the tree it sets state on.
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportState, setExportState] = useState<string | null>(null);
  const [exportSince, setExportSince] = useState<number | null>(null);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [estimate, setEstimate] = useState<HostExportEstimate | null>(null);
  const [title, setTitle] = useState('');
  const [pin, setPin] = useState('');
  const [filter, setFilter] = useState<CaptureFilter>('all');
  // The capture the last Delete click trashed, which gets the Undo wording.
  const [undoFor, setUndoFor] = useState<string | null>(null);
  const [trashNote, setTrashNote] = useState<string | null>(null);
  // Clear roll: the confirm is open, what the host has typed, and the answer.
  const [clearing, setClearing] = useState(false);
  const [clearCode, setClearCode] = useState('');
  const [clearResult, setClearResult] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [rotating, setRotating] = useState(false);
  /**
   * The setup section, once the host has opened or shut it by hand.
   *
   * Null means "nobody has said", and the default below decides: open on a
   * roll with nothing on it, because that host is setting up; shut once there
   * are photographs, because that host is working. Sticky afterwards — a
   * section that reshuts itself the moment the first capture lands would be a
   * section that closes under the hand holding it.
   */
  const [setupOpen, setSetupOpen] = useState<boolean | null>(null);

  /**
   * The first page of captures, and only the first page.
   *
   * This used to walk the whole roll before the panel painted: 1,900 captures
   * is thirty-eight sequential requests, and it ran again from the top on
   * `roll.cleared`. A host opening the dashboard to hide one photograph waited
   * for all of it. The grid is virtualised anyway, so the pages after the
   * first are worth exactly as much as the rows on screen — `loadMoreCaptures`
   * fetches them as the host scrolls.
   */
  const refreshCaptures = useCallback(
    async (rollId: string): Promise<void> => {
      const page = await api.listCaptures(rollId);
      setCaptures(page.items);
      setCapturesCursor(page.hasMore ? (page.nextCursor ?? null) : null);
    },
    [api],
  );

  const loadMoreCaptures = useCallback((): void => {
    const rollId = roll?.rollId;
    const cursor = capturesCursor;
    if (rollId === undefined || cursor === null || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    void api
      .listCaptures(rollId, cursor)
      .then((page) => {
        setCaptures((items) => {
          const known = new Set(items.map((item) => item.captureId));
          return [...items, ...page.items.filter((item) => !known.has(item.captureId))];
        });
        setCapturesCursor(page.hasMore ? (page.nextCursor ?? null) : null);
      })
      .catch(() => {
        // A page that did not arrive is not a page-wide failure: the rows
        // already loaded are still moderatable, and the next scroll asks again.
      })
      .finally(() => {
        loadingMoreRef.current = false;
      });
  }, [api, capturesCursor, roll?.rollId]);

  const refresh = useCallback(async (): Promise<void> => {
    const next = await api.resolveSession();
    setRoll(next);
    setTitle(next.title);
    await refreshCaptures(next.rollId);
  }, [api, refreshCaptures]);

  /**
   * One capture, merged in place.
   *
   * This used to page the keyset feed until the wanted id turned up, because
   * the host API had no single-capture read. For a capture near the bottom of
   * a party's roll that was 36 requests to learn that one derivative had
   * finished. `GET /api/host/captures/:id` is one.
   */
  const patchCapture = useCallback(
    async (captureId: string): Promise<void> => {
      let found: HostCaptureView;
      try {
        found = await api.getCapture(captureId);
      } catch (caught) {
        // Gone for good (purged), or an event for a capture this token cannot
        // see. Anything else is a transport problem and must not empty a tile.
        if (caught instanceof ApiError && caught.status === 404) {
          setCaptures((items) => items.filter((item) => item.captureId !== captureId));
          return;
        }
        throw caught;
      }
      setCaptures((items) =>
        items.some((item) => item.captureId === captureId)
          ? items.map((item) => (item.captureId === captureId ? found : item))
          : // A capture this dashboard has not seen yet goes in by capture
            // time, which is the order the list endpoint itself uses.
            [...items, found].sort(
              (left, right) =>
                new Date(right.capturedAt).getTime() - new Date(left.capturedAt).getTime(),
            ),
      );
    },
    [api],
  );

  useEffect(() => {
    void refresh().catch((caught: unknown) => {
      if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) {
        setFatal(caught);
        return;
      }
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  }, [refresh]);

  // The estimate is one read, at load, so the Download-all panel can say what
  // the button is about to cost before the host presses it.
  useEffect(() => {
    const rollId = roll?.rollId;
    if (rollId === undefined) return;
    let live = true;
    void api
      .exportEstimate(rollId)
      .then((value) => {
        if (live) setEstimate(value);
      })
      // No estimate route on this server: the panel simply says nothing rather
      // than raising an error over a button that still works.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, roll?.rollId]);

  /**
   * An event says what changed; the dashboard reads back only that.
   *
   * - `capture.updated` / `processing.completed`: one capture changed, and the
   *   roll's counts did not. Patch the capture, ask for nothing else.
   * - `capture.created` / `capture.hidden` / `capture.deleted`: the capture AND
   *   the counts moved. Patch the capture, re-read the roll.
   * - `roll.*`: status and counts only. No capture changed.
   *
   * The full re-list stays where it belongs: the initial load.
   */
  useEffect(() => {
    const rollId = roll?.rollId;
    if (rollId === undefined) return;

    const reconcile = (event: HostRollEvent): void => {
      const refreshRoll = (): Promise<void> => api.getRoll(rollId).then(setRoll);
      const reads: Promise<unknown>[] = [];
      switch (event.type) {
        case 'roll.opened':
        case 'roll.closed':
          reads.push(refreshRoll());
          break;
        // Every capture moved at once (another tab, or this one): one re-list
        // is cheaper than two thousand patches, and the counts moved too.
        case 'roll.cleared':
          reads.push(refreshCaptures(rollId), refreshRoll());
          break;
        // One capture changed and the totals did not.
        case 'capture.updated':
        case 'processing.completed':
          reads.push(patchCapture(event.captureId));
          break;
        // A capture appearing, hidden or trashed moves the totals with it.
        default:
          reads.push(patchCapture(event.captureId), refreshRoll());
      }
      void Promise.all(reads).catch(() => {});
    };

    return api.events(rollId, reconcile);
  }, [api, patchCapture, refreshCaptures, roll?.rollId]);

  /**
   * The camera's word, re-read on a timer as well as on an event.
   *
   * ONLINE going to OFFLINE is the passage of time, not a message: no event
   * arrives, because the thing that happened is that nothing arrived. Without
   * this the strip would keep saying ONLINE, next to "last status 9 s ago",
   * for as long as the tab stayed open.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

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

  /**
   * Delete stays one click — a host moderating a party cannot afford a dialog
   * per tile — and the mis-tap is answered afterwards instead: the tile keeps
   * an Undo, every trashed capture keeps a Restore, and the trash holds for the
   * whole grace period, so there is nothing here that a mis-tap loses.
   */
  const trash = (captureId: string): void => {
    setUndoFor(captureId);
    setTrashNote(`In the trash. Kept for ${TRASH_GRACE}, then purged.`);
    void run(() => moderate(captureId, 'delete'));
  };

  const restore = (captureId: string): void => {
    const previous = captures;
    setCaptures((items) =>
      items.map((item) =>
        item.captureId === captureId ? { ...item, deletedAt: null, purgeAfter: null } : item,
      ),
    );
    if (undoFor === captureId) setUndoFor(null);
    setTrashNote(null);
    void run(async () => {
      try {
        const result = await api.restore(captureId);
        // Merged, not assigned. `restore` answers a ModerationView — four
        // fields — so assigning it over the row wiped `mode`, `capturedAt`,
        // `status` and `assets`, and the restored tile came back with an
        // undefined mode and an Invalid Date. Same merge the other three
        // moderation verbs already used.
        setCaptures((items) =>
          items.map((item) => (item.captureId === captureId ? { ...item, ...result } : item)),
        );
      } catch (caught) {
        setCaptures(previous);
        throw caught;
      }
    });
  };

  /**
   * Clears the roll. The confirm is the roll code typed back, not a dialog
   * button: a host with 2,000 test captures and a party starting in an hour
   * must not be able to do this with a mis-tap. Rows go to the trash for the
   * grace period, so the dashboard shows them TRASHED rather than gone.
   */
  const clearRoll = async (): Promise<void> => {
    if (roll === null) return;
    setClearResult(null);
    const { cleared } = await api.clearRoll(roll.rollId);
    const now = new Date().toISOString();
    setCaptures((items) =>
      items.map((item) => (item.deletedAt === null ? { ...item, deletedAt: now } : item)),
    );
    setRoll(await api.getRoll(roll.rollId));
    setClearing(false);
    setClearCode('');
    setClearResult(
      `Cleared ${String(cleared)} ${cleared === 1 ? 'capture' : 'captures'}. In the trash for ${TRASH_GRACE}, then purged.`,
    );
  };

  const [exportStopped, setExportStopped] = useState(false);
  /** A finished-and-failed job, so the line can be an alarm and not a wait. */
  const [exportFailed, setExportFailed] = useState(false);
  const startExport = async (): Promise<void> => {
    if (roll === null) return;
    setExportUrl(null);
    setExportStopped(false);
    setExportFailed(false);
    setExportSince(Date.now());
    setExportState('Asking the server for a ZIP…');
    const { jobId } = await api.startExport(roll.rollId);
    const startedAt = Date.now();
    for (;;) {
      /**
       * Two ways out that this loop did not have.
       *
       * It was a bare `for(;;)` with a one-second sleep, no cap and no unmount
       * check: a job stuck at `queued` because the worker is down — measured on
       * the dev API, it stayed there for the whole session — polled the API
       * once a second for as long as the tab lived, and every answer called
       * `setExportState` on a tree that may no longer exist.
       */
      if (!mountedRef.current) return;
      if (Date.now() - startedAt > EXPORT_POLL_LIMIT_MS) {
        setExportSince(null);
        setExportFailed(true);
        setExportState(
          `Given up watching after ${waitedFor(EXPORT_POLL_LIMIT_MS)}. The ZIP may still be building — prepare it again to start watching.`,
        );
        return;
      }
      const current = await api.getExport(roll.rollId, jobId);
      if (!mountedRef.current) return;
      setExportState(exportWording(current.status));
      if (current.url !== undefined) {
        setExportUrl(current.url);
        setExportSince(null);
        return;
      }
      /**
       * A failed export stops being a wait and says so in the panel it was
       * started from — it does not throw.
       *
       * Throwing put the same sentence in two places at once: the page-wide
       * alert under the header said "The export failed. Try again." while this
       * panel's own line still carried the blue in-progress treatment, a live
       * "Waiting 0 s." and a Stop watching button for a job that had already
       * stopped. One sentence, in the panel with the button that caused it.
       */
      if (current.status === 'failed') {
        setExportSince(null);
        setExportFailed(true);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };

  /**
   * The ZIP, fetched with the host token and handed to the browser as a file.
   *
   * See `HostApi.exportBlob`: in the deployment mode production actually runs,
   * the download URL is an authenticated API route, and the plain `<a download>`
   * this used to be answered 401 with nothing on screen to say so.
   */
  const saveZip = (url: string, slug: string): void => {
    setSaving(true);
    void run(async () => {
      try {
        saveBlob(await api.exportBlob(url), `kino-roll-${slug}.zip`);
      } finally {
        setSaving(false);
      }
    });
  };

  const displayUrl = useMemo(() => {
    if (roll === null) return '';
    try {
      const url = new URL(roll.guestUrl);
      return `${url.origin}/r/${roll.slug}/display?qr=1`;
    } catch {
      return `/r/${roll.slug}/display?qr=1`;
    }
  }, [roll]);

  if (fatal !== null) {
    return (
      <main className="roll-shell roll-shell--narrow">
        <div className="roll-brand">
          <img src={kinoRoll} alt="KINO Roll" /> · HOST
        </div>
        <Panel title="Host link rejected">
          <p role="alert">
            This host link is no longer accepted. It may have been replaced, or the roll may be
            gone.
          </p>
          <p className="host-quiet">The server said: {fatal.message}</p>
          <Button variant="primary" onClick={() => onSignOut?.()}>
            Paste a different host token
          </Button>
        </Panel>
      </main>
    );
  }

  if (roll === null) {
    return (
      <main className="roll-shell roll-shell--narrow">
        <div className="roll-brand">
          <img src={kinoRoll} alt="KINO Roll" /> · HOST
        </div>
        <Panel title="Host dashboard">
          <p role="status">{error ?? 'Reading the roll…'}</p>
        </Panel>
      </main>
    );
  }

  const setupIsOpen = setupOpen ?? roll.counts.captures === 0;
  const showCameraPanel = roll.cameras !== undefined && roll.cameras.length > 1;
  const setupContents = [
    'guest link',
    ...(showCameraPanel ? ['cameras'] : []),
    'PIN',
    'download',
    'danger',
  ].join(' · ');

  return (
    <main className="roll-shell">
      <header className="roll-head">
        <div>
          <div className="roll-brand">
            <img src={kinoRoll} alt="KINO Roll" /> · HOST
          </div>
          <h1>{roll.title}</h1>
          {/* Was "WEB CREATED", which sat where a status goes and read as one. */}
          <div className="roll-subhead">
            Code <b>{roll.slug}</b> ·{' '}
            {roll.deviceSerial === null ? 'started from a browser' : `camera ${roll.deviceSerial}`}
            {roll.hasPin ? ' · PIN set' : ''}
          </div>
        </div>
        <ToolbarFrame aria-label="Roll status controls" className="roll-head-controls">
          <StatusLamp
            state={roll.status === 'live' ? 'ok' : 'off'}
            label={roll.status.toUpperCase()}
          />
          {token === undefined ? null : <CopyHostLink token={token} />}
          {roll.status === 'live' ? (
            <Confirm
              open={closing}
              title="Close roll"
              body={
                <>
                  Closing stops the camera uploading to this roll and shuts the guest page. Guests
                  keep what is already here. You can reopen it afterwards.
                </>
              }
              confirmLabel="Close the roll"
              openLabel="Close Roll…"
              busy={busy}
              openDisabled={roll.status !== 'live'}
              onOpen={() => setClosing(true)}
              onCancel={() => setClosing(false)}
              onConfirm={() =>
                void run(async () => {
                  await update({ status: 'closed' });
                  setClosing(false);
                })
              }
            />
          ) : roll.status === 'archived' ? (
            /* Archived is terminal in the API — `ROLL_STATUS_TRANSITIONS` in
               `rolls/rolls.ts` lets an archived roll go only to archived — so
               this used to be a permanently greyed-out "Reopen Roll" with
               nothing anywhere saying why. A dead control is worse than no
               control: it reads as the page being broken. */
            <span className="host-terminal">Archived. It cannot be reopened.</span>
          ) : (
            <Button
              disabled={busy}
              onClick={() => void run(async () => void (await update({ status: 'live' })))}
            >
              Reopen Roll
            </Button>
          )}
        </ToolbarFrame>
      </header>

      {token === undefined ? null : <HostLinkWarning token={token} />}

      {error !== null ? (
        <p className="roll-alert" role="alert">
          {error}
        </p>
      ) : null}

      <StatusStrip roll={roll} captures={captures} now={now} onFilter={setFilter} />

      {/* Setup, folded away. See `setupOpen` above for why it starts where it
          starts, and `host.css` for why it is not six panels in a row. */}
      <details
        className="host-setup"
        open={setupIsOpen}
        onToggle={(event) => setSetupOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>
          Roll setup
          <span className="host-setup-hint">{setupContents}</span>
        </summary>
        <div className="host-setup-grid">
          <Panel title="Guest link">
            <QrCard guestUrl={roll.guestUrl} slug={roll.slug} />
            {/* New tabs, both of them: the guest link used to navigate the host
                out of their own dashboard and then ask them for the PIN. */}
            <ToolbarFrame aria-label="Guest surfaces">
              <a className="kino-button kino-button--sm" href={roll.guestUrl} target="_blank" rel="noreferrer noopener">
                Open guest view
              </a>
              <a className="kino-button kino-button--sm" href={displayUrl} target="_blank" rel="noreferrer noopener">
                Open TV display
              </a>
            </ToolbarFrame>
            <div className="host-rotate">
              <Confirm
                open={rotating}
                title="Regenerate guest link"
                body="A new code is issued and the old link, and every printed QR of it, stops working at once."
                confirmLabel="Issue a new code"
                openLabel="Regenerate guest link…"
                size="sm"
                busy={busy}
                onOpen={() => setRotating(true)}
                onCancel={() => setRotating(false)}
                onConfirm={() =>
                  void run(async () => {
                    const rotated = await api.regenerateSlug(roll.rollId);
                    setRoll({ ...roll, slug: rotated.slug, guestUrl: rotated.guestUrl });
                    setRotating(false);
                  })
                }
              />
            </div>
          </Panel>

          {/* The per-camera list, and only when there is something in it the
              status strip has not already said. One camera's serial, age and
              firmware are in the strip's own foot line, so rendering this
              panel too printed the same camera twice on one screen — and on an
              empty roll printed "No camera has joined this roll yet." twice. */}
          {showCameraPanel ? <CameraPanel cameras={roll.cameras} now={now} /> : null}

          <Panel title="Roll settings">
            <form
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void run(async () => void (await update({ title })));
              }}
            >
              <div className="host-field">
                <label htmlFor="host-title">Title</label>
                <div className="host-field-row">
                  <input
                    id="host-title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={120}
                  />
                  <Button type="submit" disabled={busy || title.trim() === ''}>
                    Rename
                  </Button>
                </div>
              </div>
            </form>
            <p className="host-check">
              <label>
                <input
                  type="checkbox"
                  checked={roll.downloadsEnabled}
                  onChange={(event) =>
                    void run(async () => void (await update({ downloadsEnabled: event.target.checked })))
                  }
                />
                Guests may download the full-size file
              </label>
            </p>
            <form
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void run(async () => {
                  await update({ pin });
                  setPin('');
                });
              }}
            >
              <div className="host-field">
                <label htmlFor="host-pin">{roll.hasPin ? 'Replace PIN' : 'Set PIN'}</label>
                <div className="host-field-row">
                  <input
                    id="host-pin"
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    value={pin}
                    minLength={4}
                    onChange={(event) => setPin(event.target.value)}
                  />
                  <Button type="submit" disabled={busy || pin.length < 4}>
                    Save PIN
                  </Button>
                  {roll.hasPin ? (
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => void run(async () => void (await update({ pin: null })))}
                    >
                      Remove PIN
                    </Button>
                  ) : null}
                </div>
                <p className="host-hint">
                  {roll.hasPin
                    ? 'Guests type it once to open the roll. At least 4 digits.'
                    : 'Optional. At least 4 digits. Guests type it once to open the roll.'}
                </p>
              </div>
            </form>
          </Panel>

          <Panel title="Download all">
            <p className="host-estimate">
              {estimate === null
                ? 'Size unknown on this server.'
                : estimate.files === 0
                  ? 'Nothing to download yet.'
                  : `≈${formatBytes(estimate.bytes)}, ${estimate.files.toLocaleString()} files`}
            </p>
            {/* Preparing is the setup step; the download that follows is the
                one the host is actually after, so that is the primary and this
                is not. Both are on screen at once after the first ZIP. */}
            <Button disabled={busy || estimate?.files === 0} onClick={() => void run(startExport)}>
              Prepare ZIP
            </Button>
            {exportState !== null && !exportStopped ? (
              <p
                className="host-export-state"
                data-tone={exportFailed ? 'bad' : 'busy'}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <span>
                  {exportState}
                  {exportSince === null || now - exportSince < EXPORT_WAIT_FLOOR_MS
                    ? ''
                    : ` Waiting ${waitedFor(now - exportSince)}.`}
                </span>
                {exportSince === null ? null : (
                  <Button
                    size="sm"
                    onClick={() => {
                      setExportStopped(true);
                      setExportSince(null);
                    }}
                  >
                    Stop watching
                  </Button>
                )}
              </p>
            ) : null}
            {exportUrl !== null ? (
              <p className="host-export-done">
                <Button
                  variant="primary"
                  busy={saving}
                  onClick={() => saveZip(exportUrl, roll.slug)}
                >
                  Download ZIP
                </Button>
              </p>
            ) : null}
            <p className="host-quiet">
              The ZIP is built on the server and comes down through this dashboard to your Downloads
              folder. Preparing it again builds another one — it does not replace the first.
            </p>
          </Panel>

          {token === undefined ? null : (
            <HostAccessPanel
              token={token}
              remembered={remembered}
              onRemember={(value) => onRemember?.(value)}
              onSignOut={() => onSignOut?.()}
            />
          )}

          <Panel title="Danger">
            <div className="host-danger" data-clearing={clearing}>
              {clearing ? (
                <form
                  aria-label="Clear roll"
                  onSubmit={(event: FormEvent) => {
                    event.preventDefault();
                    if (clearCode.trim().toUpperCase() !== roll.slug.toUpperCase()) return;
                    void run(clearRoll);
                  }}
                >
                  <p>
                    This trashes all <b>{roll.counts.captures}</b> captures in this roll. Guests see
                    it empty at once. The trash is purged after {TRASH_GRACE}.
                  </p>
                  <label htmlFor="host-clear-code">
                    Type the roll code <code>{roll.slug}</code> to confirm
                  </label>
                  <input
                    id="host-clear-code"
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    value={clearCode}
                    onChange={(event) => setClearCode(event.target.value)}
                  />
                  <ToolbarFrame aria-label="Clear roll confirmation">
                    <Button
                      type="submit"
                      variant="danger-solid"
                      disabled={busy || clearCode.trim().toUpperCase() !== roll.slug.toUpperCase()}
                    >
                      {busy ? 'Clearing…' : `Clear ${roll.counts.captures} captures`}
                    </Button>
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setClearing(false);
                        setClearCode('');
                      }}
                    >
                      Cancel
                    </Button>
                  </ToolbarFrame>
                </form>
              ) : (
                <>
                  <p>
                    Clear roll: every capture goes to the trash. Nothing is deleted for{' '}
                    {TRASH_GRACE}.
                  </p>
                  <Button
                    variant="danger"
                    disabled={busy || roll.counts.captures === 0}
                    onClick={() => {
                      setClearResult(null);
                      setClearing(true);
                    }}
                  >
                    Clear roll…
                  </Button>
                </>
              )}
              {clearResult !== null ? (
                <p role="status" aria-live="polite" aria-atomic="true">
                  {clearResult}
                </p>
              ) : null}
            </div>
          </Panel>
        </div>
      </details>

      <Panel title="Moderation">
        <p className="host-hint">
          Hidden captures stay on the server and disappear from the guest page. Deleted ones go to
          the trash and are kept for {TRASH_GRACE} — until then, Restore brings them back.
        </p>
        {trashNote !== null ? (
          <p className="host-trash-note" role="status" aria-live="polite">
            {trashNote}
          </p>
        ) : null}
        <CaptureGrid
          captures={captures}
          assetBlob={api.assetBlob}
          busy={busy}
          filter={filter}
          onFilter={setFilter}
          onHide={(captureId, next) => void run(() => moderate(captureId, next))}
          onDelete={trash}
          onRestore={restore}
          undoFor={undoFor}
          hasMore={capturesCursor !== null}
          onNeedMore={loadMoreCaptures}
        />
      </Panel>
    </main>
  );
}
