import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeasuredOverride } from '@kino/hardware-profiles';
import {
  exportOverrides,
  importOverrides,
  loadOverrides,
  saveOverrides,
} from '../src/state/persist';
import { measurementChecklist } from '../src/panels/MeasurePanel';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

const bms: MeasuredOverride = {
  componentId: 'bms',
  sizeMm: [22, 15, 3],
  measuredAt: '2026-08-20T12:00:00.000Z',
};

afterEach(() => vi.unstubAllGlobals());

describe('measured override persistence', () => {
  it('round-trips the versioned document through localStorage and export/import', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    saveOverrides([bms]);
    expect(loadOverrides()).toEqual([bms]);
    expect(importOverrides(exportOverrides())).toEqual([bms]);
  });

  it('treats missing, malformed, and wrong-schema documents as empty', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    expect(loadOverrides()).toEqual([]);
    storage.setItem('kino-twin.measured-overrides', '{bad');
    expect(loadOverrides()).toEqual([]);
    storage.setItem('kino-twin.measured-overrides', JSON.stringify({ schema: 'wrong', version: 1, overrides: [bms] }));
    expect(loadOverrides()).toEqual([]);
  });
});

describe('measurement checklist', () => {
  it('marks only the BMS row when the BMS has an override', () => {
    const rows = measurementChecklist([bms]);
    expect(rows.filter((row) => row.done).map((row) => row.label)).toEqual(['BMS']);
    // 11 since ECN-0003 dropped the flash assembly and its LED driver row.
    expect(rows).toHaveLength(11);
  });
});
