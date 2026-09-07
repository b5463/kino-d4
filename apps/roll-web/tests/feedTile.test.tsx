// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WigglePlayerProps } from '../src/components/WigglePlayer';
import type { CaptureAssetSummary, CaptureView } from '../src/api/client';

/**
 * What the feed asks the network for per tile.
 *
 * A tile is not a capture page: a guest scrolling a roll on party Wi-Fi pays
 * four full-resolution originals for every wigglegram the live player renders.
 * The baked derivative is one request, so it wins whenever it exists — and the
 * live player has to stay the fallback until the worker has baked one, or a
 * fresh roll would be a wall of frozen posters.
 */
const seen: WigglePlayerProps[] = [];
vi.mock('../src/components/WigglePlayer', () => ({
  WigglePlayer: (props: WigglePlayerProps) => {
    seen.push(props);
    return <div data-mock-player="" />;
  },
}));

const { CaptureTile, FrameMark, TILE_SIZES, tileSources } = await import('../src/pages/RollFeedPage');

const reactTestGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

function asset(role: CaptureAssetSummary['role'], assetId: string, frameIndex: number | null = null): CaptureAssetSummary {
  return { role, assetId, frameIndex, width: null, height: null };
}

/** `frameIndex` is the 1-based camera number. */
const ORIGINALS = Array.from({ length: 4 }, (_unused, index) =>
  asset('original-frame', `orig_${String(index + 1)}`, index + 1),
);

function capture(assets: CaptureAssetSummary[], overrides: Partial<CaptureView> = {}): CaptureView {
  return {
    captureId: 'cap_1',
    mode: 'wiggle',
    look: null,
    capturedAt: '2026-08-14T20:00:00.000Z',
    createdAt: '2026-08-14T20:00:00.000Z',
    frameCount: 4,
    resolution: '1600x1200',
    status: 'ready',
    playback: null,
    assets,
    ...overrides,
  };
}

function bars(): { cam: string | null; pos: string | null; missing: boolean }[] {
  return [...document.querySelectorAll<HTMLElement>('.k-frames b')].map((bar) => ({
    cam: bar.getAttribute('data-cam'),
    pos: bar.getAttribute('data-pos'),
    missing: bar.hasAttribute('data-missing'),
  }));
}

describe('feed tile media source', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    seen.length = 0;
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
      root.render(
        <CaptureTile
          slug="party"
          capture={view}
          index="003"
          isNew={false}
          picked={false}
          onPick={() => undefined}
        />,
      );
    });
  }

  it('plays the baked animation, not four originals, when one exists', async () => {
    await render(capture([...ORIGINALS, asset('wiggle-webp', 'webp_1'), asset('thumb', 'thumb_1')]));

    expect(seen).toHaveLength(0);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      '/api/assets/webp_1/content',
    );
    // Nothing is still here, so the frame range must not be printed.
    expect(container.querySelector('.k-still')).toBeNull();
  });

  it('prefers the device preview over the originals too', async () => {
    await render(capture([...ORIGINALS, asset('wiggle-preview', 'prev_1')]));

    expect(seen).toHaveLength(0);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      '/api/assets/prev_1/content',
    );
  });

  it('never mounts the live player over originals in the grid; the thumb waits with Processing…', async () => {
    // Four full-resolution originals per tile, times every tile on screen, is
    // what the grid must not ask party Wi-Fi for. The still thumb and a chip
    // hold the place until the worker has baked an animation.
    await render(capture([...ORIGINALS, asset('thumb', 'thumb_1')]));

    expect(seen).toHaveLength(0);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/assets/thumb_1/content');
    expect(container.querySelector('.k-chip')?.textContent).toBe('Processing…');
    expect(container.querySelector('.k-chip')?.getAttribute('data-state')).toBe('processing');
  });

  it('spells out the frame range only when the tile really cannot move', async () => {
    await render(capture([asset('thumb', 'thumb_1')]));

    expect(seen).toHaveLength(0);
    expect(container.querySelector('.k-still')?.textContent).toBe('1-4');
  });

  it('draws one bar per camera slot and darkens the camera that sent nothing', async () => {
    // Cameras 1, 3, 4 answered — frameIndex 1, 3, 4, listed out of order to
    // prove the tile sorts by camera number rather than trusting API order.
    const sparse = [
      asset('original-frame', 'orig_4', 4),
      asset('original-frame', 'orig_1', 1),
      asset('original-frame', 'orig_3', 3),
    ];
    await render(capture([...sparse, asset('thumb', 'thumb_1')], { frameCount: 3, status: 'partial' }));

    expect(bars()).toEqual([
      { cam: '1', pos: '0', missing: false },
      { cam: '2', pos: null, missing: true },
      { cam: '3', pos: '1', missing: false },
      { cam: '4', pos: '2', missing: false },
    ]);
    expect(container.querySelector('.k-chip')?.textContent).toBe('3 OF 4');
    expect(container.querySelector('.k-chip')?.getAttribute('data-state')).toBe('partial');
  });

  it('lights the first frameCount slots while the feed does not yet know which cameras answered', async () => {
    await act(async () => {
      root.render(<FrameMark capture={{ assets: [], frameCount: 4 }} />);
    });
    expect(bars().map((bar) => bar.missing)).toEqual([false, false, false, false]);
  });

  it('marks a failed capture FAILED and shows no animation for it', async () => {
    await render(
      capture([...ORIGINALS, asset('wiggle-webp', 'webp_1'), asset('thumb', 'thumb_1')], { status: 'failed' }),
    );

    expect(seen).toHaveLength(0);
    expect(container.querySelector('.k-chip')?.textContent).toBe('FAILED');
    // The still, never the bake.
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/assets/thumb_1/content');
  });

  it('swaps a broken thumb for the placeholder block', async () => {
    await render(capture([...ORIGINALS, asset('wiggle-webp', 'webp_1')]));
    const img = container.querySelector('img');
    await act(async () => img?.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.k-img-missing')?.textContent).toContain('Image unavailable');
    // Tiles get no Retry; that belongs to the capture page.
    expect(container.querySelector('.k-img-missing button')).toBeNull();
  });
});

/**
 * A tile on a phone is the full CSS width at 2–3× DPR. The `thumb` alone
 * (480 px on older rolls, 720 px now) is upscaled there; the `kino-still` is
 * 1280 px. The browser picks between them from `srcset` + `sizes`.
 */
describe('tile sources', () => {
  const url = (id: string): string => `/api/assets/${id}/content`;
  const sized = (role: CaptureAssetSummary['role'], assetId: string, width: number | null, height: number | null): CaptureAssetSummary =>
    ({ role, assetId, frameIndex: null, width, height });

  it('offers the thumb and the kino-still as width candidates, thumb as the plain src', () => {
    const sources = tileSources(
      { assets: [sized('kino-still', 'still', 1280, 960), sized('thumb', 'thumb', 480, 360), ...ORIGINALS] },
      url,
    );
    expect(sources).toEqual({
      src: '/api/assets/thumb/content',
      srcSet: '/api/assets/thumb/content 480w, /api/assets/still/content 1280w',
      sizes: TILE_SIZES,
    });
    // One column on a phone, so the tile is the viewport: 100vw at 3× on a
    // 390 px phone asks for 1170 px, which selects the still.
    expect(TILE_SIZES.endsWith('100vw')).toBe(true);
  });

  it('gives no srcset when only one still has a known width', () => {
    expect(tileSources({ assets: [sized('thumb', 'thumb', 720, 540)] }, url, 1)).toEqual({ src: '/api/assets/thumb/content' });
    expect(tileSources({ assets: ORIGINALS }, url, 1)).toBeUndefined();
  });

  /**
   * The rule that fixes the 4x upscale on a phone.
   *
   * A device-uploaded `thumb` has `width: null`, so it can never be a srcset
   * candidate and the browser was left painting a 288 px image across 1170
   * device pixels. With nothing to choose between, the client chooses: below
   * 2x the cheap thumb is enough, at 2x and above it is not.
   */
  it('takes the still instead of an unmeasured thumb on a high-DPR screen', () => {
    const assets = [sized('thumb', 'thumb', null, null), sized('kino-still', 'still', 1280, 960)];

    // A 1x desktop column: the thumb is still the cheap, correct answer.
    expect(tileSources({ assets }, url, 1)).toEqual({ src: '/api/assets/thumb/content' });

    // A 2x or 3x phone, one tile per row: the 1280 px still.
    expect(tileSources({ assets }, url, 2)).toEqual({ src: '/api/assets/still/content' });
    expect(tileSources({ assets }, url, 3)).toEqual({ src: '/api/assets/still/content' });

    // A thumb that DOES have a width is describable, so the browser decides
    // and the client stops guessing.
    const measured = [sized('thumb', 'thumb', 720, 540), sized('kino-still', 'still', 1280, 960)];
    expect(tileSources({ assets: measured }, url, 3)?.srcSet).toBe(
      '/api/assets/thumb/content 720w, /api/assets/still/content 1280w',
    );

    // No still to fall back to: the thumb is all there is, at any DPR.
    expect(tileSources({ assets: [sized('thumb', 'thumb', null, null)] }, url, 3)).toEqual({
      src: '/api/assets/thumb/content',
    });
  });

  /**
   * A `thumb` no longer names one row: the worker writes the capture's tile at
   * `frameIndex: null` plus one per camera. The tile must take the capture's,
   * because a per-camera thumb is one of four views and the feed shows one
   * picture per capture — and it must not offer a per-camera row as a `srcset`
   * candidate either, where it would collide with the capture's at the same
   * 720 px width and let the browser pick a single camera's frame.
   */
  it('ignores the per-camera thumbs and tiles from the capture own', () => {
    const perCamera = [1, 2, 3, 4].map((camera) => ({
      role: 'thumb' as const,
      assetId: `thumb_cam${String(camera)}`,
      frameIndex: camera,
      width: 720,
      height: 540,
    }));
    const assets = [
      sized('thumb', 'thumb', 720, 540),
      ...perCamera,
      sized('kino-still', 'still', 1280, 960),
      ...ORIGINALS,
    ];

    expect(tileSources({ assets }, url)).toEqual({
      src: '/api/assets/thumb/content',
      srcSet: '/api/assets/thumb/content 720w, /api/assets/still/content 1280w',
      sizes: TILE_SIZES,
    });

    // And with the API's own ordering — NULLS FIRST — the same answer, so the
    // rule is the filter and not the row order it happens to be handed.
    const shuffled = [...perCamera, sized('thumb', 'thumb', 720, 540), sized('kino-still', 'still', 1280, 960)];
    expect(tileSources({ assets: shuffled }, url)?.src).toBe('/api/assets/thumb/content');
  });

  it('paints the tile with whatever src the rule chose, not the poster', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const treeRoot = createRoot(host);
    const original = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
    try {
      const view = capture([sized('thumb', 'thumb', null, null), sized('kino-still', 'still', 1280, 960)]);
      await act(async () => {
        treeRoot.render(<CaptureTile slug="party" capture={view} index="001" isNew={false} picked={false} onPick={() => undefined} />);
      });
      expect(host.querySelector<HTMLImageElement>('.k-shot img')?.getAttribute('src')).toBe(
        '/api/assets/still/content',
      );
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: original, configurable: true });
      await act(async () => treeRoot.unmount());
      host.remove();
    }
  });

  it('puts the srcset on the tile image itself', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const view = capture([sized('kino-still', 'still', 1280, 960), sized('thumb', 'thumb', 720, 540)]);
    await act(async () => {
      root.render(<CaptureTile slug="party" capture={view} index="001" isNew={false} picked={false} onPick={() => undefined} />);
    });
    const img = host.querySelector<HTMLImageElement>('.k-shot img');
    expect(img?.getAttribute('srcset')).toBe('/api/assets/thumb/content 720w, /api/assets/still/content 1280w');
    expect(img?.getAttribute('sizes')).toBe(TILE_SIZES);
    await act(async () => root.unmount());
    host.remove();
  });
});
