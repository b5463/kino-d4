import { useEffect, useMemo, useRef, useState } from 'react';
import { getDevice } from '../../app/session';
import { recipeName, supportsRollUpload, useDeviceStore } from '../../state/deviceStore';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import type { LocalCapture } from '../../device/localImport';
import { alignedSources, buildGifBytes, buildMp4Bytes, buildZipBytes, saveBlob } from '../../pages/Gallery/captureExports';
import { mp4Supported } from '../../utils/mp4';
import { captureOffsets, hasAnyOffset, offsetsForFrames } from '../../utils/wiggleRender';
import { ConfirmSheet } from '../Dialog';
import { Overflow } from '../looks/Overflow';
import { LENS_POSITIONS } from '../physical/fieldBody';
import { framesByLens, localFrames, useAlignedFrames } from '../shoot/useAlignedFrames';
import type { RawFrame } from '../shoot/useAlignedFrames';
import { feelForFps, useWiggleStep } from '../shoot/useWiggleStep';
import { clock } from '../copy';
import { canSendToRoll, dayLabel, deleteQuestion, kindWord, saveOptions } from './photoGroups';
import type { PhotoLike, SaveFormat } from './photoGroups';

export type PhotoChange = 'favourite' | 'unfavourite' | 'deleted';

/**
 * One photograph, the page-wide. A wigglegram is already moving when it
 * opens, one way, hard cuts, at the camera's feel; a four-up is four frames
 * in a row and one of them large. Save, Send to Roll, Favourite, and the
 * few things behind "…". Space pauses, arrows step, Escape closes.
 */
export function PhotoView({
  summary,
  local,
  rollActive,
  onClose,
  onChanged,
}: {
  summary: PhotoLike & { recipeIds?: string[] };
  /** A photo from a folder on this computer: nothing here may write to a card. */
  local?: LocalCapture;
  rollActive: boolean;
  onClose: () => void;
  onChanged: (change: PhotoChange) => void;
}) {
  const state = useDeviceStore();
  const reduced = useReducedMotion();
  const loaded = useAlignedFrames(local ? null : summary.id);
  const localRaw = useMemo(() => (local ? localFrames(local.frames) : null), [local]);
  useEffect(() => () => localRaw?.forEach((f) => URL.revokeObjectURL(f.url)), [localRaw]);
  const raw: RawFrame[] | null = local ? localRaw : loaded.raw;
  const info = local ? local.info : loaded.info;
  const frames = local && localRaw ? framesByLens(localRaw) : loaded.frames;
  const present = frames?.filter((f): f is string => f !== null) ?? [];

  const [paused, setPaused] = useState(reduced);
  const [manual, setManual] = useState<number | null>(null);
  const [bounce, setBounce] = useState(false);
  const [trim, setTrim] = useState(true);
  const [selectedFrame, setSelectedFrame] = useState(0);
  const [favourite, setFavourite] = useState(summary.favorite);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [mp4Ok, setMp4Ok] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const fps = state.config?.wiggle.fps ?? 10;
  const step = useWiggleStep(fps, bounce ? 'bounce' : 'continuous', 'ltr', present.length, paused || manual !== null);
  const shownIndex = manual ?? step;

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (deleteOpen) return;
      if (e.key === 'Escape') onClose();
      if (summary.kind !== 'wiggle' || present.length < 2) return;
      if (e.key === ' ') {
        e.preventDefault();
        setManual(null);
        setPaused((p) => !p);
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const d = e.key === 'ArrowRight' ? 1 : -1;
        setManual((m) => ((m ?? step) + d + present.length) % present.length);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      returnTo.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, deleteOpen, summary.kind, present.length]);

  useEffect(() => {
    if (summary.kind === 'wiggle') void mp4Supported(800, 600).then(setMp4Ok);
  }, [summary.kind]);

  const offsets = useMemo(() => {
    if (!raw) return null;
    const live = state.calibration ? { cams: state.calibration.cams } : null;
    const per = offsetsForFrames(captureOffsets(info, live), raw);
    return hasAnyOffset(per) ? per : null;
  }, [raw, info, state.calibration]);

  const save = async (format: SaveFormat) => {
    if (!raw) return;
    setNote(null);
    try {
      const sources = () => alignedSources(raw, trim ? offsets : null);
      if (format === 'mp4') saveBlob(`${summary.id}.mp4`, new Blob([(await buildMp4Bytes(await sources(), fps)) as BlobPart], { type: 'video/mp4' }));
      else if (format === 'gif') saveBlob(`${summary.id}.gif`, new Blob([buildGifBytes(await sources(), fps) as BlobPart], { type: 'image/gif' }));
      else if (format === 'one') {
        const blob = await sideBySide(await sources());
        if (blob) saveBlob(`${summary.id}.jpg`, blob);
      } else if (info) saveBlob(`${summary.id}.zip`, new Blob([buildZipBytes(raw, info) as BlobPart], { type: 'application/zip' }));
      else raw.forEach((f) => saveBlob(`${summary.id}_${f.name}`, new Blob([f.data as BlobPart], { type: 'image/jpeg' })));
    } catch {
      setNote("That didn't save. Try again.");
    }
  };

  const toggleFavourite = async () => {
    const dev = getDevice();
    if (!dev || local) return;
    const next = !favourite;
    setFavourite(next);
    try {
      await dev.mediaFavorite(summary.id, next);
      onChanged(next ? 'favourite' : 'unfavourite');
    } catch {
      setFavourite(!next);
      setNote("KINO didn't save that. Try again.");
    }
  };

  const sendToRoll = async () => {
    const dev = getDevice();
    if (!dev) return;
    try {
      await dev.uploadEnqueue(summary.id);
      setSent(true);
    } catch {
      setNote("Couldn't send. Try again later.");
    }
  };

  const remove = async () => {
    setDeleteOpen(false);
    const dev = getDevice();
    if (!dev) return;
    try {
      await dev.mediaDelete(summary.id);
      onChanged('deleted');
    } catch {
      setNote("KINO didn't delete this photo. Try again.");
    }
  };

  const looks = (summary.recipeIds ?? []).map((id) => recipeName(state, id));
  const metaLine = [
    summary.ts !== null ? `${dayLabel(summary.ts)} ${clock(summary.ts)}` : null,
    kindWord(summary.kind),
    summary.kind === 'wiggle' ? looks[0] : null,
    summary.kind === 'wiggle' ? feelForFps(fps) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const showSend = canSendToRoll(supportsRollUpload(state), rollActive, !local);

  return (
    <div className="c-photo" role="dialog" aria-modal="true" aria-label={`${kindWord(summary.kind)}${summary.ts !== null ? `, ${clock(summary.ts)}` : ''}`}>
      <div className="c-photo-inner">
        <div className="c-photo-head">
          <span>{metaLine}</span>
          <button ref={closeRef} type="button" className="c-photo-close c-word--quiet" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="c-photo-stage">
          {!frames ? (
            <p className="c-photo-loading">{loaded.error ? "Can't show this one." : 'Reading the photo from the card…'}</p>
          ) : summary.kind === 'wiggle' ? (
            <img src={present[shownIndex] ?? present[0]} alt={`Frame ${shownIndex + 1} of ${present.length}`} />
          ) : (
            <>
              <div className="c-photo-fourup">
                {frames.map((url, i) =>
                  url ? (
                    <button key={i} type="button" aria-pressed={selectedFrame === i} aria-label={`${LENS_POSITIONS[i]} lens${looks[i] ? `, ${looks[i]}` : ''}`} onClick={() => setSelectedFrame(i)}>
                      <img src={url} alt="" />
                    </button>
                  ) : null,
                )}
              </div>
              {frames[selectedFrame] ? (
                <div className="c-photo-large">
                  <img src={frames[selectedFrame]!} alt={`${LENS_POSITIONS[selectedFrame]} lens, large`} />
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className="c-photo-actions">
          {raw ? <Overflow trigger="Save" quiet={false} items={saveOptions(summary.kind, mp4Ok).map((o) => ({ label: o.label, onSelect: () => void save(o.id) }))} /> : null}
          {showSend ? (
            <button type="button" className="c-word" disabled={sent} onClick={() => void sendToRoll()}>
              {sent ? 'Sent to the Roll' : 'Send to Roll'}
            </button>
          ) : null}
          {!local ? (
            <button type="button" className="c-word" aria-pressed={favourite} onClick={() => void toggleFavourite()}>
              {favourite ? 'Favourite ●' : 'Favourite'}
            </button>
          ) : null}
          {!local ? (
            <Overflow
              items={[
                { label: favourite ? 'Unfavourite' : 'Favourite', onSelect: () => void toggleFavourite() },
                ...(summary.kind === 'wiggle' && offsets ? [{ label: trim ? 'Show the full frame' : 'Trim to match', onSelect: () => setTrim((t) => !t) }] : []),
                ...(summary.kind === 'wiggle' ? [{ label: bounce ? 'Play one way' : 'Play back and forth', onSelect: () => setBounce((b) => !b) }] : []),
                { label: 'Delete', warning: true, onSelect: () => setDeleteOpen(true) },
              ]}
            />
          ) : null}
          {note ? <span className="c-mark">{note}</span> : null}
        </div>
      </div>
      <ConfirmSheet open={deleteOpen} confirmLabel="Delete" warning onCancel={() => setDeleteOpen(false)} onConfirm={() => void remove()}>
        <p>{deleteQuestion(present.length || 4)}</p>
      </ConfirmSheet>
    </div>
  );
}

/** The four frames side by side as one image, in lens order, no labels. */
async function sideBySide(sources: (HTMLImageElement | HTMLCanvasElement)[]): Promise<Blob | null> {
  if (sources.length === 0) return null;
  const w = sources[0] instanceof HTMLImageElement ? sources[0].naturalWidth : sources[0]!.width;
  const h = sources[0] instanceof HTMLImageElement ? sources[0].naturalHeight : sources[0]!.height;
  const canvas = document.createElement('canvas');
  canvas.width = w * sources.length;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  sources.forEach((s, i) => ctx.drawImage(s, i * w, 0, w, h));
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
}
