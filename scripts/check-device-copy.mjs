#!/usr/bin/env node
// Every line the camera can put on its own screen is in docs/DEVICE_COPY.md.
//
// The table said so in its first sentence and nothing checked it, so it drifted
// to holding 46% of them (#204). A table that claims to be complete and is not
// is worse than no table, because the next person changing a line trusts it.
//
//   node scripts/check-device-copy.mjs          list what is missing, fail if any
//   node scripts/check-device-copy.mjs --list   print every string found, and stop
//
// What counts as a line: a string literal handed to one of the drawing or toast
// calls below, in firmware/p4/main/{ui.c,conditions.h,capture.c}, with comments
// stripped first so that prose about a string is never mistaken for one.
//
// A string that is genuinely not shown to a person - a format fragment, a
// config key, a log line - belongs in NOT_COPY with the reason, not in the
// table. Keep that list short: if it needs an argument, it is probably copy.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The calls that put a string in front of a person. */
const DRAWS = [
  'text', 'text_mid', 'text_right', 'text_ink', 'text_block', 'text_wrap',
  'toast', 'fact_row', 'draw_row', 'group_box', 'draw_working_banner',
  'draw_toggle_row', 'sev_word',
];

/** Strings the calls above carry that are not copy. Each needs a reason. */
const NOT_COPY = new Map([
  ['%s', 'a format placeholder, the value is checked where it is built'],
  ['%d', 'a format placeholder'],
  ['...', 'the ellipsis text_fit appends to a name too long for its column'],
  ['', 'the empty string, used to clear a field'],
]);

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** String literals passed to one of DRAWS, in one file. */
function drawnStrings(src) {
  const out = new Set();
  const code = stripComments(src);
  const call = new RegExp(`\\b(?:${DRAWS.join('|')})\\s*\\(`, 'g');
  let m;
  while ((m = call.exec(code)) !== null) {
    // Take the argument list, balanced, capped so a runaway regex cannot hang.
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < code.length && depth > 0 && i - start < 2000) {
      const c = code[i];
      if (c === '"') { // skip the literal wholesale, escapes and all
        i++;
        while (i < code.length && !(code[i] === '"' && code[i - 1] !== '\\')) i++;
      } else if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    const args = code.slice(start, i - 1);
    for (const lit of args.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const s = lit[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
      if (s.length) out.add(s);
    }
  }
  return out;
}

const SOURCES = [
  'firmware/p4/main/ui.c',
  'firmware/p4/main/conditions.h',
  'firmware/p4/main/capture.c',
];

const found = new Set();
for (const rel of SOURCES) {
  for (const s of drawnStrings(readFileSync(join(root, rel), 'utf8'))) found.add(s);
}

const table = readFileSync(join(root, 'docs/DEVICE_COPY.md'), 'utf8');

if (process.argv.includes('--list')) {
  for (const s of [...found].sort()) console.log(s);
  process.exit(0);
}

const missing = [...found]
  .filter((s) => !NOT_COPY.has(s))
  .filter((s) => !table.includes(s))
  .sort();

console.log(`Device copy: ${found.size} strings drawn, ${found.size - missing.length} in the table.`);
if (missing.length === 0) {
  console.log('Device copy OK: every line the camera can show is documented.');
  process.exit(0);
}
console.error(`\n${missing.length} line(s) the camera can show are not in docs/DEVICE_COPY.md:\n`);
for (const s of missing) console.error(`  ${s}`);
console.error('\nAdd each to the table with when it appears, or to NOT_COPY in this script');
console.error('with the reason it is not something a person reads.');
process.exit(1);
