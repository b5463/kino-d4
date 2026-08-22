// Where the inspector's four frames come from. The device path is the
// MEDIA_INFO + chunked download it has always run; the local path is a folder
// already read into memory by device/localImport. Everything downstream works
// on `frames`, so the two are interchangeable.

import { useEffect, useState } from 'react';
import type { CaptureInfo } from '@kino/kdp';
import { getDevice } from '../../app/session';
import { downloadCaptureSet, TransferCancelled, TransferHandle } from '../../device/media';
import type { LocalCapture } from '../../device/localImport';

export interface CaptureFrame {
  name: string;
  data: Uint8Array;
  url: string;
}

export type CaptureSource = { kind: 'device' } | { kind: 'local'; capture: LocalCapture };

/** Module constant so the load effect is not re-run on every render. */
export const DEVICE_SOURCE: CaptureSource = { kind: 'device' };

export interface CaptureFramesState {
  info: CaptureInfo | null;
  frames: CaptureFrame[] | null;
  progress: { pct: number; label: string };
  error: string | null;
}

function toFrame(f: { name: string; data: Uint8Array }): CaptureFrame {
  return { ...f, url: URL.createObjectURL(new Blob([new Uint8Array(f.data)], { type: 'image/jpeg' })) };
}

export function useCaptureFrames(source: CaptureSource, summaryId: string): CaptureFramesState {
  const [info, setInfo] = useState<CaptureInfo | null>(null);
  const [frames, setFrames] = useState<CaptureFrame[] | null>(null);
  const [progress, setProgress] = useState({ pct: 0, label: 'Reading capture info…' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Object URLs are owned by this effect run: whatever it created is
    // revoked when the capture changes or the inspector closes.
    let created: CaptureFrame[] = [];
    const release = () => {
      created.forEach((f) => URL.revokeObjectURL(f.url));
      created = [];
    };

    setInfo(null);
    setFrames(null);
    setError(null);
    setProgress({ pct: 0, label: 'Reading capture info…' });

    if (source.kind === 'local') {
      created = source.capture.frames.map(toFrame);
      setInfo(source.capture.info);
      setFrames(created);
      return release;
    }

    const handle = new TransferHandle();
    const dev = getDevice();
    if (!dev) {
      setError('KINO is not connected.');
      return release;
    }
    void (async () => {
      try {
        const capInfo = await dev.mediaInfo(summaryId);
        if (cancelled) return;
        setInfo(capInfo);
        const files = await downloadCaptureSet(dev, capInfo, handle, (p) => {
          if (cancelled) return;
          const overall = (p.fileIndex + p.bytesDone / p.bytesTotal) / p.fileCount;
          setProgress({
            pct: Math.round(overall * 100),
            label: `Downloading ${p.file} — ${Math.round((p.bytesDone / p.bytesTotal) * 100)}%`,
          });
        });
        if (cancelled) return;
        created = files.map(toFrame);
        setFrames(created);
      } catch (err) {
        if (!cancelled && !(err instanceof TransferCancelled)) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
      handle.cancel();
      release();
    };
  }, [source, summaryId]);

  return { info, frames, progress, error };
}
