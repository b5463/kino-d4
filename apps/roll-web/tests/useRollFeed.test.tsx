// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureView, RollApi } from '../src/api/client';
import { useRollEvents, type RollEventHandlers } from '../src/hooks/useRollEvents';
import { compareFeedOrder, insertByCapturedAt, useRollFeed, type RollFeedState } from '../src/hooks/useRollFeed';
import { evictCaptureAssets, ROLL_ASSET_CACHE } from '../src/cache/assets';

const reactTestGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

function capture(captureId: string, status = 'ready', capturedAt = '2026-08-14T20:00:00.000Z'): CaptureView {
  return {
    captureId,
    mode: 'single',
    look: null,
    capturedAt,
    createdAt: '2026-08-14T20:00:01.000Z',
    frameCount: 1,
    resolution: '1600x1200',
    status,
    playback: null,
    assets: [],
  };
}

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  readonly close = vi.fn(() => {
    this.readyState = FakeEventSource.CLOSED;
  });
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, data: unknown = {}): void {
    const event =
      type === 'open' || type === 'error'
        ? new Event(type)
        : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function apiWith(overrides: Partial<RollApi> = {}): RollApi {
  return {
    getRoll: vi.fn(),
    submitPin: vi.fn(),
    listCaptures: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    getCapture: vi.fn(),
    assetUrl: (id) => `/api/assets/${id}/content`,
    react: vi.fn(),
    requestRender: vi.fn(),
    events: vi.fn(() => new FakeEventSource() as unknown as EventSource),
    ...overrides,
  };
}

describe('Roll feed hooks', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function render(element: ReactElement): Promise<void> {
    await act(async () => {
      root.render(element);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prepend deduplicates by capture id and keeps the fresh representation', async () => {
    const existing = capture('cap_1', 'processing');
    const api = apiWith({
      listCaptures: vi.fn().mockResolvedValue({ items: [existing], hasMore: false }),
    });
    const observed: { current: RollFeedState | null } = { current: null };

    const currentFeed = (): RollFeedState => {
      if (observed.current === null) throw new Error('feed hook did not render');
      return observed.current;
    };

    function Harness() {
      observed.current = useRollFeed('party', api);
      return null;
    }

    await render(<Harness />);
    expect(currentFeed().captures).toHaveLength(1);

    act(() => currentFeed().prepend(capture('cap_1', 'ready')));
    expect(currentFeed().captures).toHaveLength(1);
    expect(currentFeed().captures[0]?.status).toBe('ready');
  });

  it('does not let a slow previous slug block or overwrite the new roll', async () => {
    let resolveOld: ((page: { items: CaptureView[]; hasMore: false }) => void) | undefined;
    const oldPage = new Promise<{ items: CaptureView[]; hasMore: false }>((resolve) => {
      resolveOld = resolve;
    });
    const listCaptures = vi.fn((slug: string) =>
      slug === 'old'
        ? oldPage
        : Promise.resolve({ items: [capture('cap_new_roll')], hasMore: false as const }),
    );
    const api = apiWith({ listCaptures });
    const observed: { current: RollFeedState | null } = { current: null };

    function Harness({ slug }: { slug: string }) {
      observed.current = useRollFeed(slug, api);
      return null;
    }

    await render(<Harness slug="old" />);
    await render(<Harness slug="new" />);
    expect(observed.current?.captures.map((item) => item.captureId)).toEqual(['cap_new_roll']);

    await act(async () => {
      resolveOld?.({ items: [capture('cap_old_roll')], hasMore: false });
      await Promise.resolve();
    });
    expect(observed.current?.captures.map((item) => item.captureId)).toEqual(['cap_new_roll']);
  });

  it('capture.hidden removes the capture immediately', async () => {
    const source = new FakeEventSource();
    const remove = vi.fn();
    const api = apiWith({ events: vi.fn(() => source as unknown as EventSource) });

    function Harness() {
      useRollEvents('party', { remove }, api);
      return null;
    }

    await render(<Harness />);
    act(() => source.dispatch('capture.hidden', { type: 'capture.hidden', captureId: 'cap_1' }));
    expect(remove).toHaveBeenCalledWith('cap_1');
  });

  it('a failed stream reconnects after one second and refetches the feed head', async () => {
    vi.useFakeTimers();
    const sources: FakeEventSource[] = [];
    const events = vi.fn(() => {
      const source = new FakeEventSource();
      sources.push(source);
      return source as unknown as EventSource;
    });
    const refetchHead = vi.fn().mockResolvedValue(undefined);
    const api = apiWith({ events });
    const handlers: RollEventHandlers = { refetchHead };

    function Harness() {
      useRollEvents('party', handlers, api);
      return null;
    }

    await render(<Harness />);
    expect(events).toHaveBeenCalledTimes(1);
    act(() => sources[0]?.dispatch('error'));
    expect(sources[0]?.close).toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(events).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(events).toHaveBeenCalledTimes(2);
    expect(refetchHead).toHaveBeenCalledTimes(1);
  });

  it('capture.created fetches the full capture before prepending it', async () => {
    const source = new FakeEventSource();
    const created = capture('cap_new');
    const prepend = vi.fn();
    const api = apiWith({
      events: vi.fn(() => source as unknown as EventSource),
      getCapture: vi.fn().mockResolvedValue(created),
    });

    function Harness() {
      useRollEvents('party', { prepend }, api);
      return null;
    }

    await render(<Harness />);
    await act(async () => {
      source.dispatch('capture.created', { type: 'capture.created', captureId: 'cap_new' });
      await Promise.resolve();
    });
    expect(api.getCapture).toHaveBeenCalledWith('party', 'cap_new');
    expect(prepend).toHaveBeenCalledWith(created);
  });

  function feedHarness(api: RollApi): {
    current(): RollFeedState;
    Harness: () => null;
  } {
    const observed: { current: RollFeedState | null } = { current: null };
    return {
      current: () => {
        if (observed.current === null) throw new Error('feed hook did not render');
        return observed.current;
      },
      Harness: function Harness() {
        observed.current = useRollFeed('party', api);
        return null;
      },
    };
  }

  it('buffer holds a live arrival in pending without touching the grid', async () => {
    const api = apiWith({
      listCaptures: vi.fn().mockResolvedValue({ items: [capture('cap_old')], hasMore: false }),
    });
    const { current, Harness } = feedHarness(api);
    await render(<Harness />);

    act(() => current().buffer(capture('cap_new')));
    expect(current().captures.map((item) => item.captureId)).toEqual(['cap_old']);
    expect(current().pending.map((item) => item.captureId)).toEqual(['cap_new']);

    // Buffering the same capture again is a no-op, not a second pill count.
    act(() => current().buffer(capture('cap_new')));
    expect(current().pending).toHaveLength(1);
  });

  it('buffer patches a capture that is already visible instead of pending it', async () => {
    const api = apiWith({
      listCaptures: vi
        .fn()
        .mockResolvedValue({ items: [capture('cap_1', 'processing')], hasMore: false }),
    });
    const { current, Harness } = feedHarness(api);
    await render(<Harness />);

    act(() => current().buffer(capture('cap_1', 'ready')));
    expect(current().pending).toHaveLength(0);
    expect(current().captures[0]?.status).toBe('ready');
  });

  it('flushPending moves pending to the head and returns the flushed ids', async () => {
    const api = apiWith({
      listCaptures: vi.fn().mockResolvedValue({ items: [capture('cap_old')], hasMore: false }),
    });
    const { current, Harness } = feedHarness(api);
    await render(<Harness />);

    // Newer shutter times than the head, so they belong above it. (At an
    // equal time the id tiebreaker decides, as it does on the API.)
    act(() => {
      current().buffer(capture('cap_b', 'ready', '2026-08-14T20:05:00.000Z'));
      current().buffer(capture('cap_a', 'ready', '2026-08-14T20:06:00.000Z'));
    });

    let flushed: string[] = [];
    act(() => {
      flushed = current().flushPending();
    });
    expect(flushed.sort()).toEqual(['cap_a', 'cap_b']);
    expect(current().pending).toHaveLength(0);
    expect(current().captures.map((item) => item.captureId)).toContain('cap_a');
    expect(current().captures[current().captures.length - 1]?.captureId).toBe('cap_old');
  });

  it('remove purges a moderated capture from pending too', async () => {
    const api = apiWith();
    const { current, Harness } = feedHarness(api);
    await render(<Harness />);

    act(() => current().buffer(capture('cap_hidden')));
    expect(current().pending).toHaveLength(1);
    act(() => current().remove('cap_hidden'));
    expect(current().pending).toHaveLength(0);
  });

  it('replace patches a buffered capture in place', async () => {
    const api = apiWith();
    const { current, Harness } = feedHarness(api);
    await render(<Harness />);

    act(() => current().buffer(capture('cap_p', 'processing')));
    act(() => current().replace(capture('cap_p', 'ready')));
    expect(current().pending[0]?.status).toBe('ready');
    expect(current().captures).toHaveLength(0);
  });

  it('refetchHead({buffer:true}) sends only items newer than the head to pending', async () => {
    const first = { items: [capture('cap_2'), capture('cap_1')], hasMore: false };
    const second = {
      items: [capture('cap_4'), capture('cap_3'), capture('cap_2', 'ready'), capture('cap_1')],
      hasMore: false,
    };
    const listCaptures = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(second);
    const api = apiWith({ listCaptures });
    const { current, Harness } = feedHarness(api);
    await render(<Harness />);
    expect(current().captures.map((item) => item.captureId)).toEqual(['cap_2', 'cap_1']);

    await act(async () => current().refetchHead({ buffer: true }));

    expect(current().pending.map((item) => item.captureId)).toEqual(['cap_4', 'cap_3']);
    expect(current().captures.map((item) => item.captureId)).toEqual(['cap_2', 'cap_1']);
  });

  it('refetchHead({buffer:true}) on an empty list takes the page cursor from the state it updates', async () => {
    // The old code read `items.captures.length` from the closure, so a
    // callback built while the list was empty could set the cursor after the
    // list had filled — and every length change rebuilt the callback, which
    // resubscribed the event stream. The decision now lives in the updater.
    const listCaptures = vi
      .fn()
      .mockResolvedValueOnce({ items: [], nextCursor: undefined, hasMore: false })
      .mockResolvedValue({ items: [capture('cap_1')], nextCursor: 'tail', hasMore: true });
    const api = apiWith({ listCaptures });
    const { current, Harness } = feedHarness(api);
    await render(<Harness />);
    expect(current().captures).toHaveLength(0);
    expect(current().hasMore).toBe(false);

    const before = current().refetchHead;
    await act(async () => current().refetchHead({ buffer: true }));

    expect(current().captures.map((item) => item.captureId)).toEqual(['cap_1']);
    expect(current().pending).toHaveLength(0);
    expect(current().hasMore).toBe(true);
    // Same function: the callback no longer depends on the list length.
    expect(current().refetchHead).toBe(before);
  });

  it('prepend removes the capture from pending so a flush cannot duplicate it', async () => {
    const api = apiWith();
    const { current, Harness } = feedHarness(api);
    await render(<Harness />);

    act(() => current().buffer(capture('cap_x')));
    act(() => current().prepend(capture('cap_x')));
    expect(current().pending).toHaveLength(0);
    expect(current().captures.map((item) => item.captureId)).toEqual(['cap_x']);
  });

  it('evicts every cached asset when live moderation removes a capture', async () => {
    const removeCached = vi.fn().mockResolvedValue(true);
    const open = vi.fn().mockResolvedValue({ delete: removeCached });
    vi.stubGlobal('caches', { open });
    const api = apiWith();
    const moderated = capture('cap_hidden');
    moderated.assets = [
      { role: 'thumb', assetId: 'ast_thumb', frameIndex: null, width: 480, height: 360 },
      { role: 'wiggle-webp', assetId: 'ast_wiggle', frameIndex: null, width: 960, height: 720 },
    ];

    await evictCaptureAssets(moderated, api);

    expect(open).toHaveBeenCalledWith(ROLL_ASSET_CACHE);
    expect(removeCached).toHaveBeenCalledWith('/api/assets/ast_thumb/content');
    expect(removeCached).toHaveBeenCalledWith('/api/assets/ast_wiggle/content');
  });
});

/**
 * The phone report: a camera that was offline uploads its backlog later, and
 * every one of those is announced as `capture.created`. Prepending them sat
 * two hundred old shots above the photographs guests had just taken. A live
 * arrival is filed by its shutter time — the API's own order, `(captured_at,
 * id)` descending — and only a genuinely newer shot reaches the head.
 */
describe('live arrivals are filed by shutter time', () => {
  const at = (minute: number): string => `2026-08-14T20:${String(minute).padStart(2, '0')}:00.000Z`;

  it('compareFeedOrder is newest first, id descending inside a tie — the API keyset', () => {
    expect(compareFeedOrder(capture('cap_a', 'ready', at(5)), capture('cap_b', 'ready', at(4)))).toBeLessThan(0);
    expect(compareFeedOrder(capture('cap_a', 'ready', at(4)), capture('cap_b', 'ready', at(5)))).toBeGreaterThan(0);
    expect(compareFeedOrder(capture('cap_b', 'ready', at(5)), capture('cap_a', 'ready', at(5)))).toBeLessThan(0);
    expect(compareFeedOrder(capture('cap_a', 'ready', at(5)), capture('cap_a', 'ready', at(5)))).toBe(0);
  });

  it('insertByCapturedAt puts an older shot below the newer ones and a newer one on top', () => {
    const shown = [capture('cap_3', 'ready', at(30)), capture('cap_2', 'ready', at(20)), capture('cap_1', 'ready', at(10))];
    const late = capture('cap_late', 'ready', at(15));
    const fresh = capture('cap_fresh', 'ready', at(40));
    expect(insertByCapturedAt(shown, [late, fresh]).map((c) => c.captureId)).toEqual([
      'cap_fresh',
      'cap_3',
      'cap_2',
      'cap_late',
      'cap_1',
    ]);
    // Older than everything: the tail. Same id: replaced in place, not doubled.
    expect(insertByCapturedAt(shown, [capture('cap_0', 'ready', at(1))]).at(-1)?.captureId).toBe('cap_0');
    const patched = insertByCapturedAt(shown, [capture('cap_2', 'processing', at(20))]);
    expect(patched.map((c) => c.captureId)).toEqual(['cap_3', 'cap_2', 'cap_1']);
    expect(patched[1]?.status).toBe('processing');
  });

  async function mounted(api: RollApi): Promise<{ current(): RollFeedState }> {
    const observed: { current: RollFeedState | null } = { current: null };
    function Harness() {
      observed.current = useRollFeed('party', api);
      return null;
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });
    return {
      current: () => {
        if (observed.current === null) throw new Error('feed hook did not render');
        return observed.current;
      },
    };
  }

  it('prepend files a late upload of an older shot where it was taken', async () => {
    const api = apiWith({
      listCaptures: vi.fn().mockResolvedValue({
        items: [capture('cap_3', 'ready', at(30)), capture('cap_1', 'ready', at(10))],
        hasMore: false,
      }),
    });
    const { current } = await mounted(api);

    act(() => current().prepend(capture('cap_backlog', 'ready', at(20))));
    expect(current().captures.map((c) => c.captureId)).toEqual(['cap_3', 'cap_backlog', 'cap_1']);

    act(() => current().prepend(capture('cap_now', 'ready', at(45))));
    expect(current().captures[0]?.captureId).toBe('cap_now');
  });

  it('the "N new" pill still counts a late arrival, and a flush files it by shutter time', async () => {
    const api = apiWith({
      listCaptures: vi.fn().mockResolvedValue({
        items: [capture('cap_3', 'ready', at(30)), capture('cap_1', 'ready', at(10))],
        hasMore: false,
      }),
    });
    const { current } = await mounted(api);

    act(() => {
      current().buffer(capture('cap_backlog', 'ready', at(20)));
      current().buffer(capture('cap_now', 'ready', at(45)));
    });
    expect(current().pending).toHaveLength(2);

    let flushed: string[] = [];
    act(() => {
      flushed = current().flushPending();
    });
    expect(flushed.sort()).toEqual(['cap_backlog', 'cap_now']);
    expect(current().captures.map((c) => c.captureId)).toEqual(['cap_now', 'cap_3', 'cap_backlog', 'cap_1']);
  });

  it('clear empties the list and the pill together, and roll.cleared reaches the page handler', async () => {
    const api = apiWith({
      listCaptures: vi.fn().mockResolvedValue({ items: [capture('cap_1')], nextCursor: 'more', hasMore: true }),
    });
    const { current } = await mounted(api);
    act(() => current().buffer(capture('cap_2', 'ready', at(50))));
    expect(current().captures).toHaveLength(1);
    expect(current().pending).toHaveLength(1);

    act(() => current().clear());
    expect(current().captures).toEqual([]);
    expect(current().pending).toEqual([]);
    expect(current().hasMore).toBe(false);

    // The event hook: one roll-level event, the clear handler and the roll refresh.
    const source = new FakeEventSource();
    const onRollCleared = vi.fn();
    const onRollChanged = vi.fn();
    const remove = vi.fn();
    const events = apiWith({ events: vi.fn(() => source as unknown as EventSource) });
    function Harness() {
      useRollEvents('party', { onRollCleared, onRollChanged, remove }, events);
      return null;
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Harness />));
    act(() => source.dispatch('roll.cleared', { type: 'roll.cleared' }));
    expect(onRollCleared).toHaveBeenCalledTimes(1);
    expect(onRollChanged).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    host.remove();
  });
});
