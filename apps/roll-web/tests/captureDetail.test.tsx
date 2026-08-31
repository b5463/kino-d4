// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureDetail as CaptureView, RollApi, RollView } from '../src/api/client';
import { CaptureDetail } from '../src/pages/CaptureDetail';
import { readPicks } from '../src/state/picks';

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
    playback: null,
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
