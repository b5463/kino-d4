import { describe, expect, it } from 'vitest';

// Plain import test: the twin runs in a real browser, so nothing here
// renders to a DOM. This only confirms App's module graph (React, the
// hardware profile, and everything they pull in) evaluates cleanly.
describe('App module', () => {
  it('imports without throwing', async () => {
    const mod = await import('../src/App');
    expect(mod.App).toBeTypeOf('function');
  });
});
