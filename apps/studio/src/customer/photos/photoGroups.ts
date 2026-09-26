// Photos, grouped by day, filtered, and the sentences around them. Pure so
// the page's rules can be asserted without a DOM.

import type { CaptureKind } from '@kino/kdp';

export interface PhotoLike {
  id: string;
  kind: CaptureKind;
  /** Epoch ms; null when nothing records when the shutter fired (a folder). */
  ts: number | null;
  favorite: boolean;
}

export type PhotoFilter = 'all' | 'wiggle' | 'quad' | 'favorites';

export const PHOTO_FILTERS: { id: PhotoFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'wiggle', label: 'Wigglegrams' },
  { id: 'quad', label: 'Four-ups' },
  { id: 'favorites', label: 'Favourites' },
];

export function filterPhotos<T extends PhotoLike>(list: T[], filter: PhotoFilter): T[] {
  return list.filter((p) => (filter === 'all' ? true : filter === 'favorites' ? p.favorite : p.kind === filter));
}

/** Newest first; photos without a time last. */
export function newestFirst<T extends PhotoLike>(list: T[]): T[] {
  return [...list].sort((a, b) => (b.ts ?? -Infinity) - (a.ts ?? -Infinity));
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today", "Yesterday", "21 September", "21 September 2025" for another year. */
export function dayLabel(ts: number | null, now = new Date()): string {
  if (ts === null) return 'Undated';
  const d = new Date(ts);
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-GB', sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
}

export interface DayGroup<T> {
  label: string;
  items: T[];
}

export function groupByDay<T extends PhotoLike>(list: T[], now = new Date()): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of newestFirst(list)) {
    const label = dayLabel(item.ts, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/**
 * New photos that landed while browsing are counted, not inserted: the tile
 * under the cursor must stay the tile that was clicked. Deleted ones drop
 * out; the rest are refreshed in place.
 */
export function mergeArrivals<T extends PhotoLike>(shown: T[], onCard: T[]): { kept: T[]; pending: T[] } {
  const byId = new Map(onCard.map((c) => [c.id, c]));
  const kept = shown.map((c) => byId.get(c.id)).filter((c): c is T => c !== undefined);
  const keptIds = new Set(kept.map((c) => c.id));
  return { kept, pending: onCard.filter((c) => !keptIds.has(c.id)) };
}

export function arrivalsLine(n: number): string {
  return `${n} new ${n === 1 ? 'photo' : 'photos'} on the card.`;
}

export function kindWord(kind: CaptureKind): string {
  return kind === 'wiggle' ? 'Wigglegram' : 'Four-up';
}

export function deleteQuestion(frames: number): string {
  return `Delete this photo? ${frames} ${frames === 1 ? 'frame' : 'frames'}. This cannot be undone.`;
}

export type SaveFormat = 'mp4' | 'gif' | 'one' | 'photos';

/** What Save offers for each kind, in the order it offers them. */
export function saveOptions(kind: CaptureKind, mp4Ok: boolean): { id: SaveFormat; label: string }[] {
  if (kind === 'wiggle') {
    return [...(mp4Ok ? [{ id: 'mp4' as const, label: 'Video (MP4)' }] : []), { id: 'gif', label: 'GIF' }, { id: 'photos', label: 'The four photos' }];
  }
  return [
    { id: 'one', label: 'One image' },
    { id: 'photos', label: 'The four photos' },
  ];
}

/** "Send to Roll" exists only with somewhere to send to. */
export function canSendToRoll(rollUpload: boolean, rollActive: boolean, onCard: boolean): boolean {
  return rollUpload && rollActive && onCard;
}
