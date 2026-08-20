import type { ComponentDef, DimensionSource, SourceKind } from './types';
import { SOURCE_KINDS } from './types';
import type { MeasuredOverride } from './overrides';

export interface ResolvedDims {
  sizeMm: [number | null, number | null, number | null];
  confidence: SourceKind | 'CONFLICT';
  conflict: DimensionSource[] | null;
  measureToLock: boolean;
}

/** >0.5mm disagreement on any known (non-null) axis counts as a conflict (§6). */
const CONFLICT_TOLERANCE_MM = 0.5;

function disagree(a: DimensionSource, b: DimensionSource): boolean {
  const axisPairs: Array<[number | null, number | null]> = [
    [a.sizeMm[0], b.sizeMm[0]],
    [a.sizeMm[1], b.sizeMm[1]],
    [a.sizeMm[2], b.sizeMm[2]],
  ];
  return axisPairs.some(([av, bv]) => av !== null && bv !== null && Math.abs(av - bv) > CONFLICT_TOLERANCE_MM);
}

function anyPairDisagrees(sources: DimensionSource[]): boolean {
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const a = sources[i];
      const b = sources[j];
      if (a && b && disagree(a, b)) return true;
    }
  }
  return false;
}

/**
 * Resolves a component's dimensions per §6: a MeasuredOverride wins outright.
 * Otherwise, conflict-checking is scoped to only the highest-priority tier
 * that has any source at all — a PROVISIONAL fallback never gets compared
 * against a SELLER_SPEC that outranks it.
 */
export function resolveDimensions(c: ComponentDef, o?: MeasuredOverride): ResolvedDims {
  if (o) {
    if (o.componentId !== c.id) {
      throw new Error(`resolveDimensions: override componentId "${o.componentId}" does not match component "${c.id}"`);
    }
    return { sizeMm: o.sizeMm, confidence: 'MEASURED', conflict: null, measureToLock: false };
  }

  for (const kind of SOURCE_KINDS) {
    const tierSources = c.sources.filter((s) => s.kind === kind);
    const first = tierSources[0];
    if (!first) continue; // this tier has no sources — try the next-lower one

    const hasNullAxis = first.sizeMm.some((v) => v === null);

    if (tierSources.length >= 2 && anyPairDisagrees(tierSources)) {
      return { sizeMm: first.sizeMm, confidence: 'CONFLICT', conflict: tierSources, measureToLock: true };
    }

    return {
      sizeMm: first.sizeMm,
      confidence: kind,
      conflict: null,
      measureToLock: kind === 'PROVISIONAL' || hasNullAxis,
    };
  }

  // Defensive: componentDef.sources requires min 1 entry, so some kind in
  // SOURCE_KINDS always matches above and this line is unreachable.
  return { sizeMm: [null, null, null], confidence: 'PROVISIONAL', conflict: null, measureToLock: true };
}
