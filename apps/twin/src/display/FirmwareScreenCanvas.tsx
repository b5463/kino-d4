import { useEffect, useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { DISPLAY_H, DISPLAY_W, drawDeviceUi } from './deviceUi';
import { firmwareUi } from './firmwareUi';
import { readDeviceUiState } from '../scene/DisplayScreen';

const REDRAW_MS = 150;

/**
 * The on-device display as a flat canvas, and its touch panel.
 *
 * One component for the SCREEN tab and the SCREEN VIEW so the two cannot
 * drift: the picture is the firmware's own frame once ui.c is up (the sketch
 * before that), and a pointer on the canvas is a finger on the glass — press,
 * slide off, lift, exactly as the GT911 path takes it. Sizing is the caller's.
 */
export function FirmwareScreenCanvas({
  className,
  style,
  ariaLabel,
}: {
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fw = firmwareUi();

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const redraw = () => {
      if (fw.available()) ctx.drawImage(fw.screen, 0, 0);
      else drawDeviceUi(ctx, readDeviceUiState());
    };
    redraw();
    const timer = setInterval(redraw, REDRAW_MS);
    const off = fw.onFrame(redraw);
    return () => {
      clearInterval(timer);
      off();
    };
  }, [fw]);

  function point(e: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * DISPLAY_W),
      y: Math.round(((e.clientY - r.top) / r.height) * DISPLAY_H),
    };
  }
  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!fw.available()) return;
    try {
      // A slide that leaves the canvas still ends in a lift, as ui.c expects.
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic or already-released pointer: the press still counts */
    }
    const p = point(e);
    fw.setTouch(true, p.x, p.y);
  }
  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!fw.available() || e.buttons === 0) return;
    const p = point(e);
    fw.setTouch(true, p.x, p.y);
  }
  function onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>) {
    const p = point(e);
    fw.setTouch(false, p.x, p.y);
  }

  return (
    <canvas
      ref={canvasRef}
      width={DISPLAY_W}
      height={DISPLAY_H}
      className={className}
      style={{ touchAction: 'none', cursor: fw.available() ? 'pointer' : 'default', ...style }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      aria-label={ariaLabel ?? (fw.available() ? 'Touch panel' : 'Device display')}
    />
  );
}
