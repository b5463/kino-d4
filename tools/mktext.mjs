// Rasterise UI label text to 1-bit C arrays for the camera's own screen.
//
// The device has no font engine. Adding one to draw six fixed words would be
// a large dependency for strings that never change, so the words are rendered
// here — with real kerning and antialias-thresholding from a browser text
// stack — and committed as generated C.
//
// Dynamic text — counters, storage figures, node state — cannot be a fixed
// bitmap, so this also emits a small ASCII atlas in two sizes. Same renderer,
// same thresholding, so screen copy and the big chrome labels look like they
// came from one typeface, because they did.
//
//   node tools/mktext.mjs firmware/p4/main/ui_labels.h firmware/p4/main/ui_font.h
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const repo = 'c:/Users/AlexanderMoravcik/Desktop/kino d4';
const out = process.argv[2] ?? 'firmware/p4/main/ui_labels.h';

/* The six on-camera destinations. Order is grid order: top row then bottom. */
const LABELS = ['SHOOT', 'FLASH', 'GALLERY', 'ROLL', 'SETTINGS', 'STATUS'];

// Tahoma, because that is what the design system says: tokens.css sets
// --sans to Tahoma, Verdana, 'Segoe UI', Arial and describes the language as
// "early/mid-2000s desktop-utility". Segoe UI is a Vista face and reads a
// generation too late next to Studio's chrome.
const FONT = '700 28px Tahoma, Verdana, "DejaVu Sans", Arial, sans-serif';
const TRACKING = 1.4; // px of extra letterspacing; uppercase labels need air

const pw = await import(pathToFileURL(repo + '/node_modules/playwright-core/index.js').href);
const { chromium } = pw.default ?? pw;
const browser = await chromium.launch();
const page = await browser.newPage();

const glyphs = await page.evaluate(({ labels, font, tracking }) => {
  const out = [];
  for (const text of labels) {
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    g.font = font;
    // Measure with tracking applied by hand: canvas has no letterSpacing in
    // every engine, so the string is drawn glyph by glyph below.
    let w = 0;
    for (const ch of text) w += g.measureText(ch).width + tracking;
    w = Math.ceil(w - tracking) + 2;
    const m = g.measureText(text);
    const asc = Math.ceil(m.actualBoundingBoxAscent || 24);
    const desc = Math.ceil(m.actualBoundingBoxDescent || 6);
    const h = asc + desc + 2;

    c.width = w; c.height = h;
    const g2 = c.getContext('2d');
    g2.font = font;
    g2.fillStyle = '#000';
    g2.textBaseline = 'alphabetic';
    let x = 1;
    for (const ch of text) {
      g2.fillText(ch, x, asc + 1);
      x += g2.measureText(ch).width + tracking;
    }

    const d = g2.getImageData(0, 0, w, h).data;
    const bits = [];
    for (let i = 0; i < w * h; i++) {
      // Threshold on alpha: the glyphs are painted opaque black on an empty
      // canvas, so coverage is alpha. 110 keeps stems solid without fattening
      // the antialiased edges into blobs at this size.
      bits.push(d[i * 4 + 3] > 110 ? 1 : 0);
    }
    out.push({ text, w, h, bits });
  }
  return out;
}, { labels: LABELS, font: FONT, tracking: TRACKING });

/* The ASCII atlas. Every glyph in a face shares one cell height with the
 * baseline at a fixed row, so drawing a string is a walk of blits at a
 * constant y — no per-glyph vertical offset to get wrong, at the cost of a
 * few hundred bytes of blank rows. */
const FACES = [
  { id: 'S', font: '400 17px Tahoma, Verdana, "DejaVu Sans", Arial, sans-serif', tracking: 0.2 },
  { id: 'M', font: '700 23px Tahoma, Verdana, "DejaVu Sans", Arial, sans-serif', tracking: 0.3 },
];
const FIRST_CH = 32, LAST_CH = 126;

const faces = await page.evaluate(({ faces, first, last }) => {
  const out = [];
  for (const face of faces) {
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = face.font;
    // One cell for the whole face, sized by the tallest ascender and deepest
    // descender any of its glyphs actually uses.
    let asc = 0, desc = 0;
    for (let c = first; c <= last; c++) {
      const m = probe.measureText(String.fromCharCode(c));
      asc = Math.max(asc, Math.ceil(m.actualBoundingBoxAscent || 0));
      desc = Math.max(desc, Math.ceil(m.actualBoundingBoxDescent || 0));
    }
    const lineH = asc + desc + 1;

    const glyphs = [];
    for (let c = first; c <= last; c++) {
      const ch = String.fromCharCode(c);
      const adv = Math.max(1, Math.round(probe.measureText(ch).width + face.tracking));
      const w = Math.max(1, adv);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = lineH;
      const g = cv.getContext('2d');
      g.font = face.font;
      g.fillStyle = '#000';
      g.textBaseline = 'alphabetic';
      g.fillText(ch, 0, asc);
      const d = g.getImageData(0, 0, w, lineH).data;
      const bits = [];
      for (let i = 0; i < w * lineH; i++) bits.push(d[i * 4 + 3] > 110 ? 1 : 0);
      glyphs.push({ code: c, w, adv, bits });
    }
    out.push({ id: face.id, font: face.font, lineH, asc, glyphs });
  }
  return out;
}, { faces: FACES, first: FIRST_CH, last: LAST_CH });

await browser.close();

const lines = [];
lines.push('// Generated by tools/mktext.mjs. Do not edit by hand.');
lines.push('//');
lines.push('// 1 bit per pixel, MSB first, `stride` bytes per row. Rendered from');
lines.push(`// ${JSON.stringify(FONT)} at ${TRACKING}px tracking.`);
lines.push('#pragma once');
lines.push('#include <stdint.h>');
lines.push('');
lines.push('typedef struct {');
lines.push('  const char *text;');
lines.push('  uint16_t w, h, stride;');
lines.push('  const uint8_t *bits;');
lines.push('} ui_label_t;');
lines.push('');

const names = [];
for (const gl of glyphs) {
  const stride = Math.ceil(gl.w / 8);
  const bytes = new Uint8Array(stride * gl.h);
  for (let y = 0; y < gl.h; y++) {
    for (let x = 0; x < gl.w; x++) {
      if (gl.bits[y * gl.w + x]) bytes[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const name = 'LBL_' + gl.text;
  names.push({ name, gl, stride });
  lines.push(`static const uint8_t ${name}_BITS[${stride * gl.h}] = {`);
  for (let y = 0; y < gl.h; y++) {
    const row = [];
    for (let i = 0; i < stride; i++) row.push('0x' + bytes[y * stride + i].toString(16).padStart(2, '0'));
    lines.push('    ' + row.join(', ') + ',');
  }
  lines.push('};');
}

lines.push('');
lines.push(`#define UI_LABEL_COUNT ${names.length}`);
lines.push('static const ui_label_t UI_LABELS[UI_LABEL_COUNT] = {');
for (const { name, gl, stride } of names) {
  lines.push(`    {"${gl.text}", ${gl.w}, ${gl.h}, ${stride}, ${name}_BITS},`);
}
lines.push('};');

writeFileSync(out, lines.join('\n') + '\n');
console.log(out + ':');
for (const { gl, stride } of names) {
  console.log(`  ${gl.text.padEnd(9)} ${gl.w}x${gl.h}, ${stride * gl.h} bytes`);
}

/* ---- the ASCII atlas ---- */
const fout = process.argv[3] ?? 'firmware/p4/main/ui_font.h';
const f = [];
f.push('// Generated by tools/mktext.mjs. Do not edit by hand.');
f.push('//');
f.push('// ASCII 32..126, 1 bit per pixel, MSB first, `stride` bytes per row.');
f.push('// Every glyph in a face is `line_h` rows tall with the baseline at');
f.push('// `ascent`, so drawing a string is a row of blits at one constant y.');
f.push('#pragma once');
f.push('#include <stdint.h>');
f.push('');
f.push('typedef struct {');
f.push('  uint8_t w, stride, adv;');
f.push('  const uint8_t *bits;');
f.push('} ui_glyph_t;');
f.push('');
f.push('typedef struct {');
f.push('  const ui_glyph_t *glyphs;');
f.push('  uint8_t first, count, line_h, ascent;');
f.push('} ui_font_t;');
f.push('');

let fontBytes = 0;
for (const face of faces) {
  for (const gl of face.glyphs) {
    const stride = Math.ceil(gl.w / 8);
    const bytes = new Uint8Array(stride * face.lineH);
    for (let y = 0; y < face.lineH; y++)
      for (let x = 0; x < gl.w; x++)
        if (gl.bits[y * gl.w + x]) bytes[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    fontBytes += bytes.length;
    f.push(`static const uint8_t G${face.id}_${gl.code}[${bytes.length}] = {`);
    const rows = [];
    for (let y = 0; y < face.lineH; y++) {
      const row = [];
      for (let i = 0; i < stride; i++) row.push('0x' + bytes[y * stride + i].toString(16).padStart(2, '0'));
      rows.push('    ' + row.join(', ') + ',');
    }
    f.push(rows.join('\n'));
    f.push('};');
  }
  f.push(`static const ui_glyph_t GLYPHS_${face.id}[${face.glyphs.length}] = {`);
  for (const gl of face.glyphs) {
    const stride = Math.ceil(gl.w / 8);
    f.push(`    {${gl.w}, ${stride}, ${gl.adv}, G${face.id}_${gl.code}},`);
  }
  f.push('};');
  f.push(`static const ui_font_t UI_FONT_${face.id} = {GLYPHS_${face.id}, ${FIRST_CH}, ${face.glyphs.length}, ${face.lineH}, ${face.asc}};`);
  f.push('');
}

writeFileSync(fout, f.join('\n') + '\n');
console.log(fout + ':');
for (const face of faces) {
  console.log(`  face ${face.id}  line_h ${face.lineH}, ascent ${face.asc}, ${face.glyphs.length} glyphs`);
}
console.log(`  ${fontBytes} bytes of glyph data`);
