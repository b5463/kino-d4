export interface RollClosedProps {
  closedAt: string | null;
}

export function RollClosed({ closedAt }: RollClosedProps) {
  const date = closedAt === null ? 'date unavailable' : new Date(closedAt).toLocaleString();
  return (
    <aside role="status" className="roll-closed">
      CLOSED — {date}
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
      This roll is archived.
    </aside>
  );
}
