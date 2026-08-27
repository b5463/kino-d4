#!/usr/bin/env node
// Bake the six Windows XP home-screen icons into firmware/p4/main/icons_xp.h.
//
//   npm run icons:bake            fetch, verify, regenerate
//   npm run icons:bake -- --check regenerate into memory and diff; fail on drift
//
// The header holds each icon at 48x48 - the grid these were drawn on - as
// RGB565 plus 8-bit alpha. About 41 KB for the set. The device expands them to
// 168 px at boot (icons.c, xp_expand) with the scanlines, aperture triads and
// bloom of the monitor they were meant for, so the flash cost is the icon's
// real resolution rather than half a megabyte of pixels an upscaler invented.
//
// The artwork belongs to Microsoft. See THIRD_PARTY_NOTICES.md; the REUSE
// annotation on the generated header records that, and records nothing more.
//
// SPDX-FileCopyrightText: 2026 KINO contributors <https://github.com/b5463/kino-d4/graphs/contributors>
// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'firmware/p4/main/icons_xp.h');
const CACHE = join(ROOT, 'node_modules/.cache/xp-icons');

/* Pinned so the artwork cannot change under the build. jsDelivr serves a repo
 * at a commit; @main would let an upstream edit rewrite six icons silently. */
const REPO = 'softwarehistorysociety/XPIcons';
const COMMIT = '3887f20148463a100b2cc6fb053fc620fefd0858';

/** Native grid. XP shipped these at 16, 32 and 48; 48 is the desktop size. */
const N = 48;

/* Tile order is the SCREEN_* order in ui.c: MODE, FLASH, GALLERY, ROLL,
 * SETTINGS, STATUS. Changing this array reorders the home screen. */
const ICONS = [
  {
    tile: 'MODE',
    file: 'DigitalCamera',
    sha256: 'f5f12ba96e5a2cdf83f77582b87f46413aba48357f390bd2d4904fdff918671c',
    note: 'A camera. The tile picks how it shoots.',
  },
  {
    tile: 'FLASH',
    file: 'SmartScreen',
    sha256: 'a9b076676a8c4197603467bef563341b248226f8b1c89dc29b1e3d272faac3f0',
    note: 'The only real lightning bolt in the set.',
  },
  {
    tile: 'GALLERY',
    file: 'MyPictures',
    sha256: 'e9211e6bab296db99108558cbe33f6fc70a242de153280a638ab578688ca7685',
    note: 'The folder that holds photographs.',
  },
  {
    tile: 'ROLL',
    file: 'DialUpConnection',
    sha256: '07c436f6860b0acd80202be0e97b6641aad9eecef4f3733cca52c4690a25e6cd',
    note: 'Two machines and a modem. A roll is the party\'s shared link.',
  },
  {
    tile: 'SETTINGS',
    file: 'SettingsAlert',
    sha256: '9a1244da92333e3d2d66a721a53c96b204e9ebe0d7809ceb96b6d3c2b6fb1984',
    note: 'Gear.',
  },
  {
    tile: 'STATUS',
    file: 'MSN',
    sha256: '0a436cba978488b47358e3ca4db25e3d68884e7642e697b4b9f248718fe7b572',
    note: 'Four wings for four camera links.',
  },
];

/* ------------------------------------------------------------------ */
/* PNG                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Decode a non-interlaced 8-bit truecolour-with-alpha PNG to RGBA bytes.
 *
 * Deliberately narrow: it asserts the format rather than handling every PNG,
 * because the inputs are six pinned files whose digests are checked first. A
 * decoder that quietly coped with a palette image would turn a bad download
 * into a strange-looking icon instead of an error.
 */
function decodePng(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');

  let w = 0;
  let h = 0;
  const idat = [];
  for (let p = 8; p + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      const [depth, colour, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== 8 || colour !== 6 || interlace !== 0) {
        throw new Error(`unsupported PNG: depth ${depth}, colour ${colour}, interlace ${interlace}`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  if (!w || !h) throw new Error('PNG has no IHDR');

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = w * bpp;
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
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`bad PNG filter ${filter} on row ${y}`);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, rgba: out };
}

/* ------------------------------------------------------------------ */
/* Resample                                                            */
/* ------------------------------------------------------------------ */

/**
 * Area-average down to N x N, weighting colour by alpha.
 *
 * Straight averaging of RGB across a transparent edge drags the fully
 * transparent pixels' colour - which is whatever the exporter left there,
 * usually black - into the visible rim, and every icon picks up a dark halo.
 * Premultiplying by alpha and dividing the weight back out is the fix.
 */
function downscale(src, w, h, n) {
  const rgb = new Float64Array(n * n * 3);
  const alpha = new Float64Array(n * n);
  for (let oy = 0; oy < n; oy++) {
    const y0 = Math.floor((oy * h) / n);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * h) / n));
    for (let ox = 0; ox < n; ox++) {
      const x0 = Math.floor((ox * w) / n);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * w) / n));
      let r = 0;
      let g = 0;
      let b = 0;
      let aw = 0;
      let cells = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          const a = src[i + 3] / 255;
          r += src[i] * a;
          g += src[i + 1] * a;
          b += src[i + 2] * a;
          aw += a;
          cells++;
        }
      }
      const o = oy * n + ox;
      alpha[o] = aw / cells;
      if (aw > 1e-6) {
        rgb[o * 3] = r / aw;
        rgb[o * 3 + 1] = g / aw;
        rgb[o * 3 + 2] = b / aw;
      }
    }
  }
  return { rgb, alpha };
}

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

const to565 = (r, g, b) =>
  ((clamp8(r) & 0xf8) << 8) | ((clamp8(g) & 0xfc) << 3) | (clamp8(b) >> 3);

/* ------------------------------------------------------------------ */
/* Fetch                                                               */
/* ------------------------------------------------------------------ */

async function fetchIcon(icon) {
  const cached = join(CACHE, `${COMMIT}-${icon.file}.png`);
  let buf;
  try {
    buf = readFileSync(cached);
  } catch {
    const url = `https://cdn.jsdelivr.net/gh/${REPO}@${COMMIT}/XP/${icon.file}.png`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${icon.file}: HTTP ${res.status} from ${url}`);
    buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(cached, buf);
  }
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== icon.sha256) {
    throw new Error(`${icon.file}: sha256 ${got}, expected ${icon.sha256}`);
  }
  return buf;
}

/* ------------------------------------------------------------------ */

function emit(baked) {
  const L = [];
  L.push('// Generated by scripts/bake-xp-icons.mjs. Do not edit by hand.');
  L.push('//');
  L.push('// The six home-screen icons from the Windows XP (Luna) set, at the 48x48');
  L.push('// grid they were drawn on. icons.c expands them to ICON_PX with the');
  L.push('// scanlines and phosphor bloom of a period display; expanding here instead');
  L.push('// would cost twelve times the flash to store an upscale the device can do');
  L.push('// at boot in a few milliseconds.');
  L.push('//');
  L.push(`// Source: https://github.com/${REPO}`);
  L.push(`// Commit: ${COMMIT}`);
  L.push('//');
  L.push('// The artwork is Microsoft\'s and is not covered by this repository\'s MIT');
  L.push('// grant. See THIRD_PARTY_NOTICES.md.');
  L.push('//');
  L.push('// SPDX-FileCopyrightText: Microsoft Corporation');
  L.push('// SPDX-License-Identifier: LicenseRef-Microsoft-Proprietary');
  L.push('#ifndef P4_ICONS_XP_H');
  L.push('#define P4_ICONS_XP_H');
  L.push('');
  L.push('#include <stdint.h>');
  L.push('');
  L.push(`#define XP_ICON_N ${N}`);
  L.push(`#define XP_ICON_COUNT ${baked.length}`);
  L.push('');
  L.push('typedef struct {');
  L.push('  const char *name;             /* the XP file this came from */');
  L.push(`  const uint16_t *rgb;          /* RGB565, ${N}x${N}, row-major */`);
  L.push('  const uint8_t *alpha;         /* coverage, same layout */');
  L.push('} xp_icon_t;');
  L.push('');

  for (const b of baked) {
    const sym = b.tile.toLowerCase();
    L.push(`/* ${b.tile} - ${b.file}.png. ${b.note} */`);
    L.push(`static const uint16_t XP_${b.tile}_RGB[${N} * ${N}] = {`);
    for (let y = 0; y < N; y++) {
      const row = [];
      for (let x = 0; x < N; x++) row.push('0x' + b.rgb[y * N + x].toString(16).padStart(4, '0'));
      L.push('    ' + row.join(', ') + ',');
    }
    L.push('};');
    L.push(`static const uint8_t XP_${b.tile}_A[${N} * ${N}] = {`);
    for (let y = 0; y < N; y++) {
      const row = [];
      for (let x = 0; x < N; x++) row.push(String(b.alpha[y * N + x]).padStart(3, ' '));
      L.push('    ' + row.join(', ') + ',');
    }
    L.push('};');
    L.push('');
    void sym;
  }

  L.push('/* Home-screen order: the SCREEN_* order in ui.c. */');
  L.push('static const xp_icon_t XP_ICONS[XP_ICON_COUNT] = {');
  for (const b of baked) {
    L.push(`    {"${b.file}", XP_${b.tile}_RGB, XP_${b.tile}_A},`);
  }
  L.push('};');
  L.push('');
  L.push('#endif');
  L.push('');
  return L.join('\n');
}

async function main() {
  const check = process.argv.includes('--check');
  const baked = [];
  for (const icon of ICONS) {
    const png = decodePng(await fetchIcon(icon));
    const { rgb, alpha } = downscale(png.rgba, png.w, png.h, N);
    const r16 = new Uint16Array(N * N);
    const a8 = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) {
      r16[i] = to565(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
      a8[i] = clamp8(alpha[i] * 255);
    }
    baked.push({ ...icon, rgb: r16, alpha: a8 });
    process.stdout.write(`${icon.tile.padEnd(9)} ${icon.file}.png ${png.w}x${png.h} -> ${N}x${N}\n`);
  }

  const text = emit(baked);
  if (check) {
    const have = readFileSync(OUT, 'utf8');
    if (have !== text) {
      console.error(`\n${OUT} is stale. Run: npm run icons:bake`);
      process.exit(1);
    }
    console.log('\nicons_xp.h is current.');
    return;
  }
  writeFileSync(OUT, text);
  console.log(`\nwrote ${OUT} (${(text.length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
