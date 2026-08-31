import { describe, it, expect } from 'vitest';
import { D4_V1, hardwareProfile } from '../src/index';
import { parseVersioned } from '@kino/schemas';

describe('kino.hardware-profile d4-v1', () => {
  it('ships a valid versioned document', () => {
    expect(D4_V1.profile).toBe('d4-v1');
    expect(D4_V1.units).toBe('mm');
  });
  it('stores BOTH Guition envelopes as separate sources (§6/§7.1)', () => {
    const disp = D4_V1.components.find((c) => c.id === 'main-display')!;
    const officials = disp.sources.filter((s) => s.kind === 'OFFICIAL_SPEC');
    expect(officials.map((s) => s.sizeMm[0]).sort()).toEqual([114.4, 117.01]);
  });
  it('never hard-codes an OV3660 FOV (§7.3)', () => {
    const cam = D4_V1.components.find((c) => c.id === 'camera-node')!;
    expect(cam.specs?.horizontalFovDeg).toBeNull();
    expect(cam.specs?.fovConfidence).toBe('MEASURE_REQUIRED');
  });
  it('camera instances sit on the bar at 22 mm pitch defaults (§5)', () => {
    const xs = ['cam1', 'cam2', 'cam3', 'cam4'].map(
      (id) => D4_V1.instances.find((i) => i.id === id)!.positionMm[0],
    );
    expect(xs).toEqual([-33, -11, 11, 33]);
    expect(D4_V1.cameraPitchMm).toBe(22);
    expect(D4_V1.cameraPitchRangeMm).toEqual([20, 24]);
  });
  it('camera nodes explode as one group, not colliding with the rear-anchored pieces (§8)', () => {
    const orders = ['cam1', 'cam2', 'cam3', 'cam4'].map(
      (id) => D4_V1.instances.find((i) => i.id === id)!.explodeOrder,
    );
    expect(orders).toEqual([6, 6, 6, 6]);
  });
  it('battery power limits match seller data (§7.4)', () => {
    const b = D4_V1.power.battery;
    expect(b.safeContinuousA).toBe(3);
    expect(b.shortPulseMaxA).toBe(6);
    expect(b.chargePreferredA).toBe(0.6);
    expect(b.chargeMaxA).toBe(1.5);
  });
  it('rejects an unknown source kind', () => {
    const doc = JSON.parse(JSON.stringify({ ...D4_V1 }));
    doc.components[0].sources[0].kind = 'GUESSED';
    expect(() => parseVersioned(hardwareProfile, doc)).toThrow();
  });
  it('records mass/material only where a source exists; unweighed parts omit them (audit #63)', () => {
    const battery = D4_V1.components.find((c) => c.id === 'battery')!;
    expect(battery.massG).toEqual({ value: 55, tag: 'ESTIMATED' });
    // Was flash-heatsink's SELLER-tagged copper; ECN-0003 removed the whole
    // built-in flash assembly, and no part left on the body carries a
    // seller-stated material. The point of the assertion is the tag, not the
    // tier: a material recorded here is always attributed.
    const shell = D4_V1.components.find((c) => c.id === 'enclosure-shell')!;
    expect(shell.material?.tag).toBe('ESTIMATED');
    // Seeed wiki states no weight for the XIAO ESP32-S3 Sense — so no massG.
    const cam = D4_V1.components.find((c) => c.id === 'camera-node')!;
    expect(cam.massG).toBeUndefined();
  });
  it('splits the enclosure into shell + chassis on the same PROVISIONAL envelope (audit #63)', () => {
    const shell = D4_V1.components.find((c) => c.id === 'enclosure-shell')!;
    const chassis = D4_V1.components.find((c) => c.id === 'enclosure-chassis')!;
    expect(D4_V1.components.some((c) => c.id === 'enclosure')).toBe(false);
    expect(shell.sources[0]!.sizeMm).toEqual([126, 80, 36]);
    expect(chassis.sources[0]!.sizeMm).toEqual([126, 80, 36]);
    expect(D4_V1.instances.find((i) => i.id === 'front-acrylic')!.component).toBe('enclosure-shell');
    expect(D4_V1.instances.find((i) => i.id === 'rear-acrylic')!.component).toBe('enclosure-shell');
    expect(D4_V1.instances.find((i) => i.id === 'skeleton')!.component).toBe('enclosure-chassis');
  });
  it('ships the 16340 bench pack as alternatePower — experimental, never the default block', () => {
    const bench = D4_V1.alternatePower['16340-bench']!;
    expect(bench.experimental).toBe(true);
    expect(bench.power.battery.internalOhm.tag).toBe('ESTIMATED');
    // Top-level power stays the stock 505573 pack.
    expect(D4_V1.power.battery.capacitymAh).toBe(3000);
    expect(D4_V1.power.battery.internalOhm.value).toBe(0.08);
  });
  it('accepts a document without alternatePower (defaults to {}) but rejects experimental:false', () => {
    const doc = JSON.parse(JSON.stringify({ ...D4_V1 }));
    delete doc.alternatePower;
    expect(parseVersioned(hardwareProfile, doc).alternatePower).toEqual({});

    const bad = JSON.parse(JSON.stringify({ ...D4_V1 }));
    bad.alternatePower['16340-bench'].experimental = false;
    expect(() => parseVersioned(hardwareProfile, bad)).toThrow();
  });
});

describe('referential integrity (audit #146, TW-2)', () => {
  it('refuses a net whose endpoint names a dropped instance', () => {
    const doc = JSON.parse(JSON.stringify({ ...D4_V1 }));
    // Drop one instance but keep its nets — the exact edit that used to crash
    // the Twin at render instead of failing at load.
    const victim = doc.nets[0].from.instance;
    doc.instances = doc.instances.filter((i: { id: string }) => i.id !== victim);
    expect(() => parseVersioned(hardwareProfile, doc)).toThrow(/names instance/);
  });

  it('refuses an instance whose component is not in components[]', () => {
    const doc = JSON.parse(JSON.stringify({ ...D4_V1 }));
    doc.instances[0].component = 'does-not-exist';
    // The ZodError text JSON-escapes the quotes (\"), so match around them.
    expect(() => parseVersioned(hardwareProfile, doc)).toThrow(/names component .{1,2}does-not-exist/);
  });

  it('still accepts the shipped profile', () => {
    expect(() => parseVersioned(hardwareProfile, JSON.parse(JSON.stringify({ ...D4_V1 })))).not.toThrow();
  });
});
