import type { ReactNode } from 'react';
import kinoRoll from '../assets/kino-roll-light.png';

/**
 * Guest chrome (issue #114). Four short rows above the first photograph
 * instead of a bar, a card and a tab strip: the mark, the roll's own id, and
 * three plain words. There is no LIVE lamp — arrivals announce themselves by
 * appearing, and the "N new" pill covers the case where the guest has
 * scrolled away from the head.
 */

/** `LOFT / 22.08.26` — the roll's identity the way the camera would write it. */
export function rollId(title: string | undefined, createdAt: string | undefined): string {
  const name = (title ?? '').trim().toUpperCase();
  const short = name.length > 18 ? `${name.slice(0, 17)}…` : name;
  if (createdAt === undefined) return short;
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return short;
  const two = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${two(d.getDate())}.${two(d.getMonth() + 1)}.${two(d.getFullYear() % 100)}`;
  return short === '' ? stamp : `${short} / ${stamp}`;
}

/** Zero-padded like a frame counter, so the count reads as camera data. */
export function frameCount(n: number): string {
  return String(Math.max(0, n)).padStart(3, '0');
}

export function GuestBar({ right }: { right?: ReactNode }) {
  return (
    <div className="k-top">
      <img className="k-mark" src={kinoRoll} alt="KINO Roll" />
      {right ?? null}
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="k-end">
      <span>KINO · FOUR LENSES. ONE PRESS.</span>
    </footer>
  );
}
