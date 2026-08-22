// The virtual sensors (issue #72): render the live 3D scene from each
// camera's optical center and hand real JPEG bytes to the device — previews,
// capture frames, thumbnails. Registered as the MockKinoDevice frame source
// whenever the simulator runs; if anything fails the device falls back to
// its synthetic art, so the wire never goes silent.
//
// Every byte this produces is SIMULATED: a render through a stated 69–75°
// lens scenario, never a measurement of the physical camera.
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { MockFrameRequest } from '@kino/test-fixtures';
import { useSceneStore } from '../state/sceneStore';
import { useStageStore } from '../state/stageStore';
import { useSimStore, getTwinRuntime } from '../state/simStore';
import { sensorPoses, verticalFovDeg, SENSOR_LAYER } from './sensor';
import { previewCanvas, markPreviewUpdated } from './displayPreview';
import { viewfinderCam } from '../display/deviceUi';

const PREVIEW_INTERVAL_MS = 300; // rear-display refresh; heavier than the UI redraw, lighter than the frame loop
const PREVIEW_W = 320;
const PREVIEW_H = 240;

interface Rig {
  renderJpeg(req: MockFrameRequest): Promise<Uint8Array | null>;
  renderPreviewToDisplay(): void;
  dispose(): void;
}

function createRig(gl: THREE.WebGLRenderer, scene: THREE.Scene): Rig {
  const camera = new THREE.PerspectiveCamera(50, 4 / 3, 5, 30000);
  camera.layers.set(SENSOR_LAYER);
  const targets = new Map<string, THREE.WebGLRenderTarget>();
  const work = document.createElement('canvas');
  const workCtx = work.getContext('2d');

  function target(width: number, height: number): THREE.WebGLRenderTarget {
    const key = `${width}x${height}`;
    let t = targets.get(key);
    if (!t) {
      t = new THREE.WebGLRenderTarget(width, height);
      t.texture.colorSpace = THREE.SRGBColorSpace;
      targets.set(key, t);
    }
    return t;
  }

  /** Renders one camera's view into the work canvas. False when the pose is
   * unavailable (profile without four camera nodes) or 2D is unsupported. */
  function renderInto(cam: MockFrameRequest['cam'], width: number, height: number): boolean {
    if (!workCtx) return false;
    const { profile, pitchMm } = useSceneStore.getState();
    const { lensFovDeg } = useStageStore.getState();
    const pose = sensorPoses(profile, pitchMm).find((p) => p.cam === cam);
    if (!pose) return false;

    camera.aspect = width / height;
    camera.fov = verticalFovDeg(lensFovDeg, camera.aspect);
    camera.updateProjectionMatrix();
    camera.position.set(...pose.positionMm);
    camera.lookAt(pose.positionMm[0], pose.positionMm[1], pose.positionMm[2] + 1000);

    const rt = target(width, height);
    const previous = gl.getRenderTarget();
    gl.setRenderTarget(rt);
    gl.render(scene, camera);
    const pixels = new Uint8Array(width * height * 4);
    gl.readRenderTargetPixels(rt, 0, 0, width, height, pixels);
    gl.setRenderTarget(previous);

    work.width = width;
    work.height = height;
    const image = workCtx.createImageData(width, height);
    // GL reads bottom-up; canvases are top-down.
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      image.data.set(pixels.subarray((height - 1 - y) * rowBytes, (height - y) * rowBytes), y * rowBytes);
    }
    workCtx.putImageData(image, 0, 0);
    return true;
  }

  function toJpeg(quality: number): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      work.toBlob(
        (blob) => {
          if (!blob) return resolve(null);
          void blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
        },
        'image/jpeg',
        quality,
      );
    });
  }

  return {
    async renderJpeg(req) {
      if (!renderInto(req.cam, req.width, req.height)) return null;
      const quality = req.kind === 'capture' ? 0.8 : req.kind === 'thumb' ? 0.6 : 0.55;
      let bytes = await toJpeg(quality);
      // A preview must fit one KDP frame; re-encode harder if it doesn't.
      if (req.kind === 'preview' && bytes && bytes.length > 15000) bytes = await toJpeg(0.35);
      return bytes;
    },
    renderPreviewToDisplay() {
      const snapshot = useSimStore.getState().snapshot;
      const cam = viewfinderCam({ snapshot });
      if (!renderInto(cam, PREVIEW_W, PREVIEW_H)) return;
      const preview = previewCanvas(PREVIEW_W, PREVIEW_H);
      preview.getContext('2d')?.drawImage(work, 0, 0);
      markPreviewUpdated();
    },
    dispose() {
      for (const t of targets.values()) t.dispose();
      targets.clear();
    },
  };
}

export function SensorRig() {
  const { gl, scene } = useThree();
  const running = useSimStore((s) => s.running);
  const rig = useMemo(() => createRig(gl, scene), [gl, scene]);

  useEffect(() => () => rig.dispose(), [rig]);

  useEffect(() => {
    if (!running) return;
    // The runtime is recreated on every POWER ON — re-register each time.
    const device = getTwinRuntime().sim.device;
    device.setFrameSource((req) => rig.renderJpeg(req));
    const timer = setInterval(() => {
      if (useSimStore.getState().running) rig.renderPreviewToDisplay();
    }, PREVIEW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running, rig]);

  return null;
}
