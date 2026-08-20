import { describe, expect, it } from 'vitest';
import { D4_V1 } from '@kino/hardware-profiles';
import { instanceTransforms } from '../src/scene/transforms';
import { WIRE_SAMPLES, gaugeRadiusMm, visibleNets, wireCurve } from '../src/scene/wireGeometry';

function net(id: string) {
  const n = D4_V1.nets.find((nd) => nd.id === id);
  if (!n) throw new Error(`fixture missing net "${id}"`);
  return n;
}

describe('gaugeRadiusMm', () => {
  it('maps each round gauge to its §7.13 tube radius', () => {
    expect(gaugeRadiusMm('20AWG')).toBe(0.9);
    expect(gaugeRadiusMm('24AWG')).toBe(0.55);
    expect(gaugeRadiusMm('28AWG')).toBe(0.35);
  });

  it('never renders a high-current 20AWG run thinner than a signal-gauge one (§7.14)', () => {
    expect(gaugeRadiusMm('20AWG')).toBeGreaterThan(gaugeRadiusMm('24AWG'));
    expect(gaugeRadiusMm('24AWG')).toBeGreaterThan(gaugeRadiusMm('28AWG'));
  });

  it('gives ribbon a defined (non-round-gauge) fallback radius', () => {
    expect(gaugeRadiusMm('ribbon')).toBe(0.6);
  });
});

describe('wireCurve', () => {
  it('samples exactly WIRE_SAMPLES points along the run', () => {
    const transforms = instanceTransforms(D4_V1, 22, 0);
    const curve = wireCurve(net('cam1-5v'), transforms);
    expect(curve.points).toHaveLength(WIRE_SAMPLES);
  });

  it('starts and ends exactly at the live from/to instance positions at the base pose', () => {
    const transforms = instanceTransforms(D4_V1, 22, 0);
    const n = net('cam1-5v');
    const curve = wireCurve(n, transforms);
    expect(curve.points[0]).toEqual(transforms.get(n.from.instance)?.positionMm);
    expect(curve.points[curve.points.length - 1]).toEqual(transforms.get(n.to.instance)?.positionMm);
  });

  it('tracks the live cam1 endpoint after explode moves cam1 away from its authored waypoint', () => {
    const transforms = instanceTransforms(D4_V1, 22, 1); // full explode
    const n = net('cam1-5v'); // carrier -> cam1
    const curve = wireCurve(n, transforms);
    const camPos = transforms.get('cam1')?.positionMm;
    expect(camPos).toBeDefined();
    // The authored waypointsMm end at cam1's *base* position; after explode
    // that base position is stale, so a curve that ignored live transforms
    // would end somewhere else — this asserts it ends exactly at the live one.
    expect(curve.points[curve.points.length - 1]).toEqual(camPos);
  });

  it('also tracks re-pitching (endpoint moves with camBarX, not the authored X)', () => {
    const transforms = instanceTransforms(D4_V1, 20, 0);
    const n = net('cam1-5v');
    const curve = wireCurve(n, transforms);
    expect(curve.points[curve.points.length - 1]).toEqual(transforms.get('cam1')?.positionMm);
  });

  it('reports the net gauge radius alongside the sampled points', () => {
    const transforms = instanceTransforms(D4_V1, 22, 0);
    expect(wireCurve(net('main-batt-fuse'), transforms).radiusMm).toBe(0.9); // 20AWG
    expect(wireCurve(net('cam1-5v'), transforms).radiusMm).toBe(0.55); // 24AWG
    expect(wireCurve(net('cam1-tx'), transforms).radiusMm).toBe(0.35); // 28AWG
  });

  it('throws if a net references an instance missing from the transforms map', () => {
    const transforms = instanceTransforms(D4_V1, 22, 0);
    transforms.delete('cam1');
    expect(() => wireCurve(net('cam1-5v'), transforms)).toThrow(/missing transform/);
  });
});

describe('visibleNets', () => {
  it("returns exactly cam2's UART nets when focused on cam2 with only UART enabled", () => {
    const result = visibleNets(D4_V1.nets, new Set(['UART']), 'cam2');
    expect(result.map((n) => n.id).sort()).toEqual(['cam2-rx', 'cam2-tx']);
  });

  it('drops a net whose class is toggled off even with no focus set', () => {
    const result = visibleNets(D4_V1.nets, new Set(['POWER']), null);
    expect(result.every((n) => n.cls === 'POWER')).toBe(true);
    expect(result.some((n) => n.cls === 'UART')).toBe(false);
  });

  it('with no focus, returns every net of an enabled class regardless of instance', () => {
    const result = visibleNets(D4_V1.nets, new Set(['SYNC']), null);
    expect(result.map((n) => n.id).sort()).toEqual(['cam1-sync', 'cam2-sync', 'cam3-sync', 'cam4-sync']);
  });

  it('focus with no matching nets in the enabled classes returns empty, not a fallback to unfiltered', () => {
    const result = visibleNets(D4_V1.nets, new Set(['FLASH']), 'cam2');
    expect(result).toEqual([]);
  });
});
