import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8');

function token(name: string): string {
  const value = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)?.[1];
  if (value === undefined) throw new Error(`Missing hex token --${name}`);
  return value;
}

function luminance(hex: string): number {
  const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('shared colour-token acceptance', () => {
  it.each([
    ['text', 'panel'],
    ['text-mut', 'panel'],
    ['text-faint', 'panel'],
    ['text-on-dark', 'well-dark'],
  ])('%s remains WCAG AA on %s', (foreground, background) => {
    expect(contrast(token(foreground), token(background))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['green-dark', 'orange-dark', 'red-dark', 'blue-dark'])(
    '%s status mark remains distinguishable on a panel',
    (foreground) => {
      expect(contrast(token(foreground), token('panel'))).toBeGreaterThanOrEqual(3);
    },
  );

  it('keeps white button labels readable at the lightest gradient stops', () => {
    expect(contrast(token('text-inv'), '#3576cc')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('text-inv'), token('red'))).toBeGreaterThanOrEqual(4.5);
  });
});
