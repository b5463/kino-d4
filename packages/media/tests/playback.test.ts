import { describe, expect, it } from 'vitest';
import { kdpLoopToMediaLoop } from '../src/playback';

describe('kdpLoopToMediaLoop', () => {
  it('pins the two colliding words to their KDP meanings', () => {
    // KDP 'continuous' = repeating one-way pass = media 'sweep'.
    expect(kdpLoopToMediaLoop('continuous')).toBe('sweep');
    // KDP 'sweep' = 02 §9's "one sweep" = media 'once'.
    expect(kdpLoopToMediaLoop('sweep')).toBe('once');
  });

  it('keeps bounce and accepts an already-mapped once', () => {
    expect(kdpLoopToMediaLoop('bounce')).toBe('bounce');
    expect(kdpLoopToMediaLoop('once')).toBe('once');
  });

  it('defaults anything unrecognised to bounce', () => {
    expect(kdpLoopToMediaLoop(undefined)).toBe('bounce');
    expect(kdpLoopToMediaLoop(null)).toBe('bounce');
    expect(kdpLoopToMediaLoop('boomerang')).toBe('bounce');
    expect(kdpLoopToMediaLoop(3)).toBe('bounce');
  });
});
