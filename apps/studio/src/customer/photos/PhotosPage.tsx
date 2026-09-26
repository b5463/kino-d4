import { useEffect, useMemo, useRef, useState } from 'react';
import type { CaptureSummary } from '@kino/kdp';
import { getDevice } from '../../app/session';
import { getThumbUrl, dropThumb } from '../../device/media';
import { startTether, stopTether, useTetherStore } from '../../device/tether';
import type { LocalCapture } from '../../device/localImport';
import { useDeviceStore } from '../../state/deviceStore';
import { framesByLens, localFrames } from '../shoot/useAlignedFrames';
import { PhotoTile } from './PhotoTile';
import { PhotoView } from './PhotoView';
import { arrivalsLine, filterPhotos, groupByDay, PHOTO_FILTERS } from './photoGroups';
import type { PhotoFilter } from './photoGroups';
import { usePhotoIndex } from './usePhotoIndex';

/** Tiles shown before scrolling asks for more. */
const PAGE = 24;
const THUMB_WORKERS = 2;

/**
 * Photos: the card's photographs by day, four across, newest first. A
 * wigglegram moves when the pointer rests on it. Arrivals wait behind one
 * line. "Save new photos to this computer" writes each new photo to a
 * folder as it lands. With a folder open instead of a camera the same page
 * shows the folder.
 */
export function PhotosPage({ local, onCloseLocal }: { local?: LocalCapture[]; onCloseLocal?: () => void }) {
  return local ? <LocalPhotos captures={local} onClose={onCloseLocal ?? (() => undefined)} /> : <CardPhotos />;
}

function CardPhotos() {
  const index = usePhotoIndex();
  const config = useDeviceStore((s) => s.config);
  const rollView = useDeviceStore((s) => s.roll);
  const tether = useTetherStore();
  const [filter, setFilter] = useState<PhotoFilter>('all');
  const [shownCount, setShownCount] = useState(PAGE);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<CaptureSummary | null>(null);
  const inFlight = useRef(new Set<string>());
  const sentinel = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => filterPhotos(index.photos ?? [], filter), [index.photos, filter]);
  const slice = useMemo(() => groupByDay(visible.slice(0, shownCount)), [visible, shownCount]);
  const wantIds = useMemo(() => visible.slice(0, shownCount).map((p) => p.id).join(','), [visible, shownCount]);

  // Thumbnails for the tiles on screen, two at a time; the link is small.
  useEffect(() => {
    const dev = getDevice();
    if (!dev || wantIds === '') return;
    const queue = wantIds.split(',').filter((id) => !thumbs[id] && !inFlight.current.has(id));
    if (queue.length === 0) return;
    queue.forEach((id) => inFlight.current.add(id));
    let cancelled = false;
    const worker = async () => {
      while (!cancelled && queue.length > 0) {
        const id = queue.shift()!;
        try {
          const url = await getThumbUrl(dev, id);
          if (!cancelled) setThumbs((t) => ({ ...t, [id]: url }));
        } catch {
          // The tile stays paper; opening it still tries the frames.
        } finally {
          inFlight.current.delete(id);
        }
      }
    };
    void Promise.all(Array.from({ length: THUMB_WORKERS }, worker));
    return () => {
      cancelled = true;
      queue.forEach((id) => inFlight.current.delete(id));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantIds]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setShownCount((n) => n + PAGE);
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const rollActive = rollView?.active === true && rollView.roll !== null;

  return (
    <section aria-label="Photos">
      <div className="c-photos-tools">
        <span role="radiogroup" aria-label="Show" className="c-inline-looks">
          {PHOTO_FILTERS.map((f) => (
            <button key={f.id} type="button" role="radio" className={f.id === filter ? 'c-word' : 'c-word c-word--quiet'} aria-checked={f.id === filter} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </span>
        <button type="button" className="c-photos-save c-word c-word--quiet" aria-pressed={tether.enabled} onClick={() => (tether.enabled ? stopTether() : void startTether())}>
          {tether.enabled ? `Saving new photos to ${tether.target}` : 'Save new photos to this computer'}
        </button>
      </div>
      {tether.lastError ? <p className="c-photos-new c-grey">A photo didn't save to this computer. {tether.lastError}</p> : null}
      {index.pending.length > 0 ? (
        <p className="c-photos-new">
          <button type="button" onClick={index.reveal}>
            {arrivalsLine(index.pending.length)}
          </button>
        </p>
      ) : null}
      {index.error ? <p className="c-photos-empty">KINO couldn't read the card. {index.error}</p> : null}
      {index.photos && visible.length === 0 ? (
        <p className="c-photos-empty">{filter === 'favorites' ? 'No favourites yet.' : 'No photos on the card yet. Press the shutter to take one.'}</p>
      ) : null}
      {slice.map((group) => (
        <div key={group.label}>
          <h2 className="c-day">{group.label}</h2>
          <div className="c-grid">
            {group.items.map((photo) => (
              <PhotoTile key={photo.id} photo={photo} thumbUrl={thumbs[photo.id] ?? null} fps={config?.wiggle.fps ?? 10} loop="continuous" onOpen={() => setOpen(photo)} />
            ))}
          </div>
        </div>
      ))}
      <div className="c-photos-more" ref={sentinel} aria-hidden="true" />
      {open ? (
        <PhotoView
          summary={open}
          rollActive={rollActive}
          onClose={() => setOpen(null)}
          onChanged={(change) => {
            if (change === 'deleted') {
              dropThumb(open.id);
              index.update(open.id, null);
              setOpen(null);
            } else {
              index.update(open.id, { favorite: change === 'favourite' });
              setOpen((o) => (o ? { ...o, favorite: change === 'favourite' } : o));
            }
          }}
        />
      ) : null}
    </section>
  );
}

function LocalPhotos({ captures, onClose }: { captures: LocalCapture[]; onClose: () => void }) {
  const [open, setOpen] = useState<LocalCapture | null>(null);
  const frames = useMemo(() => new Map(captures.map((c) => [c.summary.id, framesByLens(localFrames(c.frames))])), [captures]);
  useEffect(
    () => () => {
      for (const list of frames.values()) list.forEach((u) => u && URL.revokeObjectURL(u));
    },
    [frames],
  );
  const groups = groupByDay(captures.map((c) => c.summary));
  return (
    <section aria-label="Photos from a folder">
      <div className="c-photos-tools">
        <span className="c-word">Photos from a folder</span>
        <button type="button" className="c-photos-save c-word c-word--quiet" onClick={onClose}>
          Close
        </button>
      </div>
      {groups.map((group) => (
        <div key={group.label}>
          <h2 className="c-day">{group.label}</h2>
          <div className="c-grid">
            {group.items.map((photo) => (
              <PhotoTile key={photo.id} photo={photo} thumbUrl={null} localFrames={frames.get(photo.id)} fps={10} loop="continuous" onOpen={() => setOpen(captures.find((c) => c.summary.id === photo.id) ?? null)} />
            ))}
          </div>
        </div>
      ))}
      {open ? <PhotoView summary={open.summary} local={open} rollActive={false} onClose={() => setOpen(null)} onChanged={() => undefined} /> : null}
    </section>
  );
}
