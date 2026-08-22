import type { LogEntry } from '@kino/kdp';

const ENCODER = new TextEncoder();

/**
 * The newest log entries that fit a byte budget, oldest-first.
 *
 * Same rule as the firmware (firmware/p4/main/klog.c): a GET_LOGS reply
 * larger than one KDP frame is undeliverable — the encoder refuses it and
 * the client would only ever see a timeout — and when something has to go,
 * the oldest entries are the ones a debugging session misses least
 * (issue #80).
 */
export function fitLogEntries(entries: readonly LogEntry[], budgetBytes: number): LogEntry[] {
  const kept: LogEntry[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    // Exact serialized cost of this entry plus its separating comma.
    const cost = ENCODER.encode(JSON.stringify(entries[i])).length + 1;
    if (used + cost > budgetBytes) break;
    used += cost;
    kept.unshift(entries[i]);
  }
  return kept;
}
