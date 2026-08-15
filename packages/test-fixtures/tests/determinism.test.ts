import { describe, it, expect, vi } from 'vitest';
import { MockKinoDevice } from '../src/MockKinoDevice';
import {
  encodeFrame,
  encodeJson,
  Cmd,
  FrameFlags,
  PROTOCOL_VERSION,
  CAM_IDS,
  NEUTRAL_CAL,
  KinoProtocolClient,
  MockTransport,
} from '@kino/kdp';

// No @types/node in this package — compare bytes directly instead of via
// Buffer, which would only be a type (not a runtime) problem but still fails
// `tsc --noEmit`.
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function drive(seed: number): Uint8Array {
  const out: number[] = [];
  const dev = new MockKinoDevice({ seed, now: () => 1_755_244_800_000 });
  dev.attach((b) => out.push(...b), () => {});
  const send = (cmd: Cmd, seq: number, payload: unknown) =>
    dev.receive(
      encodeFrame({ version: PROTOCOL_VERSION, type: cmd, seq, flags: FrameFlags.NONE, payload: encodeJson(payload) }),
    );
  send(Cmd.HELLO, 1, { nonce: 7 });
  send(Cmd.GET_DEVICE_INFO, 2, {});
  send(Cmd.GET_CAMERA_INFO, 3, {});
  send(Cmd.GET_RUNTIME_STATS, 4, {});
  // Not runAllTimers(): startAmbient's log/capture timers reschedule
  // themselves forever, which trips vitest's infinite-loop guard.
  vi.advanceTimersByTime(10_000);
  dev.detach();
  return Uint8Array.from(out);
}

describe('seeded MockKinoDevice', () => {
  it('same seed + same inbound bytes → identical outbound bytes', () => {
    vi.useFakeTimers();
    try {
      const a = drive(42);
      const b = drive(42);
      const c = drive(43);
      expect(bytesEqual(a, b)).toBe(true);
      expect(bytesEqual(a, c)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: handleCalibrate's order-save/flash-save/apply branches used to
  // stamp orderVerifiedAt/calibratedAt/capturedAt with `new Date().toISOString()`
  // directly, bypassing the injected clock — the one corner of the device that
  // stayed on the wall clock even under a seed. A recording made against a
  // fixed `now` must replay with these fields identical, not wall-clock drift.
  it('routes calibration *At timestamps through the injected now()', async () => {
    const fixedNow = 1_755_244_800_000;
    const dev = new MockKinoDevice({ seed: 7, now: () => fixedNow });
    const transport = new MockTransport(dev);
    await transport.open();
    const client = new KinoProtocolClient(transport);
    try {
      await client.request(Cmd.CAMERA_CALIBRATE, {
        action: 'order-save',
        order: ['cam2', 'cam1', 'cam4', 'cam3'],
      });
      await client.request(Cmd.CAMERA_CALIBRATE, {
        action: 'flash-save',
        flash: { level: 'medium', distance: '1-2' },
      });
      await client.request(Cmd.CAMERA_CALIBRATE, {
        action: 'apply',
        offsets: Object.fromEntries(CAM_IDS.map((id) => [id, { ...NEUTRAL_CAL }])),
      });
      const calibration = dev.getCalibration();
      const expectedIso = new Date(fixedNow).toISOString();
      expect(calibration.orderVerifiedAt).toBe(expectedIso);
      expect(calibration.flash.calibratedAt).toBe(expectedIso);
      expect(calibration.capturedAt).toBe(expectedIso);
    } finally {
      client.dispose();
      await transport.close();
    }
  });
});
