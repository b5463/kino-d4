import { describe, expect, it } from 'vitest';
import { D4_V1, type MeasuredOverride } from '@kino/hardware-profiles';
import { parseVersioned } from '@kino/schemas';
import {
  exportBom,
  exportDimensionReport,
  exportSceneLayout,
  exportWiringReport,
  sceneLayoutDoc,
} from '../src/exports/exports';

const measuredBms: MeasuredOverride = {
  componentId: 'bms',
  sizeMm: [22, 15, 3],
  measuredAt: '2026-08-20T12:00:00.000Z',
};

describe('Twin engineering exports', () => {
  it('exports every current-profile BOM component and reflects a measured BMS', () => {
    const doc = JSON.parse(exportBom(D4_V1, [measuredBms]));
    // One row per component in the profile, whatever the profile carries — a
    // hard-coded count here just breaks on every assembly added or dropped
    // (ECN-0003 took the flash assembly out) without testing anything the
    // line above doesn't.
    expect(doc.components).toHaveLength(D4_V1.components.length);
    expect(doc.components.length).toBeGreaterThan(0);
    expect(doc.components.find((component: { id: string }) => component.id === 'bms')).toMatchObject({
      dimensionsMm: [22, 15, 3],
      confidence: 'MEASURED',
    });
  });

  it('exports a versioned scene layout that round-trips through its schema', () => {
    const text = exportSceneLayout({ profile: D4_V1, pitchMm: 22, explode: 0 });
    const parsed = parseVersioned(sceneLayoutDoc, JSON.parse(text));
    expect(parsed.profile).toBe('d4-v1');
    expect(parsed.transforms).toHaveLength(D4_V1.instances.length);
    expect(parsed.transforms.find((item) => item.id === 'cam1')?.positionMm[0]).toBe(-33);
  });

  it('marks the unresolved Guition dimensions as measure-to-lock', () => {
    const report = exportDimensionReport(D4_V1, []);
    const row = report.split('\n').find((line) => line.includes('Guition'));
    expect(row).toContain('MEASURE TO LOCK');
  });

  it('writes one wiring row per profile net', () => {
    const rows = exportWiringReport(D4_V1).trimEnd().split('\n').slice(1);
    expect(rows).toHaveLength(D4_V1.nets.length);
  });
});
