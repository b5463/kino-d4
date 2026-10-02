// The four Quad sets. Slot data only; the customer shell writes it through
// applyConfigChecked like every other change. "Party" is the factory
// default, named as a set so there is no separate reset.
//
// The Service Quad page keeps its own copy as QUAD_PRESETS / PARTY_DEFAULT;
// the customer shell must not import that page's UI.

import type { QuadConfig } from '@kino/kdp';

export interface QuadSet {
  name: string;
  slots: QuadConfig['slots'];
}

export const QUAD_SETS: QuadSet[] = [
  {
    name: 'Film Four',
    slots: {
      cam1: { recipeId: 'chrome', exposureBias: 0, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: '' },
      cam2: { recipeId: 'superia', exposureBias: 0.3, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: '' },
      cam3: { recipeId: 'vivid', exposureBias: 0, gain: 'low', flash: 'fire', colorMode: 'recipe', note: '' },
      cam4: { recipeId: 'mono', exposureBias: -0.3, gain: 'high', flash: 'fire', colorMode: 'mono', note: 'b/w' },
    },
  },
  {
    name: 'Chaos',
    slots: {
      cam1: { recipeId: 'disposable', exposureBias: 1, gain: 'high', flash: 'fire', colorMode: 'recipe', note: 'over +1' },
      cam2: { recipeId: 'motion', exposureBias: 0.6, gain: 'low', flash: 'skip', colorMode: 'recipe', note: 'blur, no flash' },
      cam3: { recipeId: 'vivid', exposureBias: -1.2, gain: 'high', flash: 'fire', colorMode: 'recipe', note: 'under -1.2' },
      cam4: { recipeId: 'cold-flash', exposureBias: 0, gain: 'auto', flash: 'fire', colorMode: 'mono', note: 'b/w cold' },
    },
  },
  {
    name: 'Raw Four',
    slots: {
      cam1: { recipeId: 'raw-digi', exposureBias: 0, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: 'straight' },
      cam2: { recipeId: 'raw-digi', exposureBias: -0.7, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: '-0.7' },
      cam3: { recipeId: 'raw-digi', exposureBias: 0.7, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: '+0.7' },
      cam4: { recipeId: 'raw-digi', exposureBias: -0.3, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: '-0.3' },
    },
  },
  {
    name: 'Party',
    slots: {
      cam1: { recipeId: 'party-neg', exposureBias: 0, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: '' },
      cam2: { recipeId: 'motion', exposureBias: 0.3, gain: 'low', flash: 'skip', colorMode: 'recipe', note: 'blur' },
      cam3: { recipeId: 'raw-digi', exposureBias: 0, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: 'raw' },
      cam4: { recipeId: 'mono', exposureBias: -0.3, gain: 'high', flash: 'fire', colorMode: 'mono', note: 'b/w' },
    },
  },
];

/** Which set the four slots currently match, judged on look and colour only. */
export function matchingSet(slots: QuadConfig['slots']): string | null {
  for (const set of QUAD_SETS) {
    const same = (['cam1', 'cam2', 'cam3', 'cam4'] as const).every(
      (cam) => set.slots[cam].recipeId === slots[cam].recipeId && set.slots[cam].colorMode === slots[cam].colorMode,
    );
    if (same) return set.name;
  }
  return null;
}
