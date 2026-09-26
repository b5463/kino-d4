// What the customer may change about a look, and how a built-in becomes
// theirs. Five words; the rest of a look's fields keep the values it shipped
// with and are Service's business.

import type { Recipe, RecipeLook } from '../../recipes/recipeTypes';

export interface CustomerSlider {
  key: keyof RecipeLook;
  label: string;
  min: number;
  max: number;
  step: number;
}

export const CUSTOMER_SLIDERS: readonly CustomerSlider[] = [
  { key: 'contrast', label: 'Contrast', min: 0.8, max: 1.4, step: 0.01 },
  { key: 'saturation', label: 'Colour', min: 0, max: 1.6, step: 0.01 },
  { key: 'temperature', label: 'Warmth', min: -400, max: 400, step: 10 },
  { key: 'grain', label: 'Grain', min: 0, max: 0.5, step: 0.01 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 0.3, step: 0.01 },
];

export function withLookValue(recipe: Recipe, key: keyof RecipeLook, value: number): Recipe {
  return { ...recipe, look: { ...recipe.look, [key]: value } };
}

export function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

/** "Party Neg (yours)": the copy a built-in becomes on the first adjustment. */
export function yoursCopy(source: Recipe, all: Recipe[]): Recipe {
  const ids = new Set(all.map((r) => r.id));
  const names = new Set(all.map((r) => r.name));
  const baseName = `${source.name.replace(/ \(yours\)$/, '')} (yours)`;
  let name = baseName;
  let n = 2;
  while (names.has(name)) name = `${baseName} ${n++}`;
  return {
    ...structuredClone(source),
    id: uniqueId(`${source.id.replace(/-yours(-\d+)?$/, '')}-yours`, ids),
    name: name.slice(0, 40),
    factory: false,
  };
}

/** A plain copy, for Duplicate. */
export function duplicateOf(source: Recipe, all: Recipe[]): Recipe {
  const ids = new Set(all.map((r) => r.id));
  return { ...structuredClone(source), id: uniqueId(`${source.id}-copy`, ids), name: `${source.name} copy`.slice(0, 40), factory: false };
}

export function isYours(recipe: Recipe): boolean {
  return recipe.factory === false;
}

export function splitLooks(recipes: Recipe[]): { builtIn: Recipe[]; yours: Recipe[] } {
  return { builtIn: recipes.filter((r) => !isYours(r)), yours: recipes.filter(isYours) };
}

/** The current look first, then the rest in their stored order, up to `limit`. */
export function recentLooks(recipes: Recipe[], currentId: string, limit = 6): Recipe[] {
  const current = recipes.find((r) => r.id === currentId);
  const rest = recipes.filter((r) => r.id !== currentId);
  return (current ? [current, ...rest] : rest).slice(0, limit);
}
