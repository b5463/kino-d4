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

const { CaptureTile } = await import('../src/pages/RollFeedPage');

const reactTestGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

function asset(role: CaptureAssetSummary['role'], assetId: string, frameIndex: number | null = null): CaptureAssetSummary {
  return { role, assetId, frameIndex, width: null, height: null };
}

const ORIGINALS = Array.from({ length: 4 }, (_unused, index) =>
  asset('original-frame', `orig_${String(index)}`, index),
);

function capture(assets: CaptureAssetSummary[]): CaptureView {
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
  };
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

  it('falls back to the live player while no animation has been baked', async () => {
    await render(capture([...ORIGINALS, asset('thumb', 'thumb_1')]));

    expect(seen.at(-1)?.frames).toEqual([
      '/api/assets/orig_0/content',
      '/api/assets/orig_1/content',
      '/api/assets/orig_2/content',
      '/api/assets/orig_3/content',
    ]);
    expect(seen.at(-1)?.poster).toBe('/api/assets/thumb_1/content');
  });

  it('keeps one frame-URL array across re-renders so the player does not restart', async () => {
    const view = capture([...ORIGINALS, asset('thumb', 'thumb_1')]);
    await render(view);
    await render(view);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.frames).toBe(seen[1]?.frames);
  });

  it('spells out the frame range only when the tile really cannot move', async () => {
    await render(capture([asset('thumb', 'thumb_1')]));

    expect(seen).toHaveLength(0);
    expect(container.querySelector('.k-still')?.textContent).toBe('1-4');
  });
});
