import type { ReactNode } from 'react';
import kinoRoll from '../assets/kino-roll-dark.png';

/**
 * Guest chrome (issue #114). The controls are a moulded plate and the
 * photography runs on black between them, so the interface has a body and
 * the pictures have none. There is no LIVE lamp: arrivals announce
 * themselves by appearing, and the "N new" pill covers a scrolled guest.
 */

/** `Loft` — the roll's own name, trimmed to what a phone bar can hold. */
export function rollLabel(title: string | undefined, slug: string): string {
  const name = (title ?? '').trim();
  return name === '' ? slug : name;
}

/** `23.08.26` — the way a camera writes a date. */
export function shortDate(value: string | undefined): string {
  if (value === undefined) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${two(d.getFullYear() % 100)}`;
}

/** Zero-padded, so the count reads as a frame counter rather than a total. */
export function frameCount(n: number): string {
  return String(Math.max(0, n)).padStart(3, '0');
}

/**
 * The plate. `hidden` retracts it on the way down the roll; it is sticky
 * rather than in flow, so the space it gives up scrolls away with the
 * content instead of leaving a hole at the top of the screen.
 */
export function GuestBar({
  name,
  count,
  hidden = false,
  children,
}: {
  name: string;
  count: number;
  hidden?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="k-top" data-hidden={hidden || undefined}>
      <div className="k-top-row">
        <img className="k-mark" src={kinoRoll} alt="KINO Roll" />
        <span className="k-sep" aria-hidden="true" />
        <span className="k-roll-name">{name}</span>
        <span className="k-count">
          {frameCount(count)}
          <em>FR</em>
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * The end mark, printed only where the stream really ends. The count is there
 * because "End of roll" on its own is a full stop with no fact in it: after
 * four hundred screens the one thing a guest wants back is how far they came.
 */
export function SiteFooter({ count }: { count?: number }) {
  return (
    <footer className="k-end">
      <i aria-hidden="true" />
      End of roll{count === undefined ? '' : ` · ${String(count)} ${count === 1 ? 'frame' : 'frames'}`}
    </footer>
  );
}
