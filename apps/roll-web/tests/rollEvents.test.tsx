// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureDetail, RollApi } from '../src/api/client';
import {
  CAPTURE_REFETCH_DEBOUNCE_MS,
  ROLL_REFRESH_DEBOUNCE_MS,
  useRollEvents,
  type RollEventHandlers,
} from '../src/hooks/useRollEvents';

const reactTestGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

/** Just enough EventSource for the hook: named listeners and a close. */
class FakeEventSource {
  static latest: FakeEventSource | null = null;
  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  closed = false;

  constructor() {
    FakeEventSource.latest = this;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, payload: unknown): void {
    const event = { data: JSON.stringify(payload) } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function detail(captureId: string): CaptureDetail {
  return {
    captureId,
    mode: 'wiggle',
    look: null,
    capturedAt: '2026-08-14T20:00:00.000Z',
    createdAt: '2026-08-14T20:00:00.000Z',
    frameCount: 4,
    resolution: '1600x1200',
    status: 'ready',
    playback: null,
    assets: [],
    reactionCount: 0,
    reacted: false,
  };
}

describe('useRollEvents capture filter', () => {
  let container: HTMLDivElement;
  let root: Root;
  let getCapture: ReturnType<typeof vi.fn>;
  let api: RollApi;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    FakeEventSource.latest = null;
    getCapture = vi.fn((_slug: string, id: string) => Promise.resolve(detail(id)));
    api = {
      getRoll: vi.fn(),
      submitPin: vi.fn(),
      listCaptures: vi.fn(),
      getCapture: getCapture as unknown as RollApi['getCapture'],
      assetUrl: (id) => `/api/assets/${id}/content`,
      react: vi.fn(),
      requestRender: vi.fn(),
      events: vi.fn(() => new FakeEventSource() as unknown as EventSource),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  /** Lets the fetches resolve and any trailing debounce fire. */
  async function settle(ms = 0): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  async function mount(handlers: RollEventHandlers): Promise<FakeEventSource> {
    function Harness() {
      useRollEvents('party', handlers, api);
      return null;
    }
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    const source = FakeEventSource.latest;
    if (source === null) throw new Error('the hook opened no event source');
    return source;
  }

  it('fetches only the wanted capture, whatever the roll is doing', async () => {
    /**
     * Regression: a capture page subscribed to the whole roll and filtered
     * AFTER the fetch, so every capture anyone took cost this page a full
     * `getCapture` whose answer was then discarded. On a busy roll that is the
     * entire gallery downloaded to a phone showing one photograph.
     */
    const replace = vi.fn();
    const source = await mount({ wants: (id) => id === 'cap_mine', replace });

    await act(async () => {
      source.emit('capture.updated', { type: 'capture.updated', captureId: 'cap_other' });
      source.emit('processing.completed', { type: 'processing.completed', captureId: 'cap_other' });
      source.emit('capture.created', { type: 'capture.created', captureId: 'cap_other' });
      await Promise.resolve();
    });
    expect(getCapture).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();

    await act(async () => {
      source.emit('capture.updated', { type: 'capture.updated', captureId: 'cap_mine' });
      await Promise.resolve();
    });
    // The update waits out its trailing debounce; the fetch is not in the tick
    // the event arrived in.
    expect(getCapture).not.toHaveBeenCalled();
    await settle(CAPTURE_REFETCH_DEBOUNCE_MS);
    expect(getCapture).toHaveBeenCalledTimes(1);
    expect(getCapture).toHaveBeenCalledWith('party', 'cap_mine');
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("collapses a photograph's nine update events into one refetch", async () => {
    /**
     * Measured: one photograph announced itself as `capture.created`, then five
     * `capture.updated` and four `processing.completed` as its four asset roles
     * finished — eleven round trips per photograph per open tab, ten of them
     * for the same id.
     */
    const prepend = vi.fn();
    const replace = vi.fn();
    const source = await mount({ prepend, replace });

    await act(async () => {
      source.emit('capture.created', { type: 'capture.created', captureId: 'cap_1' });
      await Promise.resolve();
    });
    // The arrival is what the guest is waiting for: immediate, on its own.
    expect(getCapture).toHaveBeenCalledTimes(1);

    await settle(0);
    for (let step = 0; step < 5; step += 1) {
      await act(async () => {
        source.emit('capture.updated', { type: 'capture.updated', captureId: 'cap_1' });
        await vi.advanceTimersByTimeAsync(20);
      });
    }
    for (let step = 0; step < 4; step += 1) {
      await act(async () => {
        source.emit('processing.completed', { type: 'processing.completed', captureId: 'cap_1' });
        await vi.advanceTimersByTimeAsync(20);
      });
    }
    expect(getCapture).toHaveBeenCalledTimes(1);

    await settle(CAPTURE_REFETCH_DEBOUNCE_MS);
    expect(getCapture).toHaveBeenCalledTimes(2);
    expect(prepend).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('keeps one capture fetch on the wire and refetches what landed behind it', async () => {
    /**
     * Nine convergent events must not become nine sockets. The events that
     * land while a `GET` is open are answered by exactly one more `GET`, so a
     * capture can never be left showing a state the server has moved past.
     */
    let release: ((capture: CaptureDetail) => void) | undefined;
    getCapture.mockImplementationOnce(
      () =>
        new Promise<CaptureDetail>((resolve) => {
          release = resolve;
        }),
    );
    const replace = vi.fn();
    const source = await mount({ prepend: vi.fn(), replace });

    await act(async () => {
      source.emit('capture.created', { type: 'capture.created', captureId: 'cap_1' });
      await Promise.resolve();
    });
    expect(getCapture).toHaveBeenCalledTimes(1);

    await act(async () => {
      source.emit('capture.updated', { type: 'capture.updated', captureId: 'cap_1' });
      source.emit('processing.completed', { type: 'processing.completed', captureId: 'cap_1' });
      await Promise.resolve();
    });
    expect(getCapture).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.(detail('cap_1'));
      await Promise.resolve();
    });
    await settle(CAPTURE_REFETCH_DEBOUNCE_MS);
    expect(getCapture).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('re-reads the roll record after the arrival, never beside it', async () => {
    /**
     * `capture.created` used to put `getCapture` and `getRoll` on the wire in
     * the same tick. Through a tunnel that charges about 2.2 s for a new
     * connection and serialises them, that pair was the whole 4,439 ms the
     * guest waited for a tile the origin answered in 10 to 17 ms.
     */
    let release: ((capture: CaptureDetail) => void) | undefined;
    getCapture.mockImplementationOnce(
      () =>
        new Promise<CaptureDetail>((resolve) => {
          release = resolve;
        }),
    );
    const onRollChanged = vi.fn();
    const source = await mount({ prepend: vi.fn(), onRollChanged });

    await act(async () => {
      source.emit('capture.created', { type: 'capture.created', captureId: 'cap_1' });
      await Promise.resolve();
    });
    expect(onRollChanged).not.toHaveBeenCalled();

    // Still nothing while the capture holds the connection.
    await settle(ROLL_REFRESH_DEBOUNCE_MS * 2);
    expect(onRollChanged).not.toHaveBeenCalled();

    await act(async () => {
      release?.(detail('cap_1'));
      await Promise.resolve();
    });
    await settle(ROLL_REFRESH_DEBOUNCE_MS);
    expect(onRollChanged).toHaveBeenCalledTimes(1);
  });

  it('a roll-level event still re-reads the roll immediately', async () => {
    const onRollChanged = vi.fn();
    const source = await mount({ onRollChanged });

    act(() => source.emit('roll.closed', { type: 'roll.closed' }));
    expect(onRollChanged).toHaveBeenCalledTimes(1);
  });

  it('drops a queued refetch for a capture that was deleted', async () => {
    const source = await mount({ replace: vi.fn(), remove: vi.fn() });

    await act(async () => {
      source.emit('capture.updated', { type: 'capture.updated', captureId: 'cap_1' });
      await vi.advanceTimersByTimeAsync(100);
      source.emit('capture.deleted', { type: 'capture.deleted', captureId: 'cap_1' });
    });
    await settle(CAPTURE_REFETCH_DEBOUNCE_MS * 2);
    expect(getCapture).not.toHaveBeenCalled();
  });

  it('drops a removal for a capture this subscriber does not hold', async () => {
    const remove = vi.fn();
    const source = await mount({ wants: (id) => id === 'cap_mine', remove });

    await act(async () => {
      source.emit('capture.deleted', { type: 'capture.deleted', captureId: 'cap_other' });
    });
    expect(remove).not.toHaveBeenCalled();

    await act(async () => {
      source.emit('capture.hidden', { type: 'capture.hidden', captureId: 'cap_mine' });
    });
    expect(remove).toHaveBeenCalledWith('cap_mine');
  });

  it('fetches every capture when no filter is given — the feed wants them all', async () => {
    const prepend = vi.fn();
    const source = await mount({ prepend });

    await act(async () => {
      source.emit('capture.created', { type: 'capture.created', captureId: 'cap_1' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getCapture).toHaveBeenCalledWith('party', 'cap_1');
    expect(prepend).toHaveBeenCalledTimes(1);
  });
});
