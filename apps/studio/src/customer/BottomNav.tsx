export type CustomerPage = 'shoot' | 'photos' | 'roll' | 'kino';

const NAV: { id: CustomerPage; label: string }[] = [
  { id: 'shoot', label: 'Shoot' },
  { id: 'photos', label: 'Photos' },
  { id: 'roll', label: 'Roll' },
  { id: 'kino', label: 'KINO' },
];

/**
 * Four words on the last line of the page: three tasks from the left, the
 * object right-aligned. Current in ink, others grey. No rule, no accent, no
 * icons. Navigation is a cut.
 */
export function BottomNav({
  page,
  locked,
  onNavigate,
}: {
  page: CustomerPage;
  /** Nothing else is reachable while KINO is being updated. */
  locked: boolean;
  onNavigate: (p: CustomerPage) => void;
}) {
  return (
    <nav className="c-nav" aria-label="Sections">
      {NAV.map((item) => (
        <button
          key={item.id}
          type="button"
          className={item.id === 'kino' ? 'c-nav-kino' : undefined}
          aria-current={page === item.id ? 'page' : undefined}
          disabled={locked}
          onClick={() => onNavigate(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
