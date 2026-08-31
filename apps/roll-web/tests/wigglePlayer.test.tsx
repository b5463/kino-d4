// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WigglePlayer } from '../src/components/WigglePlayer';

const FRAMES = ['/frame-0.jpg', '/frame-1.jpg', '/frame-2.jpg', '/frame-3.jpg'];
const reactTestGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

class ImmediateImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

type ObserverCallback = IntersectionObserverCallback;

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly callback: ObserverCallback;
  readonly observe = vi.fn((element: Element) => {
    this.emit(element, true, 1);
  });
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();

  constructor(callback: ObserverCallback, readonly options?: IntersectionObserverInit) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }

  emit(element: Element, isIntersecting: boolean, intersectionRatio: number): void {
    this.callback(
      [{ target: element, isIntersecting, intersectionRatio } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

describe('WigglePlayer', () => {
  let container: HTMLDivElement;
  let root: Root;
  let reducedMotion = false;
  let nextFrameId = 1;
  let callbacks: Map<number, FrameRequestCallback>;
  let cancelAnimationFrameMock: ReturnType<typeof vi.fn>;

  function image(): HTMLImageElement {
    const element = container.querySelector('img');
    if (element === null) throw new Error('WigglePlayer did not render an image');
    return element;
  }

  function runFrame(timestamp: number): void {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback(timestamp);
  }

  async function render(player: ReactElement): Promise<void> {
    await act(async () => {
      root.render(player);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    callbacks = new Map();
    FakeIntersectionObserver.instances = [];
    nextFrameId = 1;
    reducedMotion = false;

    vi.stubGlobal('Image', ImmediateImage);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      callbacks.set(id, callback);
      return id;
    });
    cancelAnimationFrameMock = vi.fn((id: number) => callbacks.delete(id));
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: reducedMotion && query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('advances at fps through the shared bounce sequence', async () => {
    await render(<WigglePlayer frames={FRAMES} fps={10} />);
    expect(image().getAttribute('src')).toBe(FRAMES[0]);

    act(() => runFrame(0));
    const expected = [1, 2, 3, 2, 1, 0, 1, 2, 3, 2];
    for (let step = 1; step <= 10; step += 1) {
      act(() => runFrame(step * 100));
      expect(image().getAttribute('src')).toBe(FRAMES[expected[step - 1] ?? 0]);
    }
  });

  it('cancels its animation frame on unmount', async () => {
    await render(<WigglePlayer frames={FRAMES} />);
    expect(callbacks.size).toBe(1);

    await act(async () => root.unmount());
    expect(cancelAnimationFrameMock).toHaveBeenCalled();
    expect(callbacks.size).toBe(0);

    // afterEach may safely unmount an already-unmounted root only if replaced.
    root = createRoot(container);
  });

  it('toggles play and pause when tapped', async () => {
    await render(<WigglePlayer frames={FRAMES} />);
    const toggle = container.querySelector<HTMLButtonElement>('button');
    if (toggle === null) throw new Error('playback toggle was not rendered');
    expect(callbacks.size).toBe(1);

    act(() => toggle.click());
    expect(callbacks.size).toBe(0);
    expect(toggle.getAttribute('aria-label')).toBe('Play wiggle animation');

    act(() => toggle.click());
    expect(callbacks.size).toBe(1);
    expect(toggle.getAttribute('aria-label')).toBe('Pause wiggle animation');
  });

  it('shows the poster and requires a manual play action for reduced motion', async () => {
    reducedMotion = true;
    await render(<WigglePlayer frames={FRAMES} poster="/poster.jpg" />);

    expect(image().getAttribute('src')).toBe('/poster.jpg');
    expect(callbacks.size).toBe(0);
    const play = container.querySelector<HTMLButtonElement>('[aria-label="Play wiggle animation"]');
    expect(play).not.toBeNull();

    act(() => play?.click());
    expect(callbacks.size).toBe(1);
  });

  it('pauses while offscreen and resumes when at least 25% visible', async () => {
    await render(<WigglePlayer frames={FRAMES} />);
    const observer = FakeIntersectionObserver.instances[0];
    const player = container.querySelector('[data-wiggle-player]');
    if (observer === undefined || player === null) throw new Error('observer was not installed');

    act(() => observer.emit(player, false, 0));
    expect(callbacks.size).toBe(0);

    act(() => observer.emit(player, true, 0.25));
    expect(callbacks.size).toBe(1);
    expect(observer.options?.threshold).toBe(0.25);
  });

  it('keeps playing when a parent re-render hands it an equal frame array', async () => {
    // Regression: the preload effect keyed on array IDENTITY, so every scroll
    // re-render of the virtualized feed rebuilt `frames`, restarted the
    // preload, and snapped the wigglegram back to its poster.
    await render(<WigglePlayer frames={FRAMES} fps={10} poster="/poster.jpg" />);
    act(() => runFrame(0));
    act(() => runFrame(100));
    expect(image().getAttribute('src')).toBe(FRAMES[1]);

    await render(<WigglePlayer frames={[...FRAMES]} fps={10} poster="/poster.jpg" />);
    expect(image().getAttribute('src')).toBe(FRAMES[1]);
    expect(callbacks.size).toBe(1);
  });

  it('does restart when the frames themselves change', async () => {
    await render(<WigglePlayer frames={FRAMES} fps={10} poster="/poster.jpg" />);
    act(() => runFrame(0));
    act(() => runFrame(100));
    expect(image().getAttribute('src')).toBe(FRAMES[1]);

    const other = ['/other-0.jpg', '/other-1.jpg'];
    await render(<WigglePlayer frames={other} fps={10} poster="/poster.jpg" />);
    expect(image().getAttribute('src')).toBe(other[0]);
  });

  it('pauses while the document is hidden', async () => {
    await render(<WigglePlayer frames={FRAMES} />);
    expect(callbacks.size).toBe(1);

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(callbacks.size).toBe(0);
  });
});
