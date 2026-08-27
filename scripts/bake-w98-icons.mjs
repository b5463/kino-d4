#!/usr/bin/env node
// Bake the D4 menu icons into firmware/p4/main/icons_w98.h.
//
//   npm run icons:bake            fetch, verify, regenerate
//   npm run icons:check           regenerate into memory and diff; fail on drift
//
// Period shell icons from two pinned archives, each file checked by digest.
// They are stored at their NATIVE size - 48x48 or 32x32 - with the integer
// factor that takes each one up to the tile. The device scales by nearest
// neighbour (icons.c), because these are pixel art: a resampler that
// interpolates turns a hand-placed dither into mush, and the whole reason
// for using the originals rather than redrawing them is that the original
// pixels ARE the character.
//
// Two container formats, because the archives differ: Windows .ico holding a
// DIB, and palette PNG. Both decoders are here rather than pulled in as a
// dependency - the whole bake is 400 lines and has no node_modules.
//
// The artwork is Microsoft's. See THIRD_PARTY_NOTICES.md; the REUSE
// annotation on the generated header records that and grants nothing.
//
// SPDX-FileCopyrightText: 2026 KINO contributors <https://github.com/b5463/kino-d4/graphs/contributors>
// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'firmware/p4/main/icons_w98.h');
const CACHE = join(ROOT, 'node_modules/.cache/w98-icons');

/* Sources, pinned. @main would let an upstream edit rewrite an icon under
 * the build without anything failing. */
const SRC = {
  w98: {
    repo: 'trapd00r/win95-winxp_icons',
    commit: '728a866ad59a54fd4082dbe000e1e62e50bd90e9',
    dir: 'icons',
    ext: 'ico',
  },
  vintage: {
    repo: 'alexh/vintage-icons',
    commit: 'cff2143b10cb1a1ab4062355ad0dde21b7a6fab3',
    dir: 'static/icons',
    ext: 'png',
  },
};

/* The tile art box. 48 x 3 and 32 x 4 both land at or under this, so every
 * icon is an exact integer multiple of its source and nothing is resampled. */
const BOX = 144;

/* Menu order is the SCREEN_* order in ui.c. `sym` also names the C arrays. */
const ICONS = [
  {
    sym: 'SHOOT', src: 'w98', file: 'w98_camera3',
    sha256: '3dca6cce8231ba22f0ad470929664b10926742adf72346c66563bc19073924f0',
    why: 'A compact camera, front on. SHOOT holds the previews and the modes, so the tile is the camera itself.',
  },
  {
    sym: 'LOOK', src: 'w98', file: 'w98_color_profile',
    sha256: '3a53d39c6c3adf43c8dba27c74038d8de2c65770a39c9c53a9f9a8c1eaa2374b',
    why: 'An RGB triangle on a colour-profile document. LOOK is colour rendering, not painting.',
  },
  {
    sym: 'GALLERY', src: 'w98', file: 'w98_directory_pictures',
    sha256: '7efaaacab469e830748ab3654ff058884bd04f62b8af5ba0e984d47a23e2446c',
    why: 'A folder of photographs: pictures already on the device.',
  },
  {
    sym: 'ROLL', src: 'vintage', file: 'msn3_4',
    sha256: '4d39e306de0ee3696259362864dced18347b3d65c838a2e5e2d0afc72c496748',
    why: 'The Messenger butterfly. Not a shell icon and not 1998, but a roll IS the party talking to each other, and nothing in the shell set says that.',
  },
  {
    sym: 'SETTINGS', src: 'w98', file: 'w98_settings_gear',
    sha256: 'a02e15ab3032c1817d35efdcd570661a82ec91f7fffb565ada620415c6ee98c7',
    why: 'A control panel and gears. Deliberately the boring one.',
  },
  {
    sym: 'POWER', src: 'w98', file: 'w98_shut_down_normal',
    sha256: '6debe66dd595b248af66726f713ca08cadcb1856e8038a16fcfc1b016b2e5f2e',
    why: 'The Windows shutdown monitor. Ambiguous alone on a camera; the POWER label under it resolves that.',
  },
  {
    sym: 'BATTERY', src: 'w98', file: 'w98_battery',
    sha256: '402492d36632c2be5db9a27605adaf74e04ee4cf7921eb4c4973e69af69eb68d',
    why: 'Status glyph only, drawn at 1:1 rather than scaled to the tile box.',
  },
];

/* ------------------------------------------------------------------ */
/* ICO / DIB                                                           */
/* ------------------------------------------------------------------ */

/**
 * Decode the best frame of a Windows .ico into {w, h, rgba}.
 *
 * "Best" is the largest frame, and among equal sizes the deepest one: these
 * files carry both a 16-colour and a 256-colour version of the same artwork,
 * and taking the first directory entry gets the 16-colour one, which visibly
 * flattens the shading the icons are worth using for.
 */
function decodeIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an ICO');
  const count = buf.readUInt16LE(4);

  let best = null;
  for (let i = 0; i < count; i++) {
    const o = 6 + 16 * i;
    const w = buf[o] || 256;
    const h = buf[o + 1] || 256;
    const bits = buf.readUInt16LE(o + 6);
    const size = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    const cand = { w, h, bits, size, off };
    if (!best || w * h > best.w * best.h || (w * h === best.w * best.h && bits > best.bits)) {
      best = cand;
    }
  }
  if (!best) throw new Error('ICO has no frames');

  const d = buf.subarray(best.off, best.off + best.size);
  if (d.readUInt32BE(0) === 0x89504e47) throw new Error('PNG-compressed ICO frame is not supported');

  const headerSize = d.readUInt32LE(0);
  const w = d.readInt32LE(4);
  /* biHeight covers the XOR bitmap and the AND mask stacked, so it is twice
   * the icon. Trusting it as the height yields a double-height smear. */
  const h = d.readInt32LE(8) / 2;
  const bits = d.readUInt16LE(14);
  if (w !== best.w || h !== best.h) throw new Error(`DIB ${w}x${h} disagrees with directory ${best.w}x${best.h}`);

  let p = headerSize;
  const palette = [];
  if (bits <= 8) {
    const n = d.readUInt32LE(32) || (1 << bits);
    for (let i = 0; i < n; i++) {
      palette.push([d[p + 2], d[p + 1], d[p]]); /* stored BGRA */
      p += 4;
    }
  }

  const xorStride = Math.ceil((w * bits) / 32) * 4;
  const andStride = Math.ceil(w / 32) * 4;
  const xor = d.subarray(p, p + xorStride * h);
  const and = d.subarray(p + xorStride * h, p + xorStride * h + andStride * h);

  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = h - 1 - y; /* DIB rows are bottom-up */
    for (let x = 0; x < w; x++) {
      let r, g, b;
      if (bits === 8) {
        const c = palette[xor[sy * xorStride + x]] || [0, 0, 0];
        [r, g, b] = c;
      } else if (bits === 4) {
        const byte = xor[sy * xorStride + (x >> 1)];
        const idx = x & 1 ? byte & 0x0f : byte >> 4;
        const c = palette[idx] || [0, 0, 0];
        [r, g, b] = c;
      } else if (bits === 24 || bits === 32) {
        const q = sy * xorStride + x * (bits / 8);
        b = xor[q];
        g = xor[q + 1];
        r = xor[q + 2];
      } else {
        throw new Error(`unsupported ICO depth ${bits}`);
      }
      /* The AND mask is transparency: a 1 bit means "show what is behind". */
      const mbyte = and[sy * andStride + (x >> 3)];
      const transparent = (mbyte >> (7 - (x & 7))) & 1;
      const o = (y * w + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = transparent ? 0 : 255;
    }
  }
  return { w, h, rgba };
}

/* ------------------------------------------------------------------ */
/* PNG                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Decode a non-interlaced 8-bit PNG - palette, truecolour, or truecolour
 * with alpha - to RGBA bytes.
 *
 * Palette support is not optional here: the Messenger butterfly is colour
 * type 3 with a tRNS chunk, and a decoder that only handled RGBA would have
 * rejected it. Narrow by design otherwise - the inputs are pinned files
 * whose digests are checked before this runs, so an unexpected format is a
 * bad download and should stop the bake rather than be coped with.
 */
function decodePng(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');

  let w = 0, h = 0, depth = 0, colour = 0;
  const idat = [];
  let plte = null;
  let trns = null;

  for (let p = 8; p + 8 <= buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      colour = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported');
      if (colour !== 2 && colour !== 3 && colour !== 6) {
        throw new Error(`PNG colour type ${colour} is not supported`);
      }
      /* Truecolour is 8-bit here; palettes are commonly packed to 1, 2 or 4
       * bits per pixel, which is how the Messenger butterfly is stored. */
      if (colour === 3 ? ![1, 2, 4, 8].includes(depth) : depth !== 8) {
        throw new Error(`PNG bit depth ${depth} with colour type ${colour} is not supported`);
      }
    } else if (type === 'PLTE') {
      plte = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  if (!w || !h) throw new Error('PNG has no IHDR');
  if (colour === 3 && plte === null) throw new Error('palette PNG has no PLTE');

  /* Filtering works on whole bytes: the "bpp" a filter steps back by is the
   * byte width of a pixel, floored to 1 for anything packed below 8 bits. */
  const chan = colour === 6 ? 4 : colour === 2 ? 3 : 1;
  const bpp = Math.max(1, Math.ceil((chan * depth) / 8));
  const stride = Math.ceil((w * chan * depth) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(h * stride);

  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, y * stride + stride);
    const prev = y ? out.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`bad PNG filter ${filter} on row ${y}`);
      }
      cur[x] = v & 0xff;
    }
  }

  const rgba = Buffer.alloc(w * h * 4);
  const mask = (1 << depth) - 1;
  const per = 8 / depth; /* palette entries packed into one byte */
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (colour === 3) {
        let idx;
        if (depth === 8) {
          idx = out[y * stride + x];
        } else {
          const byte = out[y * stride + Math.floor(x / per)];
          const shift = 8 - depth * ((x % per) + 1);
          idx = (byte >> shift) & mask;
        }
        rgba[o] = plte[idx * 3];
        rgba[o + 1] = plte[idx * 3 + 1];
        rgba[o + 2] = plte[idx * 3 + 2];
        /* tRNS for a palette image is one alpha byte per entry; entries past
         * its end are opaque. */
        rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else {
        const q = y * stride + x * chan;
        rgba[o] = out[q];
        rgba[o + 1] = out[q + 1];
        rgba[o + 2] = out[q + 2];
        rgba[o + 3] = colour === 6 ? out[q + 3] : 255;
      }
    }
  }
  return { w, h, rgba };
}

const to565 = (r, g, b) => ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);

/* ------------------------------------------------------------------ */

async function fetchIcon(icon) {
  const src = SRC[icon.src];
  if (src === undefined) throw new Error(`${icon.file}: unknown source "${icon.src}"`);
  const name = `${icon.file}.${src.ext}`;
  const cached = join(CACHE, `${src.commit.slice(0, 12)}-${name}`);
  let buf;
  try {
    buf = readFileSync(cached);
  } catch {
    const url = `https://cdn.jsdelivr.net/gh/${src.repo}@${src.commit}/${src.dir}/${name}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${icon.file}: HTTP ${res.status} from ${url}`);
    buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(cached, buf);
  }
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== icon.sha256) {
    throw new Error(
      `${icon.file}: sha256 ${got}, expected ${icon.sha256}.\n` +
      'The pinned artwork changed under the build. Delete node_modules/.cache/w98-icons ' +
      'to re-fetch, or update the digest deliberately.',
    );
  }
  icon.gotSha = got;
  return buf;
}

function emit(baked) {
  const L = [];
  L.push('// Generated by scripts/bake-w98-icons.mjs. Do not edit by hand.');
  L.push('//');
  L.push('// The D4 menu icons: Windows 98 shell icons at their native size, with the');
  L.push('// integer factor that takes each up to the 144 px tile box. icons.c scales');
  L.push('// by nearest neighbour, so the original pixels survive - these are pixel');
  L.push('// art, and an interpolating resampler destroys the thing worth keeping.');
  L.push('//');
  for (const [key, s] of Object.entries(SRC)) {
    L.push(`// Source (${key}): https://github.com/${s.repo} @ ${s.commit}`);
  }
  L.push('//');
  L.push('// The artwork is Microsoft\'s and is not covered by this repository\'s MIT');
  L.push('// grant. See THIRD_PARTY_NOTICES.md.');
  L.push('//');
  L.push('// SPDX-FileCopyrightText: Microsoft Corporation');
  L.push('// SPDX-License-Identifier: LicenseRef-Microsoft-Proprietary');
  L.push('#ifndef P4_ICONS_W98_H');
  L.push('#define P4_ICONS_W98_H');
  L.push('');
  L.push('#include <stdint.h>');
  L.push('');
  L.push(`#define W98_BOX ${BOX}`);
  L.push(`#define W98_COUNT ${baked.length}`);
  L.push(`#define W98_MENU_COUNT ${baked.length - 1}   /* the last entry is the battery */`);
  L.push('');
  L.push('typedef struct {');
  L.push('  const char *name;      /* source file in the archive */');
  L.push('  uint8_t n;             /* native edge, 32 or 48 */');
  L.push('  uint8_t scale;         /* integer factor up to the tile box */');
  L.push('  const uint16_t *rgb;   /* n*n RGB565 */');
  L.push('  const uint8_t *alpha;  /* n*n, 0 or 255 - the ICO mask is 1 bit */');
  L.push('} w98_icon_t;');
  L.push('');

  for (const b of baked) {
    L.push(`/* ${b.sym} - ${b.file}.ico, ${b.n}x${b.n} at ${b.bits} bpp, drawn at ${b.scale}x.`);
    L.push(` * ${b.why} */`);
    L.push(`static const uint16_t W98_${b.sym}_RGB[${b.n} * ${b.n}] = {`);
    for (let y = 0; y < b.n; y++) {
      const row = [];
      for (let x = 0; x < b.n; x++) row.push('0x' + b.rgb[y * b.n + x].toString(16).padStart(4, '0'));
      L.push('    ' + row.join(', ') + ',');
    }
    L.push('};');
    L.push(`static const uint8_t W98_${b.sym}_A[${b.n} * ${b.n}] = {`);
    for (let y = 0; y < b.n; y++) {
      const row = [];
      for (let x = 0; x < b.n; x++) row.push(String(b.alpha[y * b.n + x]).padStart(3, ' '));
      L.push('    ' + row.join(', ') + ',');
    }
    L.push('};');
    L.push('');
  }

  L.push('/* Menu order: MODE, LOOK, GALLERY, ROLL, SETTINGS, POWER, then BATTERY. */');
  L.push('static const w98_icon_t W98_ICONS[W98_COUNT] = {');
  for (const b of baked) {
    L.push(`    {"${b.file}", ${b.n}, ${b.scale}, W98_${b.sym}_RGB, W98_${b.sym}_A},`);
  }
  L.push('};');
  L.push('');
  L.push('/* Index of the battery, which is drawn at 1:1 in the viewfinder header. */');
  L.push(`#define W98_BATTERY_IDX ${baked.length - 1}`);
  L.push('');
  L.push('#endif');
  L.push('');
  return L.join('\n');
}

async function main() {
  const check = process.argv.includes('--check');
  const baked = [];
  for (const icon of ICONS) {
    const raw = await fetchIcon(icon);
    const { w, h, rgba } = SRC[icon.src].ext === 'ico' ? decodeIco(raw) : decodePng(raw);
    if (w !== h) throw new Error(`${icon.file}: ${w}x${h} is not square`);
    /* The battery is a status glyph, not a tile, so it stays at 1:1. */
    const scale = icon.sym === 'BATTERY' ? 1 : Math.floor(BOX / w);
    const rgb = new Uint16Array(w * h);
    const alpha = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      rgb[i] = to565(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
      /* Coverage is treated as on or off: the ICO mask is one bit anyway, and
       * a PNG's soft edge blended against a light menu and a dark viewfinder
       * needs a matte this pipeline does not carry. 128 is the midpoint. */
      alpha[i] = rgba[i * 4 + 3] >= 128 ? 255 : 0;
    }
    const opaque = alpha.reduce((a, v) => a + (v ? 1 : 0), 0);
    baked.push({ ...icon, n: w, scale, rgb, alpha, bits: 'best' });
    process.stdout.write(
      `${icon.sym.padEnd(9)} ${icon.file.padEnd(24)} ${w}x${w} x${scale} -> ${w * scale}px  ` +
      `${Math.round((100 * opaque) / (w * h))}% opaque  sha ${icon.gotSha.slice(0, 12)}\n`,
    );
  }

  const text = emit(baked);
  if (check) {
    const have = readFileSync(OUT, 'utf8');
    if (have !== text) {
      console.error(`\n${OUT} is stale. Run: npm run icons:bake`);
      process.exit(1);
    }
    console.log('\nicons_w98.h is current.');
    return;
  }
  writeFileSync(OUT, text);
  console.log(`\nwrote ${OUT} (${(text.length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
