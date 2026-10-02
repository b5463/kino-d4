import { useEffect, useState } from 'react';
import type { CaptureKind, CaptureSummary } from '@kino/kdp';
import { getDevice, onCaptureEvent } from '../../app/session';
import { useDeviceStore } from '../../state/deviceStore';
import { galleryPageRequest } from '../../utils/limits';
import { useAlignedFrames } from './useAlignedFrames';

export interface LastPhoto {
  summary: CaptureSummary | null;
  /** Frame URLs indexed by lens (0 = left). Null entries for lenses that did not answer. */
  frames: (string | null)[] | null;
  /** True while the index or the frames are still loading. */
  loading: boolean;
}

/**
 * The most recent photograph on the card of the kind asked for (`null` =
 * any), with its frames in lens order. Re-reads when the camera reports a
 * new capture, so the result beside the body is always the last one.
 */
export function useLastPhoto(kind: CaptureKind | null): LastPhoto {
  const [summary, setSummary] = useState<CaptureSummary | null>(null);
  const [indexed, setIndexed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      const dev = getDevice();
      if (!dev) return;
      try {
        const limit = galleryPageRequest(useDeviceStore.getState().limits);
        const page = await dev.mediaList({ cursor: 0, limit });
        if (cancelled) return;
        const items = page.items.filter((c) => (kind ? c.kind === kind : true)).sort((a, b) => b.ts - a.ts);
        setSummary(items[0] ?? null);
      } catch {
        if (!cancelled) setSummary(null);
      } finally {
        if (!cancelled) setIndexed(true);
      }
    };
    void read();
    const off = onCaptureEvent(() => void read());
    return () => {
      cancelled = true;
      off();
    };
  }, [kind]);

  const loaded = useAlignedFrames(summary?.id ?? null);
  return { summary, frames: loaded.frames, loading: !indexed || (summary !== null && loaded.loading) };
}
