import { useCallback, useEffect, useRef, useState } from 'react';
import { rollApi, type CaptureView, type RollApi } from '../api/client';
import { capturedAtMs } from '../captures';

/**
 * The feed's order, as the API sorts it: shutter time descending, id
 * descending inside a tie (`(captured_at, id)` in `captures/feed.ts`).
 * Negative when `left` belongs above `right`.
 *
 * `capturedAtMs` rather than `Date.parse`: this runs inside comparators and
 * merges, and at 2,000 captures one live arrival used to cost about 4,000
 * string parses here alone.
 */
export function compareFeedOrder(
  left: Pick<CaptureView, 'capturedAt' | 'captureId'>,
  right: Pick<CaptureView, 'capturedAt' | 'captureId'>,
): number {
  const byTime = capturedAtMs(right) - capturedAtMs(left);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  return left.captureId < right.captureId ? 1 : left.captureId > right.captureId ? -1 : 0;
}

/**
 * Two feed-ordered lists into one, deduplicated by id, still in feed order.
 *
 * A linear merge, not a concatenation. The concatenation it replaces was right
 * only while every capture in `second` was older than every capture in
 * `first`, which a head refetch after a long spell in the background does not
 * guarantee: the page that fills the gap belongs BETWEEN the new head and the
 * old one, and appending it put a run of newer photographs below older ones.
 *
 * `first` wins a tie, so a refetched record replaces the copy already shown
 * rather than the other way round.
 */
export function mergeFeedOrder(
  first: readonly CaptureView[],
  second: readonly CaptureView[],
): CaptureView[] {
  const merged: CaptureView[] = [];
  const seen = new Set<string>();
  const push = (capture: CaptureView): void => {
    if (seen.has(capture.captureId)) return;
    seen.add(capture.captureId);
    merged.push(capture);
  };

  let left = 0;
  let right = 0;
  while (left < first.length && right < second.length) {
    const a = first[left]!;
    const b = second[right]!;
    if (seen.has(a.captureId)) {
      left += 1;
      continue;
    }
    if (seen.has(b.captureId)) {
      right += 1;
      continue;
    }
    if (compareFeedOrder(a, b) <= 0) {
      push(a);
      left += 1;
    } else {
      push(b);
      right += 1;
    }
  }
  while (left < first.length) push(first[left++]!);
  while (right < second.length) push(second[right++]!);
  return merged;
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

/**
 * The first page, and every page after it.
 *
 * A phone paints one tile per row: twelve records is already more than two
 * screens of feed, while the API's own default is fifty capture records —
 * assets, playback and all — to put one or two pictures on screen. Deeper
 * pages are the guest scrolling on purpose, and there the round trip costs
 * more than the bytes.
 */
export const FEED_FIRST_PAGE = 12;
export const FEED_NEXT_PAGE = 50;

type FeedPage = Awaited<ReturnType<RollApi['listCaptures']>>;

interface FeedItems {
  captures: CaptureView[];
  /** Live arrivals held back while the guest is scrolled down — the "N new" pill. */
  pending: CaptureView[];
  /** The keyset cursor for the page after the last one loaded. */
  nextCursor: string | null;
  hasMore: boolean;
}

const EMPTY: FeedItems = { captures: [], pending: [], nextCursor: null, hasMore: true };

/**
 * A refetched page 1 folded back into what is already on screen.
 *
 * The question that decides everything here is whether page 1 still OVERLAPS
 * the list: does any capture on it appear in the list already?
 *
 *  - It does. Then the head has grown by however many captures sit above the
 *    first known one and nothing is missing in between, so the deeper pages
 *    stay exactly where they are — including their cursor. Taking page 1's
 *    cursor instead, which is what this used to do, threw away up to
 *    thirty-eight pages of position: the next `loadMore` re-walked the whole
 *    roll from the top and the duplicates were invisible because the merge
 *    deduplicates.
 *  - It does not. Then more captures arrived than one page holds while the tab
 *    was in the background, and there is a HOLE between page 1's tail and the
 *    old head. Nothing was fetching it: the whole page went to `pending`,
 *    `captures` was untouched and the cursor was left alone, so those captures
 *    were never asked for again. So the cursor becomes page 1's and `hasMore`
 *    goes true, and the ordinary load-more walk fills the hole.
 */
function applyHeadPage(current: FeedItems, page: FeedPage, buffer: boolean): FeedItems {
  if (current.captures.length === 0) {
    // Nothing was shown, so this page IS the list and its cursor is the tail.
    const arrived = new Set(page.items.map((capture) => capture.captureId));
    return {
      captures: page.items,
      pending: current.pending.filter((held) => !arrived.has(held.captureId)),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  const known = new Set(current.captures.map((capture) => capture.captureId));
  const boundary = page.items.findIndex((capture) => known.has(capture.captureId));
  const gap = boundary === -1;
  const fresh = gap ? page.items : page.items.slice(0, boundary);
  const overlap = gap ? [] : page.items.slice(boundary);

  // Buffering keeps a scrolled guest's grid still: only the captures that were
  // already visible are merged in place; the new head waits in the pill.
  const captures = mergeFeedOrder(buffer ? overlap : page.items, current.captures);
  const shown = new Set(captures.map((capture) => capture.captureId));
  const pending = buffer
    ? mergeFeedOrder(fresh, current.pending).filter((held) => !shown.has(held.captureId))
    : current.pending.filter((held) => !shown.has(held.captureId));

  return {
    captures,
    pending,
    nextCursor: gap ? page.nextCursor : current.nextCursor,
    hasMore: gap ? page.hasMore : current.hasMore,
  };
}

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
  /**
   * The last `loadMore` failed. Separate from `error`, which is the roll not
   * loading at all: a page that fails while two hundred photographs are on
   * screen is not a page-wide failure and must not paint one.
   */
  loadMoreError: Error | null;
}

/** An aborted read is this hook cancelling its own request, not a failure to report. */
function isAbort(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === 'AbortError';
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
  const [loadMoreError, setLoadMoreError] = useState<Error | null>(null);
  const activeRequestsRef = useRef(0);
  const generationRef = useRef(0);
  /**
   * Every read this hook has on the wire, cancelled when the roll changes or
   * the page goes away. Without it, moving between rolls left the old roll's
   * pages downloading over the new one's.
   */
  const abortRef = useRef<AbortController | null>(null);
  /**
   * Whether a `loadMore` is in flight, read synchronously.
   *
   * The guard used to read `loading` out of state against a trigger that
   * depends on a fresh object every render, so two effect runs in the same
   * commit both saw `loading: false` and both fetched the same page.
   */
  const loadingMoreRef = useRef(false);

  const readPage = useCallback(
    async (cursor: string | undefined, limit: number): Promise<FeedPage | null> => {
      activeRequestsRef.current += 1;
      setLoading(true);
      try {
        return await api.listCaptures(slug, cursor, {
          limit,
          signal: abortRef.current?.signal,
        });
      } catch (caught) {
        if (isAbort(caught)) return null;
        const failure = caught instanceof Error ? caught : new Error(String(caught));
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
      let page: FeedPage | null;
      try {
        page = await readPage(undefined, FEED_FIRST_PAGE);
      } catch (caught) {
        setError(caught instanceof Error ? caught : new Error(String(caught)));
        throw caught;
      }
      if (page === null || generation !== generationRef.current) return;
      setError(null);
      const head = page;
      const buffer = options?.buffer === true;
      setItems((current) => applyHeadPage(current, head, buffer));
    },
    [readPage],
  );

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    loadingMoreRef.current = false;
    setItems(EMPTY);
    setError(null);
    setLoadMoreError(null);

    void readPage(undefined, FEED_FIRST_PAGE)
      .then((page) => {
        if (page === null || generation !== generationRef.current) return;
        setItems({
          captures: page.items,
          pending: [],
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        });
      })
      .catch((caught: unknown) => {
        if (generation !== generationRef.current) return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      });

    return () => {
      generationRef.current += 1;
      controller.abort();
    };
  }, [readPage]);

  const { nextCursor, hasMore } = items;
  const loadMore = useCallback(async (): Promise<void> => {
    if (!hasMore || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    const generation = generationRef.current;
    let page: FeedPage | null;
    try {
      page = await readPage(nextCursor ?? undefined, FEED_NEXT_PAGE);
    } catch (caught) {
      loadingMoreRef.current = false;
      if (generation === generationRef.current) {
        setLoadMoreError(caught instanceof Error ? caught : new Error(String(caught)));
      }
      throw caught;
    }
    loadingMoreRef.current = false;
    if (page === null || generation !== generationRef.current) return;
    setLoadMoreError(null);
    const deeper = page;
    setItems((current) => ({
      ...current,
      captures: mergeFeedOrder(current.captures, deeper.items),
      nextCursor: deeper.nextCursor,
      hasMore: deeper.hasMore,
    }));
  }, [hasMore, nextCursor, readPage]);

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
        : { ...current, pending: mergeFeedOrder([capture], current.pending) },
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
    setItems({ captures: [], pending: [], nextCursor: null, hasMore: false });
    setLoadMoreError(null);
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
    loadMoreError,
  };
}
