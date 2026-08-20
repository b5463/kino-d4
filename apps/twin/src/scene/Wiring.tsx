import { useMemo } from 'react';
import * as THREE from 'three';
import { twinMaterials } from '@kino/three-assets';
import { useSceneStore } from '../state/sceneStore';
import { instanceTransforms } from './transforms';
import { RIBBON_SIZE_MM, visibleNets, wireCurve } from './wireGeometry';

const ENDPOINT_MARKER_RADIUS_MM = 1.4;

/** One net's tube: `TubeGeometry` traced along `wireCurve`'s sampled points, colored by convention (§8). */
function WireTube({ points, radiusMm, material }: { points: [number, number, number][]; radiusMm: number; material: THREE.Material }) {
  const geometry = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
    return new THREE.TubeGeometry(curve, Math.max(points.length - 1, 1), radiusMm, 8, false);
  }, [points, radiusMm]);

  return <mesh geometry={geometry} material={material} raycast={() => {}} />;
}

/**
 * A ribbon net's flat strip (§7.13): 33×1.2mm box run straight from live
 * `from` to live `to` (ribbons in this profile are short, single-span runs —
 * a straight box is an honest Tier-C proxy, not a curved path pretending to
 * be measured routing). One long face is tinted red as the pin-1 stripe.
 */
function RibbonStrip({ from, to }: { from: [number, number, number]; to: [number, number, number] }) {
  const { body, stripe } = useMemo(() => {
    const start = new THREE.Vector3(...from);
    const end = new THREE.Vector3(...to);
    const lengthMm = start.distanceTo(end) || 0.001;
    const [width, height] = RIBBON_SIZE_MM;

    const mid = start.clone().add(end).multiplyScalar(0.5);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      end.clone().sub(start).normalize(),
    );

    return {
      body: { position: mid.toArray() as [number, number, number], quaternion, size: [width, height, lengthMm] as [number, number, number] },
      stripe: {
        position: mid
          .clone()
          .add(new THREE.Vector3(width / 2 - 1.5, 0, 0).applyQuaternion(quaternion))
          .toArray() as [number, number, number],
        quaternion,
        size: [3, height + 0.05, lengthMm] as [number, number, number],
      },
    };
  }, [from, to]);

  const mats = useMemo(() => twinMaterials(), []);

  return (
    <>
      <mesh position={body.position} quaternion={body.quaternion} raycast={() => {}}>
        <boxGeometry args={body.size} />
        <primitive object={mats.wireByColor.grey} attach="material" />
      </mesh>
      <mesh position={stripe.position} quaternion={stripe.quaternion} raycast={() => {}}>
        <boxGeometry args={stripe.size} />
        <primitive object={mats.wireByColor.red} attach="material" />
      </mesh>
    </>
  );
}

/**
 * The wiring harness (§8, Task 15): one `TubeGeometry` per net that passes
 * both the class toggles and the focus filter, plus a small endpoint marker
 * at each visible net's two ends. Renders nothing outside WIRING mode — the
 * harness is that view's whole reason to exist, not a permanent overlay on
 * every other mode.
 *
 * Wires never raycast: they sit inside/around the already-selectable
 * component meshes, and swallowing clicks/hover here would fight the
 * Assembly's own instance picking for no benefit.
 */
export function Wiring() {
  const profile = useSceneStore((s) => s.profile);
  const pitchMm = useSceneStore((s) => s.pitchMm);
  const explode = useSceneStore((s) => s.explode);
  const viewMode = useSceneStore((s) => s.viewMode);
  const netClasses = useSceneStore((s) => s.netClasses);
  const netFocus = useSceneStore((s) => s.netFocus);

  const transforms = useMemo(() => instanceTransforms(profile, pitchMm, explode), [profile, pitchMm, explode]);
  const mats = useMemo(() => twinMaterials(), []);

  const nets = useMemo(() => visibleNets(profile.nets, netClasses, netFocus), [profile.nets, netClasses, netFocus]);

  if (viewMode !== 'wiring') return null;

  return (
    <>
      {nets.map((net) => {
        const fromT = transforms.get(net.from.instance);
        const toT = transforms.get(net.to.instance);
        if (!fromT || !toT) return null; // defensive: profile data should always resolve both

        const material = mats.wireByColor[net.color];

        if (net.gauge === 'ribbon') {
          return (
            <group key={net.id}>
              <RibbonStrip from={fromT.positionMm} to={toT.positionMm} />
            </group>
          );
        }

        const { points, radiusMm } = wireCurve(net, transforms);

        return (
          <group key={net.id}>
            <WireTube points={points} radiusMm={radiusMm} material={material} />
            <mesh position={fromT.positionMm} raycast={() => {}}>
              <sphereGeometry args={[ENDPOINT_MARKER_RADIUS_MM, 12, 12]} />
              <primitive object={material} attach="material" />
            </mesh>
            <mesh position={toT.positionMm} raycast={() => {}}>
              <sphereGeometry args={[ENDPOINT_MARKER_RADIUS_MM, 12, 12]} />
              <primitive object={material} attach="material" />
            </mesh>
          </group>
        );
      })}
    </>
  );
}
