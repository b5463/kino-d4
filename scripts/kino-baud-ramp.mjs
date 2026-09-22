// The camera link, measured at every baud it will accept.
//
// The cost of a shutter is the largest JPEG divided by the line rate (#218),
// so the only question that matters is how fast the link will run without
// losing bytes. This asks it, at each rate, with the same scene.
//
// One session: opening the port resets the body, and a reset puts every
// channel back on the default, which would undo the thing being measured.
//
//   npx tsx scripts/kino-baud-ramp.mjs --port COM8
//   npx tsx scripts/kino-baud-ramp.mjs --port COM8 --rates 921600,1500000
//
// It always ends by putting the link back on 921600, including after a
// failure, so a bench body is never left somewhere it cannot be reached.
import { SerialPort } from 'serialport';
import {
  FrameDecoder, decodeJson, encodeFrame, encodeJson, nextSeq,
} from '../packages/kdp/src/protocol/packet.ts';
import { Cmd, FrameFlags } from '../packages/kdp/src/protocol/commands.ts';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const portPath = opt('--port', 'COM8');
const settleMs = Number(opt('--settle', '14000'));
const rates = opt('--rates', '921600,1500000,2000000,3000000').split(',').map(Number);
// One capture proves a rate can work; it does not prove it keeps working.
// --captures repeats at each rate and reports the worst, which is what a
// shipping decision needs.
const captures = Number(opt('--captures', '1'));
const DEFAULT_BAUD = 921600;

let seq = 0;
const waiting = new Map();
const decoder = new FrameDecoder();
const port = await new Promise((resolve, reject) => {
  const p = new SerialPort({ path: portPath, baudRate: 921600, autoOpen: false });
  p.open((err) => (err ? reject(err) : resolve(p)));
});
port.on('data', (chunk) => {
  for (const frame of decoder.push(new Uint8Array(chunk))) {
    if (frame.flags & FrameFlags.EVENT) continue;
    const pending = waiting.get(frame.seq);
    if (pending) { waiting.delete(frame.seq); pending(frame); }
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function request(type, body, timeoutMs = 8000) {
  seq = nextSeq(seq);
  const mySeq = seq;
  const frame = { version: 1, type, flags: FrameFlags.NONE, seq: mySeq, payload: encodeJson(body ?? {}) };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(mySeq); reject(new Error(`timeout 0x${type.toString(16)}`)); }, timeoutMs);
    waiting.set(mySeq, (f) => {
      clearTimeout(timer);
      let parsed; try { parsed = decodeJson(f.payload); } catch { parsed = {}; }
      resolve({ ok: !(f.flags & FrameFlags.ERROR), body: parsed });
    });
    port.write(Buffer.from(encodeFrame(frame)), (err) => {
      if (err) { clearTimeout(timer); waiting.delete(mySeq); reject(err); }
    });
  });
}

/** The link's error counters, so each rate is judged on its own delta. */
function linkCounters(stats) {
  const out = {};
  const cams = stats?.cameraLink ?? stats?.links ?? stats?.cameras ?? {};
  for (const [k, v] of Object.entries(cams)) {
    if (v && typeof v === 'object') {
      out[k] = {
        crc: v.crcErrors ?? v.crc ?? 0,
        resync: v.resyncs ?? 0,
        timeouts: v.timeouts ?? 0,
        retries: v.retries ?? 0,
      };
    }
  }
  return out;
}
function deltaCounters(before, after) {
  let crc = 0, resync = 0, timeouts = 0, retries = 0;
  for (const k of Object.keys(after)) {
    const b = before[k] ?? { crc: 0, resync: 0, timeouts: 0, retries: 0 };
    crc += (after[k].crc ?? 0) - (b.crc ?? 0);
    resync += (after[k].resync ?? 0) - (b.resync ?? 0);
    timeouts += (after[k].timeouts ?? 0) - (b.timeouts ?? 0);
    retries += (after[k].retries ?? 0) - (b.retries ?? 0);
  }
  return { crc, resync, timeouts, retries };
}

async function setBaud(baud) {
  const r = await request(Cmd.SET_LINK_BAUD, { baud }, 30000);
  if (!r.ok) return { ok: false, why: r.body?.message ?? r.body?.code ?? 'refused' };
  const cams = r.body?.cams ?? [];
  const bad = cams.filter((c) => !c.ok);
  return { ok: bad.length === 0, cams, bad };
}

const results = [];
try {
  console.log(`opened ${portPath}; settling ${settleMs} ms for the reset the open caused`);
  await sleep(settleMs);
  const h = await request(Cmd.HELLO, { hostEpochMs: Date.now(), hostUtcOffsetMin: -new Date().getTimezoneOffset() }, 4000);
  if (!h.ok) throw new Error('HELLO refused');

  for (const baud of rates) {
    process.stdout.write(`\n=== ${baud} baud ===\n`);
    const applied = await setBaud(baud);
    if (!applied.ok) {
      console.log(`  refused: ${applied.why ?? JSON.stringify(applied.bad)}`);
      results.push({ baud, applied: false, note: applied.why ?? 'one or more channels refused' });
      continue;
    }
    console.log(`  all four channels at ${baud}`);

    const before = linkCounters((await request(Cmd.GET_RUNTIME_STATS, {}, 6000)).body);
    let failedAt = null;
    let worstTotal = 0, worstSlowest = 0, sumRate = 0, nOk = 0, kbLast = 0, framesLast = 0;
    for (let i = 1; i <= captures && failedAt === null; i++) {
      const cap = await request(Cmd.CAMERA_CAPTURE, {}, 40000);
      if (!cap.ok) { failedAt = `${i}: ${cap.body?.code ?? 'failed'}`; break; }
      const frames = cap.body?.frames ?? [];
      if (frames.length < 4) { failedAt = `${i}: ${frames.length} of 4 frames`; break; }
      const bytes = frames.reduce((a, f) => a + (f.bytes ?? 0), 0);
      const slowest = Math.max(...frames.map((f) => f.transferMs ?? 0));
      const rate = frames.reduce((a, f) => a + (f.bytes / 1024) / (f.transferMs / 1000), 0) / frames.length;
      worstTotal = Math.max(worstTotal, cap.body?.timing?.totalMs ?? 0);
      worstSlowest = Math.max(worstSlowest, slowest);
      sumRate += rate; nOk++; kbLast = Math.round(bytes / 1024); framesLast = frames.length;
      if (captures > 1) process.stdout.write(`  ${i}/${captures} ${cap.body?.timing?.totalMs} ms, slowest link ${slowest} ms, ${rate.toFixed(1)} KB/s
`);
    }
    const after = linkCounters((await request(Cmd.GET_RUNTIME_STATS, {}, 6000)).body);
    const d = deltaCounters(before, after);

    if (failedAt !== null) {
      console.log(`  capture FAILED at ${failedAt}; crc ${d.crc} resync ${d.resync} timeouts ${d.timeouts}`);
      results.push({ baud, applied: true, captureOk: false, note: failedAt, ...d });
      continue;
    }
    const rate = sumRate / nOk;
    results.push({
      baud, applied: true, captureOk: true,
      frames: framesLast, kb: kbLast,
      totalMs: worstTotal, slowestMs: worstSlowest,
      kbs: Number(rate.toFixed(1)), ...d,
    });
    console.log(`  ${nOk} capture(s); worst total ${worstTotal} ms, worst link ${worstSlowest} ms`);
    console.log(`  mean per link ${rate.toFixed(1)} KB/s; crc ${d.crc} resync ${d.resync} timeouts ${d.timeouts} retries ${d.retries}`);
  }
} finally {
  process.stdout.write(`\nputting the link back on ${DEFAULT_BAUD}\n`);
  try {
    const back = await setBaud(DEFAULT_BAUD);
    console.log(back.ok ? '  all four channels home' : `  NOT all home: ${JSON.stringify(back.bad ?? back.why)}`);
  } catch (e) {
    console.log(`  could not put it back: ${e.message}`);
  }
  port.close();
}

console.log('\n%s %8s %7s %9s %11s %6s %8s %9s %8s', 'baud'.padEnd(9), 'frames', 'KB', 'totalMs', 'slowestMs', 'KB/s', 'crc', 'resync', 'timeouts');
for (const r of results) {
  if (!r.applied) { console.log(`${String(r.baud).padEnd(9)} ${'-'.padStart(8)}  (${r.note})`); continue; }
  if (!r.captureOk) { console.log(`${String(r.baud).padEnd(9)} ${'-'.padStart(8)}  (capture ${r.note})`); continue; }
  console.log(
    `${String(r.baud).padEnd(9)} ${String(r.frames).padStart(8)} ${String(r.kb).padStart(7)} ${String(r.totalMs).padStart(9)} ${String(r.slowestMs).padStart(11)} ${String(r.kbs).padStart(6)} ${String(r.crc).padStart(8)} ${String(r.resync).padStart(9)} ${String(r.timeouts).padStart(8)}`,
  );
}
console.log('\nThe rate to ship is the fastest one with zero crc, zero resync and no timeouts.');
