import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const run = promisify(execFile);

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
    await stat(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
}

/**
 * The file as the last commit has it, or null.
 *
 * Null covers every reason git cannot answer — no git on PATH, an export with
 * no history, a file that did not exist at HEAD, a shallow or unborn branch.
 * A missing baseline must not fail the run: this check compares against
 * history, and a checkout with no history has nothing to disagree with.
 */
async function committed(relative) {
  try {
    const { stdout } = await run('git', ['show', `HEAD:${relative}`], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/** -1, 0 or 1. Pre-release suffixes are ignored — the three numbers decide. */
function compareSemver(a, b) {
  const parse = (v) => v.split('-')[0].split('.').map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const versions = await json('versions.json');
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

// --firmware scopes the run to the protocol/firmware records — the build
// daemon's gate. Unrelated backend drift (package versions, migrations,
// hardware artifacts) must not block a firmware build (issue #90).
const firmwareOnly = process.argv.includes('--firmware');

check(versions.schema === 'kino.version-manifest', 'versions.json has the wrong schema');
check(versions.manifestVersion === 1, 'unsupported version-manifest format');

if (!firmwareOnly) {
const rootPackage = await json('package.json');

// ---------------------------------------------------------------------------
// Every workspace is covered, derived from package.json rather than from the
// list in versions.json.
//
// `apps/prusa-print-98` sat outside every gate — not in versions.json, not in
// RELEASING.md, not in CONTRIBUTING.md, not in the README's repository map, not
// in ci.yml's hand-maintained workspace list; only REUSE.toml knew about it.
// scripts/check-licenses.mjs already derives its workspace set from the
// `workspaces` field precisely to close that hole. This is the same treatment:
// a workspace that is in neither versions.json nor the debt map below fails,
// so a new package cannot arrive silently unversioned.
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

// Workspaces deliberately absent from versions.json, with why.
//
// Recorded debt, not an exemption. The list must shrink: give the workspace a
// versions.json entry with a tagPrefix, document it in docs/RELEASING.md and
// docs/VERSIONING.md, then delete the line here.
const VERSION_DEBT = new Map([
  [
    'apps/prusa-print-98',
    'the @kino/print utility — the only 1.x in a 0.x tree, and released with nothing. Give it a versions.json entry before it ships to anyone.',
  ],
]);

const versionedDirectories = new Set(
  versions.software.map((entry) => (entry.package === 'package.json' ? '' : path.dirname(entry.package).replaceAll('\\', '/'))),
);
for (const directory of await workspaceDirectories()) {
  if (versionedDirectories.has(directory)) {
    check(
      !VERSION_DEBT.has(directory),
      `${directory} is in versions.json now — delete its VERSION_DEBT line in scripts/check-versions.mjs`,
    );
    continue;
  }
  check(
    VERSION_DEBT.has(directory),
    `${directory} is a workspace with no versions.json entry, so no gate checks its version or names its tag. Add it to versions.json, or record it in VERSION_DEBT in scripts/check-versions.mjs with a reason.`,
  );
}

const lock = await json('package-lock.json');
for (const entry of versions.software) {
  const pkg = await json(entry.package);
  const lockPath = entry.package === 'package.json' ? '' : path.dirname(entry.package).replaceAll('\\', '/');
  const locked = lock.packages[lockPath];
  check(pkg.version === entry.version, `${entry.name}: versions.json=${entry.version}, ${entry.package}=${pkg.version}`);
  check(locked?.version === entry.version, `${entry.name}: versions.json=${entry.version}, package-lock=${locked?.version ?? 'missing'}`);
  check(semver.test(entry.version), `${entry.name}: ${entry.version} is not semantic versioning`);
  check(entry.tagPrefix.endsWith('-v'), `${entry.name}: tagPrefix must end in -v`);
}
}

const commands = await text('packages/kdp/src/protocol/commands.ts');
const protocolMatch = commands.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
check(protocolMatch !== null, 'PROTOCOL_VERSION was not found');
check(Number(protocolMatch?.[1]) === versions.protocol.kdp, `KDP protocol: versions.json=${versions.protocol.kdp}, source=${protocolMatch?.[1] ?? 'missing'}`);

const types = await text('packages/kdp/src/protocol/types.ts');
const configMatch = types.match(/CONFIG_SCHEMA_VERSION\s*=\s*(\d+)/);
check(configMatch !== null, 'CONFIG_SCHEMA_VERSION was not found');
check(Number(configMatch?.[1]) === versions.protocol.configEnvelope, `config envelope: versions.json=${versions.protocol.configEnvelope}, source=${configMatch?.[1] ?? 'missing'}`);

for (const entry of versions.portableSchemas) {
  const source = await text(entry.source);
  const expression = new RegExp(`schema:\\s*['\"]${escapeRegex(entry.name)}['\"][\\s\\S]{0,500}?version:\\s*(\\d+)`);
  const match = source.match(expression);
  check(match !== null, `${entry.name}: schema and version were not found in ${entry.source}`);
  check(Number(match?.[1]) === entry.version, `${entry.name}: versions.json=${entry.version}, source=${match?.[1] ?? 'missing'}`);
}

const firmwareVersion = (await text(versions.firmware.source)).trim();
check(firmwareVersion === versions.firmware.version, `firmware: versions.json=${versions.firmware.version}, ${versions.firmware.source}=${firmwareVersion}`);
check(semver.test(versions.firmware.version), `firmware: ${versions.firmware.version} is not semantic versioning`);
check(versions.firmware.tagPrefix.endsWith('-v'), 'firmware: tagPrefix must end in -v');

// commands.ts line 2: "Keep numeric values in sync with firmware protocol.h".
const firmwareProtocol = await text(versions.firmware.protocolHeader);
const firmwareProtocolMatch = firmwareProtocol.match(/KDP_PROTOCOL_VERSION\s+(\d+)/);
check(firmwareProtocolMatch !== null, 'KDP_PROTOCOL_VERSION was not found in firmware protocol.h');
check(Number(firmwareProtocolMatch?.[1]) === versions.protocol.kdp, `firmware protocol.h: versions.json=${versions.protocol.kdp}, source=${firmwareProtocolMatch?.[1] ?? 'missing'}`);

// Opcode parity: commands.ts is normative and protocol.h claims to mirror
// it. Nothing enforced that until issue #90 — compare every name and value
// in both directions, for commands and events.
function enumEntries(source, name) {
  const body = source.match(new RegExp(`export enum ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
  return new Map([...body.matchAll(/([A-Z0-9_]+)\s*=\s*(0x[0-9a-fA-F]+)/g)].map((m) => [m[1], parseInt(m[2], 16)]));
}
function defineEntries(source, prefix) {
  return new Map(
    [...source.matchAll(new RegExp(`${prefix}([A-Z0-9_]+)\\s*=\\s*(0x[0-9a-fA-F]+)`, 'g'))].map((m) => [m[1], parseInt(m[2], 16)]),
  );
}
for (const [enumName, cPrefix] of [['Cmd', 'KDP_CMD_'], ['Evt', 'KDP_EVT_']]) {
  const ts = enumEntries(commands, enumName);
  const c = defineEntries(firmwareProtocol, cPrefix);
  check(ts.size > 0, `no ${enumName} entries parsed from commands.ts`);
  check(c.size > 0, `no ${cPrefix}* entries parsed from protocol.h`);
  for (const [name, value] of ts) {
    if (!c.has(name)) errors.push(`protocol.h is missing ${cPrefix}${name} (commands.ts ${enumName}.${name} = 0x${value.toString(16)})`);
    else if (c.get(name) !== value) errors.push(`${cPrefix}${name} = 0x${c.get(name).toString(16)} but commands.ts says 0x${value.toString(16)}`);
  }
  for (const [name, value] of c) {
    if (!ts.has(name)) errors.push(`protocol.h has ${cPrefix}${name} = 0x${value.toString(16)} with no commands.ts counterpart`);
  }
}

// The Twin emulates "current firmware" through PROFILE_FOR_VERSION. A
// firmware version bump without a profile mapping silently breaks that
// emulation (issue #90).
const profiles = await text('packages/test-fixtures/src/firmwareProfiles.ts');
const profileMapBody = profiles.match(/PROFILE_FOR_VERSION[\s\S]*?=\s*\{([\s\S]*?)\}/)?.[1] ?? '';
const mappedVersions = [...profileMapBody.matchAll(/'([^']+)':/g)].map((m) => m[1]);
check(
  mappedVersions.includes(versions.firmware.version),
  `PROFILE_FOR_VERSION has no entry for firmware ${versions.firmware.version} (has: ${mappedVersions.join(', ') || 'none'})`,
);

if (!firmwareOnly) {
const journal = await json(versions.database.journal);
const latestMigration = journal.entries.at(-1)?.tag;
check(latestMigration === versions.database.latestMigration, `database: versions.json=${versions.database.latestMigration}, journal=${latestMigration ?? 'missing'}`);

// ---------------------------------------------------------------------------
// Journal integrity. Only the last `tag` was compared above, so a journal
// could name a migration whose .sql was never committed, or carry a gap or a
// duplicate index, and pass.
//
// This does not catch a schema edit with no generated migration at all — that
// needs `drizzle-kit generate` and a diff, which is a CI step (see
// .github/workflows/ci.yml, "migration drift"), not something to run inside a
// version check.
const migrationsDirectory = path.dirname(path.dirname(versions.database.journal)).replaceAll('\\', '/');
const indices = new Set();
for (const entry of journal.entries) {
  const sql = `${migrationsDirectory}/${entry.tag}.sql`;
  check(await exists(sql), `database journal names ${entry.tag} but ${sql} is not committed — a migrate run would skip it`);
  const snapshot = `${migrationsDirectory}/meta/${String(entry.idx).padStart(4, '0')}_snapshot.json`;
  check(await exists(snapshot), `database journal entry ${entry.idx} (${entry.tag}) has no ${snapshot}`);
  check(!indices.has(entry.idx), `database journal has two entries at idx ${entry.idx}`);
  indices.add(entry.idx);
}
const ordered = journal.entries.map((entry) => entry.idx);
for (let i = 1; i < ordered.length; i++) {
  check(
    ordered[i] === ordered[i - 1] + 1,
    `database journal indices are not contiguous: ${ordered[i - 1]} is followed by ${ordered[i]}. Drizzle applies in journal order and records idx, so a gap means a migration was removed and a duplicate means two claim the same slot.`,
  );
}

// Every .sql on disk is in the journal. A file nobody lists is a migration
// that never runs, which is worse than a missing file: the tree looks like it
// has the change.
for (const file of await readdir(path.join(root, migrationsDirectory))) {
  if (!file.endsWith('.sql')) continue;
  const tag = file.slice(0, -4);
  check(
    journal.entries.some((entry) => entry.tag === tag),
    `${migrationsDirectory}/${file} is committed but is in no journal entry, so it never runs`,
  );
}

const hardware = await json(versions.hardware.manifest);
const revisionFile = (await text('hardware/REVISION')).trim();
const hardwareChangelog = await text('hardware/CHANGELOG.md');
check(hardware.product === versions.hardware.product, `hardware product drift: ${hardware.product} != ${versions.hardware.product}`);
check(hardware.hardwareRevision === versions.hardware.revision, `hardware revision drift: ${hardware.hardwareRevision} != ${versions.hardware.revision}`);
check(revisionFile === versions.hardware.revision, `hardware/REVISION drift: ${revisionFile} != ${versions.hardware.revision}`);
check(hardware.designVersion === versions.hardware.designVersion, `hardware design version drift: ${hardware.designVersion} != ${versions.hardware.designVersion}`);
check(hardware.status === versions.hardware.status, `hardware status drift: ${hardware.status} != ${versions.hardware.status}`);
check(semver.test(hardware.designVersion), `hardware design version ${hardware.designVersion} is not semantic versioning`);
check(hardware.license === 'CERN-OHL-S-2.0', `hardware license must be CERN-OHL-S-2.0, got ${hardware.license}`);
check(hardware.compatibility.kdpProtocol === versions.protocol.kdp, `hardware KDP compatibility drift: ${hardware.compatibility.kdpProtocol} != ${versions.protocol.kdp}`);
check(hardwareChangelog.includes(`## ${hardware.designVersion}`), `hardware changelog has no ${hardware.designVersion} section`);

for (const [name, artifact] of Object.entries(hardware.artifacts)) {
  try {
    await stat(path.join(root, artifact.path));
  } catch {
    errors.push(`hardware artifact ${name} is missing: ${artifact.path}`);
  }
  check(Number.isInteger(artifact.revision) && artifact.revision >= 0, `hardware artifact ${name} has invalid revision ${artifact.revision}`);
}
}

// ---------------------------------------------------------------------------
// No version ever goes backwards.
//
// Everything above compares versions.json against the owning source, so the
// two agreeing is all it took — including when both said a number that was
// already released. That has happened once: a commit from a checkout whose
// versions.json was behind HEAD re-used a version, and it was caught and
// repaired by hand. Concurrent sessions in one worktree make it easy to repeat.
//
// The baseline is the committed HEAD copy of versions.json. Equal is fine — most
// commits do not bump anything. Lower is the failure.
const headManifest = await committed('versions.json');
if (headManifest !== null) {
  let previous = null;
  try {
    previous = JSON.parse(headManifest);
  } catch {
    // A HEAD copy that will not parse is not this check's problem to report.
  }
  if (previous !== null) {
    const before = new Map((previous.software ?? []).map((entry) => [entry.name, entry.version]));
    for (const entry of versions.software) {
      const was = before.get(entry.name);
      if (was === undefined || !semver.test(was)) continue;
      check(
        compareSemver(entry.version, was) >= 0,
        `${entry.name}: ${entry.version} is lower than the committed ${was}. Rebase or pull — a version that goes backwards re-uses a number that is already recorded.`,
      );
    }
    const firmwareWas = previous.firmware?.version;
    if (typeof firmwareWas === 'string' && semver.test(firmwareWas)) {
      check(
        compareSemver(versions.firmware.version, firmwareWas) >= 0,
        `firmware: ${versions.firmware.version} is lower than the committed ${firmwareWas}.`,
      );
    }
    const hardwareWas = previous.hardware?.designVersion;
    if (typeof hardwareWas === 'string' && semver.test(hardwareWas)) {
      check(
        compareSemver(versions.hardware.designVersion, hardwareWas) >= 0,
        `hardware design version: ${versions.hardware.designVersion} is lower than the committed ${hardwareWas}.`,
      );
    }
  }
}

if (errors.length) {
  console.error('Version manifest drift:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`Version manifest OK: ${versions.software.length} software packages, KDP ${versions.protocol.kdp}, ${versions.portableSchemas.length} portable schemas, ${versions.hardware.revision} ${versions.hardware.designVersion}.`);
