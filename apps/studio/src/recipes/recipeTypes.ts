// A recipe is data, not firmware. Both capture parameters (what the sensor
// does) and look parameters (what the P4 does to the JPEG) live here, plus
// an advanced block that can grow (RGB matrix now, LUT reference later)
// without a schema redesign.

export const RECIPE_SCHEMA = 1;

export interface RecipeCapture {
  resolution: '1600x1200' | '2048x1536';
  jpegQuality: number; // 60..95
  exposureBias: number; // EV, -2..+2
  gainLimit: number; // max sensor gain, 1..32
  denoise: number; // 0..2
  sharpness: number; // 0..2
}

export interface RecipeLook {
  contrast: number; // 0.8..1.4
  saturation: number; // 0..1.6
  temperature: number; // mired shift, -400..+400
  tint: number; // -20..+20
  blackPoint: number; // 0..16
  highlightCompression: number; // 0..0.3
  grain: number; // 0..0.5
  vignette: number; // 0..0.3
}

export interface RecipeAdvanced {
  /** Row-major 3x3 color matrix applied before the look stage. */
  rgbMatrix?: [number, number, number, number, number, number, number, number, number];
  /** Reserved: name of a LUT stored on the SD card. */
  lut?: string | null;
}

export interface Recipe {
  schema: number;
  id: string;
  name: string;
  factory?: boolean;
  description?: string;
  capture: RecipeCapture;
  look: RecipeLook;
  advanced?: RecipeAdvanced;
}

export const IDENTITY_MATRIX: NonNullable<RecipeAdvanced['rgbMatrix']> = [
  1, 0, 0, 0, 1, 0, 0, 0, 1,
];

export function cloneRecipe(recipe: Recipe): Recipe {
  return JSON.parse(JSON.stringify(recipe)) as Recipe;
}

/** Structural validation for imported/uploaded recipe JSON. */
export function validateRecipe(value: unknown): { ok: true; recipe: Recipe } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'Look file must be a JSON object' };
  }
  const r = value as Partial<Recipe>;
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
    return { ok: false, error: 'Look file is missing the capture block' };
  }
  if (typeof r.look !== 'object' || r.look === null) {
    return { ok: false, error: 'Look file is missing the look block' };
  }
  const c = r.capture as RecipeCapture;
  if (c.resolution !== '1600x1200' && c.resolution !== '2048x1536') {
    return { ok: false, error: 'capture.resolution must be 1600×1200 or 2048×1536' };
  }
  const numeric: [string, number][] = [
    ['capture.jpegQuality', c.jpegQuality],
    ['capture.exposureBias', c.exposureBias],
    ['capture.gainLimit', c.gainLimit],
    ['capture.denoise', c.denoise],
    ['capture.sharpness', c.sharpness],
  ];
  const look = r.look as RecipeLook;
  for (const key of Object.keys(look) as (keyof RecipeLook)[]) {
    numeric.push([`look.${key}`, look[key]]);
  }
  for (const [name, v] of numeric) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ok: false, error: `${name} must be a number` };
    }
  }
  if (r.advanced?.rgbMatrix && r.advanced.rgbMatrix.length !== 9) {
    return { ok: false, error: 'advanced.rgbMatrix must contain 9 values' };
  }
  return { ok: true, recipe: r as Recipe };
}
