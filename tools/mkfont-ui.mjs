#!/usr/bin/env node
// Bake the camera's interface type into firmware/p4/main/ui_font_ui.h.
//
//   npm run font:ui:bake          fetch, verify, regenerate
//   npm run font:ui:check         regenerate into memory and diff; fail on drift
//
// The face is BIZ UDPGothic (Morisawa's universal-design gothic, SIL Open
// Font License 1.1): a modern Japanese sans drawn to be read at small sizes
// on screens, proportional Latin, and nothing nostalgic about it. The camera
// has no font engine, so it is rasterised HERE - anti-aliased, 16 levels, at
// the exact pixel sizes the interface uses - and the firmware blends the
// coverage into the canvas. Three faces:
//
//   S   22 px regular   values, captions, the one line under a picture
//   M   34 px regular   rows, controls, words that act
//   MB  34 px bold      the mode's name, identifiers, notices, reactions
//
// (34 px is 4 mm of em on the 4.3" 217 ppi panel; 22 px is 2.6 mm.) The
// display sizes - a reaction thrown at 3x, the FILTER identifier at 2x - are
// MB resampled bilinearly on the device: on this density the softening is a
// quarter of a millimetre and the flash cost of a fourth face is not paid.
//
// The glyph set is what ui.c actually says: every code point in a string
// literal there, plus printable ASCII and a few marks the drawing uses. A
// word typed by a user (a look named in Studio, a Wi-Fi network) that falls
// outside it renders in the Shinonome fallback, visibly, rather than not at
// all. Adding a Japanese word to ui.c means re-baking, and `--check` in CI is
// what makes forgetting impossible.
//
// Pinned by commit and by digest like the other baked sources: a font that
// changes under the build would move every word on the camera silently.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const opentype = require('opentype.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'firmware/p4/main/ui_font_ui.h');
const UI_C = join(ROOT, 'firmware/p4/main/ui.c');
/* The words the behaviour tables put on screen live here rather than in ui.c,
 * and a glyph the camera can display but the font does not carry draws as
 * nothing at all. */
const BEHAVIOURS = join(ROOT, 'firmware/p4/behaviors');
const CACHE = join(ROOT, 'node_modules/.cache/bizud');

const SRC = { repo: 'googlefonts/morisawa-biz-ud-gothic', commit: '18934af56b9c003ca58c54bffbf226848cb11032' };
const FILES = {
  regular: { path: 'fonts/ttf/BIZUDPGothic-Regular.ttf', sha256: '258d7156c165f2ff774b6efee637c22c3b950de0d8a10e501137061bc8085d01' },
  bold: { path: 'fonts/ttf/BIZUDPGothic-Bold.ttf', sha256: '30eba52fc837e8b62c97d4b82e6706583149fb7294e3712dd71a655eaea80a90' },
};

/* XS is the units, indexes and metadata a piece of equipment prints next to
 * its numbers; SB is a value or a selection at body size. Both exist because
 * the interface is dense now: hierarchy comes from size and weight rather
 * than from space, which there is not much of on a 4.3 inch panel. */
const FACES = [
  { name: 'XS', file: 'regular', px: 16 },
  { name: 'S', file: 'regular', px: 22 },
  { name: 'SB', file: 'bold', px: 22 },
  { name: 'M', file: 'regular', px: 34 },
  { name: 'MB', file: 'bold', px: 34 },
];

/* Marks the drawing code uses that need not appear in a string literal. */
const ALWAYS = '●○★☆→←↑↓…・ー〜～×÷%℃°';

async function fetchFile(f) {
  const cached = join(CACHE, `${SRC.commit.slice(0, 12)}-${f.path.replace(/\//g, '-')}`);
  let buf;
  if (existsSync(cached)) buf = readFileSync(cached);
  else {
    const url = `https://raw.githubusercontent.com/${SRC.repo}/${SRC.commit}/${f.path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(cached, buf);
  }
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== f.sha256) throw new Error(`${f.path}: sha256 ${got}, expected ${f.sha256}`);
  return buf;
}

/** Every code point the camera can put on the screen from its own text. */
function glyphSet() {
  const cps = new Set();
  for (let c = 0x20; c <= 0x7e; c++) cps.add(c);
  for (const ch of ALWAYS) cps.add(ch.codePointAt(0));
  /* String literals only, so a kanji in a comment does not cost flash. A
   * simple scanner: a double-quoted run on one line, escapes skipped. */
  const lit = /"((?:[^"\\\n]|\\.)*)"/g;
  const add = (src) => {
    let m;
    while ((m = lit.exec(src)) !== null)
      for (const ch of m[1]) {
        const cp = ch.codePointAt(0);
        if (cp > 0x7e) cps.add(cp);
      }
    lit.lastIndex = 0;
  };
  add(readFileSync(UI_C, 'utf8'));
  for (const f of readdirSync(BEHAVIOURS))
    if (f.endsWith('.json')) add(readFileSync(join(BEHAVIOURS, f), 'utf8'));
  return [...cps].sort((a, b) => a - b);
}

/* ---- rasteriser: nonzero winding, 4 sub-scanlines, exact horizontal coverage ---- */

function flatten(path) {
  const edges = [];
  let sx = 0, sy = 0, cx = 0, cy = 0;
  const line = (x0, y0, x1, y1) => { if (y0 !== y1) edges.push([x0, y0, x1, y1]); };
  const bez = (pts) => {
    const n = 12;
    let px = pts[0][0], py = pts[0][1];
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      let x, y;
      if (pts.length === 3) {
        const u = 1 - t;
        x = u * u * pts[0][0] + 2 * u * t * pts[1][0] + t * t * pts[2][0];
        y = u * u * pts[0][1] + 2 * u * t * pts[1][1] + t * t * pts[2][1];
      } else {
        const u = 1 - t;
        x = u * u * u * pts[0][0] + 3 * u * u * t * pts[1][0] + 3 * u * t * t * pts[2][0] + t * t * t * pts[3][0];
        y = u * u * u * pts[0][1] + 3 * u * u * t * pts[1][1] + 3 * u * t * t * pts[2][1] + t * t * t * pts[3][1];
      }
      line(px, py, x, y);
      px = x; py = y;
    }
  };
  for (const c of path.commands) {
    switch (c.type) {
      case 'M': sx = cx = c.x; sy = cy = c.y; break;
      case 'L': line(cx, cy, c.x, c.y); cx = c.x; cy = c.y; break;
      case 'Q': bez([[cx, cy], [c.x1, c.y1], [c.x, c.y]]); cx = c.x; cy = c.y; break;
      case 'C': bez([[cx, cy], [c.x1, c.y1], [c.x2, c.y2], [c.x, c.y]]); cx = c.x; cy = c.y; break;
      case 'Z': line(cx, cy, sx, sy); cx = sx; cy = sy; break;
      default: break;
    }
  }
  return edges;
}

/** Coverage 0..15 over the box [x0, x0+w) x [y0, y0+h), y down. */
function raster(edges, x0, y0, w, h) {
  const SS = 4;
  const cov = new Float32Array(w * h);
  const xs = [];
  for (let row = 0; row < h; row++) {
    for (let s = 0; s < SS; s++) {
      const y = y0 + row + (s + 0.5) / SS;
      xs.length = 0;
      for (const [ax, ay, bx, by] of edges) {
        const top = Math.min(ay, by), bot = Math.max(ay, by);
        if (y < top || y >= bot) continue;
        const t = (y - ay) / (by - ay);
        xs.push([ax + t * (bx - ax), by > ay ? 1 : -1]);
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a[0] - b[0]);
      let wind = 0;
      for (let i = 0; i < xs.length - 1; i++) {
        wind += xs[i][1];
        if (wind === 0) continue;
        let xa = xs[i][0] - x0, xb = xs[i + 1][0] - x0;
        if (xb <= 0 || xa >= w) continue;
        if (xa < 0) xa = 0;
        if (xb > w) xb = w;
        let ia = Math.floor(xa), ib = Math.floor(xb);
        if (ia === ib) { cov[row * w + ia] += (xb - xa) / SS; continue; }
        cov[row * w + ia] += (ia + 1 - xa) / SS;
        for (let k = ia + 1; k < ib; k++) cov[row * w + k] += 1 / SS;
        if (ib < w) cov[row * w + ib] += (xb - ib) / SS;
      }
    }
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < cov.length; i++) {
    let v = Math.round(Math.min(1, Math.max(0, cov[i])) * 15);
    out[i] = v;
  }
  return out;
}

function bakeFace(font, face, cps) {
  const scale = face.px / font.unitsPerEm;
  const glyphs = [];
  const px = [];
  let missing = 0;
  for (const cp of cps) {
    const gi = font.charToGlyphIndex(String.fromCodePoint(cp));
    if (gi === 0 && cp !== 0x20) { missing++; continue; }
    const g = font.glyphs.get(gi);
    const path = g.getPath(0, 0, face.px);
    const adv = Math.round((g.advanceWidth || 0) * scale);
    const bb = path.getBoundingBox();
    let bx = 0, by = 0, w = 0, h = 0, bits = new Uint8Array(0);
    if (path.commands.length > 0 && bb.x2 > bb.x1 && bb.y2 > bb.y1) {
      bx = Math.floor(bb.x1); by = Math.floor(bb.y1);
      w = Math.ceil(bb.x2) - bx; h = Math.ceil(bb.y2) - by;
      bits = raster(flatten(path), bx, by, w, h);
      /* Trim rows/cols that rasterised to nothing so the box is the ink. */
      let r0 = 0, r1 = h, c0 = 0, c1 = w;
      const rowInk = (r) => { for (let c = 0; c < w; c++) if (bits[r * w + c]) return true; return false; };
      const colInk = (c) => { for (let r = 0; r < h; r++) if (bits[r * w + c]) return true; return false; };
      while (r0 < r1 && !rowInk(r0)) r0++;
      while (r1 > r0 && !rowInk(r1 - 1)) r1--;
      while (c0 < c1 && !colInk(c0)) c0++;
      while (c1 > c0 && !colInk(c1 - 1)) c1--;
      if (r0 >= r1 || c0 >= c1) { w = h = 0; bits = new Uint8Array(0); }
      else {
        const nw = c1 - c0, nh = r1 - r0, nb = new Uint8Array(nw * nh);
        for (let r = 0; r < nh; r++) for (let c = 0; c < nw; c++) nb[r * nw + c] = bits[(r + r0) * w + (c + c0)];
        bx += c0; by += r0; w = nw; h = nh; bits = nb;
      }
    }
    const off = px.length;
    for (let i = 0; i < bits.length; i += 2) px.push((bits[i] << 4) | (bits[i + 1] || 0));
    glyphs.push({ cp, off, bx, by, w, h, adv });
  }
  return {
    glyphs, px, missing,
    asc: Math.round(font.ascender * scale),
    desc: Math.round(-font.descender * scale),
  };
}

function emit(faces, cps, notes) {
  const L = [];
  L.push('// Generated by tools/mkfont-ui.mjs - do not edit.');
  L.push(`// BIZ UDPGothic (SIL OFL 1.1), ${SRC.repo}@${SRC.commit.slice(0, 12)}`);
  L.push(`// ${cps.length} code points from ui.c string literals + ASCII; ${notes}`);
  L.push('#pragma once');
  L.push('#include <stdint.h>');
  L.push('');
  L.push('/* One glyph: ink box (bx, by) relative to the pen at the baseline, w x h');
  L.push(' * pixels of 4-bit coverage at `off` (two per byte, high nibble first),');
  L.push(' * and the advance. */');
  L.push('typedef struct { uint16_t cp; uint32_t off; int8_t bx, by; uint8_t w, h, adv; } ut_glyph_t;');
  L.push('typedef struct { const ut_glyph_t *g; int n; const uint8_t *px; int em, asc, desc; } ut_face_t;');
  L.push('');
  for (const f of faces) {
    const tag = `UT_${f.name}`;
    L.push(`static const ut_glyph_t ${tag}_GLYPHS[${f.glyphs.length}] = {`);
    for (const g of f.glyphs) L.push(`  {0x${g.cp.toString(16).padStart(4, '0')}, ${g.off}, ${g.bx}, ${g.by}, ${g.w}, ${g.h}, ${g.adv}},`);
    L.push('};');
    L.push(`static const uint8_t ${tag}_PX[${Math.max(1, f.px.length)}] = {`);
    for (let i = 0; i < f.px.length; i += 32) L.push('  ' + f.px.slice(i, i + 32).map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(',') + ',');
    if (f.px.length === 0) L.push('  0,');
    L.push('};');
    L.push(`static const ut_face_t ${tag} = {${tag}_GLYPHS, ${f.glyphs.length}, ${tag}_PX, ${f.pxSize}, ${f.asc}, ${f.desc}};`);
    L.push('');
  }
  return L.join('\n') + '\n';
}

async function main() {
  const check = process.argv.includes('--check');
  const fonts = {};
  for (const [k, f] of Object.entries(FILES)) fonts[k] = opentype.parse((await fetchFile(f)).buffer.slice(0));
  const cps = glyphSet();
  const faces = [];
  const sizes = [];
  for (const spec of FACES) {
    const b = bakeFace(fonts[spec.file], spec, cps);
    faces.push({ name: spec.name, pxSize: spec.px, ...b });
    sizes.push(`${spec.name} ${spec.px}px: ${b.glyphs.length} glyphs, ${(b.px.length / 1024).toFixed(0)} KB${b.missing ? `, ${b.missing} missing` : ''}`);
  }
  const text = emit(faces, cps, sizes.join('; '));
  if (check) {
    let have = '';
    try { have = readFileSync(OUT, 'utf8'); } catch { /* absent counts as drift */ }
    if (have !== text) {
      console.error(`[font-ui] ${OUT} is out of date - run: npm run font:ui:bake`);
      process.exit(1);
    }
    console.log(`[font-ui] committed ui_font_ui.h matches ui.c (${cps.length} code points)`);
    return;
  }
  writeFileSync(OUT, text);
  console.log(`[font-ui] wrote ${OUT}: ${sizes.join('; ')}; total ${(text.length / 1024).toFixed(0)} KB of source`);
  const pngAt = process.argv.indexOf('--png');
  if (pngAt > 0) samplePng(faces, process.argv[pngAt + 1]);
}

/* ---- a proof, for the eye: each face setting one line, as a grey PNG ---- */
function samplePng(faces, out) {
  const zlib = require('node:zlib');
  const W = 800, H = 60 * faces.length + 20;
  const img = new Uint8Array(W * H).fill(0x10);
  const line = '撮影 再生 色 接続 設定 C02 白黒 つながった！ 4枚 12:34 KINO ROLL WiFi';
  faces.forEach((f, i) => {
    let x = 16;
    const base = 20 + i * 60 + f.asc;
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      const g = f.glyphs.find((q) => q.cp === cp);
      if (!g) { x += f.pxSize / 2; continue; }
      for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w; c++) {
        const i2 = r * g.w + c, b = f.px[g.off + (i2 >> 1)];
        const a = (i2 & 1) ? (b & 15) : (b >> 4);
        const X = x + g.bx + c, Y = base + g.by + r;
        if (X >= 0 && X < W && Y >= 0 && Y < H) img[Y * W + X] = Math.max(img[Y * W + X], 0x10 + Math.round(a * 0xee / 15));
      }
      x += g.adv;
    }
  });
  const raw = Buffer.alloc((W + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W + 1)] = 0; img.subarray(y * W, (y + 1) * W).forEach((v, k) => { raw[y * (W + 1) + 1 + k] = v; }); }
  const crc = (buf) => { let c, crcTable = samplePng.t || (samplePng.t = [...Array(256)].map((_, n) => { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; })); let v = 0xffffffff; for (const b of buf) v = crcTable[(v ^ b) & 0xff] ^ (v >>> 8); return (v ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 0;
  writeFileSync(out, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  console.log(`[font-ui] sample ${out}`);
}

main().catch((e) => { console.error(`[font-ui] ${e.message}`); process.exit(1); });
