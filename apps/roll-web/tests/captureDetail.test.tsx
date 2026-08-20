// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureDetail as CaptureView, RollApi, RollView } from '../src/api/client';
import { CaptureDetail } from '../src/pages/CaptureDetail';

const reactTestGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

function capture(mode: string, frameCount: number): CaptureView {
  return {
    captureId: 'cap_1',
    mode,
    look: 'CLASSIC',
    capturedAt: '2026-08-14T20:00:00.000Z',
    createdAt: '2026-08-14T20:00:01.000Z',
    frameCount,
    resolution: '1600x1200',
    status: 'ready',
    reactionCount: 2,
    reacted: false,
    assets: Array.from({ length: frameCount }, (_unused, index) => ({
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

  it('renders recipe labels beneath every Quad camera frame', async () => {
    await render(capture('quad', 4), roll());
    expect(container.textContent).toContain('CAM 1 · CLASSIC');
    expect(container.textContent).toContain('CAM 4 · CLASSIC');
    expect(container.querySelectorAll('figure')).toHaveLength(4);
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

    const share = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Share',
    );
    await act(async () => share?.click());

    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(container.textContent).toContain('Link copied');
  });

  it('renders and reconciles reactions only when the Roll enables them', async () => {
    const updated = { ...capture('single', 1), reactionCount: 3, reacted: true };
    const react = vi.fn().mockResolvedValue(undefined);
    const getCapture = vi.fn().mockResolvedValue(updated);
    await render(capture('single', 1), roll(), api({ react, getCapture }));

    const heart = container.querySelector('button[aria-label="Add heart"]') as HTMLButtonElement;
    await act(async () => heart.click());
    expect(react).toHaveBeenCalledWith('party', 'cap_1');
    expect(container.textContent).toContain('♥ 3');

    await render(updated, roll({ reactionsEnabled: false }));
    expect(container.querySelector('button[aria-label*="heart"]')).toBeNull();
  });
});
