import { describe, expect, it } from 'vitest';
import { D4_V1 } from '@kino/hardware-profiles';
import type { HardwareProfile, InstanceDef } from '@kino/hardware-profiles';
import { camBarX, cameraBarExplodeOffsetMm, explodedPosition, instanceTransforms } from '../src/scene/transforms';

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

/**
 * `instanceTransforms`/`cameraBarExplodeOffsetMm` only ever read
 * `profile.instances` — a full `HardwareProfile` fixture would be mostly
 * dead weight for these tests, so this deliberately builds a partial one.
 */
function fixtureProfile(instances: InstanceDef[]): HardwareProfile {
  return { instances } as unknown as HardwareProfile;
}

/** A camera-bar row that agrees on explodeOrder/explodeDirMm, like the real D4_V1 profile. */
function agreeingCamBar(): InstanceDef[] {
  return [-33, -11, 11, 33].map((x, i) =>
    fixtureInstance({
      id: `cam${i + 1}`,
      positionMm: [x, 10, 14],
      group: 'camera-bar',
      explodeOrder: 6,
      explodeDirMm: [0, 0, 1],
    }),
  );
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
    // rigid-group offset shows up entirely on Y/Z here. This is guaranteed by
    // construction (instanceTransforms sources it from cameraBarExplodeOffsetMm
    // exactly once — see below), not merely because D4_V1's four cam entries
    // happen to carry matching explodeOrder/explodeDirMm.
    for (const offset of offsets) expect(offset).toEqual(offsets[0]);
    expect(offsets[0]).not.toEqual([0, 0, 0]);
  });
});

describe('cameraBarExplodeOffsetMm', () => {
  it("derives D4_V1's one shared camera-bar explode offset (order 6, dir +Z)", () => {
    expect(cameraBarExplodeOffsetMm(D4_V1, 0)).toEqual([0, 0, 0]);
    expect(cameraBarExplodeOffsetMm(D4_V1, 1)).toEqual([0, 0, 72]); // 6 * 1 * 12
    expect(cameraBarExplodeOffsetMm(D4_V1, 0.5)).toEqual([0, 0, 36]); // 6 * 0.5 * 12
  });

  it('returns zero offset for a profile with no camera-bar group', () => {
    const profile = fixtureProfile([fixtureInstance({ id: 'solo', positionMm: [0, 0, 0], group: 'body' })]);
    expect(cameraBarExplodeOffsetMm(profile, 1)).toEqual([0, 0, 0]);
  });

  it('throws when camera-bar members disagree on explodeOrder — rigidity must not depend on data agreeing by luck (§5)', () => {
    const camBar = agreeingCamBar();
    camBar[2] = fixtureInstance({ ...camBar[2]!, explodeOrder: 3 }); // cam3 diverges
    const profile = fixtureProfile(camBar);

    expect(() => cameraBarExplodeOffsetMm(profile, 1)).toThrow(/camera-bar rigidity violated/i);
  });

  it('throws when camera-bar members disagree on explodeDirMm', () => {
    const camBar = agreeingCamBar();
    camBar[2] = fixtureInstance({ ...camBar[2]!, explodeDirMm: [1, 0, 0] }); // cam3 diverges
    const profile = fixtureProfile(camBar);

    expect(() => cameraBarExplodeOffsetMm(profile, 1)).toThrow(/camera-bar rigidity violated/i);
  });

  it('throws when camera-bar members disagree on rotation', () => {
    const camBar = agreeingCamBar();
    camBar[2] = fixtureInstance({ ...camBar[2]!, rotationDeg: [0, 4, 0] });
    expect(() => cameraBarExplodeOffsetMm(fixtureProfile(camBar), 1)).toThrow(/camera-bar rigidity violated/i);
  });

  it('fails loudly if a profile adds a fifth member to the four-camera bar', () => {
    const fifth = fixtureInstance({
      ...agreeingCamBar()[0]!,
      id: 'cam5',
      positionMm: [55, 10, 14],
    });
    expect(() => instanceTransforms(fixtureProfile([...agreeingCamBar(), fifth]), 22, 1)).toThrow(/at most four/i);
  });
});

describe('instanceTransforms — camera-bar rigidity is structural, not data-coincidental', () => {
  it('a divergent camera-bar member fails loudly instead of silently flying the bar apart', () => {
    const camBar = agreeingCamBar();
    camBar[2] = fixtureInstance({ ...camBar[2]!, explodeOrder: 3 }); // cam3 diverges
    const profile = fixtureProfile(camBar);

    expect(() => instanceTransforms(profile, 22, 1)).toThrow(/camera-bar rigidity violated/i);
  });

  it('a synthetic camera-bar that agrees still moves as one unit, independent of D4_V1', () => {
    const profile = fixtureProfile(agreeingCamBar());
    const base = instanceTransforms(profile, 22, 0);
    const exploded = instanceTransforms(profile, 22, 1);

    const offsets = ['cam1', 'cam2', 'cam3', 'cam4'].map((id) => {
      const b = base.get(id);
      const e = exploded.get(id);
      if (!b || !e) throw new Error(`fixture missing transform for "${id}"`);
      return [e.positionMm[0] - b.positionMm[0], e.positionMm[1] - b.positionMm[1], e.positionMm[2] - b.positionMm[2]];
    });

    for (const offset of offsets) expect(offset).toEqual(offsets[0]);
    expect(offsets[0]).toEqual([0, 0, 72]); // order 6 * explode 1 * 12mm, all on +Z
  });
});
