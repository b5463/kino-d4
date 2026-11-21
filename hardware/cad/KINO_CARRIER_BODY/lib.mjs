// Shared primitives for the carrier body package: manifold setup, solids,
// the STL writer and the overhang measure. Body frame throughout: X right and
// Y up as the camera is seen from the front, Z toward the viewer.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Module from "manifold-3d";

export const wasm = await Module();
wasm.setup();
export const { Manifold, CrossSection } = wasm;

export const cube = (x, y, z, w, d, h) => {
  if (![x, y, z, w, d, h].every(Number.isFinite) || w <= 0 || d <= 0 || h <= 0) {
    throw new Error(`cube(${[x, y, z, w, d, h].join(", ")}) is not a real box`);
  }
  return Manifold.cube([w, d, h]).translate([x, y, z]);
};
export const box = (x0, y0, z0, x1, y1, z1) => cube(x0, y0, z0, x1 - x0, y1 - y0, z1 - z0);
export const cylZ = (cx, cy, z, r, h, seg = 64) => Manifold.cylinder(h, r, r, seg).translate([cx, cy, z]);
export const coneZ = (cx, cy, z, r0, r1, h, seg = 64) => Manifold.cylinder(h, r0, r1, seg).translate([cx, cy, z]);
export const cylY = (cx, y, cz, r, len, seg = 64) => Manifold.cylinder(len, r, r, seg).rotate([-90, 0, 0]).translate([cx, y, cz]);
export const fuse = (list) => Manifold.union(list);
export const vol = (a, b) => a.intersect(b).volume();
// A box with rounded vertical edges: the hull of four cylinders. The radius
// is clamped to half the shorter side: past that the corner cylinders cross
// and the hull overruns the box (a plate grew 5 mm each way once).
export const rbox = (x0, y0, z0, x1, y1, z1, rIn, seg = 48) => {
  const r = Math.min(rIn, (x1 - x0) / 2 - 0.01, (y1 - y0) / 2 - 0.01);
  return r <= 0 ? box(x0, y0, z0, x1, y1, z1) : Manifold.hull([
  cylZ(x0 + r, y0 + r, z0, r, z1 - z0, seg), cylZ(x1 - r, y0 + r, z0, r, z1 - z0, seg),
  cylZ(x0 + r, y1 - r, z0, r, z1 - z0, seg), cylZ(x1 - r, y1 - r, z0, r, z1 - z0, seg)]);
};
// A convex prism along Y from [x, z] points.
export const prismY = (y, len, ...pointsXZ) => Manifold.hull(pointsXZ.map(([x, z]) => cube(x - 0.01, y, z - 0.01, 0.02, len, 0.02)));
export const status = (name, m) => { if (m.status() !== "NoError") throw new Error(`${name}: ${m.status()}`); return m; };
export const toBed = (m) => { const b = m.boundingBox(); return m.translate([-b.min[0], -b.min[1], -b.min[2]]); };
export const r2 = (v) => Math.round(v * 100) / 100;

// Text for the part IDs in a real font (DejaVu Sans Bold, drawn by
// text-outline.py, which needs python with matplotlib). Returns a solid
// from z up h, the glyph box's lower-left at (x, y), capH tall; mirrored in
// X when it is cut into a face that is read from -Z. Never on a bed face
// (the first layer squashes an engraving there) and never under 2 mm of
// cap height: the strokes must clear one nozzle line.
const here = path.dirname(fileURLToPath(import.meta.url));
const glyphs = new Map();
export function textOutline(text, capH) {
  const key = `${text}|${capH}`;
  if (!glyphs.has(key)) {
    let out;
    try {
      out = execFileSync("python", ["-I", path.join(here, "text-outline.py"), text, String(capH)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      throw new Error(`text-outline.py failed for "${text}" (python with matplotlib draws the part IDs): ${e.stderr || e.message}`);
    }
    glyphs.set(key, JSON.parse(out));
  }
  return glyphs.get(key);
}
export const textWidth = (text, capH) => textOutline(text, capH).widthMm;
export function textSolid(text, x, y, z, capH, h, mirror = false) {
  const g = textOutline(text, capH);
  if (capH < 2.0) throw new Error(`textSolid: "${text}" at ${capH} mm is under one nozzle line of stroke`);
  const cs = new CrossSection(g.polygons, "EvenOdd");
  const placed = mirror ? cs.scale([-1, 1]).translate([x + g.x0 + g.widthMm, y - g.y0]) : cs.translate([x - g.x0, y - g.y0]);
  const solid = placed.extrude(h).translate([0, 0, z]);
  if (solid.volume() < 1e-3) throw new Error(`textSolid: "${text}" drew nothing`);
  return solid;
}

// Down-facing area past 45 degrees, above the bed, split by whether each
// triangle's centroid lies in one of the
// boxes [x0, y0, z0, x1, y1, z1] (the print's frame): inside is a named
// bridge, hole or pocket; outside is a surface a support would scar.
export function overhangOutside(m, zones) {
  const mesh = m.getMesh(); const s = mesh.numProp; let inside = 0, outside = 0, worst = null, worstA = 0;
  const v = (i) => [mesh.vertProperties[i * s], mesh.vertProperties[i * s + 1], mesh.vertProperties[i * s + 2]];
  for (let t = 0; t < mesh.triVerts.length; t += 3) {
    const [a, b, c] = [v(mesh.triVerts[t]), v(mesh.triVerts[t + 1]), v(mesh.triVerts[t + 2])];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n); if (len < 1e-9) continue;
    if (!(n[2] / len < -Math.SQRT1_2 - 1e-6 && Math.max(a[2], b[2], c[2]) > 0.01)) continue;
    const area = len / 2, p = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const hit = zones.some(([x0, y0, z0, x1, y1, z1]) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1 && p[2] >= z0 && p[2] <= z1);
    if (hit) inside += area; else { outside += area; if (area > worstA) { worstA = area; worst = p; } }
  }
  return { inside, outside, worst };
}

export function writeStl(outDir, name, solid) {
  const mesh = solid.getMesh(); const s = mesh.numProp;
  const v = (i) => [mesh.vertProperties[i * s], mesh.vertProperties[i * s + 1], mesh.vertProperties[i * s + 2]];
  const n = mesh.triVerts.length / 3;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write(`KINO CARRIER BODY ${name}`.slice(0, 80), 0, "ascii");
  buf.writeUInt32LE(n, 80);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const [a, b, c] = [v(mesh.triVerts[t * 3]), v(mesh.triVerts[t * 3 + 1]), v(mesh.triVerts[t * 3 + 2])];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nn = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...nn) || 1;
    for (const x of [nn[0] / l, nn[1] / l, nn[2] / l, ...a, ...b, ...c]) { buf.writeFloatLE(x, o); o += 4; }
    buf.writeUInt16LE(0, o); o += 2;
  }
  fs.writeFileSync(path.join(outDir, name), buf);
  const bb = solid.boundingBox();
  return { triangles: n, volumeCm3: r2(solid.volume() / 1000), size: bb.max.map((hi, i) => r2(hi - bb.min[i])) };
}
