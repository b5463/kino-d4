import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useSceneStore } from '../state/sceneStore';
import { fovForCam, frustumCorners, opticsDistancesM } from '../optics/frustum';
import { instanceTransforms } from './transforms';

type Point3 = [number, number, number];
type Segment = [Point3, Point3];

function SegmentLines({ segments, color, opacity = 1 }: { segments: Segment[]; color: string; opacity?: number }) {
  const geometry = useMemo(() => {
    const positions = new Float32Array(segments.length * 6);
    let cursor = 0;
    for (const [from, to] of segments) {
      positions.set(from, cursor);
      cursor += 3;
      positions.set(to, cursor);
      cursor += 3;
    }
    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return result;
  }, [segments]);

  // The geometry is a prop, not a <bufferGeometry> element, so R3F does not
  // free it. Explode and pitch drags rebuild it continuously.
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments geometry={geometry} raycast={() => {}}>
      <lineBasicMaterial color={color} transparent={opacity < 1} opacity={opacity} depthWrite={opacity === 1} />
    </lineSegments>
  );
}

function frustumSegments(origin: Point3, corners: Point3[]): Segment[] {
  const edges: Segment[] = corners.map((corner) => [origin, corner]);
  for (let index = 0; index < corners.length; index++) {
    edges.push([corners[index]!, corners[(index + 1) % corners.length]!]);
  }
  return edges;
}

function OverlapPlane({ position, widthMm, heightMm, color, opacity }: {
  position: Point3;
  widthMm: number;
  heightMm: number;
  color: string;
  opacity: number;
}) {
  if (widthMm <= 0 || heightMm <= 0) return null;
  return (
    <mesh position={position} raycast={() => {}}>
      <planeGeometry args={[widthMm, heightMm]} />
      <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  );
}

function PersonProxy({ position, widthMm, heightMm }: { position: Point3; widthMm: number; heightMm: number }) {
  const radius = Math.max(1, Math.min(widthMm / 2, heightMm / 2));
  const bodyLength = Math.max(1, heightMm - radius * 2);
  return (
    <mesh position={position} raycast={() => {}}>
      <capsuleGeometry args={[radius, bodyLength, 8, 16]} />
      <meshBasicMaterial color="#d4a85f" transparent opacity={0.18} wireframe />
    </mesh>
  );
}

function SubjectProxy({ center, subject, widthMm, heightMm }: {
  center: Point3;
  subject: 'person' | 'group';
  widthMm: number;
  heightMm: number;
}) {
  if (subject === 'person') return <PersonProxy position={center} widthMm={widthMm} heightMm={heightMm} />;

  const personWidth = Math.max(1, widthMm / 4);
  const spacing = widthMm / 3;
  return (
    <group>
      {[-1, 0, 1].map((slot) => (
        <PersonProxy
          key={slot}
          position={[center[0] + slot * spacing, center[1], center[2]]}
          widthMm={personWidth}
          heightMm={heightMm}
        />
      ))}
    </group>
  );
}

/** Geometry-only optical overlay. Every numeric FOV is either measured profile data or a labelled scenario. */
export function Optics() {
  const profile = useSceneStore((state) => state.profile);
  const pitchMm = useSceneStore((state) => state.pitchMm);
  const explode = useSceneStore((state) => state.explode);
  const optics = useSceneStore((state) => state.optics);

  const transforms = useMemo(() => instanceTransforms(profile, pitchMm, explode), [profile, pitchMm, explode]);
  const cameras = useMemo(
    () => profile.instances
      .filter((instance) => instance.component === 'camera-node')
      .map((instance) => {
        const position = transforms.get(instance.id)?.positionMm;
        if (!position) return undefined;
        // Frustum apex = board center + the instance's optical-center offset
        // (audit #63). The offset defaults to zero until the bench measures
        // real optical centers, so apex = board center stays explicit.
        const [ox, oy, oz] = instance.opticalCenterOffsetMm;
        return [position[0] + ox, position[1] + oy, position[2] + oz] as Point3;
      })
      .filter((position): position is Point3 => position !== undefined)
      .sort((a, b) => a[0] - b[0]),
    [profile.instances, transforms],
  );
  const fov = useMemo(() => fovForCam(profile, optics.fovScenarioDeg), [profile, optics.fovScenarioDeg]);
  const distancesM = useMemo(
    () => opticsDistancesM(optics.distancesM, optics.customM),
    [optics.distancesM, optics.customM],
  );

  /**
   * Axis and frustum edge lists per camera, memoised on the inputs that
   * actually change them. Built inline in the render body these were a fresh
   * array on every render, so `SegmentLines`' geometry memo never hit and the
   * overlay allocated (and, before `SegmentLines` learned to dispose, leaked)
   * eight line buffers per render — continuously, for the length of an
   * explode or pitch drag.
   */
  const cameraSegments = useMemo(() => {
    if (!('hDeg' in fov) || distancesM.length === 0) return [];
    const maxMm = distancesM[distancesM.length - 1]! * 1_000;
    return cameras.map((origin) => ({
      origin,
      axis: [[origin, [origin[0], origin[1], origin[2] + maxMm]]] as Segment[],
      frusta: distancesM.flatMap((distanceM) =>
        frustumSegments(origin, frustumCorners(origin, fov.hDeg, fov.vDeg, distanceM * 1_000) as Point3[]),
      ),
    }));
  }, [cameras, distancesM, fov]);

  if (!optics.enabled || !('hDeg' in fov) || cameras.length !== 4 || distancesM.length === 0) return null;

  const centerX = cameras.reduce((sum, camera) => sum + camera[0], 0) / cameras.length;
  const centerY = cameras.reduce((sum, camera) => sum + camera[1], 0) / cameras.length;
  const centerZ = cameras.reduce((sum, camera) => sum + camera[2], 0) / cameras.length;
  const subjectDistanceM = distancesM[0]!;

  return (
    <group name="optics-overlay">
      {cameraSegments.map(({ origin, axis, frusta }, cameraIndex) => (
        <group key={cameraIndex}>
          <mesh position={origin} raycast={() => {}}>
            <planeGeometry args={[8, 6]} />
            <meshBasicMaterial color="#72d7ef" transparent opacity={0.5} side={THREE.DoubleSide} />
          </mesh>
          <SegmentLines segments={axis} color="#8be0f2" opacity={0.8} />
          <SegmentLines segments={frusta} color="#4c9fb4" opacity={0.42} />
        </group>
      ))}

      {distancesM.map((distanceM) => {
        const distanceMm = distanceM * 1_000;
        const corners = frustumCorners([centerX, centerY, centerZ], fov.hDeg, fov.vDeg, distanceMm) as Point3[];
        const singleWidthMm = corners[1]![0] - corners[0]![0];
        const planeHeightMm = corners[0]![1] - corners[3]![1];
        const pairWidthMm = Math.max(0, singleWidthMm - pitchMm);
        const commonWidthMm = Math.max(0, singleWidthMm - pitchMm * 3);
        const planeZ = centerZ + distanceMm;
        return (
          <group key={distanceM}>
            {cameras.slice(0, -1).map((camera, index) => (
              <OverlapPlane
                key={index}
                position={[(camera[0] + cameras[index + 1]![0]) / 2, centerY, planeZ]}
                widthMm={pairWidthMm}
                heightMm={planeHeightMm}
                color="#4aa8a1"
                opacity={0.055}
              />
            ))}
            <OverlapPlane
              position={[centerX, centerY, planeZ + 0.5]}
              widthMm={commonWidthMm}
              heightMm={planeHeightMm}
              color="#a77bd8"
              opacity={0.12}
            />
          </group>
        );
      })}

      {optics.subject !== 'none' ? (
        <SubjectProxy
          center={[centerX, centerY, centerZ + subjectDistanceM * 1_000 + 1]}
          subject={optics.subject}
          widthMm={optics.subjectWmm}
          heightMm={optics.subjectHmm}
        />
      ) : null}
    </group>
  );
}
