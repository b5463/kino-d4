import { describe, expect, it } from 'vitest';
import { validateRecipe } from '../src/recipes/recipeTypes';
import { FACTORY_RECIPES, RECIPE_PARITY_CASES, validateDeviceRecipe } from '@kino/test-fixtures';

describe('recipe validation', () => {
  it('accepts every factory recipe', () => {
    for (const recipe of FACTORY_RECIPES) {
      const r = validateRecipe(JSON.parse(JSON.stringify(recipe)));
      expect(r.ok, `${recipe.id} should validate`).toBe(true);
    }
  });

  it('includes the full factory look library', () => {
    const ids = FACTORY_RECIPES.map((r) => r.id);
    const expected = [
      'party-neg', 'chrome', 'superia', 'vivid', 'mono', 'raw-digi', 'motion',
      'flash-digi', 'warm-2007', 'cold-flash', 'disposable',
    ];
    for (const id of expected) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
  });

  it('rejects a bad id', () => {
    const bad = { ...FACTORY_RECIPES[0], id: 'Party Neg!' };
    expect(validateRecipe(bad).ok).toBe(false);
  });

  it('rejects a missing look block', () => {
    const { look: _omitted, ...rest } = FACTORY_RECIPES[0];
    expect(validateRecipe(rest).ok).toBe(false);
  });

  it('rejects non-numeric look values', () => {
    const bad = JSON.parse(JSON.stringify(FACTORY_RECIPES[0]));
    bad.look.contrast = 'high';
    expect(validateRecipe(bad).ok).toBe(false);
  });
});

// Studio validates a look before uploading it; the camera validates it again
// before writing it to the card. Those are two implementations of one rule,
// and only this file can see both — the fixtures package must not import the
// app. If they ever disagree, Studio ships a look the device then refuses (or
// worse, blocks one the device would have taken).
describe('device/host validator parity', () => {
  it('agrees with the device validator on every parity fixture', () => {
    for (const c of RECIPE_PARITY_CASES) {
      const host = validateRecipe(c.document);
      const device = validateDeviceRecipe(c.document);
      expect(host.ok, `${c.name}: Studio`).toBe(c.valid);
      expect(device.ok, `${c.name}: device`).toBe(c.valid);
    }
  });

  it('agrees on the whole factory look library', () => {
    for (const recipe of FACTORY_RECIPES) {
      const document = JSON.parse(JSON.stringify(recipe));
      expect(validateRecipe(document).ok, recipe.id).toBe(true);
      expect(validateDeviceRecipe(document).ok, recipe.id).toBe(true);
    }
  });
});
