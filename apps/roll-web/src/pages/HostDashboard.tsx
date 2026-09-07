import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type {
  HostApi,
  HostCaptureView,
  HostExportEstimate,
  HostRollEvent,
  HostRollView,
} from '../api/hostClient';
import { ApiError } from '../api/client';
import { Button, Panel, StatusLamp, ToolbarFrame } from '@kino/design-system';
import kinoRoll from '../assets/kino-roll-dark.png';
import { CameraPanel } from '../components/host/CameraPanel';
import { CaptureGrid, type CaptureFilter } from '../components/host/CaptureGrid';
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
      return 'The export failed.';
    default:
      return `Export: ${status}`;
  }
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    // A description list, not four divs: label and number are a pair, and the
    // pairing was carried by nothing but their order on the screen.
    <div className="host-stat">
      <dt className="host-stat-label">{label}</dt>
      <dd className="host-stat-value">{value}</dd>
    </div>
  );
}

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
}) {
  if (!open) {
    return (
      <Button variant={variant} disabled={openDisabled === true || busy} onClick={onOpen}>
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
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportState, setExportState] = useState<string | null>(null);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
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
        const restored = await api.restore(captureId);
        setCaptures((items) =>
          items.map((item) => (item.captureId === captureId ? restored : item)),
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

  const startExport = async (): Promise<void> => {
    if (roll === null) return;
    setExportUrl(null);
    setExportState('Asking the server for a ZIP…');
    const { jobId } = await api.startExport(roll.rollId);
    for (;;) {
      const current = await api.getExport(roll.rollId, jobId);
      setExportState(exportWording(current.status));
      if (current.url !== undefined) {
        setExportUrl(current.url);
        return;
      }
      if (current.status === 'failed') throw new Error('The export failed. Try again.');
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
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
      <main className="roll-shell">
        <h1>Host dashboard</h1>
        <p role="status">{error ?? 'Reading the roll…'}</p>
      </main>
    );
  }

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
            Code {roll.slug} ·{' '}
            {roll.deviceSerial === null ? 'started from a browser' : `camera ${roll.deviceSerial}`}
          </div>
        </div>
        <ToolbarFrame aria-label="Roll status controls">
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
          ) : (
            <Button
              disabled={busy || roll.status === 'archived'}
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

      <dl aria-label="Roll totals" className="host-stats">
        <Stat label="CAPTURES" value={roll.counts.captures} />
        <Stat label="GUESTS" value={roll.guests} />
        <Stat label="PENDING" value={roll.counts.pending} />
        <Stat label="HIDDEN" value={roll.counts.hidden} />
      </dl>

      <section className="host-settings">
        <CameraPanel cameras={roll.cameras} />

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

        {token === undefined ? null : (
          <HostAccessPanel
            token={token}
            remembered={remembered}
            onRemember={(value) => onRemember?.(value)}
            onSignOut={() => onSignOut?.()}
          />
        )}

        <Panel title="Roll settings">
          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void run(async () => void (await update({ title })));
            }}
          >
            <label htmlFor="host-title">Title</label>
            <br />
            <input
              id="host-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
            />
            <Button type="submit" disabled={busy || title.trim() === ''}>
              Rename
            </Button>
          </form>
          <p>
            <label>
              <input
                type="checkbox"
                checked={roll.downloadsEnabled}
                onChange={(event) =>
                  void run(async () => void (await update({ downloadsEnabled: event.target.checked })))
                }
              />{' '}
              Guest downloads
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
            <label htmlFor="host-pin">{roll.hasPin ? 'Replace PIN' : 'Set PIN'}</label>
            <br />
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
              <Button disabled={busy} onClick={() => void run(async () => void (await update({ pin: null })))}>
                Remove PIN
              </Button>
            ) : null}
          </form>
        </Panel>

        <Panel title="Download all">
          <p className="host-estimate">
            {estimate === null
              ? 'Size unknown on this server.'
              : `≈${formatBytes(estimate.bytes)}, ${estimate.files.toLocaleString()} files`}
          </p>
          <Button disabled={busy} onClick={() => void run(startExport)}>
            Prepare ZIP
          </Button>
          {exportState !== null ? (
            <p role="status" aria-live="polite" aria-atomic="true">
              {exportState}
            </p>
          ) : null}
          {exportUrl !== null ? (
            <a className="roll-action" href={exportUrl} download={`kino-roll-${roll.slug}.zip`}>
              Download ZIP
            </a>
          ) : null}
          <p className="host-quiet">
            The ZIP is built on the server and comes down through this dashboard to your Downloads
            folder. Preparing it again builds another one — it does not replace the first.
          </p>
        </Panel>

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
                  This trashes all <b>{roll.counts.captures}</b> captures in this roll. Guests see it
                  empty at once. The trash is purged after {TRASH_GRACE}.
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
                  Clear roll: every capture goes to the trash. Nothing is deleted for {TRASH_GRACE}.
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
      </section>

      <Panel title="Moderation">
        <p className="host-quiet">
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
          assetUrl={api.assetUrl}
          busy={busy}
          filter={filter}
          onFilter={setFilter}
          onHide={(captureId, next) => void run(() => moderate(captureId, next))}
          onDelete={trash}
          onRestore={restore}
          undoFor={undoFor}
        />
      </Panel>
    </main>
  );
}
