// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadFailure } from '../src/components/LoadFailure';
import { setRouteMeta } from '../src/meta';
import { LandingPage } from '../src/pages/LandingPage';
import { NoCapturePage, NoRollPage } from '../src/pages/NotFoundPage';
import { PinGate } from '../src/pages/PinGate';
import {
  indexSize,
  markGranularity,
  rowEstimate,
  streamItems,
  timeIndex,
  type StreamItem,
} from '../src/pages/RollFeedPage';
import type { CaptureView, RollApi } from '../src/api/client';

const reactTestGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

const CSS = readFileSync(resolve(__dirname, '../src/roll.css'), 'utf8');
/** The same stylesheet with its comments removed: what the browser paints. */
const PAINTED = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declaration block of one selector, so a rule can be asserted on directly. */
function ruleFor(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  const inline = CSS.indexOf(`\n${selector} { `);
  const start = at === -1 ? inline : at;
  if (start === -1) throw new Error(`no rule for ${selector}`);
  return CSS.slice(start, CSS.indexOf('}', start) + 1);
}

function apiStub(): RollApi {
  return {
    getRoll: vi.fn(),
    submitPin: vi.fn(),
    listCaptures: vi.fn(),
    getCapture: vi.fn(),
    assetUrl: (id) => `/api/assets/${id}/content`,
    react: vi.fn(),
    requestRender: vi.fn(),
    events: vi.fn(),
  };
}

describe('the wordmark on the dark gate', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    localStorage.clear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  /**
   * The bug: `.k-gate .k-mark` carried `filter: invert(1)` and the gate uses
   * `kino-roll-light.png`, which is ALREADY the light-ink artwork. Inverting
   * it painted the mark black on a #0b0b0c page — an invisible logo on the
   * first screen a guest ever sees.
   *
   * The mark is an image, so its "computed colour" is the ink of the file it
   * points at, modified by any filter. This asserts both halves: the file is
   * the light one, and nothing inverts it.
   */
  it('paints ink that is not the page ground', async () => {
    const rule = ruleFor('.k-gate .k-mark');
    expect(rule).not.toContain('invert');
    expect(/filter\s*:/.test(rule)).toBe(false);

    await act(async () => {
      root.render(<PinGate slug="party" onUnlocked={vi.fn()} api={apiStub()} />);
    });
    const mark = container.querySelector<HTMLImageElement>('.k-gate .k-mark');
    expect(mark).not.toBeNull();
    // The LIGHT-ink asset. The dark one is the header plate's, where the
    // surface under it is #dedbd4.
    expect(mark?.getAttribute('src')).toContain('kino-roll-light');
    expect(mark?.getAttribute('src')).not.toContain('kino-roll-dark');
    expect(mark?.getAttribute('alt')).toBe('KINO Roll');
  });

  it('uses the same mark on the landing page', async () => {
    await act(async () => {
      root.render(<LandingPage onOpen={vi.fn()} lastRoll={null} />);
    });
    expect(container.querySelector<HTMLImageElement>('.k-mark')?.getAttribute('src')).toContain('kino-roll-light');
    // The keyboard must not cover "Scan the code on the camera to join".
    expect(container.querySelector('#roll-code')?.hasAttribute('autofocus')).toBe(false);
  });
});

describe('text tokens', () => {
  /**
   * `--k-faint` was #726f69: 3.93:1 on the ground, below AA. Everything that
   * used it — the exif labels, the day mark, the gate labels — failed with
   * it. It is lifted; nothing under 0.6875rem may use it, because a 4.7:1
   * grey at 10px is a smear whatever the number says.
   */
  it('lifts --k-faint and keeps it off anything under 11px', () => {
    expect(PAINTED).toContain('--k-faint: #7f7c75;');

    // The failing inks the audit named, no longer painted anywhere. Only the
    // comment that records what they were may still mention them.
    for (const dead of ['#726f69', '#3a3a38', '#74716b', '#8d8a83']) {
      expect(PAINTED, `${dead} still painted somewhere`).not.toContain(dead);
    }

    // Every rule that names --k-faint, and the size it sets.
    const offenders: string[] = [];
    for (const match of PAINTED.matchAll(/\n([^\n{}]+)\{([^}]*var\(--k-faint\)[^}]*)\}/g)) {
      const size = /font-size:\s*([0-9.]+)rem/.exec(match[2] ?? '');
      if (size !== null && Number(size[1]) < 0.6875) offenders.push(match[1]?.trim() ?? '');
    }
    expect(offenders).toEqual([]);
  });

  /** 200% root font size has to move the text; px does not. */
  it('sets every text size in rem, and keeps px for hairlines only', () => {
    const sizes = [...CSS.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1]?.trim() ?? '');
    expect(sizes.length).toBeGreaterThan(30);
    expect(sizes.filter((size) => size.endsWith('px'))).toEqual([]);
    const shorthand = [...CSS.matchAll(/font:\s*(?!inherit)([^;]+);/g)].map((m) => m[1] ?? '');
    expect(shorthand.filter((value) => /\d px|\dpx/.test(value))).toEqual([]);
  });
});

describe('the time index', () => {
  function clock(label: string, at: string): StreamItem {
    return { kind: 'clock', key: `t_${at}`, label, at };
  }
  function day(label: string, at: string): StreamItem {
    return { kind: 'day', key: `d_${at}`, label, at };
  }
  const row: StreamItem = { kind: 'row', key: 'r_1', captures: [] };

  it('offers the first stream row of each hour it has loaded, under its day', () => {
    const items: StreamItem[] = [
      day('05.09.26', '2026-09-05T21:40:00'),
      clock('21:40', '2026-09-05T21:40:00'),
      row,
      clock('21:12', '2026-09-05T21:12:00'),
      row,
      clock('20:59', '2026-09-05T20:59:00'),
      row,
    ];
    const days = timeIndex(items);
    expect(days).toHaveLength(1);
    expect(days[0]?.label).toBe('05.09.26');
    // The DAY's own index is the day row; each hour's is the first clock mark
    // of that hour, which is the row a jump has to land on.
    expect(days[0]?.index).toBe(0);
    expect(days[0]?.hours.map((hour) => [hour.label, hour.index])).toEqual([
      ['21:00', 1],
      ['20:00', 5],
    ]);
    expect(indexSize(days)).toBe(2);
  });

  /**
   * The day is a heading now, not six characters repeated on every key. It
   * used to be printed inline on each chip, and only when the roll happened
   * to cross midnight.
   */
  it('starts a new day whenever the stream does', () => {
    const days = timeIndex([
      day('06.09.26', '2026-09-06T00:20:00'),
      clock('00:20', '2026-09-06T00:20:00'),
      row,
      day('05.09.26', '2026-09-05T23:40:00'),
      clock('23:40', '2026-09-05T23:40:00'),
      row,
    ]);
    expect(days.map((entry) => [entry.label, entry.hours.map((hour) => hour.label)])).toEqual([
      ['06.09.26', ['00:00']],
      ['05.09.26', ['23:00']],
    ]);
  });

  it('ignores rows and unparseable marks, and drops a day with no hours', () => {
    expect(timeIndex([row, { kind: 'clock', key: 't', label: '', at: 'not a time' }])).toEqual([]);
    expect(timeIndex([day('05.09.26', '2026-09-05T21:00:00'), row])).toEqual([]);
    expect(indexSize([])).toBe(0);
  });
});

/**
 * Defect 1. The first row of the feed printed `shortDate(roll.createdAt)` —
 * the ROLL's birthday — beside a capture taken on a different day, and a roll
 * spanning ten days had no boundary in it anywhere. Days come from each
 * capture's own `capturedAt` now.
 */
describe('day boundaries in the stream', () => {
  function capture(id: string, at: string): CaptureView {
    return {
      captureId: id,
      mode: 'quad',
      look: null,
      capturedAt: at,
      createdAt: at,
      frameCount: 4,
      resolution: '1600x1200',
      status: 'complete',
      playback: null,
      assets: [],
    };
  }

  it('marks every calendar day the loaded captures cross', () => {
    const items = streamItems(
      [
        capture('c1', '2026-09-07T03:05:00'),
        capture('c2', '2026-09-05T22:03:00'),
        capture('c3', '2026-09-05T22:03:30'),
      ],
      1,
    );
    expect(items.map((item) => `${item.kind}:${item.kind === 'row' ? String(item.captures.length) : item.label}`))
      .toEqual(['day:07.09.26', 'clock:03:05', 'row:1', 'day:05.09.26', 'clock:22:03', 'row:1', 'row:1']);
  });

  /**
   * Defect: on more than one column a mark per MINUTE broke the row after
   * every tile, so a 1440 px desktop feed was one left-hand column with two
   * thirds of the screen black. Above one column the mark is the hour.
   */
  it('files captures under the hour once a row can hold more than one', () => {
    expect(markGranularity(1)).toBe('minute');
    expect(markGranularity(3)).toBe('hour');
    const items = streamItems(
      [
        capture('c1', '2026-09-05T22:31:00'),
        capture('c2', '2026-09-05T22:14:00'),
        capture('c3', '2026-09-05T22:02:00'),
      ],
      3,
    );
    expect(items.map((item) => item.kind)).toEqual(['day', 'clock', 'row']);
    expect(items[1]).toMatchObject({ kind: 'clock', label: '22:00' });
    expect(items[2]).toMatchObject({ kind: 'row' });
    expect((items[2] as { captures: CaptureView[] }).captures).toHaveLength(3);
  });
});

describe('the virtualiser estimate', () => {
  /**
   * 220 px flat against a real ~300 px row made the scrollbar a lie and the
   * page grow under a scrolled thumb as each page measured itself. A tile is
   * 4:3, so its height follows from the width it was given and nothing else.
   */
  it('derives a row from the measured column width', () => {
    // One column on a 390 px phone: 390 * 0.75 + the row hairline.
    expect(rowEstimate(390, 1)).toBe(294);
    // Three columns of a 900 px stream: 300 wide, 225 tall.
    expect(rowEstimate(900, 3)).toBe(226);
    // Four columns of the same: half the height, so half the total.
    expect(rowEstimate(900, 4)).toBe(170);
    // Never zero or negative, whatever it is handed before the first measure.
    expect(rowEstimate(0, 0)).toBeGreaterThan(0);
  });
});

describe('copy', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('tells a guest the PHOTO is gone, not the roll, and offers the roll', async () => {
    await act(async () => {
      root.render(<NoCapturePage slug="RRG8AZ" />);
    });
    // Headings on the guest surface carry no full stop — "Open a roll",
    // "No roll here" — and this one used to be the only sentence among them.
    expect(container.querySelector('h1')?.textContent).toBe('This photograph is gone');
    expect(container.textContent).toContain('The host removed it.');
    expect(container.textContent).not.toContain('No roll here');
    // A dead end has to offer the one move that makes sense, as a key rather
    // than as body text: the same plate control the gates use.
    const out = container.querySelector('a.k-gate-act');
    expect(out?.getAttribute('href')).toBe('/r/RRG8AZ');
    expect(out?.textContent?.trim()).toBe('Back to the roll');
    // ...and the mark, so a guest can tell which app they landed in.
    expect(container.querySelector<HTMLImageElement>('.k-mark')?.src).toContain('kino-roll-light');
  });

  it('keeps the roll-level 404 for a roll that is actually gone', async () => {
    await act(async () => {
      root.render(<NoRollPage />);
    });
    expect(container.querySelector('h1')?.textContent).toBe('No roll here');
  });

  /**
   * A phone that knows it is offline should not be told to check its
   * connection — it already did.
   */
  it('says offline instead of blaming the connection', async () => {
    await act(async () => {
      root.render(<LoadFailure onRetry={vi.fn()} offline what="photo" />);
    });
    expect(container.textContent).toContain("You're offline. This photo has not been loaded yet.");
    expect(container.textContent).not.toContain('Check the connection');

    await act(async () => {
      root.render(<LoadFailure onRetry={vi.fn()} what="photo" />);
    });
    expect(container.textContent).toContain('Could not reach the roll. Check the connection.');
  });
});

describe('link previews', () => {
  it('writes og tags a messenger reads, and leaves noindex alone', () => {
    document.head.innerHTML = '<meta name="robots" content="noindex, nofollow" />';
    setRouteMeta({
      title: 'Loft · 21:40 — KINO Roll',
      description: 'One capture from a KINO D4, 4 frames.',
      image: 'http://localhost/api/assets/asset_x/content',
    });

    const content = (selector: string): string | null =>
      document.head.querySelector<HTMLMetaElement>(selector)?.content ?? null;

    expect(document.title).toBe('Loft · 21:40 — KINO Roll');
    expect(content('meta[property="og:title"]')).toBe('Loft · 21:40 — KINO Roll');
    expect(content('meta[property="og:description"]')).toBe('One capture from a KINO D4, 4 frames.');
    expect(content('meta[property="og:image"]')).toBe('http://localhost/api/assets/asset_x/content');
    expect(content('meta[name="twitter:card"]')).toBe('summary_large_image');
    // Unlisted stays unlisted: a preview is not an invitation to index.
    expect(content('meta[name="robots"]')).toBe('noindex, nofollow');

    // A second route replaces the tags rather than stacking a second set.
    setRouteMeta({ title: 'Loft — KINO Roll', description: '1918 frames from a KINO D4.' });
    expect(document.head.querySelectorAll('meta[property="og:title"]')).toHaveLength(1);
    expect(content('meta[property="og:title"]')).toBe('Loft — KINO Roll');
    expect(content('meta[name="twitter:card"]')).toBe('summary');
  });
});
