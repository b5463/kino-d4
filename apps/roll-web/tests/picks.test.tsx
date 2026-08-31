// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type CaptureView, type RollApi } from '../src/api/client';
import {
  readPicks,
  setPick,
  togglePick,
  usePickedCaptures,
  usePicks,
} from '../src/state/picks';

const reactTestGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

function capture(captureId: string, capturedAt = '2026-08-14T20:00:00.000Z'): CaptureView {
  return {
    captureId,
    mode: 'single',
    look: null,
    playback: null,
    capturedAt,
    createdAt: capturedAt,
    frameCount: 1,
    resolution: '1600x1200',
    status: 'ready',
    assets: [],
  };
}

function apiWith(overrides: Partial<RollApi> = {}): RollApi {
  return {
    getRoll: vi.fn(),
    submitPin: vi.fn(),
    listCaptures: vi.fn(),
    getCapture: vi.fn(),
    assetUrl: (id) => `/api/assets/${id}/content`,
    react: vi.fn(),
    requestRender: vi.fn(),
    events: vi.fn(),
    ...overrides,
  };
}

describe('picks store', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips picks per roll through localStorage', () => {
    setPick('party', 'cap_1', true);
    setPick('party', 'cap_2', true);
    setPick('other', 'cap_9', true);

    expect([...readPicks('party')].sort()).toEqual(['cap_1', 'cap_2']);
    expect([...readPicks('other')]).toEqual(['cap_9']);

    setPick('party', 'cap_1', false);
    expect([...readPicks('party')]).toEqual(['cap_2']);
  });

  it('togglePick flips and reports the new state', () => {
    expect(togglePick('party', 'cap_1')).toBe(true);
    expect(readPicks('party').has('cap_1')).toBe(true);
    expect(togglePick('party', 'cap_1')).toBe(false);
    expect(readPicks('party').has('cap_1')).toBe(false);
  });

  it('survives garbage in the stored value', () => {
    localStorage.setItem('kino-picks:party', 'not json');
    expect(readPicks('party').size).toBe(0);
    localStorage.setItem('kino-picks:party', JSON.stringify({ nope: 1 }));
    expect(readPicks('party').size).toBe(0);
  });
});

describe('picks hooks', () => {
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
    localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('usePicks sees a write made in this tab', async () => {
    const observed: { current: ReadonlySet<string> | null } = { current: null };
    function Harness() {
      observed.current = usePicks('party');
      return null;
    }
    await render(<Harness />);
    expect(observed.current?.size).toBe(0);

    act(() => setPick('party', 'cap_1', true));
    expect(observed.current?.has('cap_1')).toBe(true);
  });

  it('usePicks sees a write made in another tab (storage event)', async () => {
    const observed: { current: ReadonlySet<string> | null } = { current: null };
    function Harness() {
      observed.current = usePicks('party');
      return null;
    }
    await render(<Harness />);

    localStorage.setItem('kino-picks:party', JSON.stringify(['cap_2']));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'kino-picks:party' }));
    });
    expect(observed.current?.has('cap_2')).toBe(true);
  });

  it('usePickedCaptures reuses loaded captures and fetches the rest, newest first', async () => {
    const loaded = [capture('cap_loaded', '2026-08-14T20:05:00.000Z')];
    const fetched = { ...capture('cap_fetched', '2026-08-14T20:10:00.000Z'), reactionCount: 1, reacted: true };
    const getCapture = vi.fn().mockResolvedValue(fetched);
    const api = apiWith({ getCapture });
    const picks = new Set(['cap_loaded', 'cap_fetched']);
    const observed: { current: CaptureView[] | null } = { current: null };

    function Harness() {
      observed.current = usePickedCaptures('party', picks, loaded, api);
      return null;
    }
    await render(<Harness />);

    expect(getCapture).toHaveBeenCalledWith('party', 'cap_fetched');
    expect(getCapture).not.toHaveBeenCalledWith('party', 'cap_loaded');
    expect(observed.current?.map((item) => item.captureId)).toEqual(['cap_fetched', 'cap_loaded']);
  });

  it('asks for each missing pick exactly once, however often the effect re-runs', async () => {
    /**
     * Regression: `fetched` was an effect dependency, so every resolution
     * re-ran the whole batch. With the answers landing one at a time that is
     * N²/2 duplicate `getCapture` requests — 20 picks cost ~190 extra
     * round-trips on a phone. The in-flight set is what makes the re-runs
     * (a new page of the feed, a changed pick set) free.
     */
    const ids = ['cap_a', 'cap_b', 'cap_c', 'cap_d'];
    const resolvers: (() => void)[] = [];
    const getCapture = vi.fn((_slug: string, captureId: string) =>
      new Promise((resolve) => {
        resolvers.push(() =>
          resolve({ ...capture(captureId), reactionCount: 0, reacted: false }),
        );
      }),
    );
    const api = apiWith({ getCapture: getCapture as unknown as RollApi['getCapture'] });
    const picks = new Set(ids);

    function Harness() {
      usePickedCaptures('party', picks, [], api);
      return null;
    }
    await render(<Harness />);
    expect(getCapture).toHaveBeenCalledTimes(ids.length);

    // Resolve them one at a time: each resolution re-renders, and a re-render
    // must not put a second request for any id on the wire.
    for (const resolve of [...resolvers]) {
      await act(async () => {
        resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(getCapture).toHaveBeenCalledTimes(ids.length);
    expect(getCapture.mock.calls.map(([, id]) => id).sort()).toEqual([...ids].sort());
  });

  it('does not re-request a pick when a new feed page arrives', async () => {
    let resolveFirst: ((value: CaptureView) => void) | undefined;
    const getCapture = vi.fn(
      () => new Promise((resolve) => {
        resolveFirst = resolve as (value: CaptureView) => void;
      }),
    );
    const api = apiWith({ getCapture: getCapture as unknown as RollApi['getCapture'] });
    const picks = new Set(['cap_missing']);

    function Harness({ loaded }: { loaded: CaptureView[] }) {
      usePickedCaptures('party', picks, loaded, api);
      return null;
    }
    await render(<Harness loaded={[]} />);
    expect(getCapture).toHaveBeenCalledTimes(1);

    // A different `loaded` array — a page load, which is a real dependency
    // change — while the first request is still in the air.
    await render(<Harness loaded={[capture('cap_other')]} />);
    expect(getCapture).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst?.({ ...capture('cap_missing'), reactionCount: 0, reacted: false } as CaptureView);
      await Promise.resolve();
    });
    expect(getCapture).toHaveBeenCalledTimes(1);
  });

  it('drops a pick the server answers CAPTURE_NOT_FOUND for (host moderation wins)', async () => {
    setPick('party', 'cap_gone', true);
    const getCapture = vi
      .fn()
      .mockRejectedValue(new ApiError(404, 'CAPTURE_NOT_FOUND', 'no such capture'));
    const api = apiWith({ getCapture });
    const observed: { current: CaptureView[] | null } = { current: null };

    function Harness() {
      observed.current = usePickedCaptures('party', readPicks('party'), [], api);
      return null;
    }
    await render(<Harness />);

    expect(observed.current).toEqual([]);
    expect(readPicks('party').has('cap_gone')).toBe(false);
  });
});
