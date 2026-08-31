import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
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
  'LICENSES/LicenseRef-Microsoft-Proprietary.txt',
  // Espressif's vendored C6 partition table is Apache-2.0 and REUSE.toml says
  // so, which obliges the tree to carry the text it names.
  'LICENSES/Apache-2.0.txt',
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
  // The P4 home-screen icons are Microsoft's. firmware/** is MIT, so losing
  // this override would declare that we are giving away someone else's
  // artwork under our own grant.
  'SPDX-License-Identifier = "LicenseRef-Microsoft-Proprietary"',
  '"firmware/p4/main/icons_w98.h"',
  // Espressif's C6 partition table, same shape of override for the same
  // reason: firmware/** is MIT and this file is not ours to give away.
  'SPDX-License-Identifier = "Apache-2.0"',
  '"firmware/c6/partitions_eh_cp_ota_4m.csv"',
  // tools/ holds the two bitmap generators. Declared with scripts/, because a
  // path in neither block has no license at all.
  '"tools/**"',
]) check(reuse.includes(marker), `REUSE.toml is missing ${marker}`);

// LICENSE is what a human reads; REUSE.toml is what the tooling reads. They
// disagreed once (LICENSE called the app wordmarks MIT while REUSE reserved
// them), and a prose file cannot be diffed against a path map automatically —
// so the paths that carry a surprising license are pinned here in both.
const license = await text('LICENSE');
for (const marker of [
  'apps/studio/src/assets/**',
  'apps/twin/src/assets/**',
  'apps/roll-web/src/assets/**',
  'apps/studio/public/icon-*.png',
  'firmware/p4/main/icons_w98.h',
  'firmware/c6/partitions_eh_cp_ota_4m.csv',
  'THIRD_PARTY_NOTICES.md',
]) check(license.includes(marker), `LICENSE no longer mentions ${marker}`);

// The icon header is generated, so it is easy to regenerate without the
// notice and easy to delete the notice without touching the header. Both
// halves have to be present together.
if (await exists('firmware/p4/main/icons_w98.h')) {
  const icons = await text('firmware/p4/main/icons_w98.h');
  check(
    icons.includes('SPDX-License-Identifier: LicenseRef-Microsoft-Proprietary'),
    'firmware/p4/main/icons_w98.h has lost its SPDX header; re-run npm run icons:bake',
  );
  const notices = await text('THIRD_PARTY_NOTICES.md');
  check(
    notices.includes('icons_w98.h'),
    'THIRD_PARTY_NOTICES.md does not mention the bundled Windows 98 icon artwork',
  );
}

const rootPackage = await json('package.json');
const lock = await json('package-lock.json');
check(rootPackage.license === 'SEE LICENSE IN LICENSE', `root package license is ${rootPackage.license ?? 'missing'}`);
check(lock.packages['']?.license === rootPackage.license, `root package-lock license is ${lock.packages['']?.license ?? 'missing'}`);

// Every workspace, derived from package.json rather than listed here. The old
// hardcoded five checked 5 of the 13 workspaces this repository has; the other
// eight could declare anything, or nothing, and this script would pass.
async function workspaceDirectories() {
  const directories = [];
  for (const pattern of rootPackage.workspaces ?? []) {
    // Only the `<dir>/*` shape is understood. Anything else would be silently
    // skipped, which is the failure this function exists to remove.
    const match = /^([^*]+)\/\*$/.exec(pattern);
    if (!match) {
      errors.push(`workspaces pattern ${pattern} is not of the form dir/* — teach this script about it`);
      continue;
    }
    const parent = match[1];
    for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = `${parent}/${entry.name}`;
      if (await exists(`${directory}/package.json`)) directories.push(directory);
    }
  }
  return directories.sort();
}

// Workspaces that do not yet declare MIT, with what they declare today.
//
// This is recorded debt, not an exemption: the check below still fails if one
// of them CHANGES, and a workspace missing from both this map and MIT fails
// too — so a new package cannot arrive unlicensed. The list must shrink.
// Every one of these is MIT software; the field is simply absent, which leaves
// the npm metadata saying nothing while REUSE.toml says MIT (issue #146).
const LICENSE_DEBT = new Map([
  ['apps/roll-web', 'SEE LICENSE IN LICENSE'],
  ['apps/twin', undefined],
  ['apps/worker', undefined],
  ['packages/hardware-profiles', undefined],
  ['packages/simulator-engine', undefined],
  ['packages/three-assets', undefined],
]);

for (const directory of await workspaceDirectories()) {
  const pkg = await json(`${directory}/package.json`);
  const expected = LICENSE_DEBT.has(directory) ? LICENSE_DEBT.get(directory) : 'MIT';
  if (LICENSE_DEBT.has(directory)) {
    check(
      pkg.license === expected,
      `${directory} license is now ${pkg.license ?? 'missing'} — it is listed as known debt in scripts/check-licenses.mjs as ${expected ?? 'missing'}; set it to MIT and delete the entry`,
    );
  } else {
    check(pkg.license === 'MIT', `${directory}/package.json license is ${pkg.license ?? 'missing'}, expected MIT`);
  }
  check(
    lock.packages[directory]?.license === pkg.license,
    `${directory} package-lock license is ${lock.packages[directory]?.license ?? 'missing'}, package.json says ${pkg.license ?? 'missing'} — run npm install`,
  );
}

const hardware = await json('hardware/manifest.json');
check(hardware.license === 'CERN-OHL-S-2.0', `hardware manifest license is ${hardware.license ?? 'missing'}`);

if (errors.length) {
  console.error('License metadata errors:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log('License metadata OK: MIT software, CERN-OHL-S-2.0 hardware, reserved marks and media.');
