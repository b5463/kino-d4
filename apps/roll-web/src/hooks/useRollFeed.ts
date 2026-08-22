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

interface FeedItems {
  captures: CaptureView[];
  /** Live arrivals held back while the guest is scrolled down — the "N new" pill. */
  pending: CaptureView[];
}

const EMPTY: FeedItems = { captures: [], pending: [] };

export interface RollFeedState {
  captures: CaptureView[];
  pending: CaptureView[];
  loadMore(): Promise<void>;
  hasMore: boolean;
  prepend(capture: CaptureView): void;
  /** Holds a live arrival in `pending` instead of shifting the visible grid. */
  buffer(capture: CaptureView): void;
  /** Moves everything pending to the head and returns the moved ids. */
  flushPending(): string[];
  replace(capture: CaptureView): void;
  remove(captureId: string): void;
  refetchHead(options?: { buffer?: boolean }): Promise<void>;
  loading: boolean;
  error: Error | null;
}

/** Keyset-paginated guest feed state, with live-update-safe identity merging. */
export function useRollFeed(slug: string, api: RollApi = rollApi): RollFeedState {
  // One state object: every mutation has to see captures and pending together,
  // or a race between a buffer and a flush could duplicate a capture.
  const [items, setItems] = useState<FeedItems>(EMPTY);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(true);
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
            return { captures: page.items, pending: current.pending };
          }
          const known = new Set(current.captures.map((capture) => capture.captureId));
          const boundary = page.items.findIndex((capture) => known.has(capture.captureId));
          const fresh = boundary === -1 ? page.items : page.items.slice(0, boundary);
          const rest = boundary === -1 ? [] : page.items.slice(boundary);
          return {
            captures: mergeUnique(rest, current.captures),
            pending: mergeUnique(fresh, current.pending),
          };
        });
        if (items.captures.length === 0) {
          setNextCursor(page.nextCursor);
          setHasMore(page.hasMore);
        }
        return;
      }

      // Server order wins at the head; existing deeper pages remain behind it.
      setItems((current) => ({
        captures: mergeUnique(page.items, current.captures),
        pending: current.pending.filter(
          (capture) => !page.items.some((item) => item.captureId === capture.captureId),
        ),
      }));
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    },
    [items.captures.length, readPage],
  );

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setItems(EMPTY);
    setNextCursor(undefined);
    setHasMore(true);
    setError(null);

    void readPage()
      .then((page) => {
        if (page === null || generation !== generationRef.current) return;
        setItems({ captures: page.items, pending: [] });
        setNextCursor(page.nextCursor);
        setHasMore(page.hasMore);
      })
      .catch(() => {
        // `readPage` has already put the failure in state for the page to show.
      });

    return () => {
      generationRef.current += 1;
    };
  }, [readPage]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!hasMore || loading) return;
    const generation = generationRef.current;
    const page = await readPage(nextCursor);
    if (page === null || generation !== generationRef.current) return;
    setItems((current) => ({
      captures: mergeUnique(current.captures, page.items),
      pending: current.pending,
    }));
    setNextCursor(page.nextCursor);
    setHasMore(page.hasMore);
  }, [hasMore, loading, nextCursor, readPage]);

  const prepend = useCallback((capture: CaptureView): void => {
    setItems((current) => ({
      captures: mergeUnique([capture], current.captures),
      pending: current.pending.filter((held) => held.captureId !== capture.captureId),
    }));
  }, []);

  const buffer = useCallback((capture: CaptureView): void => {
    setItems((current) =>
      // Already visible: this is an update, not an arrival — patch it in place.
      current.captures.some((shown) => shown.captureId === capture.captureId)
        ? {
            captures: current.captures.map((shown) =>
              shown.captureId === capture.captureId ? capture : shown,
            ),
            pending: current.pending,
          }
        : { captures: current.captures, pending: mergeUnique([capture], current.pending) },
    );
  }, []);

  const flushPending = useCallback((): string[] => {
    const flushed = items.pending.map((capture) => capture.captureId);
    setItems((current) => ({
      captures: mergeUnique(current.pending, current.captures),
      pending: [],
    }));
    return flushed;
  }, [items.pending]);

  const replace = useCallback((capture: CaptureView): void => {
    const patch = (list: CaptureView[]): CaptureView[] =>
      list.map((candidate) => (candidate.captureId === capture.captureId ? capture : candidate));
    setItems((current) => ({ captures: patch(current.captures), pending: patch(current.pending) }));
  }, []);

  const remove = useCallback((captureId: string): void => {
    const drop = (list: CaptureView[]): CaptureView[] =>
      list.filter((capture) => capture.captureId !== captureId);
    setItems((current) => ({ captures: drop(current.captures), pending: drop(current.pending) }));
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
    refetchHead,
    loading,
    error,
  };
}
