#!/usr/bin/env node
// Bring KINO Twin's hardware profile into line with the released CAD.
//
//   npm run twin:body:bake            rewrite the body parts and placements in
//                                     packages/hardware-profiles/src/profiles/d4-v1.json
//                                     from hardware/cad/KINO_FIELD_BODY/twin/
//   npm run twin:body:check           rewrite into memory and diff; fail on drift
//   npm run twin:body:bake -- --generate
//                                     run the CAD generator and promote first
//
// The Twin used to place a provisional 126 x 80 x 36 acrylic-and-skeleton box
// and guess where the boards sat inside it. The field body (ECN-0004) is a
// different camera: 131 x 90 x 65.5, two chassis halves, a face shell with a
// sliding lens cover, a rear door - and its generator knows exactly where the
// P4 module, the four XIAO stations and the hub board are, because it gates
// them. So the generator writes those datums (twin/field-body-twin-datums.json)
// and this script turns them into the profile: one source of truth, no number
// typed twice. Everything electrical in the profile - nets, GPIO, JP1, the
// power model - is left exactly as it was.
//
// Frame. The CAD's body frame has X across the front with camera 1 at low X,
// Y up, Z from the front plate face toward the rear door. The Twin looks at the
// camera with +Z toward the lenses. The two differ by a half turn about Y, so
// every position here is R_y(180 deg) about the body's centre and every body
// part instance carries rotationDeg [0, 180, 0]; the meshes stay untouched.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CAD = join(root, 'hardware', 'cad', 'KINO_FIELD_BODY');
const DATUMS = join(CAD, 'twin', 'field-body-twin-datums.json');
const PROFILE = join(root, 'packages', 'hardware-profiles', 'src', 'profiles', 'd4-v1.json');
const DATUMS_REF = 'hardware/cad/KINO_FIELD_BODY/twin/field-body-twin-datums.json';

const args = new Set(process.argv.slice(2));
if (args.has('--generate')) {
  execFileSync(process.execPath, [join(CAD, 'generate-field-body.mjs')], { stdio: 'inherit' });
  execFileSync(process.execPath, [join(CAD, 'promote.mjs')], { stdio: 'inherit' });
}

const D = JSON.parse(readFileSync(DATUMS, 'utf8'));
const profile = JSON.parse(readFileSync(PROFILE, 'utf8'));
if (D.schema !== 'kino.twin-body' || D.version !== 1) throw new Error(`unexpected datums ${D.schema} v${D.version}`);

const r = (v) => Math.round(v * 100) / 100;
const cx = D.envelope.w / 2;
const cy = D.envelope.h / 2;
const zc = (D.assembly.min[2] + D.assembly.max[2]) / 2;
/** Body frame -> Twin frame: a half turn about Y around the body's centre. */
const toTwin = ([x, y, z]) => [r(-(x - cx)), r(y - cy), r(-(z - zc))];
const centre = (bb) => [0, 1, 2].map((i) => (bb.min[i] + bb.max[i]) / 2);
const extent = (bb) => [0, 1, 2].map((i) => r(bb.max[i] - bb.min[i]));
const PETG_G_PER_CM3 = 1.27;

// ---- the body's parts --------------------------------------------------------

const BODY_PARTS = [
  { key: 'chassis-front', id: 'field-chassis-front', name: 'KINO field body — chassis, front half', explodeOrder: 4, dir: [0, 0, 1],
    note: 'Plate, camera pockets and bores, XIAO seats and clamp bosses, P4 posts, the shutter pod. The whole optical datum.' },
  { key: 'chassis-rear', id: 'field-chassis-rear', name: 'KINO field body — chassis, rear half', explodeOrder: 2, dir: [0, 0, -1],
    note: 'Module seat, door grooves, cable exit, vents, the strap lug on the -X wall. Bolts to the front half at the bay floor.' },
  { key: 'face-shell', id: 'field-face-shell', name: 'KINO field body — face shell', explodeOrder: 8, dir: [0, 0, 1],
    note: 'Glued to the chassis front. Lens bar, the four 81.9° cells, the cover track.' },
  { key: 'lens-cover', id: 'field-lens-cover', name: 'KINO field body — sliding lens cover', explodeOrder: 10, dir: [0, 0, 1],
    note: 'Modelled OPEN (dropped to shoot), 21.4 mm below closed. The KINO D4 wordmark and thumb ridge are raised on it.' },
  { key: 'slider-keeper', id: 'field-slider-keeper', name: 'KINO field body — slider keeper', explodeOrder: 9, dir: [0, 0, 1],
    note: 'Glued into the track entry gap once the cover is in: the positive stop.' },
  { key: 'rear-door', id: 'field-rear-door', name: 'KINO field body — rear door', explodeOrder: 0, dir: [0, 0, -1],
    note: 'Tool-less dovetail door with the display window; foam gasket on its lip.' },
];

const partComponents = BODY_PARTS.map((p) => {
  const part = D.parts[p.key];
  if (!part) throw new Error(`datums have no part "${p.key}"`);
  return {
    id: p.id,
    name: p.name,
    model: `KINO_FIELD_BODY ${D.designVersion} · ${part.file}`,
    qty: 1,
    meshTier: 'A',
    sources: [{
      kind: 'OFFICIAL_CAD',
      sizeMm: extent(part.bbox),
      ref: DATUMS_REF,
      note: `assembled bounding box from generate-field-body.mjs (design ${D.designVersion}); print file ${part.print}`,
    }],
    material: { value: 'PETG, black — FDM, support-free', tag: 'ESTIMATED' },
    massG: { value: r(part.volumeCm3 * PETG_G_PER_CM3), tag: 'ESTIMATED' },
    specs: { cad: { body: D.body, file: part.file, print: part.print, frame: 'body' }, note: p.note },
  };
});

const partInstances = BODY_PARTS.map((p) => ({
  id: p.key,
  component: p.id,
  positionMm: toTwin(centre(D.parts[p.key].bbox)),
  rotationDeg: [0, 180, 0],
  group: 'shell',
  explodeOrder: p.explodeOrder,
  explodeDirMm: p.dir,
}));

// ---- the electronics, where the body puts them ---------------------------------

const stackZ = [D.cameras.lensFrontZ, D.xiao.z[1]]; // lens face to XIAO board back
const stackMidZ = (stackZ[0] + stackZ[1]) / 2;
const cameraInstances = D.cameras.xs.map((x, i) => {
  const origin = [x, D.xiao.centerY, stackMidZ];
  const lens = [x, D.cameras.lensY, D.cameras.lensFrontZ];
  const twinOrigin = toTwin(origin);
  const twinLens = toTwin(lens);
  return {
    id: `cam${i + 1}`,
    component: 'camera-node',
    positionMm: twinOrigin,
    rotationDeg: [0, 0, 0],
    group: 'camera-bar',
    explodeOrder: 6,
    explodeDirMm: [0, 0, 1],
    opticalCenterOffsetMm: [0, 1, 2].map((k) => r(twinLens[k] - twinOrigin[k])),
    opticalCenterConfidence: 'OFFICIAL_CAD',
  };
});

const moduleCentre = [
  (D.module.x[0] + D.module.x[1]) / 2,
  (D.module.y[0] + D.module.y[1]) / 2,
  (D.module.pcbBackZ + D.module.glassRearZ) / 2,
];
const displayInstance = {
  id: 'display', component: 'main-display', positionMm: toTwin(moduleCentre), rotationDeg: [0, 0, 0],
  explodeOrder: 4, explodeDirMm: [0, 0, -1],
};

const hub = D.bay.hub;
const hubCentre = [(hub.x[0] + hub.x[1]) / 2, (hub.y[0] + hub.y[1]) / 2, (hub.z[0] + hub.z[1]) / 2];
const carrierInstance = {
  id: 'carrier', component: 'perfboard', positionMm: toTwin(hubCentre), rotationDeg: [0, 0, 0],
  group: 'body', explodeOrder: 3, explodeDirMm: [0, 0, -1],
};

// The shutter's tactile switch, in the pod under the top wall (ECN-0003: the
// shutter is on JP1-21; the pod is at shutterX / shutterZ).
const sw = D.shutter.switchBody;
const shutterInstance = {
  id: 'shutter', component: 'tact-switch',
  positionMm: toTwin([D.shutter.x, D.shutter.topWallY - 6 - sw[2] / 2, D.shutter.z]),
  rotationDeg: [90, 0, 0], group: 'body', explodeOrder: 7, explodeDirMm: [0, 1, 0],
};

// The external light on the top wall's 1/4-20 stud (README, Openings; the
// built-in flash went with ECN-0003). The stud is measured; the light is a
// bought unit nobody has put calipers on yet, so its box is PROVISIONAL and
// says so.
const L = D.light;
// Modelled as the part below the light's base plate: the top 6 mm is inside
// the light, and a box for it would read as a collision with the light it is
// screwed into. The full 25 is in the specs.
const studTopY = L.topWallY;
const studBottomY = L.topWallY - L.wallT - L.studInside;
const studShownLen = r(studTopY - studBottomY);
const LIGHT_BOX = [50, 32, 38]; // PROVISIONAL envelope, w x h x d
const lightComponents = [
  {
    id: 'light-stud', name: '1/4-20 light stud', qty: 1, meshTier: 'B',
    sources: [{ kind: 'MEASURED', sizeMm: [L.threadD, studShownLen, L.threadD], ref: DATUMS_REF,
      note: `the ${studShownLen} mm below the light's ${L.plate} mm square base: ${L.wallT} through the top wall, ${L.studInside} inside for its two nuts; the stud is ${L.studLen} with ${L.studBuried} buried in the base` }],
    material: { value: 'steel, zinc plated', tag: 'ESTIMATED' },
    specs: { thread: '1/4-20 UNC', lengthMm: L.studLen, buriedInLightMm: L.studBuried, nuts: 2, note: 'Fit and tighten the nuts before the XIAO boards go in (README, Hardware).' },
  },
  {
    id: 'top-light', name: 'External constant light (video light) on the top stud', qty: 1, meshTier: 'B',
    sources: [{ kind: 'PROVISIONAL', sizeMm: LIGHT_BOX, ref: DATUMS_REF,
      note: 'MEASURE_REQUIRED - envelope of the bought light; only its base plate and stud are measured' }],
    specs: { mount: '1/4-20 stud, 18 mm square base plate on the flat top', note: 'Replaces the built-in flash assembly dropped by ECN-0003. Drive and control are the light\'s own.' },
  },
];
const lightInstances = [
  {
    id: 'light-stud', component: 'light-stud',
    positionMm: toTwin([L.x, (studTopY + studBottomY) / 2, L.z]), rotationDeg: [0, 0, 0],
    group: 'body', explodeOrder: 8, explodeDirMm: [0, 1, 0],
  },
  {
    id: 'top-light', component: 'top-light',
    positionMm: toTwin([L.x, L.topWallY + 3 + LIGHT_BOX[1] / 2, L.z]), rotationDeg: [0, 0, 0],
    group: 'body', explodeOrder: 9, explodeDirMm: [0, 1, 0],
  },
];

// ---- assemble the profile ------------------------------------------------------

const OLD_ENCLOSURE = new Set(['enclosure-shell', 'enclosure-chassis']);
const NOT_IN_THIS_BODY = new Set(['battery', 'bms', 'power-module', 'fuse', 'speaker', 'bulk-cap']);
const REPLACED = new Set(['cam1', 'cam2', 'cam3', 'cam4', 'display', 'carrier', 'shutter', 'light-stud', 'top-light']);

const keptComponents = profile.components.filter((c) =>
  !OLD_ENCLOSURE.has(c.id) && !BODY_PARTS.some((p) => p.id === c.id) && !lightComponents.some((l) => l.id === c.id));
// The XIAO stands portrait in its seat: 17.8 mm across the bar, 21 mm tall,
// the camera stack 15 mm deep from lens face to board back (CAD xiao/cameras).
const camNode = keptComponents.find((c) => c.id === 'camera-node');
if (camNode) {
  camNode.sources = [{
    ...camNode.sources[0],
    sizeMm: [D.xiao.boardW, D.xiao.boardH, 15],
    note: 'Seeed module envelope 21 x 17.8 x 15; portrait in the field body\'s seat (17.8 across the bar, 21 tall), lens 6.95 mm below the board centre',
  }];
}
const carrier = keptComponents.find((c) => c.id === 'perfboard');
if (carrier) {
  carrier.name = 'Hub board (the wiring carrier)';
  carrier.model = '54 × 33 mm piggyback, Dupont headers';
  carrier.sources = [{
    kind: 'SELLER_SPEC',
    sizeMm: hub.size,
    ref: DATUMS_REF,
    note: 'board 54 x 33 (seller), 12.6 mm with plugged headers; floats in the 14.6 mm bay between the P4 post rows, wrapped in Kapton (field-body README, Wiring room)',
  }];
}

// Everything this script does not place itself: not the pack, not the parts
// it re-places, and no shell - the old acrylic panels and skeleton, or this
// script's own six parts on a second run, which is what keeps `--check` a
// fixed point.
const keptInstances = profile.instances.filter((i) =>
  !NOT_IN_THIS_BODY.has(i.id) && !REPLACED.has(i.id) && i.group !== 'shell');

// The pack chain's nets go with the pack: a net must name placed instances,
// and the battery, fuse, BMS and charger are not in this body. WIRING.md and
// the profile's power model still describe the chain; the Twin just does not
// route wires to parts that are not there.
const placed = new Map([...cameraInstances, displayInstance, carrierInstance, shutterInstance, ...lightInstances, ...keptInstances]
  .map((i) => [i.id, i.positionMm]));
// Harness routes. The authored waypoints described the provisional layout;
// here every wire runs from its instance into the component bay's trunk -
// below the hub board, mid-bay, where the README's Dupont loom actually lives
// - across, and up to the other end. Cosmetic, and said so: the wire's path
// is a stated route, not a measured one; only its endpoints are the parts.
const trunkY = r(hub.y[0] - cy - 14); // well below the hub board, still inside the bay
const nets = profile.nets
  .filter((n) => !NOT_IN_THIS_BODY.has(n.from.instance) && !NOT_IN_THIS_BODY.has(n.to.instance))
  .map((n) => {
    const a = placed.get(n.from.instance);
    const b = placed.get(n.to.instance);
    if (!a || !b) return n;
    // The drop from an outer camera runs 4 mm outboard of the board, so the
    // spline's corner does not bulge into the hub board beside it.
    const out = (x) => (Math.abs(x) > hub.size[0] / 2 ? x + Math.sign(x) * 4 : x);
    // ...and each end drops or rises at its own depth: the module's component face
    // and the hub board's back are 2 mm apart, so a leg that climbs from the
    // mid-bay trunk to the module skims the hub. Rising under the endpoint
    // itself keeps the run clear of everything but the part it terminates on.
    // Five points (the schema's cap): down at the from-end's own depth, the
    // trunk below the hub drifting to the to-end's depth, up under the to-end.
    return { ...n, waypointsMm: [a, [out(a[0]), trunkY, a[2]], [out(b[0]), trunkY, b[2]], [b[0], trunkY, b[2]], b] };
  });

const next = {
  ...profile,
  body: { sizeMm: extent(D.assembly), confidence: 'OFFICIAL_CAD' },
  components: [...keptComponents, ...lightComponents, ...partComponents],
  instances: [...cameraInstances, displayInstance, carrierInstance, shutterInstance, ...lightInstances, ...keptInstances, ...partInstances],
  nets,
};

const text = JSON.stringify(next, null, 2) + '\n';
if (args.has('--check')) {
  const current = readFileSync(PROFILE, 'utf8');
  if (current !== text) {
    console.error('[twin-body] d4-v1.json is out of step with the released CAD datums - run npm run twin:body:bake');
    process.exit(1);
  }
  console.log('[twin-body] d4-v1.json matches the released CAD datums');
} else {
  writeFileSync(PROFILE, text);
  console.log(`[twin-body] wrote ${PROFILE}: body ${next.body.sizeMm.join(' x ')} mm, ${partInstances.length} body parts, ${next.instances.length} instances, ${nets.length} nets (${profile.nets.length - nets.length} pack-chain nets not routed)`);
}
