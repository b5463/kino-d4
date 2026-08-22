// Power-load ladder (issue #61): the series builder holds the Twin's power
// model against the device's own battery reads. The rules it must not break
// are that the estimate comes from computePower and nowhere else, and that a
// rung the device never answered for reports nothing rather than zero.
import { describe, expect, it } from 'vitest';
import { D4_V1 } from '@kino/hardware-profiles';
import { computePower } from '@kino/simulator-engine';
import {
  buildPowerLoadSeries,
  powerLoadRungs,
  worstDivergence,
  type PowerRungSamples,
} from '../src/developer/powerLoad';

const PROFILE = D4_V1.power;

const FULL_LADDER = powerLoadRungs({ flash: ['low', 'medium', 'high'], uart: true });

function samples(id: PowerRungSamples['id'], batteryV: number[], busV: number[] = []): PowerRungSamples {
  return { id, batteryV, busV };
}

describe('powerLoadRungs', () => {
  it('walks idle → preview → quad → each flash level → uart', () => {
    expect(FULL_LADDER.map((r) => r.id)).toEqual([
      'idle',
      'preview',
      'quad',
      'flash-low',
      'flash-medium',
      'flash-high',
      'uart',
    ]);
  });

  it('leaves out the rungs the firmware cannot drive', () => {
    const gated = powerLoadRungs({ flash: [], uart: false });
    expect(gated.map((r) => r.id)).toEqual(['idle', 'preview', 'quad']);
  });

  it('the flash rungs differ from quad capture only by the flash current', () => {
    const quad = FULL_LADDER.find((r) => r.id === 'quad')!;
    const high = FULL_LADDER.find((r) => r.id === 'flash-high')!;
    expect(high.activity).toEqual({ ...quad.activity, flashA: 0.65 });
    expect(quad.activity.flashA).toBe(0);
  });

  it('every rung names the command that drives it', () => {
    for (const rung of FULL_LADDER) expect(rung.command.length).toBeGreaterThan(0);
  });
});

describe('buildPowerLoadSeries', () => {
  it('takes ESTIMATED straight from computePower, not from a second model', () => {
    const rows = buildPowerLoadSeries(PROFILE, FULL_LADDER, []);
    for (const row of rows) {
      const rung = FULL_LADDER.find((r) => r.id === row.id)!;
      expect(row.estimated).toEqual(computePower(PROFILE, PROFILE.loads, rung.activity));
    }
  });

  it('the estimated bus current rises monotonically up the ladder', () => {
    const rows = buildPowerLoadSeries(PROFILE, FULL_LADDER, []);
    const ids = ['idle', 'preview', 'quad', 'flash-low', 'flash-medium', 'flash-high'];
    const draw = ids.map((id) => rows.find((r) => r.id === id)!.estimated.busA);
    for (let i = 1; i < draw.length; i++) expect(draw[i]).toBeGreaterThan(draw[i - 1]);
  });

  it('reports the deepest sag, the mean and the sample count', () => {
    const rows = buildPowerLoadSeries(PROFILE, FULL_LADDER, [
      samples('quad', [3.9, 3.7, 3.8]),
    ]);
    const quad = rows.find((r) => r.id === 'quad')!;
    expect(quad.measured?.minBatteryV).toBe(3.7);
    expect(quad.measured?.meanBatteryV).toBeCloseTo(3.8, 10);
    expect(quad.measured?.minBusV).toBeNull();
    expect(quad.measured?.samples).toBe(3);
  });

  it('divergence is negative and sized when the pack sags deeper than predicted', () => {
    const rows = buildPowerLoadSeries(PROFILE, FULL_LADDER, [samples('quad', [3.4])]);
    const quad = rows.find((r) => r.id === 'quad')!;
    const estimated = quad.estimated.batteryV;
    expect(quad.divergenceV).toBeCloseTo(3.4 - estimated, 10);
    expect(quad.divergenceV!).toBeLessThan(0);
    expect(quad.divergencePct).toBeCloseTo(((3.4 - estimated) / estimated) * 100, 10);
  });

  it('divergence is positive when the device holds up better than the model', () => {
    const idleEstimate = buildPowerLoadSeries(PROFILE, FULL_LADDER, [])
      .find((r) => r.id === 'idle')!.estimated.batteryV;
    const rows = buildPowerLoadSeries(PROFILE, FULL_LADDER, [
      samples('idle', [idleEstimate + 0.2]),
    ]);
    const idle = rows.find((r) => r.id === 'idle')!;
    expect(idle.divergenceV).toBeCloseTo(0.2, 10);
    expect(idle.divergencePct!).toBeGreaterThan(0);
  });

  it('a rung with no samples is NOT MEASURED, never zero', () => {
    const rows = buildPowerLoadSeries(PROFILE, FULL_LADDER, [
      samples('idle', [4.0]),
      samples('uart', []),
    ]);
    const uart = rows.find((r) => r.id === 'uart')!;
    expect(uart.measured).toBeNull();
    expect(uart.divergenceV).toBeNull();
    expect(uart.divergencePct).toBeNull();

    // A rung the run never reached behaves the same as one that answered nothing.
    expect(rows.find((r) => r.id === 'quad')!.measured).toBeNull();
  });

  it('carries the rail voltage only when the firmware reported one', () => {
    const rows = buildPowerLoadSeries(PROFILE, FULL_LADDER, [
      samples('quad', [3.8, 3.75], [4.98, 4.91]),
      samples('preview', [4.0]),
    ]);
    expect(rows.find((r) => r.id === 'quad')!.measured?.minBusV).toBe(4.91);
    expect(rows.find((r) => r.id === 'preview')!.measured?.minBusV).toBeNull();
  });

  it('keeps the drive error on the row it belongs to', () => {
    const rows = buildPowerLoadSeries(PROFILE, FULL_LADDER, [
      { id: 'flash-high', batteryV: [3.6], busV: [], error: 'NACK 0x05' },
    ]);
    expect(rows.find((r) => r.id === 'flash-high')!.error).toBe('NACK 0x05');
    expect(rows.find((r) => r.id === 'idle')!.error).toBeNull();
  });

  it('returns one row per rung, in ladder order', () => {
    const rows = buildPowerLoadSeries(PROFILE, FULL_LADDER, [samples('quad', [3.8])]);
    expect(rows.map((r) => r.id)).toEqual(FULL_LADDER.map((r) => r.id));
  });
});

describe('worstDivergence', () => {
  it('picks the largest gap by magnitude, either sign', () => {
    const rows = buildPowerLoadSeries(PROFILE, FULL_LADDER, [
      samples('idle', [4.1]),
      samples('quad', [3.0]),
      samples('uart', [3.9]),
    ]);
    expect(worstDivergence(rows)?.id).toBe('quad');
  });

  it('is null when nothing was measured', () => {
    expect(worstDivergence(buildPowerLoadSeries(PROFILE, FULL_LADDER, []))).toBeNull();
  });
});
