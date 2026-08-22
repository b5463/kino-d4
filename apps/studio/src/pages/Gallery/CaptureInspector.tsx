import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { getDevice } from '../../app/session';
import { useDeviceStore, recipeName, supportsRollUpload } from '../../state/deviceStore';
import { useModal } from '../../hooks/useModal';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import type { InspectorSummary } from '../../device/localImport';
import { mp4Supported } from '../../utils/mp4';
import type { RollView } from '../../roll/rollTypes';
import { AlignEditor } from './AlignEditor';
import { CaptureMeta, ImportedFileMeta } from './CaptureMeta';
import { MatchPanel } from './MatchPanel';
import { PushToRoll } from './PushToRoll';
import { DEVICE_SOURCE, useCaptureFrames } from './useCaptureFrames';
import type { CaptureSource } from './useCaptureFrames';
import {
  SEQ_BOUNCE,
  alignedSources,
  buildContactSheet,
  buildGifBytes,
  buildMp4Bytes,
  buildZipBytes,
  saveBlob,
} from './captureExports';
import { captureOffsets, hasAnyOffset } from '../../utils/wiggleRender';

export function CaptureInspector({
  summary,
  roll,
  source = DEVICE_SOURCE,
  onClose,
  onChanged,
}: {
  summary: InspectorSummary;
  /** ROLL_STATUS as the gallery last read it; `null` means no Roll to push to. */
  roll: RollView | null;
  /** Where the frames come from. Defaults to the attached camera. */
  source?: CaptureSource;
  onClose: () => void;
  onChanged: (change: 'favorite' | 'deleted') => void;
}) {
  const deviceState = useDeviceStore();
  const wiggleCfg = deviceState.config?.wiggle;
  const calibration = deviceState.calibration;
  const reducedMotion = useReducedMotion();
  // An imported folder is not on the card: nothing here may favourite it,
  // delete it, push it to a Roll or write calibration off it.
  const isLocal = source.kind === 'local';
  const { info, frames, progress, error: loadError } = useCaptureFrames(source, summary.id);
  const [actionError, setActionError] = useState<string | null>(null);
  const error = loadError ?? actionError;
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
  // Offsets recorded on the capture win over live device calibration — see
  // `captureOffsets`. `info` is null until MEDIA_INFO answers, so the first
  // render uses live calibration and settles once the meta arrives.
  const camOffsets = captureOffsets(info, calibration);
  const offsetsAvailable = hasAnyOffset(camOffsets);
  const [alignedCrop, setAlignedCrop] = useState(true);
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

  useEffect(() => {
    if (summary.kind !== 'wiggle') return;
    void mp4Supported(800, 600).then(setMp4Ok);
  }, [summary.kind]);

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

  const runExport = async (tag: string, run: () => Promise<void>) => {
    setExporting(tag);
    try {
      await run();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(null);
    }
  };

  const sources = () => alignedSources(frames ?? [], alignedCrop && offsetsAvailable ? camOffsets : null);

  const exportMp4 = () =>
    runExport('mp4', async () => {
      const bytes = await buildMp4Bytes(await sources(), fps);
      saveBlob(`${summary.id}.mp4`, new Blob([bytes as BlobPart], { type: 'video/mp4' }));
    });

  const exportGif = () =>
    runExport('gif', async () => {
      const gif = buildGifBytes(await sources(), fps);
      saveBlob(`${summary.id}.gif`, new Blob([gif as BlobPart], { type: 'image/gif' }));
    });

  const exportZip = () => {
    if (!frames || !info) return;
    void runExport('zip', async () => {
      const zip = buildZipBytes(frames, info);
      saveBlob(`${summary.id}.zip`, new Blob([zip as BlobPart], { type: 'application/zip' }));
    });
  };

  const exportContactSheet = () =>
    runExport('sheet', async () => {
      if (!frames) return;
      // An imported folder with no META.JSON has no capture time to print.
      const when = summary.ts === null ? '' : `${new Date(summary.ts).toLocaleString()} · `;
      const blob = await buildContactSheet(frames, `${summary.id} · ${when}KINO`);
      if (blob) saveBlob(`${summary.id}_sheet.jpg`, blob);
    });

  /** UPLOAD_ENQUEUE. Failure surfaces on the button, not in this dialog's
      error line — the capture itself is fine either way. */
  const pushToRoll = async (captureId: string) => {
    const dev = getDevice();
    if (!dev) throw new Error('KINO is not connected.');
    await dev.uploadEnqueue(captureId);
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
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const lookName = (id: string | undefined) => (id ? recipeName(deviceState, id).toUpperCase() : '');

  const kindLabel = summary.kind === 'wiggle' ? 'WIGGLEGRAM' : 'QUAD SET';

  // Where the offsets in use came from. Zeros are never shown as a measurement.
  const offsetOrigin = info?.meta.calibration
    ? 'OFFSETS FROM CAPTURE META'
    : offsetsAvailable
      ? 'OFFSETS FROM DEVICE CALIBRATION'
      : 'OFFSETS UNMEASURED';

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
                : `${summary.id} — ${kindLabel}${isLocal ? ' — IMPORTED' : ''}`}
            </span>
            {alignMode ? (
              // One way out in align mode: the editor's own CANCEL / SAVE.
              <span className="microlabel" style={{ marginLeft: 'auto' }}>
                CANCEL OR SAVE BELOW
              </span>
            ) : (
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                {isLocal ? null : (
                  <Button size="sm" onClick={() => void toggleFavorite()}>
                    {favorite ? '♥ FAVORITE' : '♡ FAVORITE'}
                  </Button>
                )}
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
                : `${kindLabel} · ${frames ? `${frames.length} FRAMES` : 'LOADING FRAMES'}${
                    isLocal ? ` · ${offsetOrigin}` : ''
                  } · ESC CLOSES`}
            </p>

            {source.kind === 'local' && source.capture.warnings.length > 0 ? (
              <p className="notice">
                <span className="mono">{source.capture.warnings.join(' · ')}</span>
              </p>
            ) : null}

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
                        {isLocal ? null : (
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
                        )}
                      </>
                    ) : null}
                  </span>
                  {/* Sending the capture somewhere is not an export either —
                      it leaves the camera on the camera's schedule. Renders
                      nothing unless there is an active Roll to push to. */}
                  {isLocal ? null : (
                    <PushToRoll
                      captureId={summary.id}
                      rollUpload={supportsRollUpload(deviceState)}
                      roll={roll}
                      onPush={pushToRoll}
                    />
                  )}
                  {/* DELETE is not an export. Own trailing group, ruled off. */}
                  {isLocal ? null : (
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
                  )}
                </div>
              </>
            )}

            {frames && !alignMode ? (
              <MatchPanel frameUrls={frames.map((f) => f.url)} isWiggle={summary.kind === 'wiggle'} />
            ) : null}

            {info ? <CaptureMeta info={info} kind={summary.kind} lookName={lookName} /> : null}

            {isLocal && !info && frames ? <ImportedFileMeta id={summary.id} frames={frames} /> : null}
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
