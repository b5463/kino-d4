import { describe, expect, it } from 'vitest';
import { dottedPatch, flattenConfig, leafValue, rgbaToRgb565 } from '../src/display/firmwareUiState';

// The bridge between the simulator's config document and ui.c's config_store:
// what the screens read is what SET_CONFIG would have written, and what the
// screens write is what SET_CONFIG would carry.
describe('firmware UI state mapping', () => {
  it('flattens the config document to the dotted paths ui.c reads', () => {
    const rows = new Map(
      flattenConfig({
        mode: 'wiggle',
        shoot: { flashMode: 'auto', volume: 6, displayAfterShotS: 2 },
        body: { name: '', sounds: { ui: false, save: true } },
        quad: { slots: { cam3: { recipeId: 'raw-digi', colorMode: 'recipe' } } },
      }),
    );
    expect(rows.get('mode')).toBe('wiggle');
    expect(rows.get('shoot.flashMode')).toBe('auto');
    // Numbers keep their decimal form; config_int() parses them back.
    expect(rows.get('shoot.volume')).toBe('6');
    // Booleans are the words, not 1/0, so config_bool() and config_int() agree.
    expect(rows.get('body.sounds.ui')).toBe('false');
    expect(rows.get('body.sounds.save')).toBe('true');
    // An empty name is a present empty string, which is what the About screen
    // tests for; it must not vanish in the flattening.
    expect(rows.has('body.name')).toBe(true);
    expect(rows.get('body.name')).toBe('');
    expect(rows.get('quad.slots.cam3.recipeId')).toBe('raw-digi');
  });

  it('rebuilds the nested patch a written leaf implies', () => {
    expect(dottedPatch('shoot.flashMode', 'on')).toEqual({ shoot: { flashMode: 'on' } });
    expect(dottedPatch('mode', 'quad')).toEqual({ mode: 'quad' });
    expect(dottedPatch('body.sounds.ui', true)).toEqual({ body: { sounds: { ui: true } } });
  });

  it('decodes the leaf kinds meta_patch_path() hands over', () => {
    expect(leafValue(0, 0, 'auto')).toBe('auto');
    expect(leafValue(1, 30, '')).toBe(30);
    expect(leafValue(2, 1, '')).toBe(true);
    expect(leafValue(2, 0, '')).toBe(false);
  });

  it('packs RGBA into the RGB565 the tiles and panes are', () => {
    const out = new Uint16Array(3);
    rgbaToRgb565(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]), out);
    expect(Array.from(out)).toEqual([0xf800, 0x07e0, 0x001f]);
  });
});
