import { describe, expect, it } from 'vitest';
import { D4_V1 } from '@kino/hardware-profiles';
import { CHECKLIST, totalChecks, importRecord, exportRecord, useBringUp } from '../src/developer/bringup';

describe('bring-up record', () => {
  it('covers the spec checklist sections', () => {
    // Three electrical sections from the hardware spec, then the four the
    // usable-V1 build added: printed body, closed-body numbers, the effect,
    // field reliability.
    expect(CHECKLIST).toHaveLength(8);
    expect(totalChecks()).toBeGreaterThan(70);
    const ids = CHECKLIST.flatMap((s) => s.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length); // unique ids
  });

  it('runs past the electrical build to the parts a printed body added', () => {
    const titles = CHECKLIST.map((s) => s.title);
    // The modules arrive before the harness, so their check comes first.
    expect(titles[0]).toContain('CAMERA MODULE INCOMING CHECK');
    expect(titles).toContain('PRINTED BODY — V1 STRUCTURE');
    expect(titles).toContain('CLOSED-BODY POWER AND THERMAL — V2 INPUTS');
    expect(titles).toContain('THE EFFECT ITSELF');
  });

  it('gives every measurement check somewhere to put the measurement', () => {
    // A tick that records no number wastes the run it came from: the V2
    // input sections are worthless as bare checkboxes.
    const v2 = CHECKLIST.find((s) => s.title.includes('V2 INPUTS'));
    expect(v2).toBeDefined();
    expect(v2!.items.every((i) => typeof i.record === 'string' && i.record.length > 0)).toBe(true);
  });

  it('only wires RUN buttons to tests the page implements', () => {
    const known = new Set(['uart-echo', 'trigger', 'captures', 'selftest', 'snapshot']);
    for (const item of CHECKLIST.flatMap((s) => s.items)) {
      if (item.test !== undefined) expect(known.has(item.test)).toBe(true);
    }
  });

  it('seeds the wiring record from the profile pin map, JP1 pin included', () => {
    const wiring = useBringUp.getState().wiring;
    const cam1 = wiring.find((r) => r.func.startsWith('CAM1 TX'));
    expect(cam1?.provisional).toBe(`${D4_V1.gpio.CAM1_TX} (JP1 pin ${D4_V1.jp1!.pins.CAM1_TX!.pin})`);
    const cam3 = wiring.find((r) => r.func.startsWith('CAM3 TX'));
    expect(cam3?.provisional).toBe(`${D4_V1.gpio.CAM3_TX} (JP1 pin ${D4_V1.jp1!.pins.CAM3_TX!.pin})`);
    // No strapping pin (GPIO34-38) may appear in the record any more.
    for (const r of wiring) expect(r.provisional).not.toMatch(/GPIO3[4-8]\b/);
    // Lines without a header pin say so instead of naming a GPIO that routes nowhere.
    expect(wiring.find((r) => r.func === 'FLASH_EN')?.provisional).toBe('unassigned');
    expect(wiring.find((r) => r.func === 'CAM_PWR_EN')?.provisional).toBe('unassigned');
    expect(wiring.every((r) => r.status === 'unverified')).toBe(true);
  });

  it('rejects foreign or wrong-schema records', () => {
    expect(importRecord({ kind: 'something-else' })).toMatch(/not a kino/i);
    expect(importRecord({ kind: 'kino-wiring-record', schema: 99 })).toMatch(/schema/i);
    expect(importRecord('nope')).toMatch(/object/i);
  });

  it('round trips an exported record, measurements included', () => {
    useBringUp.setState({
      checks: { a1: true },
      values: { d2: '19.02, 18.98, 19.01' },
      notes: 'pin 1 marked',
    });
    const record = exportRecord();
    useBringUp.setState({ checks: {}, values: {}, notes: '' });
    expect(importRecord(record)).toBeNull();
    expect(useBringUp.getState().checks.a1).toBe(true);
    expect(useBringUp.getState().values.d2).toBe('19.02, 18.98, 19.01');
    expect(useBringUp.getState().notes).toBe('pin 1 marked');
  });

  it('still imports a record written before measurements existed', () => {
    // Values were added after the first builds were recorded. An older
    // export simply has none, which is a fact about that build rather than
    // a broken file — so the schema stays 1 and the field is optional.
    useBringUp.setState({ values: { d2: 'stale' } });
    expect(importRecord({ kind: 'kino-wiring-record', schema: 1, checks: { a1: true } })).toBeNull();
    expect(useBringUp.getState().values).toEqual({});
    expect(useBringUp.getState().checks.a1).toBe(true);
  });
});
