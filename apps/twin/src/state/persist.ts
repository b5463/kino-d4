import { measuredOverrides, type MeasuredOverride } from '@kino/hardware-profiles';
import { parseVersioned } from '@kino/schemas';

export const OVERRIDES_STORAGE_KEY = 'kino-twin.measured-overrides';

function documentFor(overrides: MeasuredOverride[]) {
  return { schema: 'kino.measured-overrides' as const, version: 1 as const, overrides };
}

export function importOverrides(json: string): MeasuredOverride[] {
  try {
    return parseVersioned(measuredOverrides, JSON.parse(json)).overrides;
  } catch {
    return [];
  }
}

export function exportOverrides(overrides?: MeasuredOverride[]): string {
  const values = overrides ?? loadOverrides();
  return JSON.stringify(documentFor(values), null, 2);
}

export function loadOverrides(): MeasuredOverride[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(OVERRIDES_STORAGE_KEY);
    return raw === null ? [] : importOverrides(raw);
  } catch {
    return [];
  }
}

export function saveOverrides(overrides: MeasuredOverride[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(OVERRIDES_STORAGE_KEY, JSON.stringify(documentFor(overrides)));
  } catch {
    // Measurement capture must remain usable when storage is unavailable.
  }
}
