// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRollCode, LandingPage, normaliseRollCode } from '../src/pages/LandingPage';
import { readLastRoll, rememberRoll } from '../src/state/lastRoll';

const reactTestGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

describe('normaliseRollCode', () => {
  it('uppercases and strips spaces, and stops at six characters', () => {
    expect(normaliseRollCode(' ab c2 3d ')).toBe('ABC23D');
    expect(normaliseRollCode('abc23dxyz')).toBe('ABC23D');
  });

  it('accepts only the slug alphabet: no 0, O, 1, I or L', () => {
    expect(isRollCode('ABC23D')).toBe(true);
    expect(isRollCode('ABC0OD')).toBe(false);
    expect(isRollCode('AB1ILD')).toBe(false);
    expect(isRollCode('ABC2')).toBe(false);
  });
});

describe('LandingPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    localStorage.clear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function typeCode(value: string): void {
    const input = container.querySelector<HTMLInputElement>('#roll-code');
    if (input === null) throw new Error('no roll code input');
    // React listens for `input`; setting the value through the native setter
    // is what makes the controlled field see a change.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('normalises what the guest types and opens /r/<CODE>', async () => {
    const onOpen = vi.fn();
    await act(async () => {
      root.render(<LandingPage onOpen={onOpen} lastRoll={null} />);
    });

    expect(container.textContent).toContain('Or scan the code on the camera.');
    // What the field wants, said before a guest can get it wrong.
    expect(container.textContent).toContain('Six letters and digits');
    expect(container.querySelector('label')?.textContent).toBe('Roll code');

    await act(async () => typeCode(' ab c2 3d'));
    expect(container.querySelector<HTMLInputElement>('#roll-code')?.value).toBe('ABC23D');

    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Open roll');
    expect(button).toBeDefined();
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onOpen).toHaveBeenCalledWith('ABC23D');
  });

  it('refuses a code outside the alphabet and says why', async () => {
    const onOpen = vi.fn();
    await act(async () => {
      root.render(<LandingPage onOpen={onOpen} lastRoll={null} />);
    });
    await act(async () => typeCode('abc01o'));
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onOpen).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('6 letters and digits');
  });

  it('offers a way back to the roll last opened on this phone', async () => {
    rememberRoll('ABC23D', 'Loft');
    expect(readLastRoll()).toEqual({ slug: 'ABC23D', title: 'Loft' });

    await act(async () => {
      root.render(<LandingPage />);
    });
    const back = container.querySelector<HTMLAnchorElement>('.k-landing-back');
    expect(back?.textContent).toBe('Back to Loft');
    expect(back?.getAttribute('href')).toBe('/r/ABC23D');
  });

  it('falls back to the code when the remembered roll has no title, and shows nothing without one', async () => {
    rememberRoll('ABC23D', '');
    await act(async () => {
      root.render(<LandingPage />);
    });
    expect(container.querySelector('.k-landing-back')?.textContent).toBe('Back to ABC23D');

    localStorage.clear();
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<LandingPage />);
    });
    expect(container.querySelector('.k-landing-back')).toBeNull();
  });

  it('treats unreadable storage as nothing remembered', () => {
    localStorage.setItem('kino-roll:last', '{not json');
    expect(readLastRoll()).toBeNull();
    localStorage.setItem('kino-roll:last', JSON.stringify({ title: 'no slug' }));
    expect(readLastRoll()).toBeNull();
  });
});
