// A soak from the bench: one session, N host captures spaced by --gap ms,
// then the runtime stats and the log. Opening the port resets the body, so
// this stays in one session instead of one kino-bench call per capture.
//
//   npx tsx scripts/kino-soak.mjs --port COM8 --n 60 --gap 12000
import { SerialPort } from 'serialport';
import { FrameDecoder, decodeJson, encodeFrame, encodeJson, nextSeq } from '../packages/kdp/src/protocol/packet.ts';
import { Cmd, FrameFlags } from '../packages/kdp/src/protocol/commands.ts';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt; };
const portPath = opt('--port', 'COM8');
const N = Number(opt('--n', '30'));
const gapMs = Number(opt('--gap', '12000'));
const settleMs = Number(opt('--settle', '14000'));

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
    port.write(Buffer.from(encodeFrame(frame)), (err) => { if (err) { clearTimeout(timer); waiting.delete(mySeq); reject(err); } });
  });
}

console.log(`opened ${portPath}; settling ${settleMs} ms`);
await sleep(settleMs);
const h = await request(Cmd.HELLO, { hostEpochMs: Date.now(), hostUtcOffsetMin: -new Date().getTimezoneOffset() }, 3000);
if (!h.ok) throw new Error('HELLO refused');
const before = await request(Cmd.GET_RUNTIME_STATS, {}, 4000);
const heap = (b) => ({ freeHeapKB: b?.freeHeapKB, internalFreeKB: b?.internalFreeKB, freePsramKB: b?.freePsramKB, memory: b?.memory });
console.log('before:', JSON.stringify(heap(before.body)));

let okN = 0, partial = 0, failed = 0, totalMs = 0, worst = 0;
const t0 = Date.now();
for (let i = 1; i <= N; i++) {
  let r;
  try { r = await request(Cmd.CAMERA_CAPTURE, {}, 20000); } catch (e) { r = { ok: false, body: { code: 'TIMEOUT', message: e.message } }; }
  if (r.ok) {
    okN++;
    const frames = r.body?.frameCount ?? r.body?.frames?.length ?? '?';
    const ms = r.body?.totalMs ?? 0;
    totalMs += ms; if (ms > worst) worst = ms;
    if (r.body?.status === 'partial') partial++;
    console.log(`#${i} ok ${r.body?.id ?? ''} frames=${frames} ${ms} ms${r.body?.status === 'partial' ? ' PARTIAL' : ''}`);
  } else {
    failed++;
    console.log(`#${i} FAIL ${r.body?.code ?? ''} ${r.body?.message ?? ''}`);
  }
  if (i < N) await sleep(gapMs);
}
const after = await request(Cmd.GET_RUNTIME_STATS, {}, 4000);
console.log('after:', JSON.stringify(heap(after.body)));
const tasks = after.body?.tasks ?? [];
for (const t of tasks) if (/cap|ui|kdp|vf|gal|upl|card/i.test(t.name)) console.log(`  task ${t.name} minFree ${t.minFreeBytes}`);
console.log(`summary: ${okN}/${N} ok, ${partial} partial, ${failed} failed, mean ${okN ? Math.round(totalMs / okN) : 0} ms, worst ${worst} ms, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
const logs = await request(Cmd.GET_LOGS, { limit: 40 }, 8000).catch(() => null);
for (const e of logs?.body?.entries ?? []) if (/panic|crash|heap|reserve|lost|timeout|error|fail/i.test(e.msg)) console.log(`  log ${e.src} ${e.msg}`);
port.close();
