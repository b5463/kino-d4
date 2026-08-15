import { create } from 'zustand';
import type { LogEntry, LogSource } from '@kino/kdp';

// Bounded in-memory log. The cap keeps the DOM and memory flat during long
// sessions; EXPORT is the way to keep more.
const MAX_ENTRIES = 1500;

export type LogFilter = 'ALL' | 'P4' | 'CAM1' | 'CAM2' | 'CAM3' | 'CAM4' | 'POWER' | 'STORAGE' | 'PROTOCOL';

export const LOG_FILTERS: LogFilter[] = ['ALL', 'P4', 'CAM1', 'CAM2', 'CAM3', 'CAM4', 'POWER', 'STORAGE', 'PROTOCOL'];

const FILTER_TO_SOURCE: Record<Exclude<LogFilter, 'ALL'>, LogSource> = {
  P4: 'P4',
  CAM1: 'C1',
  CAM2: 'C2',
  CAM3: 'C3',
  CAM4: 'C4',
  POWER: 'PWR',
  STORAGE: 'SD',
  PROTOCOL: 'PROTO',
};

interface LogState {
  entries: LogEntry[];
  paused: boolean;
  filter: LogFilter;
}

let pendingWhilePaused: LogEntry[] = [];

export const useLogStore = create<LogState>(() => ({
  entries: [],
  paused: false,
  filter: 'ALL',
}));

export function appendLog(entry: LogEntry) {
  const { paused } = useLogStore.getState();
  if (paused) {
    pendingWhilePaused.push(entry);
    if (pendingWhilePaused.length > MAX_ENTRIES) {
      pendingWhilePaused.splice(0, pendingWhilePaused.length - MAX_ENTRIES);
    }
    return;
  }
  useLogStore.setState((s) => {
    const entries = [...s.entries, entry];
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    return { entries };
  });
}

export function setLogPaused(paused: boolean) {
  if (!paused && pendingWhilePaused.length > 0) {
    const flushed = pendingWhilePaused;
    pendingWhilePaused = [];
    useLogStore.setState((s) => {
      const entries = [...s.entries, ...flushed];
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
      return { entries, paused };
    });
    return;
  }
  useLogStore.setState({ paused });
}

export function clearLogs() {
  pendingWhilePaused = [];
  useLogStore.setState({ entries: [] });
}

export function setLogFilter(filter: LogFilter) {
  useLogStore.setState({ filter });
}

export function filterEntries(entries: LogEntry[], filter: LogFilter): LogEntry[] {
  if (filter === 'ALL') return entries;
  const src = FILTER_TO_SOURCE[filter];
  return entries.filter((e) => e.src === src);
}
