// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WigglePlayerProps } from '../src/components/WigglePlayer';
import type { CaptureDetail as CaptureDetailView, RollApi, RollView } from '../src/api/client';

/**
 * The stored playback choice must reach the player: fps as-is, loop mapped
 * from the KDP vocabulary into @kino/media's (KDP `sweep` is the player's
 * `once`). The player is mocked to a prop recorder — how it animates is
 * `wigglePlayer.test.tsx`'s business; that the page hands it the capture's
 * stored settings is this file's.
 */
const seen: WigglePlayerProps[] = [];
vi.mock('../src/components/WigglePlayer', () => ({
  WigglePlayer: (props: WigglePlayerProps) => {
    seen.push(props);
    return <div data-mock-player="" />;
  },
}));

// Imported after the mock so the page binds to the recorder.
const { CaptureDetail } = await import('../src/pages/CaptureDetail');

const reactTestGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

function capture(playback: CaptureDetailView['playback']): CaptureDetailView {
  return {
    captureId: 'cap_1',
    mode: 'wiggle',
    look: 'CLASSIC',
    capturedAt: '2026-08-14T20:00:00.000Z',
    createdAt: '2026-08-14T20:00:01.000Z',
    frameCount: 4,
    resolution: '1600x1200',
    status: 'ready',
    playback,
    reactionCount: 0,
    reacted: false,
    assets: Array.from({ length: 4 }, (_unused, index) => ({
      role: 'original-frame',
      assetId: `asset_${String(index)}`,
      frameIndex: index,
      mime: 'image/jpeg',
      bytes: 100,
      width: 1600,
      height: 1200,
    })),
  };
}

const roll: RollView = {
  title: 'Friday party',
  status: 'live',
  photoCount: 1,
  downloadsEnabled: true,
  reactionsEnabled: false,
  createdAt: '2026-08-14T19:00:00.000Z',
  closedAt: null,
};

const api: RollApi = {
  getRoll: vi.fn(),
  submitPin: vi.fn(),
  requestRender: vi.fn(),
  listCaptures: vi.fn(),
  getCapture: vi.fn(),
  assetUrl: (id) => `/api/assets/${id}/content`,
  react: vi.fn(),
  events: vi.fn(),
};

describe('playback props reach the wiggle player', () => {
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

  async function render(view: CaptureDetailView): Promise<void> {
    await act(async () => {
      root.render(<CaptureDetail slug="party" capture={view} roll={roll} api={api} />);
    });
  }

  it('passes the stored fps and maps the KDP loop word', async () => {
    await render(capture({ fps: 5, loop: 'sweep' }));
    expect(seen.at(-1)).toMatchObject({ fps: 5, loop: 'once' });
  });

  it('maps continuous to the repeating sweep', async () => {
    await render(capture({ fps: 12, loop: 'continuous' }));
    expect(seen.at(-1)).toMatchObject({ fps: 12, loop: 'sweep' });
  });

  it('defaults to bounce with no stored choice', async () => {
    await render(capture(null));
    expect(seen.at(-1)).toMatchObject({ fps: undefined, loop: 'bounce' });
  });
});
