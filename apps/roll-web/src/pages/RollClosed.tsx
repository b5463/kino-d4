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

/**
 * Whether the camera can still add to this roll.
 *
 * `live` is the only state that can. Five exist
 * (`packages/schemas/src/media.ts#ROLL_STATUSES`) and this used to name two of
 * the four that cannot, so a `draft` or `trash` roll told a guest that
 * photographs "appear here as the camera sends them" when nothing was coming.
 * Written the positive way round, an unknown status is treated as not
 * accepting rather than as live — a promise this app cannot keep is worse than
 * one line of caution.
 */
export function rollAcceptsUploads(status: string | undefined): boolean {
  return status === 'live';
}

/**
 * The banner for a roll state that changes what a guest can expect.
 *
 * `closed` has its own component above, because it carries a date. The other
 * three that are not `live` each say the one thing a guest needs; `live` and
 * anything unrecognised say nothing, which is the right amount for a roll that
 * is simply working.
 */
const ROLL_STATE_LINES: Record<string, { word: string; line: string }> = {
  draft: {
    word: 'Not open yet',
    line: 'The host has not opened this roll. Nothing is coming until they do.',
  },
  archived: {
    word: 'Archived',
    line: 'This roll has been put away. Nothing new will arrive.',
  },
  trash: {
    word: 'Deleted',
    line: 'This roll has been deleted. What is still here will go with it.',
  },
};

export function RollStateBanner({ status }: { status: string }) {
  const state = ROLL_STATE_LINES[status];
  if (state === undefined) return null;
  return (
    <aside role="status" className="roll-closed">
      <b>{state.word}</b>
      <span>{state.line}</span>
    </aside>
  );
}
