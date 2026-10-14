// Cut faces in ui_font.h down to the characters the interface sets in them.
//
//   node tools/subset-font.mjs <ui_font.h> <NAME>=<chars> [<NAME>=<chars> ...]
//
//   node tools/subset-font.mjs firmware/p4/main/ui_font.h "XL= SHOT"
//
// mkfont.swift bakes ASCII 32..126 for every face. XL is 75 px and sets one
// word, SHOOT, on the menu card: the other 90 glyphs were about 160 KB of
// flash that nothing drew, in a radio image with 45 KB of room under its
// guard. Every glyph not named here keeps its advance, so text_w() measures
// the same, and loses its coverage: its entry becomes {0, 0, adv, 0, 0, NULL}
// and its table is deleted. A string that later sets a dropped letter in the
// face draws a gap there; host_preview's audit fails on it (NULL GLYPH) and
// names the string.
//
// mkfont.swift takes the same list as keep=<chars>, so a fresh bake comes out
// subset already. This tool is for the header as committed, which is what
// the build reads, and it is idempotent: run twice, it changes nothing the
// second time. Line endings are kept as found.
import { readFileSync, writeFileSync } from 'node:fs';

const [path, ...specs] = process.argv.slice(2);
if (!path || specs.length === 0) {
  console.error('usage: node tools/subset-font.mjs <ui_font.h> <NAME>=<chars> ...');
  process.exit(2);
}

const raw = readFileSync(path, 'utf8');
const crlf = raw.includes('\r\n');
let src = raw.replace(/\r\n/g, '\n');

for (const spec of specs) {
  const eq = spec.indexOf('=');
  if (eq <= 0) {
    console.error(`bad spec "${spec}": want NAME=chars`);
    process.exit(2);
  }
  const name = spec.slice(0, eq);
  const keep = new Set([...spec.slice(eq + 1)].map((c) => c.charCodeAt(0)));
  if (!/^[A-Z]+$/.test(name)) {
    console.error(`bad face name "${name}"`);
    process.exit(2);
  }

  const tableRe = new RegExp(`static const ui_glyph_t GLYPHS_${name}\\[95\\] = \\{\\n([\\s\\S]*?)\\n\\};`);
  const m = tableRe.exec(src);
  if (!m) {
    console.error(`no GLYPHS_${name} table in ${path}`);
    process.exit(1);
  }
  const rows = m[1].split('\n');
  if (rows.length !== 95) {
    console.error(`GLYPHS_${name} has ${rows.length} rows, want 95`);
    process.exit(1);
  }

  let dropped = 0;
  let bytes = 0;
  const out = rows.map((row, i) => {
    const code = 32 + i;
    const e = /^ {4}\{(\d+), (\d+), (\d+), (-?\d+), (-?\d+), (\w+)\},$/.exec(row);
    if (!e) {
      console.error(`GLYPHS_${name}[${i}] does not parse: ${row}`);
      process.exit(1);
    }
    if (keep.has(code) || e[6] === 'NULL') return row;
    const sym = e[6];
    const arr = new RegExp(`static const uint8_t ${sym}\\[(\\d+)\\] = \\{[\\s\\S]*?\\n\\};\\n`);
    const a = arr.exec(src);
    if (!a) {
      console.error(`no table ${sym} for '${String.fromCharCode(code)}'`);
      process.exit(1);
    }
    bytes += Number(a[1]);
    src = src.slice(0, a.index) + src.slice(a.index + a[0].length);
    dropped++;
    return `    {0, 0, ${e[3]}, 0, 0, NULL},`;
  });

  src = src.replace(tableRe, `static const ui_glyph_t GLYPHS_${name}[95] = {\n${out.join('\n')}\n};`);
  const kept = [...keep].sort((a, b) => a - b).map((c) => String.fromCharCode(c)).join('');
  const note = `// ${name} keeps "${kept}" only (tools/subset-font.mjs); every other glyph is NULL.\n`;
  if (!src.includes(note)) {
    src = src.replace(/(\/\/ row of blends at one constant baseline y\.\n)/, `$1${note}`);
  }
  console.error(`[subset-font] ${name}: kept "${kept}", dropped ${dropped} glyphs, ${bytes} bytes`);
}

writeFileSync(path, crlf ? src.replace(/\n/g, '\r\n') : src);
