// Media transfer over the full protocol stack: list, info, chunked read
// with checksum verification — the same path the gallery uses.
import { afterEach, describe, expect, it } from 'vitest';
import { KinoProtocolClient } from '@kino/kdp';
import { KinoDevice } from '../src/device/KinoDevice';
import { MockTransport } from '@kino/kdp';
import { MockKinoDevice } from '@kino/test-fixtures';
import { downloadCaptureFile, TransferHandle } from '../src/device/media';
import { sha256Hex } from '../src/firmware/hashing';

let transport: MockTransport | null = null;

async function connect() {
  const mock = new MockKinoDevice();
  transport = new MockTransport(mock);
  await transport.open();
  const client = new KinoProtocolClient(transport);
  return { mock, device: new KinoDevice(client) };
}

afterEach(async () => {
  await transport?.close();
  transport = null;
});

describe('media over the protocol', () => {
  it('lists captures with wiggles and quad sets', async () => {
    const { device } = await connect();
    const res = await device.mediaList();
    expect(res.total).toBeGreaterThan(10);
    expect(res.items.some((c) => c.kind === 'wiggle')).toBe(true);
    expect(res.items.some((c) => c.kind === 'quad')).toBe(true);
  });

  it('reports four files with checksums per capture', async () => {
    const { device } = await connect();
    const list = await device.mediaList();
    const info = await device.mediaInfo(list.items[0].id);
    expect(info.files).toHaveLength(4);
    for (const f of info.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.sizeBytes).toBeGreaterThan(1000);
    }
  }, 15000);

  it('downloads a file in chunks and the checksum matches', async () => {
    const { device } = await connect();
    const list = await device.mediaList();
    const info = await device.mediaInfo(list.items[0].id);
    // The name the card actually carries. This asked for `C1_RAW.JPG`, which
    // was never in the MEDIA_READ allow-list nor on the card — the download
    // has to use the name MEDIA_INFO reported.
    expect(info.files[0].name).toBe('C1.JPG');
    const data = await downloadCaptureFile(device, info, info.files[0].name, new TransferHandle());
    expect(data.length).toBe(info.files[0].sizeBytes);
    expect(await sha256Hex(data)).toBe(info.files[0].sha256);
    // JPEG magic survives the trip
    expect(data[0]).toBe(0xff);
    expect(data[1]).toBe(0xd8);
  }, 20000);

  it('supports favorite and delete', async () => {
    const { device } = await connect();
    const list = await device.mediaList();
    const id = list.items[0].id;
    await device.mediaFavorite(id, true);
    const after = await device.mediaList();
    expect(after.items.find((c) => c.id === id)?.favorite).toBe(true);
    await device.mediaDelete(id);
    const final = await device.mediaList();
    expect(final.items.find((c) => c.id === id)).toBeUndefined();
  });

  it('serves viewfinder frames as JPEG bytes', async () => {
    const { device } = await connect();
    const frame = await device.previewFrame('cam2');
    expect(frame.length).toBeGreaterThan(500);
    expect(frame[0]).toBe(0xff);
    expect(frame[1]).toBe(0xd8);
  });

  it('reports all three timing metrics, with VSYNC dominating', async () => {
    const { device } = await connect();
    const r = await device.timingTest();
    expect(r.cams).toHaveLength(4);
    expect(r.vsyncMeasured).toBe(true);
    // GPIO distribution is small; free-running sensors are not.
    expect(r.gpioSpreadUs).toBeLessThan(1000);
    expect(r.vsyncSpreadUs).toBeGreaterThan(5000);
    expect(r.exposureSpreadUs).toBeGreaterThan(1000);
  }, 10000);

  it('paginates the gallery', async () => {
    const { device } = await connect();
    const first = await device.mediaList({ cursor: 0, limit: 5 });
    expect(first.items).toHaveLength(5);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(5);
    const second = await device.mediaList({ cursor: first.nextCursor!, limit: 5 });
    expect(second.items[0].id).not.toBe(first.items[0].id);
    // Walk to the end: the last page reports no more.
    let cursor: number | null = 0;
    let seen = 0;
    while (cursor !== null) {
      const page: Awaited<ReturnType<typeof device.mediaList>> = await device.mediaList({ cursor, limit: 10 });
      seen += page.items.length;
      cursor = page.hasMore ? page.nextCursor : null;
    }
    expect(seen).toBe(first.total);
  });

  it('aligns sensor phase on rephase and reports convergence', async () => {
    const { device } = await connect();
    const before = await device.measurePhase();
    expect(before.spreadUs).toBeGreaterThan(10000); // free-running
    await device.rephaseSensors();
    await new Promise((r) => setTimeout(r, 3000));
    const after = await device.measurePhase();
    expect(after.spreadUs).toBeLessThan(before.spreadUs / 3);
  }, 15000);

  it('walks the baud ladder and finds errors at the top', async () => {
    const { device } = await connect();
    const low = await device.linkBench(921600, 65536);
    expect(low.clean).toBe(true);
    expect(low.concurrent).toBe(true);
    expect(low.channels).toHaveLength(4);
    const high = await device.linkBench(3000000, 262144);
    expect(high.clean).toBe(false);
    expect(high.channels.some((c) => c.crcErrors > 0)).toBe(true);
  }, 15000);

  it('NACKs unsupported commands instead of going silent', async () => {
    const { mock, device } = await connect();
    mock.setScenario('legacyFirmware', true);
    await expect(device.measurePhase()).rejects.toThrow(/not implemented/i);
    const caps = await device.getCapabilities();
    expect(caps.capabilities.phaseCalibration).toBe(false);
    expect(caps.capabilities.vsyncTelemetry).toBe(false);
    expect(caps.capabilities.wiggle).toBe(true);
  });

  it('refuses media access with the SD card missing', async () => {
    const { mock, device } = await connect();
    mock.setScenario('sdMissing', true);
    await expect(device.mediaList()).rejects.toThrow(/SD card/i);
  });
});
