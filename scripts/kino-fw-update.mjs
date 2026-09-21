#!/usr/bin/env node
// Push a firmware image to the camera over KDP, the way Studio's updater does
// (apps/studio/src/firmware/updater.ts), from the bench:
//
//   npx tsx scripts/kino-fw-update.mjs --port COM8 --target p4 \
//       --image firmware/p4/build-hand-radio/kino-p4.bin [--version 0.4.58]
//   npx tsx scripts/kino-fw-update.mjs --port COM8 --target cam2 \
//       --image firmware/camnode/build/kino-camnode.bin
//
// FW_BEGIN names the target, the size and the SHA-256 of the whole file;
// FW_CHUNK carries an 8-byte little-endian sessionId/offset header and up to
// the chunkSize the device asked for; FW_END verifies and applies. For the P4
// the link drops as it restarts, so the script reopens the port and asks
// GET_DEVICE_INFO what is running. For a camera node it polls FW_STATUS until
// the node says "ready" or "error".
//
// --corrupt flips one byte after hashing, so FW_END must answer
// CHECKSUM_FAILED and the device must not switch slots: the negative test.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SerialPort } from 'serialport';
import {
  FrameDecoder,
  decodeJson,
  encodeFrame,
  encodeJson,
  nextSeq,
} from '../packages/kdp/src/protocol/packet.ts';
import { Cmd, FrameFlags } from '../packages/kdp/src/protocol/commands.ts';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const has = (name) => args.includes(name);

const portPath = opt('--port', 'COM8');
const target = opt('--target', 'p4');
const imagePath = opt('--image', null);
const version = opt('--version', '');
const settleMs = Number(opt('--settle', '12000'));
if (!imagePath) {
  console.error('need --image <file.bin>');
  process.exit(2);
}
const image = new Uint8Array(readFileSync(imagePath));
const sha256 = createHash('sha256').update(image).digest('hex');
if (has('--corrupt')) image[Math.floor(image.length / 2)] ^= 0xff;

let port = null;
let decoder = null;
let seq = 0;
const waiting = new Map();

function attach(p) {
  decoder = new FrameDecoder();
  p.on('data', (chunk) => {
    for (const frame of decoder.push(new Uint8Array(chunk))) {
      if (frame.flags & FrameFlags.EVENT) continue;
      const pending = waiting.get(frame.seq);
      if (pending) {
        waiting.delete(frame.seq);
        pending(frame);
      }
    }
  });
}
function open(path) {
  return new Promise((resolve, reject) => {
    const p = new SerialPort({ path, baudRate: 921600, autoOpen: false });
    p.open((err) => {
      if (err) return reject(err);
      attach(p);
      port = p;
      resolve(p);
    });
  });
}
function close() {
  return new Promise((resolve) => {
    if (!port) return resolve();
    port.close(() => resolve());
    port = null;
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(type, body, flags = FrameFlags.NONE, timeoutMs = 8000) {
  seq = nextSeq(seq);
  const mySeq = seq;
  const payload = body === undefined ? new Uint8Array(0) : body instanceof Uint8Array ? body : encodeJson(body);
  const frame = { version: 1, type, flags, seq: mySeq, payload };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(mySeq);
      reject(new Error(`timeout after ${timeoutMs} ms waiting for 0x${type.toString(16)}`));
    }, timeoutMs);
    waiting.set(mySeq, (f) => {
      clearTimeout(timer);
      let parsed;
      try {
        parsed = decodeJson(f.payload);
      } catch {
        parsed = { _bytes: f.payload.length };
      }
      resolve({ ok: !(f.flags & FrameFlags.ERROR), body: parsed });
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

async function hello() {
  return request(Cmd.HELLO, { hostEpochMs: Date.now(), hostUtcOffsetMin: -new Date().getTimezoneOffset() }, FrameFlags.NONE, 3000);
}

async function main() {
  await open(portPath);
  console.log(`opened ${portPath}; settling ${settleMs} ms for the reset the open caused`);
  await sleep(settleMs);
  const h = await hello();
  if (!h.ok) throw new Error(`HELLO refused: ${JSON.stringify(h.body)}`);
  const before = await request(Cmd.GET_DEVICE_INFO, {}, FrameFlags.NONE, 3000);
  console.log(`device: p4 ${before.body?.p4Firmware ?? '?'}, cameras ${JSON.stringify(before.body?.cameraFirmware ?? [])}`);

  const t0 = Date.now();
  const begin = await request(Cmd.FW_BEGIN, { target, size: image.length, sha256, version }, FrameFlags.NONE, 12000);
  if (!begin.ok) throw new Error(`FW_BEGIN refused: ${JSON.stringify(begin.body)}`);
  const chunkSize = Math.min(Math.max(begin.body.chunkSize || 4096, 1024), 8192);
  const sessionId = begin.body.sessionId;
  console.log(`FW_BEGIN ok: session ${sessionId}, chunk ${chunkSize} B, image ${image.length} B, sha ${sha256.slice(0, 12)}…${has('--corrupt') ? ' (one byte corrupted after hashing)' : ''}`);

  let sent = 0;
  let lastPct = -1;
  for (let offset = 0; offset < image.length; offset += chunkSize) {
    const data = image.subarray(offset, Math.min(offset + chunkSize, image.length));
    const payload = new Uint8Array(8 + data.length);
    const view = new DataView(payload.buffer);
    view.setUint32(0, sessionId, true);
    view.setUint32(4, offset, true);
    payload.set(data, 8);
    const res = await request(Cmd.FW_CHUNK, payload, FrameFlags.BINARY, 8000);
    if (!res.ok) throw new Error(`FW_CHUNK at ${offset} refused: ${JSON.stringify(res.body)}`);
    sent += data.length;
    const pct = Math.floor((sent * 100) / image.length);
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      console.log(`  ${pct}%  ${sent} B  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
  }
  const kbps = (sent / 1024 / ((Date.now() - t0) / 1000)).toFixed(1);
  console.log(`sent ${sent} B in ${((Date.now() - t0) / 1000).toFixed(1)} s (${kbps} KB/s)`);

  const end = await request(Cmd.FW_END, {}, FrameFlags.NONE, 20000);
  console.log(`FW_END: ${end.ok ? 'OK' : 'NACK'} ${JSON.stringify(end.body)}`);
  if (!end.ok) {
    const st = await request(Cmd.FW_STATUS, { target }, FrameFlags.NONE, 3000);
    console.log(`FW_STATUS: ${JSON.stringify(st.body)}`);
    await close();
    process.exit(has('--corrupt') && end.body?.code === 'CHECKSUM_FAILED' ? 0 : 1);
  }

  if (target === 'p4') {
    console.log('the P4 restarts into the new slot; reopening in 10 s');
    await close();
    await sleep(10000);
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        await open(portPath);
        break;
      } catch (err) {
        console.log(`  reopen ${attempt}: ${err.message}`);
        await sleep(3000);
      }
    }
    if (!port) throw new Error('the port did not come back');
    await sleep(settleMs);
    const h2 = await hello();
    const info = await request(Cmd.GET_DEVICE_INFO, {}, FrameFlags.NONE, 3000);
    console.log(`back: HELLO ${h2.ok ? 'ok' : 'refused'}; p4Firmware ${info.body?.p4Firmware ?? '?'}`);
    const q = await request(Cmd.FW_QUERY, {}, FrameFlags.NONE, 3000);
    console.log(`FW_QUERY: ${JSON.stringify(q.body?.targets?.p4)}`);
  } else {
    const deadline = Date.now() + 120000;
    let state = 'verifying';
    while (Date.now() < deadline) {
      await sleep(1500);
      const st = await request(Cmd.FW_STATUS, { target }, FrameFlags.NONE, 3000);
      if (st.body?.state !== state) console.log(`  ${target}: ${st.body?.state}${st.body?.error ? ` (${st.body.error})` : ''}`);
      state = st.body?.state;
      if (state === 'ready' || state === 'error') break;
    }
    console.log(`final: ${state}`);
    if (state !== 'ready') process.exitCode = 1;
  }
  await close();
}

main().catch(async (err) => {
  console.error(`FAILED: ${err.message}`);
  await close();
  process.exit(1);
});
