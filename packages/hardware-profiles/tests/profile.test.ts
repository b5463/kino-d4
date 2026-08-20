import { describe, it, expect } from 'vitest';
import { D4_V1, hardwareProfile } from '../src/index';
import { parseVersioned } from '@kino/schemas';

describe('kino.hardware-profile d4-v1', () => {
  it('ships a valid versioned document', () => {
    expect(D4_V1.profile).toBe('d4-v1');
    expect(D4_V1.units).toBe('mm');
  });
  it('stores BOTH Guition envelopes as separate sources (§6/§7.1)', () => {
    const disp = D4_V1.components.find((c) => c.id === 'main-display')!;
    const officials = disp.sources.filter((s) => s.kind === 'OFFICIAL_SPEC');
    expect(officials.map((s) => s.sizeMm[0]).sort()).toEqual([114.4, 117.01]);
  });
  it('never hard-codes an OV3660 FOV (§7.3)', () => {
    const cam = D4_V1.components.find((c) => c.id === 'camera-node')!;
    expect(cam.specs?.horizontalFovDeg).toBeNull();
    expect(cam.specs?.fovConfidence).toBe('MEASURE_REQUIRED');
  });
  it('camera instances sit on the bar at 22 mm pitch defaults (§5)', () => {
    const xs = ['cam1', 'cam2', 'cam3', 'cam4'].map(
      (id) => D4_V1.instances.find((i) => i.id === id)!.positionMm[0],
    );
    expect(xs).toEqual([-33, -11, 11, 33]);
    expect(D4_V1.cameraPitchMm).toBe(22);
    expect(D4_V1.cameraPitchRangeMm).toEqual([20, 24]);
  });
  it('camera nodes explode as one group, not colliding with the rear-anchored pieces (§8)', () => {
    const orders = ['cam1', 'cam2', 'cam3', 'cam4'].map(
      (id) => D4_V1.instances.find((i) => i.id === id)!.explodeOrder,
    );
    expect(orders).toEqual([6, 6, 6, 6]);
  });
  it('battery power limits match seller data (§7.4)', () => {
    const b = D4_V1.power.battery;
    expect(b.safeContinuousA).toBe(3);
    expect(b.shortPulseMaxA).toBe(6);
    expect(b.chargePreferredA).toBe(0.6);
    expect(b.chargeMaxA).toBe(1.5);
  });
  it('rejects an unknown source kind', () => {
    const doc = JSON.parse(JSON.stringify({ ...D4_V1 }));
    doc.components[0].sources[0].kind = 'GUESSED';
    expect(() => parseVersioned(hardwareProfile, doc)).toThrow();
  });
});
