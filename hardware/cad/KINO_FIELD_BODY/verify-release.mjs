// Independent verification of the RELEASED STLs in this folder.
//
// The generator gates prove the geometry it built. This proves the FILES that go
// to the slicer: every released part is re-imported through Manifold's own
// importer, put back into body coordinates by inverting its print transform,
// and then measured and intersected against the others. Nothing here reads the
// generator's solids or its parameters beyond a handful of datum constants used
// to place probes, so it does not share the gates' assumptions - it caught an
// 870 mm^2 overhang and a gate blind spot that 262 gates walked past.
//
//   node verify-release.mjs          exit 0 = ALL CLEAR, exit 1 = findings
//
// Run it after validate-stl.mjs on every release. It is deliberately a separate
// program from the generator: an independent check that imports the generator
// is not independent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Module from "manifold-3d";

const here = path.dirname(fileURLToPath(import.meta.url));
const wasm = await Module(); wasm.setup();
const { Manifold, Mesh } = wasm;

const out = []; let fails = 0;
const say = (ok, name, detail) => { out.push(`  ${ok ? "ok  " : "FAIL"} ${name}\n        ${detail}`); if (!ok) fails++; };
const vol = (a, b) => a.intersect(b).volume();

// ---- STL -> Manifold ---------------------------------------------------------
// Vertices are welded at 0.1 um, so the importer sees a shared-vertex mesh; a
// file that is not a closed manifold fails Manifold's own status check here.
function loadSTL(name) {
  const b = fs.readFileSync(path.join(here, name));
  const n = b.readUInt32LE(80);
  const key = new Map(); const verts = []; const tris = new Uint32Array(n * 3);
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; let degenerate = 0;
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50; const ids = [];
    for (let k = 0; k < 3; k++) {
      const x = b.readFloatLE(o + 12 + k * 12), y = b.readFloatLE(o + 16 + k * 12), z = b.readFloatLE(o + 20 + k * 12);
      for (const [a, q] of [[0, x], [1, y], [2, z]]) { if (q < lo[a]) lo[a] = q; if (q > hi[a]) hi[a] = q; }
      const kk = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
      let id = key.get(kk); if (id === undefined) { id = verts.length / 3; key.set(kk, id); verts.push(x, y, z); }
      ids.push(id);
    }
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) degenerate++;
    tris.set(ids, i * 3);
  }
  const mesh = new Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: tris });
  mesh.merge();
  const m = new Manifold(mesh);
  return { m, status: m.status(), tris: n, degenerate, dims: [0, 1, 2].map((a) => hi[a] - lo[a]), lo, hi, raw: b };
}

// Datum constants of the design. These place probes; they are not what is
// being verified. If the design moves, they move with it - by hand, on purpose.
const bodyW = 131, bodyH = 90, bodyD = 65.5, plate = 5;
/* The XIAO board's stand-off, stated here the long way round rather than copied
 * as a figure, because it is the term that was wrong on the first printed rig.
 * The camera hangs off the board and the vendor gives the assembled stack's
 * overall height as 15.0 mm from the XIAO's back face to the lens's front face,
 * so the stand-off that lands the lens on the pocket floor is that height, less
 * the 7.6 mm of boards, less the pocket's depth - and the pocket is as deep as
 * the 5 mm plate can give while leaving 1.5 mm to carry the bore. */
const padH = 15.0 - 7.6 - (plate - 1.5);                   // 3.9
const pcbBackZ = plate + padH + 7.6 + 14.0 + 1.4 + 14.6;   // 46.5: the module's PCB back
const splitZ = pcbBackZ - 14.6;                            // 31.9: the cut, at the bay floor
const faceBase = 3, barProud = 6, panelDepth = 2.2;
const floorZ = -(faceBase + barProud) + panelDepth;        // -6.8: the cover's track floor
const coverClosedY0 = 32.8, coverTravel = 21.4, coverH = 20.4;   // the cover drops 21.4 to open
const trackX0 = 21.2, trackX1 = 110.8;                      // the cover track's side walls
const wallY = [6, bodyH - 6];                               // top and bottom walls' inner faces
// doorBite is 1.5, and the slide is a SQUARE-SHOULDERED TONGUE, not a dovetail.
// It was a dovetail at 47 degrees, then at 55, and the angle was never the
// point: the body's retaining surface must face -Z, the rear half prints
// cut-face-down so -Z is DOWN, and a sloped retaining surface therefore always
// begins as an unanchored knife edge. Probed layer by layer, the 47-degree
// ceiling appeared as a 0.11 mm ledge with 1.4 mm of air beside it and nothing
// under it, and grew for eleven layers before it met the wall. A flat shoulder
// appears at its full 1.5 mm width in ONE layer, rooted on the groove's deep
// wall. Every probe below that reaches for a groove or a tongue face is placed
// off this number.
const doorBite = 1.5, doorClr = 0.15, detentBite = 0.15, detentX = 12.0;
const bezelT = 4.0;
const cams = [-1.5, -0.5, 0.5, 1.5].map((i) => bodyW / 2 + i * 22.0), lensY = 43.0;
/* The standoff group: Ø3.5 x 3.3 brass MEASURED, the pattern centre 9.3 mm left
 * of module centre still PROVISIONAL, and the pitch restated by hand here as
 * every datum in this file is. */
/* 61.9 x 54.8 between CENTRES, not the 65.5 x 58.2 that stood here. A caliper
 * reaches edges, not centres, so an edge-to-edge span written into a
 * centre-pitch field is 61.9 + 3.5 = 65.4, rounded to "65.5" - which is exactly
 * what happened, and it moved every post 1.8 mm out to correct a fault that was
 * never there. The printed posts splayed by that amount, and calipers across
 * the standoff edges read 65 x 58: the drawing's pitch, confirmed. */
const holeX = 61.9, holeY = 54.8, standoffH = 3.3, standoffOD = 3.5;
const outsideSpanX = 65.0, outsideSpanY = 58.0;   // MEASURED, edge to edge
/* The brass bottoms on the socket floor and the post rim rises socketDepth
 * above it, so the front half's total height follows from the standoff and is
 * not a number of its own: pcbBackZ - 3.3 + 2.0. It was 44.6 while the standoff
 * was recorded as 3.0 mm tall, and 44.3 while the board's stand-off was. */
const socketDepth = 2.0, postTopZ = pcbBackZ - standoffH + socketDepth;
const mountXs = [bodyW / 2 - 9.3 - holeX / 2, bodyW / 2 - 9.3 + holeX / 2];
const mountYs = [bodyH / 2 - holeY / 2, bodyH / 2 + holeY / 2];
const bolts = [18.0, 92.0].flatMap((x) => [{ x, y: bodyH - 6 - 1.25, wall: "top" }, { x, y: 6 + 1.25, wall: "bottom" }]);
const FRONT_TEXT = "KINO";

// ---- Load, and put back into body coordinates -------------------------------
// Each inverse is the exact undo of the print transform in generate-field-body:
//   front   as-is                          rear    translate +splitZ
//   face    rotate 180 about Y after -bodyW  cover  the same, then +6.6 in Z
//   door    translate (0,-bodyH,-bodyD), rotate 180 about X
const P = {};
const files = {
  front: "print/KINO_FIELD_BODY_FRONT_PRINT.stl", rear: "print/KINO_FIELD_BODY_REAR_PRINT.stl",
  face: "print/KINO_FIELD_FACE_PRINT.stl", slider: "print/KINO_FIELD_LENS_SLIDER.stl", keeper: "print/KINO_FIELD_SLIDER_KEEPER.stl",
  bezel: "print/KINO_FIELD_BEZEL_PRINT.stl",
  clamps: "print/KINO_FIELD_XIAO_CLAMPS.stl", button: "print/KINO_FIELD_SHUTTER_BUTTON.stl",
};
out.push("IMPORT (Manifold's own importer, independent of the validator)");
for (const [k, f] of Object.entries(files)) {
  const L = loadSTL(f); P[k] = L;
  say(L.status === "NoError" && L.degenerate === 0, `${f} imports as a manifold solid`,
    `status ${L.status}, ${L.tris} triangles, ${L.degenerate} degenerate, ${L.dims.map((v) => v.toFixed(2)).join(" x ")} mm`);
}
const front = P.front.m;
const rear = P.rear.m.translate([0, 0, splitZ]);
const face = P.face.m.translate([-bodyW, 0, 0]).rotate([0, 180, 0]);
const sliderClosed = P.slider.m.translate([-bodyW, 0, -floorZ]).rotate([0, 180, 0]);
const sliderOpen = sliderClosed.translate([0, -coverTravel, 0]);
const keeper = P.keeper.m.translate([-bodyW, 0, -floorZ]).rotate([0, 180, 0]);
/* The door prints INNER-face-down now, not outer-face-down, so this inverse is
 * a plain lift back to the door plane instead of a flip about X. It printed the
 * other way up for two versions, and the dovetail's Z-section was upside down
 * for both: the wedge's outermost tip arrived 1.5 mm above the bed with nothing
 * beneath it, 36.9 mm^2 of island along the whole 125 mm of both edges, seeding
 * a 337 mm^2 dovetail out of air. Every overhang gate passed it, here included,
 * because they all asked how steep a downward face was and none asked whether
 * its lowest edge had anything to land on. */
const bezel = P.bezel.m.translate([0, 0, bodyD - bezelT]);

// ---- Frames -------------------------------------------------------------------
out.push("\nFRAMES (print transform inverted; each part must land on its datum)");
const bb = (m) => { const b = m.boundingBox(); return { lo: b.min, hi: b.max }; };
const fb = bb(front), rb = bb(rear), fcb = bb(face), sb = bb(sliderClosed), bz = bb(bezel);
say(Math.abs(fb.lo[2]) < 1e-3 && Math.abs(fb.hi[2] - postTopZ) < 0.05, "front half spans Z 0 .. post tops", `Z ${fb.lo[2].toFixed(2)} .. ${fb.hi[2].toFixed(2)}, against a post rim at ${postTopZ.toFixed(1)} derived from the ${standoffH} mm standoff`);
say(Math.abs(rb.lo[2] - splitZ) < 1e-3 && Math.abs(rb.hi[2] - bodyD) < 0.05, "rear half spans the cut to the rear face", `Z ${rb.lo[2].toFixed(2)} .. ${rb.hi[2].toFixed(2)}`);
say(Math.abs(fcb.hi[2]) < 1e-3 && Math.abs(fcb.lo[2] + 9) < 0.05 && Math.abs(fcb.lo[0]) < 1e-3, "face shell backs onto Z=0 at X=0, relief to -9", `X from ${fcb.lo[0].toFixed(2)}, Z ${fcb.lo[2].toFixed(2)} .. ${fcb.hi[2].toFixed(2)}`);
say(Math.abs(sb.hi[2] - floorZ) < 0.02 && Math.abs(sb.lo[1] - coverClosedY0) < 0.05, "cover sits on the panel floor at its closed position", `back Z ${sb.hi[2].toFixed(2)} (floor ${floorZ.toFixed(1)}), Y ${sb.lo[1].toFixed(1)} .. ${sb.hi[1].toFixed(1)}`);
{
  const kb = bb(keeper);
  say(Math.abs(kb.hi[2] - floorZ) < 0.02 && kb.hi[1] < sliderOpen.boundingBox().min[1] && kb.lo[1] > 3.0, "keeper sits in the rim gap below the open cover", `back Z ${kb.hi[2].toFixed(2)}, Y ${kb.lo[1].toFixed(1)} .. ${kb.hi[1].toFixed(1)} under an open cover starting at ${sliderOpen.boundingBox().min[1].toFixed(1)}`);
  const stop = vol(sliderOpen.translate([0, -1.5, 0]), keeper);
  say(stop > 1.0, "keeper stops the cover at the open end", `${stop.toFixed(1)} mm^3 of keeper in the way of a cover pushed 1.5 mm past open`);
}
say(Math.abs(bz.hi[2] - bodyD) < 0.05 && Math.abs(bz.lo[2] - (bodyD - bezelT)) < 0.05, "door occupies the rear 4 mm", `Z ${bz.lo[2].toFixed(2)} .. ${bz.hi[2].toFixed(2)}`);

// ---- Assembly -----------------------------------------------------------------
out.push("\nASSEMBLY (shipped parts intersected against each other)");
// Parts that rest on each other (the door on its groove floors) share a
// tessellation film of coincident faces. That is not interference, so the test
// is the THICKNESS of the thickest shared piece, not the raw shared volume.
const pairs = [["front", front, "rear", rear], ["face", face, "front", front], ["face", face, "rear", rear],
  ["door", bezel, "rear", rear], ["door", bezel, "front", front], ["cover (closed)", sliderClosed, "face", face],
  ["cover (open)", sliderOpen, "face", face], ["cover (closed)", sliderClosed, "front", front],
  ["keeper", keeper, "face", face], ["keeper", keeper, "cover (open)", sliderOpen]];
for (const [an, a, bn, b] of pairs) {
  const x = a.intersect(b); const v = x.volume(); let thickest = 0;
  if (v > 1e-4) for (const q of x.decompose()) thickest = Math.max(thickest, q.volume() / Math.max(q.surfaceArea() / 2, 1e-9));
  say(thickest < 0.01, `${an} does not penetrate ${bn}`,
    `${v.toFixed(4)} mm^3 shared; thickest shared piece ${thickest.toExponential(1)} mm${v > 1e-4 ? " (coincident-face film)" : ""}`);
}
{
  const v1 = vol(sliderClosed.translate([0, 0, -0.7]), face), v2 = vol(sliderOpen.translate([0, 0, -0.7]), face);
  say(v1 > 0.5 && v2 > 0.5, "cover is retained by the lips at both positions", `${v1.toFixed(2)} / ${v2.toFixed(2)} mm^3 of engagement at a 0.7 mm pull`);
}
for (const b of bolts) {
  const ann = Manifold.cylinder(2.7, 2.2, 2.2, 48).translate([b.x, b.y, splitZ + 0.1])
    .subtract(Manifold.cylinder(3, 1.3, 1.3, 48).translate([b.x, b.y, splitZ]));
  const inF = vol(front, ann) / ann.volume(), inR = vol(rear, ann);
  say(inF > 0.95 && inR < 1e-3, `joint ${b.wall} X=${b.x}: peg on the front, socket on the rear`, `${(100 * inF).toFixed(0)}% peg, ${inR.toFixed(4)} mm^3 of rear in the socket`);
  const floorZb = splitZ + 12 - 3, doorZ = bodyD - bezelT;
  const head = Manifold.cylinder(doorZ - floorZb - 0.2, 2.35, 2.35, 32).translate([b.x, b.y, floorZb + 0.1]);
  say(vol(rear, head) < 1e-3, `joint ${b.wall} X=${b.x}: M2.5 head has a clear path from the door to its pocket`, `${vol(rear, head).toFixed(4)} mm^3 in the way`);
}
{
  const mod = Manifold.cube([117.01, 69.41, 13.8]).translate([bodyW / 2 - 117.01 / 2, bodyH / 2 - 69.41 / 2, pcbBackZ]);
  say(vol(mod, front) < 1e-2 && vol(mod, rear) < 1e-2, "P4 module envelope is clear of both halves", `${vol(mod, front).toFixed(4)} / ${vol(mod, rear).toFixed(4)} mm^3`);
  // The brass is Ø3.5 x 3.0 (measured again by the maintainer; an earlier 5.4
  // stood here). Probe 0.1 under, standing in the socket, and a Ø3.7 must be
  // met by the socket wall near the floor: the cone closes on the brass.
  /* The brass stands standoffH out of the PCB back, so its free end - and the
   * socket floor that has to meet it - sits at pcbBackZ - standoffH. */
  const floorZ4 = pcbBackZ - standoffH;
  let worst = 0, grip = 1; for (const x of mountXs) for (const y of mountYs) {
    worst = Math.max(worst, vol(front, Manifold.cylinder(standoffH - 0.2, standoffOD / 2 - 0.05, standoffOD / 2 - 0.05, 48).translate([x, y, floorZ4 + 0.1])));
    grip = Math.min(grip, vol(front, Manifold.cylinder(0.3, standoffOD / 2 + 0.1, standoffOD / 2 + 0.1, 48).translate([x, y, floorZ4 + 0.05])));
  }
  say(worst < 1e-3 && grip > 1e-3, "four brass standoffs drop into their sockets and are gripped at the floor", `${worst.toFixed(4)} mm^3 of front half inside the worst Ø${(standoffOD - 0.1).toFixed(1)} x ${(standoffH - 0.2).toFixed(1)} standoff standing on the socket floor at Z=${floorZ4.toFixed(1)}; a Ø${(standoffOD + 0.2).toFixed(1)} meets ${grip.toFixed(3)} mm^3 of wall in its first 0.3 mm`);

  /*
   * Getting the module back OUT.
   *
   * It goes in from the rear and is held down by foam on the door, so with the
   * door off the only grip on it is its own long edges - there is no lift tab,
   * no push-through from the front, and the bay under it is behind the board.
   * The strip beside each long edge is therefore a real feature and not
   * leftover space, and it is exactly the kind of thing a later boss or rib
   * fills in without anybody noticing. 4 mm deep and 40 mm long is two
   * fingernails.
   */
  const modY0 = bodyH / 2 - 69.41 / 2, modY1 = bodyH / 2 + 69.41 / 2;
  let worstRun = 1e9;
  const runs = [];
  for (const [name, y0] of [["bottom", 6.0], ["top", modY1]]) {
    const depth = (name === "bottom" ? modY0 - 6.0 : bodyH - 6.0 - modY1);
    let best = 0, run = 0;
    for (let x = 6; x < bodyW - 11; x += 5) {
      const box = Manifold.cube([5, depth, 13.8]).translate([x, y0, pcbBackZ]);
      if (vol(front, box) + vol(rear, box) < 1e-3) { run += 5; if (run > best) best = run; }
      else run = 0;
    }
    if (best < worstRun) worstRun = best;
    runs.push(`${name} ${depth.toFixed(1)} mm deep, ${best} mm clear`);
  }
  say(worstRun >= 40, "a fingernail can reach the module's edge to lift it out", `${runs.join("; ")} - nothing but the walls stands in either strip`);
}

// ---- Optics -------------------------------------------------------------------
out.push("\nOPTICS (bores and cells located by slicing the shipped meshes)");
const loops = (m, z, dmin, dmax) => m.slice(z).toPolygons().map((poly) => {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  return { w, h, cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2 };
}).filter((l) => l.w > dmin && l.w < dmax && l.h > dmin && l.h < dmax).sort((a, b) => a.cx - b.cx);
/* The Hall switch that used to read the cover's position is gone - firmware
 * reads it off the four sensors instead - so the front plate's only openings
 * are the four bores, the shell's back is unbroken, and the cover's back
 * carries no magnet pocket. Checked as an ABSENCE on the shipped meshes,
 * because a removal that half-happens is worse than either state: a blind
 * pocket nobody fills is a void in a permanent glue joint, and a Ø2.4 hole
 * nobody threads a lead through is an unexplained opening in the plate. The
 * coordinates below are where the parts used to be; they are datums now. */
{
  const cyl = (x, y, z, d, h) => Manifold.cylinder(h, d / 2, d / 2, 32).translate([x, y, z]);
  const at = [107.5, 36.0];
  const cases = [
    ["front plate, Hall lead hole at (107.5, 20.0)", front, cyl(107.5, 20.0, 0.2, 2.4, plate - 0.4)],
    ["face shell back, Ø4.5 x 5.5 sensor pocket", face, cyl(at[0], at[1], -5.5, 4.5, 5.5)],
    ["face shell back, 2.5 x 1.75 lead channel", face,
     Manifold.cube([2.5, at[1] - 20.0, 1.75]).translate([at[0] - 1.25, 20.0, -1.75])],
    ["cover back, Ø3.2 x 1.1 magnet pocket", sliderClosed, cyl(at[0], at[1], floorZ - 1.1, 3.2, 1.1)],
  ];
  let ok = true; const read = [];
  for (const [name, part, probe] of cases) {
    const frac = vol(part, probe) / probe.volume();
    ok = ok && frac > 0.99;
    read.push(`${name} ${(100 * frac).toFixed(1)}%`);
  }
  say(ok, "no Hall switch, lead path or magnet pocket survives anywhere", read.join("; "));
}
// Z=1.2 is inside the bore-only zone; from Z 2.4 up the plate carries the
// 8.65 mm camera pockets and a slice there sees squares, not the bores.
const bores = loops(front, 1.2, 6.6, 7.6);
say(bores.length === 4, "front half has exactly four lens bores at Z=1.2", `${bores.length} loops of Ø6.6..7.6: ${bores.map((l) => `(${l.cx.toFixed(2)}, ${l.cy.toFixed(2)}) Ø${l.w.toFixed(2)}`).join("  ")}`);
if (bores.length === 4) {
  const pitches = [1, 2, 3].map((i) => bores[i].cx - bores[i - 1].cx);
  say(pitches.every((p) => Math.abs(p - 22.0) < 0.03), "lens pitch is 22.00 mm", `pitches ${pitches.map((p) => p.toFixed(3)).join(", ")} mm`);
  say(bores.every((l) => Math.abs(l.cy - lensY) < 0.03), "bores are collinear on Y=43", `Y ${bores.map((l) => l.cy.toFixed(3)).join(", ")}`);
  say(bores.every((l) => Math.abs(l.w - 7.1) < 0.06 && Math.abs(l.h - 7.1) < 0.06), "bores are Ø7.10 (guiding fit on a Ø7.0 barrel)", `Ø ${bores.map((l) => l.w.toFixed(3)).join(", ")}`);
}
const cells = loops(face, -4.0, 7.0, 20.0);
say(cells.length === 4, "face shell has four cell cones at Z=-4", `${cells.length} loops: ${cells.map((l) => `(${l.cx.toFixed(2)}, ${l.cy.toFixed(2)}) Ø${l.w.toFixed(1)}`).join("  ")}`);
if (bores.length === 4 && cells.length === 4) {
  const off = bores.map((b, i) => Math.hypot(b.cx - cells[i].cx, b.cy - cells[i].cy));
  say(off.every((o) => o < 0.05), "face cells are coaxial with the body bores", `offsets ${off.map((o) => o.toFixed(3)).join(", ")} mm`);
}
for (const cx of cams) {
  const rod = Manifold.cylinder(14.4, 3.45, 3.45, 48).translate([cx, lensY, -9.2]);
  const blocked = vol(rod, face) + vol(rod, front) + vol(rod, sliderOpen);
  say(blocked < 1e-3, `clear line of sight through lens at X=${cx}`, `${blocked.toFixed(4)} mm^3 of face, front or open cover inside a Ø6.9 rod`);
}
{
  let minCov = 1;
  for (const cx of cams) { const disc = Manifold.cylinder(1.2, 9.0, 9.0, 64).translate([cx, lensY, floorZ - 1.6]); minCov = Math.min(minCov, vol(sliderClosed, disc) / disc.volume()); }
  say(minCov > 0.999, "closed cover blanks every cell", `${(100 * minCov).toFixed(1)}% of the weakest Ø18 disc is cover`);
}

// ---- Detents, probed with needles on the shipped files ----------------------
// A 0.15 mm bite on a Ø1.2 bump is 0.04 mm^3 - the size of a resting film - so
// no volume can prove a detent. A needle at the bump's tip can: it is either
// inside the part that should carry the bump, or it is not.
out.push("\nDETENTS (needle probes at the bump tips)");
{
  const doorZ0 = bodyD - bezelT;
  const needle = (x, y, z) => Manifold.cylinder(0.3, 0.04, 0.04, 12).translate([x, y, z - 0.15]);
  for (const [i, side] of [[0, -1], [1, 1]]) {
    const deep = wallY[i] + side * doorBite;
    const tipY = deep - side * (doorClr + detentBite - 0.03);
    const n = needle(detentX, tipY, doorZ0 + 1.4);
    const inBump = vol(rear, n) > 1e-6, inDimple = vol(bezel, n) < 1e-9;
    const onCrest = vol(bezel.translate([-1.5, 0, 0]), n) > 1e-6, inRelief = vol(bezel.translate([-20, 0, 0]), n) < 1e-9;
    say(inBump && inDimple && onCrest && inRelief, `door detent, ${side < 0 ? "bottom" : "top"} wall: bump, dimple, crest, relief`,
      `wall bump at X ${detentX} stands ${(doorClr + detentBite).toFixed(2)} into the groove: bump ${inBump ? "present" : "MISSING"}, seated dimple ${inDimple ? "open" : "BLOCKED"}, crest 1.5 mm off seat ${onCrest ? "bites" : "MISSES"}, channel 20 mm off ${inRelief ? "free" : "RUBS"}`);
  }
  // The cover's detent: one pair of wall bumps at the boundary between the two
  // positions, standing 0.25 proud of the track walls (0.1 clearance + 0.15).
  const holdY = coverClosedY0 - (coverTravel - coverH) / 2, bz = floorZ - 0.5;
  const nearL = needle(trackX0 + 0.12, holdY, bz), farL = needle(trackX0 + 0.35, holdY, bz);
  const nearR = needle(trackX1 - 0.12, holdY, bz), farR = needle(trackX1 - 0.35, holdY, bz);
  say(vol(face, nearL) > 1e-6 && vol(face, nearR) > 1e-6 && vol(face, farL) < 1e-9 && vol(face, farR) < 1e-9,
    `cover detent ribs stand 0.25 mm off both track walls at Y ${holdY.toFixed(2)}`,
    `needles 0.12 in from each wall are inside the face, needles 0.35 in are in air: the ribs bite the cover's edge by 0.15 past its 0.1 clearance, and only there`);
  // And the cover really does click: shifted 1.0 down from closed its end
  // crest is on the ribs, shifted 1.0 up from open likewise, and halfway along
  // the travel the ribs ride the relief in its edges and nothing touches.
  const downHit = vol(sliderClosed.translate([0, -1.0, 0]), face), upHit = vol(sliderOpen.translate([0, 1.0, 0]), face);
  const midHit = vol(sliderClosed.translate([0, -coverTravel / 2, 0]), face);
  say(downHit > 1e-4 && upHit > 1e-4, "cover's edge crests meet the detent leaving either position",
    `${downHit.toFixed(4)} mm^3 of rib in the way 1.0 mm below closed, ${upHit.toFixed(4)} mm^3 1.0 mm above open`);
  say(midHit < 1e-3, "cover slides free between the crests",
    `${midHit.toFixed(4)} mm^3 shared with the face halfway along the travel`);
}

// ---- Thin features ---------------------------------------------------------------
// Anything narrower than two nozzle lines (0.9 mm) in plan prints as one bead
// or not at all. Each camera part is sliced every millimetre in its print frame;
// each slice is eroded by 0.45 and re-dilated, and what does not come back is
// thinner than 0.9. A 45-degree slope shows up thin in the one slice near its
// tip and every dovetail here has one, so a region only counts as a WALL if
// the same footprint is thin in three consecutive slices - 2 mm of height. The
// first run of this scan, before that rule, found a real one: the cover
// track's lips stood 0.8 mm free over the accent groove behind them.
out.push("\nTHIN FEATURES (plan features under 0.9 mm persisting over 2 mm of height, per part, in the print frame)");
{
  const intended = { slider: "wordmark strokes (0.46 min, 0.6 tall), bevel tips", face: "lip and cell-cone tips",
    front: "camera-pocket pinch ribs (0.2 proud, 2.6 tall)", rear: "door groove shoulders, detent ribs (0.3 proud, 1.5 tall)",
    bezel: "wedge tips, window bevel edge", keeper: "chamfer edge", clamps: "arm edges", button: "flange edge" };
  for (const k of Object.keys(files)) {
    const L = P[k]; const m = L.m; const zTop = L.dims[2];
    let worst = 0, worstZ = 0, worstBox = null, total = 0, slices = 0; const prev = [];
    for (let z = 0.3; z < zTop - 0.2; z += 1.0) {
      const cs = m.slice(z); if (cs.isEmpty()) { prev.length = 0; continue; } slices++;
      const thin = cs.subtract(cs.offset(-0.45, "Round", 2, 16).offset(0.45, "Round", 2, 16));
      total += thin.area();
      prev.push(thin); if (prev.length > 3) prev.shift();
      if (prev.length === 3) {
        const wall = prev[0].intersect(prev[1]).intersect(prev[2]);
        if (wall.area() > 1e-3) for (const piece of wall.decompose()) { const pa = piece.area(); if (pa > worst) { worst = pa; worstZ = z; worstBox = piece.bounds(); } }
      }
    }
    say(worst < 3.0, `${k}: no wall thinner than 0.9 mm`,
      `${slices} slices; ${total.toFixed(1)} mm^2 of sub-0.9 plan features in all (tapers included); largest region thin through three slices ${worst.toFixed(2)} mm^2, ending at Z ${worstZ.toFixed(1)}` +
      (worstBox ? ` (X ${worstBox.min[0].toFixed(1)}..${worstBox.max[0].toFixed(1)}, Y ${worstBox.min[1].toFixed(1)}..${worstBox.max[1].toFixed(1)})` : "") +
      `; intended thin features: ${intended[k] || "none"}`);
  }
}

// ---- Every released file fits the bed on its own ---------------------------------
out.push("\nBED (every released file, 250 x 210, either way round)");
{
  const all = ["print", "plates", "coupons"].flatMap((d) =>
    fs.readdirSync(path.join(here, d)).filter((f) => f.endsWith(".stl")).sort().map((f) => `${d}/${f}`));
  const bad = [];
  for (const f of all) {
    const L = loadSTL(f); const [w, d, hgt] = L.dims;
    const fits = (w <= 250 && d <= 210) || (d <= 250 && w <= 210);
    const flat = Math.abs(L.lo[2]) < 1e-3;
    if (!fits || !flat) bad.push(`${f}: ${w.toFixed(0)} x ${d.toFixed(0)} x ${hgt.toFixed(0)}${flat ? "" : `, Z starts at ${L.lo[2].toFixed(2)}`}`);
  }
  // 21 files: the shutter coupon joined the set. The shutter is the only thing
  // a user operates besides the cover and the door, and it was the only one of
  // the three with no coupon - so every fit in it between a printed part and a
  // bought 6 x 6 x 4.3 mm switch was going to be first tried on the camera.
  say(bad.length === 0 && all.length === 21, "all 21 released files sit at Z=0 and fit the bed",
    bad.length ? bad.join("; ") : `${all.length} files, every one with its base on Z=0 and inside 250 x 210`);
}

// ---- Finish: the seam, the grain, the marks, the lug -------------------------
// All of this was added after the scan last grew, so until now it was proved
// only by the generator's own gates - which is the arrangement this program
// exists to distrust.
out.push("\nFINISH (seam, grain and marks, measured on the shipped halves)");
{
  const chamfer = 0.6, rise = 0.6 * Math.tan((50 * Math.PI) / 180); /* 50 degrees */
  const probe = (x, y, w, h, z) => Manifold.cube([w, h, 0.1]).translate([x, y, z - 0.05]);
  /* 0.05 to 0.25 mm inside each outer face: inside the 0.43 mm the V has taken
   * 0.2 from the cut plane, and well inside plain wall two rises away. */
  const faces = [
    ["bottom", 60.5, 0.05, 10, 0.2],
    ["top", 60.5, bodyH - 0.25, 10, 0.2],
    ["left", 0.05, 40, 0.2, 10],
    ["right", bodyW - 0.25, 40, 0.2, 10],
  ];
  let ok = true;
  const notes = [];
  for (const [name, x, y, w, h] of faces) {
    const floor = 0.5 * w * h * 0.1;
    const fAir = vol(front, probe(x, y, w, h, splitZ - 0.2)) < 1e-6;
    const rAir = vol(rear, probe(x, y, w, h, splitZ + 0.2)) < 1e-6;
    const fSolid = vol(front, probe(x, y, w, h, splitZ - 2 * rise)) > floor;
    const rSolid = vol(rear, probe(x, y, w, h, splitZ + 2 * rise)) > floor;
    ok = ok && fAir && rAir && fSolid && rSolid;
    notes.push(`${name} ${fAir && rAir ? "grooved both sides" : "NOT GROOVED"}` +
               (fSolid && rSolid ? "" : ", wall missing below"));
  }
  say(ok, "the split seam runs in a V-groove on all four faces of both halves",
      `${chamfer} mm deep and ${(2 * rise).toFixed(2)} mm tall at the cut plane Z=${splitZ} - ${notes.join("; ")}`);
}
{
  /* The plate's outer face is at Z=-3 in body coordinates; the grain takes the
   * top 0.2 of it. The sample sits above the lens bar and left of the serial,
   * the land between the R3 edge round and where the grain is allowed to start. */
  const zs = -3, t = 0.16, area = (w, h) => w * h * t;
  const sample = Manifold.cube([20, 12, t]).translate([20, 70, zs + 0.02]);
  const land = Manifold.cube([0.8, 10, t]).translate([3.0, 40, zs + 0.02]);
  const frac = vol(face, sample) / area(20, 12);
  const landFrac = vol(face, land) / area(0.8, 10);
  say(frac > 0.60 && frac < 0.78 && landFrac > 0.995,
      "the face plate carries its grain, and keeps a clean land at the outline",
      `${(100 * (1 - frac)).toFixed(0)}% of the plate's top 0.2 mm removed over a 20 x 12 mm sample, against 31% for 0.5 mm grooves on a 1.6 mm pitch; the border land is ${(100 * landFrac).toFixed(1)}% solid`);
}
{
  /* One digit engraved into the plate's inner face above each camera station.
   * Partly cut, not fully and not at all: a through hole would read as 0% and
   * a missing digit as 100%. */
  let ok = true;
  const seen = [];
  for (const [i, cx] of cams.entries()) {
    const box = Manifold.cube([6, 5, 0.3]).translate([cx - 3, 61.5, 4.65]);
    const frac = vol(front, box) / (6 * 5 * 0.3);
    ok = ok && frac > 0.6 && frac < 0.98;
    seen.push(`${i + 1} ${(100 * (1 - frac)).toFixed(1)}%`);
  }
  say(ok, "the plate is numbered 1 to 4, one digit above each camera station",
      `share of a 6 x 5 mm patch cut away at each: ${seen.join(", ")}`);
}
{
  /* The spec line, against a plain band of the same wall - which is what tells
   * "engraved" apart from "this whole face is missing".
   *
   * The reference band used to sit 7 mm lower down, on the assumption that any
   * other piece of that wall is plain. Since the walls are fluted it is not:
   * 7 mm below reads 13% cut, which is the flutes doing their job. The plain
   * reference has to come from inside the lettering's own LAND - the 2 mm the
   * flutes are held off every engraving - so Z 21.0, between the spec line's
   * glyph tops at 20.0 and the serial's land below at 20.7. */
  const band = (z0) => Manifold.cube([30, 0.3, 3.7]).translate([50, 0, z0]);
  const spec = vol(front, band(16.5)) / (30 * 0.3 * 3.7);
  const thin = Manifold.cube([30, 0.3, 0.3]).translate([50, 0, 21.0]);
  const plain = vol(front, thin) / (30 * 0.3 * 0.3);
  say(spec < 0.99 && plain > 0.995, "the front half's bottom carries the spec line over plain wall",
      `${(100 * (1 - spec)).toFixed(1)}% of the lettering band is cut, against ${(100 * (1 - plain)).toFixed(1)}% of the plain land at Z 21 between the spec line and the serial`);
}
{
  /* The strap anchor stands on the cut plane, so it belongs to the rear half
   * and to nothing else - an anchor on the front half would print into open
   * air. It is on the -X wall now, not the +X wall: the shutter is at X 115, so
   * a right hand wraps the +X end and the palm covered most of that wall, which
   * is where a 4.5 mm proud block with a cord hole used to sit. Restated by
   * hand here, as every datum in this file is.
   *
   * The bore is 1.5 mm inboard of the lug's outer face, and BOTH walls of it
   * are probed, because the version this replaces had 0.5 mm - one bead -
   * between the cord and the outside, and nothing checked it. */
  const proud = 2 * 1.5 + 3.5;                    // wall + cord + wall = 6.5
  const boreX = -(1.5 + 3.5 / 2);                 // -3.25
  const lugBox = Manifold.cube([proud, 10, 8]).translate([-proud, 66, splitZ]);
  const cord = Manifold.cylinder(8.4, 1.6, 1.6, 32).translate([boreX, 71, splitZ - 0.2]);
  const onRear = vol(rear, lugBox), onFront = vol(front, lugBox);
  const open = vol(rear, cord) < 1e-6;
  const wall = (x0) => Manifold.cube([0.9, 1.2, 6]).translate([x0, 70.4, splitZ + 1]);
  const outboard = vol(rear, wall(-proud + 0.3)) / (0.9 * 1.2 * 6);
  const inboard = vol(rear, wall(boreX + 3.5 / 2 + 0.3)) / (0.9 * 1.2 * 6);
  say(onRear > 200 && onFront < 1e-6 && open && outboard > 0.9 && inboard > 0.9,
      "the strap anchor is on the rear half alone, walled both sides of an open cord hole",
      `${onRear.toFixed(0)} mm^3 of lug beyond the -X wall on the rear and ${onFront.toFixed(4)} on the front; the Ø3.5 cord hole is ${open ? "open" : "BLOCKED"}, with ${(100 * outboard).toFixed(0)}% solid outboard of it and ${(100 * inboard).toFixed(0)}% inboard`);
  /* And it has to be off the grip: the shutter names the end the right hand
   * wraps, and the anchor must be on the other one. */
  say((115.0 > bodyW / 2) !== (-proud / 2 > bodyW / 2),
      "the strap anchor is not on the wall the shooting hand grips",
      `shutter at X 115 puts the grip on the +X end; the anchor sits at X ${boreX.toFixed(2)} on the -X wall`);
}

// ---- The bed jobs against the parts they are made of --------------------------
// A plate that has drifted from its singles is the worst kind of wrong: both
// files validate, and the one you actually load in the slicer is not the one
// the rest of this program measured.
out.push("\nPLATES (each bed job against the released parts in it)");
{
  const jobs = [
    ["plate 1", "plates/KINO_PLATE_1_CHASSIS.stl", 2,
     ["print/KINO_FIELD_BODY_FRONT_PRINT.stl", "print/KINO_FIELD_BODY_REAR_PRINT.stl"]],
    ["plate 2", "plates/KINO_PLATE_2_FACE_DOOR_COVER.stl", 10,
     ["print/KINO_FIELD_FACE_PRINT.stl", "print/KINO_FIELD_BEZEL_PRINT.stl",
      "print/KINO_FIELD_LENS_SLIDER.stl", "print/KINO_FIELD_SLIDER_KEEPER.stl",
      "print/KINO_FIELD_XIAO_CLAMPS.stl", "print/KINO_FIELD_SHUTTER_BUTTON.stl"]],
  ];
  /* The drift a correct plate still shows. An STL is float32, so every
   * coordinate is quantised - about 1.2e-5 mm at 200 mm - and this comparison
   * round-trips three meshes through that: the plate's file, each part's file,
   * and the 0.1 um weld the importer above does to all of them. The volume a
   * quantised surface loses goes as its AREA, not its size, so the bound is
   * area x quantum, once per mesh in the comparison.
   *
   * It used to be a flat 0.5 mm^3, which was true of a smooth chassis and
   * stopped being true the moment the walls were fluted: 530 V-grooves add
   * about 15,000 mm^2 of surface across plate 1, and the same correct plate
   * then reads 1.09 mm^3 apart. A tolerance that has to be raised every time
   * the part gains detail is not measuring what it claims to. */
  const q = 1.2e-5;
  for (const [name, plateFile, parts, partFiles] of jobs) {
    const L = loadSTL(plateFile);
    let sum = 0, area = L.m.surfaceArea();
    for (const f of partFiles) { const p = loadSTL(f).m; sum += p.volume(); area += p.surfaceArea(); }
    const v = L.m.volume();
    const n = L.m.decompose().length;
    const drift = Math.abs(v - sum);
    const tol = Math.max(0.5, 2 * q * area);
    say(drift < tol && n === parts, `${name} is the released parts, only moved`,
        `${(v / 1000).toFixed(2)} cm^3 on the plate against ${(sum / 1000).toFixed(2)} in its ${partFiles.length} files, ${drift.toFixed(4)} mm^3 apart against ${tol.toFixed(4)} allowed for float32 over ${area.toFixed(0)} mm^2; ${n} separate parts of ${parts}`);
  }
}

// ---- Lettering direction, on the file as printed ---------------------------
out.push("\nWORDMARK (the cover as it will be printed: slicer top view = subject's view)");
{
  // The cover carries the KINO D4 wordmark as a raised bitmap traced by
  // brand/trace-mark.py. The trace records how much ink sits in its left and
  // right thirds (the "k" end is heavier than the boxed D4); the print-frame
  // slice must show the same imbalance the same way round. Sliced 0.3 above the
  // 2.0 mm plate: the thumb ridge is higher and outside the mark's band anyway.
  const mark = JSON.parse(fs.readFileSync(path.join(here, "brand", "kino-d4-mark.json"), "utf8"));
  const w = mark.widthMm, h = mark.heightMm, third = w / 3;
  // The band the mark is centred in: from the thumb ridge's top (ridge bottom
  // edge 34.3, 1.6 tall, 0.6 gap) to 1.0 under the closed cover's top edge
  // (32.8 + 20.4). These moved when the cover was turned over; they are the
  // design's numbers, restated here by hand on purpose.
  const ridgeTop = coverClosedY0 + 1.5 + 1.6, bandY0 = ridgeTop + 0.6, bandY1 = coverClosedY0 + 20.4 - 1.0;
  const yB = bandY0 + (bandY1 - bandY0 - h) / 2;
  const xCp = bodyW - (trackX0 + trackX1) / 2;   // panel centre, mirrored into the print frame
  const cs = P.slider.m.slice(2.0 + 0.3);
  const band = (x0) => cs.intersect(wasm.CrossSection.square([third, h + 0.2], false).translate([x0, yB - 0.1])).area();
  const left = band(xCp - w / 2), right = band(xCp + w / 2 - third);
  const srcRatio = mark.inkLeftThird / mark.inkRightThird, gotRatio = left / Math.max(right, 1e-9);
  say((left > right) === (mark.inkLeftThird > mark.inkRightThird) && Math.abs(gotRatio - srcRatio) < 0.35 * srcRatio,
    "wordmark reads the right way round in the print file",
    `left third ${left.toFixed(0)} mm^2 vs right third ${right.toFixed(0)} mm^2 (ratio ${gotRatio.toFixed(2)}); trace ${mark.inkLeftThird} vs ${mark.inkRightThird} cells (ratio ${srcRatio.toFixed(2)}) - the print transform is a rotation, so this is also the subject's view`);
}

// ---- Print readiness ----------------------------------------------------------
out.push("\nPRINT (each part as shipped, on its own bed)");
// Downward faces steeper than 45 degrees are grouped into coplanar regions and
// judged by SPAN - the smaller side of the region's footprint - not by facet
// area. Facet area depends on how the mesher happened to triangulate a flat
// ceiling (simplify() turns a Ø4.5 pocket ceiling into one 12 mm^2 triangle),
// while span is what decides whether a ceiling bridges: under 5 mm it does,
// as every socket and pocket ceiling in this camera does. The door's window
// bevel that this scan first caught was a ring 105 x 61 mm - span 61.
function printScan(name) {
  const L = P[name]; const b = L.raw; const n = b.readUInt32LE(80);
  let bed = 0, over = 0, at45 = 0; const zmin = L.lo[2]; const downs = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50; const v = [0, 1, 2].map((k) => [0, 1, 2].map((a) => b.readFloatLE(o + 12 + k * 12 + a * 4)));
    const u = [0, 1, 2].map((a) => v[1][a] - v[0][a]), w = [0, 1, 2].map((a) => v[2][a] - v[0][a]);
    const c = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]; const m = Math.hypot(...c); if (m < 1e-12) continue;
    const nz = c[2] / m, area = m / 2;
    // Bed contact is a triangle lying IN the bed plane, not one that touches it.
    if (v.every((p) => p[2] <= zmin + 0.05)) { bed += area; continue; }
    if (nz < -0.7072) {
      over += area;
      const xs = v.map((p) => p[0]), ys = v.map((p) => p[1]), zs = v.map((p) => p[2]);
      downs.push({ area, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), z: (zs[0] + zs[1] + zs[2]) / 3 });
    } else if (nz < -0.68) at45 += area;
  }
  // Cluster: same height within 0.3 mm and footprints touching within 0.3 mm.
  const regions = [];
  for (const t of downs) {
    let r = regions.find((q) => Math.abs(q.z - t.z) < 0.3 && t.x0 <= q.x1 + 0.3 && t.x1 >= q.x0 - 0.3 && t.y0 <= q.y1 + 0.3 && t.y1 >= q.y0 - 0.3);
    if (!r) { regions.push({ ...t }); continue; }
    r.area += t.area; r.x0 = Math.min(r.x0, t.x0); r.x1 = Math.max(r.x1, t.x1); r.y0 = Math.min(r.y0, t.y0); r.y1 = Math.max(r.y1, t.y1);
  }
  let span = 0, spanRegion = null;
  for (const r of regions) { const s = Math.min(r.x1 - r.x0, r.y1 - r.y0); if (s > span) { span = s; spanRegion = r; } }
  return { bed, over, at45, span, spanRegion, regions: regions.length, h: L.dims[2], foot: L.dims[0] * L.dims[1] };
}
/* The rear half gets 700 mm^2 where every other part gets 400, and it is a
 * budget rather than a relaxation. The door slide's shoulder is a FLAT ledge on
 * purpose - 1.5 x 118 mm on each wall, about 354 mm^2 of horizontal ceiling -
 * because a flat shoulder appears at full width in one layer, rooted on the
 * groove's deep wall, while the 47-degree cantilever it replaced grew from a
 * knife edge in mid-air: measured layer by layer, a 0.11 mm ledge with 1.4 mm
 * of air beside it and nothing under it, growing for eleven layers before it
 * met the wall. By ANGLE the flat ledge looks worse, which is why the span test
 * below and the generator's layer gate are what actually judge these parts. */
const OVER_BUDGET = { rear: 700 };
for (const k of Object.keys(files)) {
  const s = printScan(k);
  say(s.over < (OVER_BUDGET[k] ?? 400) && s.span <= 5.0 && s.bed > 0.15 * s.foot, `${k}: prints flat, support-free`,
    `${s.h.toFixed(1)} mm tall, first layer ${s.bed.toFixed(0)} mm^2 (${(100 * s.bed / s.foot).toFixed(0)}% of footprint), >45deg downward ${s.over.toFixed(1)} mm^2 in ${s.regions} regions, widest ceiling span ${s.span.toFixed(2)} mm` +
    (s.spanRegion ? ` at X ${s.spanRegion.x0.toFixed(1)}..${s.spanRegion.x1.toFixed(1)} Y ${s.spanRegion.y0.toFixed(1)}..${s.spanRegion.y1.toFixed(1)}` : "") + ` (bridges under 5 mm), at-45 ${s.at45.toFixed(0)} mm^2`);
}
{
  const fit = (w, d) => w <= 250 && d <= 210;
  const j1 = [Math.max(P.front.dims[0], P.rear.dims[0]), P.front.dims[1] + 6 + P.rear.dims[1]], j2 = [P.face.dims[0] + 6 + P.slider.dims[0], P.face.dims[1] + 6 + P.bezel.dims[1]];
  say(fit(...j1), "job 1 fits a 250 x 210 bed: front + rear stacked", `${j1[0].toFixed(0)} x ${j1[1].toFixed(1)}`);
  say(fit(...j2), "job 2 fits the bed: face + door stacked, cover beside", `${j2[0].toFixed(0)} x ${j2[1].toFixed(1)}`);
}

console.log(out.join("\n"));
const n = out.filter((l) => /^  (ok|FAIL)/.test(l)).length;
console.log(`\n${fails === 0 ? "ALL CLEAR" : fails + " FINDING(S)"} - ${n} independent checks on the released files`);
process.exit(fails ? 1 : 0);
