import { useEffect, useState } from 'react';
import {
  isMissingCaptureError,
  rollApi,
  type CaptureView,
  type RollApi,
} from '../api/client';

/**
 * MY PICKS — the guest's local favorites for one roll.
 *
 * A mirror of the server's per-guest `reacted` flag, kept in localStorage so
 * the picks tab can render without an endpoint that lists a guest's reactions
 * (the API has none). The server stays the truth: every write here happens
 * after a reaction toggle succeeded, or when the server says a picked capture
 * no longer exists.
 */

const PICKS_EVENT = 'kino-picks';

function keyOf(slug: string): string {
  return `kino-picks:${slug}`;
}

/**
 * `localStorage` can be absent (server render) or throw on access (storage
 * disabled by browser policy) — the same class of guard `cache/assets.ts`
 * applies to `caches`. Picks silently degrade to "none" in that case.
 */
function storageOf(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readPicks(slug: string): ReadonlySet<string> {
  const storage = storageOf();
  if (storage === null) return new Set();
  try {
    const raw = storage.getItem(keyOf(slug));
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

function writePicks(slug: string, picks: ReadonlySet<string>): void {
  const storage = storageOf();
  if (storage === null) return;
  try {
    storage.setItem(keyOf(slug), JSON.stringify([...picks]));
  } catch {
    return;
  }
  // The `storage` event only fires in OTHER tabs; this tab needs its own signal.
  window.dispatchEvent(new CustomEvent(PICKS_EVENT, { detail: { slug } }));
}

/** Records the server's answer after a reaction toggle: picked or not. */
export function setPick(slug: string, captureId: string, picked: boolean): void {
  const picks = new Set(readPicks(slug));
  if (picked) picks.add(captureId);
  else picks.delete(captureId);
  writePicks(slug, picks);
}

/** Flips a pick locally and returns the new state. */
export function togglePick(slug: string, captureId: string): boolean {
  const picked = !readPicks(slug).has(captureId);
  setPick(slug, captureId, picked);
  return picked;
}

/** The pick set, re-read whenever this tab or another one writes it. */
export function usePicks(slug: string): ReadonlySet<string> {
  const [picks, setPicks] = useState<ReadonlySet<string>>(() => readPicks(slug));

  useEffect(() => {
    setPicks(readPicks(slug));
    const changed = (): void => setPicks(readPicks(slug));
    window.addEventListener('storage', changed);
    window.addEventListener(PICKS_EVENT, changed);
    return () => {
      window.removeEventListener('storage', changed);
      window.removeEventListener(PICKS_EVENT, changed);
    };
  }, [slug]);

  return picks;
}

/**
 * The picked captures as feed items, newest first.
 *
 * Picks already in the loaded pages are reused; the rest are fetched one by
 * one. A pick the server answers 404 for (hidden or deleted by the host) is
 * dropped from the local set — moderation wins over a stale favorite.
 */
export function usePickedCaptures(
  slug: string,
  picks: ReadonlySet<string>,
  loaded: readonly CaptureView[],
  api: RollApi = rollApi,
): CaptureView[] {
  const [fetched, setFetched] = useState<ReadonlyMap<string, CaptureView>>(new Map());

  useEffect(() => {
    setFetched(new Map());
  }, [slug]);

  useEffect(() => {
    let active = true;
    const known = new Set(loaded.map((capture) => capture.captureId));
    const missing = [...picks].filter((id) => !known.has(id) && !fetched.has(id));
    if (missing.length === 0) return;

    for (const captureId of missing) {
      void api
        .getCapture(slug, captureId)
        .then((capture) => {
          if (!active) return;
          setFetched((current) => new Map(current).set(captureId, capture));
        })
        .catch((caught: unknown) => {
          if (active && isMissingCaptureError(caught)) setPick(slug, captureId, false);
        });
    }
    return () => {
      active = false;
    };
  }, [api, fetched, loaded, picks, slug]);

  const byId = new Map<string, CaptureView>();
  for (const capture of loaded) if (picks.has(capture.captureId)) byId.set(capture.captureId, capture);
  for (const [id, capture] of fetched) if (picks.has(id) && !byId.has(id)) byId.set(id, capture);

  return [...byId.values()].sort(
    (left, right) => new Date(right.capturedAt).getTime() - new Date(left.capturedAt).getTime(),
  );
}
