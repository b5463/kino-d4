import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { rollApi, type CaptureView, type RollView } from '../api/client';
import { evictCaptureAssets } from '../cache/assets';
import { WigglePlayer } from '../components/WigglePlayer';
import { useRollEvents } from '../hooks/useRollEvents';
import { useRollFeed } from '../hooks/useRollFeed';

export interface RollFeedPageProps {
  slug: string;
}

function useColumnCount(): number {
  const query = '(min-width: 768px)';
  const [columns, setColumns] = useState(() =>
    typeof window.matchMedia === 'function' && window.matchMedia(query).matches ? 4 : 3,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const changed = (event: MediaQueryListEvent): void => setColumns(event.matches ? 4 : 3);
    setColumns(media.matches ? 4 : 3);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
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

function CaptureTile({
  slug,
  capture,
  downloadsEnabled,
}: {
  slug: string;
  capture: CaptureView;
  downloadsEnabled: boolean;
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
        poster={poster === undefined ? undefined : rollApi.assetUrl(poster.assetId)}
      />
    );
  } else {
    const source = animated ?? poster;
    media =
      source === undefined ? (
        <span aria-label="Capture processing">Processing…</span>
      ) : (
        <img
          src={rollApi.assetUrl(source.assetId)}
          alt=""
          loading="lazy"
          style={{ display: 'block', width: '100%', aspectRatio: '4 / 3', objectFit: 'cover' }}
        />
      );
  }

  return (
    <a
      href={`/r/${encodeURIComponent(slug)}/c/${encodeURIComponent(capture.captureId)}`}
      aria-label={`Open capture from ${new Date(capture.capturedAt).toLocaleTimeString()}`}
      style={{ display: 'block', color: 'inherit', textDecoration: 'none', minWidth: 0 }}
    >
      {media}
    </a>
  );
}

function formattedDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(value),
  );
}

/** Virtualized, keyset-paginated and live-updating guest Roll gallery. */
export function RollFeedPage({ slug }: RollFeedPageProps) {
  const feed = useRollFeed(slug);
  const [roll, setRoll] = useState<RollView | null>(null);
  const [rollError, setRollError] = useState<Error | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columns = useColumnCount();
  const rows = useMemo(() => rowsOf(feed.captures, columns), [columns, feed.captures]);

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

  useRollEvents(slug, {
    prepend: feed.prepend,
    replace: feed.replace,
    remove: removeLive,
    refetchHead: feed.refetchHead,
    onRollChanged: refreshRoll,
  });

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 230,
    overscan: 2,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const lastVirtualRow = virtualRows[virtualRows.length - 1];

  useEffect(() => {
    if (
      lastVirtualRow !== undefined &&
      lastVirtualRow.index >= rows.length - 2 &&
      feed.hasMore &&
      !feed.loading
    ) {
      void feed.loadMore().catch(() => {});
    }
  }, [feed, lastVirtualRow, rows.length]);

  const failure = rollError ?? feed.error;

  return (
    <main style={{ maxWidth: 1120, margin: '0 auto', padding: '1rem' }}>
      <header style={{ marginBottom: '1rem' }}>
        <div style={{ fontSize: '0.75rem', letterSpacing: '0.14em' }}>KINO ROLL</div>
        <h1 style={{ margin: '0.25rem 0', fontSize: '1.25rem' }}>
          {roll?.title ?? slug} {roll?.status === 'live' ? 'LIVE' : (roll?.status.toUpperCase() ?? '')}
        </h1>
        {roll !== null ? (
          <div>
            {roll.photoCount} photos · {formattedDate(roll.createdAt)}
          </div>
        ) : null}
      </header>

      {failure !== null ? <p role="alert">{failure.message}</p> : null}
      {feed.captures.length === 0 && feed.loading ? <p>Loading Roll…</p> : null}
      {feed.captures.length === 0 && !feed.loading && failure === null ? <p>No photos yet.</p> : null}

      <div ref={scrollRef} style={{ height: '72vh', overflow: 'auto', contain: 'strict' }}>
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
                transform: `translateY(${String(virtualRow.start)}px)`,
                display: 'grid',
                gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`,
                gap: '0.5rem',
                paddingBottom: '0.5rem',
              }}
            >
              {(rows[virtualRow.index] ?? []).map((capture) => (
                <CaptureTile
                  key={capture.captureId}
                  slug={slug}
                  capture={capture}
                  downloadsEnabled={roll?.downloadsEnabled ?? false}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
