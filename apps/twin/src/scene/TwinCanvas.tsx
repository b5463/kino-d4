import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { screenshotPng } from '../exports/exports';
import { useSceneStore } from '../state/sceneStore';
import { bboxFromBodySizeMm, viewPose, type ViewPoseName } from './viewPoses';

export interface TwinCanvasHandle {
  /** Imperatively drive the camera/controls to one viewport-bar pose (§3, Task 13). */
  applyView(name: ViewPoseName): void;
  screenshot(): Promise<Blob>;
}

interface TwinCanvasProps {
  children?: ReactNode;
}

interface CameraRigProps {
  /** Hands the rig's `applyView` closure up to the imperative handle, once mounted. */
  registerApplyView: (fn: (name: ViewPoseName) => void) => void;
  registerScreenshot: (fn: () => Promise<Blob>) => void;
}

/**
 * Lives inside the `<Canvas>` so it can reach the live R3F camera and the
 * drei `OrbitControls` instance — both are unavailable outside the canvas.
 * `applyView` reads the profile's body size for the standard-view bbox
 * (§25: never hard-code an assembly dimension the profile carries), captures
 * the controls' current position/target as `fit`'s "current direction", then
 * imperatively sets the camera position and orbit target from `viewPose`.
 */
function CameraRig({ registerApplyView, registerScreenshot }: CameraRigProps) {
  const { camera, gl } = useThree();
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const measureMode = useSceneStore((state) => state.measureMode);

  useEffect(() => {
    registerApplyView((name) => {
      const { profile, pitchMm } = useSceneStore.getState();
      const controls = controlsRef.current;
      const current = controls
        ? {
            position: camera.position.toArray() as [number, number, number],
            target: controls.target.toArray() as [number, number, number],
          }
        : undefined;

      const pose = viewPose(name, bboxFromBodySizeMm(profile.body.sizeMm), pitchMm, current);
      camera.position.set(...pose.position);
      camera.lookAt(...pose.target);
      if (controls) {
        controls.target.set(...pose.target);
        controls.update();
      }
    });
  }, [camera, registerApplyView]);

  useEffect(() => {
    registerScreenshot(() => screenshotPng(gl));
  }, [gl, registerScreenshot]);

  return <OrbitControls ref={controlsRef} makeDefault enabled={!measureMode} />;
}

/**
 * The R3F canvas root. Camera start pose is a fixed scene-wide constant
 * (§3); `gl.preserveDrawingBuffer` keeps the backbuffer around for Task 21's
 * screenshot export. Clicking empty space (no instance hit) clears
 * selection — the natural complement to Assembly's per-instance onClick.
 * Orbit/pan/zoom come from `<OrbitControls makeDefault />` (Task 13); the
 * viewport-bar's standard-view buttons drive the camera through the
 * `applyView` imperative handle instead, since they live outside the canvas.
 */
export const TwinCanvas = forwardRef<TwinCanvasHandle, TwinCanvasProps>(function TwinCanvas({ children }, ref) {
  const applyViewRef = useRef<(name: ViewPoseName) => void>(() => {});
  const screenshotRef = useRef<() => Promise<Blob>>(() => Promise.reject(new Error('3D canvas is not ready')));

  useImperativeHandle(ref, () => ({
    applyView(name) {
      applyViewRef.current(name);
    },
    screenshot() {
      return screenshotRef.current();
    },
  }));

  return (
    <Canvas
      camera={{ position: [180, 120, 220], near: 1, far: 5000 }}
      gl={{ preserveDrawingBuffer: true }}
      onPointerMissed={() => useSceneStore.getState().select(null)}
    >
      <CameraRig
        registerApplyView={(fn) => {
          applyViewRef.current = fn;
        }}
        registerScreenshot={(fn) => {
          screenshotRef.current = fn;
        }}
      />
      {children}
    </Canvas>
  );
});
