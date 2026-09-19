import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import { resolveDimensions } from '@kino/hardware-profiles';
import { fallbackBoxMm } from '@kino/three-assets';
import { useSceneStore } from '../state/sceneStore';
import { useSimStore } from '../state/simStore';
import { DISPLAY_H, DISPLAY_W, drawDeviceUi } from '../display/deviceUi';
import type { DeviceUiState } from '../display/deviceUi';
import { firmwareUi } from '../display/firmwareUi';
import { instanceTransforms } from './transforms';
import { getDisplayPreview } from './displayPreview';
import { useRollBridge } from '../roll/bridge';
import { rollQrCanvas } from '../roll/qr';

/** Active-area size of the Guition panel, matching the builder's glass inset. */
const ACTIVE_W_MM = 93.6;
const ACTIVE_H_MM = 56.16;

/** Texture refresh period. The sim mutates far more often during a capture,
 * but the panel is informational — ~7 Hz keeps it live without re-uploading
 * an 800×480 texture every frame. */
const REDRAW_MS = 150;

export function readDeviceUiState(): DeviceUiState {
  const s = useSimStore.getState();
  const bridge = useRollBridge.getState();
  return {
    running: s.running,
    bootStage: s.bootStage,
    camStage: s.camStage,
    fw: s.fw,
    snapshot: s.snapshot,
    studioConnected: s.studioConnected,
    preview: getDisplayPreview(),
    rollBridge: bridge.roll
      ? {
          slug: bridge.roll.slug,
          qr: rollQrCanvas(bridge.roll.guestUrl),
          queued: bridge.queued,
          failed: bridge.failed,
          uploaded: bridge.uploaded,
        }
      : null,
  };
}

/**
 * The device UI rendered onto the display's glass. Everything shown comes
 * from the simulator state — the same state Studio sees over KDP — and the
 * preview field is labelled SIMULATED because no real sensor is behind it.
 */
export function DisplayScreen() {
  const profile = useSceneStore((s) => s.profile);
  const pitchMm = useSceneStore((s) => s.pitchMm);
  const explode = useSceneStore((s) => s.explode);
  const viewMode = useSceneStore((s) => s.viewMode);
  const visible = useSceneStore((s) => s.visibility['display'] ?? true);

  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = DISPLAY_W;
    canvas.height = DISPLAY_H;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  useEffect(() => () => texture.dispose(), [texture]);

  const position = useMemo<[number, number, number] | null>(() => {
    const transform = instanceTransforms(profile, pitchMm, explode).get('display');
    if (!transform) return null;
    const component = profile.components.find((c) => c.id === 'main-display');
    if (!component) return null;
    const depth = fallbackBoxMm(resolveDimensions(component).sizeMm)[2];
    // Just proud of the glass outer face (glass: 0.6 mm on the -Z side).
    const [x, y, z] = transform.positionMm;
    return [x, y, z - depth / 2 - 0.75];
  }, [explode, pitchMm, profile]);

  // Exactly the condition the early return below uses: nothing renders this
  // texture in ENCLOSURE view, with the display hidden, or without a resolved
  // position, so nothing should be redrawing and re-uploading it 7 times a
  // second either. Same for a backgrounded tab — the panel is not on screen,
  // and the browser throttles the timer unevenly rather than stopping it.
  const shown = position !== null && visible && viewMode !== 'enclosure';

  useEffect(() => {
    if (!shown) return;
    const ctx = (texture.image as HTMLCanvasElement).getContext('2d');
    if (!ctx) return;
    // Once SIM READY, the glass shows the firmware's own screens
    // (display/firmwareUi.ts); until then, and without the module, the sketch.
    const fw = firmwareUi();
    const redraw = () => {
      if (fw.available()) ctx.drawImage(fw.screen, 0, 0);
      else drawDeviceUi(ctx, readDeviceUiState());
      texture.needsUpdate = true;
    };

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer !== null) return;
      redraw(); // paint the current state before the first interval elapses
      timer = setInterval(redraw, REDRAW_MS);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    // A presented frame - a dissolve, a pressed button - goes up at once
    // rather than on the next poll, but only while the panel is on screen.
    const offFrame = fw.onFrame(() => {
      if (timer !== null) redraw();
    });

    const onVisibilityChange = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      offFrame();
      stop();
    };
  }, [texture, shown]);

  if (!position || !visible || viewMode === 'enclosure') return null;

  // The glass is the touch panel. A hit's UV is the point on the screen:
  // u runs left to right as the texture does, v runs bottom to top, so the
  // logical row is (1 - v). Pointer events stop here so a tap on the screen is
  // a tap on the screen, not a pick of the display part behind it; capture
  // keeps a slide that leaves the glass ending in a lift, as ui.c expects.
  const fw = firmwareUi();
  const toScreen = (e: ThreeEvent<PointerEvent>) =>
    e.uv ? { x: Math.round(e.uv.x * DISPLAY_W), y: Math.round((1 - e.uv.y) * DISPLAY_H) } : null;
  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!fw.available()) return;
    const p = toScreen(e);
    if (!p) return;
    e.stopPropagation();
    (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
    fw.setTouch(true, p.x, p.y);
  };
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!fw.available() || e.buttons === 0) return;
    const p = toScreen(e);
    if (p) fw.setTouch(true, p.x, p.y);
  };
  const onPointerUp = (e: ThreeEvent<PointerEvent>) => {
    if (!fw.available()) return;
    const p = toScreen(e);
    (e.target as Element | null)?.releasePointerCapture?.(e.pointerId);
    e.stopPropagation();
    fw.setTouch(false, p?.x ?? 0, p?.y ?? 0);
  };

  // The rear acrylic is a transparent pane between the viewer and this
  // screen; drawn after the screen it composites its milky tint on top.
  // Opaque geometry always renders before the transparent pass, so the fix
  // is to put the screen INTO the transparent queue (transparent + opacity 1)
  // with a late renderOrder — it then draws after the acrylic and stays
  // crisp. Depth testing still hides it from the front, where the opaque
  // module body wrote depth first.
  return (
    <mesh
      position={position}
      rotation={[0, Math.PI, 0]}
      renderOrder={10}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerOver={(e) => { if (fw.available()) e.stopPropagation(); }}
      onPointerOut={(e) => { if (fw.available()) e.stopPropagation(); }}
      onClick={(e) => { if (fw.available()) e.stopPropagation(); }}
    >
      <planeGeometry args={[ACTIVE_W_MM, ACTIVE_H_MM]} />
      <meshBasicMaterial map={texture} toneMapped={false} transparent opacity={1} />
    </mesh>
  );
}
