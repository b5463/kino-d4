import { create } from 'zustand';
import { useDeviceStore } from './deviceStore';
import { useConnectionStore } from './connectionStore';

/**
 * Bench results live here, not in the panel that produced them.
 *
 * Same failure the drafts store fixes, with worse consequences: the pages are
 * mounted and unmounted by a plain page swap, so a result held in component
 * state died on the next sidebar click — a 50-capture timing run and the
 * EXPORT button that would have saved it, gone, with no warning and no way to
 * get the numbers back short of running the bench again.
 *
 * Every entry carries the wall clock the run finished at, because two panels
 * printing contradictory verdicts with no timestamps is worse than one panel:
 * SENSOR PHASE read 1.73 ms USABLE while TIMING BENCH 400 px below still read
 * 21.76 ms NOT ACCEPTABLE from before the re-phase, and both looked current.
 *
 * `staleReason` is the other half of that. A re-phase, a reboot, a baud change
 * or a calibration write does not make an old reading wrong on the page — it
 * makes it a lie by omission. When one of those happens the reading says so in
 * text, and keeps its numbers so the run can still be exported.
 */

export type BenchOwner =
  | 'timing'
  | 'phase'
  | 'link'
  | 'storage'
  | 'burnin'
  | 'conformance'
  | 'skew'
  | 'power';

export const BENCH_OWNERS: BenchOwner[] = [
  'timing',
  'phase',
  'link',
  // SD throughput. Card-owned rather than link-owned, but it goes stale for
  // the same reasons: swap the card or reboot and the numbers describe a
  // device that is no longer there.
  'storage',
  'burnin',
  'conformance',
  // The Skew Bench, Calibration's product surface. It is here rather than in
  // its own store for the reason the rest are: Overview prints its verdict,
  // and a verdict that survives a page swap has to say when it was measured
  // and whether anything since invalidated it.
  'skew',
  // The power-load ladder. Its rows are measured battery volts under a named
  // activity, so a reboot or a link drop invalidates them for the same reason
  // it invalidates the timing runs — the load that produced them is gone.
  'power',
];

export interface BenchEntry<T = unknown> {
  result: T;
  /** Wall clock when the run finished, ms since epoch. */
  ranAt: number;
  /** Non-null once something happened that invalidates this reading. */
  staleReason: string | null;
}

interface BenchState {
  entries: Partial<Record<BenchOwner, BenchEntry>>;
}

export const useBenchStore = create<BenchState>(() => ({ entries: {} }));

/** Reactive read for a panel. */
export function useBenchResult<T>(owner: BenchOwner): BenchEntry<T> | null {
  return useBenchStore((s) => (s.entries[owner] as BenchEntry<T> | undefined) ?? null);
}

/** Non-reactive read, for exports and cross-panel readouts. */
export function getBenchResult<T>(owner: BenchOwner): BenchEntry<T> | null {
  return (useBenchStore.getState().entries[owner] as BenchEntry<T> | undefined) ?? null;
}

/** A finished run. Always fresh: whatever made it stale happened before it. */
export function putBenchResult<T>(owner: BenchOwner, result: T, ranAt = Date.now()): void {
  useBenchStore.setState((s) => ({
    entries: { ...s.entries, [owner]: { result, ranAt, staleReason: null } },
  }));
}

/** Drop one result — a run has started and the old numbers are not it. */
export function clearBenchResult(owner: BenchOwner): void {
  useBenchStore.setState((s) => {
    if (!(owner in s.entries)) return s;
    const entries = { ...s.entries };
    delete entries[owner];
    return { entries };
  });
}

/**
 * Mark results stale. Numbers are kept — they were measured, and the export
 * still has to work — but the panel now prints the reason they cannot be
 * trusted. First reason wins: the earliest invalidation is the one that
 * explains the drift.
 */
export function invalidateBench(owners: BenchOwner[], reason: string): void {
  useBenchStore.setState((s) => {
    let touched = false;
    const entries = { ...s.entries };
    for (const owner of owners) {
      const entry = entries[owner];
      if (!entry || entry.staleReason !== null) continue;
      entries[owner] = { ...entry, staleReason: reason };
      touched = true;
    }
    return touched ? { entries } : s;
  });
}

export function resetBenchResults(): void {
  useBenchStore.setState({ entries: {} });
}

/** HH:MM:SS local. Bench runs are minutes apart, not days. */
export function formatRanAt(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * The one line every bench panel prints under its result, so no two panels
 * can both look current.
 */
export function benchStamp(entry: BenchEntry | null): { text: string; stale: boolean } | null {
  if (!entry) return null;
  const ran = `RAN ${formatRanAt(entry.ranAt)}`;
  if (!entry.staleReason) return { text: ran, stale: false };
  return { text: `${ran} · STALE: ${entry.staleReason}. Re-run before trusting it.`, stale: true };
}

// ---- automatic invalidation the panels cannot see themselves ----

// A reboot restarts every sensor and every UART, so nothing measured before
// it still describes the device. Uptime running backwards is the only signal
// that survives a reconnect, and it catches recovery mode and firmware
// updates as well as a power cycle.
let lastUptimeS: number | null = null;
useDeviceStore.subscribe((s) => {
  const up = s.stats?.uptimeS ?? null;
  if (up === null) {
    lastUptimeS = null;
    return;
  }
  if (lastUptimeS !== null && up < lastUptimeS) {
    invalidateBench(BENCH_OWNERS, 'KINO rebooted after this run');
  }
  lastUptimeS = up;
});

// A dropped link is not proof the device changed, so the numbers stay — but
// they describe a session that ended. `recovery` is the clearest case of all:
// the board was told to reboot and never answered again, so whatever it is
// doing now, it is not the run these numbers came from.
useConnectionStore.subscribe((s, prev) => {
  if (s.phase === prev.phase) return;
  if (s.phase === 'disconnected' || s.phase === 'error' || s.phase === 'recovery') {
    invalidateBench(BENCH_OWNERS, 'the link dropped after this run');
  }
});
