import { useCallback, useEffect, useRef, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/Button';
import { useConnectionStore } from '../../state/connectionStore';
import { supportsRollUpload, useDeviceStore } from '../../state/deviceStore';
import { getDevice, onCaptureEvent } from '../../app/session';
import { getThumbUrl, dropThumb } from '../../device/media';
import { useTetherStore, startTether, stopTether } from '../../device/tether';
import type { CaptureSummary } from '@kino/kdp';
import type { RollView } from '../../roll/rollTypes';
import { CaptureInspector } from './CaptureInspector';
import {
  GALLERY_LIST_CAP,
  GALLERY_PAGE_SIZE as PAGE_SIZE,
  clampGalleryPage,
  galleryPageCount,
  galleryPageSlice,
  galleryView,
  nextGalleryListLimit,
} from './galleryPaging';
import type { GalleryFilter as Filter, GallerySort as Sort } from './galleryPaging';

/** Concurrent thumbnail reads. The P4 is a small computer. */
const THUMB_WORKERS = 2;

function formatWhen(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** Enough of a failure to act on, short enough for a 190px tile. */
function shortReason(reason: string): string {
  const first = reason.split('\n')[0].trim();
  return first.length > 46 ? `${first.slice(0, 45)}…` : first;
}

export function GalleryPage() {
  const phase = useConnectionStore((s) => s.phase);
  // `captures` is the list you are looking at and it does not move on its
  // own. Anything that lands on the card while you are here waits in
  // `pending` until you ask for it — a NEWEST FIRST grid that inserts at the
  // top means the card under the cursor is not the card you clicked.
  const [captures, setCaptures] = useState<CaptureSummary[] | null>(null);
  const [pending, setPending] = useState<CaptureSummary[]>([]);
  /** Total the camera reports for the card, independent of what is shown. */
  const [total, setTotal] = useState<number | null>(null);
  const [indexBusy, setIndexBusy] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [thumbErrors, setThumbErrors] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('newest');
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [rollView, setRollView] = useState<RollView | null>(null);
  const rollUpload = useDeviceStore(supportsRollUpload);
  const [thumbBusy, setThumbBusy] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  const alive = useRef(true);
  const thumbsRef = useRef<Record<string, string>>({});
  const thumbErrorsRef = useRef<Record<string, string>>({});
  const inFlight = useRef<Set<string>>(new Set());
  const capturesRef = useRef<CaptureSummary[] | null>(null);
  const listLimitRef = useRef(GALLERY_LIST_CAP);
  capturesRef.current = captures;

  /**
   * `replace` rebuilds the visible list (first load, manual retry).
   * `merge` keeps it in place: entries still on the card are refreshed,
   * deleted ones drop out, and arrivals go to the SHOW row.
   */
  const load = useCallback(async (mode: 'replace' | 'merge', listLimit = listLimitRef.current) => {
    const dev = getDevice();
    if (!dev) return;
    setError(null);
    setIndexBusy(true);
    try {
      // Paginated: the wire contract never assumes the whole card fits in
      // one response. Studio pulls pages until the card is covered.
      const all: CaptureSummary[] = [];
      let cursor: number | null = 0;
      let reported: number | null = null;
      while (cursor !== null && alive.current) {
        const chunk = await dev.mediaList({ cursor, limit: 100 });
        if (reported === null) reported = chunk.total;
        all.push(...chunk.items);
        cursor = chunk.hasMore ? chunk.nextCursor : null;
        if (all.length >= listLimit) break;
      }
      if (!alive.current) return;
      setTotal(reported ?? all.length);
      const shown = capturesRef.current;
      if (mode === 'replace' || shown === null) {
        setCaptures(all);
        setPending([]);
        return;
      }
      const onCard = new Map(all.map((c) => [c.id, c]));
      const kept = shown.map((c) => onCard.get(c.id)).filter((c): c is CaptureSummary => c !== undefined);
      const keptIds = new Set(kept.map((c) => c.id));
      setCaptures(kept);
      setPending(all.filter((c) => !keptIds.has(c.id)));
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setIndexBusy(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load('replace');
    return () => {
      alive.current = false;
    };
  }, [load]);

  // New captures committed while connected are counted, not inserted.
  useEffect(() => onCaptureEvent(() => void load('merge')), [load]);

  // "Push to Roll" (02 §16) only exists while the camera is on a Roll, so the
  // gallery has to know. Read once per visit, and again whenever the inspector
  // opens — leaving a Roll from the Roll page must not leave a live button here.
  useEffect(() => {
    if (!rollUpload) {
      setRollView(null);
      return;
    }
    const dev = getDevice();
    if (!dev) return;
    let cancelled = false;
    void dev
      .rollStatus()
      .then((view) => {
        if (!cancelled) setRollView(view);
      })
      // A camera that cannot answer ROLL_STATUS simply has no Roll to push to.
      .catch(() => {
        if (!cancelled) setRollView(null);
      });
    return () => {
      cancelled = true;
    };
  }, [rollUpload, openId]);

  const tether = useTetherStore();

  const visible = galleryView(captures ?? [], filter, sort);
  const pageCount = galleryPageCount(visible);
  const current = clampGalleryPage(visible, page);
  const from = current * PAGE_SIZE;
  const slice = galleryPageSlice(visible, page);
  const pageKey = slice.map((c) => c.id).join(',');

  // Thumbnails are fetched for the page you are on, two at a time. Fetching
  // all 94 up front spent the link on cards nobody had scrolled to.
  useEffect(() => {
    const dev = getDevice();
    if (!dev || pageKey === '') return;
    const need = pageKey
      .split(',')
      .filter((id) => !thumbsRef.current[id] && !thumbErrorsRef.current[id] && !inFlight.current.has(id));
    if (need.length === 0) return;
    need.forEach((id) => inFlight.current.add(id));
    setThumbBusy((n) => n + need.length);
    const queue = [...need];
    const worker = async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id) return;
        try {
          const url = await getThumbUrl(dev, id);
          thumbsRef.current[id] = url;
          if (alive.current) setThumbs((t) => (t[id] ? t : { ...t, [id]: url }));
        } catch (err) {
          // A failed thumbnail used to leave the tile reading LOADING… for
          // the rest of the session. It now says what happened and can be
          // asked again.
          const reason = err instanceof Error ? err.message : String(err);
          thumbErrorsRef.current[id] = reason;
          if (alive.current) setThumbErrors((e) => ({ ...e, [id]: reason }));
        } finally {
          inFlight.current.delete(id);
          if (alive.current) setThumbBusy((n) => Math.max(0, n - 1));
        }
      }
    };
    void Promise.all(Array.from({ length: THUMB_WORKERS }, () => worker()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey, retryTick]);

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

  const openCapture = captures?.find((c) => c.id === openId) ?? null;
  const failedHere = slice.filter((c) => thumbErrors[c.id]).length;

  const retryThumbs = () => {
    for (const cap of slice) {
      delete thumbErrorsRef.current[cap.id];
    }
    setThumbErrors((e) => {
      const next = { ...e };
      for (const cap of slice) delete next[cap.id];
      return next;
    });
    setRetryTick((n) => n + 1);
  };

  const showPending = () => {
    setCaptures((shown) => [...(shown ?? []), ...pending]);
    setPending([]);
    setPage(0);
  };

  const shownCount = captures?.length ?? 0;
  const canListMore = total !== null && shownCount < total;
  const listMore = () => {
    if (total === null || indexBusy) return;
    const nextLimit = nextGalleryListLimit(listLimitRef.current, total);
    listLimitRef.current = nextLimit;
    void load('replace', nextLimit);
  };

  return (
    <>
      <div className="pagehead">
        <h1>
          <Icon name="gallery" />
          Gallery
        </h1>
        <span className="pagehead-actions">
          {thumbBusy > 0 ? <span className="microlabel">READING {thumbBusy} THUMBNAILS</span> : null}
          <span className="microlabel">
            {captures === null
              ? 'READING CARD…'
              : total !== null && total !== shownCount
                ? `${shownCount} LISTED · ${total} ON CARD`
                : `${shownCount} CAPTURES ON CARD`}
          </span>
          {canListMore ? (
            <Button size="sm" disabled={indexBusy} onClick={listMore}>
              {indexBusy ? 'READING INDEX…' : `LIST ${Math.min(GALLERY_LIST_CAP, total! - shownCount)} MORE`}
            </Button>
          ) : null}
        </span>
      </div>

      {tether.lastError ? <p className="notice notice--err">Tether: {tether.lastError}</p> : null}
      {error ? (
        <p className="notice notice--err">
          Could not read the card index: {error}
          <Button size="sm" onClick={() => void load('replace')} style={{ marginLeft: 'auto' }}>
            RETRY
          </Button>
        </p>
      ) : null}

      {pending.length > 0 ? (
        <p className="notice">
          <span>
            <strong>
              {pending.length} NEW {pending.length === 1 ? 'CAPTURE' : 'CAPTURES'} ON THE CARD
            </strong>{' '}
            — the list below has not moved.
          </span>
          <Button size="sm" variant="primary" onClick={showPending} style={{ marginLeft: 'auto' }}>
            SHOW
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
              onClick={() => {
                setFilter(value);
                setPage(0);
              }}
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
              onClick={() => {
                setSort(value);
                setPage(0);
              }}
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
        <>
          <div className="gallery-grid">
            {slice.map((cap) => {
              const failure = thumbErrors[cap.id];
              return (
                <button key={cap.id} type="button" className="capturecard" onClick={() => setOpenId(cap.id)}>
                  <span className="capturecard-thumb">
                    {thumbs[cap.id] ? (
                      <img src={thumbs[cap.id]} alt={`${cap.id} preview`} />
                    ) : failure ? (
                      // `.faint` is --text-faint, which measures 2.48:1 on the
                      // dark well. Muted text in a dark well takes the light
                      // end of the ramp instead.
                      <span
                        className="mono"
                        style={{ color: 'var(--text-on-dark)', fontSize: 10, textAlign: 'center', padding: '0 6px' }}
                        title={failure}
                      >
                        NO THUMBNAIL
                        <br />
                        {shortReason(failure)}
                      </span>
                    ) : (
                      <span className="mono" style={{ color: 'var(--text-on-dark)', fontSize: 10 }}>
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
              );
            })}
          </div>

          {/* One page is 24 cards and 24 tab stops. The whole card used to be
              one run of 94. */}
          <div
            className="gallery-tools"
            style={{
              marginTop: 'var(--pad)',
              marginBottom: 0,
              justifyContent: 'flex-start',
              display: slice.length === 0 ? 'none' : undefined,
            }}
          >
            <span className="microlabel">
              SHOWING {from + 1}–{from + slice.length} OF {visible.length}
              {visible.length !== shownCount ? ` MATCHING · ${shownCount} LISTED` : ''}
              {total !== null && total !== shownCount ? ` · ${total} ON CARD` : ''}
            </span>
            {failedHere > 0 ? (
              <Button size="sm" onClick={retryThumbs}>
                RETRY {failedHere} {failedHere === 1 ? 'THUMBNAIL' : 'THUMBNAILS'}
              </Button>
            ) : null}
            {pageCount > 1 ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
                <Button size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}>
                  ‹ PREVIOUS
                </Button>
                <span className="microlabel">
                  PAGE {current + 1} OF {pageCount}
                </span>
                <Button size="sm" disabled={current >= pageCount - 1} onClick={() => setPage(current + 1)}>
                  NEXT ›
                </Button>
              </span>
            ) : null}
          </div>
        </>
      )}

      {openCapture ? (
        <CaptureInspector
          summary={openCapture}
          roll={rollView}
          onClose={() => setOpenId(null)}
          onChanged={(change) => {
            if (change === 'deleted') {
              dropThumb(openCapture.id);
              delete thumbsRef.current[openCapture.id];
              setOpenId(null);
            }
            void load('merge');
          }}
        />
      ) : null}
    </>
  );
}
