// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureView, RollApi } from '../src/api/client';
import { useRollEvents, type RollEventHandlers } from '../src/hooks/useRollEvents';
import { useRollFeed, type RollFeedState } from '../src/hooks/useRollFeed';
import { evictCaptureAssets, ROLL_ASSET_CACHE } from '../src/cache/assets';

const reactTestGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

function capture(captureId: string, status = 'ready'): CaptureView {
  return {
    captureId,
    mode: 'single',
    look: null,
    capturedAt: '2026-08-14T20:00:00.000Z',
    createdAt: '2026-08-14T20:00:01.000Z',
    frameCount: 1,
    resolution: '1600x1200',
    status,
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

    act(() => {
      current().buffer(capture('cap_b'));
      current().buffer(capture('cap_a'));
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
