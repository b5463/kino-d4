// Plain serial console reader, with a reset so the boot log is not missed.
//
// The camera node logs ESP_LOG text on USB-Serial-JTAG rather than speaking
// KDP, so kino-bench.mjs cannot read it. Node standalone validation is the
// first checkpoint of a camera bring-up and it happens entirely in this log:
// sensor model, PID, SCCB address, PSRAM, and whether the node reaches READY.
//
//   npx tsx scripts/kino-console.mjs --port COM6 --seconds 20
//   npx tsx scripts/kino-console.mjs --port COM6 --no-reset
import { SerialPort } from 'serialport';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const portPath = opt('--port', process.env.KINO_PORT);
if (!portPath) {
  console.error('usage: kino-console.mjs --port <COM6> [--seconds N] [--no-reset]');
  process.exit(2);
}
const seconds = Number(opt('--seconds', '20'));
const doReset = !args.includes('--no-reset');

const port = new SerialPort({
  path: portPath,
  baudRate: Number(opt('--baud', '115200')),
  autoOpen: false,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const set = (flags) =>
  new Promise((resolve, reject) => port.set(flags, (e) => (e ? reject(e) : resolve())));

let buf = '';
port.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  buf += text;
  process.stdout.write(text);
});

await new Promise((resolve, reject) =>
  port.open((e) => (e ? reject(e) : resolve())),
);

// Opening the port asserts DTR and RTS by default, and on this part DTR is
// GPIO0: the board resets into DOWNLOAD mode before a single byte is read,
// prints "waiting for download" and never runs the app. Both lines are
// released first, and only then is EN pulsed.
try {
  await set({ dtr: false, rts: false });
  await sleep(300);
} catch (e) {
  console.error(`\n[could not release DTR/RTS: ${e.message}]`);
}

if (doReset) {
  // USB-Serial-JTAG: RTS drives EN, DTR drives GPIO0. Pulse EN with GPIO0
  // left high so the chip comes up in normal boot rather than the bootloader.
  try {
    await set({ dtr: false, rts: true });
    await sleep(120);
    await set({ dtr: false, rts: false });
  } catch (e) {
    console.error(`\n[reset failed: ${e.message} — capturing anyway]`);
  }
}

await sleep(seconds * 1000);
port.close();

// A short verdict on the things node standalone validation actually needs, so
// the answer is not "read 200 lines and decide".
const want = [
  ['sensor detected', /sensor detected:\s*(\S+)\s*\(PID\s*(0x[0-9a-fA-F]+)\)/],
  ['SCCB address', /Detected camera at address=(0x[0-9a-fA-F]+)/],
  ['PSRAM', /Found \d+MB PSRAM device|SPI SRAM memory test \w+/],
  ['node up', /camnode [\d.]+ up[^\r\n]*/],
  // Anchored, and no bare "error": the temperature sensor announces
  // "error < 1°C" on every healthy boot, which reported a fault on a node
  // that had none.
  ['errors', /^E \([^)]*\)[^\r\n]*|Guru Meditation[^\r\n]*|abort\(\)[^\r\n]*/m],
];
console.log('\n\n--- summary ---');
for (const [label, re] of want) {
  const m = buf.match(re);
  console.log(`  ${label.padEnd(16)} ${m ? m[0].trim().slice(0, 90) : 'NOT SEEN'}`);
}
console.log(`  ${'bytes read'.padEnd(16)} ${buf.length}`);
