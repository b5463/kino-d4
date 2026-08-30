import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { FACTORY_RECIPES } from '../src/factoryRecipes';
import type { DeviceRecipe } from '../src/recipes';

/**
 * The factory looks exist twice: once as `FACTORY_RECIPES`, which the mock
 * device and every Studio test read, and once as
 * `firmware/p4/main/factory_recipes.json`, which is compiled into the P4
 * image. Two copies of the same eleven documents is exactly the arrangement
 * that produces a Party Neg on the bench that is not the Party Neg in the
 * app, and the difference would show as a picture, not as an error.
 *
 * So neither is normative on its own: they have to be equal, and this is what
 * says so. Editing one and not the other is a red test rather than a look
 * that quietly means two things (issue #141).
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIRMWARE_JSON = 'firmware/p4/main/factory_recipes.json';
const jsonPath = resolve(REPO_ROOT, FIRMWARE_JSON);

/** Order is not part of the contract — the id is. */
function byId(recipes: DeviceRecipe[]): Map<string, DeviceRecipe> {
  return new Map(recipes.map((r) => [r.id, r]));
}

describe('factory look parity: firmware JSON == FACTORY_RECIPES', () => {
  it('the firmware document exists', () => {
    expect(existsSync(jsonPath), `${FIRMWARE_JSON} missing — the P4 image compiles its factory looks from this file`).toBe(true);
  });

  it('carries the same eleven ids', () => {
    const fromFirmware = readFirmwareRecipes();
    expect([...byId(fromFirmware).keys()].sort()).toEqual([...byId(FACTORY_RECIPES).keys()].sort());
    expect(fromFirmware).toHaveLength(11);
    expect(FACTORY_RECIPES).toHaveLength(11);
  });

  it('marks every entry factory', () => {
    for (const recipe of readFirmwareRecipes()) {
      expect(recipe.factory, `${recipe.id} is not marked factory`).toBe(true);
    }
  });

  it('matches document for document', () => {
    const fromFirmware = byId(readFirmwareRecipes());
    for (const expected of FACTORY_RECIPES) {
      expect(fromFirmware.get(expected.id), `${expected.id} differs between ${FIRMWARE_JSON} and FACTORY_RECIPES`).toEqual(expected);
    }
  });
});

/**
 * Read the firmware document, or fail with the path rather than with a
 * `ENOENT` stack — the file is written by the firmware side and a missing one
 * is a real answer about the state of the tree, not a broken test.
 */
function readFirmwareRecipes(): DeviceRecipe[] {
  if (!existsSync(jsonPath)) {
    throw new Error(`${FIRMWARE_JSON} missing — cannot check factory look parity`);
  }
  const parsed: unknown = JSON.parse(readFileSync(jsonPath, 'utf8'));
  // Accept either a bare array or a wrapper with a `recipes` array; the
  // firmware may want a schema stamp beside the list.
  const list = Array.isArray(parsed) ? parsed : (parsed as { recipes?: unknown }).recipes;
  if (!Array.isArray(list)) {
    throw new Error(`${FIRMWARE_JSON} is neither an array of looks nor { recipes: [...] }`);
  }
  return list as DeviceRecipe[];
}
