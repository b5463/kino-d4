// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_TOKEN_STORAGE_KEY,
  consumeHostToken,
  hostLinkUrl,
  isHostTokenRemembered,
  rememberHostToken,
  type HostApi,
  type HostCameraView,
  type HostCaptureView,
  type HostRollEvent,
  type HostRollView,
} from '../src/api/hostClient';
import { ApiError } from '../src/api/client';
import { HostDashboard, exportWording, formatBytes } from '../src/pages/HostDashboard';
import { HostDashboardPage } from '../src/pages/HostDashboardPage';
import { cameraReport, relativeTime } from '../src/components/host/CameraPanel';
import { matchesFilter } from '../src/components/host/CaptureGrid';

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr') } }));

const reactTestGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

// The window virtualiser calls `window.scrollTo` once when it attaches to the
// scroll element. jsdom does not implement it and prints a stack for every
// render; the gap is jsdom's, not the grid's.
window.scrollTo = (): undefined => undefined;

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

const trashed: HostCaptureView = {
  ...capture,
  captureId: 'cap_2',
  capturedAt: '2026-08-20T12:00:30.000Z',
  deletedAt: '2026-08-20T12:05:00.000Z',
  purgeAfter: '2026-08-27T12:05:00.000Z',
  visible: false,
};

function fakeApi(overrides: Partial<HostApi> = {}): HostApi {
  return {
    resolveSession: vi.fn().mockResolvedValue(roll),
    getRoll: vi.fn().mockResolvedValue(roll),
    updateRoll: vi.fn().mockResolvedValue(roll),
    listCaptures: vi.fn().mockResolvedValue({ items: [capture], hasMore: false }),
    getCapture: vi.fn().mockResolvedValue(capture),
    hide: vi.fn().mockResolvedValue({ captureId: 'cap_1', visible: false, deletedAt: null, purgeAfter: null }),
    unhide: vi.fn(),
    deleteCapture: vi
      .fn()
      .mockResolvedValue({ captureId: 'cap_1', visible: false, deletedAt: '2026-08-20T12:06:00.000Z', purgeAfter: '2026-08-27T12:06:00.000Z' }),
    restore: vi.fn().mockResolvedValue({ ...capture, deletedAt: null, purgeAfter: null }),
    clearRoll: vi.fn().mockResolvedValue({ cleared: 1 }),
    regenerateSlug: vi.fn(),
    startExport: vi.fn(),
    getExport: vi.fn(),
    exportEstimate: vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'no estimate')),
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

  async function render(api: HostApi, props: Partial<Parameters<typeof HostDashboard>[0]> = {}): Promise<void> {
    await act(async () => {
      root.render(<HostDashboard api={api} pollMs={0} {...props} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  const button = (label: string): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find((item) => item.textContent === label);

  it('moves the deep-link token into session storage and strips the hash', () => {
    const session = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    const local = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    const history = { replaceState: vi.fn() };
    const token = consumeHostToken(
      { hash: '#token=hrt_secret-token', pathname: '/host', search: '?from=studio' },
      history,
      session,
      local,
    );

    expect(token).toBe('hrt_secret-token');
    expect(session.setItem).toHaveBeenCalledWith(HOST_TOKEN_STORAGE_KEY, 'hrt_secret-token');
    // Default off: nothing is written to the device store unless asked for.
    expect(local.setItem).not.toHaveBeenCalled();
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/host?from=studio');
  });

  it('survives a tab close only when the host asked it to', () => {
    const empty = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    const local = new Map<string, string>();
    const localStore = {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => void local.set(key, value),
      removeItem: (key: string) => void local.delete(key),
    };

    rememberHostToken('hrt_kept', true, localStore);
    expect(isHostTokenRemembered(localStore)).toBe(true);
    // A brand-new tab: session storage is empty, and the device store answers.
    expect(consumeHostToken({ hash: '', pathname: '/host', search: '' }, { replaceState: vi.fn() }, empty, localStore)).toBe('hrt_kept');

    rememberHostToken('hrt_kept', false, localStore);
    expect(isHostTokenRemembered(localStore)).toBe(false);
    expect(consumeHostToken({ hash: '', pathname: '/host', search: '' }, { replaceState: vi.fn() }, empty, localStore)).toBeNull();
  });

  it('rebuilds the whole host link from the token the tab is holding', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await render(fakeApi(), { token: 'hrt_abc' });

    expect(hostLinkUrl('hrt_abc', 'https://kino.test')).toBe('https://kino.test/host#token=hrt_abc');
    await act(async () => button('Copy host link')?.click());
    expect(writeText).toHaveBeenCalledWith(hostLinkUrl('hrt_abc'));
    // And the one-line warning is there on a device that has not seen it.
    expect(container.querySelector('[role="note"]')?.textContent).toContain('only copy');
  });

  it('hides optimistically and reconciles the moderation grid from the event stream', async () => {
    let eventHandler: ((event: HostRollEvent) => void) | undefined;
    let hideResolve: ((value: { captureId: string; visible: boolean; deletedAt: null; purgeAfter: null }) => void) | undefined;
    const hide = vi.fn(() => new Promise<{ captureId: string; visible: boolean; deletedAt: null; purgeAfter: null }>((resolve) => { hideResolve = resolve; }));
    const getCapture = vi.fn().mockResolvedValue({ ...capture, visible: false });
    const api = fakeApi({
      hide,
      getCapture,
      events: vi.fn((_rollId, handler) => {
        eventHandler = handler;
        return vi.fn();
      }),
    });
    await render(api);

    await act(async () => button('Hide')?.click());
    expect(container.querySelector('[data-capture-id="cap_1"]')?.getAttribute('aria-label')).toContain('Hidden');
    expect(hide).toHaveBeenCalledWith('cap_1');

    await act(async () => {
      eventHandler?.({ type: 'capture.hidden', captureId: 'cap_1' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getCapture).toHaveBeenCalledWith('cap_1');
    expect(container.textContent).toContain('Unhide');

    await act(async () => hideResolve?.({ captureId: 'cap_1', visible: false, deletedAt: null, purgeAfter: null }));
  });

  it('reads one capture straight instead of paging the feed until it finds it', async () => {
    /**
     * Regression: with no single-capture route the dashboard paged the keyset
     * feed looking for the id, which for an old capture in a party roll was 36
     * requests to learn that one derivative had finished.
     */
    let eventHandler: ((event: HostRollEvent) => void) | undefined;
    const listCaptures = vi.fn().mockResolvedValue({ items: [capture], hasMore: false });
    const getCapture = vi.fn().mockResolvedValue(capture);
    const getRoll = vi.fn().mockResolvedValue(roll);
    const api = fakeApi({
      listCaptures,
      getCapture,
      getRoll,
      events: vi.fn((_rollId, handler) => {
        eventHandler = handler;
        return vi.fn();
      }),
    });
    await render(api);
    expect(listCaptures).toHaveBeenCalledTimes(1);

    await act(async () => {
      eventHandler?.({ type: 'processing.completed', captureId: 'cap_1', role: 'wiggle-mp4' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getCapture).toHaveBeenCalledTimes(1);
    // Not one further page of the feed, and not a roll re-read either.
    expect(listCaptures).toHaveBeenCalledTimes(1);
    expect(getRoll).not.toHaveBeenCalled();

    await act(async () => {
      eventHandler?.({ type: 'roll.closed' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getCapture).toHaveBeenCalledTimes(1);
    expect(getRoll).toHaveBeenCalledTimes(1);
  });

  it('offers Undo on a capture the last click trashed, and Restore on any other', async () => {
    const restore = vi.fn().mockResolvedValue({ ...capture, deletedAt: null, purgeAfter: null });
    const deleteCapture = vi
      .fn()
      .mockResolvedValue({ captureId: 'cap_1', visible: false, deletedAt: '2026-08-20T12:06:00.000Z', purgeAfter: '2026-08-27T12:06:00.000Z' });
    const api = fakeApi({
      restore,
      deleteCapture,
      listCaptures: vi.fn().mockResolvedValue({ items: [capture, trashed], hasMore: false }),
    });
    await render(api);

    // A capture that was already in the trash offers Restore, not Undo.
    const older = container.querySelector('[data-capture-id="cap_2"]');
    expect(older?.textContent).toContain('Restore');
    expect(older?.getAttribute('aria-label')).toContain('In trash');

    // One click deletes — no dialog — and the grace period is said in words.
    await act(async () => button('Delete')?.click());
    expect(deleteCapture).toHaveBeenCalledWith('cap_1');
    const tile = container.querySelector('[data-capture-id="cap_1"]');
    expect(tile?.textContent).toContain('Undo delete');
    expect(container.querySelector('.host-trash-note')?.textContent).toContain('7 days');

    await act(async () => button('Undo delete')?.click());
    expect(restore).toHaveBeenCalledWith('cap_1');
    expect(container.querySelector('[data-capture-id="cap_1"]')?.textContent).toContain('Delete');
  });

  it('filters the grid without reordering it', async () => {
    const api = fakeApi({
      listCaptures: vi.fn().mockResolvedValue({
        items: [capture, { ...capture, captureId: 'cap_3', visible: false }, trashed],
        hasMore: false,
      }),
    });
    await render(api);

    expect(button('All 3')).toBeDefined();
    expect(button('Hidden 1')).toBeDefined();
    expect(button('In trash 1')).toBeDefined();

    await act(async () => button('In trash 1')?.click());
    expect(container.querySelector('[data-capture-id="cap_2"]')).not.toBeNull();
    expect(container.querySelector('[data-capture-id="cap_1"]')).toBeNull();

    await act(async () => button('Failed 0')?.click());
    expect(container.textContent).toContain('Nothing in Failed.');
  });

  it('says what the ZIP will cost before the button, in words', async () => {
    const exportEstimate = vi.fn().mockResolvedValue({ files: 9400, bytes: 17_600_000_000 });
    const startExport = vi.fn().mockResolvedValue({ jobId: 'export_1' });
    const getExport = vi
      .fn()
      .mockResolvedValueOnce({ status: 'queued' })
      .mockResolvedValueOnce({ status: 'done', url: 'https://storage.test/export.zip' });
    await render(fakeApi({ exportEstimate, startExport, getExport }));

    expect(container.querySelector('.host-estimate')?.textContent).toBe('≈17.6 GB, 9,400 files');

    await act(async () => {
      button('Prepare ZIP')?.click();
      const deadline = Date.now() + 2000;
      while (getExport.mock.calls.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    expect(startExport).toHaveBeenCalledWith('roll_1');
    expect(getExport).toHaveBeenCalledTimes(2);
    const link = container.querySelector<HTMLAnchorElement>('a[href="https://storage.test/export.zip"]');
    expect(link?.textContent).toBe('Download ZIP');
    expect(link?.getAttribute('download')).toBe('kino-roll-ABC234.zip');
    // And it says another export is another ZIP, not a replacement.
    expect(container.textContent).toContain('Preparing it again builds another one');
  });

  it('asks before closing the roll, which stops the camera mid-party', async () => {
    const updateRoll = vi.fn().mockResolvedValue({ ...roll, status: 'closed' });
    await render(fakeApi({ updateRoll }));

    await act(async () => button('Close Roll…')?.click());
    expect(updateRoll).not.toHaveBeenCalled();
    const confirm = container.querySelector('[aria-label="Close roll"]');
    expect(confirm?.textContent).toContain('stops the camera uploading');

    await act(async () => button('Cancel')?.click());
    expect(updateRoll).not.toHaveBeenCalled();

    await act(async () => button('Close Roll…')?.click());
    await act(async () => button('Close the roll')?.click());
    expect(updateRoll).toHaveBeenCalledWith('roll_1', { status: 'closed' });
  });

  it('opens the guest view and the TV display in new tabs', async () => {
    await render(fakeApi());
    const guest = container.querySelector<HTMLAnchorElement>('a[href="https://roll.test/r/ABC234"]');
    expect(guest?.target).toBe('_blank');
    const display = container.querySelector<HTMLAnchorElement>('a[href="https://roll.test/r/ABC234/display?qr=1"]');
    expect(display?.target).toBe('_blank');
  });

  it('names the QR by its code and offers it as a file', async () => {
    await render(fakeApi());
    const qr = container.querySelector<HTMLImageElement>('.host-qr');
    expect(qr?.alt).toContain('ABC234');
    expect(qr?.alt).toContain('roll.test/r/ABC234');
    const download = container.querySelector<HTMLAnchorElement>('a[download="kino-roll-ABC234.png"]');
    expect(download).not.toBeNull();
  });

  it('reads the totals as a description list, not four loose divs', async () => {
    await render(fakeApi());
    const list = container.querySelector('dl.host-stats');
    expect(list?.querySelectorAll('dt').length).toBe(4);
    expect(list?.querySelector('dt')?.textContent).toBe('CAPTURES');
    expect(list?.querySelector('dd')?.textContent).toBe('1');
  });

  it('offers a way back to the paste form when the token is refused', async () => {
    const onSignOut = vi.fn();
    const api = fakeApi({ resolveSession: vi.fn().mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'host token expired')) });
    await render(api, { onSignOut });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('no longer accepted');
    await act(async () => button('Paste a different host token')?.click());
    expect(onSignOut).toHaveBeenCalled();
  });

  it('says it is reading the roll rather than "Loading Roll…"', async () => {
    const api = fakeApi({ resolveSession: vi.fn(() => new Promise<HostRollView>(() => undefined)) });
    await render(api);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Reading the roll…');
  });

  it('clears the roll only after the host types the roll code, and reports the count', async () => {
    const clearRoll = vi.fn().mockResolvedValue({ cleared: 1 });
    const getRoll = vi.fn().mockResolvedValue({ ...roll, counts: { captures: 1, pending: 0, hidden: 0 } });
    const api = fakeApi({ clearRoll, getRoll });
    await render(api);

    expect(container.querySelector('#host-clear-code')).toBeNull();
    await act(async () => button('Clear roll…')?.click());

    const form = container.querySelector('form[aria-label="Clear roll"]');
    expect(form?.textContent).toContain('all 1 captures');
    expect(form?.textContent).toContain('ABC234');
    expect(button('Clear 1 captures')?.disabled).toBe(true);
    const input = container.querySelector<HTMLInputElement>('#host-clear-code');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const type = async (value: string): Promise<void> => {
      await act(async () => {
        setter?.call(input, value);
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await type('ABC999');
    expect(button('Clear 1 captures')?.disabled).toBe(true);
    expect(clearRoll).not.toHaveBeenCalled();

    // Case does not matter — the card prints capitals, thumbs do not.
    await type('abc234');
    expect(button('Clear 1 captures')?.disabled).toBe(false);
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(clearRoll).toHaveBeenCalledWith('roll_1');
    expect(container.querySelector('#host-clear-code')).toBeNull();
    expect(container.querySelector('.host-danger [role="status"]')?.textContent).toContain('Cleared 1 capture');
    expect(container.querySelector('[data-capture-id="cap_1"]')?.getAttribute('aria-label')).toContain('In trash');
  });

  it('re-lists the roll on a roll.cleared event', async () => {
    let eventHandler: ((event: HostRollEvent) => void) | undefined;
    const listCaptures = vi
      .fn()
      .mockResolvedValueOnce({ items: [capture], hasMore: false })
      .mockResolvedValue({ items: [{ ...capture, deletedAt: '2026-08-20T13:00:00.000Z' }], hasMore: false });
    const getRoll = vi.fn().mockResolvedValue(roll);
    const api = fakeApi({
      listCaptures,
      getRoll,
      events: vi.fn((_rollId, handler) => {
        eventHandler = handler;
        return vi.fn();
      }),
    });
    await render(api);
    await act(async () => {
      eventHandler?.({ type: 'roll.cleared' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listCaptures).toHaveBeenCalledTimes(2);
    expect(getRoll).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-capture-id="cap_1"]')?.getAttribute('aria-label')).toContain('In trash');
  });
});

describe('camera panel', () => {
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

  const camera = (over: Partial<HostCameraView>): HostCameraView => ({
    deviceId: 'dev_1',
    serial: 'KINO-D4-001',
    lastSeenAt: new Date('2026-08-20T12:00:00.000Z').toISOString(),
    pending: 0,
    uploading: 0,
    failed: 0,
    serverState: 'reachable',
    firmware: '0.4.43',
    ...over,
  });

  const now = new Date('2026-08-20T12:00:12.000Z').getTime();

  it('uses the camera screen wording, not a second vocabulary', () => {
    expect(relativeTime('2026-08-20T12:00:00.000Z', now)).toBe('12 s ago');

    const online = cameraReport(camera({ pending: 3 }), now);
    expect(online.word).toBe('ONLINE');
    expect(online.queue).toBe('3 waiting to upload');
    expect(cameraReport(camera({}), now).queue).toBe('All uploaded');

    expect(cameraReport(camera({ serverState: 'unreachable' }), now).word).toBe('KINO NOT ANSWERING');
    expect(cameraReport(camera({ uploadPaused: true }), now).word).toBe('UPLOAD PAUSED');
    expect(cameraReport(camera({ serverState: 'offline' }), now).word).toBe('OFFLINE');
  });

  it('reads a heartbeat older than two minutes as not reporting', () => {
    const stale = cameraReport(camera({ lastSeenAt: '2026-08-20T11:55:00.000Z' }), now);
    expect(stale.word).toBe('NOT REPORTING');
    expect(stale.lamp).toBe('warn');
    expect(stale.note).toContain('5 m ago');
    // A heartbeat one second inside the window is still a report.
    expect(cameraReport(camera({ lastSeenAt: '2026-08-20T11:58:13.000Z' }), now).word).toBe('ONLINE');
  });

  it('says an older firmware does not report, rather than calling it offline', () => {
    const never = cameraReport(camera({ lastSeenAt: null, pending: null, uploading: null, failed: null, serverState: null, firmware: '0.3.9' }), now);
    expect(never.word).toBe('NOT REPORTING');
    expect(never.word).not.toBe('OFFLINE');
    expect(never.note).toContain('does not report at all');
    expect(never.seen).toBe('never');
    // No counters are invented for a camera that has never sent any.
    expect(never.queue).toBe('');
  });

  it('says so plainly when the server does not report cameras at all', async () => {
    const api = fakeApi({ resolveSession: vi.fn().mockResolvedValue(roll) });
    await act(async () => {
      root.render(<HostDashboard api={api} pollMs={0} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('does not report camera status');
  });

  it('shows serial, lamp, waiting count and last seen for each camera', async () => {
    const withCameras: HostRollView = {
      ...roll,
      cameras: [
        camera({ pending: 3, uploading: 0 }),
        camera({ deviceId: 'dev_2', serial: 'KINO-D4-002', lastSeenAt: null, pending: null, uploading: null, failed: null, serverState: null }),
      ],
    };
    const api = fakeApi({ resolveSession: vi.fn().mockResolvedValue(withCameras) });
    await act(async () => {
      root.render(<HostDashboard api={api} pollMs={0} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const rows = container.querySelectorAll('.host-camera');
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain('KINO-D4-001');
    expect(rows[0]?.textContent).toContain('3 waiting to upload');
    expect(rows[0]?.textContent).toContain('firmware 0.4.43');
    expect(rows[1]?.getAttribute('data-word')).toBe('NOT REPORTING');
    expect(rows[1]?.textContent).toContain('Last status never');
  });
});

describe('host helpers', () => {
  it('prints an estimate as an estimate', () => {
    expect(formatBytes(17_600_000_000)).toBe('17.6 GB');
    expect(formatBytes(940)).toBe('940 B');
    expect(formatBytes(0)).toBe('0 B');
  });

  it('turns export enum values into sentences', () => {
    expect(exportWording('queued')).toContain('Queued');
    expect(exportWording('running')).toContain('Building the ZIP');
    expect(exportWording('done')).toBe('Ready.');
    // An unknown state is still shown rather than swallowed.
    expect(exportWording('reticulating')).toBe('Export: reticulating');
  });

  it('sorts a capture into exactly the filters it belongs to', () => {
    const failed = { ...capture, status: 'failed' };
    const pending = { ...capture, status: 'processing' };
    const hidden = { ...capture, visible: false };
    expect(matchesFilter(capture, 'pending')).toBe(false);
    expect(matchesFilter(pending, 'pending')).toBe(true);
    expect(matchesFilter(failed, 'failed')).toBe(true);
    expect(matchesFilter(hidden, 'hidden')).toBe(true);
    expect(matchesFilter(trashed, 'trash')).toBe(true);
    // A trashed capture is in the trash and nowhere else, whatever it was.
    expect(matchesFilter(trashed, 'hidden')).toBe(false);
    expect(matchesFilter(trashed, 'pending')).toBe(false);
  });
});

describe('host token gate', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('says why a rejected token was rejected instead of doing nothing', async () => {
    // The button used to appear to work: a token the client refused left the
    // page exactly as it was, with no message and no navigation.
    await act(async () => root.render(<HostDashboardPage />));

    const input = container.querySelector<HTMLInputElement>('#host-token');
    const form = container.querySelector('form');
    input!.value = '   ';
    await act(async () => form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('host token');
  });

  it('offers "keep me signed in", default off', async () => {
    await act(async () => root.render(<HostDashboardPage />));
    const keep = container.querySelector<HTMLInputElement>('#host-remember');
    expect(keep?.checked).toBe(false);
    expect(container.textContent).toContain('cannot be re-issued');
  });
});
