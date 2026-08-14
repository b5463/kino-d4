import { describe, expect, it } from 'vitest';
import { diffConfigs } from '../src/utils/diffConfig';

describe('config diff', () => {
  it('reports changed leaf paths only', () => {
    const now = { wiggle: { fps: 10, flash: true }, mode: 'wiggle' };
    const after = { wiggle: { fps: 12, flash: true }, mode: 'quad' };
    const diffs = diffConfigs(now, after);
    expect(diffs).toEqual([
      { path: 'mode', from: 'wiggle', to: 'quad' },
      { path: 'wiggle.fps', from: '10', to: '12' },
    ]);
  });

  it('handles added and removed keys', () => {
    const diffs = diffConfigs({ a: 1 }, { b: 2 });
    expect(diffs).toEqual([
      { path: 'a', from: '1', to: '—' },
      { path: 'b', from: '—', to: '2' },
    ]);
  });

  it('treats arrays as single values', () => {
    const diffs = diffConfigs({ spacing: [0, 19, 38, 57] }, { spacing: [0, 19.5, 38, 57] });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toBe('spacing');
  });

  it('returns nothing for identical objects', () => {
    const cfg = { deep: { nested: { value: 'x' } } };
    expect(diffConfigs(cfg, structuredClone(cfg))).toHaveLength(0);
  });
});
