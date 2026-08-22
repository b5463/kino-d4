// KINO Twin §5/§10 telemetry tap: MockKinoDevice grows a second, additive
// observation channel (`onTelemetry`/`twinSnapshot`) for the Twin's 3D view.
// Studio never touches this — it only ever sees the raw KDP bytes the device
// writes to its sink. These tests exercise the tap itself, not the protocol
// surface (already covered by mockDevice.test.ts / twinFaults.test.ts).
import { describe, expect, it, vi } from 'vitest';
import {
  Cmd,
  FrameFlags,
  KinoProtocolClient,
  MockTransport,
  PROTOCOL_VERSION,
  encodeFrame,
  encodeJson,
} from '@kino/kdp';
import { MockKinoDevice } from '../src/index';
import type { TwinTelemetry } from '../src/index';

function send(dev: MockKinoDevice, cmd: Cmd, seq: number, payload: unknown = {}) {
  dev.receive(
    encodeFrame({ version: PROTOCOL_VERSION, type: cmd, seq, flags: FrameFlags.NONE, payload: encodeJson(payload) }),
  );
}

function capturesOf(events: TwinTelemetry[]) {
  return events.filter((e): e is Extract<TwinTelemetry, { t: 'capture' }> => e.t === 'capture');
}

describe('telemetry tap: capture pipeline', () => {
  it('a CAMERA_CAPTURE frame emits capture begin then committed, with per-cam jpegKB/durationMs', () => {
    vi.useFakeTimers();
    try {
      // No attach(): startAmbient() never arms, so nothing but this one
      // triggered capture can produce telemetry — no risk of the ambient
      // capture loop firing mid-window and contaminating the assertions.
      const dev = new MockKinoDevice({ seed: 5, now: () => 1_755_300_000_000 });
      const events: TwinTelemetry[] = [];
      dev.onTelemetry((e) => events.push(e));

      send(dev, Cmd.CAMERA_CAPTURE, 1, {});
      vi.advanceTimersByTime(6000);

      const captures = capturesOf(events);
      expect(captures.length).toBeGreaterThanOrEqual(2);
      expect(captures[0].phase).toBe('begin');
      expect(captures[0].cams).toEqual({});

      const committed = captures.find((c) => c.phase === 'committed');
      expect(committed).toBeDefined();
      expect(committed!.id).toBe(captures[0].id);
      const cam2 = committed!.cams.cam2;
      expect(cam2).toBeDefined();
      expect(typeof cam2!.jpegKB).toBe('number');
      expect(typeof cam2!.durationMs).toBe('number');
    } finally {
      vi.useRealTimers();
    }
  });

  // Issue #75: the Header's private KDP client closes right after the
  // CAMERA_CAPTURE ack. Unplugging the host cable must not lose a photo the
  // camera is already committing to SD — only power loss or a reboot may.
  it('a capture in flight survives detach and still commits with its capId', () => {
    vi.useFakeTimers();
    try {
      const dev = new MockKinoDevice({ seed: 5, now: () => 1_755_300_000_000 });
      const events: TwinTelemetry[] = [];
      dev.onTelemetry((e) => events.push(e));

      send(dev, Cmd.CAMERA_CAPTURE, 1, {});
      vi.advanceTimersByTime(30); // dispatch latency — the capture is now in flight
      dev.detach(); // link gone before exposure/transfer finishes
      vi.advanceTimersByTime(8000);

      const committed = capturesOf(events).find((c) => c.phase === 'committed');
      expect(committed).toBeDefined();
      expect(committed!.capId).toMatch(/^(WG|QD)\d{6}$/);
      expect(committed!.kind).toBe('wiggle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a capture in flight dies with a power-off cancel, not a late commit', () => {
    vi.useFakeTimers();
    try {
      const dev = new MockKinoDevice({ seed: 5, now: () => 1_755_300_000_000 });
      const events: TwinTelemetry[] = [];
      dev.onTelemetry((e) => events.push(e));

      send(dev, Cmd.CAMERA_CAPTURE, 1, {});
      vi.advanceTimersByTime(30); // dispatch latency — the capture is now in flight
      dev.cancelInFlightCaptures();
      vi.advanceTimersByTime(8000);

      expect(capturesOf(events).find((c) => c.phase === 'committed')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('telemetry tap: camFault', () => {
  it('setCamFault emits a camFault event with the cam and the new fault', () => {
    const dev = new MockKinoDevice();
    const events: TwinTelemetry[] = [];
    dev.onTelemetry((e) => events.push(e));

    dev.setCamFault('cam3', 'offline');

    const ev = events.find((e) => e.t === 'camFault');
    expect(ev).toEqual({ t: 'camFault', cam: 'cam3', fault: 'offline' });
  });
});

describe('telemetry tap: twinSnapshot', () => {
  it('reflects configured uartBaud/phase and gets a new sessionId across a reboot', () => {
    vi.useFakeTimers();
    try {
      const dev = new MockKinoDevice({ seed: 3, now: () => 1_755_300_000_000 });
      dev.setUartBaud(2_000_000);

      const before = dev.twinSnapshot();
      expect(before.uartBaud).toBe(2_000_000);
      expect(before.frameIntervalUs).toBe(33_333);
      expect(before.cams.cam3.phaseUs).toBe(21_880); // untouched default cam3 phase
      expect(before.scenarios.legacyFirmware).toBe(false);

      send(dev, Cmd.REBOOT, 1, {});
      vi.advanceTimersByTime(500); // dispatch latency + reboot()'s own 300 ms delay

      const after = dev.twinSnapshot();
      expect(after.sessionId).not.toBe(before.sessionId);
      expect(after.uartBaud).toBe(2_000_000); // survives the reboot, like real NVS
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('telemetry tap: subscription lifecycle', () => {
  it('unsubscribe stops further delivery to that listener', () => {
    const dev = new MockKinoDevice();
    const events: TwinTelemetry[] = [];
    const unsubscribe = dev.onTelemetry((e) => events.push(e));

    dev.setCamFault('cam1', 'offline');
    const countAfterFirst = events.length;
    expect(countAfterFirst).toBeGreaterThan(0);

    unsubscribe();
    dev.setCamFault('cam1', null);
    expect(events.length).toBe(countAfterFirst);
  });

  it('supports multiple independent subscribers', () => {
    const dev = new MockKinoDevice();
    const a: TwinTelemetry[] = [];
    const b: TwinTelemetry[] = [];
    dev.onTelemetry((e) => a.push(e));
    const unsubB = dev.onTelemetry((e) => b.push(e));

    dev.setCamFault('cam2', 'sensor-missing');
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);

    unsubB();
    dev.setCamFault('cam2', null);
    expect(a.length).toBeGreaterThan(b.length);
  });

  it('delivery is best-effort: a throwing listener does not block the others', () => {
    const dev = new MockKinoDevice();
    const good: TwinTelemetry[] = [];
    dev.onTelemetry(() => {
      throw new Error('bad subscriber');
    });
    dev.onTelemetry((e) => good.push(e));

    expect(() => dev.setCamFault('cam4', 'no-vsync')).not.toThrow();
    expect(good.some((e) => e.t === 'camFault')).toBe(true);
  });
});

describe('telemetry tap: scenario + link + log', () => {
  it('setScenario emits a scenario event with the key/value that was set', () => {
    const dev = new MockKinoDevice();
    const events: TwinTelemetry[] = [];
    dev.onTelemetry((e) => events.push(e));

    dev.setScenario('lowBattery', true);

    const ev = events.find((e) => e.t === 'scenario');
    expect(ev).toEqual({ t: 'scenario', key: 'lowBattery', value: true });
  });

  it('attach/detach emit link connected/disconnected', () => {
    const dev = new MockKinoDevice();
    const events: TwinTelemetry[] = [];
    dev.onTelemetry((e) => events.push(e));

    dev.attach(() => {}, () => {});
    dev.detach();

    const linkEvents = events.filter((e): e is Extract<TwinTelemetry, { t: 'link' }> => e.t === 'link');
    expect(linkEvents.map((e) => e.connected)).toEqual([true, false]);
  });

  it('log() mirrors every log line onto the telemetry tap', () => {
    const dev = new MockKinoDevice();
    const events: TwinTelemetry[] = [];
    dev.onTelemetry((e) => events.push(e));

    dev.setCamFault('cam2', 'power-open'); // triggers an internal this.log(...)

    const logEvents = events.filter((e): e is Extract<TwinTelemetry, { t: 'log' }> => e.t === 'log');
    expect(logEvents.length).toBeGreaterThan(0);
    expect(logEvents.some((e) => e.entry.msg.includes('no 5V rail on CAM2'))).toBe(true);
  });
});

describe('telemetry tap: uploads + sd + fw', () => {
  it('tickUploads emits an uploads event with the current queue counts', () => {
    const dev = new MockKinoDevice();
    dev.setScenario('uploadBacklog', true);
    const events: TwinTelemetry[] = [];
    dev.onTelemetry((e) => events.push(e));

    dev.tickUploads();

    const queue = dev.uploadQueue();
    const ev = events.find((e) => e.t === 'uploads');
    expect(ev).toEqual({
      t: 'uploads',
      pending: queue.pending,
      uploading: queue.uploading,
      failed: queue.failed,
      uploaded: queue.uploaded,
    });
  });

  it('media reads and writes emit sd telemetry with the matching activity', async () => {
    const dev = new MockKinoDevice();
    const transport = new MockTransport(dev);
    await transport.open();
    const client = new KinoProtocolClient(transport);
    const events: TwinTelemetry[] = [];
    dev.onTelemetry((e) => events.push(e));
    try {
      const list = await client.request<{ items: { id: string }[] }>(Cmd.MEDIA_LIST, { cursor: 0, limit: 1 });
      await client.request(Cmd.MEDIA_FAVORITE, { id: list.items[0].id, favorite: true });

      const sdEvents = events.filter((e): e is Extract<TwinTelemetry, { t: 'sd' }> => e.t === 'sd');
      expect(sdEvents.some((e) => e.activity === 'read')).toBe(true);
      expect(sdEvents.some((e) => e.activity === 'write')).toBe(true);
    } finally {
      client.dispose();
      await transport.close();
    }
  });

  it('firmware transfer emits fw telemetry as its state moves', async () => {
    const dev = new MockKinoDevice();
    const transport = new MockTransport(dev);
    await transport.open();
    const client = new KinoProtocolClient(transport);
    const events: TwinTelemetry[] = [];
    dev.onTelemetry((e) => events.push(e));
    try {
      await client.request(Cmd.ENTER_MAINTENANCE, {});
      await client.request(Cmd.FW_BEGIN, { target: 'cam1', size: 16, sha256: 'x', version: '0.2.0' });
      await client.request(Cmd.FW_ABORT, {});

      const fwEvents = events.filter((e): e is Extract<TwinTelemetry, { t: 'fw' }> => e.t === 'fw');
      expect(fwEvents.map((e) => e.state)).toEqual(['receiving', 'idle']);
      expect(fwEvents.every((e) => e.target === 'cam1')).toBe(true);
    } finally {
      client.dispose();
      await transport.close();
    }
  });
});
