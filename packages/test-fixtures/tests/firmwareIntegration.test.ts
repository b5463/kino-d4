// Studio↔Twin↔firmware integration contract (issue #72, brief §45).
//
// Exercises the whole loop a developer runs against the virtual bench: pin
// the device to the CURRENT firmware profile, walk the real Milestone 1B
// command surface, verify honesty (unimplemented commands NACK, offline
// cameras report offline), verify a virtual-sensor capture produces REAL
// image bytes that MEDIA_* serves back, and verify that flashing the real
// 0.1.0 artifact turns the demo device into the honest M1B device.
import { afterEach, describe, expect, it } from 'vitest';
import { Cmd, KinoProtocolClient, MockTransport } from '@kino/kdp';
import type {
  CameraInfo,
  CameraTestResult,
  CapabilitiesResponse,
  DeviceInfo,
  HelloResponse,
  MediaListResponse,
  StorageStatus,
} from '@kino/kdp';
import { MockKinoDevice, FIRMWARE_PROFILES } from '../src/index';
import type { MockFrameRequest } from '../src/index';

let transports: MockTransport[] = [];

async function connect(mock: MockKinoDevice) {
  const transport = new MockTransport(mock);
  transports.push(transport);
  await transport.open();
  return new KinoProtocolClient(transport);
}

afterEach(async () => {
  for (const t of transports) await t.close().catch(() => undefined);
  transports = [];
});

function tinyJpeg(tag: number): Uint8Array {
  const bytes = new Uint8Array(600);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  bytes.fill(tag, 4, 598);
  bytes.set([0xff, 0xd9], 598);
  return bytes;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('current-firmware profile (d4-m1b)', () => {
  it('answers exactly the Milestone 1B surface and NACKs the rest', async () => {
    const mock = new MockKinoDevice({ seed: 3, ambientCaptures: false });
    mock.setFirmwareProfile('d4-m1b');
    const client = await connect(mock);

    const hello = await client.request<HelloResponse>(Cmd.HELLO, {
      protocolMin: 1, protocolMax: 1, nonce: 42, client: 'integration-test',
    });
    expect(hello.product).toBe('KINO');
    expect(hello.nonce).toBe(42);

    const caps = await client.request<CapabilitiesResponse>(Cmd.GET_CAPABILITIES);
    expect(caps.firmware).toBe('0.1.0');
    expect(caps.capabilities.benchDiagnostics).toBe(true);
    expect(caps.capabilities.wiggle).toBe(false);
    expect(caps.capabilities.gallery).toBe(false);
    expect(caps.capabilities.autofocus).toBe(false);
    expect(caps.limits.maxUartBaud).toBe(921600);

    const info = await client.request<DeviceInfo>(Cmd.GET_DEVICE_INFO);
    expect(info.p4Firmware).toBe('0.1.0');
    expect(info.sensors).toEqual(['OV3660', '', '', '']);
    expect(info.cameraFirmware).toEqual(['0.1.0', '', '', '']);

    const cams = await client.request<{ cameras: CameraInfo[] }>(Cmd.GET_CAMERA_INFO);
    expect(cams.cameras.map((c) => c.online)).toEqual([true, false, false, false]);

    const storage = await client.request<StorageStatus>(Cmd.GET_STORAGE_STATUS);
    expect(storage.present).toBe(true);
    expect(storage.writeTestStatus).toBeDefined();

    // Everything the real M1B build does not implement answers
    // UNSUPPORTED_COMMAND — the same message shape as the C dispatcher.
    for (const cmd of [Cmd.GET_CONFIG, Cmd.GET_RECIPES, Cmd.GET_POWER_STATUS, Cmd.CAMERA_PREVIEW, Cmd.MEDIA_LIST, Cmd.FW_QUERY, Cmd.NETWORK_LIST]) {
      await expect(client.request(cmd)).rejects.toThrow(/not implemented in firmware 0\.1\.0/);
    }
  });

  it('CAMERA_TEST works, REBOOT changes the session (§45 steps 11-15)', async () => {
    const mock = new MockKinoDevice({ seed: 4, ambientCaptures: false });
    mock.setFirmwareProfile('d4-m1b');
    const client = await connect(mock);

    const hello = await client.request<HelloResponse>(Cmd.HELLO, {
      protocolMin: 1, protocolMax: 1, nonce: 1, client: null,
    });
    const firstSession = String(hello.sessionId);

    const test = await client.request<CameraTestResult>(Cmd.CAMERA_TEST, { cam: 'cam1' }, 8000);
    expect(test.ok).toBe(true);
    expect(test.checksums.match).toBe(true);

    await client.request(Cmd.REBOOT);
    await new Promise((r) => setTimeout(r, 200));

    // The link dropped with the reboot; a fresh connection sees a new boot.
    const client2 = await connect(mock);
    await new Promise((r) => setTimeout(r, mock.bootDelayMs() + 100));
    const hello2 = await client2.request<HelloResponse>(Cmd.HELLO, {
      protocolMin: 1, protocolMax: 1, nonce: 2, client: null,
    });
    expect(String(hello2.sessionId)).not.toBe(firstSession);
  }, 15000);
});

describe('virtual sensor frame source', () => {
  it('captures store the REAL rendered bytes and MEDIA_* serves them back (§45 step 12)', async () => {
    const mock = new MockKinoDevice({ seed: 5, ambientCaptures: false });
    mock.setUartBaud(3000000); // keep the simulated transfer short
    const rendered: MockFrameRequest[] = [];
    mock.setFrameSource((req) => {
      rendered.push(req);
      if (req.kind === 'thumb') return tinyJpeg(0x77);
      return tinyJpeg(0x10 + Number(req.cam.slice(-1)));
    });
    const client = await connect(mock);
    await client.request(Cmd.HELLO, { protocolMin: 1, protocolMax: 1, nonce: 1, client: null });

    const before = await client.request<MediaListResponse>(Cmd.MEDIA_LIST, { cursor: 0, limit: 1 });
    await client.request(Cmd.CAMERA_CAPTURE, {});

    // Wait for the SD commit (choreographed transfer + async render).
    let latest: MediaListResponse | null = null;
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      latest = await client.request<MediaListResponse>(Cmd.MEDIA_LIST, { cursor: 0, limit: 1 });
      if (latest.total > before.total) break;
    }
    expect(latest!.total).toBe(before.total + 1);
    const captureId = latest!.items[0].id;

    // The stored file IS the render from CAM1's optical center.
    const c1 = await client.requestBytes(Cmd.MEDIA_READ, { id: captureId, file: 'C1.JPG', offset: 0, length: 8192 }, 8000);
    expect(Array.from(c1)).toEqual(Array.from(tinyJpeg(0x11)));
    const thumb = await client.requestBytes(Cmd.MEDIA_THUMB, { id: captureId }, 8000);
    expect(Array.from(thumb)).toEqual(Array.from(tinyJpeg(0x77)));

    // All four cameras rendered — four distinct perspectives, per request.
    expect(rendered.filter((r) => r.kind === 'capture').map((r) => r.cam)).toEqual(['cam1', 'cam2', 'cam3', 'cam4']);

    // Live preview serves the render too.
    const preview = await client.requestBytes(Cmd.CAMERA_PREVIEW, { cam: 'cam1' }, 4000);
    expect(Array.from(preview)).toEqual(Array.from(tinyJpeg(0x11)));
  }, 20000);

  it('answers the wire when a render never returns, and keeps serving after', async () => {
    // Regression: CAMERA_PREVIEW awaited the frame source with no bound, so
    // a render that never settled left the request unanswered. On a single
    // link every later command then times out — which is what "no response
    // to CAMERA_CALIBRATE" looked like from Studio once a populated Twin
    // stage made renders slow enough to overlap.
    const mock = new MockKinoDevice({ seed: 9, ambientCaptures: false });
    // A holder, because TS narrows a callback-assigned `let` back to null.
    const hung: { release?: () => void } = {};
    let calls = 0;
    mock.setFrameSource(() => {
      calls += 1;
      // The first render hangs forever; later ones behave.
      if (calls === 1) {
        return new Promise<Uint8Array | null>((resolve) => {
          hung.release = () => resolve(null);
        });
      }
      return Promise.resolve(tinyJpeg(0x42));
    });
    const client = await connect(mock);

    const preview = await client.requestBytes(Cmd.CAMERA_PREVIEW, { cam: 'cam1' }, 8000);
    expect(preview[0]).toBe(0xff);
    expect(preview[1]).toBe(0xd8);

    // The link is still usable — the hung render did not wedge the device.
    const info = await client.request<DeviceInfo>(Cmd.GET_DEVICE_INFO, {}, 4000);
    expect(info.serial).toBeTruthy();
    const second = await client.requestBytes(Cmd.CAMERA_PREVIEW, { cam: 'cam1' }, 8000);
    expect(Array.from(second)).toEqual(Array.from(tinyJpeg(0x42)));

    hung.release?.();
  }, 30000);

  it('falls back to synthesis when the source fails', async () => {
    const mock = new MockKinoDevice({ seed: 6, ambientCaptures: false });
    mock.setFrameSource(() => {
      throw new Error('renderer gone');
    });
    const client = await connect(mock);
    const preview = await client.requestBytes(Cmd.CAMERA_PREVIEW, { cam: 'cam1' }, 4000);
    expect(preview[0]).toBe(0xff);
    expect(preview[1]).toBe(0xd8);
  });
});

describe('firmware install switches the profile (§35/§36)', () => {
  it('flashing a 0.1.0 P4 image turns the demo device into honest M1B firmware', async () => {
    const mock = new MockKinoDevice({ seed: 7, ambientCaptures: false });
    expect(mock.getFirmwareProfile()).toBe('d4-sim-full');
    const client = await connect(mock);
    await client.request(Cmd.HELLO, { protocolMin: 1, protocolMax: 1, nonce: 1, client: null });

    // Before: the demo device answers GET_RECIPES.
    await client.request(Cmd.GET_RECIPES);

    const image = tinyJpeg(0x42);
    await client.request(Cmd.ENTER_MAINTENANCE);
    const begin = await client.request<{ sessionId: number; chunkSize: number }>(Cmd.FW_BEGIN, {
      target: 'p4', size: image.length, sha256: await sha256Hex(image), version: '0.1.0',
    }, 8000);
    const header = new Uint8Array(8 + image.length);
    new DataView(header.buffer).setUint32(0, begin.sessionId, true);
    new DataView(header.buffer).setUint32(4, 0, true);
    header.set(image, 8);
    await client.requestBinary(Cmd.FW_CHUNK, header, 8000);
    const end = await client.request<{ ok: boolean; verified: boolean }>(Cmd.FW_END, undefined, 15000);
    expect(end.verified).toBe(true);

    // Apply timeline: applying @900, version+profile @2200, reboot @2800.
    await new Promise((r) => setTimeout(r, 3200));
    expect(mock.getFirmwareProfile()).toBe('d4-m1b');

    const client2 = await connect(mock);
    await new Promise((r) => setTimeout(r, mock.bootDelayMs() + 100));
    const caps = await client2.request<CapabilitiesResponse>(Cmd.GET_CAPABILITIES);
    expect(caps.capabilities.benchDiagnostics).toBe(true);
    expect(caps.capabilities.gallery).toBe(false);
    await expect(client2.request(Cmd.GET_RECIPES)).rejects.toThrow(/not implemented in firmware 0\.1\.0/);
    expect(FIRMWARE_PROFILES['d4-m1b'].simulatedFuture).toBe(false);
  }, 20000);
});
