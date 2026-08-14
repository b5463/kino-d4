import { useCallback, useEffect, useRef, useState } from 'react';
import { getDraftEntry, putDraftEntry, setDraftDirty, useDraftStore } from '../state/draftStore';
import type { DraftEntry } from '../state/draftStore';

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Differing leaf fields between two config objects. The discard confirmation
 * says how much work is about to be thrown away, so it has to be a real
 * count, not the number of top-level keys.
 */
export function countChanges(a: unknown, b: unknown): number {
  if (deepEqual(a, b)) return 0;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return 1;
  if (Array.isArray(a) !== Array.isArray(b)) return 1;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let n = 0;
  for (const key of keys) {
    n += countChanges((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]);
  }
  return n;
}

/**
 * Local editable copy of device-reported state. The draft re-syncs whenever
 * the device value changes *and* the user has no pending edits — device
 * truth never silently overwrites unsaved work.
 *
 * Pass `persist` to keep the draft alive across page navigation and to have
 * the section show an unsaved marker while you are elsewhere. `key` may carry
 * an instance suffix (`looks:party-neg`) when one page edits several things.
 */
export function useDraft<T>(source: T | null, persist?: { key: string; label: string }) {
  const key = persist?.key ?? null;
  const label = persist?.label ?? '';

  // Unkeyed callers keep the old page-local behaviour.
  const [localEntry, setLocalEntry] = useState<DraftEntry<T> | null>(() =>
    source === null ? null : { draft: structuredClone(source), base: structuredClone(source) },
  );
  const localRef = useRef(localEntry);
  localRef.current = localEntry;

  const storedEntry = useDraftStore((s) => (key === null ? undefined : s.entries[key])) as
    | DraftEntry<T>
    | undefined;
  const entry = key === null ? localEntry : storedEntry ?? null;

  const write = useCallback(
    (next: DraftEntry<T> | null) => {
      if (key === null) setLocalEntry(next);
      else putDraftEntry(key, next);
    },
    [key],
  );

  const read = useCallback(
    (): DraftEntry<T> | null => (key === null ? localRef.current : getDraftEntry<T>(key)),
    [key],
  );

  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    if (source === null) return;
    if (entry === null) {
      write({ draft: structuredClone(source), base: structuredClone(source) });
      return;
    }
    if (deepEqual(entry.base, source)) return;
    // Device truth moved. An untouched draft follows it; an edited one keeps
    // the edits and just rebases what it is compared against.
    write(
      deepEqual(entry.draft, entry.base)
        ? { draft: structuredClone(source), base: structuredClone(source) }
        : { draft: entry.draft, base: structuredClone(source) },
    );
  }, [source, entry, write]);

  const draft = entry?.draft ?? null;
  const dirty = draft !== null && source !== null && !deepEqual(draft, source);
  const changes = dirty ? countChanges(draft, source) : 0;

  // Not cleared on unmount, on purpose: the point of a persisted draft is
  // that the section still reports unsaved work while you are on another one.
  useEffect(() => {
    if (key === null) return;
    setDraftDirty(key, dirty ? label : null);
  }, [key, label, dirty]);

  const patch = useCallback(
    (updater: (d: T) => T) => {
      const current = read();
      if (current === null) return;
      write({ draft: updater(current.draft), base: current.base });
    },
    [read, write],
  );

  const discard = useCallback(() => {
    const s = sourceRef.current;
    write(s === null ? null : { draft: structuredClone(s), base: structuredClone(s) });
  }, [write]);

  const setDraft = useCallback(
    (next: T | null) => {
      const current = read();
      write(next === null ? null : { draft: next, base: current?.base ?? structuredClone(next) });
    },
    [read, write],
  );

  return { draft, dirty, changes, patch, discard, setDraft } as const;
}
