// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_TOKEN_STORAGE_KEY,
  consumeHostToken,
  type HostApi,
  type HostCaptureView,
  type HostRollEvent,
  type HostRollView,
} from '../src/api/hostClient';
import { HostDashboard } from '../src/pages/HostDashboard';

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr') } }));

const reactTestGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

const roll: HostRollView = {
  rollId: 'roll_1',
  slug: 'ABC234',
  title: 'Launch party',
  status: 'live',
  privacy: 'unlisted',
  hasPin: false,
  downloadsEnabled: true,
  reactionsEnabled: true,
  deviceSerial: 'KINO-D4-001',
  guestUrl: 'https://roll.test/r/ABC234',
  createdAt: '2026-08-20T12:00:00.000Z',
  closedAt: null,
  counts: { captures: 1, pending: 0, hidden: 0 },
  guests: 3,
};

const capture: HostCaptureView = {
  captureId: 'cap_1',
  mode: 'wiggle',
  look: null,
  capturedAt: '2026-08-20T12:01:00.000Z',
  createdAt: '2026-08-20T12:01:01.000Z',
  frameCount: 4,
  resolution: '2048x1536',
  status: 'ready',
  assets: [],
  visible: true,
  deletedAt: null,
  purgeAfter: null,
};

function fakeApi(overrides: Partial<HostApi> = {}): HostApi {
  return {
    resolveSession: vi.fn().mockResolvedValue(roll),
    getRoll: vi.fn().mockResolvedValue(roll),
    updateRoll: vi.fn().mockResolvedValue(roll),
    listCaptures: vi.fn().mockResolvedValue({ items: [capture], hasMore: false }),
    hide: vi.fn().mockResolvedValue({ captureId: 'cap_1', visible: false, deletedAt: null, purgeAfter: null }),
    unhide: vi.fn(),
    deleteCapture: vi.fn(),
    regenerateSlug: vi.fn(),
    startExport: vi.fn(),
    getExport: vi.fn(),
    assetUrl: vi.fn((id: string) => `/asset/${id}`),
    events: vi.fn(() => vi.fn()),
    ...overrides,
  };
}

describe('host dashboard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(api: HostApi, pollMs = 0): Promise<void> {
    await act(async () => {
      root.render(<HostDashboard api={api} pollMs={pollMs} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('moves the deep-link token into session storage and strips the hash', () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    const history = { replaceState: vi.fn() };
    const token = consumeHostToken(
      { hash: '#token=hrt_secret-token', pathname: '/host', search: '?from=studio' },
      history,
      storage,
    );

    expect(token).toBe('hrt_secret-token');
    expect(storage.setItem).toHaveBeenCalledWith(HOST_TOKEN_STORAGE_KEY, 'hrt_secret-token');
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/host?from=studio');
  });

  it('hides optimistically and reconciles the moderation grid from the event stream', async () => {
    let eventHandler: ((event: HostRollEvent) => void) | undefined;
    let hideResolve: ((value: { captureId: string; visible: boolean; deletedAt: null; purgeAfter: null }) => void) | undefined;
    const hide = vi.fn(() => new Promise<{ captureId: string; visible: boolean; deletedAt: null; purgeAfter: null }>((resolve) => { hideResolve = resolve; }));
    const listCaptures = vi
      .fn()
      .mockResolvedValueOnce({ items: [capture], hasMore: false })
      .mockResolvedValue({ items: [{ ...capture, visible: false }], hasMore: false });
    const api = fakeApi({
      hide,
      listCaptures,
      events: vi.fn((_rollId, handler) => {
        eventHandler = handler;
        return vi.fn();
      }),
    });
    await render(api);

    const hideButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Hide');
    await act(async () => hideButton?.click());
    expect(container.textContent).toContain('HIDDEN');
    expect(hide).toHaveBeenCalledWith('cap_1');

    await act(async () => {
      eventHandler?.({ type: 'capture.hidden', captureId: 'cap_1' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listCaptures).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Unhide');

    await act(async () => hideResolve?.({ captureId: 'cap_1', visible: false, deletedAt: null, purgeAfter: null }));
  });

  it('polls an export job until its download link is ready', async () => {
    const startExport = vi.fn().mockResolvedValue({ jobId: 'export_1' });
    const getExport = vi
      .fn()
      .mockResolvedValueOnce({ status: 'queued' })
      .mockResolvedValueOnce({ status: 'done', url: 'https://storage.test/export.zip' });
    await render(fakeApi({ startExport, getExport }));

    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === 'Prepare ZIP');
    // Waits for the second poll rather than racing one fixed sleep against
    // it: the poll interval is real time, so a fixed window turns unrelated
    // module-load cost into a failed assertion.
    await act(async () => {
      button?.click();
      const deadline = Date.now() + 2000;
      while (getExport.mock.calls.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    expect(startExport).toHaveBeenCalledWith('roll_1');
    expect(getExport).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    expect(container.querySelector('a[href="https://storage.test/export.zip"]')?.textContent).toBe('Download ZIP');
  });
});
