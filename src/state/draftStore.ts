import { create } from 'zustand';

/**
 * Unsaved edits live here, not in the page component.
 *
 * The pages are mounted and unmounted by a plain page swap, so a draft held
 * in page state died on the next sidebar click — change JPEG QUALITY, click
 * Quad, click back, and the edit was gone with no warning. The app raises a
 * bold UNSAVED CHANGES bar; it has to mean something. Drafts now survive
 * navigation and only die on disconnect or an explicit discard.
 *
 * `base` is the device value the draft was last synced against. It is how we
 * tell "the user has not touched this, so let device truth through" from
 * "the user edited this, so keep the edit" after coming back to a page.
 */
export interface DraftEntry<T = unknown> {
  draft: T;
  base: T;
}

interface DraftState {
  entries: Record<string, DraftEntry>;
  /** Draft key → label for the status bar and the unsaved markers. */
  dirty: Record<string, string>;
}

export const useDraftStore = create<DraftState>(() => ({ entries: {}, dirty: {} }));

export function getDraftEntry<T>(key: string): DraftEntry<T> | null {
  return (useDraftStore.getState().entries[key] as DraftEntry<T> | undefined) ?? null;
}

export function putDraftEntry<T>(key: string, entry: DraftEntry<T> | null): void {
  useDraftStore.setState((s) => {
    const entries = { ...s.entries };
    if (entry === null) delete entries[key];
    else entries[key] = entry as DraftEntry;
    return { entries };
  });
}

export function setDraftDirty(key: string, label: string | null): void {
  useDraftStore.setState((s) => {
    if (label === null) {
      if (!(key in s.dirty)) return s;
      const dirty = { ...s.dirty };
      delete dirty[key];
      return { dirty };
    }
    if (s.dirty[key] === label) return s;
    return { dirty: { ...s.dirty, [key]: label } };
  });
}

/** Forget one draft outright — the thing it edits no longer exists. */
export function dropDraft(key: string): void {
  useDraftStore.setState((s) => {
    const entries = { ...s.entries };
    const dirty = { ...s.dirty };
    delete entries[key];
    delete dirty[key];
    return { entries, dirty };
  });
}

/** Cleared on disconnect — a draft for a camera that is gone is meaningless. */
export function resetDrafts(): void {
  useDraftStore.setState({ entries: {}, dirty: {} });
}

/**
 * Section ids with unsaved edits. Keys are either a page id (`shoot`) or a
 * page id with an instance suffix (`looks:party-neg`), so the marker lands on
 * the right sidebar row either way.
 */
export function dirtySections(dirty: Record<string, string>): Set<string> {
  const out = new Set<string>();
  for (const key of Object.keys(dirty)) out.add(key.split(':')[0]);
  return out;
}
