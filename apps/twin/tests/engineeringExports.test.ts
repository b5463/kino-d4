// Fabrication exports (issue #31): the files must round-trip against
// measured overrides and the live pitch — the same resolved geometry the
// scene renders, never the canonical guess behind a measured label.
import { describe, expect, it } from 'vitest';
import { D4_V1 } from '@kino/hardware-profiles';
import type { MeasuredOverride } from '@kino/hardware-profiles';
import {
  exportEnvelopeStep,
  exportFrontPanelDxf,
  exportTransformsCsv,
  lensCenters,
  LENS_CUTOUT_DIAMETER_MM,
} from '../src/exports/engineering';

const override = (componentId: string, sizeMm: [number, number, number]): MeasuredOverride => ({
  componentId,
  sizeMm,
  measuredAt: '2026-08-22T00:00:00.000Z',
});

describe('front panel DXF', () => {
  it('carries the outline and one lens cutout per camera at the live pitch', () => {
    const dxf = exportFrontPanelDxf(D4_V1, [], 22);
    expect(dxf).toContain('ENTITIES');
    expect(dxf.match(/\nCIRCLE\n/g)).toHaveLength(4);
    expect(dxf.match(/\nLINE\n/g)).toHaveLength(4);
    // Pitch 22 → cam centers at ±11 and ±33 on x.
    for (const x of [-33, -11, 11, 33]) expect(dxf).toContain(`10\n${x}\n`);
    // The guessed number names itself inside the file.
    expect(dxf).toContain(`${LENS_CUTOUT_DIAMETER_MM} mm is PROVISIONAL`);
  });

  it('cutout positions follow the pitch', () => {
    const centers = lensCenters(D4_V1, 20).map((c) => c.x);
    expect(centers).toEqual([-30, -10, 10, 30]);
    expect(exportFrontPanelDxf(D4_V1, [], 20)).toContain('10\n-30\n');
  });

  it('a measured shell override changes the outline', () => {
    const dxf = exportFrontPanelDxf(D4_V1, [override('enclosure-shell', [130, 84, 3])], 22);
    expect(dxf).toContain('10\n-65\n');
    expect(dxf).toContain('outline 130x84 mm (MEASURED)');
  });
});

describe('transforms CSV', () => {
  it('one row per instance with resolved dimensions and confidence', () => {
    const csv = exportTransformsCsv(D4_V1, [], 22);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('id,component,x_mm,y_mm,z_mm,rx_deg,ry_deg,rz_deg,w_mm,h_mm,d_mm,confidence');
    expect(lines).toHaveLength(1 + D4_V1.instances.length);
    expect(csv).toContain('cam1,camera-node,-33,10,7,');
    expect(csv).toMatch(/battery,.*ESTIMATED|battery,.*PROVISIONAL/);
  });

  it('a measured override lands in the row', () => {
    const csv = exportTransformsCsv(D4_V1, [override('battery', [72.4, 54.8, 5.2])], 22);
    expect(csv).toContain('72.4,54.8,5.2,MEASURED');
  });
});

describe('envelope STEP', () => {
  it('is a structurally complete AP214 box carrying the resolved envelope', () => {
    const step = exportEnvelopeStep(D4_V1, []);
    expect(step.startsWith('ISO-10303-21;')).toBe(true);
    expect(step.trim().endsWith('END-ISO-10303-21;')).toBe(true);
    expect(step).toContain('MANIFOLD_SOLID_BREP');
    expect(step.match(/ADVANCED_FACE/g)).toHaveLength(6);
    expect(step.match(/EDGE_CURVE/g)).toHaveLength(12);
    expect(step.match(/VERTEX_POINT/g)).toHaveLength(8);
    expect(step).toContain('CLOSED_SHELL');
    expect(step).toContain('SHAPE_DEFINITION_REPRESENTATION');
    // 126×80×36 envelope → half extents in the corner coordinates.
    expect(step).toContain("CARTESIAN_POINT('',(-63,-40,-18))");
    expect(step).toContain("CARTESIAN_POINT('',(63,40,18))");
    expect(step).toContain('envelope only, internal geometry not modeled');
  });

  it('a measured shell override moves the corners', () => {
    const step = exportEnvelopeStep(D4_V1, [override('enclosure-shell', [130, 84, 38])]);
    expect(step).toContain("CARTESIAN_POINT('',(-65,-42,-19))");
    expect(step).toContain('130x84x38 mm (MEASURED)');
  });
});
