import { beforeEach, describe, expect, it } from 'vitest';
import {
  dirtySections,
  dropDraft,
  getDraftEntry,
  putDraftEntry,
  resetDrafts,
  setDraftDirty,
  useDraftStore,
} from '../src/state/draftStore';
import { countChanges } from '../src/hooks/useDraft';

beforeEach(() => resetDrafts());

describe('draft store', () => {
  it('keeps a draft after the page that made it is gone', () => {
    putDraftEntry('shoot', { draft: { volume: 7 }, base: { volume: 6 } });
    // Page unmount touches nothing — the entry is not owned by the component.
    expect(getDraftEntry<{ volume: number }>('shoot')?.draft.volume).toBe(7);
  });

  it('tracks and clears dirty labels', () => {
    setDraftDirty('shoot', 'Shoot');
    setDraftDirty('quad', 'Quad');
    expect(Object.values(useDraftStore.getState().dirty).sort()).toEqual(['Quad', 'Shoot']);
    setDraftDirty('shoot', null);
    expect(Object.values(useDraftStore.getState().dirty)).toEqual(['Quad']);
  });

  it('maps instance keys back to their section', () => {
    setDraftDirty('looks:party-neg', 'Looks');
    setDraftDirty('device', 'Device');
    expect([...dirtySections(useDraftStore.getState().dirty)].sort()).toEqual(['device', 'looks']);
  });

  it('drops one draft without touching the others', () => {
    putDraftEntry('looks:mono', { draft: 1, base: 2 });
    putDraftEntry('quad', { draft: 3, base: 4 });
    setDraftDirty('looks:mono', 'Looks');
    dropDraft('looks:mono');
    expect(getDraftEntry('looks:mono')).toBeNull();
    expect(getDraftEntry('quad')).not.toBeNull();
    expect(useDraftStore.getState().dirty['looks:mono']).toBeUndefined();
  });

  it('forgets everything on disconnect', () => {
    putDraftEntry('shoot', { draft: 1, base: 1 });
    setDraftDirty('shoot', 'Shoot');
    resetDrafts();
    expect(useDraftStore.getState().entries).toEqual({});
    expect(useDraftStore.getState().dirty).toEqual({});
  });
});

describe('countChanges', () => {
  it('counts changed leaves, not top-level keys', () => {
    const a = { wiggle: { fps: 10, flash: true, loop: 'bounce' }, note: 'x' };
    const b = { wiggle: { fps: 12, flash: false, loop: 'bounce' }, note: 'x' };
    expect(countChanges(a, b)).toBe(2);
  });

  it('is zero for equal objects', () => {
    expect(countChanges({ a: [1, 2, 3] }, { a: [1, 2, 3] })).toBe(0);
  });

  it('counts array cells individually', () => {
    expect(countChanges({ m: [1, 0, 0] }, { m: [1, 2, 3] })).toBe(2);
  });

  it('counts a whole subtree appearing as its leaves', () => {
    expect(countChanges({ a: {} }, { a: { x: 1, y: 2 } })).toBe(2);
  });

  it('treats a type change as one change', () => {
    expect(countChanges({ a: 1 }, { a: 'one' })).toBe(1);
  });
});
