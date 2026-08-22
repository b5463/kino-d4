import { describe, expect, it } from 'vitest';
import { matchRoute } from '../src/routes';

describe('matchRoute', () => {
  it('matches the guest feed', () => {
    expect(matchRoute('/r/abc123')).toEqual({ name: 'roll-feed', slug: 'abc123' });
  });

  it('matches capture detail', () => {
    expect(matchRoute('/r/abc123/c/cap_01')).toEqual({
      name: 'capture-detail',
      slug: 'abc123',
      captureId: 'cap_01',
    });
  });

  it('matches display mode', () => {
    expect(matchRoute('/r/abc123/display')).toEqual({ name: 'roll-display', slug: 'abc123' });
  });

  it('matches display mode with a trailing slash', () => {
    expect(matchRoute('/r/abc123/display/')).toEqual({ name: 'roll-display', slug: 'abc123' });
  });

  it('falls back to not-found for a display path with an extra segment', () => {
    expect(matchRoute('/r/abc123/display/extra')).toEqual({
      name: 'not-found',
      pathname: '/r/abc123/display/extra',
    });
  });

  it('matches the host dashboard', () => {
    expect(matchRoute('/host')).toEqual({ name: 'host-dashboard' });
  });

  it('decodes percent-encoded path segments', () => {
    expect(matchRoute('/r/abc%20123')).toEqual({ name: 'roll-feed', slug: 'abc 123' });
  });

  it('tolerates a trailing slash', () => {
    expect(matchRoute('/r/abc123/')).toEqual({ name: 'roll-feed', slug: 'abc123' });
  });

  it('falls back to not-found for the root path', () => {
    expect(matchRoute('/')).toEqual({ name: 'not-found', pathname: '/' });
  });

  it('falls back to not-found for an unrelated path', () => {
    expect(matchRoute('/nope')).toEqual({ name: 'not-found', pathname: '/nope' });
  });

  it('falls back to not-found for a roll-feed path with an extra segment that is not /c/:id', () => {
    expect(matchRoute('/r/abc123/extra')).toEqual({
      name: 'not-found',
      pathname: '/r/abc123/extra',
    });
  });

  it('falls back to not-found for /host with an extra segment', () => {
    expect(matchRoute('/host/settings')).toEqual({
      name: 'not-found',
      pathname: '/host/settings',
    });
  });
});
