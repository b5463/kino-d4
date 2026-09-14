import { describe, expect, it } from 'vitest';
import { isScreenFocus, loadedAgo, screenCssSize, SCREEN_HASH } from '../src/display/screenFocus';
import { moduleHash } from '../src/display/moduleHash';

describe('SCREEN VIEW sizing and mode', () => {
  it('is entered by the #screen hash and nothing else', () => {
    expect(isScreenFocus(SCREEN_HASH)).toBe(true);
    expect(isScreenFocus('#screen?x=1')).toBe(true);
    expect(isScreenFocus('')).toBe(false);
    expect(isScreenFocus('#screenshot')).toBe(false);
  });

  it('FIT keeps 5:3 and fills the shorter side', () => {
    expect(screenCssSize(1600, 480, 'fit')).toEqual({ width: 800, height: 480, integer: false });
    expect(screenCssSize(400, 1000, 'fit')).toEqual({ width: 400, height: 240, integer: false });
  });

  it('integer scales are exact, and fall back to FIT when they would overflow', () => {
    expect(screenCssSize(2000, 1200, '1x')).toEqual({ width: 800, height: 480, integer: true });
    expect(screenCssSize(2000, 1200, '2x')).toEqual({ width: 1600, height: 960, integer: true });
    expect(screenCssSize(1000, 1000, '2x')).toEqual({ width: 1000, height: 600, integer: false });
  });

  it('ages the loaded stamp in words', () => {
    const t = 1_000_000;
    expect(loadedAgo(t, t + 4000)).toBe('4s ago');
    expect(loadedAgo(t, t + 90_000)).toBe('1m ago');
    expect(loadedAgo(t, t + 7_200_000)).toBe('2h ago');
  });
});

describe('module fingerprint', () => {
  it('changes when a byte changes and is stable otherwise', () => {
    const a = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 7]);
    const b = Uint8Array.from(a);
    b[8] = 8;
    expect(moduleHash(a)).toBe(moduleHash(Uint8Array.from(a)));
    expect(moduleHash(a)).not.toBe(moduleHash(b));
    expect(moduleHash(a)).toMatch(/^[0-9a-f]{8}$/);
    expect(moduleHash(a.buffer)).toBe(moduleHash(a));
  });
});
