// Integration coverage for the capture-choreography wiring described in the
// brief but not exercised by choreography.test.ts (pure function) or
// boot.test.ts (boot machine only): a real CAMERA_CAPTURE frame driving
// device.onTelemetry -> TwinSimulator.scheduleCapture -> queueMicrotask ->
// choreographCapture -> timer-emitted SimEvents, end to end.
import { describe, expect, it, vi } from 'vitest';
import { Cmd, FrameFlags, PROTOCOL_VERSION, encodeFrame, encodeJson } from '@kino/kdp';
import { TwinSimulator } from '../src/TwinSimulator';
import type { SimEvent } from '../src/events';

function sendCapture(sim: TwinSimulator, seq: number) {
  // Raw KDP, no side-channel — the same wire a real Studio shutter press
  // would produce (matches @kino/test-fixtures' own telemetry tests).
  sim.device.receive(
    encodeFrame({
      version: PROTOCOL_VERSION,
      type: Cmd.CAMERA_CAPTURE,
      seq,
      flags: FrameFlags.NONE,
      payload: encodeJson({}),
    }),
  );
}

function camStagesOf(events: SimEvent[]) {
  return events.filter((e): e is Extract<SimEvent, { t: 'cam-stage' }> => e.t === 'cam-stage');
}

function uartsOf(events: SimEvent[]) {
  return events.filter((e): e is Extract<SimEvent, { t: 'uart' }> => e.t === 'uart');
}

describe('TwinSimulator capture wiring', () => {
  it('a real CAMERA_CAPTURE drives cam-stage/sync-pulse/uart through to READY for all four cams', async () => {
    vi.useFakeTimers();
    try {
      const sim = new TwinSimulator({ seed: 7 });
      const events: SimEvent[] = [];
      const unsubscribe = sim.onEvent((e) => events.push(e));

      sendCapture(sim, 1);
      // handleFrame itself dispatches through a randomized-latency setTimeout
      // (MockKinoDevice.ts:927) before simulateCapture() ever runs, and
      // scheduleCapture()'s own queueMicrotask needs a real microtask
      // checkpoint to flush — the async advance variant yields between each
      // fake timer callback, which the sync one does not.
      await vi.advanceTimersByTimeAsync(10_000); // generous — the whole dispatch + choreography + device commit finish well inside this

      expect(events.filter((e) => e.t === 'sync-pulse')).toHaveLength(1);

      const arming = camStagesOf(events).filter((e) => e.stage === 'ARMING');
      expect(arming.map((e) => e.cam).sort()).toEqual(['cam1', 'cam2', 'cam3', 'cam4']);

      const ready = camStagesOf(events).filter((e) => e.stage === 'READY');
      expect(ready.map((e) => e.cam).sort()).toEqual(['cam1', 'cam2', 'cam3', 'cam4']);

      const uarts = uartsOf(events);
      expect(uarts.filter((e) => e.active).map((e) => e.cam).sort()).toEqual(['cam1', 'cam2', 'cam3', 'cam4']);
      expect(uarts.filter((e) => !e.active).map((e) => e.cam).sort()).toEqual(['cam1', 'cam2', 'cam3', 'cam4']);

      // The raw device telemetry is forwarded unfiltered alongside the choreography.
      const committed = events.some(
        (e) => e.t === 'device' && e.telemetry.t === 'capture' && e.telemetry.phase === 'committed',
      );
      expect(committed).toBe(true);

      unsubscribe();
      sim.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cam2Timeout excludes cam2 from the choreography, matching the device\'s own (incomplete) report', async () => {
    vi.useFakeTimers();
    try {
      const sim = new TwinSimulator({ seed: 7 });
      sim.device.setScenario('cam2Timeout', true);
      const events: SimEvent[] = [];
      const unsubscribe = sim.onEvent((e) => events.push(e));

      sendCapture(sim, 1);
      await vi.advanceTimersByTimeAsync(10_000);

      const stagedCams = new Set(camStagesOf(events).map((e) => e.cam));
      expect(stagedCams.has('cam2')).toBe(false);
      expect([...stagedCams].sort()).toEqual(['cam1', 'cam3', 'cam4']);

      const uartCams = new Set(uartsOf(events).map((e) => e.cam));
      expect(uartCams.has('cam2')).toBe(false);

      // The device's own report agrees this round is incomplete: a skipped
      // cam means simulateCapture() never reaches its 'committed' telemetry
      // at all (MockKinoDevice.ts: "incomplete sets are marked, not
      // published"). Only 'begin' fires — no cam2 entry to check because
      // there's no per-cam report to have one in the first place.
      const begin = events.some(
        (e) => e.t === 'device' && e.telemetry.t === 'capture' && e.telemetry.phase === 'begin',
      );
      const committed = events.some(
        (e) => e.t === 'device' && e.telemetry.t === 'capture' && e.telemetry.phase === 'committed',
      );
      expect(begin).toBe(true);
      expect(committed).toBe(false);

      unsubscribe();
      sim.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not schedule choreography after disposal wins the microtask race', async () => {
    vi.useFakeTimers();
    try {
      const sim = new TwinSimulator({ seed: 7 });
      const events: SimEvent[] = [];
      sim.onEvent((e) => events.push(e));

      sendCapture(sim, 1);
      // Run the device command callback synchronously. Its capture-begin
      // telemetry queues scheduleCapture's microtask, but does not flush it.
      vi.advanceTimersByTime(1_000);
      sim.dispose();
      await Promise.resolve();
      await vi.runAllTimersAsync();

      expect(camStagesOf(events)).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
