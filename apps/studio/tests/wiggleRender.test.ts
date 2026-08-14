import { describe, expect, it } from 'vitest';
import { computeOverlapCrop, hasAnyOffset } from '../src/utils/wiggleRender';

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
