export type LedState = 'ok' | 'warn' | 'err' | 'busy' | 'off';

// Status LED. Always paired with a text label — state is never color-only.
export function Led({ state, label }: { state: LedState; label: string }) {
  return (
    <span className={`led led--${state}`}>
      <span className="led-dot" aria-hidden="true" />
      <span className="led-label">{label}</span>
    </span>
  );
}
