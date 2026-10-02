import { useConnectionStore } from '../state/connectionStore';
import { useDeviceBusy } from '../state/deviceBusy';

/** Owners whose claim is Studio's own short round trip, not a long operation. */
const SHORT_OWNERS = new Set(['config', 'poll', 'sync', 'session-restart']);

/**
 * Whether the customer's controls should read as state only. True while a
 * long exclusive operation holds the link (an update, a restore, matching)
 * or while KINO is restarting; the status line already says which.
 */
export function useReadOnly(): boolean {
  const phase = useConnectionStore((s) => s.phase);
  const owner = useDeviceBusy((s) => s.owner);
  if (phase !== 'connected') return true;
  return owner !== null && !SHORT_OWNERS.has(owner);
}

/** The label of the long operation holding the link, for the status line. */
export function useBusyLabel(): string | null {
  return useDeviceBusy((s) => (s.owner && !SHORT_OWNERS.has(s.owner) ? s.label : null));
}
