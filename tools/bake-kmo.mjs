#!/usr/bin/env node
// Bake the camera's choreography into firmware/p4/main/kmo_data.h.
//
//   npm run kmo:bake            firmware/p4/behaviors/*.json -> kmo_data.h
//   npm run kmo:check           regenerate into memory and diff; fail on drift
//   npm run kmo:plot [dir]      an SVG per clip: every track over time
//
// The source of truth for how KINO moves is data, not C: clips are sets of
// tracks (multi-keyframe curves on a role's channel), with sound markers,
// procedural modifiers and an optional time warp; events map to sets of
// weighted, ruled, conditioned variants. kmo.h evaluates the baked tables;
// the host preview, the Twin and the camera all include the same header, so
// a film is the camera.
//
// Track key: "role.channel" (absolute), "role.channel+" (additive),
// "role@path" (drives position along a path, x/y additive), "role@path~"
// (and rotation follows the tangent). A variant may also carry mood and scene
// bands - energy_min/max, calm_min/max, strain_min/max, conf_min, burst_min/max,
// lum_min/max, motion_max as percentages, framing_min_ms and sync_spread_max_ms
// in milliseconds. Those decide which behaviours qualify at all, so weight only
// chooses among what already fits the moment.
// Keys: [t_ms, value, interp?, p0?, p1?]
// with interp one of lin | hold | step:N | smooth | spring (p0 Hz, p1 zeta) |
// exp (p0 tau ms) | <curve name>. A value "170*p1" is scaled by the
// instance's parameter 1 at runtime (a direction, a distance).
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'firmware/p4/behaviors');
const OUT = join(ROOT, 'firmware/p4/main/kmo_data.h');

const CHANNELS = ['x', 'y', 'sx', 'sy', 'rot', 'alpha', 'ax', 'ay', 'skew', 'track',
  'mx0', 'my0', 'mx1', 'my1', 'cx0', 'cy0', 'cx1', 'cy1', 'rgb', 'strip_amp', 'strip_freq', 'strip_ph',
  'line_w', 'r', 'path_u', 'p0', 'p1', 'p2', 'p3'];
const INTERP = { lin: 0, curve: 1, hold: 2, step: 3, smooth: 4, spring: 5, exp: 6 };
const CUES = { none: 0, sync: 1, done: 2, tick: 3, shutter: 4, warn: 5 };
const MODS = { noise: 1, osc: 2, boil: 3, follow: 4 };
const EVENTS = ['capture_success', 'capture_fail', 'capture_partial', 'link_connected', 'link_lost',
  'transfer_complete', 'sync_good', 'boot', 'first_boot', 'wake', 'wake_long_idle', 'card_in', 'card_out',
  'card_low', 'usb_attach', 'usb_detach', 'look_change', 'mode_change'];

function load() {
  const merged = { curves: {}, paths: {}, clips: {}, events: {} };
  for (const f of readdirSync(SRC_DIR).filter((n) => n.endsWith('.json')).sort()) {
    const j = JSON.parse(readFileSync(join(SRC_DIR, f), 'utf8'));
    /* A key beginning with an underscore is a note to the reader, at every
     * level of these files, and never data. */
    for (const k of ['curves', 'paths', 'clips']) for (const [n, v] of Object.entries(j[k] || {})) {
      if (n.startsWith('_')) continue;
      if (merged[k][n]) throw new Error(`${f}: ${k} "${n}" defined twice`);
      merged[k][n] = v;
    }
    for (const [ev, list] of Object.entries(j.events || {})) {
      if (ev.startsWith('_')) continue;
      if (!EVENTS.includes(ev)) throw new Error(`${f}: unknown event "${ev}"`);
      merged.events[ev] = (merged.events[ev] || []).concat(list);
    }
  }
  return merged;
}

function bake(src) {
  const roles = [];
  const role = (n) => { let i = roles.indexOf(n); if (i < 0) { roles.push(n); i = roles.length - 1; } return i; };
  role('char'); /* per-glyph clips address this one */
  const curveNames = Object.keys(src.curves);
  const curves = [], samples = [];
  for (const n of curveNames) {
    const c = src.curves[n];
    if (c.bezier) curves.push({ kind: 0, p: c.bezier });
    else if (c.pow !== undefined) curves.push({ kind: 2, p: [c.pow, 0, 0, 0] });
    else if (c.samples) { curves.push({ kind: 1, p: [samples.length, c.samples.length, 0, 0] }); samples.push(...c.samples); }
    else throw new Error(`curve "${n}": bezier | pow | samples`);
  }
  const pathNames = Object.keys(src.paths);
  const paths = [], pts = [];
  for (const n of pathNames) {
    const p = src.paths[n];
    const arr = p.quad || p.poly;
    if (!arr) throw new Error(`path "${n}": quad | poly`);
    paths.push({ kind: p.quad ? 1 : 0, pt0: pts.length / 2, npts: arr.length });
    for (const [x, y] of arr) pts.push(x, y);
  }
  const keys = [], tracks = [], sounds = [], mods = [], clips = [], gates = [];
  const gateNames = [];
  const gateIdx = (n) => { let i = gateNames.indexOf(n); if (i < 0) { gateNames.push(n); i = gateNames.length - 1; } return i; };
  const clipNames = Object.keys(src.clips);
  const parseValue = (v) => {
    if (typeof v === 'number') return { v, pm: 0 };
    const m = /^(?:(-?[\d.]+)\*)?p([1-4])(?:\*(-?[\d.]+))?$/.exec(String(v).replace(/\s/g, ''));
    if (!m) throw new Error(`bad value "${v}"`);
    return { v: parseFloat(m[1] ?? m[3] ?? '1'), pm: parseInt(m[2], 10) };
  };
  for (const cn of clipNames) {
    const c = src.clips[cn];
    const clip = { name: cn, dur: c.dur ?? 0, track0: tracks.length, ntracks: 0, sound0: sounds.length, nsounds: 0,
      mod0: mods.length, nmods: 0, gate0: gates.length, ngates: 0, warp: 0, hold: c.hold ? 1 : 0 };
    if (c.warp) { const i = curveNames.indexOf(c.warp); if (i < 0) throw new Error(`${cn}: warp curve "${c.warp}"`); clip.warp = i + 1; }
    for (const [key, ks] of Object.entries(c.tracks || {})) {
      const tr = { role: 0, ch: 0, add: 0, path: 0, key0: keys.length, nkeys: ks.length };
      let m;
      if ((m = /^([\w-]+)@([\w-]+)(~?)$/.exec(key))) {
        tr.role = role(m[1]); tr.ch = CHANNELS.indexOf('path_u');
        const pi = pathNames.indexOf(m[2]); if (pi < 0) throw new Error(`${cn}: path "${m[2]}"`);
        tr.path = pi + 1; tr.add = m[3] ? 2 : 1;
      } else if ((m = /^([\w-]+)\.([\w]+)(\+?)$/.exec(key))) {
        tr.role = role(m[1]); tr.ch = CHANNELS.indexOf(m[2]);
        if (tr.ch < 0) throw new Error(`${cn}: channel "${m[2]}"`);
        tr.add = m[3] ? 1 : 0;
      } else throw new Error(`${cn}: track key "${key}"`);
      let lastT = -1;
      for (const k of ks) {
        const [t, val, interp = 'lin', p0 = 0, p1 = 0] = k;
        if (t < lastT) throw new Error(`${cn}.${key}: keys out of order at ${t}`);
        lastT = t;
        const { v, pm } = parseValue(val);
        const kk = { t, v, interp: 0, curve: 0, pm, p0, p1 };
        if (interp in INTERP && interp !== 'curve') kk.interp = INTERP[interp];
        else if (/^step:\d+$/.test(interp)) { kk.interp = INTERP.step; kk.curve = parseInt(interp.slice(5), 10); }
        else { const ci = curveNames.indexOf(interp); if (ci < 0) throw new Error(`${cn}.${key}: interp "${interp}"`); kk.interp = INTERP.curve; kk.curve = ci; }
        keys.push(kk);
      }
      tracks.push(tr); clip.ntracks++;
      if (c.dur === undefined) clip.dur = Math.max(clip.dur, lastT);
    }
    for (const s of c.sounds || []) { if (!(s.cue in CUES)) throw new Error(`${cn}: cue "${s.cue}"`); sounds.push({ t: s.t, cue: CUES[s.cue] }); clip.nsounds++; }
    /* Gates in ascending time: the runtime holds at the first one still shut. */
    for (const g of (c.gates || []).slice().sort((a, b) => a.t - b.t)) {
      if (!g.wait) throw new Error(`${cn}: a gate needs { t, wait }`);
      gates.push({ t: g.t, gate: gateIdx(g.wait) });
      clip.ngates++;
    }
    if (clip.ngates > 32) throw new Error(`${cn}: more than 32 gates`);
    for (const md of c.mods || []) {
      const kind = Object.keys(MODS).find((k) => md[k] !== undefined);
      if (!kind) throw new Error(`${cn}: mod needs noise | osc | boil | follow`);
      const spec = md[kind];
      const out = { role: role(md.role), kind: MODS[kind], from: md.from ?? 0, to: md.to ?? 0, a: [0, 0, 0, 0], freq: 0 };
      if (kind === 'noise' || kind === 'boil') { out.a = [...(spec.amp || [0, 0, 0, 0]), 0, 0, 0, 0].slice(0, 4); out.freq = spec.hz ?? 6; }
      else if (kind === 'osc') { const ch = CHANNELS.indexOf(spec.ch || 'x'); if (ch < 0) throw new Error(`${cn}: osc channel`); out.a = [spec.amp ?? 4, spec.hz ?? 3, spec.zeta ?? 0.2, ch]; }
      else if (kind === 'follow') { out.a = [role(spec.target), spec.lag ?? 60, 0, 0]; }
      mods.push(out); clip.nmods++;
    }
    clips.push(clip);
  }
  /* Variants. */
  const variants = [], textPool = [];
  for (const ev of EVENTS) {
    for (const v of src.events[ev] || []) {
      const ci = clipNames.indexOf(v.clip); if (ci < 0) throw new Error(`event ${ev}: clip "${v.clip}"`);
      const texts = v.texts || [];
      const tp = texts.length ? textPool.length : -1;
      if (texts.length) textPool.push(texts);
      variants.push({ event: ev, clip: ci, weight: v.w ?? 0, min_interval_s: v.min_interval_s ?? 0,
        once_per_boot: v.once_per_boot ? 1 : 0, once_per_session: v.once_per_session ? 1 : 0,
        avoid_prev_n: v.avoid_prev ?? 0, max_repeats: v.max_repeats ?? 0, rare: v.rare ? 1 : 0,
        shots_eq: v.shots_eq ?? -1, shots_min: v.shots_min ?? -1, flash: v.flash ?? -1, sync_ok: v.sync_ok ?? -1,
        quad: v.quad ?? -1, idle_min_s: v.idle_min_s ?? 0, hour_lt: v.hour_lt ?? -1, first_boot: v.first_boot ? 1 : -1,
        // Mood and scene bands: what makes selection context-first.
        energy_min: v.energy_min ?? -1, energy_max: v.energy_max ?? -1,
        calm_min: v.calm_min ?? -1, calm_max: v.calm_max ?? -1,
        strain_min: v.strain_min ?? -1, strain_max: v.strain_max ?? -1, conf_min: v.conf_min ?? -1,
        burst_min: v.burst_min ?? -1, burst_max: v.burst_max ?? -1,
        lum_min: v.lum_min ?? -1, lum_max: v.lum_max ?? -1, motion_max: v.motion_max ?? -1,
        framing_min_ms: v.framing_min_ms ?? 0, sync_spread_max_ms: v.sync_spread_max_ms ?? -1,
        tp, ntexts: texts.length });
    }
  }
  return { roles, curves, samples, paths, pts, keys, tracks, sounds, mods, gates, gateNames, clips, clipNames, variants, textPool };
}

const f = (x) => { const s = Number(x).toString(); return /[.e]/.test(s) ? `${s}f` : `${s}.f`; };
const cstr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function emit(b) {
  const L = [];
  L.push('// Generated by tools/bake-kmo.mjs from firmware/p4/behaviors/*.json - do not edit.');
  L.push('#pragma once');
  L.push('');
  L.push(`#define KMO_ROLE_COUNT ${b.roles.length}`);
  L.push(`static const char *const KMO_ROLES[${b.roles.length}] = {${b.roles.map(cstr).join(', ')}};`);
  L.push(`#define KMO_CURVE_COUNT ${b.curves.length}`);
  L.push(`static const kmo_curve_t KMO_CURVES[${Math.max(1, b.curves.length)}] = {${b.curves.length ? b.curves.map((c) => `{${c.kind}, {${c.p.map(f).join(', ')}}}`).join(', ') : '{0, {0.f, 0.f, 0.f, 0.f}}'}};`);
  L.push(`static const float KMO_SAMPLES[${Math.max(1, b.samples.length)}] = {${b.samples.length ? b.samples.map(f).join(', ') : '0.f'}};`);
  L.push(`#define KMO_PATH_COUNT ${b.paths.length}`);
  L.push(`static const kmo_path_t KMO_PATHS[${Math.max(1, b.paths.length)}] = {${b.paths.length ? b.paths.map((p) => `{${p.kind}, ${p.pt0}, ${p.npts}}`).join(', ') : '{0, 0, 0}'}};`);
  L.push(`static const float KMO_PATH_PTS[${Math.max(1, b.pts.length)}] = {${b.pts.length ? b.pts.map(f).join(', ') : '0.f'}};`);
  L.push(`#define KMO_KEY_COUNT ${b.keys.length}`);
  L.push(`static const kmo_key_t KMO_KEYS[${Math.max(1, b.keys.length)}] = {`);
  for (const k of b.keys) L.push(`  {${k.t}, ${f(k.v)}, ${k.interp}, ${k.curve}, ${k.pm}, ${f(k.p0)}, ${f(k.p1)}},`);
  if (!b.keys.length) L.push('  {0, 0.f, 0, 0, 0, 0.f, 0.f},');
  L.push('};');
  L.push(`static const kmo_track_t KMO_TRACKS[${Math.max(1, b.tracks.length)}] = {`);
  for (const t of b.tracks) L.push(`  {${t.role}, ${t.ch}, ${t.add}, ${t.path}, ${t.key0}, ${t.nkeys}},`);
  if (!b.tracks.length) L.push('  {0, 0, 0, 0, 0, 0},');
  L.push('};');
  L.push(`static const kmo_sound_t KMO_SOUNDS[${Math.max(1, b.sounds.length)}] = {${b.sounds.length ? b.sounds.map((s) => `{${s.t}, ${s.cue}}`).join(', ') : '{0, 0}'}};`);
  L.push(`#define KMO_GATE_COUNT ${b.gateNames.length}`);
  L.push(`static const char *const KMO_GATE_NAMES[${Math.max(1, b.gateNames.length)}] = {${b.gateNames.length ? b.gateNames.map(cstr).join(', ') : '""'}};`);
  L.push(`static const kmo_gate_t KMO_GATES[${Math.max(1, b.gates.length)}] = {${b.gates.length ? b.gates.map((g) => `{${g.t}, ${g.gate}}`).join(', ') : '{0, 0}'}};`);
  L.push(`static const kmo_mod_t KMO_MODS[${Math.max(1, b.mods.length)}] = {${b.mods.length ? b.mods.map((m) => `{${m.role}, ${m.kind}, ${m.from}, ${m.to}, {${m.a.map(f).join(', ')}}, ${f(m.freq)}}`).join(', ') : '{0, 0, 0, 0, {0.f, 0.f, 0.f, 0.f}, 0.f}'}};`);
  L.push(`#define KMO_CLIP_COUNT ${b.clips.length}`);
  L.push(`static const kmo_clip_t KMO_CLIPS[${Math.max(1, b.clips.length)}] = {`);
  for (const c of b.clips) L.push(`  {${cstr(c.name)}, ${c.dur}, ${c.track0}, ${c.ntracks}, ${c.sound0}, ${c.nsounds}, ${c.mod0}, ${c.nmods}, ${c.gate0}, ${c.ngates}, ${c.warp}, ${c.hold}},`);
  if (!b.clips.length) L.push('  {"", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},');
  L.push('};');
  b.clipNames.forEach((n, i) => L.push(`#define KCLIP_${n.toUpperCase().replace(/[^A-Z0-9]/g, '_')} ${i}`));
  L.push(`static const char *const KMO_EVENT_NAMES[${EVENTS.length}] = {${EVENTS.map(cstr).join(', ')}};`);
  b.textPool.forEach((texts, i) => L.push(`static const char *const KMO_TEXTS_${i}[${texts.length}] = {${texts.map(cstr).join(', ')}};`));
  L.push(`#define KMO_VARIANT_COUNT ${b.variants.length}`);
  L.push(`static const kb_variant_t KMO_VARIANTS[${Math.max(1, b.variants.length)}] = {`);
  for (const v of b.variants)
    L.push(`  {${cstr(v.event)}, ${v.clip}, ${v.weight}, ${v.min_interval_s}, ${v.once_per_boot}, ${v.once_per_session}, ${v.avoid_prev_n}, ${v.max_repeats}, ${v.rare}, ${v.shots_eq}, ${v.shots_min}, ${v.flash}, ${v.sync_ok}, ${v.quad}, ${v.idle_min_s}, ${v.hour_lt}, ${v.first_boot}, ${v.energy_min}, ${v.energy_max}, ${v.calm_min}, ${v.calm_max}, ${v.strain_min}, ${v.strain_max}, ${v.conf_min}, ${v.burst_min}, ${v.burst_max}, ${v.lum_min}, ${v.lum_max}, ${v.motion_max}, ${v.framing_min_ms}, ${v.sync_spread_max_ms}, ${v.tp >= 0 ? `KMO_TEXTS_${v.tp}` : 'NULL'}, ${v.ntexts}},`);
  if (!b.variants.length) L.push('  {"", 0, 0, 0, 0, 0, 0, 0, 0, -1, -1, -1, -1, -1, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, -1, NULL, 0},');
  L.push('};');
  return L.join('\n') + '\n';
}

/* ---- plots: every track of a clip over its duration, as an SVG ---- */
function plot(src, b, dir) {
  mkdirSync(dir, { recursive: true });
  const evalTrack = (ks, t) => {
    /* the same semantics as kmo_track_eval, in JS, for the eye */
    const val = (k) => (typeof k[1] === 'number' ? k[1] : 1);
    if (t <= ks[0][0]) return val(ks[0]);
    if (t >= ks[ks.length - 1][0]) return val(ks[ks.length - 1]);
    let i = 0; while (i < ks.length - 2 && t >= ks[i + 1][0]) i++;
    const a = ks[i], bk = ks[i + 1], va = val(a), vb = val(bk);
    const seg = bk[0] - a[0], s = seg > 0 ? (t - a[0]) / seg : 1, since = t - a[0];
    const interp = a[2] || 'lin';
    if (interp === 'hold') return va;
    if (interp.startsWith('step:')) { const n = parseInt(interp.slice(5), 10); return va + (vb - va) * Math.floor(s * n) / n; }
    if (interp === 'spring') { const fq = a[3] || 4, z = a[4] || 0.4, w = 2 * Math.PI * fq, ts = since / 1000; if (z >= 1) return vb + (va - vb) * Math.exp(-w * ts) * (1 + w * ts); const wd = w * Math.sqrt(1 - z * z); return vb + (va - vb) * Math.exp(-z * w * ts) * (Math.cos(wd * ts) + (z * w / wd) * Math.sin(wd * ts)); }
    if (interp === 'exp') { const tau = a[3] || 80; return vb + (va - vb) * Math.exp(-since / tau); }
    if (interp === 'smooth') { const v0 = i > 0 ? val(ks[i - 1]) : va, v3 = i + 2 < ks.length ? val(ks[i + 2]) : vb, s2 = s * s, s3 = s2 * s; return 0.5 * ((2 * va) + (-v0 + vb) * s + (2 * v0 - 5 * va + 4 * vb - v3) * s2 + (-v0 + 3 * va - 3 * vb + v3) * s3); }
    if (interp in src.curves) { const c = src.curves[interp]; let e = s; if (c.bezier) { const [x1, y1, x2, y2] = c.bezier; let tt = s; for (let n = 0; n < 6; n++) { const mt = 1 - tt, bx = 3 * mt * mt * tt * x1 + 3 * mt * tt * tt * x2 + tt ** 3, dx = 3 * mt * mt * x1 + 6 * mt * tt * (x2 - x1) + 3 * tt * tt * (1 - x2); if (dx < 1e-5) break; tt -= (bx - s) / dx; tt = Math.min(1, Math.max(0, tt)); } const mt = 1 - tt; e = 3 * mt * mt * tt * y1 + 3 * mt * tt * tt * y2 + tt ** 3; } else if (c.pow !== undefined) e = Math.pow(s, c.pow); else if (c.samples) { const n = c.samples.length, fpos = s * (n - 1), ii = Math.min(n - 2, Math.floor(fpos)); e = c.samples[ii] + (c.samples[ii + 1] - c.samples[ii]) * (fpos - ii); } return va + (vb - va) * e; }
    return va + (vb - va) * s;
  };
  const colours = ['#2f70c9', '#f4c542', '#c83a3a', '#48a83e', '#e28cd0', '#7ad1e6', '#f2f2ee', '#ff8c42'];
  for (const [cn, c] of Object.entries(src.clips)) {
    const W = 720, H = 300, pad = 40;
    const dur = c.dur ?? Math.max(...Object.values(c.tracks || {}).map((ks) => ks[ks.length - 1][0]), 1);
    const names = Object.keys(c.tracks || {});
    const rows = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 16 * names.length}" style="background:#0e1014;font:12px monospace">`];
    rows.push(`<text x="${pad}" y="20" fill="#f2f2ee">${cn}  ${dur} ms</text>`);
    names.forEach((n, ni) => {
      const ks = c.tracks[n];
      const vals = []; for (let t = 0; t <= dur; t += 2) vals.push(evalTrack(ks, t));
      const lo = Math.min(...vals, 0), hi = Math.max(...vals, 1);
      const px = (t) => pad + (t / dur) * (W - 2 * pad), py = (v) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
      const d = vals.map((v, i) => `${i ? 'L' : 'M'}${px(i * 2).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
      const col = colours[ni % colours.length];
      rows.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="1.5"/>`);
      ks.forEach((k) => rows.push(`<circle cx="${px(k[0]).toFixed(1)}" cy="${py(typeof k[1] === 'number' ? k[1] : 1).toFixed(1)}" r="3" fill="${col}"/>`));
      rows.push(`<text x="${pad}" y="${H + 12 + 16 * ni}" fill="${col}">${n}  [${lo.toFixed(2)} .. ${hi.toFixed(2)}]</text>`);
    });
    for (const s of c.sounds || []) rows.push(`<line x1="${(pad + (s.t / dur) * (W - 2 * pad)).toFixed(1)}" y1="${pad}" x2="${(pad + (s.t / dur) * (W - 2 * pad)).toFixed(1)}" y2="${H - pad}" stroke="#f4c542" stroke-dasharray="3 3"/><text x="${(pad + (s.t / dur) * (W - 2 * pad) + 3).toFixed(1)}" y="${pad + 10}" fill="#f4c542">${s.cue} ${s.t}</text>`);
    rows.push('</svg>');
    writeFileSync(join(dir, `${cn}.svg`), rows.join('\n'));
  }
  console.log(`[kmo] plotted ${Object.keys(src.clips).length} clips into ${dir}`);
}

function main() {
  const src = load();
  const b = bake(src);
  const text = emit(b);
  const plotAt = process.argv.indexOf('--plot');
  if (plotAt > 0) { plot(src, b, process.argv[plotAt + 1] || join(ROOT, 'firmware/p4/behaviors/plots')); return; }
  if (process.argv.includes('--check')) {
    let have = '';
    try { have = readFileSync(OUT, 'utf8'); } catch { /* absent counts as drift */ }
    if (have !== text) { console.error(`[kmo] ${OUT} is out of date - run: npm run kmo:bake`); process.exit(1); }
    console.log(`[kmo] committed kmo_data.h matches behaviors/ (${b.clips.length} clips, ${b.variants.length} variants)`);
    return;
  }
  writeFileSync(OUT, text);
  console.log(`[kmo] wrote kmo_data.h: ${b.clips.length} clips, ${b.tracks.length} tracks, ${b.keys.length} keys, ${b.variants.length} variants, ${b.roles.length} roles, ${b.paths.length} paths, ${b.curves.length} curves, ${b.gates.length} gates`);
}

main();
