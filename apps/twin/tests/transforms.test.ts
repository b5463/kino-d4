import { describe, expect, it } from 'vitest';
import { D4_V1 } from '@kino/hardware-profiles';
import type { InstanceDef } from '@kino/hardware-profiles';
import { camBarX, explodedPosition, instanceTransforms } from '../src/scene/transforms';

function fixtureInstance(overrides: Partial<InstanceDef> & Pick<InstanceDef, 'positionMm'>): InstanceDef {
  return {
    id: 'fixture',
    component: 'enclosure',
    rotationDeg: [0, 0, 0],
    group: 'body',
    explodeOrder: 0,
    explodeDirMm: [0, 0, 1],
    ...overrides,
  };
}

describe('camBarX', () => {
  it('places the four lens centers at -33/-11/+11/+33 at the 22 mm default pitch (§5)', () => {
    expect(camBarX(1, 22)).toBe(-33);
    expect(camBarX(2, 22)).toBe(-11);
    expect(camBarX(3, 22)).toBe(11);
    expect(camBarX(4, 22)).toBe(33);
  });

  it('scales with pitch — 20 mm pitch narrows the row to -30/-10/+10/+30', () => {
    expect(camBarX(1, 20)).toBe(-30);
    expect(camBarX(2, 20)).toBe(-10);
    expect(camBarX(3, 20)).toBe(10);
    expect(camBarX(4, 20)).toBe(30);
  });
});

describe('explodedPosition', () => {
  it('returns the base position untouched when explode is 0', () => {
    const inst = fixtureInstance({ positionMm: [5, -7, 18], explodeOrder: 9, explodeDirMm: [0, 0, 1] });
    expect(explodedPosition(inst, 0)).toEqual([5, -7, 18]);
  });

  it('moves front-acrylic (order 9, +Z) by 108 mm at full explode', () => {
    const front = fixtureInstance({ positionMm: [0, 0, 18], explodeOrder: 9, explodeDirMm: [0, 0, 1] });
    expect(explodedPosition(front, 1)).toEqual([0, 0, 126]);
  });

  it('leaves rear-acrylic (order 0) exactly at its base position at full explode', () => {
    const rear = fixtureInstance({ positionMm: [0, 0, -18], explodeOrder: 0, explodeDirMm: [0, 0, -1] });
    expect(explodedPosition(rear, 1)).toEqual([0, 0, -18]);
  });

  it('scales linearly with a partial explode value', () => {
    const inst = fixtureInstance({ positionMm: [0, 0, 0], explodeOrder: 6, explodeDirMm: [0, 0, 1] });
    expect(explodedPosition(inst, 0.5)).toEqual([0, 0, 36]); // 6 * 0.5 * 12
  });
});

describe('instanceTransforms — D4_V1', () => {
  it('reproduces the profile-authored camera-bar row at the 22 mm default pitch and zero explode', () => {
    const transforms = instanceTransforms(D4_V1, 22, 0);
    for (const id of ['cam1', 'cam2', 'cam3', 'cam4']) {
      const inst = D4_V1.instances.find((i) => i.id === id);
      if (!inst) throw new Error(`fixture missing instance "${id}"`);
      expect(transforms.get(id)?.positionMm).toEqual(inst.positionMm);
    }
  });

  it('re-pitches the camera bar independent of the profile-authored X (§5)', () => {
    const transforms = instanceTransforms(D4_V1, 20, 0);
    expect(transforms.get('cam1')?.positionMm[0]).toBe(-30);
    expect(transforms.get('cam2')?.positionMm[0]).toBe(-10);
    expect(transforms.get('cam3')?.positionMm[0]).toBe(10);
    expect(transforms.get('cam4')?.positionMm[0]).toBe(30);
  });

  it('moves front-acrylic +108 mm on Z and leaves rear-acrylic in place at full explode', () => {
    const transforms = instanceTransforms(D4_V1, 22, 1);
    expect(transforms.get('front-acrylic')?.positionMm).toEqual([0, 0, 126]);
    expect(transforms.get('rear-acrylic')?.positionMm).toEqual([0, 0, -18]);
  });

  it('moves every camera-bar instance by the same explode offset — the bar rides as one rigid group (§5)', () => {
    const base = instanceTransforms(D4_V1, 22, 0);
    const exploded = instanceTransforms(D4_V1, 22, 1);

    const offsets = ['cam1', 'cam2', 'cam3', 'cam4'].map((id) => {
      const b = base.get(id);
      const e = exploded.get(id);
      if (!b || !e) throw new Error(`fixture missing transform for "${id}"`);
      return [e.positionMm[0] - b.positionMm[0], e.positionMm[1] - b.positionMm[1], e.positionMm[2] - b.positionMm[2]];
    });

    // Same offset on every camera — pitch alone controls X, so the shared
    // rigid-group offset shows up entirely on Y/Z here.
    for (const offset of offsets) expect(offset).toEqual(offsets[0]);
    expect(offsets[0]).not.toEqual([0, 0, 0]);
  });
});
