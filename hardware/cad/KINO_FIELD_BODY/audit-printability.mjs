import fs from "node:fs";
import path from "node:path";

const input = process.argv[2];
if (!input) throw new Error("usage: node audit-printability.mjs <binary.stl>");
const output = process.argv[3];

const data = fs.readFileSync(input);
const count = data.readUInt32LE(80);
const triangles = [];
const key = (v) => v.map((n) => Math.round(n * 10000)).join(",");

for (let i = 0; i < count; i++) {
  const offset = 84 + i * 50;
  const normal = [0, 1, 2].map((j) => data.readFloatLE(offset + j * 4));
  const vertices = [0, 1, 2].map((vertex) => [0, 1, 2].map((axis) =>
    data.readFloatLE(offset + 12 + (vertex * 3 + axis) * 4)));
  const a = vertices[0];
  const b = vertices[1];
  const c = vertices[2];
  const u = b.map((n, axis) => n - a[axis]);
  const v = c.map((n, axis) => n - a[axis]);
  const cross = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const area = Math.hypot(...cross) / 2;
  const minZ = Math.min(...vertices.map((point) => point[2]));
  triangles.push({ index: i, normal, vertices, area, minZ });
}

// Faces steeper than 45 degrees from the build direction and not lying on the
// bed are potential unsupported ceilings. Connected components make the output
// useful for locating complete problem regions rather than individual facets.
const candidates = triangles.filter((triangle) => triangle.normal[2] < -0.7072 && triangle.minZ > 0.3);
const byVertex = new Map();
for (const triangle of candidates) {
  for (const vertex of triangle.vertices) {
    const vertexKey = key(vertex);
    if (!byVertex.has(vertexKey)) byVertex.set(vertexKey, []);
    byVertex.get(vertexKey).push(triangle);
  }
}

const remaining = new Set(candidates.map((triangle) => triangle.index));
const byIndex = new Map(candidates.map((triangle) => [triangle.index, triangle]));
const groups = [];
while (remaining.size) {
  const seed = remaining.values().next().value;
  const queue = [seed];
  remaining.delete(seed);
  const group = [];
  while (queue.length) {
    const index = queue.pop();
    const triangle = byIndex.get(index);
    group.push(triangle);
    for (const vertex of triangle.vertices) {
      for (const neighbor of byVertex.get(key(vertex)) ?? []) {
        if (remaining.delete(neighbor.index)) queue.push(neighbor.index);
      }
    }
  }
  const points = group.flatMap((triangle) => triangle.vertices);
  const area = group.reduce((sum, triangle) => sum + triangle.area, 0);
  const axisBounds = [0, 1, 2].map((axis) => [
    Math.min(...points.map((point) => point[axis])),
    Math.max(...points.map((point) => point[axis])),
  ]);
  const horizontalArea = group
    .filter((triangle) => triangle.normal[2] < -0.98)
    .reduce((sum, triangle) => sum + triangle.area, 0);
  groups.push({
    triangles: group.length,
    areaMm2: Number(area.toFixed(2)),
    horizontalAreaMm2: Number(horizontalArea.toFixed(2)),
    bounds: {
      x: axisBounds[0].map((n) => Number(n.toFixed(2))),
      y: axisBounds[1].map((n) => Number(n.toFixed(2))),
      z: axisBounds[2].map((n) => Number(n.toFixed(2))),
    },
  });
}

groups.sort((a, b) => b.areaMm2 - a.areaMm2);
const report = {
  // Basename only: these audits are committed, and an absolute path bakes the
  // machine and account they happened to be generated on into the record.
  file: path.basename(input),
  threshold: "downward face steeper than 45 degrees",
  candidateTriangles: candidates.length,
  candidateAreaMm2: Number(candidates.reduce((sum, triangle) => sum + triangle.area, 0).toFixed(2)),
  regions: groups,
};
const json = JSON.stringify(report, null, 2);
if (output) fs.writeFileSync(output, `${json}\n`);
console.log(json);
