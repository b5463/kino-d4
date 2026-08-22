import { describe, expect, it } from 'vitest';
import { alignmentPlan, computeOverlapCrop, hasAnyOffset, SENSOR_BASE_W } from '../src/alignment';

// Ported from apps/studio/tests/wiggleRender.test.ts when the math moved here
// (audit #59): the numbers must not change in the move, because Studio's
// preview was already showing them to people.
describe('overlap crop', () => {
  it('detects when there is nothing to correct', () => {
    expect(hasAnyOffset([{ x: 0, y: 0, rot: 0 }, { x: 0, y: 0, rot: 0 }])).toBe(false);
    expect(hasAnyOffset([{ x: 0, y: 0, rot: 0 }, { x: 2, y: 0, rot: 0 }])).toBe(true);
  });

  it('insets by the largest offset on each axis', () => {
    const crop = computeOverlapCrop(800, 600, [
      { x: 0, y: 0, rot: 0 },
      { x: -6, y: 3, rot: 0 },
      { x: 4, y: -2, rot: 0 },
      { x: 0, y: 0, rot: 0 },
    ], 0.5); // 800px render of a 1600px sensor frame
    // x: max |6| sensor px → 3 render px, +2 pad → inset 5 → 790
    // y: max |3| sensor px → 1.5 render px, +2 pad → inset 4 → 592
    expect(crop.w).toBe(790);
    expect(crop.h).toBe(592);
    expect(crop.x).toBe(5);
    expect(crop.y).toBe(4);
  });

  it('adds slack for rotation and keeps even dimensions', () => {
    const crop = computeOverlapCrop(800, 600, [
      { x: 0, y: 0, rot: 0 },
      { x: 0, y: 0, rot: 1.5 },
      { x: 0, y: 0, rot: 0 },
      { x: 0, y: 0, rot: 0 },
    ], 0.5);
    expect(crop.w).toBeLessThan(790); // rotation costs more than a 2px pad
    expect(crop.w % 2).toBe(0);
    expect(crop.h % 2).toBe(0);
  });

  it('never collapses below a usable size for absurd offsets', () => {
    const crop = computeOverlapCrop(800, 600, [
      { x: 0, y: 0, rot: 0 },
      { x: 5000, y: 5000, rot: 45 },
      { x: 0, y: 0, rot: 0 },
      { x: 0, y: 0, rot: 0 },
    ], 1);
    expect(crop.w).toBeGreaterThanOrEqual(16);
    expect(crop.h).toBeGreaterThanOrEqual(16);
  });
});

describe('alignmentPlan', () => {
  it('scales sensor-base offsets to the source resolution and keeps rotation', () => {
    const offsets = [
      { x: 0, y: 0, rot: 0 },
      { x: -6, y: 3, rot: 1.5 },
      { x: 4, y: -2, rot: 0 },
      { x: 0, y: 0, rot: 0 },
    ];
    const plan = alignmentPlan(800, 600, offsets);

    expect(plan.perFrame).toHaveLength(4);
    expect(plan.perFrame[0]).toEqual({ dx: 0, dy: 0, rotDeg: 0 });
    expect(plan.perFrame[1]).toEqual({ dx: -3, dy: 1.5, rotDeg: 1.5 });
    expect(plan.perFrame[2]).toEqual({ dx: 2, dy: -1, rotDeg: 0 });

    // Same crop the standalone function computes at this scale.
    expect(plan.crop).toEqual(computeOverlapCrop(800, 600, offsets, 800 / SENSOR_BASE_W));
  });

  it('passes offsets through 1:1 at the sensor base width', () => {
    const plan = alignmentPlan(SENSOR_BASE_W, 1200, [
      { x: 0, y: 0, rot: 0 },
      { x: 7, y: -4, rot: -0.5 },
    ]);
    expect(plan.perFrame[1]).toEqual({ dx: 7, dy: -4, rotDeg: -0.5 });
  });
});
