import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureSummary } from '@kino/kdp';
import { getDevice, onCaptureEvent } from '../../app/session';
import { useDeviceStore } from '../../state/deviceStore';
import { galleryPageRequest } from '../../utils/limits';
import { mergeArrivals } from './photoGroups';

/** How many index rows Studio reads in one visit. Nobody scrolls to card 7,412. */
export const INDEX_CAP = 5000;

export interface PhotoIndex {
  /** The list on screen. Null before the first read. */
  photos: CaptureSummary[] | null;
  /** Arrivals waiting behind "N new photos on the card." */
  pending: CaptureSummary[];
  error: string | null;
  reveal: () => void;
  /** A photo was deleted or changed here; keep the list honest without moving it. */
  update: (id: string, patch: Partial<CaptureSummary> | null) => void;
}

/**
 * The card's index, paged the way the wire contract asks. Arrivals while
 * browsing wait behind one line rather than pushing the grid down.
 */
export function usePhotoIndex(): PhotoIndex {
  const [photos, setPhotos] = useState<CaptureSummary[] | null>(null);
  const [pending, setPending] = useState<CaptureSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const shownRef = useRef<CaptureSummary[] | null>(null);
  shownRef.current = photos;

  const load = useCallback(async (mode: 'replace' | 'merge') => {
    const dev = getDevice();
    if (!dev) return;
    try {
      const all: CaptureSummary[] = [];
      let cursor: number | null = 0;
      const limit = galleryPageRequest(useDeviceStore.getState().limits);
      while (cursor !== null && alive.current && all.length < INDEX_CAP) {
        const chunk = await dev.mediaList({ cursor, limit });
        all.push(...chunk.items);
        cursor = chunk.hasMore ? chunk.nextCursor : null;
      }
      if (!alive.current) return;
      setError(null);
      const shown = shownRef.current;
      if (mode === 'replace' || shown === null) {
        setPhotos(all);
        setPending([]);
        return;
      }
      const merged = mergeArrivals(shown, all);
      setPhotos(merged.kept);
      setPending(merged.pending);
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load('replace');
    return () => {
      alive.current = false;
    };
  }, [load]);

  useEffect(() => onCaptureEvent(() => void load('merge')), [load]);

  const reveal = useCallback(() => {
    setPhotos((shown) => [...pending, ...(shown ?? [])]);
    setPending([]);
  }, [pending]);

  const update = useCallback((id: string, patch: Partial<CaptureSummary> | null) => {
    setPhotos((shown) => (shown ? (patch === null ? shown.filter((p) => p.id !== id) : shown.map((p) => (p.id === id ? { ...p, ...patch } : p))) : shown));
  }, []);

  return { photos, pending, error, reveal, update };
}
