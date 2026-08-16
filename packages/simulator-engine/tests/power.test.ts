// computePower/thermalStep are pure — no timers, no device, no RNG. These
// build a hand-rolled activity/loads fixture and assert the §7/§15/§16
// warning, fuse, tagging and thermal-drift rules directly.
import { describe, expect, it } from 'vitest';
import { D4_V1 } from '@kino/hardware-profiles';
import type { PowerProfile } from '@kino/hardware-profiles';
import { ACTIVITY_PRESETS, computePower } from '../src/power';
import type { ActivityState } from '../src/power';
import { thermalStep } from '../src/thermal';
import type { ThermalState, ThermalZone } from '../src/thermal';

const POWER = D4_V1.power;

describe('computePower', () => {
  it('idle draws ~0.32 A on the bus, sourced from the MANUFACTURER-tagged p4 display load', () => {
    const sample = computePower(POWER, POWER.loads, ACTIVITY_PRESETS.idle);

    expect(sample.busA).toBeCloseTo(0.32, 6);
    expect(sample.tags.busA).toBe('MANUFACTURER');
    expect(sample.tags.batteryA).toBe('MANUFACTURER');
    expect(sample.tags.boostLossW).toBe('MANUFACTURER');
    expect(sample.tags.busV).toBe('MANUFACTURER');
    // §14: the battery-voltage sag model is never grounded in a measurement,
    // regardless of which loads are active.
    expect(sample.tags.batteryV).toBe('SIMULATED');
    expect(sample.warnings).toEqual([]);
    expect(sample.fuse).toBe('ok');
  });

  it('worstOverlap pushes battery-side current over 3 A: SUSTAINED_OVER_3A after 5 s, fuse warm after 10 s', () => {
    const first = computePower(POWER, POWER.loads, ACTIVITY_PRESETS.worstOverlap);
    expect(first.batteryA).toBeGreaterThan(POWER.battery.safeContinuousA);
    expect(first.batteryA).toBeLessThan(POWER.battery.shortPulseMaxA);
    expect(first.warnings).toContain('TRANSIENT_3_6A');
    expect(first.warnings).not.toContain('SUSTAINED_OVER_3A');
    expect(first.fuse).toBe('ok');

    const t0 = 1_000;
    const sustained = computePower(POWER, POWER.loads, ACTIVITY_PRESETS.worstOverlap, {
      overAsinceMs: t0,
      nowMs: t0 + 5_001,
    });
    expect(sustained.warnings).toContain('SUSTAINED_OVER_3A');
    expect(sustained.fuse).toBe('ok');

    const warm = computePower(POWER, POWER.loads, ACTIVITY_PRESETS.worstOverlap, {
      overAsinceMs: t0,
      nowMs: t0 + 10_001,
    });
    expect(warm.warnings).toContain('SUSTAINED_OVER_3A');
    expect(warm.fuse).toBe('warm');
  });

  it('a synthetic heavy load pushes battery current over 6 A: CRITICAL_OVER_6A + blown fuse + BUS_SAG', () => {
    // Deliberately inflated camActive draw — the point is exercising the
    // >6A branch cleanly, not modeling a real D4 load combination
    // (worstOverlap above tops out around 4 A on the real profile).
    const heavyLoads: PowerProfile['loads'] = {
      ...POWER.loads,
      camActive: { amps: 1.0, tag: 'ESTIMATED' },
    };
    const activity: ActivityState = {
      p4On: true,
      camsOn: ['cam1', 'cam2', 'cam3', 'cam4'],
      camsCapturing: ['cam1', 'cam2', 'cam3', 'cam4'],
      uartActive: [],
      flashA: 0.65,
      wifiUploading: true,
      chargingA: 0,
    };

    const sample = computePower(POWER, heavyLoads, activity);

    expect(sample.batteryA).toBeGreaterThan(POWER.battery.shortPulseMaxA);
    expect(sample.warnings).toContain('CRITICAL_OVER_6A');
    expect(sample.warnings).toContain('BUS_SAG');
    expect(sample.fuse).toBe('blown');
  });

  it('a blown fuse stays blown even after current drops back to normal (a fast-blow fuse does not self-heal)', () => {
    const heavyLoads: PowerProfile['loads'] = {
      ...POWER.loads,
      camActive: { amps: 1.0, tag: 'ESTIMATED' },
    };
    const heavyActivity: ActivityState = {
      p4On: true,
      camsOn: ['cam1', 'cam2', 'cam3', 'cam4'],
      camsCapturing: ['cam1', 'cam2', 'cam3', 'cam4'],
      uartActive: [],
      flashA: 0.65,
      wifiUploading: true,
      chargingA: 0,
    };

    // Tick 1: the heavy load blows the fuse.
    const blown = computePower(POWER, heavyLoads, heavyActivity, {
      overAsinceMs: null,
      nowMs: 0,
      fuseBlown: false,
    });
    expect(blown.fuse).toBe('blown');

    // Tick 2: load drops all the way back to idle, but the caller (matching
    // TwinSimulator's own bookkeeping) reports the fuse was already blown.
    // A regression here would be computePower re-deriving 'ok' purely from
    // this tick's (harmless) current, which is exactly the self-heal bug
    // task-7 review finding #1 flagged.
    const stillBlown = computePower(POWER, POWER.loads, ACTIVITY_PRESETS.idle, {
      overAsinceMs: null,
      nowMs: 60_000,
      fuseBlown: true,
    });
    expect(stillBlown.batteryA).toBeLessThan(POWER.battery.safeContinuousA);
    expect(stillBlown.fuse).toBe('blown');
  });

  it('charging at 0.8 A is above the preferred rate but not over max', () => {
    const sample = computePower(POWER, POWER.loads, { ...ACTIVITY_PRESETS.idle, chargingA: 0.8 });
    expect(sample.warnings).toContain('CHARGE_ABOVE_PREFERRED');
    expect(sample.warnings).not.toContain('CHARGE_OVER_MAX');
  });

  it('charging at 1.6 A is over the max — the 3 A/1C rate is never modeled as acceptable', () => {
    const sample = computePower(POWER, POWER.loads, { ...ACTIVITY_PRESETS.idle, chargingA: 1.6 });
    expect(sample.warnings).toContain('CHARGE_OVER_MAX');
  });
});

describe('thermalStep', () => {
  const allCool: Record<ThermalZone, ThermalState> = {
    battery: 'COOL',
    sw6106: 'COOL',
    led: 'COOL',
    heatsink: 'COOL',
    batteryConnector: 'COOL',
  };

  it('sustained over-3A current heats the battery zone toward HOT over repeated ticks', () => {
    const sample = computePower(POWER, POWER.loads, ACTIVITY_PRESETS.worstOverlap, {
      overAsinceMs: 0,
      nowMs: 10_001,
    });
    expect(sample.fuse).toBe('warm');

    let zones = allCool;
    let carryMs = 0;
    for (let i = 0; i < 5; i++) {
      ({ zones, carryMs } = thermalStep(zones, sample, ACTIVITY_PRESETS.worstOverlap, 500, carryMs));
    }
    expect(zones.battery).toBe('HOT');
  });

  it('drifts back toward COOL once the load stops', () => {
    let zones: Record<ThermalZone, ThermalState> = { ...allCool, battery: 'HOT' };
    let carryMs = 0;
    const idleSample = computePower(POWER, POWER.loads, ACTIVITY_PRESETS.idle);

    for (let i = 0; i < 5; i++) {
      ({ zones, carryMs } = thermalStep(zones, idleSample, ACTIVITY_PRESETS.idle, 500, carryMs));
    }
    expect(zones.battery).toBe('COOL');
  });

  it('a single large dtMs still advances multiple steps in one call', () => {
    // A load heavy enough to target CRITICAL for the battery zone (same
    // fixture as computePower's own >6A test) — COOL -> CRITICAL is 3
    // ordinal steps, and a single 2,000 ms call (4 nominal 500 ms periods)
    // comfortably covers that in one shot.
    const heavyLoads: PowerProfile['loads'] = { ...POWER.loads, camActive: { amps: 1.0, tag: 'ESTIMATED' } };
    const heavyActivity: ActivityState = {
      p4On: true,
      camsOn: ['cam1', 'cam2', 'cam3', 'cam4'],
      camsCapturing: ['cam1', 'cam2', 'cam3', 'cam4'],
      uartActive: [],
      flashA: 0.65,
      wifiUploading: true,
      chargingA: 0,
    };
    const sample = computePower(POWER, heavyLoads, heavyActivity);
    expect(sample.warnings).toContain('CRITICAL_OVER_6A');

    const { zones, carryMs } = thermalStep(allCool, sample, heavyActivity, 2_000);
    expect(zones.battery).toBe('CRITICAL');
    expect(carryMs).toBe(0); // 2,000 ms is an exact multiple of the 500 ms period
  });

  it('a sub-period dtMs (< 500 ms) does not force a step — no silent speed-up toward a hot target', () => {
    // task-7 review finding #3, round 1: thermalStep used to floor a
    // *minimum* of one step regardless of dtMs, so a caller invoking this
    // once per animation frame (~16 ms) would race COOL -> CRITICAL in 3
    // calls. A single call with dtMs well under MS_PER_STEP (500 ms) must
    // leave the state exactly as it was handed in.
    const sample = computePower(POWER, POWER.loads, ACTIVITY_PRESETS.worstOverlap, {
      overAsinceMs: 0,
      nowMs: 10_001,
    });
    expect(sample.fuse).toBe('warm'); // confirms this sample does target a hotter state

    const oneFrame = thermalStep(allCool, sample, ACTIVITY_PRESETS.worstOverlap, 16);
    expect(oneFrame.zones).toEqual(allCool);
    expect(oneFrame.carryMs).toBe(16);
  });

  it('~31 repeated 16 ms calls do not yet step, but the 32nd (crossing 500 ms) does — proportional, not forced, not stuck', () => {
    // task-7 review finding #3, round 2: a bare floor(dtMs/MS_PER_STEP) with
    // no carry swapped the "always forces a step" bug for "never steps under
    // a sub-period cadence, no matter how many times it's called" — the
    // fuse-warm sample never moved the battery zone even after 20x 16 ms
    // calls (320 ms of simulated real time). With `carryMs` threaded back in,
    // 31 calls (496 ms cumulative) must still be a no-op, and the very next
    // one (512 ms cumulative — the first time the running total clears the
    // 500 ms period) must register exactly one step.
    const sample = computePower(POWER, POWER.loads, ACTIVITY_PRESETS.worstOverlap, {
      overAsinceMs: 0,
      nowMs: 10_001,
    });
    expect(sample.fuse).toBe('warm');

    let zones = allCool;
    let carryMs = 0;
    for (let i = 0; i < 31; i++) {
      ({ zones, carryMs } = thermalStep(zones, sample, ACTIVITY_PRESETS.worstOverlap, 16, carryMs));
    }
    expect(zones.battery).toBe('COOL'); // 496 ms elapsed — still under one period
    expect(carryMs).toBe(496);

    ({ zones, carryMs } = thermalStep(zones, sample, ACTIVITY_PRESETS.worstOverlap, 16, carryMs));
    expect(zones.battery).toBe('WARM'); // 512 ms elapsed — one step in, one 12 ms carried forward
    expect(carryMs).toBe(12);
  });
});
