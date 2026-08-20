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

export interface RollFeedState {
  captures: CaptureView[];
  loadMore(): Promise<void>;
  hasMore: boolean;
  prepend(capture: CaptureView): void;
  replace(capture: CaptureView): void;
  remove(captureId: string): void;
  refetchHead(): Promise<void>;
  loading: boolean;
  error: Error | null;
}

/** Keyset-paginated guest feed state, with live-update-safe identity merging. */
export function useRollFeed(slug: string, api: RollApi = rollApi): RollFeedState {
  const [captures, setCaptures] = useState<CaptureView[]>([]);
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

  const refetchHead = useCallback(async (): Promise<void> => {
    const generation = generationRef.current;
    const page = await readPage();
    if (page === null || generation !== generationRef.current) return;
    // Server order wins at the head; existing deeper pages remain behind it.
    setCaptures((current) => mergeUnique(page.items, current));
    setNextCursor(page.nextCursor);
    setHasMore(page.hasMore);
  }, [readPage]);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setCaptures([]);
    setNextCursor(undefined);
    setHasMore(true);
    setError(null);

    void readPage()
      .then((page) => {
        if (page === null || generation !== generationRef.current) return;
        setCaptures(page.items);
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
    setCaptures((current) => mergeUnique(current, page.items));
    setNextCursor(page.nextCursor);
    setHasMore(page.hasMore);
  }, [hasMore, loading, nextCursor, readPage]);

  const prepend = useCallback((capture: CaptureView): void => {
    setCaptures((current) => mergeUnique([capture], current));
  }, []);

  const replace = useCallback((capture: CaptureView): void => {
    setCaptures((current) =>
      current.map((candidate) =>
        candidate.captureId === capture.captureId ? capture : candidate,
      ),
    );
  }, []);

  const remove = useCallback((captureId: string): void => {
    setCaptures((current) => current.filter((capture) => capture.captureId !== captureId));
  }, []);

  return {
    captures,
    loadMore,
    hasMore,
    prepend,
    replace,
    remove,
    refetchHead,
    loading,
    error,
  };
}
