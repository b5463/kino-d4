// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureDetail as CaptureView, RollApi, RollView } from '../src/api/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { aspectOf, CaptureDetail, frameSource, heroStill, initialQuadFrame, quadRatio } from '../src/pages/CaptureDetail';
import { readPicks } from '../src/state/picks';

const reactTestGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

/** `frameIndex` is the 1-based CAMERA NUMBER on the wire, never a 0-based slot. */
function capture(mode: string, frameCount: number, cameras?: number[]): CaptureView {
  const numbers = cameras ?? Array.from({ length: frameCount }, (_unused, index) => index + 1);
  return {
    captureId: 'cap_1',
    mode,
    look: 'CLASSIC',
    capturedAt: '2026-08-14T20:00:00.000Z',
    createdAt: '2026-08-14T20:00:01.000Z',
    frameCount,
    resolution: '1600x1200',
    status: 'ready',
    playback: null,
    reactionCount: 2,
    reacted: false,
    assets: numbers.map((camera) => ({
      role: 'original-frame',
      assetId: `asset_${String(camera)}`,
      frameIndex: camera,
      mime: 'image/jpeg',
      bytes: 100,
      width: 1600,
      height: 1200,
    })),
  };
}

function roll(overrides: Partial<RollView> = {}): RollView {
  return {
    title: 'Friday party',
    status: 'live',
    photoCount: 1,
    downloadsEnabled: true,
    reactionsEnabled: true,
    createdAt: '2026-08-14T19:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

function api(overrides: Partial<RollApi> = {}): RollApi {
  return {
    getRoll: vi.fn(),
    submitPin: vi.fn(),
    listCaptures: vi.fn(),
    getCapture: vi.fn(),
    assetUrl: (id, options) => `/api/assets/${id}/content${options?.download ? '?download=1' : ''}`,
    react: vi.fn(),
    requestRender: vi.fn(),
    events: vi.fn(),
    ...overrides,
  };
}

describe('CaptureDetail', () => {
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
    vi.restoreAllMocks();
  });

  async function render(view: CaptureView, rollView: RollView, client = api()): Promise<void> {
    await act(async () => {
      root.render(<CaptureDetail slug="party" capture={view} roll={rollView} api={client} />);
    });
  }

  it('hides the download control entirely when the host disabled downloads', async () => {
    await render(capture('single', 1), roll({ downloadsEnabled: false }));
    expect(container.textContent).not.toContain('Download');
    expect(container.querySelector('a[download]')).toBeNull();
  });

  /**
   * The old name ("renders recipe labels beneath every Quad camera frame")
   * described a thing the guest wire cannot support: `look` is one value for
   * the whole capture, so the four labels were one look printed four times and
   * called a per-camera recipe.
   */
  it('numbers each Quad frame by camera and prints the capture look once', async () => {
    await render(capture('quad', 4), roll());
    const figures = container.querySelectorAll('figure');
    expect(figures).toHaveLength(4);
    expect([...figures].map((figure) => figure.querySelector('figcaption')?.textContent)).toEqual([
      'CAM 1',
      'CAM 2',
      'CAM 3',
      'CAM 4',
    ]);
    expect(container.querySelectorAll('.photo-look')).toHaveLength(1);
    expect(container.querySelector('.photo-look')?.textContent).toBe('CLASSIC');
  });

  it('names a sparse capture by camera number, not by array slot', async () => {
    // Cameras 1, 3 and 4 answered; camera 2 did not. Three assets, frameIndex
    // 1, 3, 4 — the labels must say CAM 1 / CAM 3 / CAM 4, never CAM 1/2/3.
    await render(capture('wiggle', 3, [1, 3, 4]), roll());

    const thumbs = [...container.querySelectorAll<HTMLButtonElement>('.frame-thumb')];
    expect(thumbs.map((thumb) => thumb.querySelector('span')?.textContent)).toEqual(['CAM 1', 'CAM 3', 'CAM 4']);
    expect(thumbs.map((thumb) => thumb.getAttribute('aria-label'))).toEqual([
      'CAM 1 frame',
      'CAM 3 frame',
      'CAM 4 frame',
    ]);
    // The playhead slot is the frame's place in the stored list, 0..2.
    expect(thumbs.map((thumb) => thumb.getAttribute('data-slot'))).toEqual(['0', '1', '2']);
    expect(container.querySelector('.k-exif')?.textContent).toContain('1, 3, 4');

    // Pinning the middle thumb shows camera 3, and says so.
    await act(async () => thumbs[1]?.click());
    expect(container.querySelector('.k-exif')?.textContent).toContain('CAM 3');
  });

  it('sorts frames by frameIndex whatever order the API listed them in', async () => {
    const view = capture('quad', 4);
    view.assets = [...view.assets].reverse();
    await render(view, roll());
    expect([...container.querySelectorAll('figcaption')].map((caption) => caption.textContent)).toEqual([
      'CAM 1',
      'CAM 2',
      'CAM 3',
      'CAM 4',
    ]);
  });

  it('shows a 3 OF 4 chip on a partial capture and keeps the player', async () => {
    const view = capture('wiggle', 3, [1, 3, 4]);
    view.status = 'partial';
    await render(view, roll());
    expect(container.querySelector('.k-chip')?.textContent).toBe('3 OF 4');
    expect(container.querySelector('[data-wiggle-player]')).not.toBeNull();
  });

  it('shows FAILED and mounts no player on a failed capture', async () => {
    const view = capture('wiggle', 4);
    view.status = 'failed';
    await render(view, roll());
    expect(container.querySelector('.k-chip')?.textContent).toBe('FAILED');
    expect(container.querySelector('[data-wiggle-player]')).toBeNull();
    expect(container.querySelector('.frame-strip')).toBeNull();
  });

  it('replaces a broken hero image with the placeholder and retries once', async () => {
    const view = capture('single', 1);
    view.assets = [
      ...view.assets,
      { role: 'kino-still', assetId: 'asset_1', frameIndex: null, mime: 'image/webp', bytes: 9, width: 1280, height: 960 },
    ];
    await render(view, roll());
    const img = container.querySelector<HTMLImageElement>('.k-hero img');
    expect(img).not.toBeNull();
    await act(async () => img?.dispatchEvent(new Event('error')));
    expect(container.querySelector('.k-img-missing')?.textContent).toContain('Image unavailable');

    const retry = container.querySelector<HTMLButtonElement>('.k-img-missing button');
    expect(retry?.textContent).toBe('Retry');
    await act(async () => retry?.click());
    expect(container.querySelector<HTMLImageElement>('.k-hero img')?.getAttribute('src')).toBe(
      '/api/assets/asset_1/content',
    );

    // Once. A second failure is just the placeholder.
    await act(async () => container.querySelector('.k-hero img')?.dispatchEvent(new Event('error')));
    expect(container.querySelector('.k-img-missing button')).toBeNull();
  });

  it('derives three grid columns for a six-frame Quad instead of hard-coding two', async () => {
    await render(capture('quad', 6), roll());
    const grid = container.querySelector('[aria-label="Quad frames"]');
    expect(grid?.getAttribute('data-columns')).toBe('3');
    expect((grid as HTMLElement | null)?.style.gridTemplateColumns).toContain('repeat(3');
  });

  it('copies the capture link when native sharing is unavailable', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await render(capture('single', 1), roll());

    // Sharing lives in the save sheet now — one place for getting a capture out.
    await openSaveSheet();
    const share = container.querySelector<HTMLButtonElement>('button[aria-label="Share"]');
    await act(async () => share?.click());

    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(container.textContent).toContain('Link copied');
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
  });

  /**
   * Save controls live behind one SAVE button now (issue #114), so a test
   * that wants one has to open the sheet first. Each row is `LABEL` plus a
   * quiet hint (`1600x1200`, `MP4`, `STORY`), hence the prefix match.
   */
  async function openSaveSheet(): Promise<void> {
    if (container.querySelector('.k-sheet') !== null) return;
    const save = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save',
    );
    await act(async () => save?.click());
  }

  /** Re-rendering rebuilds the page with the sheet shut, so reopen it. */
  async function reopenSaveSheet(): Promise<void> {
    const veil = container.querySelector<HTMLButtonElement>('.k-veil');
    if (veil) await act(async () => veil.click());
    await openSaveSheet();
  }

  function findAction(label: string): HTMLElement | undefined {
    return Array.from(container.querySelectorAll<HTMLElement>('a.action-link, button.action-link')).find(
      (element) => (element.textContent ?? '').startsWith(label),
    );
  }

  it('SAVE PHOTO downloads a still, never the animated preferred asset', async () => {
    const view = capture('wiggle', 4);
    view.assets = [
      ...view.assets,
      { role: 'wiggle-webp', assetId: 'asset_webp', frameIndex: null, mime: 'image/webp', bytes: 9, width: 960, height: 720 },
      { role: 'kino-still', assetId: 'asset_still', frameIndex: null, mime: 'image/webp', bytes: 9, width: 1280, height: 960 },
    ];
    await render(view, roll());
    await openSaveSheet();

    const save = findAction('Original');
    expect(save?.getAttribute('href')).toBe('/api/assets/asset_still/content?download=1');
    expect(save?.hasAttribute('download')).toBe(true);
  });

  it('SAVE WIGGLE downloads the MP4 when it already exists', async () => {
    const view = capture('wiggle', 4);
    view.assets = [
      ...view.assets,
      { role: 'wiggle-mp4', assetId: 'asset_mp4', frameIndex: null, mime: 'video/mp4', bytes: 9, width: 960, height: 720 },
    ];
    await render(view, roll());
    await openSaveSheet();

    expect(findAction('Wiggle')?.getAttribute('href')).toBe(
      '/api/assets/asset_mp4/content?download=1',
    );
  });

  it('SAVE WIGGLE requests a render and shows Rendering… until the asset arrives', async () => {
    const requestRender = vi.fn().mockResolvedValue(undefined);
    const client = api({ requestRender });
    const view = capture('wiggle', 4);
    await render(view, roll(), client);
    await openSaveSheet();

    const save = findAction('Wiggle');
    expect(save?.tagName).toBe('BUTTON');
    await act(async () => save?.click());

    expect(requestRender).toHaveBeenCalledWith('party', 'cap_1', 'wiggle-mp4');
    expect(findAction('Wiggle')?.textContent).toContain('Preparing…');

    // The SSE replace path hands the component a refreshed capture that now
    // carries the MP4 — the pending state resolves into a download link.
    const finished = capture('wiggle', 4);
    finished.assets = [
      ...finished.assets,
      { role: 'wiggle-mp4', assetId: 'asset_mp4', frameIndex: null, mime: 'video/mp4', bytes: 9, width: 960, height: 720 },
    ];
    await render(finished, roll(), client);
    await reopenSaveSheet();
    expect(findAction('Wiggle')?.getAttribute('href')).toBe(
      '/api/assets/asset_mp4/content?download=1',
    );
  });

  it('says so when a render request fails instead of silently reverting', async () => {
    const requestRender = vi.fn().mockRejectedValue(new Error('the render queue is full'));
    await render(capture('wiggle', 4), roll(), api({ requestRender }));
    await openSaveSheet();

    await act(async () => findAction('Wiggle')?.click());

    // The row goes back to being pressable — nothing is preparing — and the
    // page's status line carries the reason.
    expect(findAction('Wiggle')?.textContent).not.toContain('Preparing…');
    expect(container.querySelector('.k-status')?.textContent).toContain('the render queue is full');
  });

  it('SAVE WIGGLE is absent on a non-wiggle capture', async () => {
    await render(capture('single', 1), roll());
    await openSaveSheet();
    expect(findAction('Wiggle')).toBeUndefined();
  });

  it('the social format row requests the shared render job per format', async () => {
    const requestRender = vi.fn().mockResolvedValue(undefined);
    await render(capture('single', 1), roll(), api({ requestRender }));
    await openSaveSheet();

    for (const label of ['Story', 'Post', 'Square']) {
      expect(findAction(label)?.tagName).toBe('BUTTON');
    }
    await act(async () => findAction('Story')?.click());
    expect(requestRender).toHaveBeenCalledWith('party', 'cap_1', 'social-9x16');
  });

  it('a social format that already exists downloads directly', async () => {
    const view = capture('single', 1);
    view.assets = [
      ...view.assets,
      { role: 'social-1x1', assetId: 'asset_sq', frameIndex: null, mime: 'image/jpeg', bytes: 9, width: 1080, height: 1080 },
    ];
    await render(view, roll());
    await openSaveSheet();
    expect(findAction('Square')?.getAttribute('href')).toBe('/api/assets/asset_sq/content?download=1');
  });

  it('hides every save control when downloads are off', async () => {
    await render(capture('wiggle', 4), roll({ downloadsEnabled: false }));
    // No SAVE button at all, so the sheet cannot be reached.
    await openSaveSheet();
    expect(findAction('Original')).toBeUndefined();
    expect(findAction('WIGGLE')).toBeUndefined();
    expect(findAction('Story')).toBeUndefined();
  });

  it('keeps the photograph moving and its frames listed when saving is off', async () => {
    // Regression for issue #114: playback and the frame strip were gated on
    // `downloadsEnabled`, so a host turning saves off silently froze every
    // photograph and hid the four frames it was built from. A save permission
    // decides what leaves the phone, never what the guest can look at.
    await render(capture('wiggle', 4), roll({ downloadsEnabled: false }));

    expect(container.querySelector('[data-wiggle-player]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Original frame strip"]')).not.toBeNull();
    expect(container.querySelectorAll('.frame-thumb')).toHaveLength(4);
  });

  it('names the photograph with an h1 and keeps every control at 44 px', async () => {
    // The page used to have no h1 at all — its only heading was "D4 frames".
    await render(capture('wiggle', 4), roll());

    const h1 = container.querySelector('h1');
    expect(h1?.textContent).toContain('Friday party');

    for (const el of container.querySelectorAll<HTMLElement>('.k-acts > button, .k-bar')) {
      expect(el.className).not.toContain('action-link');
    }
  });

  it('renders and reconciles reactions only when the Roll enables them', async () => {
    const updated = { ...capture('single', 1), reactionCount: 3, reacted: true };
    const react = vi.fn().mockResolvedValue(undefined);
    const getCapture = vi.fn().mockResolvedValue(updated);
    await render(capture('single', 1), roll(), api({ react, getCapture }));

    localStorage.clear();
    const heart = container.querySelector('button[aria-label="Add heart"]') as HTMLButtonElement;
    await act(async () => heart.click());
    expect(react).toHaveBeenCalledWith('party', 'cap_1');
    expect(container.textContent).toContain('♥ 3');
    // The heart mirrors the server's `reacted` into the local picks set.
    expect(readPicks('party').has('cap_1')).toBe(true);

    await render(updated, roll({ reactionsEnabled: false }));
    expect(container.querySelector('button[aria-label*="heart"]')).toBeNull();
  });
});

/**
 * The phone report: on a 620 px portrait Android the quad rendered as four
 * ~150 px frames stacked top-left on a black page with the look label
 * floating beside them. The hero was a ROW flexbox and the quad handed it
 * three children. jsdom does no layout, so what is checked is the structure
 * the stylesheet lays out — one hero child, percentage widths, per-frame
 * ratios, the look as a caption row — and the stylesheet rules themselves.
 */
describe('CaptureDetail on a phone', () => {
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

  async function render(view: CaptureView): Promise<void> {
    await act(async () => {
      root.render(<CaptureDetail slug="party" capture={view} roll={roll()} api={api()} />);
    });
  }

  /** A thumb and a still next to the originals, the way a processed capture arrives. */
  function withDerivatives(view: CaptureView): CaptureView {
    view.assets = [
      ...view.assets,
      { role: 'thumb', assetId: 'asset_thumb', frameIndex: null, mime: 'image/webp', bytes: 9, width: 480, height: 360 },
      { role: 'kino-still', assetId: 'asset_still', frameIndex: null, mime: 'image/webp', bytes: 9, width: 1280, height: 960 },
    ];
    return view;
  }

  /**
   * And one thumb per camera on top of that — what a capture processed by the
   * current worker holds (`worker/src/jobs/thumbnail.ts`). Every camera gets
   * its OWN id, because the whole point is four different pictures.
   */
  function withFrameThumbs(view: CaptureView, cameras: number[] = [1, 2, 3, 4]): CaptureView {
    view.assets = [
      ...view.assets,
      ...cameras.map((camera) => ({
        role: 'thumb' as const,
        assetId: `asset_thumb_cam${String(camera)}`,
        frameIndex: camera,
        mime: 'image/webp',
        bytes: 40_000,
        width: 720,
        height: 540,
      })),
    ];
    return view;
  }

  it('hands the hero ONE child for a quad: the grid and the look row inside one wrap', async () => {
    await render(withDerivatives(capture('quad', 4)));
    const hero = container.querySelector('.k-hero');
    const children = [...(hero?.children ?? [])].filter((child) => !child.classList.contains('k-chip'));
    expect(children).toHaveLength(1);
    expect(children[0]?.className).toBe('photo-quad-wrap');

    const wrap = children[0] as HTMLElement;
    const grid = wrap.querySelector('.photo-quad');
    expect(grid?.getAttribute('data-columns')).toBe('2');
    expect((grid as HTMLElement).style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
    // The look is a caption row after the grid, inside the wrap — not a
    // sibling floating in the hero.
    expect(grid?.nextElementSibling?.className).toBe('photo-look');
    expect(wrap.querySelector('.photo-look')?.textContent).toBe('CLASSIC');
    // Width over height of a 2x2 of 4:3 frames, for the landscape height cap.
    expect(wrap.style.getPropertyValue('--quad-ratio')).toBe('1.3333');
  });

  /**
   * A capture processed before the per-camera thumbs existed — every capture
   * already on roll RRG8AZ. There is nothing small that depicts CAM 1, so the
   * cell falls back to CAM 1's original. Expensive, and correct: the earlier
   * attempt drew the capture-level `thumb` in all four cells and showed the
   * same camera four times under four different captions.
   */
  it('keeps a distinct ORIGINAL in every quad cell when there are no per-camera thumbs', async () => {
    await render(withDerivatives(capture('quad', 4)));
    const images = [...container.querySelectorAll<HTMLImageElement>('.photo-figure img')];
    expect(images.map((img) => img.getAttribute('src'))).toEqual([
      '/api/assets/asset_1/content',
      '/api/assets/asset_2/content',
      '/api/assets/asset_3/content',
      '/api/assets/asset_4/content',
    ]);
    for (const img of images) {
      expect(img.style.aspectRatio).toBe('1600 / 1200');
      expect(img.getAttribute('width')).toBe('1600');
      expect(img.getAttribute('height')).toBe('1200');
      // Behind the hero, and boxed before the bytes land.
      expect(img.getAttribute('loading')).toBe('lazy');
      expect(img.getAttribute('fetchpriority')).toBe('low');
    }
    expect([...container.querySelectorAll('figcaption')].map((c) => c.textContent)).toEqual(['CAM 1', 'CAM 2', 'CAM 3', 'CAM 4']);
    expect(container.querySelector('.photo-figure img[src*="asset_thumb"]')).toBeNull();
  });

  it('boxes every strip cell before its bytes arrive, and never blocks the hero', async () => {
    await render(withDerivatives(capture('quad', 4)));
    const strip = [...container.querySelectorAll<HTMLImageElement>('.frame-thumb img')];
    expect(strip.map((img) => img.getAttribute('src'))).toEqual([
      '/api/assets/asset_1/content',
      '/api/assets/asset_2/content',
      '/api/assets/asset_3/content',
      '/api/assets/asset_4/content',
    ]);
    for (const img of strip) {
      expect(img.style.aspectRatio).toBe('1 / 1');
      expect(img.getAttribute('loading')).toBe('lazy');
      expect(img.getAttribute('fetchpriority')).toBe('low');
    }
  });

  /**
   * The whole point of the per-camera thumbs: eight boxes, none wider than
   * 195 CSS px, drawn from eight ~40 kB WebPs instead of four 190 kB JPEGs —
   * and still four DIFFERENT pictures, one per camera, which is the property
   * the reverted client-only version broke.
   */
  it('draws the strip and the 2x2 from each camera OWN thumb when the worker made them', async () => {
    await render(withFrameThumbs(withDerivatives(capture('quad', 4))));

    const expected = [
      '/api/assets/asset_thumb_cam1/content',
      '/api/assets/asset_thumb_cam2/content',
      '/api/assets/asset_thumb_cam3/content',
      '/api/assets/asset_thumb_cam4/content',
    ];
    const cells = [...container.querySelectorAll<HTMLImageElement>('.photo-figure img')];
    expect(cells.map((img) => img.getAttribute('src'))).toEqual(expected);
    const strip = [...container.querySelectorAll<HTMLImageElement>('.frame-thumb img')];
    expect(strip.map((img) => img.getAttribute('src'))).toEqual(expected);

    // Four different pictures, not one repeated — asserted as a set so it
    // cannot pass by the list happening to be in order.
    expect(new Set(cells.map((img) => img.getAttribute('src'))).size).toBe(4);
    // The capture-level tile is still not one of them: it is CAM 2's picture,
    // and putting it in a cell captioned CAM 1 is the bug this replaces.
    expect(container.querySelector('.photo-figure img[src*="asset_thumb/"]')).toBeNull();

    for (const img of cells) {
      // The BOX is the frame's ratio; `width`/`height` describe the file being
      // fetched, which is now the 720 px thumb rather than the 1600 px frame.
      expect(img.style.aspectRatio).toBe('1600 / 1200');
      expect(img.getAttribute('width')).toBe('720');
      expect(img.getAttribute('height')).toBe('540');
    }

    // No original is fetched for the overview or the strip any more.
    expect(container.querySelector('.photo-figure img[src*="asset_1/"]')).toBeNull();
    expect(container.querySelector('.frame-thumb img[src*="asset_1/"]')).toBeNull();
  });

  it('falls back per camera, not per capture, when only some frames have a thumb', async () => {
    // A half-processed capture, or a sparse one. CAM 3 has its own thumb; the
    // rest have to be their originals — never CAM 3's picture under CAM 1.
    await render(withFrameThumbs(withDerivatives(capture('quad', 4)), [3]));
    const cells = [...container.querySelectorAll<HTMLImageElement>('.photo-figure img')];
    expect(cells.map((img) => img.getAttribute('src'))).toEqual([
      '/api/assets/asset_1/content',
      '/api/assets/asset_2/content',
      '/api/assets/asset_thumb_cam3/content',
      '/api/assets/asset_4/content',
    ]);
  });

  it('keeps the hero on the full original, never on a per-camera thumb', async () => {
    // A guest looking at one picture gets the picture, not a 720 px tile of it.
    const view = withFrameThumbs(withDerivatives(capture('quad', 4)));
    await render(view);
    const [firstCell] = container.querySelectorAll<HTMLButtonElement>('.photo-figure .photo-open');
    await act(async () => firstCell?.click());

    const hero = container.querySelector<HTMLImageElement>('.k-hero img');
    expect(hero?.getAttribute('src')).toBe('/api/assets/asset_1/content');
    expect(hero?.getAttribute('width')).toBe('1600');
  });

  it('uses the cheap copy where it IS the frame: a single-frame capture', async () => {
    // One frame, so the capture's own thumb depicts it exactly. Nothing is
    // being chosen between and 9 kB does the job of 190.
    const view = withDerivatives(capture('single', 1));
    view.mode = 'wiggle';
    view.frameCount = 1;
    await render(view);
    // The hero still never takes a thumb; only the sheet-sized copies may.
    expect(container.querySelector<HTMLImageElement>('.k-hero img')?.getAttribute('src')).toBe(
      '/api/assets/asset_still/content',
    );
  });

  it('shows a single capture from the kino-still, and from the original when there is none — never the thumb', async () => {
    await render(withDerivatives(capture('single', 1)));
    expect(container.querySelector<HTMLImageElement>('.k-hero img')?.getAttribute('src')).toBe('/api/assets/asset_still/content');

    const bare = capture('single', 1);
    bare.assets = [
      ...bare.assets,
      { role: 'thumb', assetId: 'asset_thumb', frameIndex: null, mime: 'image/webp', bytes: 9, width: 480, height: 360 },
    ];
    await render(bare);
    expect(container.querySelector<HTMLImageElement>('.k-hero img')?.getAttribute('src')).toBe('/api/assets/asset_1/content');
    expect(container.querySelector('img[src*="asset_thumb"]')).toBeNull();
    // The hero carries its ratio for the landscape cap.
    expect(container.querySelector<HTMLElement>('.k-hero')?.style.getPropertyValue('--hero-ratio')).toBe('1.3333');
  });

  it('posters the wiggle player with a still, never with a video or the thumb', () => {
    const view = withDerivatives(capture('wiggle', 4));
    view.assets = [
      ...view.assets,
      { role: 'wiggle-mp4', assetId: 'asset_mp4', frameIndex: null, mime: 'video/mp4', bytes: 9, width: 960, height: 720 },
    ];
    expect(heroStill(view)?.assetId).toBe('asset_still');
    const originalsOnly = capture('wiggle', 4);
    // Middle frame, the same camera the worker's still would show.
    expect(heroStill(originalsOnly)?.assetId).toBe('asset_3');
  });

  it('derives ratios from the asset rows and falls back to 4:3 without them', () => {
    expect(aspectOf({ width: 1600, height: 1200 })).toBe('1600 / 1200');
    expect(aspectOf({ width: null, height: 1200 })).toBeNull();
    expect(aspectOf({ width: 0, height: 1200 })).toBeNull();
    // 3 columns of 4:3 over 2 rows.
    expect(quadRatio(Array.from({ length: 6 }, () => ({ width: 1600, height: 1200 })), 3)).toBeCloseTo(2, 5);
    expect(quadRatio([{ width: null, height: null }], 2)).toBeCloseTo(8 / 3, 5);
  });

  /**
   * The stylesheet is what turns the structure above into a full-width quad.
   * jsdom cannot measure it, so the rules that decide the layout are asserted
   * as text: a regression that puts the hero back on a row, or lets the quad
   * shrink below the container width, fails here.
   */
  describe('roll.css layout rules', () => {
    // vitest runs from the workspace root; jsdom gives import.meta.url no file: scheme.
    const css = readFileSync(resolve(process.cwd(), 'src/roll.css'), 'utf8');
    const rule = (selector: string): string => {
      const at = css.indexOf(`\n${selector} {`);
      if (at === -1) throw new Error(`no rule for ${selector}`);
      return css.slice(at, css.indexOf('}', at));
    };

    it('stacks the hero as a column with no horizontal slack', () => {
      const hero = rule('.k-hero');
      expect(hero).toContain('flex-direction: column');
      expect(hero).toContain('width: 100%');
      expect(hero).toContain('overflow: hidden');
      expect(rule('.k-hero > *')).toContain('max-width: 100%');
    });

    it('lets the quad take the full width in portrait and caps it by height in landscape', () => {
      expect(rule('.photo-quad-wrap')).toContain('width: 100%');
      expect(rule('.photo-quad')).toContain('width: 100%');
      // Each frame: 50% of the container (two columns of minmax(0, 1fr)),
      // height from the ratio, cover so the hairline grid stays square.
      expect(rule('.photo-figure img')).toContain('width: 100%');
      expect(rule('.photo-figure img')).toContain('aspect-ratio: 4 / 3');
      const landscape = css.slice(css.indexOf('@media (orientation: landscape)'));
      expect(landscape).toContain('var(--quad-ratio');
      expect(landscape).toContain('var(--hero-ratio');
      expect(landscape).toContain('100dvh');
    });

    it('prints the look as a block caption row, not a floating label', () => {
      expect(rule('.photo-look')).toContain('display: block');
      expect(css).not.toMatch(/\.photo-look\s*\{[^}]*position: absolute/);
    });
  });
});

describe('the Save sheet as a dialog', () => {
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

  async function openSheet(): Promise<HTMLButtonElement> {
    const view = capture('quad', 4);
    view.assets = [
      ...view.assets,
      { role: 'kino-still', assetId: 'asset_still', frameIndex: null, mime: 'image/webp', bytes: 9, width: 1280, height: 960 },
    ];
    await act(async () => {
      root.render(<CaptureDetail slug="party" capture={view} roll={roll()} api={api()} />);
    });
    const save = container.querySelector<HTMLButtonElement>('.k-acts .k-save');
    if (save === null) throw new Error('no Save button');
    save.focus();
    await act(async () => save.click());
    return save;
  }

  /**
   * It already claimed `role="dialog" aria-modal="true"` and delivered none
   * of it: focus stayed on the button behind, Escape did nothing, and the
   * page it covered was still in the tab order.
   */
  it('moves focus into the sheet on open and back out on close', async () => {
    const save = await openSheet();
    expect(container.querySelector('.k-sheet')).not.toBeNull();

    // Focus is inside the tray, and not on the veil — landing on "Close" is
    // not what opening a save sheet means.
    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.closest('.k-tray')).not.toBeNull();
    expect(focused?.classList.contains('k-veil')).toBe(false);

    const cancel = container.querySelector<HTMLButtonElement>('.k-cancel');
    await act(async () => cancel?.click());
    expect(container.querySelector('.k-sheet')).toBeNull();
    expect(document.activeElement).toBe(save);
  });

  it('closes on Escape', async () => {
    const save = await openSheet();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('.k-sheet')).toBeNull();
    expect(document.activeElement).toBe(save);
  });

  it('makes the page behind inert while it is open, and not after', async () => {
    await openSheet();
    const article = container.querySelector('.photo-page');
    const behind = [...(article?.children ?? [])].filter((child) => !child.classList.contains('k-sheet'));
    expect(behind.length).toBeGreaterThan(2);
    // Every sibling of the sheet, including the plate carrying Save itself.
    expect(behind.every((child) => child.hasAttribute('inert'))).toBe(true);
    expect(container.querySelector('.k-sheet')?.hasAttribute('inert')).toBe(false);

    await act(async () => container.querySelector<HTMLButtonElement>('.k-veil')?.click());
    expect(behind.some((child) => child.hasAttribute('inert'))).toBe(false);
  });

  it('wraps Tab at the ends of its own list', async () => {
    await openSheet();
    const inSheet = [...container.querySelectorAll<HTMLElement>('.k-sheet a[href], .k-sheet button:not([disabled])')];
    const last = inSheet[inSheet.length - 1];
    last?.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(inSheet[0]);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(last);
  });
});

describe('frameSource', () => {
  const original = (camera: number) => ({
    role: 'original-frame',
    assetId: `orig_${String(camera)}`,
    frameIndex: camera,
    mime: 'image/jpeg',
    bytes: 190_000,
    width: 1600,
    height: 1200,
  });
  const thumb = (frameIndex: number | null) => ({
    role: 'thumb',
    assetId: frameIndex === null ? 'thumb_capture' : `thumb_${String(frameIndex)}`,
    frameIndex,
    mime: 'image/webp',
    bytes: 40_000,
    width: 720,
    height: 540,
  });

  it('prefers the frame own thumb over the frame own still and over the original', () => {
    const assets = [original(1), original(2), thumb(null), thumb(1), thumb(2)];
    expect(frameSource({ assets, frameCount: 2 } as never, original(2) as never).assetId).toBe('thumb_2');
  });

  it('never substitutes the capture-level row on a multi-frame capture', () => {
    // The reverted version did exactly this and painted CAM 2's picture in
    // all four cells.
    const assets = [original(1), original(2), original(3), original(4), thumb(null)];
    for (const camera of [1, 2, 3, 4]) {
      expect(frameSource({ assets, frameCount: 4 } as never, original(camera) as never).assetId).toBe(
        `orig_${String(camera)}`,
      );
    }
  });

  it('does substitute it on a single-frame capture, where it IS that frame', () => {
    const assets = [original(1), thumb(null)];
    expect(frameSource({ assets, frameCount: 1 } as never, original(1) as never).assetId).toBe('thumb_capture');
  });
});

describe('initialQuadFrame', () => {
  const frame = (frameIndex: number) => ({
    role: 'original-frame', assetId: `a${String(frameIndex)}`, frameIndex, width: 1600, height: 1200, mime: 'image/jpeg', bytes: 1,
  });
  it('opens a quad on its first frame on a narrow screen', () => {
    expect(initialQuadFrame({ mode: 'quad', assets: [frame(0), frame(1), frame(2), frame(3)] } as never, true)).toBe(0);
  });
  it('opens on the overview on a wide screen, and never pins a wiggle or an empty quad', () => {
    expect(initialQuadFrame({ mode: 'quad', assets: [frame(0), frame(1)] } as never, false)).toBeNull();
    expect(initialQuadFrame({ mode: 'wiggle', assets: [frame(0), frame(1)] } as never, true)).toBeNull();
    expect(initialQuadFrame({ mode: 'quad', assets: [] } as never, true)).toBeNull();
  });
});
