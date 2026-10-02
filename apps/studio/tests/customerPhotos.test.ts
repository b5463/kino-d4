// #230: Photos. Day groups, filters, arrivals that do not move the grid, the
// delete question, what Save offers, and when Send to Roll exists.
import { describe, expect, it } from 'vitest';
import { arrivalsLine, canSendToRoll, dayLabel, deleteQuestion, filterPhotos, groupByDay, kindWord, mergeArrivals, newestFirst, saveOptions } from '../src/customer/photos/photoGroups';
import type { PhotoLike } from '../src/customer/photos/photoGroups';

const NOW = new Date(2026, 8, 26, 18, 0, 0);
const at = (d: number, h = 12) => new Date(2026, 8, d, h).getTime();
const photos: PhotoLike[] = [
  { id: 'WG_0004', kind: 'wiggle', ts: at(26, 18), favorite: false },
  { id: 'QD_0003', kind: 'quad', ts: at(26, 9), favorite: true },
  { id: 'WG_0002', kind: 'wiggle', ts: at(25), favorite: false },
  { id: 'WG_0001', kind: 'wiggle', ts: at(21), favorite: true },
];

describe('grouping', () => {
  it('labels days Today, Yesterday, then the date', () => {
    expect(dayLabel(at(26), NOW)).toBe('Today');
    expect(dayLabel(at(25), NOW)).toBe('Yesterday');
    expect(dayLabel(at(21), NOW)).toBe('21 September');
    expect(dayLabel(new Date(2025, 8, 21).getTime(), NOW)).toBe('21 September 2025');
    expect(dayLabel(null, NOW)).toBe('Undated');
  });

  it('groups newest first with one heading per day', () => {
    const groups = groupByDay(photos, NOW);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', '21 September']);
    expect(groups[0]!.items.map((p) => p.id)).toEqual(['WG_0004', 'QD_0003']);
    expect(newestFirst(photos)[0]!.id).toBe('WG_0004');
  });

  it('filters by kind and favourites', () => {
    expect(filterPhotos(photos, 'wiggle').length).toBe(3);
    expect(filterPhotos(photos, 'quad').map((p) => p.id)).toEqual(['QD_0003']);
    expect(filterPhotos(photos, 'favorites').length).toBe(2);
    expect(filterPhotos(photos, 'all').length).toBe(4);
  });
});

describe('arrivals', () => {
  it('keeps the shown list in place and counts what landed', () => {
    const shown = photos.slice(1);
    const onCard = [{ id: 'WG_0009', kind: 'wiggle', ts: at(26, 19), favorite: false } as PhotoLike, ...photos];
    const { kept, pending } = mergeArrivals(shown, onCard);
    expect(kept.map((p) => p.id)).toEqual(shown.map((p) => p.id));
    expect(pending.map((p) => p.id)).toEqual(['WG_0009', 'WG_0004']);
    expect(arrivalsLine(2)).toBe('2 new photos on the card.');
    expect(arrivalsLine(1)).toBe('1 new photo on the card.');
  });

  it('drops photos deleted on the camera', () => {
    const { kept } = mergeArrivals(photos, photos.slice(0, 2));
    expect(kept.length).toBe(2);
  });
});

describe('the single photo', () => {
  it('asks the camera’s own delete question', () => {
    expect(deleteQuestion(4)).toBe('Delete this photo? 4 frames. This cannot be undone.');
    expect(deleteQuestion(1)).toBe('Delete this photo? 1 frame. This cannot be undone.');
  });

  it('offers Save formats by kind, without engineering words', () => {
    expect(saveOptions('wiggle', true).map((o) => o.label)).toEqual(['Video (MP4)', 'GIF', 'The four photos']);
    expect(saveOptions('wiggle', false).map((o) => o.label)).toEqual(['GIF', 'The four photos']);
    expect(saveOptions('quad', true).map((o) => o.label)).toEqual(['One image', 'The four photos']);
    expect(kindWord('wiggle')).toBe('Wigglegram');
    expect(kindWord('quad')).toBe('Four-up');
  });

  it('shows Send to Roll only with a Roll to send to, and never for a folder', () => {
    expect(canSendToRoll(true, true, true)).toBe(true);
    expect(canSendToRoll(true, false, true)).toBe(false);
    expect(canSendToRoll(false, true, true)).toBe(false);
    expect(canSendToRoll(true, true, false)).toBe(false);
  });
});
