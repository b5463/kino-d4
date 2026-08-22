// Fabrication exports (issue #31): front-panel DXF, per-instance transform
// CSV, and a STEP solid of the assembly envelope. All three resolve geometry
// through the same `resolveDimensions` + `instanceTransforms` the scene uses,
// so a measured override changes the exported file the same way it changes
// the viewport — canonical guesses never ship behind a measured label.
import { resolveDimensions } from '@kino/hardware-profiles';
import type { HardwareProfile, MeasuredOverride } from '@kino/hardware-profiles';
import { instanceTransforms } from '../scene/transforms';

/**
 * No measured lens-barrel diameter exists yet (the XIAO Sense lens is
 * unmeasured hardware) — PROVISIONAL, carried as a comment inside the DXF so
 * the fab file itself says which number is a guess.
 */
export const LENS_CUTOUT_DIAMETER_MM = 10;

function resolvedSize(
  profile: HardwareProfile,
  overrides: MeasuredOverride[],
  componentId: string,
): { sizeMm: readonly (number | null)[]; confidence: string } {
  const component = profile.components.find((item) => item.id === componentId);
  if (!component) return { sizeMm: [null, null, null], confidence: 'MISSING' };
  const resolved = resolveDimensions(component, overrides.find((item) => item.componentId === componentId));
  return { sizeMm: resolved.sizeMm, confidence: resolved.confidence };
}

/** The front panel's outline source: the shell component, else the body envelope. */
function panelOutline(profile: HardwareProfile, overrides: MeasuredOverride[]): { w: number; h: number; confidence: string } {
  const shell = resolvedSize(profile, overrides, 'enclosure-shell');
  const [w, h] = shell.sizeMm;
  if (w !== null && h !== null) return { w, h, confidence: shell.confidence };
  return { w: profile.body.sizeMm[0], h: profile.body.sizeMm[1], confidence: profile.body.confidence };
}

/** Camera lens centers on the panel plane at the live pitch, offsets applied. */
export function lensCenters(profile: HardwareProfile, pitchMm: number): Array<{ id: string; x: number; y: number }> {
  const transforms = instanceTransforms(profile, pitchMm, 0);
  return profile.instances
    .filter((instance) => instance.group === 'camera-bar')
    .map((instance) => {
      const transform = transforms.get(instance.id);
      const offset = instance.opticalCenterOffsetMm ?? [0, 0, 0];
      return {
        id: instance.id,
        x: (transform?.positionMm[0] ?? 0) + offset[0],
        y: (transform?.positionMm[1] ?? 0) + offset[1],
      };
    });
}

const dxfPair = (code: number, value: string | number) => `${code}\n${value}`;

function dxfLine(x1: number, y1: number, x2: number, y2: number): string {
  return [dxfPair(0, 'LINE'), dxfPair(8, 'PANEL'), dxfPair(10, x1), dxfPair(20, y1), dxfPair(11, x2), dxfPair(21, y2)].join('\n');
}

function dxfCircle(x: number, y: number, radius: number, layer: string): string {
  return [dxfPair(0, 'CIRCLE'), dxfPair(8, layer), dxfPair(10, x), dxfPair(20, y), dxfPair(40, radius)].join('\n');
}

/**
 * Front-panel outline plus one lens cutout per camera, DXF R12 (the dialect
 * every laser/CNC toolchain reads). Units are millimetres; origin is the
 * panel center, matching the scene's coordinate frame.
 */
export function exportFrontPanelDxf(
  profile: HardwareProfile,
  overrides: MeasuredOverride[],
  pitchMm: number,
): string {
  const outline = panelOutline(profile, overrides);
  const hw = outline.w / 2;
  const hh = outline.h / 2;
  const cutouts = lensCenters(profile, pitchMm);

  const entities = [
    dxfLine(-hw, -hh, hw, -hh),
    dxfLine(hw, -hh, hw, hh),
    dxfLine(hw, hh, -hw, hh),
    dxfLine(-hw, hh, -hw, -hh),
    ...cutouts.map((lens) => dxfCircle(lens.x, lens.y, LENS_CUTOUT_DIAMETER_MM / 2, 'LENS-CUTOUTS')),
  ];

  return [
    dxfPair(999, `KINO Twin front panel — profile ${profile.profile}, pitch ${pitchMm} mm, outline ${outline.w}x${outline.h} mm (${outline.confidence})`),
    dxfPair(999, `lens cutout diameter ${LENS_CUTOUT_DIAMETER_MM} mm is PROVISIONAL — no measured lens barrel yet`),
    dxfPair(0, 'SECTION'),
    dxfPair(2, 'ENTITIES'),
    ...entities,
    dxfPair(0, 'ENDSEC'),
    dxfPair(0, 'EOF'),
  ].join('\n') + '\n';
}

const csvNum = (value: number) => (Object.is(value, -0) ? '0' : String(Math.round(value * 1000) / 1000));

/** Every instance's assembled-pose transform and resolved dimensions, CSV. */
export function exportTransformsCsv(
  profile: HardwareProfile,
  overrides: MeasuredOverride[],
  pitchMm: number,
): string {
  const transforms = instanceTransforms(profile, pitchMm, 0);
  const header = 'id,component,x_mm,y_mm,z_mm,rx_deg,ry_deg,rz_deg,w_mm,h_mm,d_mm,confidence';
  const rows = profile.instances.map((instance) => {
    const transform = transforms.get(instance.id);
    const position = transform?.positionMm ?? [0, 0, 0];
    const rotation = transform?.rotationDeg ?? [0, 0, 0];
    const { sizeMm, confidence } = resolvedSize(profile, overrides, instance.component);
    const dims = sizeMm.map((axis) => (axis === null ? '' : csvNum(axis)));
    return [instance.id, instance.component, ...position.map(csvNum), ...rotation.map(csvNum), ...dims, confidence].join(',');
  });
  return [header, ...rows].join('\n') + '\n';
}

/**
 * STEP AP214 solid of the assembly envelope — one box, exactly what the
 * profile claims and nothing it does not: internal geometry is not modeled,
 * so exporting it would be invention. The box picks up measured overrides on
 * the shell component the same way the DXF outline does.
 */
export function exportEnvelopeStep(profile: HardwareProfile, overrides: MeasuredOverride[]): string {
  const shell = resolvedSize(profile, overrides, 'enclosure-shell');
  const size: [number, number, number] = [
    shell.sizeMm[0] ?? profile.body.sizeMm[0],
    shell.sizeMm[1] ?? profile.body.sizeMm[1],
    shell.sizeMm[2] ?? profile.body.sizeMm[2],
  ];
  const [w, h, d] = size;
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;

  const lines: string[] = [];
  let next = 0;
  const add = (body: string): number => {
    const id = ++next;
    lines.push(`#${id}=${body};`);
    return id;
  };
  const point = (x: number, y: number, z: number) => add(`CARTESIAN_POINT('',(${x},${y},${z}))`);
  const direction = (x: number, y: number, z: number) => add(`DIRECTION('',(${x},${y},${z}))`);

  // 8 corners; index bit pattern (x, y, z): 0 = negative half, 1 = positive.
  const corner = (ix: number, iy: number, iz: number): [number, number, number] => [
    ix ? hx : -hx,
    iy ? hy : -hy,
    iz ? hz : -hz,
  ];
  const vertexIds: number[] = [];
  const cornerPoints: number[] = [];
  for (let i = 0; i < 8; i++) {
    const p = point(...corner(i & 1, (i >> 1) & 1, (i >> 2) & 1));
    cornerPoints.push(p);
    vertexIds.push(add(`VERTEX_POINT('',#${p})`));
  }

  // 12 edges as vertex-index pairs.
  const edgePairs: Array<[number, number]> = [
    [0, 1], [2, 3], [4, 5], [6, 7], // x-direction
    [0, 2], [1, 3], [4, 6], [5, 7], // y-direction
    [0, 4], [1, 5], [2, 6], [3, 7], // z-direction
  ];
  const edgeIds = edgePairs.map(([a, b]) => {
    const [ax, ay, az] = corner(a & 1, (a >> 1) & 1, (a >> 2) & 1);
    const [bx, by, bz] = corner(b & 1, (b >> 1) & 1, (b >> 2) & 1);
    const length = Math.hypot(bx - ax, by - ay, bz - az) || 1;
    const dir = direction((bx - ax) / length, (by - ay) / length, (bz - az) / length);
    const vector = add(`VECTOR('',#${dir},${length})`);
    const line = add(`LINE('',#${cornerPoints[a]},#${vector})`);
    return add(`EDGE_CURVE('',#${vertexIds[a]},#${vertexIds[b]},#${line},.T.)`);
  });
  const edgeIndex = new Map(edgePairs.map(([a, b], i) => [`${a}-${b}`, i]));
  const oriented = (a: number, b: number): string => {
    const forward = edgeIndex.get(`${a}-${b}`);
    if (forward !== undefined) return `ORIENTED_EDGE('',*,*,#${edgeIds[forward]},.T.)`;
    const reverse = edgeIndex.get(`${b}-${a}`);
    return `ORIENTED_EDGE('',*,*,#${edgeIds[reverse!]},.F.)`;
  };

  // 6 faces: corner loop (outward-ordered) + outward normal.
  const faces: Array<{ loop: [number, number, number, number]; normal: [number, number, number] }> = [
    { loop: [0, 2, 3, 1], normal: [0, 0, -1] }, // z-
    { loop: [4, 5, 7, 6], normal: [0, 0, 1] }, // z+
    { loop: [0, 1, 5, 4], normal: [0, -1, 0] }, // y-
    { loop: [2, 6, 7, 3], normal: [0, 1, 0] }, // y+
    { loop: [0, 4, 6, 2], normal: [-1, 0, 0] }, // x-
    { loop: [1, 3, 7, 5], normal: [1, 0, 0] }, // x+
  ];
  const faceIds = faces.map(({ loop, normal }) => {
    const orientedEdges = loop.map((v, i) => oriented(v, loop[(i + 1) % 4]));
    const loopId = add(`EDGE_LOOP('',(${orientedEdges.map((e) => `#${add(e)}`).join(',')}))`);
    const bound = add(`FACE_OUTER_BOUND('',#${loopId},.T.)`);
    const origin = point(normal[0] * hx, normal[1] * hy, normal[2] * hz);
    const axis = direction(...normal);
    const ref = direction(...(normal[0] !== 0 ? [0, 1, 0] : [1, 0, 0]) as [number, number, number]);
    const placement = add(`AXIS2_PLACEMENT_3D('',#${origin},#${axis},#${ref})`);
    const plane = add(`PLANE('',#${placement})`);
    return add(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`);
  });

  const shellId = add(`CLOSED_SHELL('',(${faceIds.map((f) => `#${f}`).join(',')}))`);
  const brep = add(`MANIFOLD_SOLID_BREP('envelope',#${shellId})`);

  const worldOrigin = point(0, 0, 0);
  const worldZ = direction(0, 0, 1);
  const worldX = direction(1, 0, 0);
  const worldPlacement = add(`AXIS2_PLACEMENT_3D('',#${worldOrigin},#${worldZ},#${worldX})`);

  const mm = add(`( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )`);
  const rad = add(`( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )`);
  const sr = add(`( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )`);
  const uncertainty = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.001),#${mm},'','')`);
  const context = add(
    `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${mm},#${rad},#${sr})) REPRESENTATION_CONTEXT('','3D') )`,
  );
  const representation = add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(#${worldPlacement},#${brep}),#${context})`);

  const app = add(`APPLICATION_CONTEXT('automotive design')`);
  const productContext = add(`PRODUCT_CONTEXT('',#${app},'mechanical')`);
  const product = add(`PRODUCT('kino-d4-envelope','KINO D4 assembly envelope','',(#${productContext}))`);
  const formation = add(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
  const definitionContext = add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`);
  const definition = add(`PRODUCT_DEFINITION('','',#${formation},#${definitionContext})`);
  const definitionShape = add(`PRODUCT_DEFINITION_SHAPE('','',#${definition})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(#${definitionShape},#${representation})`);

  return [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('KINO D4 assembly envelope ${w}x${h}x${d} mm (${shell.confidence}); envelope only, internal geometry not modeled'),'2;1');`,
    `FILE_NAME('kino-d4-envelope.step','',('KINO Twin'),(''),'','','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
  ].join('\n') + '\n';
}
