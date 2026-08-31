import { describe, expect, it } from 'vitest';
import { D4_V1, resolveDimensions } from '@kino/hardware-profiles';
import type { ComponentDef } from '@kino/hardware-profiles';
import { formatDims, connectedInstanceIds, formatNetLine, fovLabel, massLabel, materialLabel } from '../src/panels/Inspector';
import { confidenceLabel, conflictSourceLines, formatSizeMm } from '../src/panels/ConfidenceBadge';
import { groupedInstances } from '../src/panels/ComponentTree';

function component(id: string) {
  const c = D4_V1.components.find((cd) => cd.id === id);
  if (!c) throw new Error(`fixture missing component "${id}"`);
  return c;
}

/**
 * A minimal `ComponentDef` fixture — only `specs` varies between tests
 * below, everything else is filler `fovLabel` never reads.
 */
function fixtureComponent(specs: Record<string, unknown> | undefined): ComponentDef {
  return {
    id: 'fixture',
    name: 'Fixture component',
    qty: 1,
    meshTier: 'A',
    sources: [{ kind: 'OFFICIAL_SPEC', sizeMm: [1, 1, 1] }],
    keepouts: [],
    specs,
  };
}

describe('formatDims', () => {
  it('renders every known axis to one decimal, with the mm unit (camera-node, §8)', () => {
    const resolved = resolveDimensions(component('camera-node'));
    expect(formatDims(resolved)).toBe('21.0 × 17.8 × 15.0 mm');
  });

  it('renders unknown axes as "?" — never a guessed number (fuse: all axes null)', () => {
    const resolved = resolveDimensions(component('fuse'));
    expect(resolved.sizeMm).toEqual([null, null, null]);
    expect(formatDims(resolved)).toBe('? × ? × ? mm');
  });

  it('mixes known and unknown axes in one string (speaker: z unmeasured)', () => {
    const resolved = resolveDimensions(component('speaker'));
    expect(formatDims(resolved)).toBe('35.0 × 25.0 × ? mm');
  });
});

describe('connectedInstanceIds', () => {
  it("cam2's connected instances are carrier (power) and display (UART/sync) — not speaker", () => {
    const connected = connectedInstanceIds(D4_V1, 'cam2');
    expect(connected).toContain('carrier');
    expect(connected).toContain('display');
    expect(connected).not.toContain('speaker');
  });

  it('returns no duplicates even though multiple nets share the same other endpoint', () => {
    const connected = connectedInstanceIds(D4_V1, 'cam2');
    // cam2 has two nets to carrier (5V, GND) and three to display (tx/rx/sync);
    // each endpoint must appear exactly once.
    expect(connected.filter((id) => id === 'carrier')).toHaveLength(1);
    expect(connected.filter((id) => id === 'display')).toHaveLength(1);
  });

  it('returns an empty list for an instance with no nets', () => {
    // The enclosure shell panels carry no wiring.
    expect(connectedInstanceIds(D4_V1, 'skeleton')).toEqual([]);
  });
});

describe('formatNetLine', () => {
  it('renders an outgoing net (this instance is the "from" side) with a forward arrow', () => {
    const net = D4_V1.nets.find((n) => n.id === 'main-batt-fuse');
    if (!net) throw new Error('fixture missing net "main-batt-fuse"');
    expect(formatNetLine(net, 'battery')).toBe('POWER BAT+ → fuse');
  });

  it('renders an incoming net (this instance is the "to" side) with a reverse arrow', () => {
    const net = D4_V1.nets.find((n) => n.id === 'main-batt-fuse');
    if (!net) throw new Error('fixture missing net "main-batt-fuse"');
    expect(formatNetLine(net, 'fuse')).toBe('POWER IN ← battery');
  });
});

describe('confidenceLabel — provenance badge text (§6)', () => {
  it('shows the plain source kind for a non-conflicting resolution (battery: PROVISIONAL)', () => {
    const resolved = resolveDimensions(component('battery'));
    expect(resolved.confidence).toBe('PROVISIONAL');
    expect(confidenceLabel(resolved)).toBe('PROVISIONAL');
  });

  it('shows MEASURE TO LOCK only when sources actually conflict (main-display)', () => {
    const resolved = resolveDimensions(component('main-display'));
    expect(resolved.confidence).toBe('CONFLICT');
    expect(resolved.measureToLock).toBe(true);
    expect(confidenceLabel(resolved)).toBe('MEASURE TO LOCK');
  });

  it('shows the plain source kind for a clean single-source resolution (camera-node: OFFICIAL_SPEC)', () => {
    const resolved = resolveDimensions(component('camera-node'));
    expect(confidenceLabel(resolved)).toBe('OFFICIAL_SPEC');
  });
});

describe('conflictSourceLines — both disagreeing values stay visible (§6)', () => {
  it('lists both main-display sources with their distinguishing ref/note', () => {
    const resolved = resolveDimensions(component('main-display'));
    const lines = conflictSourceLines(resolved);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('OFFICIAL_SPEC');
    expect(lines[0]).toContain('117.0'); // 117.01 rounds to one decimal
    expect(lines[1]).toContain('114.4');
  });

  it('is empty outside the CONFLICT case', () => {
    const resolved = resolveDimensions(component('battery'));
    expect(conflictSourceLines(resolved)).toEqual([]);
  });
});

describe('formatSizeMm', () => {
  it('formats a fully-known tuple to one decimal per axis', () => {
    expect(formatSizeMm([21, 17.8, 15])).toBe('21.0 × 17.8 × 15.0');
  });

  it('renders a null axis as "?"', () => {
    expect(formatSizeMm([null, 55, 73])).toBe('? × 55.0 × 73.0');
  });
});

describe('groupedInstances', () => {
  it('groups D4_V1 instances into CAMERA BAR / BODY / POWER / SHELL, in that order', () => {
    const groups = groupedInstances(D4_V1);
    expect(groups.map((g) => g.label)).toEqual(['CAMERA BAR', 'BODY', 'POWER', 'SHELL']);
  });

  it('puts every camera in the CAMERA BAR group', () => {
    const groups = groupedInstances(D4_V1);
    const camBar = groups.find((g) => g.label === 'CAMERA BAR');
    expect(camBar?.instances.map((i) => i.id)).toEqual(['cam1', 'cam2', 'cam3', 'cam4']);
  });

  it('drops groups the profile has no instances for', () => {
    const partial = { instances: D4_V1.instances.filter((i) => i.group === 'body') } as typeof D4_V1;
    const groups = groupedInstances(partial);
    expect(groups.map((g) => g.label)).toEqual(['BODY']);
  });
});

describe('materialLabel/massLabel — recorded claims only (audit #63)', () => {
  it('renders the recorded battery mass with its ESTIMATED tag', () => {
    expect(massLabel(component('battery'))).toEqual({ text: '55 g', tag: 'ESTIMATED' });
  });

  /* This used to read the flash heatsink's copper/SELLER claim. ECN-0003 took
   * the flash assembly off D4 V1, and no component left in the profile
   * carries a SELLER material — so the tag pass-through is asserted against a
   * fixture instead of a part that may come and go. */
  it('passes a recorded material claim through with its own tag, whatever the tag is', () => {
    const seller: ComponentDef = { ...fixtureComponent(undefined), material: { value: 'copper', tag: 'SELLER' } };
    expect(materialLabel(seller)).toEqual({ text: 'copper', tag: 'SELLER' });
  });

  it('renders the split enclosure component materials with ESTIMATED tags', () => {
    expect(materialLabel(component('enclosure-shell'))?.tag).toBe('ESTIMATED');
    expect(materialLabel(component('enclosure-chassis'))?.text).toContain('PETG');
  });

  it('returns null (renders "not recorded") when the profile carries no claim — never a guess', () => {
    expect(massLabel(component('camera-node'))).toBeNull();
    expect(materialLabel(component('camera-node'))).toBeNull();
  });
});

describe('fovLabel — never a hard-coded OV3660 FOV (§7.3, §9)', () => {
  it('shows MEASURE REQUIRED for the real camera-node specs (both axes null, fovConfidence MEASURE_REQUIRED)', () => {
    const camera = component('camera-node');
    expect(camera.specs?.['horizontalFovDeg']).toBeNull();
    expect(camera.specs?.['verticalFovDeg']).toBeNull();
    expect(fovLabel(camera)).toBe('MEASURE REQUIRED');
  });

  it('formats a real numeric measurement when both axes are known', () => {
    const measured = fixtureComponent({ horizontalFovDeg: 68.5, verticalFovDeg: 51.2, fovConfidence: 'MEASURED' });
    expect(fovLabel(measured)).toBe('68.5° × 51.2°');
  });

  it('never prints a partial or invented number when only one axis is populated', () => {
    const oneAxis = fixtureComponent({ horizontalFovDeg: 68.5, verticalFovDeg: null, fovConfidence: 'PROVISIONAL' });
    const label = fovLabel(oneAxis);
    expect(label).not.toMatch(/68\.5/);
    expect(label).not.toMatch(/^\d/);
  });

  it('falls back to MEASURE REQUIRED when FOV fields exist but the confidence tag is missing/unrecognized', () => {
    const noConfidence = fixtureComponent({ horizontalFovDeg: null, verticalFovDeg: null });
    expect(fovLabel(noConfidence)).toBe('UNKNOWN');
  });

  it('returns null (no FOV row at all) for a component with no FOV fields, e.g. the battery', () => {
    expect(fovLabel(component('battery'))).toBeNull();
  });
});
