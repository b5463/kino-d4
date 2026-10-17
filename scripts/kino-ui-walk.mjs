// See and drive the camera's own screen from the bench, over KDP (#246).
//
//   npx tsx scripts/kino-ui-walk.mjs --port COM8 --out menu.png       one screenshot
//   npx tsx scripts/kino-ui-walk.mjs --port COM8 --tap 190,58         a tap, logical px
//   npx tsx scripts/kino-ui-walk.mjs --port COM8 --key shutter        or --key fn [--long]
//   npx tsx scripts/kino-ui-walk.mjs --port COM8 --plate on --out plate.png
//   npx tsx scripts/kino-ui-walk.mjs --port COM8 --walk --dir walk/   every main screen
//   npx tsx scripts/kino-ui-walk.mjs --mock --walk --dir walk/        the reference device
//
// Actions run in this order when several are given: --plate, --key, --tap,
// then --out, so `--tap 190,58 --out look.png` saves the screen the tap
// opened.
//
// GET_SCREEN renders the screen once on the body and pages it out, 3072 bytes
// a page, 250 pages a screen. The body refuses a page once the canvas moved
// on (INVALID_STATE) and a render while a move runs (BUSY); both are retried
// here. The PNG is the RGB565 picture expanded the way host_preview's PPM
// writer expands it, so a screenshot and a render of the same state compare
// pixel for pixel.
//
// --walk visits MENU, SHOOT, LOOK, GALLERY, ROLL, SETTINGS and its five
// screens, STATUS too when the body reports a condition, and POWER, saving
// each, and checks the body named the screen it expected. The taps are the right-hand layout (ui.c, from_hand()) mirrored
// for --hand left; the hand is read from GET_CONFIG when not given. It opens
// nothing destructive: no dialog, no capture, no setting changed. Before the
// first picture it lifts a dim scrim (SHOOT and back) or wakes a dark screen,
// so 01-menu.png is not darkened by a body that idled past body.autoDimS.
//
// Opening the port does not reset the body; --settle waits anyway, for a body
// that was just flashed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { KinoProtocolClient } from '../packages/kdp/src/protocol/KinoProtocolClient.ts';
import { MockTransport } from '../packages/kdp/src/transport/MockTransport.ts';
import { NodeSerialTransport } from '../packages/kdp/src/transport/NodeSerialTransport.ts';
import { PROTOCOL_VERSION } from '../packages/kdp/src/protocol/commands.ts';
import { KinoCommandError } from '../packages/kdp/src/protocol/KinoProtocolClient.ts';
import { KinoDevice } from '../apps/studio/src/device/KinoDevice.ts';

const USAGE = `usage: npx tsx scripts/kino-ui-walk.mjs (--port <COM8> | --mock) [actions]

  --port <path>      serial port (env KINO_PORT is the fallback)
  --mock             the reference device instead of a camera
  --settle <ms>      wait after opening the port, default 1500
  --plate on|off     the test plate
  --key shutter|fn   a key press; --long adds the hold report
  --tap x,y          a tap at logical x 0..799, y 0..479; --hold <ms>, default 80
  --out <file.png>   save the screen as it is after the actions above
  --walk             visit every main screen and save each
  --dir <dir>        where --walk saves, default ui-walk
  --hand right|left  the layout --walk taps, default the body's body.hand

Exit status: 0 when everything asked for happened, 1 when a step failed, 2
for a usage or link failure.`;

const args = process.argv.slice(2);
const VALUED = new Set(['--port', '--settle', '--plate', '--key', '--tap', '--hold', '--out', '--dir', '--hand']);
const FLAGS = new Set(['--mock', '--long', '--walk', '--help', '-h']);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);
const usage = (msg) => {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(2);
};

if (has('-h') || has('--help')) {
  console.log(USAGE);
  process.exit(0);
}
for (const a of args) {
  if (a.startsWith('-') && !VALUED.has(a) && !FLAGS.has(a)) usage(`unknown option: ${a}`);
}
for (const flag of VALUED) {
  const i = args.indexOf(flag);
  if (i >= 0 && (args[i + 1] === undefined || args[i + 1].startsWith('--'))) usage(`${flag} needs a value`);
}

const mock = has('--mock');
const portPath = opt('--port', process.env.KINO_PORT);
if (!mock && !portPath) usage('--port or --mock is required');
const settleMs = Number(opt('--settle', '1500'));
const plate = opt('--plate');
if (plate !== undefined && plate !== 'on' && plate !== 'off') usage('--plate takes on or off');
const key = opt('--key');
if (key !== undefined && key !== 'shutter' && key !== 'fn') usage('--key takes shutter or fn');
const tapArg = opt('--tap');
let tap = null;
if (tapArg !== undefined) {
  const m = /^(\d+),(\d+)$/.exec(tapArg);
  if (!m) usage('--tap takes x,y in logical px, e.g. 190,58');
  tap = { x: Number(m[1]), y: Number(m[2]) };
}
const holdMs = Number(opt('--hold', '80'));
const outPath = opt('--out');
const walk = has('--walk');
const dir = opt('--dir', 'ui-walk');
const handArg = opt('--hand');
if (handArg !== undefined && handArg !== 'right' && handArg !== 'left') usage('--hand takes right or left');
if (!plate && !key && !tap && !outPath && !walk) usage('nothing to do');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the link ----

let transport;
if (mock) {
  const { MockKinoDevice } = await import('../packages/test-fixtures/src/index.ts');
  transport = new MockTransport(new MockKinoDevice({ ambientCaptures: false }));
} else {
  const { SerialPort } = await import('serialport');
  transport = new NodeSerialTransport(new SerialPort({ path: portPath, baudRate: 921600, autoOpen: false }));
}
const client = new KinoProtocolClient(transport);
const device = new KinoDevice(client);
try {
  await transport.open();
} catch (err) {
  console.error(`could not open ${mock ? 'the reference device' : portPath}: ${err.message ?? err}`);
  process.exit(2);
}
if (!mock && settleMs > 0) await sleep(settleMs);
try {
  const hello = await client.hello({ protocolMin: PROTOCOL_VERSION, protocolMax: PROTOCOL_VERSION, clientVersion: 'kino-ui-walk' });
  if (hello.product !== 'KINO') throw new Error(`device answered as "${hello.product}"`);
  const caps = await device.getCapabilities();
  if (caps.capabilities.screenControl !== true) throw new Error(`firmware ${caps.firmware} has no screenControl`);
  console.log(`${mock ? 'reference device' : portPath}: firmware ${caps.firmware}`);
} catch (err) {
  console.error(`handshake failed: ${err.message ?? err}`);
  await transport.close();
  process.exit(2);
}

// ---- the screen ----

const codeOf = (err) => (err instanceof KinoCommandError ? err.code : null);

/** One whole picture: render, page it out, and prove the canvas held still. */
async function screenshot() {
  const t0 = Date.now();
  for (let attempt = 0; attempt < 40; attempt++) {
    let info;
    try {
      info = await device.getScreen();
    } catch (err) {
      if (codeOf(err) !== 'BUSY') throw err;
      await sleep(150);
      continue;
    }
    const px = new Uint8Array(info.bytes);
    let offset = 0;
    let stale = false;
    try {
      while (offset < info.bytes) {
        const page = await device.getScreenPage(info.shot, offset, info.chunkMax);
        if (page.length === 0) throw new Error(`empty page at ${offset} of ${info.bytes}`);
        px.set(page, offset);
        offset += page.length;
      }
      const tail = await device.getScreenPage(info.shot, info.bytes, info.chunkMax);
      if (tail.length !== 0) throw new Error('a page past the end was not empty');
    } catch (err) {
      const code = codeOf(err);
      if (code !== 'INVALID_STATE' && code !== 'BUSY') throw err;
      stale = true;
    }
    if (stale) {
      await sleep(150);
      continue;
    }
    const ms = Date.now() - t0;
    return { info, px, ms };
  }
  throw new Error('the screen never held still long enough to read');
}

/** RGB565 little-endian to an 8-bit RGB PNG, expanded as host_preview does. */
function png(info, px) {
  const { width: w, height: h } = info;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 2;
      const v = px[i] | (px[i + 1] << 8);
      const o = row + 1 + x * 3;
      raw[o] = Math.floor((((v >> 11) & 0x1f) * 255) / 31);
      raw[o + 1] = Math.floor((((v >> 5) & 0x3f) * 255) / 63);
      raw[o + 2] = Math.floor(((v & 0x1f) * 255) / 31);
    }
  }
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function save(path) {
  const { info, px, ms } = await screenshot();
  writeFileSync(path, png(info, px));
  const kbs = (info.bytes / 1024 / (ms / 1000)).toFixed(0);
  console.log(`  ${path}: ${info.screen}${info.plate ? ' (plate)' : ''}, ${(ms / 1000).toFixed(1)} s, ${kbs} KB/s`);
  return info;
}

/** The screen the body is on, once nothing is moving. */
async function screenNow() {
  for (let i = 0; i < 40; i++) {
    try {
      return (await device.getScreen()).screen;
    } catch (err) {
      if (codeOf(err) !== 'BUSY') throw err;
      await sleep(150);
    }
  }
  throw new Error('the screen stayed busy for 6 s');
}

/** Tap, then wait for `expect` to be the screen, for up to 3 s. `quiet`
 * leaves a miss to the caller to report. */
async function tapTo(x, y, expect, quiet = false) {
  await device.uiTap(x, y, holdMs);
  const until = Date.now() + 3000;
  let now = null;
  while (Date.now() < until) {
    await sleep(200);
    now = await screenNow();
    if (now === expect) return true;
  }
  if (!quiet) console.log(`  tap ${x},${y} left the body on ${now}, expected ${expect}`);
  return false;
}

// ---- actions ----

let failed = false;
try {
  if (plate) {
    await device.screenPlate(plate === 'on');
    console.log(`plate ${plate}`);
    await sleep(100);
  }
  if (key) {
    await device.uiKey(key, has('--long'));
    console.log(`key ${key}${has('--long') ? ' held' : ''}`);
    await sleep(100);
  }
  if (tap) {
    const r = await device.uiTap(tap.x, tap.y, holdMs);
    console.log(`tap ${tap.x},${tap.y} held ${holdMs} ms, ${r.queued} waiting`);
    await sleep(holdMs + 300);
  }
  if (outPath) await save(outPath);

  if (walk) {
    let hand = handArg;
    if (hand === undefined) {
      try {
        const cfg = await device.getConfig();
        hand = cfg?.config?.body?.hand === 'left' ? 'left' : 'right';
      } catch {
        hand = 'right';
      }
    }
    /* The right-hand layout (ui.c): the SHOOT card on the hand's side, five
     * rows on the other at x 190, Back at the header's hand end, the finder's
     * MENU plate, and the SETTINGS rows hanging from y 79 at a 64 px pitch. */
    const X = (x) => (hand === 'left' ? 799 - x : x);
    const P = {
      card: [X(600), 240],
      back: [X(752), 31],
      finderMenu: [X(726), 31],
      menuRow: (i) => [X(190), 58 + i * 91],
      settingsRow: (i) => [400, 111 + i * 64],
    };
    mkdirSync(dir, { recursive: true });
    console.log(`walk, ${hand} hand, into ${dir}`);

    const power = await device.getPowerStatus().catch(() => null);
    if (power?.displayStage === 'asleep') {
      // A tap on dark glass wakes it and presses nothing.
      await device.uiTap(400, 240, holdMs);
      await sleep(800);
    }
    // Back to the menu from wherever the body is.
    for (let i = 0; i < 4; i++) {
      const s = await screenNow();
      if (s === 'menu') break;
      const [x, y] = s === 'shoot' ? P.finderMenu : P.back;
      await device.uiTap(x, y, holdMs);
      await sleep(700);
    }
    if ((await screenNow()) !== 'menu') throw new Error('could not get back to the menu');

    let n = 0;
    const shot = async (name) => save(join(dir, `${String(++n).padStart(2, '0')}-${name}.png`));
    const step = async (xy, expect) => {
      if (!(await tapTo(xy[0], xy[1], expect))) {
        failed = true;
        return false;
      }
      await sleep(250);
      await shot(expect);
      return true;
    };

    // GET_SCREEN is not activity, and a body left on MENU past body.autoDimS
    // answers with the dim scrim over the picture. A tap on a dim screen is
    // acted on (power.c), so the card and the finder's MENU lift it; a dark
    // screen takes the wake tap first.
    const stage = (await device.getPowerStatus().catch(() => null))?.displayStage;
    if (stage === 'asleep') {
      await device.uiTap(400, 240, holdMs);
      await sleep(800);
    } else if (stage === 'dim') {
      if (!(await tapTo(...P.card, 'shoot')) || !(await tapTo(...P.finderMenu, 'menu'))) {
        throw new Error('could not lift the dim scrim');
      }
    }
    if (stage === 'asleep' || stage === 'dim') await sleep(250);
    await shot('menu');
    if (await step(P.card, 'shoot') && !(await tapTo(...P.finderMenu, 'menu'))) failed = true;
    const rows = ['look', 'gallery', 'roll', 'settings', 'power'];
    for (let i = 0; i < rows.length; i++) {
      if ((await screenNow()) !== 'menu') break;
      if (!(await tapTo(...P.menuRow(i), rows[i]))) {
        failed = true;
        continue;
      }
      await sleep(250);
      await shot(rows[i]);
      if (rows[i] === 'settings') {
        const subs = ['display', 'sound', 'connection', 'storage', 'about', 'status'];
        for (let j = 0; j < subs.length; j++) {
          // STATUS is a sixth row only while the body reports a condition
          // (settings_rows() in ui.c); on a healthy body the tap lands on
          // empty ground and SETTINGS stays.
          const optional = subs[j] === 'status';
          if (!(await tapTo(...P.settingsRow(j), subs[j], optional))) {
            if (optional && (await screenNow()) === 'settings') {
              console.log('  STATUS: no row, the body reports no condition');
              continue;
            }
            if (optional) console.log(`  tap on the STATUS row left the body off SETTINGS`);
            failed = true;
            continue;
          }
          await sleep(250);
          await shot(subs[j]);
          if (!(await tapTo(...P.back, 'settings'))) {
            failed = true;
            break;
          }
        }
      }
      if (!(await tapTo(...P.back, 'menu'))) failed = true;
    }
    // The walk ends on the menu, where it began.
  }
} catch (err) {
  console.error(`failed: ${err.message ?? err}`);
  failed = true;
}

client.dispose();
await transport.close();
process.exit(failed ? 1 : 0);
