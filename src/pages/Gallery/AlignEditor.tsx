// Manual alignment on a real capture: overlay one camera against the CAM2
// reference, nudge x/y/rotation, write the offsets back to calibration.

import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { NumberField, SegField, SliderField } from '../../components/fields';
import { useDeviceStore } from '../../state/deviceStore';
import { getDevice, refreshCalibration } from '../../app/session';
import type { CalibrationData, CamCalibration, CamId } from '../../protocol/types';
import { CAM_IDS, NEUTRAL_CAL } from '../../protocol/types';
import { formatSigned } from '../../utils/format';

const REF: CamId = 'cam2';
const VIEW_W = 720;
/** Slider range doubles as the clamp for typed values. */
const LIMITS = { x: [-20, 20], y: [-20, 20], rot: [-2, 2] } as const;

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
  frameUrls,
  onClose,
  onDirtyChange,
}: {
  frameUrls: string[];
  onClose: () => void;
  /** Lifted so the inspector can refuse to close on unsaved offsets. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const calibration = useDeviceStore((s) => s.calibration);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [images, setImages] = useState<HTMLImageElement[] | null>(null);
  const [cam, setCam] = useState<CamId>('cam1');
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
      frameUrls.map(
        (url) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('decode failed'));
            img.src = url;
          }),
      ),
    ).then(
      (imgs) => {
        if (!cancelled) setImages(imgs);
      },
      (err) => setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [frameUrls]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !images) return;
    const refImg = images[1]; // CAM2
    const activeImg = images[Number(cam.slice(-1)) - 1];
    const scale = VIEW_W / refImg.naturalWidth;
    const h = Math.round(refImg.naturalHeight * scale);
    canvas.width = VIEW_W;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, VIEW_W, h);
    ctx.drawImage(refImg, 0, 0, VIEW_W, h);

    const o = offsets[cam];
    ctx.save();
    ctx.globalCompositeOperation = blend === 'difference' ? 'difference' : 'source-over';
    if (blend === 'overlay') ctx.globalAlpha = 0.5;
    // Offsets are sensor pixels; scale to view. Rotation around center.
    ctx.translate(VIEW_W / 2 + o.x * scale, h / 2 + o.y * scale);
    ctx.rotate((o.rot * Math.PI) / 180);
    ctx.drawImage(activeImg, -VIEW_W / 2, -h / 2, VIEW_W, h);
    ctx.restore();
  }, [images, cam, blend, offsets]);

  const patchOffset = (key: 'x' | 'y' | 'rot', value: number) => {
    const [min, max] = LIMITS[key];
    const clamped = Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
    // x/y are sensor pixels; rotation keeps two decimals.
    const next = key === 'rot' ? Math.round(clamped * 100) / 100 : Math.round(clamped);
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

  return (
    <div ref={rootRef}>
      <div className="inspector-stage" style={{ minHeight: 0 }}>
        {images ? (
          <canvas
            ref={canvasRef}
            aria-label={`${cam.toUpperCase()} ${blend} view against the CAM2 reference — offset ${formatSigned(o.x)} px X, ${formatSigned(o.y)} px Y, ${formatSigned(o.rot, 2)}° rotation`}
          />
        ) : (
          <span className="faint mono">LOADING…</span>
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
        options={CAM_IDS.filter((c) => c !== REF).map((c) => ({ value: c, label: c.toUpperCase() }))}
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
        value={o.rot}
        min={-2}
        max={2}
        step={0.05}
        format={(v) => `${formatSigned(v, 2)}°`}
        onChange={(v) => patchOffset('rot', v)}
      />
      {/* Sliders are for nudging; typed values are for repeating a known
          measurement and for anyone driving this from the keyboard. */}
      <p className="microlabel" style={{ padding: '6px 0 2px' }}>
        EXACT VALUES — {cam.toUpperCase()}
      </p>
      <NumberField label="X (PX)" value={o.x} min={LIMITS.x[0]} max={LIMITS.x[1]} onChange={(v) => patchOffset('x', v)} />
      <NumberField label="Y (PX)" value={o.y} min={LIMITS.y[0]} max={LIMITS.y[1]} onChange={(v) => patchOffset('y', v)} />
      <NumberField
        label="ROT (DEG)"
        value={o.rot}
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
