#!/usr/bin/env node
// firmware/UI_DIRECTION.md against the code it describes.
//
//   npm run ui:doc:check
//
// The spec names constants, functions and files in backticks. This fails when
// one of them no longer exists, so a rename in ui.c cannot leave the spec
// pointing at nothing. Three more checks hold the numbers:
//
//   - A table row whose first cell is one backticked constant and whose second
//     cell starts with a number must give the value the code defines. Simple
//     integer #define expressions are evaluated (PAGE_M is 2 * GRID).
//   - The table after <!-- ui-doc:palette --> must give each colour the hex,
//     the RGB565 code and the contrast on K_GROUND that the palette JSON does.
//   - The table after <!-- ui-doc:launch --> must give each launch shade and
//     its pressed shade as K_LAUNCH and K_LAUNCH_DOWN hold them, with the
//     three contrasts. Contrast is computed the way ui.c's rel_lum() does it,
//     on the RGB565 code.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = 'firmware/UI_DIRECTION.md';
const MAIN = join(root, 'firmware', 'p4', 'main');
const PALETTE = join(root, 'packages', 'design-system', 'kino-device-palette.json');

const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const doc = read(join(root, DOC));
const src = readdirSync(MAIN)
  .filter((f) => /\.(c|h)$/.test(f))
  .map((f) => read(join(MAIN, f)))
  .join('\n');
const palette = JSON.parse(read(PALETTE));

const errors = [];
const fail = (line, msg) => errors.push(`${DOC}:${line}: ${msg}`);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- what the code defines ---------------------------------------------

const defines = new Map();
for (const m of src.matchAll(/^[ \t]*#define[ \t]+([A-Za-z_]\w*)(\([^)]*\))?[ \t]*(.*)$/gm)) {
  if (!defines.has(m[1])) defines.set(m[1], m[3].replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').trim());
}

// Every enum member, including enums written on one line.
const enumMembers = new Set();
for (const m of src.matchAll(/\benum\b[^{;]*\{([^}]*)\}/g)) {
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const item of body.split(',')) {
    const id = /^\s*([A-Za-z_]\w*)/.exec(item)?.[1];
    if (id) enumMembers.add(id);
  }
}

function constantExists(name) {
  if (defines.has(name) || enumMembers.has(name)) return true;
  if (palette.colours[name] || palette.roles[name] || palette.arrays[name]) return true;
  // An enum member, or a variable or table defined at file scope.
  if (new RegExp(`^[ \\t]*${esc(name)}[ \\t]*(=[^=]|,|$)`, 'm').test(src)) return true;
  return new RegExp(`^(static |const |extern )*[A-Za-z_][\\w \\t*]*\\b${esc(name)}\\b[ \\t]*(\\[[^\\]]*\\])*[ \\t]*[=;]`, 'm').test(src);
}

function functionExists(name) {
  // A definition or a prototype starts at column 0; a call never does.
  return new RegExp(`^[A-Za-z_][^;\\n]*\\b${esc(name)}[ \\t]*\\(`, 'm').test(src);
}

// A #define's integer value, with other defines expanded. C semantics: integer
// division truncates. null when the body is not integer arithmetic.
function evaluate(name, depth = 0) {
  if (depth > 16 || !defines.has(name)) return null;
  let body = defines.get(name);
  for (let i = 0; i < 16 && /[A-Za-z_]/.test(body); i++) {
    let unknown = false;
    body = body.replace(/\b[A-Za-z_]\w*\b/g, (id) => {
      const v = evaluate(id, depth + 1);
      if (v === null) unknown = true;
      return v === null ? id : String(v);
    });
    if (unknown) return null;
  }
  body = body.replace(/\b(\d+)[uUlLfF]*\b/g, '$1');
  if (!/^[\d\s+\-*/()]+$/.test(body)) return null;
  const tokens = body.match(/\d+|[+\-*/()]/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const expr = () => {
    let v = term();
    while (peek() === '+' || peek() === '-') v = tokens[at++] === '+' ? v + term() : v - term();
    return v;
  };
  const term = () => {
    let v = unary();
    while (peek() === '*' || peek() === '/') {
      const op = tokens[at++];
      const r = unary();
      v = op === '*' ? v * r : Math.trunc(v / r);
    }
    return v;
  };
  const unary = () => {
    if (peek() === '-') { at++; return -unary(); }
    if (peek() === '(') { at++; const v = expr(); at++; return v; }
    return Number(tokens[at++]);
  };
  try {
    const v = expr();
    return at === tokens.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

// ---- colour, the way ui.c measures it -----------------------------------

const pack = (hex) => {
  const n = parseInt(hex, 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
};
const lin = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const relLum = (c) => {
  const r = Math.trunc((((c >> 11) & 0x1f) * 255) / 31) / 255;
  const g = Math.trunc((((c >> 5) & 0x3f) * 255) / 63) / 255;
  const b = Math.trunc(((c & 0x1f) * 255) / 31) / 255;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a, b) => {
  const x = relLum(pack(a)) + 0.05, y = relLum(pack(b)) + 0.05;
  return x > y ? x / y : y / x;
};
const near = (got, want) => Math.abs(got - want) <= 0.011;

// ---- the document ---------------------------------------------------------

const lines = doc.split('\n');
const cells = (line) => line.split('|').slice(1, -1).map((c) => c.trim());
const tableAfter = (marker) => {
  const i = lines.findIndex((l) => l.trim() === marker);
  if (i < 0) return null;
  const rows = [];
  let j = i + 1;
  while (j < lines.length && !lines[j].startsWith('|')) j++;
  for (j += 2; j < lines.length && lines[j].startsWith('|'); j++) rows.push({ n: j + 1, c: cells(lines[j]) });
  return rows;
};

let named = 0;
let valued = 0;
const fileish = /^[\w.\-]+(\/[\w.\-*]+)+$|^[\w\-]+\.(c|h|md|mjs|json|ts|png)$/;
lines.forEach((line, i) => {
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1];
    if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(t)) {
      named++;
      if (!constantExists(t)) fail(i + 1, `\`${t}\` is not defined in firmware/p4/main`);
    } else if (/^[a-z_][a-z0-9_]*\(\)$/.test(t)) {
      named++;
      if (!functionExists(t.slice(0, -2))) fail(i + 1, `\`${t}\` is not defined in firmware/p4/main`);
    } else if (fileish.test(t) && !t.includes('*')) {
      named++;
      const paths = t.includes('/') ? [join(root, t)] : [join(MAIN, t), join(root, t)];
      if (!t.startsWith('out/') && !paths.some((p) => existsSync(p))) fail(i + 1, `\`${t}\` does not exist`);
    }
  }
  // `NAME` | 420 ms | ...: the value must be the code's.
  if (!line.startsWith('|')) return;
  const c = cells(line);
  const name = /^`([A-Z][A-Z0-9_]+)`$/.exec(c[0] ?? '')?.[1];
  const num = /^(-?\d+)(\b|$)/.exec(c[1] ?? '')?.[1];
  if (!name || num === undefined || !defines.has(name)) return;
  const v = evaluate(name);
  if (v === null) return;
  valued++;
  if (v !== Number(num)) fail(i + 1, `${name} is ${v} in the code, ${num} here`);
});

const pal = tableAfter('<!-- ui-doc:palette -->');
if (!pal) fail(0, 'no <!-- ui-doc:palette --> table');
else {
  const seen = new Set();
  for (const { n, c } of pal) {
    const name = /^`(K_\w+)`$/.exec(c[0])?.[1];
    const want = name && palette.colours[name];
    if (!want) { fail(n, `${c[0]} is not a colour in the palette JSON`); continue; }
    seen.add(name);
    const hex = want.hex.toLowerCase();
    if (c[1].toLowerCase() !== hex) fail(n, `${name} is ${hex} in the JSON, ${c[1]} here`);
    const code = `0x${pack(hex).toString(16).toUpperCase().padStart(4, '0')}`;
    if (c[2].toUpperCase() !== code.toUpperCase()) fail(n, `${name} packs to ${code}, ${c[2]} here`);
    const cr = contrast(hex, palette.colours.K_GROUND.hex);
    if (!near(cr, Number(c[3]))) fail(n, `${name} on K_GROUND is ${cr.toFixed(2)}, ${c[3]} here`);
  }
  for (const name of Object.keys(palette.colours)) if (!seen.has(name)) fail(0, `palette table has no row for ${name}`);
}

const launch = tableAfter('<!-- ui-doc:launch -->');
if (!launch) fail(0, 'no <!-- ui-doc:launch --> table');
else {
  const L = palette.arrays.K_LAUNCH.values, D = palette.arrays.K_LAUNCH_DOWN.values;
  const inkHex = palette.colours.K_ACCENT_INK.hex, ground = palette.colours.K_GROUND.hex;
  if (launch.length !== L.length) fail(0, `launch table has ${launch.length} rows, K_LAUNCH has ${L.length}`);
  for (const { n, c } of launch) {
    const i = Number(c[0]);
    if (!(i >= 0 && i < L.length)) { fail(n, `row ${c[0]} is not a K_LAUNCH row`); continue; }
    if (c[1].toLowerCase() !== L[i]) fail(n, `K_LAUNCH[${i}] is ${L[i]}, ${c[1]} here`);
    if (c[2].toLowerCase() !== D[i]) fail(n, `K_LAUNCH_DOWN[${i}] is ${D[i]}, ${c[2]} here`);
    const want = [contrast(inkHex, L[i]), contrast(L[i], ground), contrast(inkHex, D[i])];
    want.forEach((w, k) => {
      if (!near(w, Number(c[3 + k]))) fail(n, `row ${i} column ${4 + k} is ${w.toFixed(2)}, ${c[3 + k]} here`);
    });
  }
}

if (errors.length) {
  for (const e of errors) console.error(`[ui-doc] ${e}`);
  console.error(`[ui-doc] ${errors.length} problem(s). Fix ${DOC} or the code it names.`);
  process.exit(1);
}
console.log(`[ui-doc] ${DOC}: ${named} names exist, ${valued} values match, palette and launch tables match the JSON.`);
