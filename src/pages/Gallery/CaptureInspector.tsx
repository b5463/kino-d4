import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { getDevice } from '../../app/session';
import { useDeviceStore, recipeName } from '../../state/deviceStore';
import { useModal } from '../../hooks/useModal';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { downloadCaptureSet, TransferHandle, TransferCancelled } from '../../device/media';
import type { CaptureInfo, CaptureSummary } from '../../protocol/types';
import { buildZip } from '../../utils/zip';
import { encodeGif } from '../../utils/gif';
import type { GifFrame } from '../../utils/gif';
import { mp4Supported, encodeWiggleMp4 } from '../../utils/mp4';
import { AlignEditor } from './AlignEditor';
import { MatchPanel } from './MatchPanel';
import { buildAlignedFrames, hasAnyOffset } from '../../utils/wiggleRender';
import { CAM_IDS } from '../../protocol/types';
const SEQ_BOUNCE = [0, 1, 2, 3, 2, 1];

function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function CaptureInspector({
  summary,
  onClose,
  onChanged,
}: {
  summary: CaptureSummary;
  onClose: () => void;
  onChanged: (change: 'favorite' | 'deleted') => void;
}) {
  const deviceState = useDeviceStore();
  const wiggleCfg = deviceState.config?.wiggle;
  const calibration = deviceState.calibration;
  const reducedMotion = useReducedMotion();
  const [info, setInfo] = useState<CaptureInfo | null>(null);
  const [frames, setFrames] = useState<{ name: string; data: Uint8Array; url: string }[] | null>(null);
  const [progress, setProgress] = useState({ pct: 0, label: 'Reading capture info…' });
  const [error, setError] = useState<string | null>(null);
  // Reduced motion means the capture opens on a still frame. PLAY stays
  // available — the setting suppresses autoplay, not playback.
  const [playing, setPlaying] = useState(!reducedMotion);
  const [fps, setFps] = useState(wiggleCfg?.fps ?? 10);
  const [frameIdx, setFrameIdx] = useState(0);
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const [favorite, setFavorite] = useState(summary.favorite);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [alignMode, setAlignMode] = useState(false);
  const [alignDirty, setAlignDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [mp4Ok, setMp4Ok] = useState<boolean | null>(null);
  const camOffsets = CAM_IDS.map((id) => {
    const c = calibration?.cams[id];
    return { x: c?.x ?? 0, y: c?.y ?? 0, rot: c?.rot ?? 0 };
  });
  const offsetsAvailable = hasAnyOffset(camOffsets);
  const [alignedCrop, setAlignedCrop] = useState(true);
  const handleRef = useRef(new TransferHandle());
  const stepRef = useRef(0);
  const headId = useId();
  const descId = useId();
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // `useModal` keys its listener off the identity of `onClose`, so the close
  // handler has to be stable: rebuilding it on every offset nudge would tear
  // the listener down and yank focus back to the capture card mid-edit.
  const latest = useRef({ alignMode, alignDirty, nested: false, onClose });
  useEffect(() => {
    latest.current = { alignMode, alignDirty, nested: deleteOpen || discardOpen, onClose };
  });

  const requestClose = useCallback(() => {
    const l = latest.current;
    // A nested confirm owns Escape while it is up; both dialogs listen on
    // window, and the outer listener fires first.
    if (l.nested) return;
    if (l.alignMode && l.alignDirty) {
      setDiscardOpen(true);
      return;
    }
    l.onClose();
  }, []);

  const dialogRef = useModal({ open: true, onClose: requestClose, initialFocus: closeBtnRef });

  const leaveAlign = useCallback(() => {
    setAlignMode(false);
    setAlignDirty(false);
  }, []);

  // Leaving align mode unmounts the editor's buttons; hand focus back to the
  // head instead of letting it fall to <body>.
  const wasAlign = useRef(false);
  useEffect(() => {
    if (wasAlign.current && !alignMode) closeBtnRef.current?.focus();
    wasAlign.current = alignMode;
  }, [alignMode]);

  // Load metadata + all four originals with live progress.
  useEffect(() => {
    const handle = handleRef.current;
    let cancelled = false;
    const dev = getDevice();
    if (!dev) return;
    void (async () => {
      try {
        const capInfo = await dev.mediaInfo(summary.id);
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
        setFrames(
          files.map((f) => ({
            ...f,
            url: URL.createObjectURL(new Blob([new Uint8Array(f.data)], { type: 'image/jpeg' })),
          })),
        );
      } catch (err) {
        if (!cancelled && !(err instanceof TransferCancelled)) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
      handle.cancel();
    };
  }, [summary.id]);

  useEffect(() => {
    return () => {
      // Revoke object URLs on unmount.
      setFrames((f) => {
        f?.forEach((frame) => URL.revokeObjectURL(frame.url));
        return f;
      });
    };
  }, []);

  useEffect(() => {
    if (summary.kind !== 'wiggle') return;
    void mp4Supported(800, 600).then(setMp4Ok);
  }, [summary.kind]);

  const loadImages = async (): Promise<HTMLImageElement[]> => {
    if (!frames) throw new Error('Frames not loaded');
    return Promise.all(
      frames.map(
        (f) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('decode failed'));
            img.src = f.url;
          }),
      ),
    );
  };

  const alignedSources = async (): Promise<(HTMLImageElement | HTMLCanvasElement)[]> => {
    const imgs = await loadImages();
    if (alignedCrop && offsetsAvailable) {
      const aligned = buildAlignedFrames(imgs, camOffsets);
      if (aligned) return aligned;
    }
    return imgs;
  };

  const exportMp4 = async () => {
    setExporting('mp4');
    try {
      const imgs = await alignedSources();
      const bytes = await encodeWiggleMp4(imgs, fps);
      saveBlob(`${summary.id}.mp4`, new Blob([bytes as BlobPart], { type: 'video/mp4' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(null);
    }
  };

  // Wiggle playback: bounce through the four viewpoints at the chosen fps.
  useEffect(() => {
    if (summary.kind !== 'wiggle' || !playing || !frames || selectedFrame !== null) return;
    const timer = setInterval(() => {
      stepRef.current = (stepRef.current + 1) % SEQ_BOUNCE.length;
      setFrameIdx(SEQ_BOUNCE[stepRef.current]);
    }, Math.max(1000 / fps, 40));
    return () => clearInterval(timer);
  }, [summary.kind, playing, frames, fps, selectedFrame]);

  const shownFrame = selectedFrame ?? frameIdx;

  const rgbaFrames = useMemo(() => {
    return async (): Promise<{ w: number; h: number; frames: GifFrame[] } | null> => {
      if (!frames) return null;
      const sources = await alignedSources();
      const srcW = sources[0] instanceof HTMLImageElement ? sources[0].naturalWidth : sources[0].width;
      const srcH = sources[0] instanceof HTMLImageElement ? sources[0].naturalHeight : sources[0].height;
      const w = Math.min(srcW, 640);
      const h = Math.round((srcH / srcW) * w);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const delay = 1000 / fps;
      const gifFrames: GifFrame[] = SEQ_BOUNCE.map((idx) => {
        ctx.drawImage(sources[idx], 0, 0, w, h);
        return { rgba: ctx.getImageData(0, 0, w, h).data, delayMs: delay };
      });
      return { w, h, frames: gifFrames };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, fps, alignedCrop, offsetsAvailable]);

  const exportGif = async () => {
    setExporting('gif');
    try {
      const data = await rgbaFrames();
      if (!data) return;
      const gif = encodeGif(data.w, data.h, data.frames);
      saveBlob(`${summary.id}.gif`, new Blob([gif as BlobPart], { type: 'image/gif' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(null);
    }
  };

  const exportZip = () => {
    if (!frames || !info) return;
    setExporting('zip');
    try {
      const entries = frames.map((f, i) => ({ name: `C${i + 1}_RAW.JPG`, data: f.data }));
      entries.push({
        name: 'metadata.json',
        data: new TextEncoder().encode(JSON.stringify(info, null, 2)),
      });
      saveBlob(`${summary.id}.zip`, new Blob([buildZip(entries) as BlobPart], { type: 'application/zip' }));
    } finally {
      setExporting(null);
    }
  };

  const exportContactSheet = async () => {
    if (!frames) return;
    setExporting('sheet');
    try {
      const imgs = await Promise.all(
        frames.map(
          (f) =>
            new Promise<HTMLImageElement>((resolve) => {
              const img = new Image();
              img.onload = () => resolve(img);
              img.src = f.url;
            }),
        ),
      );
      const fw = imgs[0].naturalWidth;
      const fh = imgs[0].naturalHeight;
      const pad = 12;
      const canvas = document.createElement('canvas');
      canvas.width = fw * 2 + pad * 3;
      canvas.height = fh * 2 + pad * 3 + 26;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#f2f4f7';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      imgs.forEach((img, i) => {
        const x = pad + (i % 2) * (fw + pad);
        const y = pad + Math.floor(i / 2) * (fh + pad);
        ctx.drawImage(img, x, y);
        ctx.fillStyle = 'rgba(20,32,48,0.8)';
        ctx.fillRect(x + 6, y + fh - 24, 52, 18);
        ctx.fillStyle = '#fff';
        ctx.font = '700 12px Consolas, monospace';
        ctx.fillText(`CAM ${i + 1}`, x + 11, y + fh - 11);
      });
      ctx.fillStyle = '#536273';
      ctx.font = '700 13px Consolas, monospace';
      ctx.fillText(`${summary.id} · ${new Date(summary.ts).toLocaleString()} · KINO`, pad, canvas.height - 10);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      if (blob) saveBlob(`${summary.id}_sheet.jpg`, blob);
    } finally {
      setExporting(null);
    }
  };

  const toggleFavorite = async () => {
    const dev = getDevice();
    if (!dev) return;
    const next = !favorite;
    setFavorite(next);
    try {
      await dev.mediaFavorite(summary.id, next);
      onChanged('favorite');
    } catch {
      setFavorite(!next);
    }
  };

  const doDelete = async () => {
    const dev = getDevice();
    if (!dev) return;
    setDeleteOpen(false);
    try {
      await dev.mediaDelete(summary.id);
      onChanged('deleted');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Looks are stored by recipe id; users know them by name.
  const lookName = (id: string | undefined) =>
    id ? recipeName(deviceState, id).toUpperCase() : '';

  const kindLabel = summary.kind === 'wiggle' ? 'WIGGLEGRAM' : 'QUAD SET';

  return (
    <>
      <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
        <div
          ref={dialogRef}
          className="dialog dialog--wide"
          role="dialog"
          aria-modal="true"
          aria-labelledby={headId}
          aria-describedby={descId}
        >
          <div className="dialog-head">
            <span id={headId}>
              {alignMode
                ? `${summary.id} — ALIGN (WRITES DEVICE CALIBRATION)`
                : `${summary.id} — ${kindLabel}`}
            </span>
            {alignMode ? (
              // One way out in align mode: the editor's own CANCEL / SAVE.
              <span className="microlabel" style={{ marginLeft: 'auto' }}>
                CANCEL OR SAVE BELOW
              </span>
            ) : (
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <Button size="sm" onClick={() => void toggleFavorite()}>
                  {favorite ? '♥ FAVORITE' : '♡ FAVORITE'}
                </Button>
                <Button ref={closeBtnRef} size="sm" onClick={requestClose}>
                  CLOSE
                </Button>
              </span>
            )}
          </div>
          <div className="dialog-body">
            <p id={descId} className="microlabel" style={{ margin: '0 0 8px' }}>
              {alignMode
                ? 'SAVE WRITES X / Y / ROTATION TO DEVICE CALIBRATION — IT AFFECTS EVERY CAPTURE, NOT JUST THIS ONE.'
                : `${kindLabel} · ${frames ? `${frames.length} FRAMES` : 'LOADING FRAMES'} · ESC CLOSES`}
            </p>

            {error ? <p className="notice notice--err">{error}</p> : null}

            {!frames ? (
              <div className="transferbar" style={{ padding: '30px 10px' }}>
                <span className="mono">{progress.label}</span>
                <span className="meter" style={{ flex: 1 }}>
                  <span className="meter-fill" style={{ width: `${progress.pct}%`, display: 'block' }} />
                </span>
                <span className="val">{progress.pct}%</span>
              </div>
            ) : alignMode ? (
              <AlignEditor
                frameUrls={frames.map((f) => f.url)}
                onClose={leaveAlign}
                onDirtyChange={setAlignDirty}
              />
            ) : (
              <>
                <div className="inspector-stage">
                  {summary.kind === 'wiggle' && selectedFrame === null ? (
                    <img src={frames[shownFrame].url} alt={`Camera ${shownFrame + 1} viewpoint`} />
                  ) : summary.kind === 'quad' && selectedFrame === null ? (
                    <div className="inspector-quad">
                      {frames.map((f, i) => (
                        <figure key={f.name}>
                          <img src={f.url} alt={`CAM ${i + 1}`} />
                          <figcaption>
                            CAM {i + 1}
                            {info && info.recipeIds[i] ? ` · ${lookName(info.recipeIds[i])}` : ''}
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  ) : (
                    <img src={frames[shownFrame].url} alt={`Camera ${shownFrame + 1} frame`} />
                  )}
                </div>

                {/* Each frame carries its own download, so the tools row below is
                    only whole-capture exports. */}
                <div className="inspector-strip">
                  {frames.map((f, i) => (
                    <span key={f.name} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <button
                        type="button"
                        aria-pressed={selectedFrame === i}
                        aria-label={`Inspect CAM ${i + 1} frame`}
                        onClick={() => setSelectedFrame(selectedFrame === i ? null : i)}
                      >
                        <img src={f.url} alt="" />
                      </button>
                      <Button
                        size="sm"
                        aria-label={`Download CAM ${i + 1} JPEG`}
                        title={`Save ${summary.id}_C${i + 1}.jpg`}
                        style={{ padding: '0 4px' }}
                        onClick={() =>
                          saveBlob(
                            `${summary.id}_C${i + 1}.jpg`,
                            new Blob([f.data as BlobPart], { type: 'image/jpeg' }),
                          )
                        }
                      >
                        ↓ C{i + 1}.JPG
                      </Button>
                    </span>
                  ))}
                  {summary.kind === 'wiggle' ? (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8 }}>
                      <Button size="sm" onClick={() => setPlaying(!playing)} disabled={selectedFrame !== null}>
                        {playing && selectedFrame === null ? 'PAUSE' : 'PLAY'}
                      </Button>
                      <span className="sliderwrap" style={{ width: 150 }}>
                        <input
                          type="range"
                          min={5}
                          max={15}
                          value={fps}
                          aria-label="Playback speed"
                          onChange={(e) => setFps(Number(e.target.value))}
                        />
                        <span className="slider-val">{fps} FPS</span>
                      </span>
                    </span>
                  ) : null}
                </div>

                {/* The row itself must not wrap: a wrapping parent breaks the
                    line before it shrinks anything, which dropped DELETE onto a
                    second row directly under the export chips. */}
                <div className="inspector-tools" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                  <span
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      gap: 6,
                      flex: '1 1 auto',
                      minWidth: 0,
                    }}
                  >
                    <span className="microlabel">EXPORT</span>
                    <Button size="sm" busy={exporting === 'zip'} onClick={exportZip}>
                      ZIP PACKAGE
                    </Button>
                    {summary.kind === 'wiggle' ? (
                      <>
                        <Button size="sm" busy={exporting === 'gif'} onClick={() => void exportGif()}>
                          ANIMATED GIF
                        </Button>
                        <Button
                          size="sm"
                          busy={exporting === 'mp4'}
                          disabled={mp4Ok === false}
                          title={mp4Ok === false ? 'No H.264 encoder in this browser' : 'H.264 MP4, bounce sequence'}
                          onClick={() => void exportMp4()}
                        >
                          MP4
                        </Button>
                      </>
                    ) : null}
                    <Button size="sm" busy={exporting === 'sheet'} onClick={() => void exportContactSheet()}>
                      CONTACT SHEET
                    </Button>
                    {summary.kind === 'wiggle' ? (
                      <>
                        <Button
                          size="sm"
                          aria-pressed={alignedCrop && offsetsAvailable}
                          disabled={!offsetsAvailable}
                          title={
                            offsetsAvailable
                              ? 'Apply calibration offsets and common crop to exports'
                              : 'No calibration offsets stored'
                          }
                          onClick={() => setAlignedCrop(!alignedCrop)}
                        >
                          {alignedCrop && offsetsAvailable ? 'ALIGNED CROP' : 'FULL FRAME'}
                        </Button>
                        {/* Label and button travel together when the row wraps. */}
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
                          <span className="microlabel">CALIBRATION</span>
                          <Button
                            size="sm"
                            title="Nudge camera offsets against CAM2 and write them to device calibration"
                            onClick={() => setAlignMode(true)}
                          >
                            ALIGN
                          </Button>
                        </span>
                      </>
                    ) : null}
                  </span>
                  {/* DELETE is not an export. Own trailing group, ruled off. */}
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      flex: 'none',
                      marginLeft: 14,
                      paddingLeft: 14,
                      borderLeft: '1px solid var(--border-mid)',
                    }}
                  >
                    <Button size="sm" variant="danger" onClick={() => setDeleteOpen(true)}>
                      DELETE
                    </Button>
                  </span>
                </div>
              </>
            )}

            {frames && !alignMode ? (
              <MatchPanel frameUrls={frames.map((f) => f.url)} isWiggle={summary.kind === 'wiggle'} />
            ) : null}

            {info ? (
              <div style={{ marginTop: 10 }}>
                <dl>
                  <div className="datarow"><dt>Taken</dt><dd>{new Date(info.ts).toLocaleString()}</dd></div>
                  <div className="datarow">
                    <dt>{summary.kind === 'wiggle' ? 'Look' : 'Looks (CAM 1–4)'}</dt>
                    <dd>{info.recipeIds.map((id) => lookName(id)).join(' · ')}</dd>
                  </div>
                  <div className="datarow">
                    <dt>Resolution</dt>
                    <dd>{info.resolution.replace('x', '×')} · {info.totalKB} KB total</dd>
                  </div>
                  <div className="datarow"><dt>Flash</dt><dd>{info.meta.flash ? 'FIRED' : 'OFF'}</dd></div>
                  {info.meta.exposure.length > 0 ? (
                    <div className="datarow" style={{ maxWidth: 'none' }}>
                      <dt>Shutter / gain</dt>
                      <dd>
                        {info.meta.exposure.map((e) => (
                          <span key={e.cam} style={{ marginRight: 14, whiteSpace: 'nowrap' }}>
                            {e.cam.toUpperCase().replace('CAM', 'CAM ')} {e.shutter} · {e.gain}×
                          </span>
                        ))}
                      </dd>
                    </div>
                  ) : null}
                  {/* The number that decides a wigglegram is the effective
                      exposure spread, and firmware does not record it per
                      capture — only GPIO distribution reaches the card. Say
                      that, in the place the spread would occupy, instead of
                      leaving the µs figure below to be read as the answer. */}
                  <div className="datarow" style={{ maxWidth: 'none' }}>
                    <dt>Effective exposure spread</dt>
                    <dd>
                      <strong>—</strong>{' '}
                      <span className="dim">
                        not recorded per capture — measure it live on Developer › TIMING BENCH
                      </span>
                    </dd>
                  </div>
                  <div className="datarow" style={{ maxWidth: 'none' }}>
                    <dt>GPIO trigger skew</dt>
                    <dd className="dim">
                      {info.meta.gpioSkewUs} µs — when the shared trigger edge reached each
                      camera. It does not say when each sensor exposed.
                    </dd>
                  </div>
                  <div className="datarow"><dt>Battery at capture</dt><dd>{info.meta.batteryV.toFixed(2)} V</dd></div>
                  <div className="datarow"><dt>Firmware</dt><dd>P4 {info.meta.p4Firmware} · CAM {info.meta.cameraFirmware.join('/')}</dd></div>
                </dl>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Confirms live outside the inspector's overlay: nested, the wide
          dialog's higher z-index painted over them and swallowed the clicks. */}
      <ConfirmDialog
        open={deleteOpen}
        danger
        title="DELETE CAPTURE"
        confirmLabel="DELETE"
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void doDelete()}
      >
        <p>
          Delete <strong>{summary.id}</strong> from the SD card? All four originals are removed.
          This cannot be undone.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={discardOpen}
        danger
        title="DISCARD ALIGN CHANGES"
        confirmLabel="DISCARD & CLOSE"
        cancelLabel="KEEP EDITING"
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => {
          setDiscardOpen(false);
          leaveAlign();
          onClose();
        }}
      >
        <p>
          Align offsets for <strong>{summary.id}</strong> have not been written to calibration.
          Closing now drops them.
        </p>
      </ConfirmDialog>
    </>
  );
}
