import { describe, expect, it } from 'vitest';
import { D4_V1 } from '@kino/hardware-profiles';
import type { ComponentDef, HardwareProfile, InstanceDef, KeepoutDef, NetDef } from '@kino/hardware-profiles';
import { collisionReport } from '../src/collision/collide';

function component(id: string, sizeMm: [number, number, number], keepouts: KeepoutDef[] = []): ComponentDef {
  return {
    id,
    name: id,
    qty: 1,
    meshTier: 'C',
    sources: [{ kind: 'MEASURED', sizeMm }],
    keepouts,
  };
}

function instance(id: string, componentId: string, positionMm: [number, number, number]): InstanceDef {
  return {
    id,
    component: componentId,
    positionMm,
    rotationDeg: [0, 0, 0],
    group: 'body',
    explodeOrder: 0,
    explodeDirMm: [0, 0, 1],
  };
}

function fixture(components: ComponentDef[], instances: InstanceDef[], nets: NetDef[] = []): HardwareProfile {
  return {
    ...D4_V1,
    profile: 'COLLISION_TEST',
    name: 'Collision test fixture',
    body: { sizeMm: [100, 100, 100], confidence: 'MEASURED' },
    components,
    instances,
    nets,
  };
}

describe('collisionReport', () => {
  it('reports hard components separated by only 0.3 mm', () => {
    const profile = fixture(
      [component('box-a', [10, 10, 10]), component('box-b', [10, 10, 10])],
      [instance('a', 'box-a', [0, 0, 0]), instance('b', 'box-b', [10.3, 0, 0])],
    );

    expect(collisionReport(profile, [], 22)).toContainEqual({
      kind: 'HARD_CLEARANCE_UNDER_0_5',
      a: 'a',
      b: 'b',
      distanceMm: 0.3,
    });
  });

  it('reports overlapping hard components as a collision', () => {
    const profile = fixture(
      [component('box-a', [10, 10, 10]), component('box-b', [10, 10, 10])],
      [instance('a', 'box-a', [0, 0, 0]), instance('b', 'box-b', [9, 0, 0])],
    );

    expect(collisionReport(profile, [], 22)).toContainEqual({ kind: 'COLLISION', a: 'a', b: 'b', distanceMm: 0 });
  });

  it('reports a sampled wire path only 0.6 mm from a foreign component', () => {
    const net: NetDef = {
      id: 'signal-wire',
      cls: 'UART',
      from: { instance: 'source', pin: 'TX' },
      to: { instance: 'target', pin: 'RX' },
      gauge: '28AWG',
      color: 'yellow',
      waypointsMm: [
        [-10, 0, 0],
        [0, 0, 0],
        [10, 0, 0],
      ],
    };
    const profile = fixture(
      [component('endpoint', [1, 1, 1]), component('obstacle', [1, 1, 1])],
      [
        instance('source', 'endpoint', [-10, 0, 0]),
        instance('target', 'endpoint', [10, 0, 0]),
        instance('blocker', 'obstacle', [0, 1.1, 0]),
      ],
      [net],
    );

    expect(collisionReport(profile, [], 22)).toContainEqual({
      kind: 'CABLE_CLEARANCE_UNDER_1_0',
      a: 'signal-wire',
      b: 'blocker',
      distanceMm: 0.6,
    });
  });

  it('reports a foreign component intersecting a USB insertion keepout', () => {
    const usbKeepout: KeepoutDef = {
      id: 'usb-access',
      label: 'USB insertion access',
      sizeMm: [4, 4, 4],
      offsetMm: [10, 0, 0],
      kind: 'insertion',
    };
    const profile = fixture(
      [component('display', [2, 2, 2], [usbKeepout]), component('blocker', [2, 2, 2])],
      [instance('main-display', 'display', [0, 0, 0]), instance('foreign-box', 'blocker', [10, 0, 0])],
    );

    expect(collisionReport(profile, [], 22)).toContainEqual({
      kind: 'USB_ACCESS_BLOCKED',
      a: 'main-display',
      b: 'foreign-box',
      distanceMm: 0,
    });
  });

  it('distinguishes a blocked microSD ejection keepout', () => {
    const sdKeepout: KeepoutDef = {
      id: 'sd-eject',
      label: 'microSD ejection travel',
      sizeMm: [5, 3, 3],
      offsetMm: [8, 0, 0],
      kind: 'ejection',
    };
    const profile = fixture(
      [component('carrier', [2, 2, 2], [sdKeepout]), component('blocker', [2, 2, 2])],
      [instance('main-carrier', 'carrier', [0, 0, 0]), instance('sd-blocker', 'blocker', [8, 0, 0])],
    );

    expect(collisionReport(profile, [], 22)).toContainEqual({
      kind: 'SD_EJECT_BLOCKED',
      a: 'main-carrier',
      b: 'sd-blocker',
      distanceMm: 0,
    });
  });

  it('uses measured overrides instead of provisional component dimensions', () => {
    const profile = fixture(
      [component('box-a', [2, 2, 2]), component('box-b', [2, 2, 2])],
      [instance('a', 'box-a', [0, 0, 0]), instance('b', 'box-b', [2.5, 0, 0])],
    );
    expect(collisionReport(profile, [], 22).some((finding) => finding.kind === 'COLLISION')).toBe(false);

    const findings = collisionReport(
      profile,
      [{ componentId: 'box-a', sizeMm: [4, 2, 2], measuredAt: '2026-08-20T00:00:00.000Z' }],
      22,
    );
    expect(findings).toContainEqual({ kind: 'COLLISION', a: 'a', b: 'b', distanceMm: 0 });
  });

  it('runs against D4_V1 and names only profile instances or nets', () => {
    const knownIds = new Set([...D4_V1.instances.map((item) => item.id), ...D4_V1.nets.map((net) => net.id)]);
    const findings = collisionReport(D4_V1, [], 22);

    for (const finding of findings) {
      expect(knownIds.has(finding.a), `${finding.kind} has unknown id ${finding.a}`).toBe(true);
      expect(knownIds.has(finding.b), `${finding.kind} has unknown id ${finding.b}`).toBe(true);
      expect(Number.isFinite(finding.distanceMm)).toBe(true);
    }
  });
});
