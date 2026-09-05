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

const { CaptureTile, FrameMark } = await import('../src/pages/RollFeedPage');

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
