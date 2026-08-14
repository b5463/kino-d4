import { create } from 'zustand';

/**
 * A single exclusive claim on the camera link.
 *
 * Every bench used to own a private `running` flag and consult none of the
 * others, so four could run at once on one UART — burn-in reported
 * 17–21 KB/s while the link bench reported 78–174 KB/s for the same link in
 * the same window. Contended numbers presented as measurement is worse than
 * no measurement, so long operations take this claim and everything else
 * disables itself with the reason.
 */
interface BusyState {
  /** Stable id of the current owner, or null when the link is free. */
  owner: string | null;
  /** Human-readable label for the status bar and disabled reasons. */
  label: string | null;
}

export const useDeviceBusy = create<BusyState>(() => ({ owner: null, label: null }));

/** Take the claim. Returns false when someone else already holds it. */
export function claimDevice(owner: string, label: string): boolean {
  const current = useDeviceBusy.getState().owner;
  if (current !== null && current !== owner) return false;
  useDeviceBusy.setState({ owner, label });
  return true;
}

export function releaseDevice(owner: string): void {
  if (useDeviceBusy.getState().owner !== owner) return;
  useDeviceBusy.setState({ owner: null, label: null });
}

/** Cleared on disconnect so a dropped link never leaves a stuck claim. */
export function resetDeviceBusy(): void {
  useDeviceBusy.setState({ owner: null, label: null });
}

/**
 * True when another operation holds the link. Pass your own owner id so a
 * running bench doesn't disable its own STOP button.
 */
export function blockedBy(owner: string): string | null {
  const s = useDeviceBusy.getState();
  return s.owner && s.owner !== owner ? s.label : null;
}

/** Reactive variant for components. */
export function useBlockedBy(owner: string): string | null {
  return useDeviceBusy((s) => (s.owner && s.owner !== owner ? s.label : null));
}
