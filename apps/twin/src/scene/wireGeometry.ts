import * as THREE from 'three';
import type { NetClass, NetDef } from '@kino/hardware-profiles';
import type { instanceTransforms } from './transforms';

/** §7.13 gauge → tube radius (mm). Ribbon has no round radius — it renders as a flat strip (see `RIBBON_SIZE_MM`). */
const GAUGE_RADIUS_MM: Record<Exclude<NetDef['gauge'], 'ribbon'>, number> = {
  '20AWG': 0.9,
  '24AWG': 0.55,
  '28AWG': 0.35,
};

/** Ribbon cross-section (§7.13): 33mm wide × 1.2mm thick flat strip, one edge striped red for pin 1. */
export const RIBBON_SIZE_MM: [number, number] = [33, 1.2];

/** Number of points a wire curve samples to (§ Task 15 spec: CatmullRom sampled at 24 points). */
export const WIRE_SAMPLES = 24;

/**
 * Tube radius for one net's gauge (§7.13/§7.14). No AWG ever renders thinner
 * than its assigned gauge calls for — a high-current path is only ever
 * authored as 20AWG in profile data, never approximated with a thin trace.
 * Ribbon has no meaningful "radius"; callers rendering a ribbon net should
 * use `RIBBON_SIZE_MM`'s flat box profile instead and can ignore this value.
 */
export function gaugeRadiusMm(gauge: NetDef['gauge']): number {
  if (gauge === 'ribbon') return RIBBON_SIZE_MM[1] / 2;
  return GAUGE_RADIUS_MM[gauge];
}

function subVec3(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface WireCurve {
  /** Points sampled along the net's route, in scene-space millimetres (§4 axes/origin). */
  points: [number, number, number][];
  /** Tube radius in millimetres, from `gaugeRadiusMm(net.gauge)`. */
  radiusMm: number;
}

/**
 * One net's rendered wire path (§8/§7.13). `net.waypointsMm` are authored at
 * the profile's base pitch/explode (each first/last waypoint is the pin's
 * location relative to its instance at that base pose); this resolves the
 * curve against the *live* transforms instead, so the wire actually tracks
 * its endpoints through pitch changes and the exploded view rather than
 * rendering a frozen base-pose path.
 *
 * The first and last sampled points always land exactly on the live
 * `from`/`to` instance positions (endpoints "resolved from instance
 * positions" per the spec); interior waypoints blend the same from/to delta
 * linearly by position along the run, so the whole harness deforms smoothly
 * with the assembly instead of interior points staying frozen while the
 * endpoints they're routed between move away from them.
 *
 * Throws when either endpoint instance is absent from `transforms` — a net
 * naming an instance the profile no longer carries is bad data, not a curve.
 * Callers reached from render (the WIRING harness, the sim effects, the
 * clearance report) must check both endpoints resolve before calling, so one
 * stale net degrades to one missing wire instead of an error boundary.
 */
export function wireCurve(net: NetDef, transforms: ReturnType<typeof instanceTransforms>): WireCurve {
  const fromT = transforms.get(net.from.instance);
  const toT = transforms.get(net.to.instance);
  if (!fromT || !toT) {
    throw new Error(`wireCurve: missing transform for net "${net.id}" (${net.from.instance} -> ${net.to.instance})`);
  }

  const raw = net.waypointsMm;
  const last = raw.length - 1;
  const deltaFrom = subVec3(fromT.positionMm, raw[0]!);
  const deltaTo = subVec3(toT.positionMm, raw[last]!);

  const liveWaypoints = raw.map((p, i): THREE.Vector3 => {
    const t = last === 0 ? 0 : i / last;
    const dx = lerp(deltaFrom[0], deltaTo[0], t);
    const dy = lerp(deltaFrom[1], deltaTo[1], t);
    const dz = lerp(deltaFrom[2], deltaTo[2], t);
    return new THREE.Vector3(p[0] + dx, p[1] + dy, p[2] + dz);
  });

  const curve = new THREE.CatmullRomCurve3(liveWaypoints);
  const sampled = curve.getPoints(WIRE_SAMPLES - 1);
  const points: [number, number, number][] = sampled.map((v) => [v.x, v.y, v.z]);

  // CatmullRomCurve3.getPoint(0)/getPoint(1) reproduce the first/last control
  // point up to floating-point error from the spline's internal arithmetic —
  // pin the endpoints back to the exact live positions so "the wire starts
  // and ends exactly on its instance" is a hard guarantee, not an
  // approximation that happens to be close.
  points[0] = [...fromT.positionMm];
  points[points.length - 1] = [...toT.positionMm];

  return { points, radiusMm: gaugeRadiusMm(net.gauge) };
}

/**
 * Nets visible under the current class toggles ∧ focus filter (§8). `focus`,
 * when set, keeps only nets touching that one instance — e.g. `('cam2',
 * {UART})` returns exactly cam2's two UART runs (TX/RX to the display),
 * never cam1/cam3/cam4's, even though they share the same class.
 */
export function visibleNets(nets: NetDef[], classes: ReadonlySet<NetClass>, focus: string | null): NetDef[] {
  return nets.filter((n) => {
    if (!classes.has(n.cls)) return false;
    if (focus !== null && n.from.instance !== focus && n.to.instance !== focus) return false;
    return true;
  });
}
