// The device side of the look/recipe document. A recipe is data the camera
// stores, not firmware, so the simulator needs its own view of the format and
// its own upload check — real firmware validates arriving JSON itself rather
// than trusting whatever Studio validated on the host.
//
// Studio keeps the authoring-side type and validator in
// `apps/studio/src/recipes/recipeTypes.ts`. The two are structurally identical
// and must stay behaviorally identical: `apps/studio/tests/recipes.test.ts`
// runs BOTH validators over `RECIPE_PARITY_CASES` and over FACTORY_RECIPES,
// which is the only place either copy can be checked against the other.

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

const CAPTURE_NUMERIC: (keyof DeviceRecipeCapture)[] = [
  'jpegQuality',
  'exposureBias',
  'gainLimit',
  'denoise',
  'sharpness',
];

/**
 * What the camera checks before writing an uploaded look to the SD card.
 *
 * Deliberately kept in lockstep with Studio's `validateRecipe`
 * (`apps/studio/src/recipes/recipeTypes.ts`), including the parts that look
 * lax: the look block is checked key-by-key over the keys that are *present*,
 * so a document missing `look.grain` is stored and the firmware defaults it.
 * Rejecting it here would mean Studio accepts a look file the camera then
 * refuses — the mock is the firmware reference, so parity with the shipping
 * client beats being stricter on our own. `RECIPE_PARITY_CASES` below pins
 * this, and `apps/studio/tests/recipes.test.ts` runs both validators over it.
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
  // Present keys only — see the note above on parity with Studio.
  for (const key of Object.keys(look) as (keyof DeviceRecipeLook)[]) {
    if (!Number.isFinite(look[key])) return { ok: false, error: `look.${key} must be a number` };
  }
  if (r.advanced?.rgbMatrix && r.advanced.rgbMatrix.length !== 9) {
    return { ok: false, error: 'advanced.rgbMatrix must contain 9 values' };
  }
  return { ok: true, recipe: r as DeviceRecipe };
}

/** A minimal but valid look document, as a base for building test cases. */
export function sampleRecipe(id = 'test-look'): DeviceRecipe {
  return {
    schema: RECIPE_SCHEMA,
    id,
    name: 'Test Look',
    capture: {
      resolution: '1600x1200',
      jpegQuality: 86,
      exposureBias: 0,
      gainLimit: 16,
      denoise: 1,
      sharpness: 1,
    },
    look: {
      contrast: 1.05,
      saturation: 1.1,
      temperature: 120,
      tint: -1,
      blackPoint: 3,
      highlightCompression: 0.06,
      grain: 0.14,
      vignette: 0.04,
    },
  };
}

/**
 * Documents whose accept/reject outcome BOTH validators must agree on. The
 * device validator lives here and Studio's lives in the app, so nothing can
 * import both except a Studio-side test — `apps/studio/tests/recipes.test.ts`
 * runs this table through both and asserts they match `valid`. That is what
 * keeps the two copies from drifting; without it the duplication is a bug
 * waiting to happen rather than a documented trade-off.
 */
export const RECIPE_PARITY_CASES: { name: string; document: unknown; valid: boolean }[] = [
  { name: 'a complete look', document: sampleRecipe(), valid: true },
  {
    name: 'a look missing an optional look key (firmware defaults it)',
    document: (() => {
      const { grain: _omitted, ...look } = sampleRecipe().look;
      return { ...sampleRecipe('missing-grain'), look };
    })(),
    valid: true,
  },
  {
    name: 'a look with extra unknown look keys',
    document: { ...sampleRecipe('extra-keys'), look: { ...sampleRecipe().look, bloom: 0.2 } },
    valid: true,
  },
  { name: 'a non-object', document: 'not a look', valid: false },
  { name: 'a null', document: null, valid: false },
  { name: 'the wrong schema version', document: { ...sampleRecipe('old'), schema: 99 }, valid: false },
  { name: 'an id with capitals and punctuation', document: { ...sampleRecipe(), id: 'Party Neg!' }, valid: false },
  { name: 'an empty name', document: { ...sampleRecipe('no-name'), name: '   ' }, valid: false },
  {
    name: 'a missing look block',
    document: (() => {
      const { look: _omitted, ...rest } = sampleRecipe('no-look');
      return rest;
    })(),
    valid: false,
  },
  {
    name: 'a missing capture block',
    document: (() => {
      const { capture: _omitted, ...rest } = sampleRecipe('no-capture');
      return rest;
    })(),
    valid: false,
  },
  {
    name: 'an unsupported resolution',
    document: { ...sampleRecipe('bad-res'), capture: { ...sampleRecipe().capture, resolution: '640x480' } },
    valid: false,
  },
  {
    name: 'a non-numeric capture value',
    document: { ...sampleRecipe('bad-cap'), capture: { ...sampleRecipe().capture, jpegQuality: 'high' } },
    valid: false,
  },
  {
    name: 'a non-numeric look value',
    document: { ...sampleRecipe('bad-look'), look: { ...sampleRecipe().look, contrast: 'punchy' } },
    valid: false,
  },
  {
    name: 'a short rgbMatrix',
    document: { ...sampleRecipe('bad-matrix'), advanced: { rgbMatrix: [1, 0, 0] } },
    valid: false,
  },
];
