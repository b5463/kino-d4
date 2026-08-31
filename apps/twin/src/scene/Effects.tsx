import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { CAM_IDS } from '@kino/kdp';
import type { CamId, TargetId } from '@kino/kdp';
import { useSceneStore } from '../state/sceneStore';
import { useSimStore } from '../state/simStore';
import { instanceTransforms } from './transforms';
import { wireCurve } from './wireGeometry';

function TransferDots({ points, speed }: { points: [number, number, number][]; speed: number }) {
  const refs = useRef<Array<THREE.Mesh | null>>([]);
  const curve = useMemo(() => new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point))), [points]);
  useFrame(({ clock }) => {
    refs.current.forEach((mesh, index) => {
      if (!mesh) return;
      const t = (clock.elapsedTime * Math.max(0.18, speed / 900_000) + index / 4) % 1;
      mesh.position.copy(curve.getPointAt(t));
    });
  });
  return (
    <group userData={{ measureOverlay: true }}>
      {[0, 1, 2, 3].map((index) => (
        <mesh key={index} ref={(node) => { refs.current[index] = node; }} raycast={() => {}}>
          <sphereGeometry args={[0.9, 10, 8]} />
          <meshBasicMaterial color="#67d9ff" depthTest={false} />
        </mesh>
      ))}
    </group>
  );
}

function bootTargets(stage: string): string[] {
  if (stage === 'BOOTING_P4' || stage === 'STORAGE_MOUNT' || stage === 'NETWORK_INIT') return ['display'];
  if (stage === 'CAMERA_RAIL_START') return ['carrier', 'power-module'];
  if (stage === 'CAMERA_NODES_BOOT') return [...CAM_IDS];
  return [];
}

function targetInstance(target: TargetId): string {
  return target === 'p4' ? 'display' : target;
}

export function Effects() {
  const profile = useSceneStore((state) => state.profile);
  const pitchMm = useSceneStore((state) => state.pitchMm);
  const explode = useSceneStore((state) => state.explode);
  const running = useSimStore((state) => state.running);
  const bootStage = useSimStore((state) => state.bootStage);
  const camStage = useSimStore((state) => state.camStage);
  const uartActive = useSimStore((state) => state.uartActive);
  const uartBytesPerSec = useSimStore((state) => state.uartBytesPerSec);
  const sdActive = useSimStore((state) => state.sdActive);
  const snapshot = useSimStore((state) => state.snapshot);
  const fw = useSimStore((state) => state.fw);
  const transforms = useMemo(() => instanceTransforms(profile, pitchMm, explode), [explode, pitchMm, profile]);
  const netByCam = useMemo(() => {
    const out = new Map<CamId, (typeof profile.nets)[number]>();
    for (const cam of CAM_IDS) {
      const net = profile.nets.find((candidate) => candidate.id === `${cam}-tx`);
      if (net) out.set(cam, net);
    }
    return out;
  }, [profile.nets]);

  /**
   * The UART dot path per camera, resolved once per (nets × transforms)
   * change. Routing inline in the render body did it again on every sim tick,
   * and — more importantly — `wireCurve` throws when an endpoint instance is
   * missing, so a profile edit that drops an instance while keeping its net
   * took the whole app to the error boundary. A net with an unresolvable
   * endpoint gets no dots instead.
   */
  const uartPoints = useMemo(() => {
    const out = new Map<CamId, [number, number, number][]>();
    for (const [cam, net] of netByCam) {
      if (!transforms.has(net.from.instance) || !transforms.has(net.to.instance)) continue;
      out.set(cam, wireCurve(net, transforms).points);
    }
    return out;
  }, [netByCam, transforms]);

  const wifiGeometry = useMemo(() => {
    const display = transforms.get('display')?.positionMm ?? [0, 0, 0];
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(...display),
      new THREE.Vector3(display[0] + 22, display[1] + 45, display[2] + 10),
      new THREE.Vector3(display[0], display[1] + 85, display[2]),
    );
    return new THREE.BufferGeometry().setFromPoints(curve.getPoints(30));
  }, [transforms]);
  const wifiLine = useMemo(() => {
    const line = new THREE.Line(wifiGeometry, new THREE.LineBasicMaterial({ color: '#67d9ff', transparent: true, opacity: 0.75 }));
    line.raycast = () => {};
    return line;
  }, [wifiGeometry]);
  useEffect(
    () => () => {
      wifiGeometry.dispose();
      (wifiLine.material as THREE.Material).dispose();
    },
    [wifiGeometry, wifiLine],
  );

  if (!running) return null;
  return (
    <group>
      {bootTargets(bootStage).map((id) => {
        const position = transforms.get(id)?.positionMm;
        return position ? (
          <mesh key={`boot-${id}`} position={position} raycast={() => {}}>
            <sphereGeometry args={[7, 16, 10]} />
            <meshBasicMaterial color="#f3ca52" transparent opacity={0.28} depthWrite={false} />
          </mesh>
        ) : null;
      })}

      {CAM_IDS.map((cam) => {
        const position = transforms.get(cam)?.positionMm;
        if (!position || camStage[cam] !== 'EXPOSING') return null;
        return (
          <mesh key={`expose-${cam}`} position={[position[0], position[1], position[2] + 8]} raycast={() => {}}>
            <planeGeometry args={[12, 8]} />
            <meshBasicMaterial color="#fff3a0" side={THREE.DoubleSide} depthTest={false} />
          </mesh>
        );
      })}

      {CAM_IDS.map((cam) => {
        const points = uartPoints.get(cam);
        if (!points || !uartActive[cam]) return null;
        return <TransferDots key={`uart-${cam}`} points={points} speed={uartBytesPerSec[cam]} />;
      })}

      {sdActive && (() => {
        const position = transforms.get('display')?.positionMm;
        return position ? (
          <mesh position={[position[0] + 38, position[1] - 20, position[2] + 8]} raycast={() => {}}>
            <boxGeometry args={[8, 4, 2]} />
            <meshBasicMaterial color="#ffb347" depthTest={false} />
          </mesh>
        ) : null;
      })()}

      {(snapshot?.uploads.uploading ?? 0) > 0 && (
        <primitive object={wifiLine} />
      )}

      {Object.entries(fw).map(([target, progress]) => {
        if (!progress || progress.state === 'idle' || progress.state === 'ready') return null;
        const position = transforms.get(targetInstance(target as TargetId))?.positionMm;
        return position ? (
          <Html key={target} position={[position[0], position[1] + 12, position[2]]} center>
            <div className="twin-sim-label">{target.toUpperCase()} UPDATE {progress.pct ?? 0}%</div>
          </Html>
        ) : null;
      })}
    </group>
  );
}
