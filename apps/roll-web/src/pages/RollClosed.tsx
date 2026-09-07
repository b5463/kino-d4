import { shortDate } from '../components/SiteHeader';

export interface RollClosedProps {
  closedAt: string | null;
}

/**
 * `toLocaleString()` printed a raw locale timestamp down to the second —
 * "9/6/2026, 10:14:03 PM" — next to an Info tab and clock marks that write
 * every other date as `06.09.26`. One formatter, `shortDate`, writes them
 * all. The seconds were never information a guest wanted: what closing means
 * is "no more photographs after this day", not which second the host tapped.
 */
export function RollClosed({ closedAt }: RollClosedProps) {
  const date = closedAt === null ? '' : shortDate(closedAt);
  // "CLOSED — 07.09.26" was a stamp with no consequence in it. What closing
  // means to a guest is that the roll is finished and nothing new will land
  // while they wait, so the banner says that instead of leaving them to infer
  // it from a word borrowed from the host's vocabulary.
  return (
    <aside role="status" className="roll-closed">
      <b>Closed{date === '' ? '' : ` · ${date}`}</b>
      <span>No more photographs are coming. Everything here stays.</span>
    </aside>
  );
}

/** A roll that is closed or archived takes no more captures from the camera. */
export function rollAcceptsUploads(status: string | undefined): boolean {
  return status !== 'closed' && status !== 'archived';
}

/** The banner for a roll state that changes what a guest can expect. */
export function RollStateBanner({ status }: { status: string }) {
  if (status !== 'archived') return null;
  return (
    <aside role="status" className="roll-closed">
      <b>Archived</b>
      <span>This roll has been put away. Nothing new will arrive.</span>
    </aside>
  );
}
