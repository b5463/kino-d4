// KINO Twin §11/§12/§13/§18/§20 additions to the mock: per-camera faults,
// the twelve new device-wide fault scenarios, handshake/identity/capability
// knobs, and the §17 gallery fixtures. Pattern follows tests/mockDevice.test.ts
// (full protocol stack) with tests/determinism.test.ts's raw attach/receive +
// fake-timer harness where a test needs to observe the ambient capture loop.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Cmd,
  Evt,
  FrameDecoder,
  FrameFlags,
  KinoProtocolClient,
  MockTransport,
  PROTOCOL_VERSION,
  encodeFrame,
  encodeJson,
  decodeJson,
} from '@kino/kdp';
import type { Frame, SelfTestEvent, SelfTestCheck } from '@kino/kdp';
import { MockKinoDevice } from '../src/index';
import type { CamFault } from '../src/index';

let open: { transport: MockTransport; client: KinoProtocolClient }[] = [];

async function connect(mock: MockKinoDevice) {
  const transport = new MockTransport(mock);
  await transport.open();
  const client = new KinoProtocolClient(transport);
  open.push({ transport, client });
  return client;
}

afterEach(async () => {
  for (const { transport, client } of open) {
    client.dispose();
    await transport.close();
  }
  open = [];
});

function waitForSelfTest(client: KinoProtocolClient): Promise<SelfTestCheck[]> {
  return new Promise((resolve) => {
    const off = client.onEvent<SelfTestEvent>(Evt.SELF_TEST, (e) => {
      if (e.done) {
        off();
        resolve(e.results ?? []);
      }
    });
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

describe('handshake faults (KINO Twin §12)', () => {
  it('dropFirstHello swallows exactly one HELLO; the client recovers on retry', async () => {
    const mock = new MockKinoDevice();
    mock.setScenario('dropFirstHello', true);
    const client = await connect(mock);

    const start = Date.now();
    const hello = await client.hello();
    const elapsed = Date.now() - start;
    // The first attempt timed out (500 ms) before the retry (150 ms later)
    // got a real answer — proof one HELLO was actually swallowed.
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(hello.product).toBe('KINO');
    expect(mock.scenarios.dropFirstHello).toBe(false); // one-shot, disarmed

    // A second HELLO is not swallowed — "exactly one".
    const fastStart = Date.now();
    await client.hello();
    expect(Date.now() - fastStart).toBeLessThan(400);
  }, 10000);

  it('protocolMismatch answers protocol 99', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setScenario('protocolMismatch', true);
    const res = await client.request<{ protocol: number }>(Cmd.HELLO, { nonce: 1 });
    expect(res.protocol).toBe(99);
    // The negotiating client.hello() rejects a protocol outside its range —
    // this is final, not something a retry can fix.
    await expect(client.hello()).rejects.toMatchObject({ name: 'KinoHandshakeError', reason: 'protocol' });
  });
});

describe('per-camera faults (KINO Twin §20)', () => {
  it("offline: CAMERA_STATUS marks the cam offline and SELF_TEST fails that cam's check", async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setCamFault('cam3', 'offline');
    expect(mock.camFault('cam3')).toBe('offline');

    const status = await client.request<{ online: boolean; state: string }>(Cmd.CAMERA_STATUS, { cam: 'cam3' });
    expect(status.online).toBe(false);
    expect(status.state).toBe('offline');

    await client.request(Cmd.SELF_TEST);
    const results = await waitForSelfTest(client);
    const cam3 = results.find((r) => r.name === 'CAM3 capture');
    expect(cam3?.status).toBe('fail');
  }, 15000);

  it('power-open: a distinct log line, and per-cam commands NACK CAM_OFFLINE', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setCamFault('cam2', 'power-open');

    const status = await client.request<{ online: boolean; state: string }>(Cmd.CAMERA_STATUS, { cam: 'cam2' });
    expect(status.online).toBe(false);
    expect(status.state).toBe('offline');

    await expect(client.request(Cmd.CAMERA_TEST, { cam: 'cam2' })).rejects.toMatchObject({ code: 'CAM_OFFLINE' });

    const logs = await client.request<{ entries: { msg: string }[] }>(Cmd.GET_LOGS);
    expect(logs.entries.some((e) => e.msg.includes('no 5V rail on CAM2'))).toBe(true);
  }, 5000);

  it('sensor-missing: the node stays reachable while sensor-dependent commands NACK clearly', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setCamFault('cam4', 'sensor-missing');

    const status = await client.request<{ online: boolean; sensor: string | null }>(Cmd.CAMERA_STATUS, { cam: 'cam4' });
    expect(status.online).toBe(true); // the module still answers the bus
    expect(status.sensor).toBeNull();

    await expect(client.request(Cmd.CAMERA_TEST, { cam: 'cam4' })).rejects.toMatchObject({ code: 'SENSOR_MISSING' });
    await expect(client.request(Cmd.CAMERA_CALIBRATE, { action: 'start' })).rejects.toMatchObject({
      code: 'SENSOR_MISSING',
    });

    // The camera-node MCU still answers the bus, so a firmware repair remains possible.
    await client.request(Cmd.ENTER_MAINTENANCE, {});
    await expect(
      client.request(Cmd.FW_BEGIN, { target: 'cam4', size: 16, sha256: 'a'.repeat(64), version: '0.2.0' }),
    ).resolves.toMatchObject({ chunkSize: expect.any(Number) });
    await client.request(Cmd.FW_ABORT, {});
  }, 5000);

  it('no-vsync: the timing result marks vsyncMeasured false for only that cam', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setCamFault('cam3', 'no-vsync');

    const timing = await client.request<{ cams: { cam: string; vsyncMeasured: boolean }[] }>(
      Cmd.CAMERA_CAPTURE,
      { action: 'timing-test' },
    );
    const cam3 = timing.cams.find((c) => c.cam === 'cam3');
    const others = timing.cams.filter((c) => c.cam !== 'cam3');
    expect(cam3?.vsyncMeasured).toBe(false);
    expect(others.every((c) => c.vsyncMeasured)).toBe(true);
  }, 5000);

  it('slow-uart degrades that one channel in LINK_BENCH', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setCamFault('cam1', 'slow-uart');

    const bench = await client.request<{ channels: { cam: string; kbytesPerSec: number }[] }>(Cmd.LINK_BENCH, {});
    const cam1 = bench.channels.find((c) => c.cam === 'cam1')!;
    const cam2 = bench.channels.find((c) => c.cam === 'cam2')!;
    expect(cam1.kbytesPerSec).toBeLessThan(cam2.kbytesPerSec / 2);
  }, 5000);

  it('rebootCam takes the node briefly offline, like an XIAO power-cycle', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.rebootCam('cam2');

    const status = await client.request<{ online: boolean; state: string }>(Cmd.CAMERA_STATUS, { cam: 'cam2' });
    expect(status.online).toBe(false);
    expect(status.state).toBe('rebooting');
  });

  it('setCamFault(cam, null) clears the fault and re-establishes the link', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    const fault: CamFault = 'offline';
    mock.setCamFault('cam3', fault);
    mock.setCamFault('cam3', null);
    expect(mock.camFault('cam3')).toBeNull();

    const status = await client.request<{ online: boolean }>(Cmd.CAMERA_STATUS, { cam: 'cam3' });
    expect(status.online).toBe(true);
  });

  it("offlineCameraNode still works for CAM1 and now delegates to setCamFault", async () => {
    const mock = new MockKinoDevice();
    const changed = vi.fn();
    mock.onScenarioChange(changed);
    mock.setScenario('offlineCameraNode', true);
    expect(mock.camFault('cam1')).toBe('offline');
    expect(changed).toHaveBeenCalledTimes(1);
    mock.setScenario('offlineCameraNode', false);
    expect(mock.camFault('cam1')).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
  });
});

describe('twin identity + tuning knobs (KINO Twin §11 / §13)', () => {
  it('setIdentity patches DEVICE_INFO only — HELLO keeps answering product KINO', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setIdentity({ serial: 'KD4-SIM-0001', hardwareRevision: 'D4-V1', product: 'KINO D4' });

    const info = await client.request<{ serial: string; hardware: string; product: string }>(Cmd.GET_DEVICE_INFO);
    expect(info.serial).toBe('KD4-SIM-0001');
    expect(info.hardware).toBe('D4-V1');
    expect(info.product).toBe('KINO D4');

    // Studio's handshake (apps/studio/src/app/session.ts) rejects any HELLO
    // product other than 'KINO' — the identity patch must never touch it.
    const hello = await client.hello();
    expect(hello.product).toBe('KINO');
  });

  it('overrideCapabilities patches GET_CAPABILITIES; null restores the baseline', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    const before = await client.request<{ capabilities: { wiggle: boolean } }>(Cmd.GET_CAPABILITIES);
    expect(before.capabilities.wiggle).toBe(true);

    mock.overrideCapabilities({ wiggle: false });
    const overridden = await client.request<{ capabilities: { wiggle: boolean } }>(Cmd.GET_CAPABILITIES);
    expect(overridden.capabilities.wiggle).toBe(false);

    mock.overrideCapabilities(null);
    const restored = await client.request<{ capabilities: { wiggle: boolean } }>(Cmd.GET_CAPABILITIES);
    expect(restored.capabilities.wiggle).toBe(true);
  });

  it('setUartBaud shows up in GET_RUNTIME_STATS', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setUartBaud(2_000_000);
    const stats = await client.request<{ uartBaud: number }>(Cmd.GET_RUNTIME_STATS);
    expect(stats.uartBaud).toBe(2_000_000);
  });
});

describe('storage + power faults (KINO Twin §20)', () => {
  it('sdFull reports 0 MB free and NACKs a capture with SD_FULL', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setScenario('sdFull', true);

    const storage = await client.request<{ freeMB: number }>(Cmd.GET_STORAGE_STATUS);
    expect(storage.freeMB).toBe(0);
    await expect(client.request(Cmd.CAMERA_CAPTURE, {})).rejects.toMatchObject({ code: 'SD_FULL' });
  });

  it('fuseBlown reports fuse blown and force-closes the link like a dead rail', async () => {
    const mock = new MockKinoDevice();
    const transport = new MockTransport(mock);
    await transport.open();
    const client = new KinoProtocolClient(transport);
    let closed = false;
    transport.onClose(() => {
      closed = true;
    });

    await client.request(Cmd.GET_DEVICE_INFO);
    mock.setScenario('fuseBlown', true);
    expect(closed).toBe(true);
    expect(mock.scenarios.fuseBlown).toBe(true); // persists — a blown fuse doesn't self-repair
    client.dispose();

    // A new connection still sees the fuse blown.
    const client2 = await connect(mock);
    const power = await client2.request<{ fuse: string }>(Cmd.GET_POWER_STATUS);
    expect(power.fuse).toBe('blown');
  });
});

describe('flash faults (KINO Twin §20)', () => {
  it('flashOverload reports a driver fault and thermal flag instead of clip percentages', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setScenario('flashOverload', true);

    const res = await client.request<{ results: unknown[]; suggested: string; fault?: boolean; thermal?: string }>(
      Cmd.CAMERA_CALIBRATE,
      { action: 'flash-test', flash: { level: 'medium', distance: '1-2' } },
    );
    expect(res.fault).toBe(true);
    expect(res.thermal).toBe('hot');
    expect(res.results).toHaveLength(0);
  }, 5000);

  it('without flashOverload, the flash test reports per-camera clip percentages and no fault flag', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);

    const res = await client.request<{ results: { cam: string; clippedPct: number }[]; suggested: string; fault?: boolean }>(
      Cmd.CAMERA_CALIBRATE,
      { action: 'flash-test', flash: { level: 'medium', distance: '1-2' } },
    );
    expect(res.fault).toBeUndefined();
    expect(res.results).toHaveLength(4);
    expect(res.results.every((r) => typeof r.clippedPct === 'number')).toBe(true);
  }, 5000);
});

describe('node firmware + phase faults (KINO Twin §20)', () => {
  it('nodeFwMismatch: CAM4 reports 0.0.9 and GET_CAPABILITIES notes the mismatch', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setScenario('nodeFwMismatch', true);

    const status = await client.request<{ firmware: string }>(Cmd.CAMERA_STATUS, { cam: 'cam4' });
    expect(status.firmware).toBe('0.0.9');
    const info = await client.request<{ cameraFirmware: string[] }>(Cmd.GET_DEVICE_INFO);
    expect(info.cameraFirmware[3]).toBe('0.0.9');
    const caps = await client.request<{ firmwareMismatch: boolean }>(Cmd.GET_CAPABILITIES);
    expect(caps.firmwareMismatch).toBe(true);
  });

  it("vsyncOffsetLarge shows CAM3's phase at 31,000 us in the phase snapshot", async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setScenario('vsyncOffsetLarge', true);

    const snap = await client.request<{ cams: { cam: string; phaseUs: number }[] }>(Cmd.CAMERA_PHASE, {
      action: 'measure',
    });
    const cam3 = snap.cams.find((c) => c.cam === 'cam3');
    expect(cam3?.phaseUs).toBe(31_000);
  }, 5000);
});

describe('network / roll faults (KINO Twin §18)', () => {
  it('wifiLost: NETWORK_STATUS reports disconnected regardless of saved networks', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    const before = await client.request<{ state: string }>(Cmd.NETWORK_STATUS);
    expect(before.state).toBe('connected');

    mock.setScenario('wifiLost', true);
    const after = await client.request<{ state: string; ssid: string | null }>(Cmd.NETWORK_STATUS);
    expect(after.state).toBe('disconnected');
    expect(after.ssid).toBeNull();
  });

  it('rollServerUnreachable / rollTokenExpired show in ROLL_STATUS; an expired token stalls the queue', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setScenario('rollServerUnreachable', true);
    mock.setScenario('rollTokenExpired', true);

    const status = await client.request<{ serverReachable: boolean; tokenStatus: string }>(Cmd.ROLL_STATUS);
    expect(status.serverReachable).toBe(false);
    expect(status.tokenStatus).toBe('token-expired');

    mock.setScenario('uploadBacklog', true);
    const before = await client.request<{ pending: number }>(Cmd.UPLOAD_QUEUE_STATUS);
    mock.tickUploads();
    mock.tickUploads();
    const after = await client.request<{ pending: number }>(Cmd.UPLOAD_QUEUE_STATUS);
    expect(after.pending).toBe(before.pending);
  });
});

describe('gallery fixtures (KINO Twin §17)', () => {
  it("the corrupt-JPEG fixture's MEDIA_READ bytes fail a JPEG magic check", async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    const info = await client.request<{ corrupt: boolean }>(Cmd.MEDIA_INFO, { id: 'WG999901' });
    expect(info.corrupt).toBe(true);

    // `C1.JPG`, the name the firmware writes and the only spelling the
    // MEDIA_READ allow-list accepts. `C1_RAW.JPG` belongs to Studio's export
    // ZIP and the mock used to answer to both.
    const bytes = await client.requestBytes(Cmd.MEDIA_READ, { id: 'WG999901', file: 'C1.JPG', offset: 0, length: 16 });
    expect(bytes[0] === 0xff && bytes[1] === 0xd8).toBe(false);
  });

  it('refuses a file name off the MEDIA_READ allow-list, and defaults to C1.JPG', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    // BAD_REQUEST, not NOT_FOUND: the P4 joins this name onto a directory
    // path, so a name that can never exist is refused before it becomes one.
    await expect(
      client.requestBytes(Cmd.MEDIA_READ, { id: 'WG999901', file: '../../secrets' }),
    ).rejects.toThrow(/C1\.JPG/);
    await expect(
      client.requestBytes(Cmd.MEDIA_READ, { id: 'WG999901', file: 'C1_RAW.JPG' }),
    ).rejects.toThrow(/C1\.JPG/);
    // `file` is optional and asks for the first frame.
    const first = await client.requestBytes(Cmd.MEDIA_READ, { id: 'WG999901' });
    expect(first.length).toBeGreaterThan(0);
    // META.JSON is served from the same stored capture MEDIA_INFO answers from.
    const meta = await client.requestBytes(Cmd.MEDIA_READ, { id: 'WG999901', file: 'META.JSON' });
    const doc = JSON.parse(new TextDecoder().decode(meta)) as { schema: string; id: string };
    expect(doc.schema).toBe('kino.capture');
    expect(doc.id).toBe('WG999901');
    const thumb = await client.requestBytes(Cmd.MEDIA_READ, { id: 'WG999901', file: 'THUMB.JPG' });
    expect(thumb.length).toBeGreaterThan(0);
  });

  it('the incomplete and missing-frame fixtures report fewer than four files', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    const incomplete = await client.request<{ files: unknown[]; corrupt: boolean }>(Cmd.MEDIA_INFO, { id: 'WG999902' });
    expect(incomplete.files).toHaveLength(3);
    expect(incomplete.corrupt).toBe(false);

    const gap = await client.request<{ files: unknown[] }>(Cmd.MEDIA_INFO, { id: 'WG999903' });
    expect(gap.files).toHaveLength(3);
  });

  it('answers BAD_REQUEST to malformed frames and keeps serving (audit #CN-6)', () => {
    vi.useFakeTimers();
    try {
      const out: number[] = [];
      const dev = new MockKinoDevice({ seed: 3, now: () => 1_755_244_800_000 });
      dev.attach((b) => out.push(...b), () => {});
      const raw = (cmd: Cmd, seq: number, payload: Uint8Array) =>
        dev.receive(encodeFrame({ version: PROTOCOL_VERSION, type: cmd, seq, flags: FrameFlags.NONE, payload }));

      // A payload that is not JSON. `decodeJson` throws, and the throw used to
      // escape the dispatch timer and take the device down mid-session.
      raw(Cmd.SET_CONFIG, 1, new Uint8Array([0x7b, 0xff, 0x00, 0x7d]));
      // A SOUND_CHUNK too short to hold its own 8-byte header: the DataView
      // read was a RangeError from the same place.
      raw(Cmd.SOUND_CHUNK, 2, new Uint8Array([1, 2, 3]));
      // The proof that it survived: an ordinary request after the two bad ones.
      raw(Cmd.GET_DEVICE_INFO, 3, encodeJson({}));
      vi.advanceTimersByTime(3000);
      dev.detach();

      const frames = new FrameDecoder()
        .push(Uint8Array.from(out))
        .filter((f) => (f.flags & FrameFlags.EVENT) === 0);
      const bySeq = new Map(frames.map((f) => [f.seq, f]));
      for (const seq of [1, 2]) {
        const answer = bySeq.get(seq);
        expect(answer, `no answer to seq ${String(seq)}`).toBeDefined();
        expect(answer!.flags & FrameFlags.ERROR).toBeTruthy();
        expect(decodeJson<{ code: string }>(answer!.payload).code).toBe('BAD_REQUEST');
      }
      expect(bySeq.get(3)).toBeDefined();
      expect(bySeq.get(3)!.flags & FrameFlags.ERROR).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates a sound id and bounds its name instead of truncating (audit #M1/#M6)', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    const begin = (patch: Record<string, unknown>) =>
      client.request(Cmd.SOUND_BEGIN, { id: 'snd-air-horn', name: 'Air horn', sizeBytes: 4096, durationMs: 800, ...patch });

    // The id becomes a path under /sdcard/KINO/SOUNDS, so the pattern is
    // firmware's (contract D18) and not the mock's own idea of one.
    await expect(begin({ id: 'airhorn' })).rejects.toThrow(/snd-/);
    await expect(begin({ id: 'snd-Air-Horn' })).rejects.toThrow(/snd-/);
    await expect(begin({ id: 'snd-' + 'a'.repeat(20) })).rejects.toThrow(/snd-/);
    // A name too long is a NACK. Truncating it silently returns a clip name
    // the host never uploaded and cannot tell from its own mistake.
    await expect(begin({ name: 'x'.repeat(33) })).rejects.toThrow(/1 to 32/);

    const ok = await client.request<{ sessionId: number }>(Cmd.SOUND_BEGIN, {
      id: 'snd-air-horn',
      name: 'x'.repeat(32),
      sizeBytes: 4096,
      durationMs: 800,
    });
    expect(ok.sessionId).toBeGreaterThan(0);
  });

  it('two demo captures carry dark-party / direct-flash look tags', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    const list = await client.request<{ items: { recipeIds: string[] }[] }>(Cmd.MEDIA_LIST, {
      cursor: 0,
      limit: 100,
    });
    const tags = list.items.flatMap((i) => i.recipeIds);
    expect(tags).toContain('dark-party');
    expect(tags).toContain('direct-flash');
  });
});

describe('capture-pipeline camera faults (deterministic, fake timers)', () => {
  it('slow-uart multiplies duration, crc-noise climbs uartErrors, flashUnavailable skips + logs, batterySag dips voltage', () => {
    vi.useFakeTimers();
    try {
      const fixedNow = 1_755_300_000_000;
      const dev = new MockKinoDevice({ seed: 21, now: () => fixedNow });
      dev.setCamFault('cam1', 'slow-uart');
      dev.setCamFault('cam2', 'crc-noise');
      dev.setScenario('flashUnavailable', true);
      dev.setScenario('batterySag', true);

      const out: Uint8Array[] = [];
      dev.attach((b) => out.push(b.slice()), () => {});
      const send = (cmd: Cmd, seq: number, payload: unknown = {}) =>
        dev.receive(
          encodeFrame({ version: PROTOCOL_VERSION, type: cmd, seq, flags: FrameFlags.NONE, payload: encodeJson(payload) }),
        );

      // Baseline, before the first ambient capture fires at +5,000 ms.
      send(Cmd.CAMERA_STATUS, 1, { cam: 'cam2' });
      send(Cmd.GET_POWER_STATUS, 2, {});
      vi.advanceTimersByTime(100);

      vi.advanceTimersByTime(5200);

      send(Cmd.CAMERA_STATUS, 3, { cam: 'cam1' });
      send(Cmd.CAMERA_STATUS, 4, { cam: 'cam2' });
      send(Cmd.GET_POWER_STATUS, 5, {});
      send(Cmd.GET_LOGS, 6, {});
      vi.advanceTimersByTime(100);
      dev.detach();

      const frames = new FrameDecoder().push(concat(out));
      function at<T>(seq: number): T {
        const f = frames.find((fr: Frame) => fr.seq === seq && (fr.flags & FrameFlags.RESPONSE) !== 0);
        if (!f) throw new Error(`no response for seq ${seq}`);
        return decodeJson<T>(f.payload);
      }

      const before = at<{ uartErrors: number }>(1);
      const beforePower = at<{ batteryV: number }>(2);
      const cam1After = at<{ lastCapture: { durationMs: number } | null }>(3);
      const cam2After = at<{ uartErrors: number }>(4);
      const power = at<{ batteryV: number }>(5);
      const logs = at<{ entries: { msg: string }[] }>(6);

      expect(beforePower.batteryV).toBe(3.55);
      expect(cam1After.lastCapture!.durationMs).toBeGreaterThanOrEqual(130 * 8);
      expect(cam2After.uartErrors).toBeGreaterThan(before.uartErrors);
      expect(power.batteryV).toBe(3.3);
      expect(logs.entries.some((e) => e.msg.includes('flash unavailable'))).toBe(true);
      expect(logs.entries.some((e) => e.msg.includes('retries (crc noise)'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
