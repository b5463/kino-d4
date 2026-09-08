// Flat diff between two configuration objects, for the restore preview.

export interface ConfigDiff {
  path: string;
  from: string;
  to: string;
}

function flatten(value: unknown, prefix: string, out: Map<string, string>) {
  if (value === null || value === undefined) {
    out.set(prefix, String(value));
    return;
  }
  if (Array.isArray(value)) {
    out.set(prefix, JSON.stringify(value));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  out.set(prefix, String(value));
}

/**
 * Fields the camera did not store as they were sent.
 *
 * `requested` is the patch that went out in SET_CONFIG and `stored` is the
 * config read back after SAVE_CONFIG, so only the paths the patch actually
 * carried are compared — everything else in the config is none of this
 * write's business. `from` is what was asked for, `to` is what the camera
 * kept.
 *
 * SET_CONFIG is allowed to clamp: a value outside the firmware's range comes
 * back at the limit, with an ACK and no complaint. Nothing compared the two,
 * so the operator's evidence of a silently refused write was the unsaved
 * marker reappearing after a successful save, with no clue which field caused
 * it.
 */
export function readbackDiff(requested: unknown, stored: unknown): ConfigDiff[] {
  const asked = new Map<string, string>();
  const kept = new Map<string, string>();
  flatten(requested, '', asked);
  flatten(stored, '', kept);
  const out: ConfigDiff[] = [];
  for (const path of [...asked.keys()].sort()) {
    const from = asked.get(path)!;
    const to = kept.get(path);
    // A path the camera does not report at all is not a refusal: the write
    // may have carried a field this firmware has no place for, and inventing
    // "kept: —" for it would put a fault on screen that nobody can act on.
    if (to !== undefined && from !== to) out.push({ path, from, to });
  }
  return out;
}

export function diffConfigs(current: unknown, incoming: unknown): ConfigDiff[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  flatten(current, '', a);
  flatten(incoming, '', b);
  const diffs: ConfigDiff[] = [];
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const key of [...keys].sort()) {
    const from = a.get(key);
    const to = b.get(key);
    if (from !== to) {
      diffs.push({ path: key, from: from ?? '—', to: to ?? '—' });
    }
  }
  return diffs;
}
