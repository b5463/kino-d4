import { readFile, stat } from 'node:fs/promises';
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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const versions = await json('versions.json');
const lock = await json('package-lock.json');
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

check(versions.schema === 'kino.version-manifest', 'versions.json has the wrong schema');
check(versions.manifestVersion === 1, 'unsupported version-manifest format');

for (const entry of versions.software) {
  const pkg = await json(entry.package);
  const lockPath = entry.package === 'package.json' ? '' : path.dirname(entry.package).replaceAll('\\', '/');
  const locked = lock.packages[lockPath];
  check(pkg.version === entry.version, `${entry.name}: versions.json=${entry.version}, ${entry.package}=${pkg.version}`);
  check(locked?.version === entry.version, `${entry.name}: versions.json=${entry.version}, package-lock=${locked?.version ?? 'missing'}`);
  check(semver.test(entry.version), `${entry.name}: ${entry.version} is not semantic versioning`);
  check(entry.tagPrefix.endsWith('-v'), `${entry.name}: tagPrefix must end in -v`);
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

const journal = await json(versions.database.journal);
const latestMigration = journal.entries.at(-1)?.tag;
check(latestMigration === versions.database.latestMigration, `database: versions.json=${versions.database.latestMigration}, journal=${latestMigration ?? 'missing'}`);

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

if (errors.length) {
  console.error('Version manifest drift:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`Version manifest OK: ${versions.software.length} software packages, KDP ${versions.protocol.kdp}, ${versions.portableSchemas.length} portable schemas, ${versions.hardware.revision} ${versions.hardware.designVersion}.`);
