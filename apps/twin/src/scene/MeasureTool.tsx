import { Html } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useSceneStore } from '../state/sceneStore';
import type { MeasurePoint } from '../state/sceneStore';

export interface MeasurementDelta {
  distanceMm: number;
  axisMm: MeasurePoint;
}

export function measurementDelta(from: MeasurePoint, to: MeasurePoint): MeasurementDelta {
  const axisMm: MeasurePoint = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  return { distanceMm: Math.hypot(...axisMm), axisMm };
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

function hasOverlayAncestor(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.userData.measureOverlay === true) return true;
    current = current.parent;
  }
  return false;
}

function hasSelectableAncestor(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.userData.selectable === true) return true;
    current = current.parent;
  }
  return false;
}

/** Raycast-driven two-point measurement overlay for the assembled viewport. */
export function MeasureTool() {
  const measureMode = useSceneStore((state) => state.measureMode);
  const points = useSceneStore((state) => state.measurePoints);
  const { camera, gl, scene } = useThree();

  useEffect(() => {
    if (!measureMode) return;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    function capturePoint(event: PointerEvent) {
      if (event.button !== 0) return;
      const bounds = gl.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster
        .intersectObjects(scene.children, true)
        .find(
          (intersection) =>
            intersection.object.visible &&
            hasSelectableAncestor(intersection.object) &&
            !hasOverlayAncestor(intersection.object),
        );
      if (!hit) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      useSceneStore.getState().addMeasurePoint([hit.point.x, hit.point.y, hit.point.z]);
    }

    gl.domElement.addEventListener('pointerdown', capturePoint, true);
    return () => gl.domElement.removeEventListener('pointerdown', capturePoint, true);
  }, [camera, gl, measureMode, scene]);

  const lineGeometry = useMemo(() => {
    if (points.length !== 2) return null;
    return new THREE.BufferGeometry().setFromPoints(points.map((point) => new THREE.Vector3(...point)));
  }, [points]);

  useEffect(() => () => lineGeometry?.dispose(), [lineGeometry]);

  if (!measureMode || points.length === 0) return null;
  const [from, to] = points;
  const measurement = from && to ? measurementDelta(from, to) : null;
  const midpoint: MeasurePoint | null =
    from && to ? [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2] : null;

  return (
    <group userData={{ measureOverlay: true }}>
      {points.map((point, index) => (
        <mesh key={`${index}-${point.join('-')}`} position={point}>
          <sphereGeometry args={[1.3, 14, 10]} />
          <meshBasicMaterial color="#f3ca52" depthTest={false} />
        </mesh>
      ))}
      {lineGeometry && (
        <lineSegments geometry={lineGeometry} renderOrder={100}>
          <lineBasicMaterial color="#f3ca52" depthTest={false} />
        </lineSegments>
      )}
      {measurement && midpoint && (
        <Html position={midpoint} center>
          <div className="twin-measure-label">
            <strong>Δ {measurement.distanceMm.toFixed(1)} mm</strong>
            <span>
              X {signed(measurement.axisMm[0])} · Y {signed(measurement.axisMm[1])} · Z {signed(measurement.axisMm[2])}
            </span>
          </div>
        </Html>
      )}
    </group>
  );
}
