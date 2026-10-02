// #230: the front of KINO is drawn from the released field body, at one
// scale, with the cells nearly touching. These are the numbers the drawing
// has to hold or it turns back into a diagram.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { bodyGeometry, cellDiameterMm, LENS_PITCH_MM, lensCentresMm, lensPhrase, scaleToFit } from '../src/customer/physical/fieldBody';
import { KinoFront } from '../src/customer/physical/KinoFront';
import { shootLayout, stageVars } from '../src/customer/shoot/shootLayout';

describe('field-body geometry', () => {
  it('draws the released lens row: 22 mm pitch, cells nearly touching', () => {
    expect(lensCentresMm()).toEqual([32.5, 54.5, 76.5, 98.5]);
    expect(cellDiameterMm() / LENS_PITCH_MM).toBeCloseTo(0.84, 2);
  });

  it('at 5.5 px/mm the body is 720 × 495 with Ø101 cells at 121 px pitch', () => {
    const g = bodyGeometry(5.5);
    expect(Math.round(g.w)).toBe(721);
    expect(Math.round(g.h)).toBe(495);
    expect(Math.round(g.cellD)).toBe(101);
    expect(Math.round(g.cellXs[1] - g.cellXs[0])).toBe(121);
    // The lens axis is 43 mm up from the bottom edge.
    expect(Math.round(g.cellY)).toBe(Math.round((90 - 43) * 5.5));
  });

  it('puts the cover below the lenses when open and over them when closed, 21.4 mm apart', () => {
    const g = bodyGeometry(5.5);
    const open = g.cover.open;
    const closed = g.cover.closed;
    expect(open.y).toBeGreaterThan(g.cellY + g.cellD / 2);
    expect(closed.y).toBeLessThan(g.cellY);
    expect(closed.y + closed.h).toBeGreaterThan(g.cellY);
    expect(open.y - closed.y).toBeCloseTo(21.4 * 5.5, 1);
  });

  it('follows a reported pitch, keeping the row centred and the web constant', () => {
    const g = bodyGeometry(5.5, 19);
    expect(g.cellXs[1] - g.cellXs[0]).toBeCloseTo(19 * 5.5, 3);
    expect(g.cellD).toBeCloseTo((19 - 3.6) * 5.5, 3);
    expect((g.cellXs[0] + g.cellXs[3]) / 2).toBeCloseTo(65.5 * 5.5, 3);
  });

  it('fits the body to a width without exceeding the desktop scale', () => {
    expect(scaleToFit(720)).toBeCloseTo(5.496, 2);
    expect(scaleToFit(2000)).toBe(5.5);
  });

  it('names lenses by position', () => {
    expect(lensPhrase(1)).toBe('the centre-left lens');
    expect(lensPhrase(3)).toBe('the right lens');
  });
});

describe('the drawing', () => {
  it('renders four cells as buttons with physical names when they do something', () => {
    const html = renderToStaticMarkup(
      createElement(KinoFront, {
        pxPerMm: 5.5,
        cover: 'open',
        cells: [0, 1, 2, 3].map((i) => ({ url: null, label: ['Left', 'Centre-left', 'Centre-right', 'Right'][i] + ' lens, Motion look', onClick: () => undefined })),
      }),
    );
    expect(html.match(/<button[^>]*class="c-cell/g)?.length).toBe(4);
    expect(html).toContain('aria-label="Centre-left lens, Motion look"');
    // Bores only where there is no photograph; no bore over an image.
    expect(html.match(/c-front-bore/g)?.length).toBe(4);
  });

  it('draws the cover closed over the cells on No KINO with no cell buttons', () => {
    const html = renderToStaticMarkup(createElement(KinoFront, { pxPerMm: 5.5, cover: 'closed', cells: null, showUsb: true }));
    expect(html).not.toContain('c-cell ');
    expect(html).toContain('c-front-usb');
    expect(html).toContain('c-front-mark');
  });
});

describe('Shoot layout', () => {
  it('keeps full scale with the result beside the body at 1232 px of content', () => {
    expect(shootLayout(1232)).toEqual({ pxPerMm: 5.5, resultW: 456, stacked: false });
  });

  it('stacks the result under the body when the width cannot hold both', () => {
    const narrow = shootLayout(700);
    expect(narrow.stacked).toBe(true);
    expect(narrow.pxPerMm).toBeLessThanOrEqual(5.5);
  });

  it('exposes the bar edge and the lens span as CSS variables', () => {
    const vars = stageVars(shootLayout(1232));
    expect(vars['--body-w']).toBe('720.5px');
    expect(vars['--bar-x']).toBe('89px');
    expect(Number.parseInt(vars['--scale-w']!, 10)).toBeGreaterThan(400);
  });
});
