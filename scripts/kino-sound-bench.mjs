// Custom sounds over USB, from a terminal.
//
// kino-bench.mjs can send any command whose body is JSON, and SOUND_CHUNK's
// body is not: it is eight bytes of little-endian header followed by raw WAV.
// That is the whole reason this script exists as a second one rather than a
// flag on the first - a bench instrument that could not send the binary frame
// could not exercise the transfer at all.
//
//   npx tsx scripts/kino-sound-bench.mjs --port COM8 list
//   npx tsx scripts/kino-sound-bench.mjs --port COM8 upload clip.wav snd-test "Test clip"
//   npx tsx scripts/kino-sound-bench.mjs --port COM8 upload - snd-tone "880 Hz"
//   npx tsx scripts/kino-sound-bench.mjs --port COM8 read snd-test out.wav
//   npx tsx scripts/kino-sound-bench.mjs --port COM8 delete snd-test
//
// A `-` in place of the file generates a 300 ms 880 Hz sine in the device
// format, so a bring-up run needs nothing prepared in advance.
//
// The framing comes from packages/kdp, imported rather than reimplemented,
// for the reason kino-bench.mjs gives: a second copy of the encoder would let
// a disagreement between tool and product look like a device fault.
import { readFileSync, writeFileSync } from 'node:fs';
import { SerialPort } from 'serialport';
import {
  encodeFrame,
  FrameDecoder,
  encodeJson,
  decodeJson,
  nextSeq,
} from '../packages/kdp/src/protocol/packet.ts';
import { Cmd, FrameFlags } from '../packages/kdp/src/protocol/commands.ts';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const portPath = opt('--port', process.env.KINO_PORT);
const VALUED = new Set(['--port', '--baud', '--timeout']);
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  if (VALUED.has(args[i])) i += 1;
  else if (!args[i].startsWith('--')) positional.push(args[i]);
}
const [verb, ...rest] = positional;

const USAGE = `usage: kino-sound-bench.mjs --port <COM8|/dev/ttyACM0> <verb>
  list
  upload <file.wav|-> <id> [name]   ( - generates a 300 ms 880 Hz test tone )
  read   <id> <out.wav> [file.wav]  ( the third file is compared byte for byte )
  delete <id>`;

if (!portPath || !verb) {
  console.error(USAGE);
  process.exit(2);
}

const baud = Number(opt('--baud', '921600'));
const timeoutMs = Number(opt('--timeout', '15000'));

// The device answers {chunkSize: 8192} and Studio's transfer manager caps at
// the same number. Used as the default until SOUND_BEGIN says otherwise.
const CHUNK = 8192;
const SAMPLE_RATE = 16000;

const port = new SerialPort({ path: portPath, baudRate: baud, autoOpen: false });
const decoder = new FrameDecoder();
let seq = 0;
const waiting = new Map();

port.on('data', (chunk) => {
  for (const frame of decoder.push(new Uint8Array(chunk))) {
    if (frame.flags & FrameFlags.EVENT) continue;
    const pending = waiting.get(frame.seq);
    if (pending) {
      waiting.delete(frame.seq);
      pending(frame);
    }
  }
});

/**
 * One request, one response.
 *
 * `payload` goes on the wire as-is and `binary` sets KDP_FLAG_BINARY, which
 * is what tells the firmware not to try to parse the body as JSON. Both
 * matter only for SOUND_CHUNK; everything else here is a JSON body.
 */
function request(type, payload, binary = false) {
  seq = nextSeq(seq);
  const mySeq = seq;
  const frame = {
    version: 1,
    type,
    flags: binary ? FrameFlags.BINARY : FrameFlags.NONE,
    seq: mySeq,
    payload: payload ?? new Uint8Array(0),
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(mySeq);
      reject(new Error(`timeout after ${timeoutMs} ms waiting for 0x${type.toString(16)}`));
    }, timeoutMs);
    waiting.set(mySeq, (f) => {
      clearTimeout(timer);
      const ok = !(f.flags & FrameFlags.ERROR);
      const isBinary = Boolean(f.flags & FrameFlags.BINARY);
      let body = null;
      if (!isBinary || !ok) {
        try {
          body = decodeJson(f.payload);
        } catch (err) {
          body = { _unparsed: String(err), _bytes: f.payload.length };
        }
      }
      resolve({ ok, body, bytes: f.payload, isBinary });
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

function json(type, body) {
  return request(type, body === undefined ? undefined : encodeJson(body), false);
}

/** Every reply is printed. A transcript that skipped the boring ones would
 *  not be a record of what the device said. */
function show(label, res) {
  const tag = res.ok ? 'OK  ' : 'NACK';
  const what = res.isBinary && res.ok ? `${res.bytes.length} bytes` : JSON.stringify(res.body);
  console.log(`${tag} ${label.padEnd(28)} ${what}`);
  return res;
}

/** Stop on the first refusal: every step below depends on the one before, and
 *  continuing turns one clear NACK into four confusing ones. */
function must(label, res) {
  show(label, res);
  if (!res.ok) {
    console.error(`\n${label} was refused - stopping.`);
    port.close();
    process.exit(1);
  }
  return res;
}

/* ---- the test clip, in the format the device stores ---- */

/**
 * A 300 ms 880 Hz sine, 16 kHz mono 16-bit PCM.
 *
 * The header layout is the one in packages/test-fixtures/src/deviceAudio.ts,
 * field for field, because that is what Studio and the mock write and this
 * script exists to prove the firmware accepts the same bytes they do.
 */
function makeTestWav(ms = 300, hz = 880) {
  const samples = Math.round((SAMPLE_RATE * ms) / 1000);
  const dataLen = samples * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples; i++) {
    // A short fade at each end, so the clip does not start and stop on a
    // step. A discontinuity into a class-D amp is a click that has nothing to
    // do with the tone being tested.
    const fade = Math.min(1, i / 160, (samples - i) / 160);
    const v = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * 0.6 * fade;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return new Uint8Array(buf);
}

function loadWav(spec) {
  if (spec === '-' || spec === undefined) {
    const wav = makeTestWav();
    console.log(`generated a 300 ms 880 Hz test clip: ${wav.length} bytes`);
    return wav;
  }
  return new Uint8Array(readFileSync(spec));
}

/** Milliseconds of PCM in a device-format clip: everything past the 44-byte
 *  header, at 32 bytes per millisecond. */
const durationOf = (wav) => Math.round((wav.length - 44) / 32);

/* ---- the verbs ---- */

async function doList() {
  show('GET_SOUNDS', await json(Cmd.GET_SOUNDS));
}

async function doUpload(fileSpec, id, name) {
  if (!id) {
    console.error(USAGE);
    process.exit(2);
  }
  const wav = loadWav(fileSpec);

  must('GET_SOUNDS (before)', await json(Cmd.GET_SOUNDS));
  const begin = must(
    'SOUND_BEGIN',
    await json(Cmd.SOUND_BEGIN, {
      id,
      name: name ?? id,
      sizeBytes: wav.length,
      durationMs: durationOf(wav),
    }),
  );
  const sessionId = begin.body.sessionId;
  const chunkSize = Math.min(begin.body.chunkSize || CHUNK, CHUNK);

  for (let offset = 0; offset < wav.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, wav.length);
    // u32 sessionId LE, u32 offset LE, then the bytes - the layout
    // apps/studio/src/device/KinoDevice.ts soundChunk() writes.
    const payload = new Uint8Array(8 + (end - offset));
    const view = new DataView(payload.buffer);
    view.setUint32(0, sessionId, true);
    view.setUint32(4, offset, true);
    payload.set(wav.subarray(offset, end), 8);
    must(`SOUND_CHUNK @${offset}`, await request(Cmd.SOUND_CHUNK, payload, true));
  }

  must('SOUND_END', await json(Cmd.SOUND_END));
  show('GET_SOUNDS (after)', await json(Cmd.GET_SOUNDS));
}

async function doRead(id, outPath, comparePath) {
  if (!id || !outPath) {
    console.error(USAGE);
    process.exit(2);
  }
  const listed = must('GET_SOUNDS', await json(Cmd.GET_SOUNDS));
  const info = (listed.body.custom ?? []).find((s) => s.id === id);
  if (!info) {
    console.error(`\n${id} is not on the device.`);
    port.close();
    process.exit(1);
  }

  const parts = [];
  let offset = 0;
  while (offset < info.sizeBytes) {
    const length = Math.min(CHUNK, info.sizeBytes - offset);
    const res = must(`SOUND_READ @${offset}`, await request(Cmd.SOUND_READ, encodeJson({ id, offset, length })));
    // A zero-length reply is the device saying "end of file". Believing it is
    // what stops this looping forever on a clip shorter than its own listing.
    if (res.bytes.length === 0) {
      console.error(`\nread stopped short: ${offset} of ${info.sizeBytes} bytes`);
      break;
    }
    parts.push(Buffer.from(res.bytes));
    offset += res.bytes.length;
  }

  const got = Buffer.concat(parts);
  writeFileSync(outPath, got);
  console.log(`\nwrote ${got.length} bytes to ${outPath}`);

  if (comparePath) {
    const want = Buffer.from(loadWav(comparePath));
    const same = want.length === got.length && want.equals(got);
    console.log(`byte-identical to ${comparePath}: ${same ? 'YES' : 'NO'}`);
    if (!same) {
      let at = -1;
      for (let i = 0; i < Math.min(want.length, got.length); i++) {
        if (want[i] !== got[i]) {
          at = i;
          break;
        }
      }
      console.log(` sent ${want.length} B, read back ${got.length} B, first difference at ${at}`);
    }
  }
}

async function doDelete(id) {
  if (!id) {
    console.error(USAGE);
    process.exit(2);
  }
  show('SOUND_DELETE', await json(Cmd.SOUND_DELETE, { id }));
  show('GET_SOUNDS (after)', await json(Cmd.GET_SOUNDS));
}

/* ---- run ---- */

await new Promise((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
console.log(`opened ${portPath} @ ${baud}`);
// HELLO first: the firmware's other commands work without it, but a link that
// is not there fails here, on one line, instead of as a timeout in the middle
// of a sixteen-chunk transfer.
must('HELLO', await json(Cmd.HELLO, { hostEpochMs: Date.now(), hostUtcOffsetMin: -new Date().getTimezoneOffset() }));

switch (verb) {
  case 'list':
    await doList();
    break;
  case 'upload':
    await doUpload(rest[0], rest[1], rest[2]);
    break;
  case 'read':
    await doRead(rest[0], rest[1], rest[2]);
    break;
  case 'delete':
    await doDelete(rest[0]);
    break;
  default:
    console.error(USAGE);
    port.close();
    process.exit(2);
}

console.log(`\n--- decoder stats --- ${JSON.stringify(decoder.stats)}`);
port.close();
