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
