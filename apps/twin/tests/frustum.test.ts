import { describe, expect, it } from 'vitest';
import { D4_V1 } from '@kino/hardware-profiles';
import type { HardwareProfile } from '@kino/hardware-profiles';
import { commonWidthMm, fovForCam, frustumCorners, opticsDistancesM, pairOverlapPct } from '../src/optics/frustum';

describe('fovForCam', () => {
  it('does not invent a FOV for the current D4 camera module', () => {
    expect(fovForCam(D4_V1, null)).toEqual({ source: 'MEASURE_REQUIRED' });
  });

  it('derives vertical FOV from the 2048×1536 sensor aspect for a labelled scenario', () => {
    const fov = fovForCam(D4_V1, 90);
    expect(fov).toMatchObject({ hDeg: 90, source: 'SCENARIO' });
    if ('vDeg' in fov) expect(fov.vDeg).toBeCloseTo(73.7398, 4);
  });

  it('uses numeric profile optics only as measured hardware data', () => {
    const profile = structuredClone(D4_V1) as HardwareProfile;
    const camera = profile.components.find((component) => component.id === 'camera-node');
    if (!camera) throw new Error('camera-node fixture missing');
    camera.specs = { ...camera.specs, horizontalFovDeg: 78, verticalFovDeg: 62 };
    expect(fovForCam(profile, null)).toEqual({ hDeg: 78, vDeg: 62, source: 'MEASURED' });
  });
});

describe('frustum geometry', () => {
  it('builds an axis-aligned +Z plane from horizontal and vertical half angles', () => {
    expect(frustumCorners([1, 2, 3], 90, 90, 1_000)).toEqual([
      [-999, 1002, 1003],
      [1001, 1002, 1003],
      [1001, -998, 1003],
      [-999, -998, 1003],
    ]);
  });

  it('reports pair and four-camera overlap at the 90° / 1 m / 22 mm benchmark', () => {
    expect(pairOverlapPct(22, 90, 1_000)).toBeCloseTo(98.9, 6);
    expect(commonWidthMm(22, 90, 1_000)).toBeCloseTo(1_934, 6);
  });

  it('never reports negative overlap for a narrow, near-distance scenario', () => {
    expect(commonWidthMm(500, 60, 300)).toBe(0);
    expect(pairOverlapPct(500, 60, 300)).toBe(0);
  });

  it('sorts, deduplicates and validates enabled distance planes', () => {
    expect(opticsDistancesM([3, 1, 1, -2], 2)).toEqual([1, 2, 3]);
  });
});
