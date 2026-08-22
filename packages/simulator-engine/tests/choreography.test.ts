// choreographCapture is pure — no timers, no device, no RNG. These tests
// build a hand-rolled TwinSnapshot fixture and assert the §13 timeline rules
// directly against it.
import { describe, expect, it } from 'vitest';
import type { CamId } from '@kino/kdp';
import { DEFAULT_SCENARIOS } from '@kino/test-fixtures';
import type { CamFault, TwinSnapshot } from '@kino/test-fixtures';
import { choreographCapture } from '../src/choreography';
import type { TimelineEvent } from '../src/choreography';
import type { CaptureStage, SimEvent } from '../src/events';

// The D4's own free-running default phases (matches MockKinoDevice's
// camPhaseUs) — cam2 leads, cam3 trails, regardless of cam numbering.
const DEFAULT_PHASES: Record<CamId, number> = { cam1: 7_420, cam2: 0, cam3: 21_880, cam4: 2_910 };

function makeSnapshot(opts?: { uartBaud?: number; faults?: Partial<Record<CamId, CamFault | null>> }): TwinSnapshot {
  const faults = opts?.faults ?? {};
  const cam = (id: CamId) => ({
    fw: '0.1.0',
    phaseUs: DEFAULT_PHASES[id],
    uartErrors: 0,
    jpegKB: 0,
    durationMs: 0,
    gpioSkewUs: 0,
    fault: faults[id] ?? null,
    updating: false,
    exposureUs: 16_667,
    focus: null,
  });
  return {
    sessionId: 'boot-1',
    maintenance: false,
    batteryV: 4.0,
    sdPresent: true,
    sdFreeMB: 20_000,
    uartBaud: opts?.uartBaud ?? 921_600,
    frameIntervalUs: 33_333,
    phaseAligned: false,
    p4Fw: '0.1.0',
    firmwareProfile: 'd4-sim-full',
    simulatedFuture: true,
    flashEnabled: true,
    cams: { cam1: cam('cam1'), cam2: cam('cam2'), cam3: cam('cam3'), cam4: cam('cam4') },
    roll: { joined: false, name: null },
    uploads: { pending: 0, uploading: 0, failed: 0, uploaded: 0 },
    wifi: 'offline',
    scenarios: { ...DEFAULT_SCENARIOS },
  };
}

function camStageEvents(timeline: TimelineEvent[], stage: CaptureStage) {
  return timeline.filter((e) => e.event.t === 'cam-stage' && e.event.stage === stage) as {
    atMs: number;
    event: Extract<SimEvent, { t: 'cam-stage' }>;
  }[];
}

describe('choreographCapture', () => {
  it('free-running VSYNC phase decides EXPOSING order, not cam numbering', () => {
    const snap = makeSnapshot();
    const cams = {
      cam1: { jpegKB: 400, durationMs: 150 },
      cam2: { jpegKB: 400, durationMs: 150 },
      cam3: { jpegKB: 400, durationMs: 150 },
      cam4: { jpegKB: 400, durationMs: 150 },
    };

    const timeline = choreographCapture(snap, cams);

    const exposing = camStageEvents(timeline, 'EXPOSING');
    expect(exposing.map((e) => e.event.cam)).toEqual(['cam2', 'cam4', 'cam1', 'cam3']);

    const syncPulses = timeline.filter((e) => e.event.t === 'sync-pulse');
    expect(syncPulses).toHaveLength(1);

    // §13: all four cams are captured before any transfer begins — every
    // TRANSFERRING starts at the same instant: max(jpegReady).
    const transferring = camStageEvents(timeline, 'TRANSFERRING');
    const startTimes = new Set(transferring.map((e) => e.atMs));
    expect(startTimes.size).toBe(1);
    const expectedStart = 40 + DEFAULT_PHASES.cam3 / 1000 + 150; // cam3's phase is slowest, so it sets max(jpegReady)
    expect([...startTimes][0]).toBeCloseTo(expectedStart, 6);
  });

  it('transfer duration for a 400 KB frame scales with uartBaud', () => {
    const cams = { cam2: { jpegKB: 400, durationMs: 0 } };

    const at921600 = choreographCapture(makeSnapshot({ uartBaud: 921_600 }), cams);
    const transferring1 = camStageEvents(at921600, 'TRANSFERRING')[0]!;
    const stored1 = camStageEvents(at921600, 'STORED')[0]!;
    expect(stored1.atMs - transferring1.atMs).toBeCloseTo(4_444.44, 1);

    const at2M = choreographCapture(makeSnapshot({ uartBaud: 2_000_000 }), cams);
    const transferring2 = camStageEvents(at2M, 'TRANSFERRING')[0]!;
    const stored2 = camStageEvents(at2M, 'STORED')[0]!;
    expect(stored2.atMs - transferring2.atMs).toBeCloseTo(2_048, 1);
  });

  it('a cam with a bus-down fault never leaves IDLE', () => {
    const snap = makeSnapshot({ faults: { cam4: 'offline' } });
    const cams = {
      cam1: { jpegKB: 400, durationMs: 150 },
      cam2: { jpegKB: 400, durationMs: 150 },
      cam3: { jpegKB: 400, durationMs: 150 },
      // cam4 omitted — an offline cam has no report, same as the device's
      // own committed telemetry.
    };

    const timeline = choreographCapture(snap, cams);

    expect(timeline.some((e) => 'cam' in e.event && e.event.cam === 'cam4')).toBe(false);
    // the other three still run the full choreography to completion.
    expect(camStageEvents(timeline, 'READY')).toHaveLength(3);
  });
});
