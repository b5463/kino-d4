// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { LoadFailure } from '../src/components/LoadFailure';
import { OfflineBanner } from '../src/components/OfflineBanner';
import { SafeImage } from '../src/components/SafeImage';
import { RollStateBanner, rollAcceptsUploads } from '../src/pages/RollClosed';

const reactTestGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

describe('guest resilience pieces', () => {
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

  it('ErrorBoundary catches a render error and offers Reload', async () => {
    // React logs the caught error; that noise is expected here.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
    function Broken(): never {
      throw new Error('boom');
    }

    await act(async () => {
      root.render(
        <ErrorBoundary>
          <Broken />
        </ErrorBoundary>,
      );
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Something broke.');
    const button = container.querySelector<HTMLButtonElement>('button');
    expect(button?.textContent).toBe('Reload');
    await act(async () => button?.click());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('OfflineBanner follows navigator.onLine through the online/offline events', async () => {
    let online = true;
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });

    await act(async () => {
      root.render(<OfflineBanner />);
    });
    expect(container.querySelector('.k-offline')).toBeNull();

    online = false;
    await act(async () => window.dispatchEvent(new Event('offline')));
    expect(container.querySelector('.k-offline')?.textContent).toBe('Offline — showing what was loaded');

    online = true;
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(container.querySelector('.k-offline')).toBeNull();
  });

  it('LoadFailure says one useful thing and retries on demand', async () => {
    const onRetry = vi.fn();
    await act(async () => {
      root.render(<LoadFailure onRetry={onRetry} />);
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not reach the roll. Check the connection.',
    );
    await act(async () => container.querySelector('button')?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('SafeImage forgets a failure when its src changes', async () => {
    await act(async () => {
      root.render(<SafeImage src="/a.jpg" alt="" />);
    });
    await act(async () => container.querySelector('img')?.dispatchEvent(new Event('error')));
    expect(container.querySelector('.k-img-missing')).not.toBeNull();

    await act(async () => {
      root.render(<SafeImage src="/b.jpg" alt="" />);
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/b.jpg');
  });

  it('an archived roll gets its banner and stops promising new photographs', async () => {
    await act(async () => {
      root.render(<RollStateBanner status="archived" />);
    });
    expect(container.querySelector('.roll-closed b')?.textContent).toBe('Archived');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Nothing new will arrive.');

    // `live` is the only one of the five states that accepts uploads, and an
    // unknown or not-yet-loaded status fails closed: the promise that
    // photographs "appear here as the camera sends them" is one this app
    // cannot keep for a `draft` or `trash` roll, and used to make it anyway.
    expect(rollAcceptsUploads('live')).toBe(true);
    expect(rollAcceptsUploads(undefined)).toBe(false);
    expect(rollAcceptsUploads('closed')).toBe(false);
    expect(rollAcceptsUploads('archived')).toBe(false);
    expect(rollAcceptsUploads('draft')).toBe(false);
    expect(rollAcceptsUploads('trash')).toBe(false);
  });

  it('a live roll gets no state banner', async () => {
    await act(async () => {
      root.render(<RollStateBanner status="live" />);
    });
    expect(container.innerHTML).toBe('');
  });
});
