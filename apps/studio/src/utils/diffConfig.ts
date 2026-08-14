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
