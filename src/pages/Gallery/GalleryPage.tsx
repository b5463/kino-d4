import { useCallback, useEffect, useRef, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/Button';
import { useConnectionStore } from '../../state/connectionStore';
import { getDevice, onCaptureEvent } from '../../app/session';
import { getThumbUrl, dropThumb } from '../../device/media';
import { useTetherStore, startTether, stopTether } from '../../device/tether';
import type { CaptureSummary } from '../../protocol/types';
import { CaptureInspector } from './CaptureInspector';

type Filter = 'all' | 'wiggle' | 'quad' | 'favorites';
type Sort = 'newest' | 'oldest';

function formatWhen(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export function GalleryPage() {
  const phase = useConnectionStore((s) => s.phase);
  const [captures, setCaptures] = useState<CaptureSummary[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('newest');
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // Two-at-a-time thumbnail fetches over a 40-capture card take a while; the
  // per-card LOADING… labels never add up to an overall signal.
  const [thumbLoad, setThumbLoad] = useState({ done: 0, total: 0 });
  const alive = useRef(true);
  const thumbsRef = useRef<Record<string, string>>({});

  const reload = useCallback(async () => {
    const dev = getDevice();
    if (!dev) return;
    setError(null);
    try {
      // Paginated: the wire contract never assumes the whole card fits in
      // one response. Studio pulls pages until the card is covered.
      const all: CaptureSummary[] = [];
      let cursor: number | null = 0;
      while (cursor !== null && alive.current) {
        const page = await dev.mediaList({ cursor, limit: 100 });
        all.push(...page.items);
        cursor = page.hasMore ? page.nextCursor : null;
        if (all.length > 5000) break; // sanity stop
      }
      if (!alive.current) return;
      setCaptures(all);
      // Fetch thumbnails two at a time; the P4 is a small computer. Anything
      // already held stays out of the queue and counts as done, so a reload
      // does not restart the progress readout from zero.
      const queue = all.filter((c) => !thumbsRef.current[c.id]);
      setThumbLoad({ done: all.length - queue.length, total: all.length });
      const worker = async () => {
        while (queue.length > 0) {
          const cap = queue.shift();
          if (!cap || !alive.current) return;
          try {
            const url = await getThumbUrl(dev, cap.id);
            thumbsRef.current[cap.id] = url;
            if (alive.current) setThumbs((t) => (t[cap.id] ? t : { ...t, [cap.id]: url }));
          } catch {
            // Thumb failures are cosmetic; the card still opens.
          }
          // Failures count too — the readout tracks attempts, not successes,
          // so it always reaches its total and disappears.
          if (alive.current) setThumbLoad((p) => ({ ...p, done: p.done + 1 }));
        }
      };
      void Promise.all([worker(), worker()]);
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  // New captures committed while connected appear without a manual refresh.
  useEffect(() => onCaptureEvent(() => void reload()), [reload]);

  const tether = useTetherStore();

  if (phase !== 'connected' && phase !== 'maintenance') {
    return (
      <div className="pagehead">
        <h1>
          <Icon name="gallery" />
          Gallery
        </h1>
      </div>
    );
  }

  const visible = (captures ?? [])
    .filter((c) =>
      filter === 'all' ? true : filter === 'favorites' ? c.favorite : c.kind === filter,
    )
    .sort((a, b) => (sort === 'newest' ? b.ts - a.ts : a.ts - b.ts));

  const openCapture = captures?.find((c) => c.id === openId) ?? null;

  return (
    <>
      <div className="pagehead">
        <h1>
          <Icon name="gallery" />
          Gallery
        </h1>
        <span className="pagehead-actions">
          {thumbLoad.total > 0 && thumbLoad.done < thumbLoad.total ? (
            <span className="microlabel">
              THUMBNAILS {thumbLoad.done}/{thumbLoad.total}
            </span>
          ) : null}
          <span className="microlabel">
            {captures ? `${captures.length} CAPTURES ON CARD` : 'READING CARD…'}
          </span>
        </span>
      </div>

      {tether.lastError ? <p className="notice notice--err">Tether: {tether.lastError}</p> : null}
      {error ? (
        <p className="notice notice--err">
          Could not read the card index: {error}
          <Button size="sm" onClick={() => void reload()} style={{ marginLeft: 'auto' }}>
            RETRY
          </Button>
        </p>
      ) : null}

      <div className="gallery-tools">
        <span className="seg" role="group" aria-label="Filter">
          {(
            [
              ['all', 'ALL'],
              ['wiggle', 'WIGGLES'],
              ['quad', 'QUAD SETS'],
              ['favorites', 'FAVORITES'],
            ] as [Filter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="seg-opt"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          <Button
            size="sm"
            variant={tether.enabled ? 'primary' : 'default'}
            onClick={() => (tether.enabled ? stopTether() : void startTether())}
            title="Automatically download every new capture to this computer"
          >
            {tether.enabled ? `TETHER → ${tether.target}` : 'TETHER OFF'}
          </Button>
          {tether.enabled ? (
            <span className="microlabel">
              {tether.saving ? `SAVING ${tether.saving}…` : `${tether.savedCount} SAVED`}
            </span>
          ) : null}
        </span>
        <span className="seg" role="group" aria-label="Sort order">
          {(
            [
              ['newest', 'NEWEST FIRST'],
              ['oldest', 'OLDEST FIRST'],
            ] as [Sort, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="seg-opt"
              aria-pressed={sort === value}
              onClick={() => setSort(value)}
            >
              {label}
            </button>
          ))}
        </span>
      </div>

      {captures && visible.length === 0 ? (
        <Panel title="NOTHING HERE">
          <p className="dim">
            {filter === 'favorites' ? 'No favorites.' : 'No captures match this filter.'}
          </p>
        </Panel>
      ) : (
        <div className="gallery-grid">
          {visible.map((cap) => (
            <button key={cap.id} type="button" className="capturecard" onClick={() => setOpenId(cap.id)}>
              <span className="capturecard-thumb">
                {thumbs[cap.id] ? (
                  <img src={thumbs[cap.id]} alt={`${cap.id} preview`} />
                ) : (
                  <span className="faint mono" style={{ fontSize: 10 }}>
                    LOADING…
                  </span>
                )}
                <span className="capturecard-kind">{cap.kind === 'wiggle' ? 'WIGGLE' : 'QUAD'}</span>
                {cap.favorite ? (
                  <span className="capturecard-fav" aria-label="Favorite">
                    ♥
                  </span>
                ) : null}
              </span>
              <span className="capturecard-meta">
                <span className="capturecard-id">{cap.id}</span>
                <span className="capturecard-sub">{formatWhen(cap.ts)}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {openCapture ? (
        <CaptureInspector
          summary={openCapture}
          onClose={() => setOpenId(null)}
          onChanged={(change) => {
            if (change === 'deleted') {
              dropThumb(openCapture.id);
              delete thumbsRef.current[openCapture.id];
              setOpenId(null);
            }
            void reload();
          }}
        />
      ) : null}
    </>
  );
}
