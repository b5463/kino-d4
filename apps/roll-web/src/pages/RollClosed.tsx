export interface RollClosedProps {
  closedAt: string | null;
}

export function RollClosed({ closedAt }: RollClosedProps) {
  const date = closedAt === null ? 'date unavailable' : new Date(closedAt).toLocaleString();
  return (
    <aside role="status" style={{ padding: '0.6rem', border: '1px solid currentColor' }}>
      CLOSED — {date}
    </aside>
  );
}
