import { useEffect, useState } from 'react';
import type { CalibrationData, CamId, CaptureInfo } from '@kino/kdp';
import { getDevice } from '../../app/session';
import { downloadCaptureSet, TransferCancelled, TransferHandle } from '../../device/media';
import { useDeviceStore } from '../../state/deviceStore';
import { buildAlignedFrames, captureOffsets, offsetsForFrames } from '../../utils/wiggleRender';
import { slotFromFileName, slotIndex } from '../../utils/camSlots';

/** One frame as downloaded: its bytes, an object URL for it, and which lens took it. */
export interface RawFrame {
  name: string;
  data: Uint8Array;
  url: string;
  slot: CamId | null;
}

export interface AlignedFrames {
  info: CaptureInfo | null;
  /** The frames as they came off the card, in file order. For exports. */
  raw: RawFrame[] | null;
  /** Frame URLs by lens (0 = left), aligned and cropped when calibration says how. Null entries for lenses that did not answer. */
  frames: (string | null)[] | null;
  loading: boolean;
  error: string | null;
}

/**
 * The four frames of one photograph, in lens order, aligned.
 *
 * Frames come through the same download path everything else uses; when
 * calibration carries offsets they are shifted and cropped the way an export
 * would be, because that is what makes a wigglegram snap instead of swim.
 * Object URLs are owned by the effect and revoked when the photo changes.
 */
export function useAlignedFrames(id: string | null): AlignedFrames {
  const calibration = useDeviceStore((s) => s.calibration);
  const [loaded, setLoaded] = useState<{ id: string; info: CaptureInfo; raw: RawFrame[]; frames: (string | null)[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (!id) return;
    const dev = getDevice();
    if (!dev) return;
    const handle = new TransferHandle();
    let cancelled = false;
    const created: string[] = [];
    void (async () => {
      try {
        const info = await dev.mediaInfo(id);
        const files = await downloadCaptureSet(dev, info, handle);
        if (cancelled) return;
        const raw: RawFrame[] = files.map((f) => ({
          name: f.name,
          data: f.data,
          url: URL.createObjectURL(new Blob([f.data as BlobPart], { type: 'image/jpeg' })),
          slot: slotFromFileName(f.name),
        }));
        created.push(...raw.map((r) => r.url));
        const frames = await alignFrames(raw, info, calibration);
        if (cancelled) return;
        created.push(...frames.filter((u): u is string => u !== null && !raw.some((r) => r.url === u)));
        setLoaded({ id, info, raw, frames });
      } catch (err) {
        if (!cancelled && !(err instanceof TransferCancelled)) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      handle.cancel();
      created.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [id, calibration]);

  const current = loaded && loaded.id === id ? loaded : null;
  return {
    info: current?.info ?? null,
    raw: current?.raw ?? null,
    frames: current?.frames ?? null,
    loading: id !== null && current === null && error === null,
    error,
  };
}

/** Frame URLs in lens order, aligned when calibration says how. */
export async function alignFrames(
  raw: RawFrame[],
  info: { meta?: CaptureInfo['meta'] } | null,
  calibration: CalibrationData | null,
): Promise<(string | null)[]> {
  const byLens: (string | null)[] = [null, null, null, null];
  const live = calibration ? { cams: calibration.cams } : null;
  const offsets = offsetsForFrames(captureOffsets(info, live), raw);
  try {
    const images = await Promise.all(raw.map((f) => loadImage(f.url)));
    const canvases = buildAlignedFrames(images, offsets);
    if (canvases) {
      const blobs = await Promise.all(canvases.map((c) => toBlob(c)));
      raw.forEach((f, i) => {
        const at = slotIndex(f.slot);
        const blob = blobs[i];
        if (at >= 0 && at < 4) byLens[at] = blob ? URL.createObjectURL(blob) : f.url;
      });
      return byLens;
    }
  } catch {
    // Fall through to the unaligned frames.
  }
  raw.forEach((f) => {
    const at = slotIndex(f.slot);
    if (at >= 0 && at < 4) byLens[at] = f.url;
  });
  return byLens;
}

/** Frames of a folder on this computer, by lens, no alignment (no calibration to align with). */
export function localFrames(files: { name: string; data: Uint8Array }[]): RawFrame[] {
  return files.map((f) => ({
    name: f.name,
    data: f.data,
    url: URL.createObjectURL(new Blob([f.data as BlobPart], { type: 'image/jpeg' })),
    slot: slotFromFileName(f.name),
  }));
}

export function framesByLens(raw: RawFrame[]): (string | null)[] {
  const byLens: (string | null)[] = [null, null, null, null];
  raw.forEach((f, i) => {
    const at = f.slot ? slotIndex(f.slot) : i;
    if (at >= 0 && at < 4) byLens[at] = f.url;
  });
  return byLens;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not decode ${url}`));
    img.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9));
}
