// A look, approximated as a CSS filter so a photograph on screen can be
// shown "through" it without a canvas. The real render happens on the
// camera; this is the same approximation utils/lookPreview.ts paints, moved
// onto an <img> so the last photo and the cells can carry it.

import type { Recipe } from '../../recipes/recipeTypes';

export function lookCssFilter(recipe: Recipe | null | undefined, mono = false, exposureBias = 0): string {
  if (!recipe) return mono ? 'grayscale(1)' : 'none';
  const look = recipe.look;
  const bias = recipe.capture.exposureBias + exposureBias;
  const brightness = Math.max(0.5, 1 + bias * 0.16 - look.blackPoint * 0.004);
  const parts = [`contrast(${look.contrast})`, `saturate(${mono ? 0 : look.saturation})`, `brightness(${brightness.toFixed(3)})`];
  // Temperature as a hue shift is crude; sepia carries warmth better on a photo.
  if (!mono && look.temperature > 0) parts.push(`sepia(${Math.min(0.45, look.temperature / 400)})`);
  if (!mono && look.temperature < 0) parts.push(`hue-rotate(${Math.max(-18, look.temperature / 25)}deg)`);
  return parts.join(' ');
}

/** "warm skin, cyan shadows, higher contrast." — the look's own line, or one read off its numbers. */
export function lookCharacter(recipe: Recipe): string {
  const given = recipe.description?.trim();
  if (given) return given;
  const look = recipe.look;
  const bits: string[] = [];
  bits.push(look.temperature > 60 ? 'warm' : look.temperature < -60 ? 'cool' : 'neutral');
  if (look.saturation === 0) bits.push('black and white');
  else if (look.saturation > 1.15) bits.push('strong colour');
  else if (look.saturation < 0.85) bits.push('faded colour');
  if (look.contrast > 1.15) bits.push('higher contrast');
  else if (look.contrast < 0.95) bits.push('soft contrast');
  if (look.grain > 0.15) bits.push('grain');
  if (look.vignette > 0.1) bits.push('dark corners');
  return bits.join(', ') + '.';
}
