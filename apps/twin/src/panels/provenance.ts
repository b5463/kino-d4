import type { ProvenanceTag } from '@kino/hardware-profiles';

/** A provenance tag, shown as itself: MEASURED, ESTIMATED, SIMULATED. No softening. */
export function tagLabel(tag: ProvenanceTag): string {
  return tag;
}
