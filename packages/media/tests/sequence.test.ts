import { describe, expect, it } from 'vitest';
import {
  clampWiggleFps,
  LOOP_MODES,
  wiggleSequence,
  WIGGLE_FPS_DEFAULT,
  WIGGLE_FPS_MAX,
  WIGGLE_FPS_MIN,
  type LoopMode,
} from '../src/sequence';

/**
 * The playback order, which three programs have to agree on: the worker renders
 * it into a WebP and an MP4, Roll web's player steps through it, and Studio
 * previews it before a shot is even taken. So the assertions here are the
 * contract — the spec's `1 → 2 → 3 → 4 → 3 → 2` (01 §8, 03 §13) written out
 * zero-indexed, plus the properties that have to hold at frame counts the D4
 * does not have.
 */

describe('wiggleSequence', () => {
  it('bounces 4 frames as the 01 §8 default order', () => {
    expect(wiggleSequence(4, 'bounce', 'ltr')).toEqual([0, 1, 2, 3, 2, 1]);
  });

  it('sweeps 4 frames straight through', () => {
    expect(wiggleSequence(4, 'sweep', 'ltr')).toEqual([0, 1, 2, 3]);
  });

  it('gives `once` the same order as `sweep` — the difference is repetition, not order', () => {
    for (const frameCount of [2, 3, 4, 7]) {
      expect(wiggleSequence(frameCount, 'once', 'ltr')).toEqual(
        wiggleSequence(frameCount, 'sweep', 'ltr'),
      );
      expect(wiggleSequence(frameCount, 'once', 'rtl')).toEqual(
        wiggleSequence(frameCount, 'sweep', 'rtl'),
      );
    }
  });

  it('mirrors every mode for rtl', () => {
    expect(wiggleSequence(4, 'bounce', 'rtl')).toEqual([3, 2, 1, 0, 1, 2]);
    expect(wiggleSequence(4, 'sweep', 'rtl')).toEqual([3, 2, 1, 0]);
    expect(wiggleSequence(4, 'once', 'rtl')).toEqual([3, 2, 1, 0]);
  });

  it('bounces 2 frames as just the two — a 2-frame bounce has no interior', () => {
    expect(wiggleSequence(2, 'bounce', 'ltr')).toEqual([0, 1]);
    expect(wiggleSequence(2, 'bounce', 'rtl')).toEqual([1, 0]);
  });

  it('bounces 5 frames', () => {
    expect(wiggleSequence(5, 'bounce', 'ltr')).toEqual([0, 1, 2, 3, 4, 3, 2, 1]);
  });

  it('bounces 3 frames', () => {
    expect(wiggleSequence(3, 'bounce', 'ltr')).toEqual([0, 1, 2, 1]);
  });

  it('is not hard-coded to four frames', () => {
    const frameCount = 32;
    const bounce = wiggleSequence(frameCount, 'bounce', 'ltr');

    expect(bounce).toHaveLength(2 * frameCount - 2);
    expect(bounce.slice(0, frameCount)).toEqual([...Array(frameCount).keys()]);
    expect(bounce.at(-1)).toBe(1);
    expect(wiggleSequence(frameCount, 'sweep', 'ltr')).toHaveLength(frameCount);
  });

  it('yields a single frame for a 1-frame capture in every mode', () => {
    for (const loop of LOOP_MODES) {
      expect(wiggleSequence(1, loop, 'ltr')).toEqual([0]);
      expect(wiggleSequence(1, loop, 'rtl')).toEqual([0]);
    }
  });

  it('refuses a frame count that is not a whole number of frames', () => {
    expect(() => wiggleSequence(0, 'bounce', 'ltr')).toThrow(/frame/i);
    expect(() => wiggleSequence(-2, 'bounce', 'ltr')).toThrow(/frame/i);
    expect(() => wiggleSequence(2.5, 'bounce', 'ltr')).toThrow(/frame/i);
  });

  it('refuses a loop mode it does not know', () => {
    expect(() => wiggleSequence(4, 'wobble' as LoopMode, 'ltr')).toThrow(/loop mode/i);
  });

  it('stays inside the frames it was given, in every mode and both directions', () => {
    for (const frameCount of [1, 2, 3, 4, 5, 9, 40]) {
      for (const loop of LOOP_MODES) {
        for (const direction of ['ltr', 'rtl'] as const) {
          const order = wiggleSequence(frameCount, loop, direction);
          expect(order.length).toBeGreaterThan(0);
          for (const index of order) {
            expect(Number.isInteger(index)).toBe(true);
            expect(index).toBeGreaterThanOrEqual(0);
            expect(index).toBeLessThan(frameCount);
          }
          // Every frame is shown at least once, whatever the mode.
          expect(new Set(order).size).toBe(frameCount);
        }
      }
    }
  });

  it('steps one frame at a time, including across a bounce loop boundary', () => {
    for (const frameCount of [2, 3, 4, 5, 12]) {
      for (const direction of ['ltr', 'rtl'] as const) {
        const order = wiggleSequence(frameCount, 'bounce', direction);
        for (let at = 0; at < order.length; at += 1) {
          const here = order[at] ?? -1;
          const next = order[(at + 1) % order.length] ?? -1;
          expect(Math.abs(next - here)).toBe(1);
        }
      }
    }
  });

  it('returns a fresh array the caller can mutate', () => {
    const first = wiggleSequence(4, 'bounce', 'ltr');
    first[0] = 99;
    expect(wiggleSequence(4, 'bounce', 'ltr')).toEqual([0, 1, 2, 3, 2, 1]);
  });
});

describe('clampWiggleFps', () => {
  it('keeps the 02 §9 range and falls back to the default', () => {
    expect(WIGGLE_FPS_MIN).toBe(5);
    expect(WIGGLE_FPS_MAX).toBe(15);
    expect(WIGGLE_FPS_DEFAULT).toBe(10);

    expect(clampWiggleFps(undefined)).toBe(10);
    expect(clampWiggleFps(null)).toBe(10);
    expect(clampWiggleFps(Number.NaN)).toBe(10);
    expect(clampWiggleFps(12)).toBe(12);
    expect(clampWiggleFps(1)).toBe(5);
    expect(clampWiggleFps(60)).toBe(15);
    expect(clampWiggleFps(9.6)).toBe(10);
  });
});
