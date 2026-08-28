// Pull a file out of a capture on the card, over KDP, and write it locally.
//
// MEDIA_READ pages: the device returns a binary-flagged frame per request and
// the host reassembles. This exists so a bench can LOOK at what the sensor
// actually produced, which is the only way to tell a corrupt frame from a
// correct frame rendered wrongly.
//
//   npx tsx scripts/kino-pull.mjs --port COM8 --id <uuid> --file C1.JPG --out shot.jpg
import { writeFileSync } from 'node:fs';
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
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const portPath = opt('--port', process.env.KINO_PORT);
const id = opt('--id');
const file = opt('--file', 'C1.JPG');
const out = opt('--out', 'pulled.bin');
const chunk = Number(opt('--chunk', '4096'));
if (!portPath || !id) {
  console.error('usage: kino-pull.mjs --port COM8 --id <uuid> [--file C1.JPG] [--out f.jpg]');
  process.exit(2);
}

const port = new SerialPort({ path: portPath, baudRate: 921600, autoOpen: false });
const decoder = new FrameDecoder();
const waiting = new Map();
let seq = 0;

port.on('data', (buf) => {
  for (const f of decoder.push(new Uint8Array(buf))) {
    if (f.flags & FrameFlags.EVENT) continue;
    const w = waiting.get(f.seq);
    if (w) {
      waiting.delete(f.seq);
      w(f);
    }
  }
});

function request(type, body, timeoutMs = 45000) {
  seq = nextSeq(seq);
  const mine = seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(mine);
      reject(new Error(`timeout on 0x${type.toString(16)} seq ${mine}`));
    }, timeoutMs);
    waiting.set(mine, (f) => {
      clearTimeout(timer);
      resolve(f);
    });
    port.write(
      Buffer.from(
        encodeFrame({ version: 1, type, flags: FrameFlags.NONE, seq: mine, payload: encodeJson(body) }),
      ),
      (e) => e && reject(e),
    );
  });
}

await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));

// Size first, from MEDIA_INFO.
const info = decodeJson((await request(Cmd.MEDIA_INFO, { id })).payload);
const entry = (info.files ?? []).find((f) => f.name === file);
if (!entry) {
  console.error(`${file} not in capture ${id}. files: ${(info.files ?? []).map((f) => f.name).join(', ')}`);
  process.exit(1);
}
const total = entry.sizeBytes;
console.log(`${file}: ${total} B`);

const parts = [];
let got = 0;
while (got < total) {
  const want = Math.min(chunk, total - got);
  const f = await request(Cmd.MEDIA_READ, { id, file, offset: got, length: want });
  // A binary-flagged response carries the bytes; a JSON one carries an error.
  if (!(f.flags & FrameFlags.BINARY)) {
    console.error(`at ${got}/${total}: ${JSON.stringify(decodeJson(f.payload))}`);
    process.exit(1);
  }
  if (f.payload.length === 0) {
    console.error(`at ${got}/${total}: empty page, stopping`);
    break;
  }
  parts.push(Buffer.from(f.payload));
  got += f.payload.length;
  process.stdout.write(`\r  ${got}/${total} B (${Math.round((got * 100) / total)}%)`);
}
process.stdout.write('\n');

const data = Buffer.concat(parts);
writeFileSync(out, data);

// Report what it is, so a truncated or non-JPEG file is obvious immediately.
const soi = data.length >= 2 && data[0] === 0xff && data[1] === 0xd8;
const eoi = data.length >= 2 && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9;
console.log(`wrote ${out}: ${data.length} B  SOI=${soi} EOI=${eoi}`);
port.close();
