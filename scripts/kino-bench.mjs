// Bench client: KDP over a serial port, from a terminal.
//
// Studio talks to the camera over Web Serial, which needs a browser and a
// human to pick the port. Bring-up needs the same conversation from a script,
// so the transcript can go into a hardware record. This is that client.
//
//   npx tsx scripts/kino-bench.mjs --port COM8 GET_DEVICE_INFO
//   npx tsx scripts/kino-bench.mjs --port COM8 --sanity
//   npx tsx scripts/kino-bench.mjs --port COM8 STORAGE_BENCH '{"sizeKB":1024}'
//
// The framing comes from packages/kdp — the same encoder and stream decoder
// Studio uses, imported rather than reimplemented. A second copy of the
// framing on the bench would mean a disagreement between tool and product
// could look like a device fault, which is the one thing a bring-up
// instrument must never do.
import { SerialPort } from 'serialport';
import {
  encodeFrame,
  FrameDecoder,
  encodeJson,
  decodeJson,
  nextSeq,
} from '../packages/kdp/src/protocol/packet.ts';
import { Cmd, Evt, FrameFlags } from '../packages/kdp/src/protocol/commands.ts';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const portPath = opt('--port', process.env.KINO_PORT);
if (!portPath) {
  console.error('usage: kino-bench.mjs --port <COM8|/dev/ttyACM0> [--sanity] [CMD [json]]');
  process.exit(2);
}
// USB-Serial-JTAG ignores the line rate, but a real UART bridge does not.
const baud = Number(opt('--baud', '921600'));
const timeoutMs = Number(opt('--timeout', '15000'));

const port = new SerialPort({ path: portPath, baudRate: baud, autoOpen: false });
const decoder = new FrameDecoder();
let seq = 0;

/** Responses keyed by the sequence they answer. */
const waiting = new Map();
/** Events arrive unasked; keep them for the transcript. */
const events = [];

port.on('data', (chunk) => {
  for (const frame of decoder.push(new Uint8Array(chunk))) {
    if (frame.flags & FrameFlags.EVENT) {
      events.push({ at: Date.now(), type: frame.type, payload: safeJson(frame.payload) });
      continue;
    }
    const pending = waiting.get(frame.seq);
    if (pending) {
      waiting.delete(frame.seq);
      pending.resolve(frame);
    }
  }
});

function safeJson(payload) {
  try {
    return decodeJson(payload);
  } catch {
    return { _raw: Buffer.from(payload).toString('hex').slice(0, 120) };
  }
}

function open() {
  return new Promise((resolve, reject) =>
    port.open((err) => (err ? reject(err) : resolve())),
  );
}

/** One request, one response, or a rejection on timeout. */
function request(type, body) {
  seq = nextSeq(seq);
  const mySeq = seq;
  const payload = body === undefined ? new Uint8Array(0) : encodeJson(body);
  const frame = { version: 1, type, flags: FrameFlags.NONE, seq: mySeq, payload };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(mySeq);
      reject(new Error(`timeout after ${timeoutMs} ms waiting for 0x${type.toString(16)}`));
    }, timeoutMs);
    waiting.set(mySeq, {
      resolve: (f) => {
        clearTimeout(timer);
        resolve({
          ok: !(f.flags & FrameFlags.ERROR),
          flags: f.flags,
          body: safeJson(f.payload),
          bytes: f.payload.length,
        });
      },
    });
    port.write(Buffer.from(encodeFrame(frame)), (err) => {
      if (err) {
        clearTimeout(timer);
        waiting.delete(mySeq);
        reject(err);
      }
    });
  });
}

const show = (label, res) => {
  const tag = res.ok ? 'OK  ' : 'NACK';
  console.log(`\n=== ${label} — ${tag} (${res.bytes} B) ===`);
  console.log(JSON.stringify(res.body, null, 1));
};

async function run(label, type, body) {
  const t0 = process.hrtime.bigint();
  try {
    const res = await request(type, body);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    show(`${label}  [${ms.toFixed(1)} ms]`, res);
    return res;
  } catch (err) {
    console.log(`\n=== ${label} — FAILED ===\n ${err.message}`);
    return null;
  }
}

// §7 of the M1 runbook: prove the instruments before trusting them to
// diagnose a camera. Ordered so a dead link is obvious at the first line
// rather than after nine timeouts.
const SANITY = [
  ['HELLO', Cmd.HELLO, { hostEpochMs: Date.now(), hostUtcOffsetMin: -new Date().getTimezoneOffset() }],
  ['GET_DEVICE_INFO', Cmd.GET_DEVICE_INFO],
  ['GET_CAPABILITIES', Cmd.GET_CAPABILITIES],
  ['GET_STORAGE_STATUS', Cmd.GET_STORAGE_STATUS],
  ['GET_RUNTIME_STATS', Cmd.GET_RUNTIME_STATS],
  ['GET_HW_VALIDATION', Cmd.GET_HW_VALIDATION],
  ['GET_LOGS', Cmd.GET_LOGS, { limit: 40 }],
];

await open();
console.log(`opened ${portPath} @ ${baud}`);

if (has('--sanity')) {
  for (const [label, type, body] of SANITY) await run(label, type, body);
} else {
  // Positionals only: --port COM8 would otherwise offer COM8 as a command,
  // since it matches the shape of one.
  const VALUED = new Set(['--port', '--baud', '--timeout']);
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (VALUED.has(args[i])) i += 1;
    else if (!args[i].startsWith('--')) positional.push(args[i]);
  }
  const name = positional.find((a) => /^[A-Z][A-Z0-9_]+$/.test(a));
  const jsonArg = positional.find((a) => a.trim().startsWith('{'));
  if (!name || Cmd[name] === undefined) {
    console.error(`unknown command: ${name}. Known: ${Object.keys(Cmd).join(', ')}`);
    process.exit(2);
  }
  await run(name, Cmd[name], jsonArg ? JSON.parse(jsonArg) : undefined);
}

console.log(`\n--- decoder stats --- ${JSON.stringify(decoder.stats)}`);
if (events.length) {
  console.log(`--- ${events.length} event(s) ---`);
  for (const e of events) {
    const name = Object.keys(Evt).find((k) => Evt[k] === e.type) ?? `0x${e.type.toString(16)}`;
    console.log(` ${name}: ${JSON.stringify(e.payload).slice(0, 200)}`);
  }
}
port.close();
