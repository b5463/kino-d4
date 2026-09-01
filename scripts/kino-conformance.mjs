// Conformance runner: the 32-case protocol suite against real hardware, from
// a terminal.
//
//   npx tsx scripts/kino-conformance.mjs --port COM8
//   npx tsx scripts/kino-conformance.mjs --port COM8 --passive
//   npx tsx scripts/kino-conformance.mjs --port COM8 --json bench/0.4.17.json
//
// Until now the suite could only be run by a human clicking through Studio's
// DEVELOPER panel over Web Serial, so nothing checked Studio against physical
// firmware between 0.4.9 and 0.4.17 — eight releases that each moved the
// contract the suite polices. A conformance record that needs a browser and a
// mouse is a record nobody produces.
//
// The cases themselves are imported, never reimplemented:
// apps/studio/src/developer/conformance.ts is the one definition of what
// conformance means, and Studio's DEVELOPER panel and this script run the same
// array against the same KinoDevice facade over the same protocol client. Only
// the bottom byte-mover differs — NodeSerialTransport here, SerialTransport in
// the browser — which is the whole point: if this run is green and Studio is
// not, the difference is Studio's UI, not the contract.
import { writeFileSync } from 'node:fs';
import { SerialPort } from 'serialport';
import { KinoProtocolClient } from '../packages/kdp/src/protocol/KinoProtocolClient.ts';
import { NodeSerialTransport } from '../packages/kdp/src/transport/NodeSerialTransport.ts';
import { Evt, PROTOCOL_VERSION } from '../packages/kdp/src/protocol/commands.ts';
import { KinoDevice } from '../apps/studio/src/device/KinoDevice.ts';
import {
  conformanceCaseCount,
  runConformance,
} from '../apps/studio/src/developer/conformance.ts';

const CLIENT_NAME = 'kino-conformance';

const args = process.argv.slice(2);
const VALUED = new Set(['--port', '--baud', '--timeout', '--json', '--case']);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const USAGE = `usage: npx tsx scripts/kino-conformance.mjs --port <COM8|/dev/ttyACM0> [options]

  --port <path>     serial port (env KINO_PORT is the fallback)
  --baud <rate>     line rate, default 921600
  --passive         skip the active cases (no captures, no writes, no mode changes)
  --timeout <ms>    wall-clock budget for the whole suite, default 300000
  --json <file>     write the results as JSON as well as printing them
  --case <text>     report only cases whose name contains <text> (see note below)
  -h, --help        this text

The suite runs whole even with --case: later cases consume state earlier ones
produce (a capture's id is what MEDIA_READ reads), so there is no honest way to
start in the middle. --case narrows what is printed and what the exit status
considers, not what executes.

Per-command timeouts belong to the protocol client (3000 ms, HELLO 500 ms) and
are not settable from here. --timeout is a watchdog over the run.

Exit status: 0 when every reported case is pass or skipped, 1 otherwise, 2 for
a usage or link failure.`;

if (has('-h') || has('--help')) {
  console.log(USAGE);
  process.exit(0);
}

for (const flag of args.filter((a) => a.startsWith('--'))) {
  if (!VALUED.has(flag) && flag !== '--passive' && flag !== '--help') {
    console.error(`unknown option: ${flag}\n\n${USAGE}`);
    process.exit(2);
  }
}
for (const flag of VALUED) {
  const i = args.indexOf(flag);
  if (i >= 0 && (args[i + 1] === undefined || args[i + 1].startsWith('--'))) {
    console.error(`${flag} needs a value\n\n${USAGE}`);
    process.exit(2);
  }
}

const portPath = opt('--port', process.env.KINO_PORT);
if (!portPath) {
  console.error(`--port is required (or set KINO_PORT)\n\n${USAGE}`);
  process.exit(2);
}
const baud = Number(opt('--baud', '921600'));
if (!Number.isFinite(baud) || baud <= 0) {
  console.error(`--baud must be a positive number, got "${opt('--baud')}"`);
  process.exit(2);
}
const budgetMs = Number(opt('--timeout', '300000'));
if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
  console.error(`--timeout must be a positive number of milliseconds, got "${opt('--timeout')}"`);
  process.exit(2);
}
const jsonPath = opt('--json');
const caseFilter = opt('--case');
const includeActive = !has('--passive');

/** Anything not in here means the firmware failed the suite. */
const OK_STATUS = new Set(['pass', 'skipped']);
const STATUS_ORDER = ['pass', 'skipped', 'unsupported', 'shape', 'timeout', 'error'];

const fail = (message) => {
  console.error(`\n${message}`);
  process.exitCode = 2;
};

const port = new SerialPort({ path: portPath, baudRate: baud, autoOpen: false });
const transport = new NodeSerialTransport(port);
const client = new KinoProtocolClient(transport);
const device = new KinoDevice(client);

/** Events arrive unasked. A bench record wants them counted. */
const eventCounts = new Map();
for (const [name, evt] of Object.entries(Evt)) {
  if (typeof evt !== 'number') continue;
  client.onEvent(evt, () => eventCounts.set(name, (eventCounts.get(name) ?? 0) + 1));
}

let lostReason = null;
transport.onClose((reason) => {
  if (!reason) return;
  lostReason = reason;
  client.dispose(reason);
});

try {
  await transport.open();
} catch (err) {
  fail(`could not open ${portPath} @ ${baud}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
console.log(`opened ${portPath} @ ${baud}`);

// The same handshake Studio's session runs, in the same order: HELLO first,
// with this client's protocol range pinned, before anything else is asked. The
// suite assumes a connected, HELLO'd device — its own HELLO case then proves
// the reply's shape.
let hello;
try {
  hello = await client.hello({
    protocolMin: PROTOCOL_VERSION,
    protocolMax: PROTOCOL_VERSION,
    clientVersion: CLIENT_NAME,
  });
  if (hello.product !== 'KINO') {
    throw new Error(`device answered as "${hello.product}" — not a KINO`);
  }
} catch (err) {
  fail(`handshake failed: ${err instanceof Error ? err.message : String(err)}`);
  await transport.close();
  process.exit(2);
}

// A pasted run has to identify itself or it is worth nothing as a record.
let info = null;
try {
  info = await device.getDeviceInfo();
} catch (err) {
  console.log(`GET_DEVICE_INFO failed before the suite: ${err instanceof Error ? err.message : String(err)}`);
}
const startedAt = new Date();
console.log('');
console.log(`KINO conformance — ${startedAt.toISOString()}`);
console.log(`  serial      ${info?.serial ?? '(unknown)'}`);
console.log(`  product     ${hello.product} · protocol ${hello.protocol}${hello.deviceId ? ` · device ${hello.deviceId}` : ''}`);
console.log(`  P4 firmware ${info?.p4Firmware ?? '(unknown)'}`);
console.log(`  cameras     ${info?.cameraFirmware ? info.cameraFirmware.join(', ') : '(unknown)'}`);
console.log(`  SD card     ${info?.sdPresent === undefined ? '(unknown)' : info.sdPresent ? 'present' : 'absent'}`);
console.log(`  runner      ${CLIENT_NAME} on ${portPath} @ ${baud}`);

const total = conformanceCaseCount(includeActive);
const passiveTotal = conformanceCaseCount(false);
console.log('');
if (includeActive) {
  console.log(
    `Running all ${total} cases, ${total - passiveTotal} of them ACTIVE: they take real ` +
      'photographs, write config, and enter maintenance on this camera. Files will appear ' +
      'on the SD card. Use --passive for the read-only half.',
  );
} else {
  console.log(
    `Running the ${total} passive cases only. The ${conformanceCaseCount(true) - passiveTotal} ` +
      'active cases are not executed and do not appear below — this run says nothing about them.',
  );
}
console.log('');

const watchdog = new Promise((_, reject) => {
  const t = setTimeout(
    () => reject(new Error(`run exceeded the --timeout budget of ${budgetMs} ms`)),
    budgetMs,
  );
  t.unref?.();
});

const t0 = performance.now();
let results;
try {
  results = await Promise.race([
    runConformance(device, includeActive, (done, count, current) => {
      if (current === 'done') return;
      process.stdout.write(`  [${String(done + 1).padStart(2)}/${count}] ${current}\n`);
    }),
    watchdog,
  ]);
} catch (err) {
  fail(`suite aborted: ${err instanceof Error ? err.message : String(err)}${lostReason ? ` (link: ${lostReason})` : ''}`);
  await transport.close();
  process.exit(2);
}
const elapsedMs = Math.round(performance.now() - t0);

const shown = caseFilter
  ? results.filter((r) => r.name.toLowerCase().includes(caseFilter.toLowerCase()))
  : results;

// --- the table ---------------------------------------------------------------
const nameWidth = Math.max(4, ...shown.map((r) => r.name.length));
const pad = (s, n) => String(s).padEnd(n);
console.log('');
console.log(`  ${pad('CASE', nameWidth)}  A  STATUS        ms  DETAIL`);
console.log(`- ${'-'.repeat(nameWidth)}  -  ----------  ----  ------`);
for (const r of shown) {
  // Leading '!' so a failure is findable with grep on a pasted transcript.
  const mark = OK_STATUS.has(r.status) ? ' ' : '!';
  console.log(
    `${mark} ${pad(r.name, nameWidth)}  ${r.active ? 'A' : ' '}  ${pad(r.status, 10)}  ${String(r.ms).padStart(4)}  ${r.detail}`,
  );
}

if (caseFilter && shown.length !== results.length) {
  console.log('');
  console.log(
    `--case "${caseFilter}" matched ${shown.length} of ${results.length} cases; the rest ran but are not shown.`,
  );
}

// --- the summary ------------------------------------------------------------
const counts = new Map();
for (const r of shown) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
const summary = STATUS_ORDER.filter((s) => counts.has(s))
  .map((s) => `${s} ${counts.get(s)}`)
  .join(' · ');
const bad = shown.filter((r) => !OK_STATUS.has(r.status));

console.log('');
console.log(`${shown.length} case(s) in ${(elapsedMs / 1000).toFixed(1)} s — ${summary}`);
console.log(`link: ${JSON.stringify(client.stats)}`);
if (eventCounts.size > 0) {
  console.log(
    `events: ${[...eventCounts].map(([name, n]) => `${name} ${n}`).join(' · ')}`,
  );
}
if (lostReason) console.log(`link closed during the run: ${lostReason}`);
if (bad.length > 0) {
  console.log('');
  console.log(`FAILED ${bad.length} case(s):`);
  for (const r of bad) console.log(`  ${r.status.toUpperCase()} ${r.name} — ${r.detail}`);
} else {
  console.log('');
  console.log('PASS — every reported case is pass or skipped.');
}

if (jsonPath) {
  const record = {
    startedAt: startedAt.toISOString(),
    runner: CLIENT_NAME,
    port: portPath,
    baud,
    includeActive,
    caseFilter: caseFilter ?? null,
    device: {
      product: hello.product,
      protocol: hello.protocol,
      deviceId: hello.deviceId ?? null,
      serial: info?.serial ?? null,
      p4Firmware: info?.p4Firmware ?? null,
      cameraFirmware: info?.cameraFirmware ?? null,
      sdPresent: info?.sdPresent ?? null,
    },
    elapsedMs,
    counts: Object.fromEntries(counts),
    linkStats: { ...client.stats },
    events: Object.fromEntries(eventCounts),
    linkClosedReason: lostReason,
    // Every case, not just the shown ones: a filtered console view must not
    // silently shrink the machine record a bench log is built from.
    results,
  };
  try {
    writeFileSync(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`\nwrote ${jsonPath}`);
  } catch (err) {
    console.error(`\ncould not write ${jsonPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}

client.dispose('Conformance run finished');
await transport.close();
if (process.exitCode === undefined || process.exitCode === 0) {
  process.exitCode = bad.length > 0 ? 1 : 0;
}
