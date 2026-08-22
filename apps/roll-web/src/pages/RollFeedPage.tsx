import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { kdpLoopToMediaLoop } from '@kino/media';
import {
  isNoRollError,
  PinRequiredError,
  rollApi,
  type CaptureView,
  type RollView,
} from '../api/client';
import { evictCaptureAssets } from '../cache/assets';
import { SiteFooter, SiteHeader } from '../components/SiteHeader';
import { WigglePlayer } from '../components/WigglePlayer';
import { useRollEvents } from '../hooks/useRollEvents';
import { useRollFeed } from '../hooks/useRollFeed';
import { usePickedCaptures, usePicks } from '../state/picks';
import { NoRollPage } from './NotFoundPage';
import { PinGate } from './PinGate';
import { RollClosed } from './RollClosed';
import { StatusLamp } from '@kino/design-system';

export interface RollFeedPageProps {
  slug: string;
}

/** 2 columns on phones, 3 on large phones, 4 from 900px up. */
function useColumnCount(): number {
  const pick = (): number => {
    if (typeof window.matchMedia !== 'function') return 2;
    if (window.matchMedia('(min-width: 900px)').matches) return 4;
    if (window.matchMedia('(min-width: 520px)').matches) return 3;
    return 2;
  };
  const [columns, setColumns] = useState(pick);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = ['(min-width: 900px)', '(min-width: 520px)'].map((query) => window.matchMedia(query));
    const changed = (): void => setColumns(pick());
    for (const entry of media) entry.addEventListener('change', changed);
    return () => {
      for (const entry of media) entry.removeEventListener('change', changed);
    };
  }, []);

  return columns;
}

function rowsOf(captures: readonly CaptureView[], columns: number): CaptureView[][] {
  const rows: CaptureView[][] = [];
  for (let index = 0; index < captures.length; index += columns) {
    rows.push(captures.slice(index, index + columns));
  }
  return rows;
}

function assetOf(capture: CaptureView, roles: readonly string[]) {
  for (const role of roles) {
    const asset = capture.assets.find((candidate) => candidate.role === role);
    if (asset !== undefined) return asset;
  }
  return undefined;
}

function formattedDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(value),
  );
}

function timeAgo(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  return formattedDate(value);
}

function CaptureTile({
  slug,
  capture,
  downloadsEnabled,
  isNew,
}: {
  slug: string;
  capture: CaptureView;
  downloadsEnabled: boolean;
  isNew: boolean;
}) {
  const poster = assetOf(capture, ['thumb', 'kino-still', 'wiggle-preview']);
  const animated = assetOf(capture, ['wiggle-webp', 'wiggle-preview']);
  const originals = capture.assets
    .filter((asset) => asset.role === 'original-frame')
    .map((asset) => rollApi.assetUrl(asset.assetId));

  let media;
  if (capture.mode === 'wiggle' && downloadsEnabled && originals.length >= 2) {
    media = (
      <WigglePlayer
        frames={originals}
        fps={capture.playback?.fps}
        // The stored loop word is KDP's; the player speaks @kino/media's.
        loop={kdpLoopToMediaLoop(capture.playback?.loop ?? 'bounce')}
        poster={poster === undefined ? undefined : rollApi.assetUrl(poster.assetId)}
      />
    );
  } else {
    const source = animated ?? poster;
    media =
      source === undefined ? (
        <span className="photo-processing" aria-label="Capture processing">Processing…</span>
      ) : (
        <img
          src={rollApi.assetUrl(source.assetId)}
          alt=""
          loading="lazy"
          className="photo-img"
        />
      );
  }

  return (
    <a
      href={`/r/${encodeURIComponent(slug)}/c/${encodeURIComponent(capture.captureId)}`}
      aria-label={`Open capture from ${new Date(capture.capturedAt).toLocaleTimeString()}`}
      className="photo-thumb"
      data-new={isNew || undefined}
    >
      {media}
      {/* The feed endpoint carries no reaction counts; hearts live on the
          detail page instead of a mocked number here. */}
      <span className="photo-thumb-meta">
        {isNew ? <strong className="photo-new">NEW</strong> : null}
        <span className="photo-when">{timeAgo(capture.capturedAt)}</span>
      </span>
    </a>
  );
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
  const shown = tab === 'picks' ? picked : feed.captures;
  const rows = useMemo(() => rowsOf(shown, columns), [columns, shown]);

  const refreshRoll = useCallback(async (): Promise<void> => {
    try {
      setRoll(await rollApi.getRoll(slug));
      setRollError(null);
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
    count: rows.length,
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
      lastVirtualRow.index >= rows.length - 2 &&
      feed.hasMore &&
      !feed.loading
    ) {
      void feed.loadMore().catch(() => {});
    }
  }, [feed, lastVirtualRow, rows.length, tab]);

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

  const newest = feed.captures[0];
  const dp = newest === undefined ? undefined : assetOf(newest, ['thumb', 'kino-still', 'wiggle-preview']);
  const photoCount = roll?.photoCount ?? feed.captures.length;

  return (
    <>
      <SiteHeader
        right={
          roll === null ? (
            <StatusLamp state="busy" label="LOADING" announce />
          ) : (
            <StatusLamp state={roll.status === 'live' ? 'ok' : 'off'} label={roll.status.toUpperCase()} announce />
          )
        }
      />
      <main className="site-width">
        <div className="roll-header">
          {dp === undefined ? (
            <span className="roll-avatar roll-avatar--empty" aria-hidden="true">K</span>
          ) : (
            <img className="roll-avatar" src={rollApi.assetUrl(dp.assetId)} alt="" />
          )}
          <div className="roll-header-text">
            <h1>{roll?.title ?? slug}</h1>
            {roll !== null ? (
              <div className="roll-meta">
                {formattedDate(roll.createdAt)} · {photoCount} {photoCount === 1 ? 'photo' : 'photos'}
              </div>
            ) : null}
            {roll?.status === 'closed' ? <RollClosed closedAt={roll.closedAt} /> : null}
          </div>
        </div>

        <nav className="roll-tabs" aria-label="Roll sections">
          <button type="button" className="roll-tab" aria-current={tab === 'photos'} onClick={() => setTab('photos')}>
            Photos ({photoCount})
          </button>
          <button type="button" className="roll-tab" aria-current={tab === 'picks'} onClick={() => setTab('picks')}>
            My picks ({picks.size})
          </button>
          <button type="button" className="roll-tab" aria-current={tab === 'info'} onClick={() => setTab('info')}>
            Info
          </button>
        </nav>

        {failure !== null ? <p className="roll-alert" role="alert">{failure.message}</p> : null}

        {tab === 'info' && roll !== null ? (
          <div className="roll-info">
            <dl className="info-list">
              <dt>Created</dt>
              <dd>{formattedDate(roll.createdAt)}</dd>
              <dt>Photos</dt>
              <dd>{photoCount}</dd>
              <dt>Status</dt>
              <dd>{roll.status === 'live' ? 'LIVE' : roll.status}</dd>
              <dt>Downloads</dt>
              <dd>{roll.downloadsEnabled ? 'On' : 'Off'}</dd>
              <dt>Display</dt>
              <dd><a href={`/r/${encodeURIComponent(slug)}/display`}>DISPLAY</a></dd>
            </dl>
          </div>
        ) : null}

        {tab !== 'info' ? (
          <>
            {tab === 'photos' && feed.captures.length === 0 && feed.loading ? (
              <p role="status" aria-live="polite">Loading Roll…</p>
            ) : null}
            {tab === 'photos' && feed.captures.length === 0 && !feed.loading && failure === null ? (
              <p role="status" aria-live="polite">No photos yet.</p>
            ) : null}
            {tab === 'picks' && shown.length === 0 ? (
              <p role="status" aria-live="polite">No picks yet. Heart a photo to keep it here.</p>
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

            <div ref={listRef} className="photo-grid" role="region" aria-label="Roll captures">
              <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
                {virtualRows.map((virtualRow) => (
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
                      display: 'grid',
                      gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`,
                      gap: '8px',
                      paddingBottom: '8px',
                    }}
                  >
                    {(rows[virtualRow.index] ?? []).map((capture) => (
                      <CaptureTile
                        key={capture.captureId}
                        slug={slug}
                        capture={capture}
                        downloadsEnabled={roll?.downloadsEnabled ?? false}
                        isNew={freshIds.has(capture.captureId)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </main>
      <SiteFooter />
    </>
  );
}
