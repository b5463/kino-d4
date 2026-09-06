import { useCallback, useEffect, useRef, useState } from 'react';
import { rollApi, type CaptureView, type RollApi } from '../api/client';

function mergeUnique(first: readonly CaptureView[], second: readonly CaptureView[]): CaptureView[] {
  const seen = new Set<string>();
  const merged: CaptureView[] = [];
  for (const capture of [...first, ...second]) {
    if (seen.has(capture.captureId)) continue;
    seen.add(capture.captureId);
    merged.push(capture);
  }
  return merged;
}

/**
 * The feed's order, as the API sorts it: shutter time descending, id
 * descending inside a tie (`(captured_at, id)` in `captures/feed.ts`).
 * Negative when `left` belongs above `right`.
 */
export function compareFeedOrder(
  left: Pick<CaptureView, 'capturedAt' | 'captureId'>,
  right: Pick<CaptureView, 'capturedAt' | 'captureId'>,
): number {
  const byTime = Date.parse(right.capturedAt) - Date.parse(left.capturedAt);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  return left.captureId < right.captureId ? 1 : left.captureId > right.captureId ? -1 : 0;
}

/**
 * Files `arrivals` into `list` at their sorted positions, newest shutter time
 * first, replacing an entry that shares an id.
 *
 * Not a prepend. A capture reaching the API late — the camera was offline, or
 * the upload retried — is announced as `capture.created` like any other, and
 * blindly putting it at the head sat a backlog of older shots on top of the
 * photographs guests had just taken. Its shutter time says where it goes.
 * `list` is assumed already in feed order (it came from the API that way);
 * nothing else is reordered.
 */
export function insertByCapturedAt(
  list: readonly CaptureView[],
  arrivals: readonly CaptureView[],
): CaptureView[] {
  const next = [...list];
  for (const capture of arrivals) {
    const at = next.findIndex((shown) => shown.captureId === capture.captureId);
    if (at !== -1) next.splice(at, 1);
    let slot = next.findIndex((shown) => compareFeedOrder(capture, shown) < 0);
    if (slot === -1) slot = next.length;
    next.splice(slot, 0, capture);
  }
  return next;
}

interface FeedItems {
  captures: CaptureView[];
  /** Live arrivals held back while the guest is scrolled down — the "N new" pill. */
  pending: CaptureView[];
  /** The keyset cursor for the page after the last one loaded. */
  nextCursor: string | undefined;
  hasMore: boolean;
}

const EMPTY: FeedItems = { captures: [], pending: [], nextCursor: undefined, hasMore: true };

export interface RollFeedState {
  captures: CaptureView[];
  pending: CaptureView[];
  loadMore(): Promise<void>;
  hasMore: boolean;
  /** Files a live arrival by its shutter time — the head only if it IS the newest. */
  prepend(capture: CaptureView): void;
  /** Holds a live arrival in `pending` instead of shifting the visible grid. */
  buffer(capture: CaptureView): void;
  /** Files everything pending by shutter time and returns the moved ids. */
  flushPending(): string[];
  replace(capture: CaptureView): void;
  remove(captureId: string): void;
  /** The host cleared the roll: nothing shown, nothing pending, nothing more to load. */
  clear(): void;
  refetchHead(options?: { buffer?: boolean }): Promise<void>;
  loading: boolean;
  error: Error | null;
}

/** Keyset-paginated guest feed state, with live-update-safe identity merging. */
export function useRollFeed(slug: string, api: RollApi = rollApi): RollFeedState {
  // One state object: every mutation has to see captures and pending together,
  // or a race between a buffer and a flush could duplicate a capture. The
  // cursor lives here too, so a head refetch decides "was the list empty"
  // from the state it is updating rather than from a closure that was current
  // when the callback was built.
  const [items, setItems] = useState<FeedItems>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const activeRequestsRef = useRef(0);
  const generationRef = useRef(0);

  const readPage = useCallback(
    async (cursor?: string): Promise<Awaited<ReturnType<RollApi['listCaptures']>> | null> => {
      activeRequestsRef.current += 1;
      setLoading(true);
      setError(null);
      try {
        return await api.listCaptures(slug, cursor);
      } catch (caught) {
        const failure = caught instanceof Error ? caught : new Error(String(caught));
        setError(failure);
        throw failure;
      } finally {
        activeRequestsRef.current -= 1;
        if (activeRequestsRef.current === 0) setLoading(false);
      }
    },
    [api, slug],
  );

  const refetchHead = useCallback(
    async (options?: { buffer?: boolean }): Promise<void> => {
      const generation = generationRef.current;
      const page = await readPage();
      if (page === null || generation !== generationRef.current) return;

      if (options?.buffer === true) {
        // The head refetch after a reconnect must not shift a scrolled guest
        // either: everything ahead of the first already-known capture is new at
        // the head and goes to pending; the rest merges in place. The cursor is
        // left alone — the visible head did not move, so the tail did not
        // either.
        setItems((current) => {
          if (current.captures.length === 0) {
            // Nothing was shown, so this page IS the list and its cursor is
            // the tail.
            return {
              captures: page.items,
              pending: current.pending,
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
            };
          }
          const known = new Set(current.captures.map((capture) => capture.captureId));
          const boundary = page.items.findIndex((capture) => known.has(capture.captureId));
          const fresh = boundary === -1 ? page.items : page.items.slice(0, boundary);
          const rest = boundary === -1 ? [] : page.items.slice(boundary);
          return {
            captures: mergeUnique(rest, current.captures),
            pending: mergeUnique(fresh, current.pending),
            nextCursor: current.nextCursor,
            hasMore: current.hasMore,
          };
        });
        return;
      }

      // Server order wins at the head; existing deeper pages remain behind it.
      setItems((current) => ({
        captures: mergeUnique(page.items, current.captures),
        pending: current.pending.filter(
          (capture) => !page.items.some((item) => item.captureId === capture.captureId),
        ),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      }));
    },
    [readPage],
  );

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setItems(EMPTY);
    setError(null);

    void readPage()
      .then((page) => {
        if (page === null || generation !== generationRef.current) return;
        setItems({ captures: page.items, pending: [], nextCursor: page.nextCursor, hasMore: page.hasMore });
      })
      .catch(() => {
        // `readPage` has already put the failure in state for the page to show.
      });

    return () => {
      generationRef.current += 1;
    };
  }, [readPage]);

  const { nextCursor, hasMore } = items;
  const loadMore = useCallback(async (): Promise<void> => {
    if (!hasMore || loading) return;
    const generation = generationRef.current;
    const page = await readPage(nextCursor);
    if (page === null || generation !== generationRef.current) return;
    setItems((current) => ({
      ...current,
      captures: mergeUnique(current.captures, page.items),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    }));
  }, [hasMore, loading, nextCursor, readPage]);

  const prepend = useCallback((capture: CaptureView): void => {
    setItems((current) => ({
      ...current,
      captures: insertByCapturedAt(current.captures, [capture]),
      pending: current.pending.filter((held) => held.captureId !== capture.captureId),
    }));
  }, []);

  const buffer = useCallback((capture: CaptureView): void => {
    setItems((current) =>
      // Already visible: this is an update, not an arrival — patch it in place.
      current.captures.some((shown) => shown.captureId === capture.captureId)
        ? {
            ...current,
            captures: current.captures.map((shown) =>
              shown.captureId === capture.captureId ? capture : shown,
            ),
          }
        : { ...current, pending: mergeUnique([capture], current.pending) },
    );
  }, []);

  const flushPending = useCallback((): string[] => {
    const flushed = items.pending.map((capture) => capture.captureId);
    setItems((current) => ({
      ...current,
      captures: insertByCapturedAt(current.captures, current.pending),
      pending: [],
    }));
    return flushed;
  }, [items.pending]);

  const replace = useCallback((capture: CaptureView): void => {
    const patch = (list: CaptureView[]): CaptureView[] =>
      list.map((candidate) => (candidate.captureId === capture.captureId ? capture : candidate));
    setItems((current) => ({ ...current, captures: patch(current.captures), pending: patch(current.pending) }));
  }, []);

  const remove = useCallback((captureId: string): void => {
    const drop = (list: CaptureView[]): CaptureView[] =>
      list.filter((capture) => capture.captureId !== captureId);
    setItems((current) => ({ ...current, captures: drop(current.captures), pending: drop(current.pending) }));
  }, []);

  const clear = useCallback((): void => {
    setItems({ captures: [], pending: [], nextCursor: undefined, hasMore: false });
  }, []);

  return {
    captures: items.captures,
    pending: items.pending,
    loadMore,
    hasMore,
    prepend,
    buffer,
    flushPending,
    replace,
    remove,
    clear,
    refetchHead,
    loading,
    error,
  };
}
