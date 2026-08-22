import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capture as captureSchema, parseVersioned } from '@kino/schemas';
import type { MockKinoDevice, TwinTelemetry } from '@kino/test-fixtures';
import {
  attachRollBridge,
  backoffMs,
  captureDocumentFor,
  detachRollBridge,
  resetRollBridgeForTests,
  retryUploads,
  useRollBridge,
} from '../src/roll/bridge';

// The bridge drives the public device wire contract against a scripted fake
// server; the device is a duck-typed stand-in for MockKinoDevice exposing
// only the taps the bridge uses.

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function fakeDevice(): { device: MockKinoDevice; emit: (e: TwinTelemetry) => void } {
  const listeners = new Set<(e: TwinTelemetry) => void>();
  const device = {
    onTelemetry(cb: (e: TwinTelemetry) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async readCaptureAssets(id: string) {
      if (id !== 'WG000042') return null;
      return {
        kind: 'wiggle' as const,
        ts: 1_700_000_000_000,
        frames: [0, 1, 2, 3].map((cam) => ({ cam, bytes: JPEG })),
        thumb: JPEG,
      };
    },
    async renderSourceFrame() {
      return JPEG;
    },
    twinSnapshot() {
      return { firmwareProfile: 'd4-sim-full' };
    },
  } as unknown as MockKinoDevice;
  return { device, emit: (e) => listeners.forEach((cb) => cb(e)) };
}

interface Call {
  method: string;
  path: string;
}

/** Scripted Roll API: happy-path answers, with an optional outage window. */
function fakeServer() {
  const calls: Call[] = [];
  const captureIdsByUuid = new Map<string, string>();
  let down = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, path });
    if (down) throw new TypeError('fetch failed');
    const reply = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/api/studio/devices/register')) {
      return reply(200, { deviceId: 'dev_1', deviceToken: 'kdt_test' });
    }
    if (/\/api\/device\/rolls\/roll_1\/captures$/.test(path)) {
      const doc = JSON.parse(String(init?.body)) as { captureUuid: string };
      const existing = captureIdsByUuid.get(doc.captureUuid);
      if (existing) return reply(200, { captureId: existing });
      const captureId = `cap_${captureIdsByUuid.size + 1}`;
      captureIdsByUuid.set(doc.captureUuid, captureId);
      return reply(201, { captureId });
    }
    if (path.includes('/assets/init')) return reply(200, { uploadId: 'up_1', partSize: 5 * 1024 * 1024, alreadyComplete: false });
    if (path.includes('/parts/')) return reply(200, { received: true, partNo: 1 });
    if (path.includes('/uploads/up_1/complete')) return reply(200, { assetId: 'as_1', status: 'ready' });
    if (/\/captures\/cap_\d+\/complete$/.test(path)) return reply(200, { captureId: 'cap_1', status: 'processing' });
    return reply(404, { code: 'NOT_FOUND' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    captureIdsByUuid,
    setDown(value: boolean) {
      down = value;
    },
  };
}

async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((done) => setTimeout(done, 10));
  }
}

const ROLL = { rollId: 'roll_1', slug: 'AMBER-042', guestUrl: 'https://kino.test/r/AMBER-042', hostUrl: null, title: 'Test party' };

beforeEach(() => {
  resetRollBridgeForTests();
  useRollBridge.setState({ roll: ROLL, queued: 0, failed: 0, uploaded: 0, uploading: false, lastError: null, online: true, serverUrl: '' });
});

afterEach(() => {
  detachRollBridge();
  resetRollBridgeForTests();
  vi.unstubAllGlobals();
});

describe('captureDocumentFor', () => {
  it('builds a valid kino.capture with capability-honest mode', () => {
    const doc = captureDocumentFor(
      { captureUuid: '6f1e9a3c-8f2b-4d6a-9c1e-2b7f4a5d8e90', mode: 'wiggle', capturedAt: new Date().toISOString() },
      'dev_1',
      4,
      'd4-sim-full',
    );
    const parsed = parseVersioned(captureSchema, doc) as Record<string, unknown>;
    expect(parsed['mode']).toBe('wiggle');
    expect(parsed['frameCount']).toBe(4);
    expect(parsed['twin']).toEqual({ bridge: 'twin-dev-bridge', firmwareProfile: 'd4-sim-full' });
  });

  it('downgrades a one-frame capture to mode single — no fake Wiggle', () => {
    const doc = captureDocumentFor(
      { captureUuid: '6f1e9a3c-8f2b-4d6a-9c1e-2b7f4a5d8e91', mode: 'wiggle', capturedAt: new Date().toISOString() },
      'dev_1',
      1,
      'd4-m1b',
    );
    expect(doc['mode']).toBe('single');
    expect(parseVersioned(captureSchema, doc)).toBeTruthy();
  });
});

describe('backoffMs', () => {
  it('doubles from 1 s and caps at 30 s', () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(5)).toBe(16_000);
    expect(backoffMs(10)).toBe(30_000);
  });
});

describe('upload queue', () => {
  it('uploads a committed capture: thumb first, then frames, then complete', async () => {
    const server = fakeServer();
    const { device, emit } = fakeDevice();
    attachRollBridge(device);
    emit({ t: 'capture', phase: 'committed', id: 42, capId: 'WG000042', kind: 'wiggle', cams: {} });
    await waitFor(() => useRollBridge.getState().uploaded === 1);

    const inits = server.calls.filter((c) => c.path.includes('/assets/init'));
    expect(inits).toHaveLength(5); // 1 thumb + 4 frames
    const captureCreate = server.calls.findIndex((c) => /rolls\/roll_1\/captures$/.test(c.path));
    const firstInit = server.calls.findIndex((c) => c.path.includes('/assets/init'));
    expect(captureCreate).toBeLessThan(firstInit);
    expect(server.calls.at(-1)?.path).toMatch(/captures\/cap_1\/complete$/);
  });

  it('keeps the job through an outage and retries with the same capture UUID', async () => {
    const server = fakeServer();
    const { device, emit } = fakeDevice();
    attachRollBridge(device);

    server.setDown(true);
    emit({ t: 'capture', phase: 'committed', id: 42, capId: 'WG000042', kind: 'wiggle', cams: {} });
    await waitFor(() => useRollBridge.getState().failed === 1);
    await waitFor(() => !useRollBridge.getState().uploading); // drain fully parked on backoff
    expect(useRollBridge.getState().online).toBe(false);
    expect(useRollBridge.getState().uploaded).toBe(0);

    server.setDown(false);
    retryUploads();
    await waitFor(() => useRollBridge.getState().uploaded === 1);
    expect(useRollBridge.getState().online).toBe(true);
    // One capture UUID reached the server across all attempts — idempotent.
    expect(server.captureIdsByUuid.size).toBe(1);
  });

  it('ignores committed captures when no Roll is associated', async () => {
    fakeServer();
    const { device, emit } = fakeDevice();
    attachRollBridge(device);
    useRollBridge.setState({ roll: null });
    emit({ t: 'capture', phase: 'committed', id: 42, capId: 'WG000042', kind: 'wiggle', cams: {} });
    await new Promise((done) => setTimeout(done, 50));
    expect(useRollBridge.getState().queued).toBe(0);
  });
});
