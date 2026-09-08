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
  /**
   * What the API said, when it said something a guest can act on — a PIN
   * lockout's wait, a closed roll, the server being down. From
   * `apiFailureMessage`, never a raw `Error.message`: `TypeError: Failed to
   * fetch` is not a sentence to put in front of a guest, and "check the
   * connection" is the right line for exactly that case.
   */
  reason?: string | null;
}

/**
 * The one line a guest sees when the roll did not answer. The raw error
 * message used to go here; `TypeError: Failed to fetch` tells a guest nothing
 * they can act on, and the connection is the thing they can check.
 */
export function LoadFailure({
  onRetry,
  offline = false,
  what = 'roll',
  reason = null,
}: LoadFailureProps) {
  const subject = what === 'photo' ? 'photo' : 'roll';
  const line = offline
    ? `You're offline. This ${subject} has not been loaded yet.`
    : (reason ?? 'Could not reach the roll. Check the connection.');
  return (
    <div className="roll-alert" role="alert">
      <span>{line}</span>
      <button type="button" onClick={onRetry}>Retry</button>
    </div>
  );
}
