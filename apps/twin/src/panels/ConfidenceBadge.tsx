import type { DimensionSource, ResolvedDims } from '@kino/hardware-profiles';

/**
 * Formats a nullable-axis mm tuple as `21.0 × 17.8 × 15.0` — shared by
 * `Inspector.tsx`'s `formatDims` (resolved dims) and the conflict-source
 * lines below (raw `DimensionSource.sizeMm`, same tuple shape). An unknown
 * axis renders as `?`, never a guessed number (§7.3, §9).
 */
export function formatSizeMm(sizeMm: readonly [number | null, number | null, number | null]): string {
  const axis = (v: number | null) => (v === null ? '?' : v.toFixed(1));
  return `${axis(sizeMm[0])} × ${axis(sizeMm[1])} × ${axis(sizeMm[2])}`;
}

/**
 * The badge's headline text (§6). A resolution only becomes `CONFLICT` when
 * `resolveDimensions` found two trustworthy sources that actually disagree —
 * a plain `PROVISIONAL` (single fallback source, nothing to compare against)
 * keeps its own kind as the label. This is deliberately keyed off
 * `confidence`, not the `measureToLock` flag: `measureToLock` also covers
 * "provisional, should be measured eventually" and "one axis unknown" cases
 * that are not conflicts and must not be relabeled as one (only an actual
 * conflict gets the "never silently choose" treatment — both values stored
 * and shown).
 */
export function confidenceLabel(r: ResolvedDims): string {
  return r.confidence === 'CONFLICT' ? 'MEASURE TO LOCK' : r.confidence;
}

/**
 * One line per conflicting source (§6) — kind, its claimed size, and its
 * ref/note if any — so both disagreeing values stay visible side by side.
 * Empty outside the `CONFLICT` case (`resolveDimensions` only populates
 * `conflict` when sources actually disagreed).
 */
export function conflictSourceLines(r: ResolvedDims): string[] {
  if (!r.conflict) return [];
  return r.conflict.map((s: DimensionSource) => {
    const dims = formatSizeMm(s.sizeMm);
    const detail = s.ref ?? s.note;
    return detail ? `${s.kind} ${dims} mm — ${detail}` : `${s.kind} ${dims} mm`;
  });
}

interface ConfidenceBadgeProps {
  resolved: ResolvedDims;
}

/**
 * Provenance badge for one resolved dimension (§6). Shows the source kind
 * normally; when `resolveDimensions` flagged the resolution as needing a
 * bench measurement (`measureToLock` — conflict, provisional fallback, or an
 * unknown axis) it takes the warn styling, and an actual conflict also lists
 * every disagreeing source underneath so nothing gets silently picked.
 */
export function ConfidenceBadge({ resolved }: ConfidenceBadgeProps) {
  const label = confidenceLabel(resolved);
  const conflictLines = conflictSourceLines(resolved);

  return (
    <span className={resolved.measureToLock ? 'twin-badge twin-badge--warn' : 'twin-badge'}>
      {label}
      {conflictLines.length > 0 && (
        <ul className="twin-badge-conflict">
          {conflictLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </span>
  );
}
