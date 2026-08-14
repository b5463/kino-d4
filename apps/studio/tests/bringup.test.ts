import { describe, expect, it } from 'vitest';
import { CHECKLIST, totalChecks, importRecord, exportRecord, useBringUp } from '../src/developer/bringup';

describe('bring-up record', () => {
  it('covers the spec checklist sections', () => {
    expect(CHECKLIST).toHaveLength(3);
    expect(totalChecks()).toBeGreaterThan(30);
    const ids = CHECKLIST.flatMap((s) => s.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length); // unique ids
  });

  it('flags the strapping-pin risk in the wiring record', () => {
    const wiring = useBringUp.getState().wiring;
    const cam3 = wiring.find((r) => r.func.startsWith('CAM3 TX'));
    expect(cam3?.provisional).toMatch(/strapping/i);
    expect(wiring.every((r) => r.status === 'unverified')).toBe(true);
  });

  it('rejects foreign or wrong-schema records', () => {
    expect(importRecord({ kind: 'something-else' })).toMatch(/not a kino/i);
    expect(importRecord({ kind: 'kino-wiring-record', schema: 99 })).toMatch(/schema/i);
    expect(importRecord('nope')).toMatch(/object/i);
  });

  it('round trips an exported record', () => {
    useBringUp.setState({ checks: { a1: true }, notes: 'pin 1 marked' });
    const record = exportRecord();
    useBringUp.setState({ checks: {}, notes: '' });
    expect(importRecord(record)).toBeNull();
    expect(useBringUp.getState().checks.a1).toBe(true);
    expect(useBringUp.getState().notes).toBe('pin 1 marked');
  });
});
