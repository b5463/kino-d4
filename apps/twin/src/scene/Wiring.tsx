import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CAM_IDS } from '@kino/kdp';
import type { CamId } from '@kino/kdp';
import { twinMaterials } from '@kino/three-assets';
import { useSceneStore } from '../state/sceneStore';
import { useSimStore } from '../state/simStore';
import { instanceTransforms } from './transforms';
import { RIBBON_SIZE_MM, visibleNets, wireCurve } from './wireGeometry';
import type { WireCurve } from './wireGeometry';

const ENDPOINT_MARKER_RADIUS_MM = 1.4;

/** One net's tube: `TubeGeometry` traced along `wireCurve`'s sampled points, colored by convention (§8). */
function WireTube({
  points,
  radiusMm,
  material,
  active,
  pulseAt,
}: {
  points: [number, number, number][];
  radiusMm: number;
  material: THREE.Material;
  active: boolean;
  pulseAt: number;
}) {
  const geometry = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
    return new THREE.TubeGeometry(curve, Math.max(points.length - 1, 1), radiusMm, 8, false);
  }, [points, radiusMm]);
  // R3F never frees a geometry handed in as a prop (only the ones it builds
  // from a <tubeGeometry> element), so this node owns the disposal. Without
  // it every re-memo — a pitch drag, an explode tick — leaks one tube's
  // buffers per net for as long as WIRING is open.
  useEffect(() => () => geometry.dispose(), [geometry]);
  const liveMaterial = useMemo(() => material.clone(), [material]);
  useEffect(() => () => liveMaterial.dispose(), [liveMaterial]);
  useFrame(() => {
    if (!(liveMaterial instanceof THREE.MeshStandardMaterial)) return;
    const pulsing = pulseAt > 0 && Date.now() - pulseAt < 180;
    liveMaterial.emissive.copy(liveMaterial.color);
    liveMaterial.emissiveIntensity = pulsing ? 1.8 : active ? 0.75 : 0;
  });

  return <mesh geometry={geometry} material={liveMaterial} raycast={() => {}} />;
}

function camForNet(id: string): CamId | null {
  return CAM_IDS.find((cam) => id.startsWith(`${cam}-`)) ?? null;
}

/**
 * A ribbon net's flat strip (§7.13): 33×1.2mm box run straight from live
 * `from` to live `to` (ribbons in this profile are short, single-span runs —
 * a straight box is an honest Tier-C proxy, not a curved path pretending to
 * be measured routing). One long face is tinted red as the pin-1 stripe.
 */
function RibbonStrip({
  from,
  to,
  mats,
}: {
  from: [number, number, number];
  to: [number, number, number];
  mats: ReturnType<typeof twinMaterials>;
}) {
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

  // The palette comes from Wiring's one shared twinMaterials() — a fresh
  // per-ribbon palette was ~15 undisposed shader programs per net-class
  // toggle (each toggle remounts every ribbon).

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
  const running = useSimStore((state) => state.running);
  const uartActive = useSimStore((state) => state.uartActive);
  const syncPulseAt = useSimStore((state) => state.syncPulseAt);
  const snapshot = useSimStore((state) => state.snapshot);

  const transforms = useMemo(() => instanceTransforms(profile, pitchMm, explode), [profile, pitchMm, explode]);
  const mats = useMemo(() => twinMaterials(), []);

  const nets = useMemo(() => visibleNets(profile.nets, netClasses, netFocus), [profile.nets, netClasses, netFocus]);

  /**
   * One route per round net, resolved once per (nets × transforms) change
   * rather than inside the render body. The sim re-renders this component on
   * every UART/sync tick; routing inline handed `WireTube` a fresh `points`
   * array each time, so its `[points]` memo never hit and the whole harness
   * rebuilt its tube geometry several times a second.
   *
   * A net whose endpoint instance is gone (a profile edit dropped the
   * instance but kept the net) is skipped here, the same way the render body
   * below skips it — `wireCurve` throws on a missing transform, and that
   * throw would take the app to the error boundary.
   */
  const routes = useMemo(() => {
    const out = new Map<string, WireCurve>();
    for (const net of nets) {
      if (net.gauge === 'ribbon') continue;
      if (!transforms.has(net.from.instance) || !transforms.has(net.to.instance)) continue;
      out.set(net.id, wireCurve(net, transforms));
    }
    return out;
  }, [nets, transforms]);

  if (viewMode !== 'wiring') return null;

  return (
    <>
      {nets.map((net) => {
        const fromT = transforms.get(net.from.instance);
        const toT = transforms.get(net.to.instance);
        // A net can outlive its endpoint instance (a profile edit drops the
        // instance, the net stays) — that net simply isn't drawn.
        if (!fromT || !toT) return null;

        const material = mats.wireByColor[net.color];
        const cam = camForNet(net.id);
        const camPowered =
          cam !== null &&
          running &&
          snapshot?.cams[cam].fault !== 'offline' &&
          snapshot?.cams[cam].fault !== 'power-open';
        const active = (net.cls === 'POWER' && camPowered) || (net.cls === 'UART' && cam !== null && uartActive[cam]);
        const pulseAt = net.cls === 'SYNC' ? syncPulseAt : 0;

        if (net.gauge === 'ribbon') {
          return (
            <group key={net.id}>
              <RibbonStrip from={fromT.positionMm} to={toT.positionMm} mats={mats} />
            </group>
          );
        }

        const route = routes.get(net.id);
        if (!route) return null;
        const { points, radiusMm } = route;

        return (
          <group key={net.id}>
            <WireTube points={points} radiusMm={radiusMm} material={material} active={active} pulseAt={pulseAt} />
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
