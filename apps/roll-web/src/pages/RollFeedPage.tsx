import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import {
  isNoRollError,
  PinRequiredError,
  rollApi,
  type CaptureView,
  type RollView,
} from '../api/client';
import { evictCaptureAssets } from '../cache/assets';
import { LoadFailure } from '../components/LoadFailure';
import { OfflineBanner } from '../components/OfflineBanner';
import { SafeImage } from '../components/SafeImage';
import { GuestBar, rollLabel, shortDate, SiteFooter } from '../components/SiteHeader';
import { CAMERA_SLOTS, StatusChip } from '../components/StatusChip';
import { useRollEvents } from '../hooks/useRollEvents';
import { useRollFeed } from '../hooks/useRollFeed';
import { rememberRoll } from '../state/lastRoll';
import { togglePick, usePickedCaptures, usePicks } from '../state/picks';
import { NoRollPage } from './NotFoundPage';
import { PinGate } from './PinGate';
import { RollClosed, RollStateBanner, rollAcceptsUploads } from './RollClosed';

export interface RollFeedPageProps {
  slug: string;
}

/** One photograph per row on a phone; two on a tablet, three on a desktop. */
function useColumnCount(): number {
  const pick = (): number => {
    if (typeof window.matchMedia !== 'function') return 1;
    if (window.matchMedia('(min-width: 1100px)').matches) return 3;
    if (window.matchMedia('(min-width: 720px)').matches) return 2;
    return 1;
  };
  const [columns, setColumns] = useState(pick);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = ['(min-width: 1100px)', '(min-width: 720px)'].map((query) => window.matchMedia(query));
    const changed = (): void => setColumns(pick());
    for (const entry of media) entry.addEventListener('change', changed);
    return () => {
      for (const entry of media) entry.removeEventListener('change', changed);
    };
  }, []);

  return columns;
}

function assetOf(capture: CaptureView, roles: readonly string[]) {
  for (const role of roles) {
    const asset = capture.assets.find((candidate) => candidate.role === role);
    if (asset !== undefined) return asset;
  }
  return undefined;
}

/** `21:40` — the clock mark a group of captures is filed under. */
export function clockMark(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The camera numbers that answered, from `frameIndex` (1-based camera number), sorted. */
export function camerasPresent(capture: Pick<CaptureView, 'assets'>): number[] {
  return capture.assets
    .filter((asset) => asset.role === 'original-frame')
    .map((asset) => asset.frameIndex)
    .filter((index): index is number => index !== null)
    .sort((left, right) => left - right);
}

/**
 * One bar per CAMERA SLOT, 1 to 4, lit when a frame from that camera exists
 * and dark when it does not — cameras 1, 3, 4 show slot 2 unlit. Each lit bar
 * carries `data-pos`, the frame's index in the stored list, which is the index
 * a live player publishes on `data-frame`; the stylesheet lights the matching
 * bar so the mark is the playhead, not a badge kept in step by hand. Until
 * the feed knows which cameras answered it lights the first `frameCount`
 * slots. A single-frame capture collapses to one wide bar.
 */
export function FrameMark({ capture }: { capture: Pick<CaptureView, 'assets' | 'frameCount'> }) {
  if (capture.frameCount < 2) return <span className="k-frames k-frames--solo" aria-hidden="true"><b /></span>;
  const known = camerasPresent(capture);
  const cameras = known.length > 0 ? known : Array.from({ length: Math.min(capture.frameCount, CAMERA_SLOTS) }, (_unused, index) => index + 1);
  return (
    <span className="k-frames" aria-hidden="true">
      {Array.from({ length: CAMERA_SLOTS }, (_unused, index) => {
        const camera = index + 1;
        const position = cameras.indexOf(camera);
        return position === -1 ? (
          <b key={camera} data-cam={camera} data-missing="" />
        ) : (
          <b key={camera} data-cam={camera} data-pos={position} />
        );
      })}
    </span>
  );
}

/** Exported for the tile-level tests; the page is the only caller. */
export function CaptureTile({
  slug,
  capture,
  index,
  isNew,
  picked,
  onPick,
}: {
  slug: string;
  capture: CaptureView;
  index: string;
  isNew: boolean;
  picked: boolean;
  onPick: (captureId: string) => void;
}) {
  const poster = assetOf(capture, ['thumb', 'kino-still', 'wiggle-preview']);
  const failed = capture.status === 'failed';
  // A failed capture shows its still if the worker made one, never a bake.
  const animated = failed ? undefined : assetOf(capture, ['wiggle-webp', 'wiggle-preview']);
  // The grid never mounts the live player. A baked animation is one request
  // of a few tens of kB; the live player is four full-resolution originals
  // per tile, times every tile on screen, on party Wi-Fi. Until the worker
  // has baked one the tile is the thumb, still, wearing "Processing…". The
  // live player belongs to the capture page, where the guest asked for that
  // one photograph.
  const source = animated ?? poster;
  const media =
    source === undefined ? (
      <span className="k-processing" aria-label={failed ? 'Capture failed' : 'Capture processing'}>
        {failed ? 'FAILED' : 'Processing…'}
      </span>
    ) : (
      <SafeImage src={rollApi.assetUrl(source.assetId)} alt="" loading="lazy" className="photo-img" />
    );
  // failed and partial come from the wire; a wiggle with no bake yet is
  // processing whatever the status column says, because that is what the
  // guest is looking at.
  const chipStatus =
    failed || capture.status === 'partial'
      ? capture.status
      : capture.mode === 'wiggle' && animated === undefined
        ? 'processing'
        : capture.status;
  const present = camerasPresent(capture).length || capture.frameCount;

  return (
    <div className="k-shot" data-new={isNew || undefined}>
      <a
        className="k-open"
        href={`/r/${encodeURIComponent(slug)}/c/${encodeURIComponent(capture.captureId)}`}
        aria-label={`Open capture ${index} from ${clockMark(capture.capturedAt)}`}
      >
        {media}
      </a>
      {isNew ? <span className="k-new">New</span> : null}
      {source === undefined ? null : <StatusChip status={chipStatus} present={present} />}
      <div className="k-overlay">
        <span className="k-idx">
          <FrameMark capture={capture} />
          <span className="k-no">{index}</span>
          {/* Motion off: the range is spelled out, since the bars cannot move.
              A baked animation moves without the player, so it is not still. */}
          {capture.frameCount >= 2 && animated === undefined ? (
            <span className="k-still">1-{capture.frameCount}</span>
          ) : null}
        </span>
        <button
          type="button"
          className="k-pick"
          aria-pressed={picked}
          aria-label={picked ? `Remove pick ${index}` : `Pick ${index}`}
          onClick={() => onPick(capture.captureId)}
        >
          {picked ? '\u2665' : '\u2661'}
        </button>
      </div>
    </div>
  );
}

/** A clock mark, or a row of captures filed under the one above it. */
type StreamItem =
  | { kind: 'clock'; key: string; label: string }
  | { kind: 'row'; key: string; captures: CaptureView[] };

/**
 * Consecutive captures sharing a minute are filed under one clock mark, so
 * the roll reads as a sequence of moments instead of repeating the same
 * relative timestamp under every tile.
 */
export function streamItems(captures: readonly CaptureView[], columns: number): StreamItem[] {
  const items: StreamItem[] = [];
  let mark: string | null = null;
  let row: CaptureView[] = [];

  const flush = (): void => {
    if (row.length === 0) return;
    items.push({ kind: 'row', key: `r_${row[0]!.captureId}`, captures: row });
    row = [];
  };

  for (const capture of captures) {
    const label = clockMark(capture.capturedAt);
    if (label !== mark) {
      flush();
      mark = label;
      items.push({ kind: 'clock', key: `t_${capture.captureId}`, label });
    }
    row.push(capture);
    if (row.length === columns) flush();
  }
  flush();
  return items;
}

/**
 * Below this scroll depth a live arrival goes to the "N new" pill instead of
 * shifting the grid under the guest's thumb. Above it the head is on screen and
 * prepending is what live means.
 */
const PREPEND_SCROLL_LIMIT_PX = 80;

/** Virtualized, keyset-paginated and live-updating guest Roll gallery. */
export function RollFeedPage({ slug }: RollFeedPageProps) {
  const feed = useRollFeed(slug);
  const [roll, setRoll] = useState<RollView | null>(null);
  const [rollError, setRollError] = useState<Error | null>(null);
  const [tab, setTab] = useState<'photos' | 'picks' | 'info'>('photos');
  const listRef = useRef<HTMLDivElement>(null);
  const columns = useColumnCount();
  const picks = usePicks(slug);
  const picked = usePickedCaptures(slug, picks, feed.captures);
  /**
   * A capture's number is its place in the roll, counted from the oldest, so
   * `003` means the same thing to two guests looking at the same photograph.
   * The feed arrives newest first, hence the subtraction.
   */
  const indexOf = useCallback(
    (captureId: string): string => {
      const at = feed.captures.findIndex((c) => c.captureId === captureId);
      const total = Math.max(feed.captures.length, roll?.photoCount ?? 0);
      const nth = at < 0 ? 0 : total - at;
      return String(nth).padStart(3, '0');
    },
    [feed.captures, roll?.photoCount],
  );

  // The plate gives way going down the roll and returns on the first upward
  // move, so the photographs get the screen without navigation ever being
  // more than one gesture away.
  const [barHidden, setBarHidden] = useState(false);
  useEffect(() => {
    let previous = window.scrollY;
    const onScroll = (): void => {
      const y = window.scrollY;
      setBarHidden(y > 120 && y > previous);
      previous = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Picking is immediate and local: no request, no toast, no confirmation.
  const onPickToggle = useCallback((captureId: string): void => {
    togglePick(slug, captureId);
  }, [slug]);
  const shown = tab === 'picks' ? picked : feed.captures;
  const items = useMemo(() => streamItems(shown, columns), [columns, shown]);

  const refreshRoll = useCallback(async (): Promise<void> => {
    try {
      const next = await rollApi.getRoll(slug);
      setRoll(next);
      setRollError(null);
      // The landing page offers a way back to the roll last opened here.
      rememberRoll(slug, next.title);
    } catch (caught) {
      setRollError(caught instanceof Error ? caught : new Error(String(caught)));
    }
  }, [slug]);

  useEffect(() => {
    void refreshRoll();
  }, [refreshRoll]);

  const removeLive = useCallback(
    (captureId: string): void => {
      const capture = feed.captures.find((candidate) => candidate.captureId === captureId);
      feed.remove(captureId);
      if (capture !== undefined) void evictCaptureAssets(capture, rollApi).catch(() => {});
    },
    [feed],
  );

  const failure = rollError ?? feed.error;

  // Only captures that arrive through the live event stream get the NEW
  // badge; initial pages and older pages never do. The badge stays for the
  // session — the border highlight animates once and settles.
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  const nearTop = (): boolean => window.scrollY <= PREPEND_SCROLL_LIMIT_PX;
  const prependLive = useCallback(
    (capture: CaptureView): void => {
      if (!nearTop()) {
        feed.buffer(capture);
        return;
      }
      feed.prepend(capture);
      setFreshIds((previous) => new Set(previous).add(capture.captureId));
    },
    [feed],
  );

  // The reconnect/pageshow head refetch obeys the same rule as a live arrival:
  // a scrolled guest gets the pill, not a shifted grid.
  const refetchHeadLive = useCallback(
    async (): Promise<void> => feed.refetchHead({ buffer: !nearTop() }),
    [feed],
  );

  const flushPending = (): void => {
    const flushed = feed.flushPending();
    setFreshIds((previous) => {
      const next = new Set(previous);
      for (const id of flushed) next.add(id);
      return next;
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useRollEvents(
    slug,
    {
      prepend: prependLive,
      replace: feed.replace,
      remove: removeLive,
      refetchHead: refetchHeadLive,
      onRollChanged: refreshRoll,
    },
    rollApi,
    roll !== null && !(failure instanceof PinRequiredError) && !isNoRollError(failure),
  );

  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: () => 220,
    overscan: 3,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const lastVirtualRow = virtualRows[virtualRows.length - 1];

  useEffect(() => {
    if (
      tab === 'photos' &&
      lastVirtualRow !== undefined &&
      lastVirtualRow.index >= items.length - 2 &&
      feed.hasMore &&
      !feed.loading
    ) {
      void feed.loadMore().catch(() => {});
    }
  }, [feed, lastVirtualRow, items.length, tab]);

  if (failure instanceof PinRequiredError) {
    return (
      <PinGate
        slug={slug}
        onUnlocked={async () => {
          await Promise.all([refreshRoll(), feed.refetchHead()]);
        }}
      />
    );
  }

  if (isNoRollError(failure)) return <NoRollPage />;

  const photoCount = roll?.photoCount ?? feed.captures.length;
  const acceptsUploads = rollAcceptsUploads(roll?.status);
  const retry = async (): Promise<void> => {
    await Promise.all([refreshRoll(), feed.refetchHead().catch(() => {})]);
  };

  return (
    <>
      <div className="k-app">
        <OfflineBanner />
        <GuestBar name={rollLabel(roll?.title, slug)} count={photoCount} hidden={barHidden}>
          <nav className="k-nav" aria-label="Roll sections">
            <button type="button" aria-current={tab === 'photos'} onClick={() => setTab('photos')}>
              Roll
            </button>
            <button
              type="button"
              aria-current={tab === 'picks'}
              aria-label={`My picks, ${String(picks.size)}`}
              onClick={() => setTab('picks')}
            >
              Picks
              {picks.size > 0 ? <span className="k-cnt">{String(picks.size).padStart(2, '0')}</span> : null}
            </button>
            <button type="button" aria-current={tab === 'info'} onClick={() => setTab('info')}>
              Info
            </button>
          </nav>
        </GuestBar>

        {roll?.status === 'closed' ? <RollClosed closedAt={roll.closedAt} /> : null}
        {roll?.status === 'archived' ? <RollStateBanner status="archived" /> : null}

        {failure !== null ? <LoadFailure onRetry={() => void retry()} /> : null}

        {tab === 'info' && roll !== null ? (
          <div className="k-info">
            <dl>
              <dt>Roll</dt>
              <dd><b>{roll.title}</b></dd>
              <dt>Date</dt>
              <dd>{shortDate(roll.createdAt)}</dd>
              <dt>Frames</dt>
              <dd>
                <b>{photoCount}</b> {photoCount === 1 ? 'capture' : 'captures'}
              </dd>
              <dt>Camera</dt>
              <dd><b>KINO D4</b> · four lenses</dd>
              <dt>Saving</dt>
              <dd>{roll.downloadsEnabled ? 'On — you can keep these photographs' : 'Off for this roll'}</dd>
              <dt>Display</dt>
              <dd><a href={`/r/${encodeURIComponent(slug)}/display`}>Open this roll on a screen</a></dd>
            </dl>
          </div>
        ) : null}

        {tab !== 'info' ? (
          <>
            {tab === 'photos' && feed.captures.length === 0 && feed.loading ? (
              <p className="k-note" role="status" aria-live="polite">Reading roll…</p>
            ) : null}
            {tab === 'photos' && feed.captures.length === 0 && !feed.loading && failure === null ? (
              <div className="k-note" role="status" aria-live="polite">
                <span className="k-blank" aria-hidden="true"><b /><b /><b /><b /></span>
                {/* A closed or archived roll takes no more uploads, so "leave
                    this page open" would be a promise nothing can keep. */}
                <b>{acceptsUploads ? 'No photographs yet' : 'No photographs'}</b>
                {acceptsUploads ? 'They appear here as the camera sends them. You can leave this page open.' : null}
              </div>
            ) : null}
            {tab === 'picks' && shown.length === 0 ? (
              <div className="k-note" role="status" aria-live="polite">
                <span className="k-blank" aria-hidden="true"><b /><b /><b /><b /></span>
                <b>Nothing picked</b>
                Tap the heart on a photograph to keep it here. Picks stay on this phone.
              </div>
            ) : null}

            {tab === 'photos' && feed.pending.length > 0 ? (
              <button
                type="button"
                className="new-pill"
                role="status"
                aria-live="polite"
                onClick={flushPending}
              >
                {feed.pending.length} new
              </button>
            ) : null}

            <div ref={listRef} className="k-stream" role="region" aria-label="Roll captures">
              <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
                {virtualRows.map((virtualRow) => {
                  const item = items[virtualRow.index];
                  return (
                    <div
                      key={virtualRow.key}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${String(virtualRow.start - virtualizer.options.scrollMargin)}px)`,
                      }}
                    >
                      {item === undefined ? null : item.kind === 'clock' ? (
                        <div className="k-clock">
                          <i aria-hidden="true" />
                          <span>{item.label}</span>
                          {/* The date belongs on the first mark of the roll, where it
                              is the answer to "when was this"; repeating it on every
                              group would be the timestamp-under-every-tile again. */}
                          {virtualRow.index === 0 ? <span className="k-day">{shortDate(roll?.createdAt)}</span> : null}
                        </div>
                      ) : (
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`,
                            gap: '1px',
                            paddingBottom: '1px',
                          }}
                        >
                          {item.captures.map((capture) => (
                            <CaptureTile
                              key={capture.captureId}
                              slug={slug}
                              capture={capture}
                              index={indexOf(capture.captureId)}
                              isNew={freshIds.has(capture.captureId)}
                              picked={picks.has(capture.captureId)}
                              onPick={onPickToggle}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        ) : null}
      </div>
      <SiteFooter />
    </>
  );
}
