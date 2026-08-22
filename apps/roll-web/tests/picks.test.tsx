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
