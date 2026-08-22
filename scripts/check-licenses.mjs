import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

async function text(relative) {
  return readFile(path.join(root, relative), 'utf8');
}

async function json(relative) {
  return JSON.parse(await text(relative));
}

function check(condition, message) {
  if (!condition) errors.push(message);
}

async function exists(relative) {
  try {
    await readFile(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
}

const required = [
  'LICENSE',
  'LICENSES/MIT.txt',
  'LICENSES/CERN-OHL-S-2.0.txt',
  'LICENSES/LicenseRef-KINO-Reserved.txt',
  'REUSE.toml',
  'TRADEMARKS.md',
];

for (const file of required) check(await exists(file), `missing ${file}`);

const cern = (await text('LICENSES/CERN-OHL-S-2.0.txt')).replace(/\r\n/g, '\n');
const cernHash = createHash('sha256').update(cern).digest('hex');
check(cernHash === '253ad3f89603e728abfa60c36fbcaf8225cf55c1eab12725f19fb3d74d647f3a', 'CERN-OHL-S-2.0 text was modified');

const mit = await text('LICENSES/MIT.txt');
check(mit.startsWith('MIT License\n'), 'MIT license text has the wrong heading');
check(mit.includes('Copyright (c) 2026 KINO contributors'), 'MIT copyright notice is missing');
check(mit.includes('Permission is hereby granted, free of charge'), 'MIT permission grant is missing');

const reuse = await text('REUSE.toml');
for (const marker of [
  'SPDX-License-Identifier = "MIT"',
  'SPDX-License-Identifier = "CERN-OHL-S-2.0"',
  'SPDX-License-Identifier = "LicenseRef-KINO-Reserved"',
  '"hardware/**"',
  '"docs/assets/brand/**"',
  '"archive/**"',
  // The wordmarks each app ships are the reserved artwork, not MIT source.
  // apps/** is MIT one block earlier, so losing these lines would quietly
  // relicense the marks.
  '"apps/studio/src/assets/**"',
  '"apps/twin/src/assets/**"',
  '"apps/roll-web/src/assets/**"',
  '"apps/studio/public/icon-*.png"',
  '"apps/twin/public/icon-*.png"',
  '"apps/roll-web/public/icon-*.png"',
]) check(reuse.includes(marker), `REUSE.toml is missing ${marker}`);

const rootPackage = await json('package.json');
const lock = await json('package-lock.json');
check(rootPackage.license === 'SEE LICENSE IN LICENSE', `root package license is ${rootPackage.license ?? 'missing'}`);
check(lock.packages['']?.license === rootPackage.license, `root package-lock license is ${lock.packages['']?.license ?? 'missing'}`);

const softwarePackages = [
  'apps/studio/package.json',
  'apps/api/package.json',
  'packages/kdp/package.json',
  'packages/schemas/package.json',
  'packages/test-fixtures/package.json',
];
for (const file of softwarePackages) {
  const pkg = await json(file);
  const lockPath = path.dirname(file).replaceAll('\\', '/');
  check(pkg.license === 'MIT', `${file} license is ${pkg.license ?? 'missing'}`);
  check(lock.packages[lockPath]?.license === 'MIT', `${lockPath} package-lock license is ${lock.packages[lockPath]?.license ?? 'missing'}`);
}

const hardware = await json('hardware/manifest.json');
check(hardware.license === 'CERN-OHL-S-2.0', `hardware manifest license is ${hardware.license ?? 'missing'}`);

if (errors.length) {
  console.error('License metadata errors:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log('License metadata OK: MIT software, CERN-OHL-S-2.0 hardware, reserved marks and media.');
