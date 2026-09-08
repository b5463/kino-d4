// Manual alignment on a real capture: overlay one camera against the CAM2
// reference, nudge x/y/rotation, write the offsets back to calibration.

import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { NumberField, SegField, SliderField } from '../../components/fields';
import { useDeviceStore } from '../../state/deviceStore';
import { getDevice, refreshCalibration } from '../../app/session';
import type { CalibrationData, CamCalibration, CamId } from '@kino/kdp';
import { CAM_IDS, NEUTRAL_CAL } from '@kino/kdp';
import { formatSigned } from '../../utils/format';
import type { CaptureFrame } from './useCaptureFrames';

const REF: CamId = 'cam2';
/** Stylesheet caps a canvas in an inspector stage at 420px tall. */
const MAX_VIEW_H = 420;
/** Backing-store width ceiling in device pixels — bounds cost per repaint. */
const MAX_BACKING_W = 1600;
/** Slider range doubles as the clamp for typed values. */
const LIMITS = { x: [-20, 20], y: [-20, 20], rot: [-2, 2] } as const;
/**
 * One precision for one angle. Calibration stores two decimals, the sliders
 * step in hundredths, so every readout of a rotation shows two decimals and
 * every readout that can carry a sign carries one. The typed boxes are number
 * inputs and cannot print a leading `+`, so they at least show the same
 * rounding instead of a third figure (`0.368` under a slider reading `+0.37`).
 */
const ROT_DECIMALS = 2;

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

type Offsets = Record<CamId, Pick<CamCalibration, 'x' | 'y' | 'rot'>>;

function readOffsets(calibration: CalibrationData | null): Offsets {
  const base = {} as Offsets;
  for (const id of CAM_IDS) {
    const c = calibration?.cams[id] ?? NEUTRAL_CAL;
    base[id] = { x: c.x, y: c.y, rot: c.rot };
  }
  return base;
}

export function AlignEditor({
  frames,
  onClose,
  onDirtyChange,
}: {
  /** The frames on the card. Each carries the camera that took it. */
  frames: CaptureFrame[];
  onClose: () => void;
  /** Lifted so the inspector can refuse to close on unsaved offsets. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const calibration = useDeviceStore((s) => s.calibration);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [stageW, setStageW] = useState(0);
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
  // Keyed by the camera each frame's own file name states — never by its
  // position in the folder. A capture stores only the cameras that answered
  // (contract D23), so on a card with C1/C3/C4 the old `images[1]` reference
  // was CAM3's frame and the editor wrote CAM1's nudges against it.
  const [images, setImages] = useState<Partial<Record<CamId, HTMLImageElement>> | null>(null);
  // The cameras this capture can actually align, in CAM order.
  const present = CAM_IDS.filter((id) => frames.some((f) => f.slot === id));
  const alignable = present.filter((id) => id !== REF);
  const [cam, setCam] = useState<CamId>(() => alignable[0] ?? 'cam1');
  const [blend, setBlend] = useState<'overlay' | 'difference'>('difference');
  const [offsets, setOffsets] = useState<Offsets>(() => readOffsets(calibration));
  // What was on the device when the editor opened — the dirty baseline.
  const baseline = useRef(offsets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = CAM_IDS.some((id) => {
    const a = baseline.current[id];
    const b = offsets[id];
    return a.x !== b.x || a.y !== b.y || a.rot !== b.rot;
  });

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Entering align mode unmounts the head's CLOSE button, which is where the
  // focus was. Take it somewhere deliberate instead of dropping it on <body>.
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('button, input')?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      frames.map(
        (frame) =>
          new Promise<{ slot: CamId | null; img: HTMLImageElement }>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve({ slot: frame.slot, img });
            img.onerror = () => reject(new Error('decode failed'));
            img.src = frame.url;
          }),
      ),
    ).then(
      (loaded) => {
        if (cancelled) return;
        const bySlot: Partial<Record<CamId, HTMLImageElement>> = {};
        // A frame whose name states no slot cannot be attributed to a camera,
        // so it is not offered for alignment at all.
        for (const { slot, img } of loaded) if (slot !== null) bySlot[slot] = img;
        setImages(bySlot);
      },
      (err) => setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [frames]);

  // Track the stage box and the display's pixel ratio: the backing store is
  // sized from both, never from a fixed number.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    setStageW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setStageW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [dpr]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !images) return;
    const refImg = images[REF];
    const activeImg = images[cam];
    if (!refImg || !activeImg) return;
    const aspect = refImg.naturalHeight / refImg.naturalWidth;

    // Drawn size first: as wide as the stage allows, capped by the same 420px
    // the stylesheet caps stage canvases at, and never wider than the source.
    let cssW = Math.max(160, stageW || refImg.naturalWidth);
    if (cssW * aspect > MAX_VIEW_H) cssW = Math.round(MAX_VIEW_H / aspect);
    cssW = Math.min(cssW, refImg.naturalWidth);
    const cssH = Math.round(cssW * aspect);

    // Backing store = CSS size × device pixel ratio, capped. It used to be a
    // fixed 720 wide, which oversampled a 560px box on a 1x display and
    // undersampled it on a 2x one.
    const w = Math.min(MAX_BACKING_W, Math.round(cssW * dpr));
    const h = Math.round(w * aspect);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    const scale = w / refImg.naturalWidth;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(refImg, 0, 0, w, h);

    const o = offsets[cam];
    ctx.save();
    ctx.globalCompositeOperation = blend === 'difference' ? 'difference' : 'source-over';
    if (blend === 'overlay') ctx.globalAlpha = 0.5;
    // Offsets are sensor pixels; scale to view. Rotation around center.
    ctx.translate(w / 2 + o.x * scale, h / 2 + o.y * scale);
    ctx.rotate((o.rot * Math.PI) / 180);
    ctx.drawImage(activeImg, -w / 2, -h / 2, w, h);
    ctx.restore();
  }, [images, cam, blend, offsets, stageW, dpr]);

  const patchOffset = (key: 'x' | 'y' | 'rot', value: number) => {
    const [min, max] = LIMITS[key];
    const clamped = Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
    // x/y are sensor pixels; rotation keeps the one precision this editor and
    // the calibration screen both display.
    const next = key === 'rot' ? round(clamped, ROT_DECIMALS) : Math.round(clamped);
    setOffsets((o) => ({ ...o, [cam]: { ...o[cam], [key]: next } }));
  };

  const save = async () => {
    const dev = getDevice();
    if (!dev || !calibration) return;
    setBusy(true);
    setError(null);
    try {
      const merged = {} as Record<CamId, CamCalibration>;
      for (const id of CAM_IDS) {
        merged[id] = { ...(calibration.cams[id] ?? NEUTRAL_CAL), ...offsets[id] };
      }
      await dev.applyCalibration(merged);
      await refreshCalibration();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const o = offsets[cam];
  // Every readout of this angle — aria label, slider, typed box — reads the
  // same rounded number.
  const rot = round(o.rot, ROT_DECIMALS);

  return (
    <div ref={rootRef}>
      <div className="inspector-stage" ref={stageRef} style={{ minHeight: 0 }}>
        {images && (!images[REF] || alignable.length === 0) ? (
          // Nothing to align against, or nothing to align. Say which.
          <span className="mono" style={{ color: 'var(--text-on-dark)', textAlign: 'center', padding: '0 10px' }}>
            {images[REF]
              ? 'THIS CAPTURE HOLDS ONLY THE CAM2 REFERENCE — NOTHING TO ALIGN AGAINST IT.'
              : 'NO CAM2 FRAME IN THIS CAPTURE — ALIGNMENT IS MEASURED AGAINST CAM2.'}
          </span>
        ) : images ? (
          <canvas
            ref={canvasRef}
            aria-label={`${cam.toUpperCase()} ${blend} view against the CAM2 reference — offset ${formatSigned(o.x)} px X, ${formatSigned(o.y)} px Y, ${formatSigned(rot, ROT_DECIMALS)}° rotation`}
          />
        ) : (
          // `--text-faint` measures 2.48:1 on the dark well. The light end of
          // the ramp is 7.8:1 and is what a dark well is supposed to use.
          <span className="mono" style={{ color: 'var(--text-on-dark)' }}>
            LOADING FRAMES…
          </span>
        )}
      </div>
      <p className="microlabel" style={{ padding: '6px 0 2px' }}>
        {blend === 'difference'
          ? 'DIFFERENCE VIEW — ALIGNED AREAS GO BLACK. SUBJECT PARALLAX STAYS; ALIGN THE BACKGROUND.'
          : 'OVERLAY VIEW — 50% MIX AGAINST CAM2.'}
      </p>
      <SegField
        label="CAMERA"
        value={cam}
        options={alignable.map((c) => ({ value: c, label: c.toUpperCase() }))}
        onChange={(v) => setCam(v as CamId)}
      />
      <SegField
        label="VIEW"
        value={blend}
        options={[
          { value: 'difference', label: 'DIFFERENCE' },
          { value: 'overlay', label: 'OVERLAY' },
        ]}
        onChange={(v) => setBlend(v as 'overlay' | 'difference')}
      />
      <SliderField
        label="X OFFSET"
        value={o.x}
        min={-20}
        max={20}
        format={(v) => `${formatSigned(v)} px`}
        onChange={(v) => patchOffset('x', v)}
      />
      <SliderField
        label="Y OFFSET"
        value={o.y}
        min={-20}
        max={20}
        format={(v) => `${formatSigned(v)} px`}
        onChange={(v) => patchOffset('y', v)}
      />
      <SliderField
        label="ROTATION"
        value={rot}
        min={-2}
        max={2}
        step={0.05}
        format={(v) => `${formatSigned(v, ROT_DECIMALS)}°`}
        onChange={(v) => patchOffset('rot', v)}
      />
      {/* Sliders are for nudging; typed values are for repeating a known
          measurement and for anyone driving this from the keyboard. Same
          numbers as the sliders above, not a more precise set — the label
          used to say EXACT VALUES over a third rounding of the same angle. */}
      <p className="microlabel" style={{ padding: '6px 0 2px' }}>
        TYPED ENTRY — {cam.toUpperCase()}
      </p>
      <NumberField
        label="X"
        unit="px"
        value={o.x}
        min={LIMITS.x[0]}
        max={LIMITS.x[1]}
        onChange={(v) => patchOffset('x', v)}
      />
      <NumberField
        label="Y"
        unit="px"
        value={o.y}
        min={LIMITS.y[0]}
        max={LIMITS.y[1]}
        onChange={(v) => patchOffset('y', v)}
      />
      <NumberField
        label="ROT"
        unit="°"
        value={rot}
        min={LIMITS.rot[0]}
        max={LIMITS.rot[1]}
        step={0.05}
        onChange={(v) => patchOffset('rot', v)}
      />
      {error ? <p className="notice notice--err" style={{ marginTop: 8 }}>{error}</p> : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', paddingTop: 8 }}>
        {dirty ? (
          <span className="microlabel" style={{ marginRight: 'auto' }}>
            UNSAVED OFFSETS
          </span>
        ) : null}
        <Button variant="ghost" onClick={onClose}>
          {dirty ? 'CANCEL — DISCARD' : 'CANCEL'}
        </Button>
        <Button variant="primary" busy={busy} onClick={() => void save()}>
          SAVE TO CALIBRATION
        </Button>
      </div>
    </div>
  );
}
