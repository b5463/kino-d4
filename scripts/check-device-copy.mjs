#!/usr/bin/env node
// Every line the camera can put on its own screen is in docs/DEVICE_COPY.md,
// and every line the table quotes is one the camera can still put there.
//
// The table said so in its first sentence and nothing checked it, so it drifted
// to holding 46% of them (#204). The first check only looked at string literals
// handed straight to a drawing call, and missed every dialog, every row title
// and every line built with snprintf - which is where the next drift was: a
// DELETE dialog that said "cannot be undone" over a thirty-second UNDO (#176).
//
//   node scripts/check-device-copy.mjs          check both directions, fail on any gap
//   node scripts/check-device-copy.mjs --list   print every string found, and stop
//
// Where a line comes from, in firmware/p4/main/{ui.c,conditions.h}, with
// comments stripped first so that prose about a string is never taken for one:
//
//   - a literal anywhere in the arguments of a drawing or toast call (DRAWS);
//   - the format and the literal arguments of snprintf: the dialog lines, the
//     header chip, the readings and the settings summaries are built this way;
//   - a literal at the top level of an initializer list: the dlg_spec_t
//     dialogs, the ABOUT and CONNECTION fact rows, and the label tables such as
//     the DISPLAY durations and the VOLUME levels;
//   - a literal assigned to a variable or returned, at the top level of the
//     expression: the ROLL status word, the CONNECTION link word, sev_word();
//   - the nouns and the tail of count_words(out, cap, n, "photo", "photos",
//     ". This cannot be undone."): it shows "%d photo<tail>" at 1 and
//     "%d photos<tail>" otherwise. The table quotes both forms, or one line
//     with the noun written "photo(s)";
//
// and in capture.c, the person's line of fail(&r, "CODE", "line"): the code goes
// to the log and the KDP reply, the line to the capture strip.
//
// Matching ignores case, because rows and facts are set in capitals when they
// are drawn. A format matches a table line with any text where its % fields
// are: "%d frames. Undo for 30 s after." matches "N frames. Undo for 30 s after.".
//
// The reverse direction reads the table columns that quote the glass (Text,
// Title, Detail, Question, Body, Line, Buttons) and fails on a line no source can
// draw any more. A toast of 40 characters or more fails in either place.
//
// A string that is genuinely not shown to a person - a config key, a path, a
// log line - belongs in NOT_COPY with the reason, not in the table. Keep that
// list short: if it needs an argument, it is probably copy. A string with no
// letter in it (a number, a separator, "%d / %d") is a reading, not copy.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The calls that put a string in front of a person. */
const DRAWS = [
  'text', 'text_mid', 'text_right', 'text_ink', 'text_block', 'text_wrap', 'text_fit',
  'fact_row', 'draw_row', 'draw_row_at', 'draw_row_face', 'group_box',
  'draw_working_banner', 'sh_panel', 'draw_strip', 'btn_text',
];

/** The calls whose string is a toast: held to TOAST_MAX as well. */
const TOASTS = ['toast', 'timer_cancel'];

/**
 * The calls that build a line from a format, by the format's argument index.
 * The literals after the format are fills: a word put into a line ("CARD OUT"
 * into "%s"), so the table needs it somewhere in a quoted line, not on its own.
 */
const FORMATTERS = { snprintf: 2, LK_ADD: 0 };

/**
 * The calls that spell a count, by the index of the singular noun; the plural
 * and the tail follow it. Each call shows two lines, one per form.
 */
const COUNTERS = { count_words: 3 };

/** Toasts sit on one line of the T face: under 40 characters (DEVICE_COPY.md, the rule). */
const TOAST_MAX = 39;

/** Strings the shapes above carry that are not copy. Each needs a reason. */
const NOT_COPY = new Map([
  ['...', 'the ellipsis text_fit appends to a name too long for its column'],
  ['ui', 'the log tag'],
  // Config keys and their stored values: written to config.json, never drawn.
  ['auto', 'a shoot.flashMode value; FLASH_NAMES holds what is drawn'],
  ['on', 'a shoot.flashMode value and a log word'],
  ['off', 'a shoot.flashMode value and a log word'],
  ['cam1', 'a quad.slots key'],
  ['cam2', 'a quad.slots key'],
  ['cam3', 'a quad.slots key'],
  ['cam4', 'a quad.slots key'],
  ['quad.slots.%s.colorMode', 'a config key'],
  ['quad.slots.%s.recipeId', 'a config key'],
  ['body.autoDimS', 'a config key'],
  ['body.sleepS', 'a config key'],
  ['shoot.displayAfterShotS', 'a config key'],
  ['body.camIdleTimeoutS', 'a config key'],
  ['click', 'a built-in sound id; SND_BUILTIN_NAME holds what is drawn'],
  ['cheap-digi', 'a built-in sound id'],
  ['tiny-beep', 'a built-in sound id'],
  ['mechanical', 'a built-in sound id'],
  ['shutter', 'a built-in sound id and the capture source'],
  ['silent', 'a built-in sound id'],
  ['%s/%s/%s', 'a file path on the card'],
  ['%s/%s', 'a file path on the card'],
  ['C1.JPG', 'a file name on the card'],
  ['THUMB.JPG', 'a file name on the card'],
  ['C2.JPG', 'a file name on the card'],
  ['https://github.com/b5463/kino-d4/issues/new?title=%s+%s', 'the help QR payload; the glass shows SCAN FOR HELP'],
  ['KD4', 'the serial the help QR payload falls back to'],
  // Bench lines: built for klog() and never drawn.
  ['%s %lu.%lu ms:', 'the UI_DRAW_PROFILE log line'],
  [' %s %lu.%lu/%lu', 'the UI_DRAW_PROFILE log line'],
  ['fill', 'a UI_DRAW_PROFILE op name in the log'],
  ['rrect', 'a UI_DRAW_PROFILE op name in the log'],
  ['routl', 'a UI_DRAW_PROFILE op name in the log'],
  ['cut', 'a UI_DRAW_PROFILE op name in the log'],
  ['disc', 'a UI_DRAW_PROFILE op name in the log'],
  ['scrim', 'a UI_DRAW_PROFILE op name in the log'],
  ['text', 'a UI_DRAW_PROFILE op name in the log'],
  ['field', 'a UI_DRAW_PROFILE op name in the log'],
  ['shblit', 'a UI_DRAW_PROFILE op name in the log'],
  ['blit', 'a UI_DRAW_PROFILE op name in the log'],
  ['bits', 'a UI_DRAW_PROFILE op name in the log'],
  ['focus', 'a UI_DRAW_PROFILE op name in the log'],
  ['mask', 'a UI_DRAW_PROFILE op name in the log'],
  ['%s%s %lu.%lu+%lu.%lu/%d', 'the boot tile-timing log line'],
  ['%st=%d.%02d %lu.%lu+%lu.%lu/%d', 'the boot tile-timing log line'],
]);

/** Comments out, string and character literals kept intact. */
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      out += ' ';
      i = end < 0 ? src.length : end + 1;
    } else if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = (end < 0 ? src.length : end) - 1;
    } else out += c;
  }
  return out;
}

/** A C string literal's text, or null when it holds a control character. */
function decode(body) {
  const s = body.replace(/\\(x[0-9a-fA-F]{1,2}|.)/g, (_, e) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: ' ', t: ' ', '"': '"', '\\': '\\', "'": "'" }[e] ?? e;
  });
  return /[\x00-\x1f]/.test(s) ? null : s;
}

/**
 * The span from `open` (an opening bracket) to its partner, split at the
 * commas on its own level. Literals are skipped whole. Returns the pieces and
 * the index after the closing bracket.
 */
function splitGroup(code, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [pairs[code[open]]];
  const parts = [];
  let i = open + 1;
  let start = i;
  while (i < code.length && stack.length) {
    const c = code[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < code.length && code[i] !== c) i += code[i] === '\\' ? 2 : 1;
    } else if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) parts.push(code.slice(start, i));
    } else if (c === ',' && stack.length === 1) {
      parts.push(code.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  return { parts, end: i };
}

/**
 * Literals in an expression that are its value: adjacent ones joined, and
 * none from inside a call, an index or a nested list. config_int("shoot.volume", 6)
 * inside an argument is a key, not copy; (a ? "X" : "Y") in plain brackets is copy.
 */
function literals(expr) {
  const out = [];
  const stack = []; // true for a bracket that hides its literals
  let run = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"') {
      let j = i + 1;
      while (j < expr.length && expr[j] !== '"') j += expr[j] === '\\' ? 2 : 1;
      const s = expr.slice(i + 1, j);
      if (!stack.includes(true)) run = run === null ? s : run + s;
      i = j;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < expr.length && expr[j] !== "'") j += expr[j] === '\\' ? 2 : 1;
      i = j;
    } else if (c === '(') stack.push(/[\w\])]\s*$/.test(expr.slice(0, i)));
    else if (c === '[' || c === '{') stack.push(true);
    else if (')]}'.includes(c)) stack.pop();
    if (!/\s/.test(c) && run !== null) {
      out.push(run);
      run = null;
    }
  }
  if (run !== null) out.push(run);
  return out.map(decode).filter((s) => s !== null);
}

/** Every string a source file can show, in the shapes the header lists. */
function shownStrings(src, file) {
  const out = [];
  const toasts = [];
  const fills = [];
  const counted = []; // { forms, line }: a count's two formats, and the "(s)" line when the plural is noun + s
  const code = stripComments(src);
  // The same code with every literal's text blanked, the same length: the
  // patterns below search this, so "?title=%s" or "open t=0.15" inside a
  // string is never read as an assignment. Text is taken from `code`.
  const bare = code.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => m[0] + ' '.repeat(m.length - 2) + m[0]);
  const add = (list, sink = out) => {
    for (const s of list) if (s.trim().length) sink.push(s);
  };

  if (file.endsWith('capture.c')) {
    for (const m of bare.matchAll(/\bfail\s*\(/g)) {
      const { parts } = splitGroup(code, m.index + m[0].length - 1);
      if (parts.length >= 3) add(literals(parts[2]));
    }
    return { out, toasts, fills, counted };
  }

  const names = [...DRAWS, ...TOASTS, ...Object.keys(FORMATTERS), ...Object.keys(COUNTERS)];
  const call = new RegExp(`\\b(${names.join('|')})\\s*\\(`, 'g');
  for (const m of bare.matchAll(call)) {
    const { parts } = splitGroup(code, m.index + m[0].length - 1);
    const c = COUNTERS[m[1]];
    if (c !== undefined) {
      // The definition's own parameters carry no literals and are skipped here.
      const [one, many, tail] = [c, c + 1, c + 2].map((k) => (parts[k] === undefined ? [] : literals(parts[k])));
      if (one.length === 1 && many.length === 1 && tail.length === 1) {
        const forms = [`%d ${one[0]}${tail[0]}`, `%d ${many[0]}${tail[0]}`];
        const line = many[0].toLowerCase() === `${one[0].toLowerCase()}s` ? `%d ${one[0]}(s)${tail[0]}` : null;
        counted.push({ forms, line });
      }
      continue;
    }
    const f = FORMATTERS[m[1]];
    if (f === undefined) {
      for (const a of parts) add(literals(a), TOASTS.includes(m[1]) ? toasts : out);
    } else {
      if (parts[f] !== undefined) add(literals(parts[f]));
      for (const a of parts.slice(f + 1)) add(literals(a), fills);
    }
  }
  // Initializer lists: { "a", "b" }, {"Radio", radio, true}, (dlg_spec_t){...},
  // [SCR_LOOK] = "LOOK". A function body never starts with a literal.
  for (const m of bare.matchAll(/[={,()]\s*\{(?=\s*["[])/g)) {
    const { parts } = splitGroup(code, m.index + m[0].length - 1);
    for (const p of parts) add(literals(p.replace(/^\s*\[[^\]]*\]\s*=/, '')));
  }

  // name = expr;  and  return expr;  - the literals on the expression's own level.
  for (const m of bare.matchAll(/(?:\b[A-Za-z_]\w*\s*=(?!=)|\breturn\b)/g)) {
    const from = m.index + m[0].length;
    const end = bare.indexOf(';', from);
    if (end < 0) continue;
    const expr = code.slice(from, end);
    if (/^\s*\{/.test(expr)) continue; // an initializer list, read above
    add(literals(expr));
  }
  return { out, toasts, fills, counted };
}

const SOURCES = [
  'firmware/p4/main/ui.c',
  'firmware/p4/main/conditions.h',
  'firmware/p4/main/capture.c',
];

const found = new Set(); // whole lines, toasts included
const toasts = new Set();
const fills = new Set(); // words put into a format
const counted = []; // count_words calls: { forms, line }
for (const rel of SOURCES) {
  const r = shownStrings(readFileSync(join(root, rel), 'utf8'), rel);
  for (const s of [...r.out, ...r.toasts]) found.add(s.trim());
  for (const s of r.toasts) toasts.add(s.trim());
  for (const s of r.fills) fills.add(s.trim());
  counted.push(...r.counted);
}

if (process.argv.includes('--list')) {
  for (const s of [...found].sort()) console.log(s);
  for (const s of [...fills].filter((f) => !found.has(f)).sort()) console.log(`${s}   (a fill)`);
  for (const { forms } of counted) console.log(`${forms.join(' / ')}   (a count)`);
  process.exit(0);
}

const isFormat = (s) => /%[-+ #0]*\d*(?:\.\d+)?(?:hh|h|ll|l|z)?[diuxXsc]/.test(s);
const hasWords = (s) => /[A-Za-z]{2,}/.test(s.replace(/%[-+ #0]*\d*(?:\.\d+)?(?:hh|h|ll|l|z)?[diuxXsc%]/g, ''));
const fold = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** A format as a pattern that a table line must fill completely. */
function formatPattern(s) {
  const spec = /%[-+ #0]*\d*(?:\.\d+)?(?:hh|h|ll|l|z)?[diuxXsc]/g;
  let re = '';
  let last = 0;
  for (const m of fold(s).matchAll(spec)) {
    re += fold(s).slice(last, m.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*?';
    last = m.index + m[0].length;
  }
  re += fold(s).slice(last).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${re}$`);
}

// ---- the table ------------------------------------------------------------

const table = readFileSync(join(root, 'docs/DEVICE_COPY.md'), 'utf8');
const GLASS_COLUMNS = new Set(['text', 'title', 'detail', 'question', 'body', 'line', 'buttons']);

/** A cell's quoted lines: its `code` spans, or else the cell split on " / ". */
function cellUnits(cell) {
  const spans = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const plain = cell.replace(/\*\*/g, '').trim();
  return spans.length ? spans : plain.split(' / ').map((s) => s.trim());
}

const tableUnits = new Set(); // everything the table quotes, for the forward check
const glassUnits = []; // { unit, section, column } from glass columns, for the reverse check
for (const m of table.matchAll(/`([^`]+)`/g)) tableUnits.add(fold(m[1]));
let section = '';
let header = null;
for (const raw of table.split(/\r?\n/)) {
  if (/^#{2,}\s/.test(raw)) {
    section = raw.replace(/^#+\s*/, '');
    header = null;
    continue;
  }
  if (!raw.startsWith('|')) {
    header = null;
    continue;
  }
  const cells = raw.slice(1, raw.endsWith('|') ? -1 : undefined).split('|').map((c) => c.trim());
  if (header === null) {
    header = cells.map((c) => c.toLowerCase());
    continue;
  }
  if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
  cells.forEach((cell, k) => {
    const plain = cell.replace(/\*\*|`/g, '').trim();
    tableUnits.add(fold(plain));
    for (const u of cellUnits(cell)) {
      tableUnits.add(fold(u));
      if (GLASS_COLUMNS.has(header[k])) glassUnits.push({ unit: u, section, column: header[k] });
    }
  });
}

// ---- forward: every line the camera can show is in the table ---------------

const copy = [...found].filter((s) => !NOT_COPY.has(s) && hasWords(s));
const fillCopy = [...fills].filter((s) => !found.has(s) && !NOT_COPY.has(s) && hasWords(s));
const units = [...tableUnits];
const documented = (s) =>
  isFormat(s) ? units.some((u) => formatPattern(s).test(u)) : tableUnits.has(fold(s));
const quotedInside = (s) => {
  const re = new RegExp(`(?:^|[^a-z0-9])${fold(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`);
  return units.some((u) => re.test(u));
};
const missing = [
  ...copy.filter((s) => !documented(s)),
  ...fillCopy.filter((s) => !documented(s) && !quotedInside(s)).map((s) => `${s}   (put into a line)`),
  // A count is documented by its "(s)" line, or by both of its forms.
  ...counted
    .filter(({ forms, line }) => !(line && documented(line)) && !forms.every(documented))
    .map(({ forms, line }) => `${line ?? forms.join(' / ')}   (a count)`),
].sort();

// ---- reverse: every line the table quotes can still be shown ---------------

const copyFolded = new Set([...copy, ...fillCopy].map(fold));
const formats = [
  ...copy.filter(isFormat),
  ...counted.flatMap(({ forms, line }) => (line ? [...forms, line] : forms)),
].map(formatPattern);
const stale = glassUnits
  .filter(({ unit }) => /[A-Za-z]{2,}/.test(unit))
  .filter(({ unit }) => !copyFolded.has(fold(unit)) && !formats.some((re) => re.test(fold(unit))));

// ---- toasts fit on one line ----------------------------------------------

const longToasts = [
  ...[...toasts].filter((s) => s.length > TOAST_MAX).map((s) => `${s}  (${s.length}, ui.c)`),
  ...glassUnits
    .filter(({ section: sec, unit }) => sec === 'Toasts' && unit.length > TOAST_MAX)
    .map(({ unit }) => `${unit}  (${unit.length}, DEVICE_COPY.md)`),
];

console.log(
  `Device copy: ${copy.length + counted.length} lines the camera can show, ` +
    `${copy.length + counted.length - missing.length} in the table; ` +
    `${glassUnits.length} quoted in the table, ${glassUnits.length - stale.length} still drawn.`,
);
let failed = false;
if (missing.length) {
  failed = true;
  console.error(`\n${missing.length} line(s) the camera can show are not in docs/DEVICE_COPY.md:\n`);
  for (const s of missing) console.error(`  ${s}`);
  console.error('\nAdd each to the table with when it appears, or to NOT_COPY in this script');
  console.error('with the reason it is not something a person reads.');
}
if (stale.length) {
  failed = true;
  console.error(`\n${stale.length} line(s) in docs/DEVICE_COPY.md that no source can draw:\n`);
  for (const { unit, section: sec, column } of stale) console.error(`  ${unit}   (${sec}, ${column})`);
  console.error('\nThe glass changed and the table did not: copy the line as the code now has it.');
}
if (longToasts.length) {
  failed = true;
  console.error(`\n${longToasts.length} toast(s) of 40 characters or more:\n`);
  for (const s of longToasts) console.error(`  ${s}`);
  console.error('\nA toast is one line. Cut it, or make it a banner or a dialog.');
}
if (failed) process.exit(1);
console.log('Device copy OK: the table and the glass say the same thing.');
