import { describe, it, expect } from 'vitest';
import { parseVersioned } from '@kino/schemas';
import { D4_V1 } from '../src/index';
import { resolveDimensions } from '../src/resolve';
import { measuredOverrides, type MeasuredOverride } from '../src/overrides';

describe('resolveDimensions', () => {
  it('flags the Guition conflicting OFFICIAL_SPEC pair as CONFLICT + measureToLock, keeping both candidates (§6/§7.1)', () => {
    const disp = D4_V1.components.find((c) => c.id === 'main-display')!;
    const r = resolveDimensions(disp);
    expect(r.confidence).toBe('CONFLICT');
    expect(r.measureToLock).toBe(true);
    expect(r.conflict).toHaveLength(2);
    expect(r.conflict?.every((s) => s.kind === 'OFFICIAL_SPEC')).toBe(true);
    const officials = disp.sources.filter((s) => s.kind === 'OFFICIAL_SPEC');
    expect(r.sizeMm).toEqual(officials[0]?.sizeMm);
  });

  it('a MEASURED override on bms wins outright with the exact measured size', () => {
    const bms = D4_V1.components.find((c) => c.id === 'bms')!;
    const override: MeasuredOverride = {
      componentId: 'bms',
      sizeMm: [42, 28, 9],
      measuredAt: '2026-08-15',
    };
    const r = resolveDimensions(bms, override);
    expect(r.confidence).toBe('MEASURED');
    expect(r.sizeMm).toEqual([42, 28, 9]);
    expect(r.conflict).toBeNull();
    expect(r.measureToLock).toBe(false);
  });

  it('rejects a MeasuredOverride whose componentId does not match the component', () => {
    const bms = D4_V1.components.find((c) => c.id === 'bms')!;
    const override: MeasuredOverride = { componentId: 'fuse', sizeMm: [1, 1, 1], measuredAt: '2026-01-01' };
    expect(() => resolveDimensions(bms, override)).toThrow();
  });

  it('a single OFFICIAL_SPEC source (XIAO) resolves clean with no lock needed', () => {
    const cam = D4_V1.components.find((c) => c.id === 'camera-node')!;
    const r = resolveDimensions(cam);
    expect(r.confidence).toBe('OFFICIAL_SPEC');
    expect(r.sizeMm).toEqual([21.0, 17.8, 15.0]);
    expect(r.conflict).toBeNull();
    expect(r.measureToLock).toBe(false);
  });

  it('a PROVISIONAL proxy (battery) always demands measure-to-lock', () => {
    const battery = D4_V1.components.find((c) => c.id === 'battery')!;
    const r = resolveDimensions(battery);
    expect(r.confidence).toBe('PROVISIONAL');
    expect(r.measureToLock).toBe(true);
  });

  it('a single-tier source with an unknown axis (p4-ribbon) still demands measure-to-lock', () => {
    const ribbon = D4_V1.components.find((c) => c.id === 'p4-ribbon')!;
    const r = resolveDimensions(ribbon);
    expect(r.confidence).toBe('SELLER_SPEC');
    expect(r.measureToLock).toBe(true);
  });

  it('a fully-known SELLER_SPEC source (flash-heatsink) does not demand measure-to-lock', () => {
    const heatsink = D4_V1.components.find((c) => c.id === 'flash-heatsink')!;
    const r = resolveDimensions(heatsink);
    expect(r.confidence).toBe('SELLER_SPEC');
    expect(r.measureToLock).toBe(false);
  });
});

describe('kino.measured-overrides schema (§23)', () => {
  it('parses a versioned overrides document', () => {
    const doc = parseVersioned(measuredOverrides, {
      schema: 'kino.measured-overrides',
      version: 1,
      overrides: [{ componentId: 'bms', sizeMm: [42, 28, 9], measuredAt: '2026-08-15' }],
    });
    expect(doc.overrides).toHaveLength(1);
    expect(doc.overrides[0]?.componentId).toBe('bms');
  });

  it('preserves measured holes, protrusions and wire-exit geometry', () => {
    const doc = parseVersioned(measuredOverrides, {
      schema: 'kino.measured-overrides',
      version: 1,
      overrides: [{
        componentId: 'battery',
        sizeMm: [60, 38, 9],
        holesMm: [[3, 4], [57, 34]],
        protrusionsMm: [{ label: 'lead fold', sizeMm: [8, 3, 2], offsetMm: [30, 19, 9] }],
        wireExitMm: [60, 19, 4.5],
        measuredAt: '2026-08-20',
      }],
    });
    expect(doc.overrides[0]).toMatchObject({
      holesMm: [[3, 4], [57, 34]],
      protrusionsMm: [{ label: 'lead fold', sizeMm: [8, 3, 2], offsetMm: [30, 19, 9] }],
      wireExitMm: [60, 19, 4.5],
    });
  });

  it('rejects an override missing its required measuredAt field', () => {
    const bad = {
      schema: 'kino.measured-overrides',
      version: 1,
      overrides: [{ componentId: 'bms', sizeMm: [42, 28, 9] }],
    };
    expect(() => parseVersioned(measuredOverrides, bad)).toThrow();
  });
});
