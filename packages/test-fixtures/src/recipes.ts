// The device side of the look/recipe document. A recipe is data the camera
// stores, not firmware, so the simulator needs its own view of the format and
// its own upload check — real firmware validates arriving JSON itself rather
// than trusting whatever Studio validated on the host.
//
// Studio keeps the authoring-side type and validator in
// `apps/studio/src/recipes/recipeTypes.ts`; the two are structurally
// identical and `apps/studio/tests/recipes.test.ts` runs Studio's validator
// over FACTORY_RECIPES to keep them from drifting.

export const RECIPE_SCHEMA = 1;

export interface DeviceRecipeCapture {
  resolution: '1600x1200' | '2048x1536';
  jpegQuality: number;
  exposureBias: number;
  gainLimit: number;
  denoise: number;
  sharpness: number;
}

export interface DeviceRecipeLook {
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  blackPoint: number;
  highlightCompression: number;
  grain: number;
  vignette: number;
}

export interface DeviceRecipeAdvanced {
  rgbMatrix?: [number, number, number, number, number, number, number, number, number];
  lut?: string | null;
}

export interface DeviceRecipe {
  schema: number;
  id: string;
  name: string;
  factory?: boolean;
  description?: string;
  capture: DeviceRecipeCapture;
  look: DeviceRecipeLook;
  advanced?: DeviceRecipeAdvanced;
}

const LOOK_KEYS: (keyof DeviceRecipeLook)[] = [
  'contrast',
  'saturation',
  'temperature',
  'tint',
  'blackPoint',
  'highlightCompression',
  'grain',
  'vignette',
];

const CAPTURE_NUMERIC: (keyof DeviceRecipeCapture)[] = [
  'jpegQuality',
  'exposureBias',
  'gainLimit',
  'denoise',
  'sharpness',
];

/**
 * What the camera checks before writing an uploaded look to the SD card.
 * Returns the NACK reason (04 §6/§18 style) or null when the document is
 * storable.
 */
export function validateDeviceRecipe(
  value: unknown,
): { ok: true; recipe: DeviceRecipe } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'Look must be a JSON object' };
  }
  const r = value as Partial<DeviceRecipe>;
  if (r.schema !== RECIPE_SCHEMA) {
    return { ok: false, error: `Unsupported look schema (expected ${RECIPE_SCHEMA})` };
  }
  if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(r.id)) {
    return { ok: false, error: 'Look id must be lowercase letters, digits and dashes' };
  }
  if (typeof r.name !== 'string' || r.name.trim().length === 0 || r.name.length > 40) {
    return { ok: false, error: 'Look name must be 1-40 characters' };
  }
  if (typeof r.capture !== 'object' || r.capture === null) {
    return { ok: false, error: 'Look is missing the capture block' };
  }
  if (typeof r.look !== 'object' || r.look === null) {
    return { ok: false, error: 'Look is missing the look block' };
  }
  const capture = r.capture as DeviceRecipeCapture;
  if (capture.resolution !== '1600x1200' && capture.resolution !== '2048x1536') {
    return { ok: false, error: 'capture.resolution must be 1600x1200 or 2048x1536' };
  }
  const look = r.look as DeviceRecipeLook;
  for (const key of CAPTURE_NUMERIC) {
    if (!Number.isFinite(capture[key])) return { ok: false, error: `capture.${key} must be a number` };
  }
  for (const key of LOOK_KEYS) {
    if (!Number.isFinite(look[key])) return { ok: false, error: `look.${key} must be a number` };
  }
  if (r.advanced?.rgbMatrix && r.advanced.rgbMatrix.length !== 9) {
    return { ok: false, error: 'advanced.rgbMatrix must contain 9 values' };
  }
  return { ok: true, recipe: r as DeviceRecipe };
}
