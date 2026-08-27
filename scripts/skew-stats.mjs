#!/usr/bin/env node
// Inter-camera exposure-skew statistics for the M2 measurement.
//
//   node scripts/skew-stats.mjs measurements.csv
//   node scripts/skew-stats.mjs -            # read stdin
//
// Input is CSV, one capture per row, one column per camera, values in
// MILLISECONDS as read off a photographed timing reference:
//
//   capture,cam1,cam2,cam3,cam4
//   1,1240,1198,1301,1265
//   2,3410,3372,3455,3402
//
// A header row is optional and auto-detected. Missing values ("", "-", "n/a")
// are allowed: a camera that failed that capture is skipped for that row, and
// rows with fewer than two readable cameras are reported as unusable rather
// than silently dropped.
//
// The skew for a capture is max(cameras) - min(cameras). That is the figure
// that decides whether a wigglegram holds together, because the worst pair in
// the set is what the eye sees.
//
// WHY MANUAL ENTRY: the ground truth for this measurement is a photograph of a
// millisecond timing reference (firmware/SYNC_FEASIBILITY.md, "Recommended M2
// measurement"). Reading those digits with OCR would add a dependency and a
// failure mode to the one number the whole architecture decision rests on. A
// human reads the frames and types them in; this script only does arithmetic.
//
// WHAT THIS MUST NEVER BE FED: dispatchSpreadUs. That measures when the P4 put
// four commands on four UARTs — a scheduler metric with no established
// relationship to when light reached a sensor. Mixing the two is the specific
// error the roadmap exists to prevent.
//
// SPDX-FileCopyrightText: 2026 KINO contributors <https://github.com/b5463/kino-d4/graphs/contributors>
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';

const BLANK = new Set(['', '-', 'n/a', 'na', 'null', 'none']);

function parseCsv(text) {
  const rows = [];
  const unusable = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (lines.length === 0) return { rows, unusable, camCount: 0 };

  // Header detection: a first row whose data cells are not all numeric.
  const cells0 = lines[0].split(',').map((c) => c.trim());
  const looksNumeric = cells0.slice(1).every((c) => BLANK.has(c.toLowerCase()) || Number.isFinite(Number(c)));
  const body = looksNumeric ? lines : lines.slice(1);

  let camCount = 0;
  for (const [i, line] of body.entries()) {
    const cells = line.split(',').map((c) => c.trim());
    // Column 0 is a capture label, not a measurement.
    const label = cells[0] === '' ? String(i + 1) : cells[0];
    const values = [];
    for (const c of cells.slice(1)) {
      if (BLANK.has(c.toLowerCase())) {
        values.push(null);
        continue;
      }
      const n = Number(c);
      values.push(Number.isFinite(n) ? n : null);
    }
    camCount = Math.max(camCount, values.length);
    const present = values.filter((v) => v !== null);
    if (present.length < 2) {
      unusable.push({ label, reason: `${present.length} readable camera(s)` });
      continue;
    }
    rows.push({ label, values, present });
  }
  return { rows, unusable, camCount };
}

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function histogram(values, buckets = 12) {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return [{ from: min, to: max, count: values.length }];
  const width = (max - min) / buckets;
  const bins = Array.from({ length: buckets }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    count: 0,
  }));
  for (const v of values) {
    let idx = Math.floor((v - min) / width);
    if (idx >= buckets) idx = buckets - 1; // the maximum lands in the last bin
    bins[idx].count++;
  }
  return bins;
}

function fmt(ms) {
  return `${ms.toFixed(1)} ms`;
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: node scripts/skew-stats.mjs <measurements.csv | ->');
    process.exit(2);
  }
  const text = arg === '-' ? readFileSync(0, 'utf8') : readFileSync(arg, 'utf8');
  const { rows, unusable, camCount } = parseCsv(text);

  if (rows.length === 0) {
    console.error('no usable captures found (need at least two readable cameras per row)');
    process.exit(1);
  }

  const skews = rows.map((r) => Math.max(...r.present) - Math.min(...r.present));
  const sorted = [...skews].sort((a, b) => a - b);
  const mean = skews.reduce((a, b) => a + b, 0) / skews.length;

  console.log('KINO D4 inter-camera skew — measured from photographed timing reference');
  console.log('='.repeat(72));
  console.log(`captures analysed   ${rows.length}`);
  console.log(`cameras per capture ${camCount}`);
  if (unusable.length > 0) {
    console.log(`unusable rows       ${unusable.length}  (reported, not silently dropped)`);
    for (const u of unusable.slice(0, 8)) console.log(`  capture ${u.label}: ${u.reason}`);
    if (unusable.length > 8) console.log(`  ... and ${unusable.length - 8} more`);
  }
  console.log('');
  console.log(`count               ${skews.length}`);
  console.log(`mean                ${fmt(mean)}`);
  console.log(`median (p50)        ${fmt(quantile(sorted, 0.5))}`);
  console.log(`p95                 ${fmt(quantile(sorted, 0.95))}`);
  console.log(`max                 ${fmt(sorted[sorted.length - 1])}`);
  console.log(`min                 ${fmt(sorted[0])}`);
  console.log('');

  const bins = histogram(skews);
  const widest = Math.max(...bins.map((b) => b.count));
  console.log('distribution');
  for (const b of bins) {
    const bar = '#'.repeat(widest === 0 ? 0 : Math.round((b.count / widest) * 40));
    console.log(
      `  ${b.from.toFixed(0).padStart(5)}..${b.to.toFixed(0).padEnd(5)} ${String(b.count).padStart(4)} ${bar}`,
    );
  }
  console.log('');

  // A uniform spread over one frame period is the free-running signature; a
  // tight cluster near zero would mean something is aligning the sensors.
  const spread = sorted[sorted.length - 1] - sorted[0];
  console.log('reading');
  console.log(
    `  A spread of ${fmt(spread)} across the set, roughly uniform, is what four`,
  );
  console.log('  free-running sensors look like: the skew is bounded by the frame');
  console.log('  period and uncorrelated between cameras. A tight cluster near zero');
  console.log('  would mean something is actually aligning them.');
  console.log('');
  console.log('  This is FRAME-level skew as photographed. It is not dispatchSpreadUs,');
  console.log('  and it is not exposure-window overlap — a rolling shutter integrates');
  console.log('  per row. The acceptance decision is photographic (see');
  console.log('  firmware/FIRMWARE_ROADMAP.md section 10), not this number alone.');
}

main();
