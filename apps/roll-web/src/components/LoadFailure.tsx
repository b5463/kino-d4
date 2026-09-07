export interface LoadFailureProps {
  onRetry(): void;
  /**
   * The phone has no network. Then the request did not fail — it never left,
   * and telling a guest to "check the connection" when their own phone
   * already knows there isn't one is the app blaming the venue for something
   * it can see for itself.
   */
  offline?: boolean;
  /** What did not load. The capture page says photo; the roll says roll. */
  what?: 'roll' | 'photo';
}

/**
 * The one line a guest sees when the roll did not answer. The raw error
 * message used to go here; `TypeError: Failed to fetch` tells a guest nothing
 * they can act on, and the connection is the thing they can check.
 */
export function LoadFailure({ onRetry, offline = false, what = 'roll' }: LoadFailureProps) {
  const subject = what === 'photo' ? 'photo' : 'roll';
  const line = offline
    ? `You're offline. This ${subject} has not been loaded yet.`
    : 'Could not reach the roll. Check the connection.';
  return (
    <div className="roll-alert" role="alert">
      <span>{line}</span>
      <button type="button" onClick={onRetry}>Retry</button>
    </div>
  );
}
