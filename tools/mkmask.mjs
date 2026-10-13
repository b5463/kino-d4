// Bake a brand mark into an A8 coverage header for the camera's mask_blit().
//
//   node tools/mkmask.mjs --png <file.png> --ink light|dark --out <file.h> \
//        --size NAME=xH [--size NAME=WxH ...] [--no-trim]
//   node tools/mkmask.mjs --polygon <file.json> --out <file.h> --size NAME=WxH ...
//
// One byte of coverage per pixel, row-major, no padding: the format
// glyph_blend() reads, so ui.c blends the mark into whatever is under it in
// one ink. Nothing is redrawn. A raster is keyed from its own luminance
// against its own field; a polygon (the carrier's traced ODD JOBS symbol) is
// filled exactly. Either way the coverage is a box filter - the area of each
// output pixel the artwork covers - so an edge is as smooth as the source
// allows and never a threshold.
//
//   --png        a brand raster. --ink light for light art on a dark field
//                (the *-on-dark crops), dark for dark art on a light field.
//   --polygon    JSON with a "points" array of [x, y], one closed outline,
//                filled non-zero.
//   --size       NAME=WxH fits the artwork inside W x H, centred; NAME=xH sets
//                the height and takes the width from the artwork, rounded up
//                to even so the mark centres on an 800 px panel without a
//                half pixel. Repeat for more sizes of the same artwork.
//   --no-trim    keep the raster's own margins instead of cutting to the ink.
//
// Each mask gets NAME_W, NAME_H, and NAME_CX_Q8 / NAME_CY_Q8: the coverage
// centroid in 1/256 px from the mask's top-left, for placing a mark by its
// weight instead of its box. The header names its source and the source's
// sha256, and is written with CRLF like every other source here.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const argv = process.argv.slice(2);
const opt = { sizes: [], trim: true };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--png') opt.png = argv[++i];
  else if (a === '--polygon') opt.polygon = argv[++i];
  else if (a === '--ink') opt.ink = argv[++i];
  else if (a === '--out') opt.out = argv[++i];
  else if (a === '--size') opt.sizes.push(argv[++i]);
  else if (a === '--no-trim') opt.trim = false;
  else fail(`unknown argument ${a}`);
}
if (!opt.out || opt.sizes.length === 0 || !!opt.png === !!opt.polygon) {
  fail('usage: mkmask.mjs (--png <f> --ink light|dark | --polygon <f>) --out <f.h> --size NAME=WxH ...');
}
if (opt.png && opt.ink !== 'light' && opt.ink !== 'dark') fail('--png needs --ink light or --ink dark');

function fail(msg) {
  console.error(`mkmask: ${msg}`);
  process.exit(2);
}

/* ---- PNG: 8-bit, non-interlaced, grey / RGB / palette / grey+alpha / RGBA ---- */
function decodePng(buf) {
  const SIG = '89504e470d0a1a0a';
  if (buf.subarray(0, 8).toString('hex') !== SIG) fail('not a PNG');
  let w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  let plte = null, trns = null;
  const idat = [];
  for (let p = 8; p < buf.length; ) {
    const len = buf.readUInt32BE(p);
    const tag = buf.toString('latin1', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (tag === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      interlace = body[12];
    } else if (tag === 'PLTE') plte = body;
    else if (tag === 'tRNS') trns = body;
    else if (tag === 'IDAT') idat.push(body);
    else if (tag === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) fail(`PNG depth ${depth}, interlace ${interlace}: only 8-bit, non-interlaced`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!ch) fail(`PNG colour type ${type} not supported`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? px.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? out[i - ch] : 0;
      const b = up[i];
      const c = i >= ch ? up[i - ch] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) fail(`PNG filter ${f}`);
      out[i] = v & 255;
    }
  }
  /* Luminance and alpha per pixel, 0..255. Rec. 709 weights on the encoded
   * values: the artwork's edges were antialiased in sRGB, and ui.c's mix()
   * blends in the same encoded space, so this is the ratio it will reproduce. */
  const lum = new Float64Array(w * h);
  const alpha = new Float64Array(w * h).fill(255);
  for (let i = 0; i < w * h; i++) {
    let r, g, b;
    if (type === 3) {
      const k = px[i];
      r = plte[k * 3]; g = plte[k * 3 + 1]; b = plte[k * 3 + 2];
      if (trns && k < trns.length) alpha[i] = trns[k];
    } else if (type === 0 || type === 4) {
      r = g = b = px[i * ch];
      if (type === 4) alpha[i] = px[i * ch + 1];
    } else {
      r = px[i * ch]; g = px[i * ch + 1]; b = px[i * ch + 2];
      if (type === 6) alpha[i] = px[i * ch + 3];
    }
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return { w, h, lum, alpha };
}

/* The raster as coverage 0..1: its own field is 0, its own ink is 1. Both
 * levels are read off the picture (the 2nd and 99.9th percentile of
 * luminance), so a field that is 08 rather than 00, or an ink that tops out
 * at F4, is still a clean 0 and 1 and the edge between them keeps its ramp. */
function rasterCoverage(img, ink) {
  const n = img.w * img.h;
  const sgn = ink === 'light' ? 1 : -1;
  const pct = (arr, p) => {
    const s = Float64Array.from(arr, (v) => sgn * v).sort();
    return sgn * s[Math.min(s.length - 1, Math.floor(s.length * p))];
  };
  /* The field from a 6 px ring round the edge, which is field and nothing
   * else, at its 99th percentile: a crop whose field reads 0 and 1 keys both
   * to 0 instead of leaving a haze of 1/255 over the whole mask. The ink is
   * the median of everything past the midpoint, so the solid strokes are
   * exactly 1 and the antialiased edges keep their ramp. */
  const ring = [];
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (x < 6 || y < 6 || x >= img.w - 6 || y >= img.h - 6) ring.push(img.lum[y * img.w + x]);
    }
  }
  const field = pct(ring, 0.99);
  const inkSide = img.lum.filter((v) => sgn * (v - 127.5) > 0);
  if (inkSide.length === 0) fail('no ink past the midpoint');
  const full = pct(inkSide, 0.5);
  const cov = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = (img.lum[i] - field) / (full - field);
    cov[i] = Math.min(1, Math.max(0, c)) * (img.alpha[i] / 255);
  }
  return { w: img.w, h: img.h, cov, field, full };
}

/* The box of everything above 2 % coverage. */
function inkBox(src) {
  let x0 = src.w, y0 = src.h, x1 = 0, y1 = 0;
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      if (src.cov[y * src.w + x] > 0.02) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x + 1 > x1) x1 = x + 1;
        if (y + 1 > y1) y1 = y + 1;
      }
    }
  }
  if (x1 <= x0) fail('no ink in the raster');
  return { x0, y0, x1, y1 };
}

/* Where the artwork's box lands in a W x H mask: as large as fits, centred. */
function parseSize(spec, aw, ah) {
  const m = /^([A-Z][A-Z0-9_]*)=(\d*)x(\d+)$/.exec(spec);
  if (!m) fail(`bad --size ${spec}: want NAME=WxH or NAME=xH`);
  const H = Number(m[3]);
  let W = m[2] ? Number(m[2]) : Math.ceil((H * aw) / ah);
  if (!m[2] && W % 2) W++;
  const s = Math.min(W / aw, H / ah);
  const dw = aw * s, dh = ah * s;
  return { name: m[1], W, H, s, dx0: (W - dw) / 2, dy0: (H - dh) / 2 };
}

/* Area resampling of a coverage raster: each output pixel is the mean of the
 * source over the exact rectangle it covers, partial source pixels weighted
 * by the part inside. Separable, rows then columns. */
function boxResample(src, box, sz) {
  const kx = 1 / sz.s; /* source px per output px */
  const span = (i, d0, s0, s1) => {
    const u0 = s0 + (i - d0) * kx;
    return [Math.max(s0, u0), Math.min(s1, u0 + kx)];
  };
  const weights = (n, d0, s0, s1) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const [a, b] = span(i, d0, s0, s1);
      const w = [];
      for (let k = Math.floor(a); k < Math.ceil(b); k++) {
        const ov = Math.min(b, k + 1) - Math.max(a, k);
        if (ov > 0) w.push([k, ov / kx]);
      }
      out.push(w);
    }
    return out;
  };
  const wx = weights(sz.W, sz.dx0, box.x0, box.x1);
  const wy = weights(sz.H, sz.dy0, box.y0, box.y1);
  const mid = new Float64Array(sz.W * src.h);
  for (let y = box.y0; y < box.y1; y++) {
    for (let i = 0; i < sz.W; i++) {
      let acc = 0;
      for (const [k, f] of wx[i]) acc += src.cov[y * src.w + k] * f;
      mid[y * sz.W + i] = acc;
    }
  }
  const out = new Float64Array(sz.W * sz.H);
  for (let j = 0; j < sz.H; j++) {
    for (let i = 0; i < sz.W; i++) {
      let acc = 0;
      for (const [k, f] of wy[j]) acc += mid[k * sz.W + i] * f;
      out[j * sz.W + i] = acc;
    }
  }
  return out;
}

/* A closed polygon filled non-zero, its coverage exact across each row and
 * sampled 64 times down each pixel: the box filter, to well under one step of
 * the 8-bit output. */
function polygonCoverage(pts, box, sz) {
  const SS = 64;
  const P = pts.map(([x, y]) => [sz.dx0 + (x - box.x0) * sz.s, sz.dy0 + (y - box.y0) * sz.s]);
  const out = new Float64Array(sz.W * sz.H);
  const row = new Float64Array(sz.W);
  for (let j = 0; j < sz.H; j++) {
    row.fill(0);
    for (let s = 0; s < SS; s++) {
      const yc = j + (s + 0.5) / SS;
      const xs = [];
      for (let k = 0; k < P.length; k++) {
        const [x0, y0] = P[k];
        const [x1, y1] = P[(k + 1) % P.length];
        if (y0 === y1) continue;
        const up = y0 < y1;
        const lo = up ? y0 : y1, hi = up ? y1 : y0;
        if (yc < lo || yc >= hi) continue;
        xs.push([x0 + ((yc - y0) * (x1 - x0)) / (y1 - y0), up ? 1 : -1]);
      }
      xs.sort((a, b) => a[0] - b[0]);
      let wind = 0;
      for (let k = 0; k < xs.length - 1; k++) {
        wind += xs[k][1];
        if (wind === 0) continue;
        const a = Math.max(0, xs[k][0]), b = Math.min(sz.W, xs[k + 1][0]);
        for (let i = Math.floor(a); i < Math.ceil(b); i++) {
          const ov = Math.min(b, i + 1) - Math.max(a, i);
          if (ov > 0) row[i] += ov;
        }
      }
    }
    for (let i = 0; i < sz.W; i++) out[j * sz.W + i] = row[i] / SS;
  }
  return out;
}

/* ---- the artwork ---- */
const srcPath = resolve(opt.png ?? opt.polygon);
const srcBytes = readFileSync(srcPath);
const sha = createHash('sha256').update(srcBytes).digest('hex');
let artBox, render, how;
if (opt.png) {
  const img = rasterCoverage(decodePng(srcBytes), opt.ink);
  artBox = opt.trim ? inkBox(img) : { x0: 0, y0: 0, x1: img.w, y1: img.h };
  render = (sz) => boxResample(img, artBox, sz);
  how = `${img.w}x${img.h} raster, ${opt.ink} ink keyed on luminance ` +
    `(field ${img.field.toFixed(1)}, ink ${img.full.toFixed(1)}), ` +
    `${opt.trim ? 'trimmed' : 'untrimmed'} to ${artBox.x1 - artBox.x0}x${artBox.y1 - artBox.y0}, box-filtered`;
} else {
  const j = JSON.parse(srcBytes.toString('utf8'));
  const pts = Array.isArray(j) ? j : j.points;
  if (!Array.isArray(pts) || pts.length < 3) fail('polygon JSON has no points');
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  artBox = { x0, y0, x1, y1 };
  render = (sz) => polygonCoverage(pts, artBox, sz);
  how = `${pts.length}-point outline, ${x1 - x0}x${y1 - y0}, filled non-zero, exact box-filter coverage`;
}

const repo = fileURLToPath(new URL('..', import.meta.url));
const rel = relative(repo, srcPath).split('\\').join('/');
const lines = [
  `// Generated by tools/mkmask.mjs. Do not edit by hand; re-run the tool.`,
  `//`,
  `// Source: ${rel}`,
  `// sha256: ${sha}`,
  `// ${how}.`,
  `//`,
  `// One byte of coverage per pixel, row-major, no padding: mask_blit() in ui.c`,
  `// blends it in one ink. CX_Q8 / CY_Q8 are the coverage centroid in 1/256 px`,
  `// from the top-left.`,
  `#pragma once`,
  `#include <stdint.h>`,
  ``,
];
for (const spec of opt.sizes) {
  const sz = parseSize(spec, artBox.x1 - artBox.x0, artBox.y1 - artBox.y0);
  const cov = render(sz);
  const bytes = new Uint8Array(sz.W * sz.H);
  let m = 0, mx = 0, my = 0;
  for (let j = 0; j < sz.H; j++) {
    for (let i = 0; i < sz.W; i++) {
      const v = Math.round(Math.min(1, Math.max(0, cov[j * sz.W + i])) * 255);
      bytes[j * sz.W + i] = v;
      m += v; mx += v * (i + 0.5); my += v * (j + 0.5);
    }
  }
  const cx = Math.round((mx / m) * 256), cy = Math.round((my / m) * 256);
  lines.push(`#define ${sz.name}_W ${sz.W}`, `#define ${sz.name}_H ${sz.H}`);
  lines.push(`#define ${sz.name}_CX_Q8 ${cx} /* ${(cx / 256).toFixed(2)} px */`);
  lines.push(`#define ${sz.name}_CY_Q8 ${cy} /* ${(cy / 256).toFixed(2)} px */`);
  lines.push(`static const uint8_t ${sz.name}[${sz.W * sz.H}] = {`);
  for (let j = 0; j < sz.H; j++) {
    const r = [];
    for (let i = 0; i < sz.W; i++) r.push(bytes[j * sz.W + i]);
    lines.push('    ' + r.join(',') + ',');
  }
  lines.push('};', '');
  console.error(`[mkmask] ${sz.name}: ${sz.W}x${sz.H}, ${sz.W * sz.H} bytes, centroid ${(cx / 256).toFixed(1)}, ${(cy / 256).toFixed(1)}`);
}
writeFileSync(opt.out, lines.join('\r\n'));
