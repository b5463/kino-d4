import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { resolveDimensions } from '@kino/hardware-profiles';
import { fallbackBoxMm } from '@kino/three-assets';
import { useSceneStore } from '../state/sceneStore';
import { useSimStore } from '../state/simStore';
import { DISPLAY_H, DISPLAY_W, drawDeviceUi } from '../display/deviceUi';
import type { DeviceUiState } from '../display/deviceUi';
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

  useEffect(() => {
    const ctx = (texture.image as HTMLCanvasElement).getContext('2d');
    if (!ctx) return;
    const redraw = () => {
      drawDeviceUi(ctx, readDeviceUiState());
      texture.needsUpdate = true;
    };
    redraw();
    const timer = setInterval(redraw, REDRAW_MS);
    return () => {
      clearInterval(timer);
      texture.dispose();
    };
  }, [texture]);

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

  if (!position || !visible || viewMode === 'enclosure') return null;
  // The rear acrylic is a transparent pane between the viewer and this
  // screen; drawn after the screen it composites its milky tint on top.
  // Opaque geometry always renders before the transparent pass, so the fix
  // is to put the screen INTO the transparent queue (transparent + opacity 1)
  // with a late renderOrder — it then draws after the acrylic and stays
  // crisp. Depth testing still hides it from the front, where the opaque
  // module body wrote depth first.
  return (
    <mesh position={position} rotation={[0, Math.PI, 0]} raycast={() => {}} renderOrder={10}>
      <planeGeometry args={[ACTIVE_W_MM, ACTIVE_H_MM]} />
      <meshBasicMaterial map={texture} toneMapped={false} transparent opacity={1} />
    </mesh>
  );
}
