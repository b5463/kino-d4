export interface LoadFailureProps {
  onRetry(): void;
}

/**
 * The one line a guest sees when the roll did not answer. The raw error
 * message used to go here; `TypeError: Failed to fetch` tells a guest nothing
 * they can act on, and the connection is the thing they can check.
 */
export function LoadFailure({ onRetry }: LoadFailureProps) {
  return (
    <div className="roll-alert" role="alert">
      <span>Could not reach the roll. Check the connection.</span>
      <button type="button" onClick={onRetry}>Retry</button>
    </div>
  );
}
