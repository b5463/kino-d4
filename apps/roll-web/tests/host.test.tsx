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
import { cameraReport, relativeTime, worstCamera } from '../src/components/host/CameraPanel';
import { stuckItems } from '../src/components/host/StatusStrip';
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
    // A ModerationView, which is what POST /restore really answers — four
    // fields, not a whole capture. Verified against the running API.
    restore: vi
      .fn()
      .mockResolvedValue({ captureId: 'cap_1', visible: true, deletedAt: null, purgeAfter: null }),
    clearRoll: vi.fn().mockResolvedValue({ cleared: 1 }),
    regenerateSlug: vi.fn(),
    startExport: vi.fn(),
    getExport: vi.fn(),
    exportEstimate: vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'no estimate')),
    exportBlob: vi.fn().mockResolvedValue(new Blob(['zip'])),
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
    const back = container.querySelector('[data-capture-id="cap_1"]');
    expect(back?.textContent).toContain('Delete');
    // And the capture is still a capture. `restore` answers a ModerationView,
    // so assigning the reply over the row used to wipe mode, capturedAt,
    // status and assets — the tile came back with an undefined mode and an
    // Invalid Date on it.
    expect(back?.getAttribute('aria-label')).toContain('wiggle');
    expect(back?.getAttribute('aria-label')).not.toContain('Invalid Date');
    expect(back?.getAttribute('aria-label')).toContain('Visible');
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
    // And it says another export is another ZIP, not a replacement.
    expect(container.textContent).toContain('Preparing it again builds another one');
  });

  /**
   * Production runs `OBJECT_DELIVERY: proxy`, so the URL the poll route hands
   * back is the API's own `/export/:jobId/content`, which is behind
   * `requireHost` and reads the bearer token and nothing else. This used to be
   * a plain `<a href download>`: the browser sent no Authorization header, the
   * route answered 401, and the page said nothing at all. Confirmed against
   * the running dev API — 200 with the header, 401 without it.
   */
  it('fetches the ZIP with the host token rather than linking at it', async () => {
    const exportBlob = vi.fn().mockResolvedValue(new Blob(['zip']));
    const startExport = vi.fn().mockResolvedValue({ jobId: 'export_1' });
    const url = 'https://roll.test/api/host/rolls/roll_1/export/export_1/content';
    const getExport = vi.fn().mockResolvedValue({ status: 'done', url });
    await render(
      fakeApi({
        startExport,
        getExport,
        exportBlob,
        exportEstimate: vi.fn().mockResolvedValue({ files: 4, bytes: 900 }),
      }),
    );

    await act(async () => {
      button('Prepare ZIP')?.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // No bare link to the authenticated route — that is the whole bug.
    expect(container.querySelector(`a[href="${url}"]`)).toBeNull();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    URL.createObjectURL = vi.fn(() => 'blob:zip');
    URL.revokeObjectURL = vi.fn();
    await act(async () => {
      button('Download ZIP')?.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(exportBlob).toHaveBeenCalledWith(url);
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  /**
   * A queued export with no worker behind it polls for ever. Measured on the
   * dev API: a job stayed `queued` for the whole session, and the panel said
   * "the server is getting to it" the entire time with no way out.
   */
  it('says how long an export has been queued, and lets the host stop watching', async () => {
    const startExport = vi.fn().mockResolvedValue({ jobId: 'export_1' });
    const getExport = vi.fn().mockResolvedValue({ status: 'queued' });
    await render(
      fakeApi({
        startExport,
        getExport,
        exportEstimate: vi.fn().mockResolvedValue({ files: 4, bytes: 900 }),
      }),
    );

    await act(async () => {
      button('Prepare ZIP')?.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(container.querySelector('.host-export-state')?.textContent).toContain('Waiting');
    await act(async () => button('Stop watching')?.click());
    expect(container.querySelector('.host-export-state')).toBeNull();
  });

  /** Nothing on the roll is not "0 B, 0 files"; it is nothing to download. */
  it('offers no ZIP of an empty roll', async () => {
    await render(fakeApi({ exportEstimate: vi.fn().mockResolvedValue({ files: 0, bytes: 0 }) }));
    expect(container.querySelector('.host-estimate')?.textContent).toBe('Nothing to download yet.');
    expect(button('Prepare ZIP')?.disabled).toBe(true);
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

  /**
   * The four equal tiles that used to head the page — CAPTURES, GUESTS,
   * PENDING, HIDDEN — put the least urgent number at the largest size, and two
   * of them repeated, from a different source and in different words, counts
   * the filter bar already carried. On screen the two disagreed.
   *
   * What replaces them is the order the host actually asks in.
   */
  it('answers the camera, then what is stuck, then the count - in that order', async () => {
    const withCamera: HostRollView = {
      ...roll,
      counts: { captures: 214, pending: 0, hidden: 3 },
      guests: 41,
      cameras: [
        {
          deviceId: 'dev_1',
          serial: 'KINO-D4-001',
          lastSeenAt: new Date().toISOString(),
          pending: 6,
          uploading: 1,
          failed: 2,
          serverState: 'reachable',
          firmware: '0.4.43',
        },
      ],
    };
    await render(fakeApi({ resolveSession: vi.fn().mockResolvedValue(withCamera) }));

    const tiles = [...container.querySelectorAll('.host-now .host-now-tile')];
    expect(tiles.length).toBe(3);
    expect(tiles[0]?.textContent).toContain('ONLINE');
    expect(tiles[0]?.textContent).toContain('6 waiting to upload');
    expect(tiles[1]?.textContent).toContain('2 uploads failed on the camera');
    expect(tiles[2]?.textContent).toContain('214');
    expect(tiles[2]?.textContent).toContain('PHOTOS');
    expect(tiles[2]?.textContent).toContain('41 guests');
    // The old four-tile list is gone rather than kept alongside.
    expect(container.querySelector('dl.host-stats')).toBeNull();
  });

  /**
   * The header lamp says LIVE because the *roll* is live, which is true and
   * beside the point when the camera cannot reach the server. That state used
   * to be a pale box two screens down from a green light.
   */
  it('raises a camera that cannot reach the server above the fold', async () => {
    const unreachable: HostRollView = {
      ...roll,
      cameras: [
        {
          deviceId: 'dev_1',
          serial: 'KINO-D4-001',
          lastSeenAt: new Date().toISOString(),
          pending: 31,
          uploading: 0,
          failed: 4,
          serverState: 'unreachable',
          firmware: '0.4.43',
        },
      ],
    };
    await render(fakeApi({ resolveSession: vi.fn().mockResolvedValue(unreachable) }));
    // The camera tile IS the alarm — one block, not a burgundy banner repeating
    // the same sentence above a tile that already says it.
    const tile = container.querySelector('.host-now-camera');
    expect(tile?.getAttribute('role')).toBe('alert');
    expect(tile?.getAttribute('data-tone')).toBe('bad');
    expect(tile?.textContent).toContain('KINO NOT ANSWERING');
    expect(tile?.textContent).toContain('31 waiting to upload');
    expect(tile?.textContent).toContain('They go when KINO answers');
    // It is the first thing under the header, and there is only one of it.
    expect(container.querySelector('.host-now')?.firstElementChild).toBe(tile);
    expect(container.querySelectorAll('.host-alarm').length).toBe(0);

    // A healthy camera does not interrupt a screen reader.
    await render(fakeApi());
    expect(container.querySelector('.host-now-camera')?.getAttribute('role')).toBeNull();
  });

  /**
   * OFFLINE carries an `off` lamp — correctly, the camera is not lit up — but
   * an OFFLINE camera with photographs waiting on its card is the problem on
   * the page. The tile used to take its colour from the lamp alone, so it drew
   * a grey rule on a white ground while announcing itself as an alert.
   */
  it('colours the camera tile by whether it is stuck, not by the lamp', async () => {
    // Named, and typed, rather than reached for through `cameras![0]` later:
    // indexing an optional array widens every field to `| undefined`, so the
    // second fixture below could not be spread from it.
    const stranded: HostCameraView = {
      deviceId: 'dev_1',
      serial: 'KINO-D4-001',
      // Well past CAMERA_STALE_MS, so the word is OFFLINE.
      lastSeenAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      pending: 6,
      uploading: 0,
      failed: 0,
      serverState: 'reachable',
      firmware: '0.4.52',
    };
    const offlineWithBacklog: HostRollView = { ...roll, cameras: [stranded] };
    await render(fakeApi({ resolveSession: vi.fn().mockResolvedValue(offlineWithBacklog) }));
    const tile = container.querySelector('.host-now-camera');
    expect(tile?.textContent).toContain('OFFLINE');
    expect(tile?.textContent).toContain('6 waiting to upload');
    expect(tile?.getAttribute('data-tone')).toBe('bad');
    expect(tile?.getAttribute('role')).toBe('alert');

    // Nothing waiting and the same silence is not an alarm, only an absence.
    const offlineIdle: HostRollView = {
      ...roll,
      cameras: [{ ...stranded, pending: 0 }],
    };
    await render(fakeApi({ resolveSession: vi.fn().mockResolvedValue(offlineIdle) }));
    const quiet = container.querySelector('.host-now-camera');
    expect(quiet?.getAttribute('data-tone')).toBe('off');
    expect(quiet?.getAttribute('role')).toBeNull();
  });

  /**
   * Six equal panels between the status and the photographs meant scrolling
   * past the QR, the PIN and a Clear Roll button to reach the work.
   */
  it('opens setup on a roll with nothing on it, because that host is setting up', async () => {
    await render(
      fakeApi({
        resolveSession: vi
          .fn()
          .mockResolvedValue({ ...roll, counts: { captures: 0, pending: 0, hidden: 0 } }),
      }),
    );
    expect(container.querySelector<HTMLDetailsElement>('.host-setup')?.open).toBe(true);
  });

  it('folds setup away once the roll has photographs on it', async () => {
    await render(
      fakeApi({
        resolveSession: vi
          .fn()
          .mockResolvedValue({ ...roll, counts: { captures: 214, pending: 0, hidden: 0 } }),
      }),
    );
    const setup = container.querySelector<HTMLDetailsElement>('.host-setup');
    expect(setup?.open).toBe(false);

    // And it stays where the host puts it: a section that reshut itself as the
    // next capture landed would close under the hand holding it.
    await act(async () => {
      setup!.open = true;
      setup!.dispatchEvent(new Event('toggle'));
    });
    expect(container.querySelector<HTMLDetailsElement>('.host-setup')?.open).toBe(true);
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

  /**
   * A camera with no Wi-Fi cannot send a heartbeat saying it has no Wi-Fi, so
   * the silence IS the report, and OFFLINE — the camera's own word for it — is
   * what the host is looking at. NOT REPORTING was a fifth word invented for a
   * state the camera already names, and it is now kept for the one thing the
   * camera genuinely cannot say: nothing has ever arrived.
   */
  it('reads a heartbeat that stopped arriving as the camera reads it: OFFLINE', () => {
    const stale = cameraReport(camera({ lastSeenAt: '2026-08-20T11:55:00.000Z' }), now);
    expect(stale.word).toBe('OFFLINE');
    expect(stale.lamp).toBe('off');
    expect(stale.note).toContain('5 m');
    // Nothing under the word is claimed to be current.
    expect(stale.note).toContain('Nothing below is newer');
    // A heartbeat one second inside the window is still a report.
    expect(cameraReport(camera({ lastSeenAt: '2026-08-20T11:58:13.000Z' }), now).word).toBe('ONLINE');
  });

  /** Several cameras, one stuck: the strip speaks for the stuck one. */
  it('lets a stuck camera speak for the roll', () => {
    const cameras = [
      camera({ deviceId: 'a' }),
      camera({ deviceId: 'b', serverState: 'unreachable' }),
      camera({ deviceId: 'c' }),
    ];
    expect(worstCamera(cameras, now)?.deviceId).toBe('b');
    expect(worstCamera([camera({ deviceId: 'a' })], now)?.deviceId).toBe('a');
    expect(worstCamera([], now)).toBeNull();
  });

  /**
   * Seen on a live roll: one camera uploading with six waiting, and three that
   * had joined and never sent a heartbeat. Ranking purely by distance from
   * ONLINE put NOT REPORTING in the headline and hid the only camera that was
   * working — and NOT REPORTING says of itself that the camera may be
   * uploading perfectly well, so it is an absence of news, not news.
   */
  it('prefers the camera that is actually working over one that has never spoken', () => {
    const working = camera({ deviceId: 'live', pending: 6, uploading: 1 });
    const silent = camera({ deviceId: 'silent', lastSeenAt: null, pending: null, uploading: null, failed: null, serverState: null });
    expect(worstCamera([silent, working, silent], now)?.deviceId).toBe('live');
    expect(cameraReport(silent, now).word).toBe('NOT REPORTING');

    // Freshest heartbeat wins among cameras that are all fine.
    const older = camera({ deviceId: 'older', lastSeenAt: '2026-08-20T11:59:00.000Z' });
    const newer = camera({ deviceId: 'newer', lastSeenAt: '2026-08-20T12:00:10.000Z' });
    expect(worstCamera([older, newer], now)?.deviceId).toBe('newer');
    expect(worstCamera([newer, older], now)?.deviceId).toBe('newer');

    // But a stuck camera still outranks a fresher healthy one.
    const stuck = camera({ deviceId: 'stuck', serverState: 'unreachable', lastSeenAt: '2026-08-20T11:59:30.000Z' });
    expect(worstCamera([newer, stuck], now)?.deviceId).toBe('stuck');
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

  it('counts what is stuck, worst first, and only what is really stuck', () => {
    const failed = { ...capture, captureId: 'c1', status: 'failed' };
    const processing = { ...capture, captureId: 'c2', status: 'processing' };
    const cameras = [
      {
        deviceId: 'd',
        serial: null,
        lastSeenAt: null,
        pending: null,
        uploading: null,
        failed: 3,
        serverState: null,
        firmware: null,
      },
    ];
    const items = stuckItems(cameras, [capture, failed, processing, trashed]);
    expect(items.map((item) => item.count)).toEqual([3, 1, 1]);
    // The camera's failures come first and have no filter: a photograph that
    // never left the card has no row in this list to jump to.
    expect(items[0]?.filter).toBeNull();
    expect(items[0]?.label).toContain('upload');
    expect(items[1]?.filter).toBe('failed');
    expect(items[2]?.filter).toBe('pending');
    // A trashed capture is not stuck; it is thrown away.
    expect(stuckItems([], [trashed])).toEqual([]);
    expect(stuckItems(undefined, [capture])).toEqual([]);
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
