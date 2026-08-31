// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureDetail, RollApi } from '../src/api/client';
import { useRollEvents, type RollEventHandlers } from '../src/hooks/useRollEvents';

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
  });

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
      await Promise.resolve();
    });
    expect(getCapture).toHaveBeenCalledTimes(1);
    expect(getCapture).toHaveBeenCalledWith('party', 'cap_mine');
    expect(replace).toHaveBeenCalledTimes(1);
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
