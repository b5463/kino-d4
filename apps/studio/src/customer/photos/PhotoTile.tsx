import { useState } from 'react';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { clock } from '../copy';
import { useAlignedFrames } from '../shoot/useAlignedFrames';
import { useWiggleStep } from '../shoot/useWiggleStep';
import type { PhotoLike } from './photoGroups';

/**
 * One photograph in the grid. No border, no caption, no file id. A
 * wigglegram shows its first frame and snaps while the pointer rests on it;
 * a four-up becomes its four-frame strip. On touch, the first tap plays and
 * the second opens.
 */
export function PhotoTile({
  photo,
  thumbUrl,
  localFrames,
  fps,
  loop,
  onOpen,
}: {
  photo: PhotoLike;
  thumbUrl: string | null;
  /** Frames already in memory (a folder on this computer); the card path loads on hover. */
  localFrames?: (string | null)[];
  fps: number;
  loop: 'continuous' | 'bounce';
  onOpen: () => void;
}) {
  const reduced = useReducedMotion();
  const [hover, setHover] = useState(false);
  const loaded = useAlignedFrames(hover && !localFrames ? photo.id : null);
  const frames = localFrames ?? loaded.frames;
  const present = frames?.filter((f): f is string => f !== null) ?? [];
  const playing = hover && photo.kind === 'wiggle' && present.length > 1 && !reduced;
  const step = useWiggleStep(fps, loop, 'ltr', present.length, !playing);
  const still = thumbUrl ?? present[0] ?? null;
  const shown = playing ? present[step] ?? still : still;
  const strip = hover && photo.kind === 'quad' && present.length > 1;

  return (
    <button
      type="button"
      className="c-tile"
      aria-label={`${photo.kind === 'wiggle' ? 'Wigglegram' : 'Four-up'}${photo.ts !== null ? `, ${clock(photo.ts)}` : ''}${photo.favorite ? ', favourite' : ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      onClick={(e) => {
        // Touch: the first tap plays, the second opens.
        if (e.nativeEvent instanceof PointerEvent && e.nativeEvent.pointerType === 'touch' && !hover) {
          setHover(true);
          return;
        }
        onOpen();
      }}
    >
      {strip ? (
        <span className="c-strip" aria-hidden="true">
          {present.map((url) => (
            <img key={url} src={url} alt="" />
          ))}
        </span>
      ) : shown ? (
        <img src={shown} alt="" />
      ) : (
        <span className="c-tile-note">{loaded.error ? "Can't show this one" : ''}</span>
      )}
      {photo.favorite ? <span className="c-tile-fav" aria-hidden="true" /> : null}
      {photo.ts !== null ? <span className="c-tile-time">{clock(photo.ts)}</span> : null}
    </button>
  );
}
