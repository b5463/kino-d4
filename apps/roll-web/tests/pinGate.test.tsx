// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type RollApi } from '../src/api/client';
import { NoRollPage } from '../src/pages/NotFoundPage';
import { PinGate } from '../src/pages/PinGate';
import { RollClosed } from '../src/pages/RollClosed';

const reactTestGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

function api(submitPin: RollApi['submitPin']): RollApi {
  return {
    getRoll: vi.fn(),
    submitPin,
    listCaptures: vi.fn(),
    getCapture: vi.fn(),
    assetUrl: vi.fn(),
    react: vi.fn(),
    requestRender: vi.fn(),
    events: vi.fn(),
  };
}

describe('Roll access states', () => {
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

  async function render(element: ReactElement): Promise<void> {
    await act(async () => root.render(element));
  }

  async function enterPinAndSubmit(pin: string): Promise<void> {
    const input = container.querySelector('#roll-pin') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, pin);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
  }

  it('shows the compact gate and a wrong PIN error inline', async () => {
    const submitPin = vi
      .fn()
      .mockRejectedValue(new ApiError(401, 'INVALID_PIN', 'that PIN does not open this roll'));
    await render(<PinGate slug="party" onUnlocked={vi.fn()} api={api(submitPin)} />);

    expect(container.textContent).toContain('This roll needs a PIN');
    // Sentence case everywhere: the gate's own button said OPEN ROLL while
    // the landing page's said "Open roll".
    expect(container.querySelector('button[type="submit"]')?.textContent).toBe('Open roll');
    expect(container.querySelector('#roll-pin')?.getAttribute('inputmode')).toBe('numeric');
    expect(container.querySelector('#roll-pin')?.getAttribute('autocomplete')).toBe('off')  // NOT one-time-code: iOS offers an SMS code for a PIN printed on a card;
    await enterPinAndSubmit('0000');

    expect(submitPin).toHaveBeenCalledWith('party', '0000');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('That PIN did not work.');
  });

  it('re-enters the Roll after a successful PIN exchange', async () => {
    const submitPin = vi.fn().mockResolvedValue(undefined);
    const onUnlocked = vi.fn().mockResolvedValue(undefined);
    await render(<PinGate slug="party" onUnlocked={onUnlocked} api={api(submitPin)} />);

    await enterPinAndSubmit('4821');

    expect(submitPin).toHaveBeenCalledWith('party', '4821');
    expect(onUnlocked).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows the closed time without making the gallery unreadable', async () => {
    await render(<RollClosed closedAt="2026-08-14T22:30:00.000Z" />);
    // The same formatter every other date on the guest surface uses — not a
    // raw locale timestamp with seconds in it.
    expect(container.querySelector('.roll-closed b')?.textContent).toBe('Closed · 15.08.26');
    // ...and what closing MEANS, which the stamp on its own never said.
    expect(container.textContent).toContain('No more photographs are coming.');
  });

  it('uses the plain product 404 for an unknown or stale Roll link', async () => {
    await render(<NoRollPage />);
    expect(container.querySelector('h1')?.textContent).toBe('No roll here');
  });
});
