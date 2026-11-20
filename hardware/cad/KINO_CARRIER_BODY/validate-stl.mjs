import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const quantize = (value) => Math.round(value * 1e5) / 1e5;
const vertexKey = (p) => p.map(quantize).join(",");
const undirectedEdgeKey = (a, b) => {
  const ka = vertexKey(a), kb = vertexKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};
const directedEdgeKey = (a, b) => `${vertexKey(a)}>${vertexKey(b)}`;

// The released set - names, folders and part counts - lives in release-set.mjs
// and is shared with promote.mjs. A file that is not listed, or sits in the
// wrong folder, fails outright.
import { RELEASE_SET, RELEASE_DIRS } from "./release-set.mjs";
const expectedParts = new Map(RELEASE_SET.map((e) => [e.file, e.parts]));
const expectedDir = new Map(RELEASE_SET.map((e) => [e.file, e.dir]));

function find(parent, i) {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
}

function join(parent, rank, a, b) {
  a = find(parent, a);
  b = find(parent, b);
  if (a === b) return;
  if (rank[a] < rank[b]) [a, b] = [b, a];
  parent[b] = a;
  if (rank[a] === rank[b]) rank[a]++;
}

function readBinaryStl(file) {
  const b = fs.readFileSync(file);
  if (b.length < 84) throw new Error(`${path.basename(file)}: too short to be a binary STL`);
  const count = b.readUInt32LE(80);
  if (b.length !== 84 + count * 50) {
    throw new Error(`${path.basename(file)}: malformed binary STL length`);
  }
  const triangles = [];
  let o = 84;
  for (let i = 0; i < count; i++, o += 50) {
    const p = [];
    for (let v = 0; v < 3; v++) {
      const q = [
        b.readFloatLE(o + 12 + v * 12),
        b.readFloatLE(o + 16 + v * 12),
        b.readFloatLE(o + 20 + v * 12),
      ];
      if (!q.every(Number.isFinite)) throw new Error(`${path.basename(file)}: non-finite coordinate`);
      p.push(q);
    }
    triangles.push(p);
  }
  return { bytes: b.length, triangles };
}

function inspect(file) {
  const name = path.basename(file);
  const { bytes, triangles } = readBinaryStl(file);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const edgeUses = new Map(), directedEdges = new Map(), faceKeys = new Set();
  const parent = triangles.map((_, i) => i), rank = triangles.map(() => 0);
  let degenerate = 0, duplicateFaces = 0, signedVolume = 0;

  triangles.forEach((p, triangleIndex) => {
    for (const q of p) for (let axis = 0; axis < 3; axis++) {
      lo[axis] = Math.min(lo[axis], q[axis]);
      hi[axis] = Math.max(hi[axis], q[axis]);
    }
    const u = p[1].map((q, axis) => q - p[0][axis]);
    const v = p[2].map((q, axis) => q - p[0][axis]);
    const cross = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    if (Math.hypot(...cross) / 2 < 1e-6) degenerate++;
    signedVolume += (
      p[0][0] * (p[1][1] * p[2][2] - p[1][2] * p[2][1]) -
      p[0][1] * (p[1][0] * p[2][2] - p[1][2] * p[2][0]) +
      p[0][2] * (p[1][0] * p[2][1] - p[1][1] * p[2][0])
    ) / 6;

    const faceKey = p.map(vertexKey).sort().join("|");
    if (faceKeys.has(faceKey)) duplicateFaces++;
    faceKeys.add(faceKey);

    for (const [a, b] of [[p[0], p[1]], [p[1], p[2]], [p[2], p[0]]]) {
      const key = undirectedEdgeKey(a, b);
      if (!edgeUses.has(key)) edgeUses.set(key, []);
      edgeUses.get(key).push(triangleIndex);
      const directed = directedEdgeKey(a, b);
      directedEdges.set(directed, (directedEdges.get(directed) ?? 0) + 1);
    }
  });

  for (const uses of edgeUses.values()) {
    for (let i = 1; i < uses.length; i++) join(parent, rank, uses[0], uses[i]);
  }
  const components = new Set(triangles.map((_, i) => find(parent, i))).size;
  const boundaryEdges = [...edgeUses.values()].filter((uses) => uses.length === 1).length;
  const nonManifoldEntries = [...edgeUses.entries()].filter(([, uses]) => uses.length > 2);
  const nonManifoldEdges = nonManifoldEntries.length;
  let orientationErrors = 0;
  for (const key of edgeUses.keys()) {
    const [a, b] = key.split("|");
    if ((directedEdges.get(`${a}>${b}`) ?? 0) !== 1 ||
        (directedEdges.get(`${b}>${a}`) ?? 0) !== 1) orientationErrors++;
  }

  const failures = [];
  if (degenerate) failures.push(`${degenerate} degenerate triangles`);
  if (duplicateFaces) failures.push(`${duplicateFaces} duplicate faces`);
  if (boundaryEdges) failures.push(`${boundaryEdges} boundary edges`);
  if (nonManifoldEdges) {
    const [firstEdge, firstUses] = nonManifoldEntries[0];
    failures.push(`${nonManifoldEdges} non-manifold edges (first: ${firstEdge}, ${firstUses.length} uses)`);
  }
  if (orientationErrors) failures.push(`${orientationErrors} incorrectly oriented edges`);
  if (Math.abs(signedVolume) < 1e-6) failures.push("zero enclosed volume");
  if (signedVolume < 0) failures.push("inward-facing shell orientation");
  const expected = expectedParts.get(name);
  if (expected === undefined) {
    failures.push("not in the released file set (stale or misnamed STL)");
  } else if (components !== expected) {
    failures.push(`${components} disconnected parts; expected ${expected}`);
  }
  // A released file (not a candidate given on the command line) must sit in
  // its own folder: print/, plates/ or coupons/.
  if (expected !== undefined && !fromArgs) {
    const dir = path.basename(path.dirname(file));
    if (dir !== expectedDir.get(name)) failures.push(`in ${dir}/, belongs in ${expectedDir.get(name)}/`);
  }

  const dims = hi.map((q, axis) => q - lo[axis]);
  console.log(
    `${failures.length ? "FAIL" : "PASS"} ${name}: ${triangles.length} triangles; ` +
    `${(bytes / 1024).toFixed(1)} KiB; ${dims.map((q) => q.toFixed(2)).join(" x ")} mm; ` +
    `${components} part(s); volume ${signedVolume.toFixed(2)} mm^3`,
  );
  for (const failure of failures) console.log(`  - ${failure}`);
  return failures.length === 0;
}

// With arguments: validate those files (the .candidate set, before promotion).
// Without: validate every STL in the release folders AND anything left at the
// folder root, which is by definition stale.
const names = process.argv.slice(2);
const fromArgs = names.length > 0;
const listDir = (d) => fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith(".stl")).map((n) => path.join(d, n)) : [];
const files = fromArgs ? names.map((name) => path.resolve(name))
  : [...RELEASE_DIRS.flatMap((d) => listDir(path.join(here, d))), ...listDir(here)];
let passed = files.map(inspect).every(Boolean);
if (!fromArgs) {
  const present = new Set(files.map((f) => path.basename(f)));
  for (const e of RELEASE_SET) if (!present.has(e.file)) { console.log(`FAIL ${e.file}: missing from ${e.dir}/`); passed = false; }
  console.log(`${files.length} files found, ${RELEASE_SET.length} in the released set`);
}
if (!passed) process.exitCode = 1;

