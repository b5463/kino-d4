import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PowerSample } from '@kino/simulator-engine';
import { applySimEvent, initialSimState, useSimStore } from '../src/state/simStore';

afterEach(() => {
  useSimStore.getState().powerOff();
  vi.useRealTimers();
});

const powerSample: PowerSample = {
  batteryV: 3.86,
  batteryA: 2.1,
  busV: 4.94,
  busA: 1.5,
  boostLossW: 0.7,
  fuse: 'ok',
  warnings: [],
  tags: {
    batteryV: 'SIMULATED',
    batteryA: 'ESTIMATED',
    busV: 'MANUFACTURER',
    busA: 'ESTIMATED',
    boostLossW: 'ESTIMATED',
  },
};

describe('applySimEvent', () => {
  it('reduces boot, one camera stage, UART activity, and power samples', () => {
    let state = initialSimState();
    state = { ...state, ...applySimEvent(state, { t: 'boot', stage: 'BOOTING_P4' }, 100) };
    expect(state).toMatchObject({ running: true, bootStage: 'BOOTING_P4' });

    state = { ...state, ...applySimEvent(state, { t: 'cam-stage', cam: 'cam3', stage: 'EXPOSING' }, 200) };
    expect(state.camStage.cam3).toBe('EXPOSING');
    expect(state.camStage.cam2).toBe('IDLE');

    state = {
      ...state,
      ...applySimEvent(state, { t: 'uart', cam: 'cam3', active: true, bytesPerSec: 460_800 }, 300),
    };
    expect(state.uartActive.cam3).toBe(true);
    expect(state.uartBytesPerSec.cam3).toBe(460_800);

    state = { ...state, ...applySimEvent(state, { t: 'power', sample: powerSample }, 400) };
    expect(state.power).toEqual(powerSample);
  });

  it('resets every camera to IDLE on device reboot telemetry', () => {
    const state = initialSimState();
    state.camStage = { cam1: 'READY', cam2: 'EXPOSING', cam3: 'TRANSFERRING', cam4: 'STORED' };

    const patch = applySimEvent(
      state,
      { t: 'device', telemetry: { t: 'reboot', sessionId: 'boot-2', reason: 'test' } },
      500,
    );
    expect(patch.camStage).toEqual({ cam1: 'IDLE', cam2: 'IDLE', cam3: 'IDLE', cam4: 'IDLE' });
    expect(patch.uartActive).toEqual({ cam1: false, cam2: false, cam3: false, cam4: false });
  });

  it('records firmware progress, SD activity, and the sync timestamp', () => {
    let state = initialSimState();
    state = {
      ...state,
      ...applySimEvent(state, { t: 'device', telemetry: { t: 'fw', target: 'cam3', state: 'receiving', pct: 62 } }, 600),
    };
    expect(state.fw.cam3).toEqual({ state: 'receiving', pct: 62 });

    state = { ...state, ...applySimEvent(state, { t: 'device', telemetry: { t: 'sd', activity: 'write' } }, 700) };
    expect(state).toMatchObject({ sdActive: true, sdActiveAt: 700 });

    state = { ...state, ...applySimEvent(state, { t: 'sync-pulse' }, 800) };
    expect(state.syncPulseAt).toBe(800);
  });
});

describe('testCapture', () => {
  it('boots and issues CAMERA_CAPTURE through the private raw KDP client', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
    useSimStore.getState().powerOn();
    await vi.advanceTimersByTimeAsync(2_400);
    expect(useSimStore.getState().bootStage).toBe('READY');

    const capture = useSimStore.getState().testCapture();
    await vi.advanceTimersByTimeAsync(1_000);
    await capture;
    expect(useSimStore.getState().syncPulseAt).toBeGreaterThan(0);
  });
});
