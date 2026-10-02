// #230: Shoot's rules. The feel scale, the end cells as the direction
// control, the look set, More, the marks the camera's answer leaves, and
// Quad's editor, colour gating, sets and travel targets.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuadConfig } from '@kino/kdp';
import { FEELS, directionForCell, feelForFps, fpsForFeel, sequenceOrder } from '../src/customer/shoot/useWiggleStep';
import { markFor } from '../src/customer/shoot/useSaved';
import { REVIEW_OPTIONS, WiggleLine, reviewLabel, shutterName } from '../src/customer/shoot/WiggleLine';
import { QUAD_SETS, matchingSet } from '../src/customer/shoot/quadSets';
import { QuadEditor, biasLabel, editorLeft } from '../src/customer/shoot/QuadEditor';
import { lookCharacter, lookCssFilter } from '../src/customer/shoot/lookFilter';
import { duplicateOf, recentLooks, splitLooks, withLookValue, yoursCopy } from '../src/customer/looks/lookEdits';
import { FACTORY_RECIPES } from '@kino/test-fixtures';
import type { Recipe } from '../src/recipes/recipeTypes';

const recipes = FACTORY_RECIPES as unknown as Recipe[];
const noop = () => undefined;

describe('Wiggle', () => {
  it('maps the five feels onto the camera’s own frame rates and back', () => {
    expect(FEELS.map((f) => f.name)).toEqual(['Dreamy', 'Slow', 'Normal', 'Fast', 'Hyper']);
    for (const f of FEELS) expect(feelForFps(fpsForFeel(f.name))).toBe(f.name);
    expect(FEELS.every((f) => f.fps >= 5 && f.fps <= 15)).toBe(true);
  });

  it('makes the end cells the direction control and the inner cells nothing', () => {
    expect(directionForCell(0)).toBe('ltr');
    expect(directionForCell(3)).toBe('rtl');
    expect(directionForCell(1)).toBeNull();
    expect(directionForCell(2)).toBeNull();
  });

  it('plays one way by default and reverses from the right lens', () => {
    expect(sequenceOrder('continuous', 'ltr')).toEqual([0, 1, 2, 3]);
    expect(sequenceOrder('continuous', 'rtl')).toEqual([3, 2, 1, 0]);
    expect(sequenceOrder('bounce', 'ltr')).toEqual([0, 1, 2, 3, 2, 1]);
    expect(sequenceOrder('continuous', 'ltr', 3)).toEqual([0, 1, 2]);
  });

  it('offers only review times the firmware keeps', () => {
    expect(REVIEW_OPTIONS.map((o) => o.label)).toEqual(['3 s', 'Until you tap']);
    expect(REVIEW_OPTIONS.map((o) => o.label as string)).not.toContain('6 s');
    expect(reviewLabel(-1)).toBe('Until you tap');
    expect(shutterName('cheap-digi', [])).toBe('Cheap digi');
  });

  it('says Saved, KINO adjusted this, or offers a retry', () => {
    expect(markFor({ differs: false })).toBe('Saved');
    expect(markFor({ differs: true })).toBe('KINO adjusted this.');
    expect(markFor({ failed: true })).toBe("KINO didn't save this.");
  });

  it('shows three words at rest and the scale, the looks or More on demand', () => {
    const base = {
      setOpen: noop, recipes, lookId: 'party-neg', lookName: 'Party Neg', feel: 'Normal' as const, bounce: false, shutter: 'cheap-digi', sounds: [], review: 3, readOnly: false, mark: null,
      onPreviewLook: noop, onChooseLook: noop, onMoreLooks: noop, onPreviewFeel: noop, onChooseFeel: noop, onBounce: noop, onShutter: noop, onPlay: noop, onReview: noop,
    };
    const rest = renderToStaticMarkup(createElement(WiggleLine, { ...base, open: 'none' }));
    expect(rest).toContain('>Party Neg<');
    expect(rest).toContain('>Normal<');
    expect(rest).toContain('>More<');
    expect(rest).not.toContain('Dreamy');
    expect(rest).not.toContain('Left to right');
    const feel = renderToStaticMarkup(createElement(WiggleLine, { ...base, open: 'feel' }));
    for (const f of FEELS) expect(feel).toContain(`>${f.name}<`);
    expect(feel).toContain('aria-checked="true"');
    const more = renderToStaticMarkup(createElement(WiggleLine, { ...base, open: 'more' }));
    expect(more).toContain('Back and forth');
    expect(more).toContain('Show the photo for');
    expect(more).toContain('>Less<');
    expect(more).not.toContain('6 s');
  });
});

describe('Quad', () => {
  const party = QUAD_SETS.find((s) => s.name === 'Party')!;

  it('names the set the slots match and nothing when they match none', () => {
    expect(matchingSet(party.slots)).toBe('Party');
    const changed: QuadConfig['slots'] = { ...party.slots, cam2: { ...party.slots.cam2, recipeId: 'vivid' } };
    expect(matchingSet(changed)).toBeNull();
  });

  it('puts the editor under the lens axis and labels brightness only while dragging', () => {
    expect(editorLeft(364)).toBe(304);
    expect(biasLabel(0.3)).toBe('+0.3');
    expect(biasLabel(-1.2)).toBe('-1.2');
    expect(biasLabel(0)).toBe('0.0');
  });

  it('renders Colour · B&W only when the camera has it, and never a numeric label at rest', () => {
    const base = {
      index: 1, axisX: 364, slot: party.slots.cam2, recipe: recipes.find((r) => r.id === 'motion') ?? null, recipes, lookOpen: false, dragValue: null, readOnly: false, mark: null,
      onToggleLook: noop, onPreviewLook: noop, onChooseLook: noop, onMoreLooks: noop, onDrag: noop, onCommitBias: noop, onColour: noop,
    };
    const withColour = renderToStaticMarkup(createElement(QuadEditor, { ...base, colourSupported: true }));
    expect(withColour).toContain('B&amp;W');
    expect(withColour).toContain('Darker');
    expect(withColour).toContain('Brighter');
    expect(withColour).not.toContain('EV');
    expect(withColour).not.toContain('c-slider-tip');
    expect(withColour).toContain('aria-label="Darker or brighter, centre-left lens"');
    const without = renderToStaticMarkup(createElement(QuadEditor, { ...base, colourSupported: false }));
    expect(without).not.toContain('B&amp;W');
    const dragging = renderToStaticMarkup(createElement(QuadEditor, { ...base, colourSupported: true, dragValue: 0.3 }));
    expect(dragging).toContain('+0.3');
  });

  it('carries four looks per set, one per lens', () => {
    for (const set of QUAD_SETS) {
      expect(Object.keys(set.slots)).toEqual(['cam1', 'cam2', 'cam3', 'cam4']);
    }
    expect(QUAD_SETS.map((s) => s.name)).toEqual(['Film Four', 'Chaos', 'Raw Four', 'Party']);
  });
});

describe('Looks', () => {
  it('orders the current look first and caps the inline set at six', () => {
    const inline = recentLooks(recipes, 'mono');
    expect(inline[0]!.id).toBe('mono');
    expect(inline.length).toBe(6);
  });

  it('splits built-in from yours and makes a built-in yours with a copy', () => {
    const { builtIn, yours } = splitLooks(recipes);
    expect(builtIn.length).toBe(recipes.length);
    expect(yours).toEqual([]);
    const source = recipes.find((r) => r.id === 'party-neg')!;
    const copy = yoursCopy(source, recipes);
    expect(copy.name).toBe('Party Neg (yours)');
    expect(copy.id).toBe('party-neg-yours');
    expect(copy.factory).toBe(false);
    const again = yoursCopy(source, [...recipes, copy]);
    expect(again.id).toBe('party-neg-yours-2');
    expect(again.name).toBe('Party Neg (yours) 2');
    expect(duplicateOf(source, recipes).name).toBe('Party Neg copy');
  });

  it('changes only the five customer fields and previews as a CSS filter', () => {
    const source = recipes.find((r) => r.id === 'party-neg')!;
    const warmer = withLookValue(source, 'temperature', 200);
    expect(warmer.look.temperature).toBe(200);
    expect(warmer.capture).toEqual(source.capture);
    expect(lookCssFilter(warmer)).toContain('sepia');
    expect(lookCssFilter(source, true)).toContain('saturate(0)');
    expect(lookCssFilter(null)).toBe('none');
    expect(lookCharacter(source).length).toBeGreaterThan(5);
  });
});
