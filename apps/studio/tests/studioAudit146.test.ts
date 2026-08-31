// Studio findings from the codebase audit (issue #146).
//
// Three behaviours that were wrong in ways no test could see:
//
//  - a refused UPLOAD_RECIPE resolved, so the ApplyBar reported SAVED TO KINO
//    and the page discarded the edit it had not saved (ST-2);
//  - a camera that restarted behind a link that never closed left config,
//    capabilities, the firmware label, looks and calibration in the store
//    forever, read from a boot that no longer existed (ST-3);
//  - the thumbnail cache was keyed on a bare capture id and nothing ever
//    cleared it, so camera B's grid showed camera A's pictures (ST-4).
//
// Environment is node (see vite.config.ts). `URL.createObjectURL` is a browser
// API, so the thumbnail tests stub it and count the calls — which is also how
// they can tell a cached thumbnail from a re-read one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KinoProtocolClient, MockTransport } from '@kino/kdp';
import { MockKinoDevice } from '@kino/test-fixtures';
import { KinoDevice } from '../src/device/KinoDevice';
import { applyFactoryEdit } from '../src/pages/Looks/LooksPage';
import { clearThumbCache, getThumbUrl } from '../src/device/media';
import { connectTransport, disconnect, drainStaleSession, getDevice, isSessionStale, recheckSession } from '../src/app/session';
import { setDeviceState, useDeviceStore } from '../src/state/deviceStore';

let transport: MockTransport | null = null;

async function rawDevice(mock = new MockKinoDevice()) {
  transport = new MockTransport(mock);
  await transport.open();
  return { mock, device: new KinoDevice(new KinoProtocolClient(transport)) };
}

afterEach(async () => {
  await transport?.close();
  transport = null;
});

describe('ST-2 — a refused look upload keeps the edit', () => {
  it('rejects instead of resolving when the firmware has no recipe commands', async () => {
    const { mock, device } = await rawDevice();
    // 0.2.0: body, settings and power, and no look storage at all.
    mock.setFirmwareProfile('d4-body-0-2');
    const caps = await device.getCapabilities();
    expect(caps.capabilities.recipes).not.toBe(true);
    await expect(device.uploadRecipe({ id: 'x', name: 'X', factory: false } as never)).rejects.toThrow();
  });

  it('does not discard the draft when the save failed', async () => {
    const discard = vi.fn();
    await expect(applyFactoryEdit(() => Promise.reject(new Error('UNSUPPORTED_COMMAND')), discard)).rejects.toThrow(
      /UNSUPPORTED_COMMAND/,
    );
    // The ApplyBar turns this rejection into its error row; the edit is only
    // thrown away once the camera has the copy.
    expect(discard).not.toHaveBeenCalled();
  });

  it('discards the draft when the save succeeded', async () => {
    const discard = vi.fn();
    await applyFactoryEdit(() => Promise.resolve(), discard);
    expect(discard).toHaveBeenCalledTimes(1);
  });
});

describe('ST-3 — an in-place restart re-reads device truth', () => {
  const sim = new MockKinoDevice();

  afterEach(async () => {
    await disconnect();
  });

  it('marks the store stale on a new boot id and repopulates it', async () => {
    await connectTransport(() => new MockTransport(sim), 'mock');
    const before = useDeviceStore.getState();
    expect(before.info).not.toBeNull();
    expect(isSessionStale()).toBe(false);

    // Values from this boot, deliberately corrupted so a re-read is visible.
    setDeviceState({ firmwareLabel: 'STALE', config: null, calibration: null });

    // A watchdog restart whose USB CDC endpoint stays open: no transport
    // close, so nothing but HELLO can notice it.
    sim.restartSessionInPlace('wdt-test');
    await recheckSession();
    expect(isSessionStale()).toBe(true);

    expect(await drainStaleSession()).toBe(true);
    expect(isSessionStale()).toBe(false);

    const after = useDeviceStore.getState();
    expect(after.firmwareLabel).not.toBe('STALE');
    expect(after.config).not.toBeNull();
    expect(after.calibration).not.toBeNull();
    // Read from the new boot, not remembered from the old one.
    expect(after.stats?.resetReason).toBe('wdt-test');
  }, 30000);
});

describe('ST-4 — thumbnail cache', () => {
  const created: string[] = [];
  const revoked: string[] = [];
  let counter = 0;

  beforeEach(() => {
    created.length = 0;
    revoked.length = 0;
    counter = 0;
    clearThumbCache();
    (globalThis.URL as unknown as Record<string, unknown>).createObjectURL = () => {
      const url = `blob:thumb-${++counter}`;
      created.push(url);
      return url;
    };
    (globalThis.URL as unknown as Record<string, unknown>).revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
  });

  afterEach(async () => {
    await disconnect();
    clearThumbCache();
  });

  it('caches per session, keys on the camera serial, and is cleared on teardown', async () => {
    const sim = new MockKinoDevice();
    await connectTransport(() => new MockTransport(sim), 'mock');
    const dev = getDevice()!;
    const list = await dev.mediaList({ cursor: 0, limit: 1 });
    const id = list.items[0].id;

    const first = await getThumbUrl(dev, id);
    const second = await getThumbUrl(dev, id);
    expect(second).toBe(first);
    expect(created).toHaveLength(1);

    // The same capture id on a different body is a different picture. The old
    // cache answered with camera A's bytes.
    const serial = useDeviceStore.getState().info!.serial;
    setDeviceState({ info: { ...useDeviceStore.getState().info!, serial: `${serial}-B` } });
    const other = await getThumbUrl(dev, id);
    expect(other).not.toBe(first);
    expect(created).toHaveLength(2);

    // Teardown revokes every object URL and empties the map — nothing else
    // could, and nothing did.
    await disconnect();
    expect(revoked).toEqual(expect.arrayContaining(created));
    const reconnected = new MockKinoDevice();
    await connectTransport(() => new MockTransport(reconnected), 'mock');
    await getThumbUrl(getDevice()!, id);
    expect(created).toHaveLength(3);
  }, 30000);

  it('reads a whole thumbnail through the paged MEDIA_THUMB contract', async () => {
    const { mock, device } = await rawDevice();
    void mock;
    const list = await device.mediaList({ cursor: 0, limit: 1 });
    const page = await device.mediaThumb(list.items[0].id, 0, 8192);
    // First page is capped at 8192 by both firmware and the reference device;
    // a caller that never pages gets a truncated JPEG for anything larger.
    expect(page.length).toBeGreaterThan(100);
    expect(page.length).toBeLessThanOrEqual(8192);
    expect(page[0]).toBe(0xff);
    expect(page[1]).toBe(0xd8);
  }, 20000);
});
