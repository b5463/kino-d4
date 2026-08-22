// Builds a release bundle from a clean checkout (issue #13).
//
//   npm run release                 Studio only (firmware images optional)
//   npm run release -- --firmware   require both firmware images too
//   npm run release -- --out DIR    default: dist/release
//
// The bundle is a directory containing the Studio bundle, any firmware
// images, a machine-readable kino.release manifest, and SHA256SUMS. Every
// digest is computed from the bytes on disk after the build — nothing is
// copied from a build log or a previous run.
//
// Reproducibility: the manifest records the git commit and whether the tree
// was dirty. A release built from a dirty tree is still emitted (the bundle
// is useful for testing) but it says so, in the manifest and on stdout,
// because a dirty release cannot be rebuilt from its own recorded commit.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = path.resolve(ROOT, outArg === -1 ? 'dist/release' : (args[outArg + 1] ?? 'dist/release'));
const REQUIRE_FIRMWARE = args.includes('--firmware');
const SKIP_BUILD = args.includes('--skip-build');

// One string, shell:true — npm needs a shell on Windows, and passing an
// argv array alongside it is what Node deprecated in DEP0190.
function run(commandLine) {
  const result = spawnSync(commandLine, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`[release] ${commandLine} failed (${String(result.status)})`);
    process.exit(result.status ?? 1);
  }
}

function capture(commandLine) {
  const result = spawnSync(commandLine, { cwd: ROOT, encoding: 'utf8', shell: true });
  return result.status === 0 ? result.stdout.trim() : '';
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/** Every file under `dir`, relative to `base`, sorted for a stable manifest. */
async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

// ---- gates: a release must not be cut from a tree that fails its own checks
if (!SKIP_BUILD) {
  run('npm run version:check');
  run('npm run license:check');
  run('npm run lint');
  run('npm run build');
}

const versions = JSON.parse(await readFile(path.join(ROOT, 'versions.json'), 'utf8'));
const studioVersion = versions.software.find((entry) => entry.name === 'kino-studio')?.version;
if (!studioVersion) {
  console.error('[release] versions.json has no kino-studio entry');
  process.exit(1);
}
const commit = capture('git rev-parse HEAD') || 'unknown';
const dirty = capture('git status --porcelain').length > 0;

await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, 'studio'), { recursive: true });

// ---- Studio bundle
const studioDist = path.join(ROOT, 'apps/studio/dist');
if (!(await exists(studioDist))) {
  console.error('[release] apps/studio/dist is missing — run without --skip-build');
  process.exit(1);
}
await cp(studioDist, path.join(OUT, 'studio'), { recursive: true });

// ---- firmware images, when this tree has built them
const firmwareTargets = [
  { id: 'main', app: 'p4', bin: 'kino-p4.bin', chip: 'esp32p4' },
  { id: 'cameraNode', app: 'camnode', bin: 'kino-camnode.bin', chip: 'esp32s3' },
];
const firmwareVersion = (await readFile(path.join(ROOT, 'firmware/VERSION'), 'utf8')).trim();
const targets = {};
let firmwareIncluded = 0;

for (const target of firmwareTargets) {
  const built = path.join(ROOT, 'firmware', target.app, 'build', target.bin);
  if (!(await exists(built))) {
    if (REQUIRE_FIRMWARE) {
      console.error(
        `[release] ${target.bin} is missing. Build it first:\n` +
          `  docker run --rm -v "$PWD:/project" -w /project/firmware/${target.app} espressif/idf:v5.5.1 idf.py build`,
      );
      process.exit(1);
    }
    continue;
  }
  await mkdir(path.join(OUT, 'firmware'), { recursive: true });
  const dest = path.join(OUT, 'firmware', target.bin);
  await cp(built, dest);
  targets[target.id] = {
    file: `firmware/${target.bin}`,
    sha256: await sha256(dest),
    version: firmwareVersion,
    chip: target.chip,
  };
  firmwareIncluded++;
}

// ---- the machine-readable manifest
//
// `compatibleHardware` carries the string devices report in
// GET_DEVICE_INFO.hardware, not the design-revision label: Studio's
// compatibility gate compares against what the camera says (issue #90).
const release = {
  schema: 'kino.release',
  version: 1,
  studio: { version: studioVersion, path: 'studio/' },
  ...(firmwareIncluded > 0
    ? {
        firmware: {
          schema: 'kino.firmware-manifest',
          version: 1,
          release: firmwareVersion,
          channel: 'release',
          protocolMin: versions.protocol.kdp,
          protocolMax: versions.protocol.kdp,
          compatibleHardware: ['V1'],
          targets,
        },
      }
    : {}),
  protocol: versions.protocol,
  hardware: { revision: versions.hardware.revision, designVersion: versions.hardware.designVersion },
  source: { commit, dirty },
  builtAt: new Date().toISOString(),
  tags: {
    studio: `kino-studio-v${studioVersion}`,
    ...(firmwareIncluded > 0 ? { firmware: `kino-fw-v${firmwareVersion}` } : {}),
  },
};
await writeFile(path.join(OUT, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);

// ---- checksums over everything the bundle ships, manifest included
const files = (await walk(OUT)).filter((file) => file !== 'SHA256SUMS');
const sums = [];
for (const file of files) sums.push(`${await sha256(path.join(OUT, file))}  ${file}`);
await writeFile(path.join(OUT, 'SHA256SUMS'), `${sums.join('\n')}\n`);

console.log(`[release] ${OUT}`);
console.log(`[release] studio ${studioVersion}${firmwareIncluded > 0 ? `, firmware ${firmwareVersion} (${firmwareIncluded}/2 targets)` : ', no firmware images'}`);
console.log(`[release] ${files.length} files, commit ${commit.slice(0, 12)}${dirty ? ' (DIRTY — not reproducible from this commit)' : ''}`);
console.log('[release] verify with: sha256sum -c SHA256SUMS');
