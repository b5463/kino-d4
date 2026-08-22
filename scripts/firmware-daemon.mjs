// KINO firmware build daemon — the localhost bridge that lets Studio drive
// the canonical firmware build (issue #72, brief §24-§31).
//
// Studio runs in a browser and cannot spawn Docker; this daemon wraps the ONE
// canonical build environment (espressif/idf:v5.5.1, the same image CI uses)
// so no second, subtly different build system exists. It refuses to build on
// version drift, runs the KDP host tests first, and emits a real
// kino.firmware-manifest for every artifact — no fake progress, no invented
// versions.
//
//   npm run firmware:daemon        (default port 5177)
//
// Dev tool only: binds 127.0.0.1, no auth, no TLS. Never expose it.

import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.KINO_FWD_PORT ?? 5177);
const IDF_IMAGE = 'espressif/idf:v5.5.1';
// Which WSL distro runs the host tests on Windows. Unset = the default
// distro; set KINO_FWD_WSL_DISTRO to pin one (issue #90).
const WSL_DISTRO = process.env.KINO_FWD_WSL_DISTRO;
// GET_DEVICE_INFO.hardware — the string devices actually report
// (firmware/p4/main/kdp_server.c). versions.json's "D4-V1" is the design
// revision label; declaring it here made every built package BLOCKED at the
// compatibility gate (issue #90).
const DEVICE_HARDWARE = 'V1';

const TARGETS = {
  p4: { dir: 'firmware/p4', bin: 'kino-p4.bin', chip: 'esp32p4', manifestTarget: 'main' },
  camnode: { dir: 'firmware/camnode', bin: 'kino-camnode.bin', chip: 'esp32s3', manifestTarget: 'cameraNode' },
};

/** @type {Map<string, {id:string,target:string,status:string,startedAt:string,finishedAt:string|null,steps:{name:string,status:string,ms:number|null}[],log:string[],warnings:number,errors:number,manifest:object|null,binaryPath:string|null,error:string|null}>} */
const builds = new Map();
let buildCounter = 0;
let running = false; // one build at a time — Docker and the tree are shared

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, shell: false, ...opts });
    let out = '';
    const onData = (chunk) => {
      out += chunk.toString();
      opts.onLine?.(chunk.toString());
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      // A missing executable must land in the build log, not vanish — it
      // used to read as a test failure with an empty log (issue #90).
      opts.onLine?.(`could not start ${cmd}: ${err.message}`);
      resolve({ code: -1, out: `${out}\n${err.message}` });
    });
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

async function gitState() {
  const commit = await run('git', ['rev-parse', 'HEAD']);
  const status = await run('git', ['status', '--porcelain']);
  return {
    gitCommit: commit.code === 0 ? commit.out.trim() : 'unknown',
    dirty: status.code === 0 ? status.out.trim().length > 0 : true,
  };
}

function pushLog(build, text) {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    build.log.push(line);
    if (/warning[: ]/i.test(line)) build.warnings++;
    if (/error[: ]/i.test(line)) build.errors++;
  }
  if (build.log.length > 5000) build.log.splice(0, build.log.length - 5000);
}

async function step(build, name, fn) {
  const entry = { name, status: 'running', ms: null };
  build.steps.push(entry);
  const t0 = Date.now();
  const ok = await fn();
  entry.ms = Date.now() - t0;
  entry.status = ok ? 'pass' : 'fail';
  return ok;
}

async function runBuild(build, skipChecks) {
  const target = TARGETS[build.target];
  try {
    if (!skipChecks) {
      // --firmware scopes the gate to the firmware/protocol records —
      // unrelated backend drift must not block a firmware build (issue #90).
      const versionsOk = await step(build, 'version check', async () => {
        const r = await run(process.execPath, ['scripts/check-versions.mjs', '--firmware'], {
          onLine: (l) => pushLog(build, l),
        });
        return r.code === 0;
      });
      if (!versionsOk) {
        // The one refusal that matters (§30): a drifted contract must not
        // become a flashable binary without an explicit override.
        build.status = 'failed';
        build.error = 'VERSION_DRIFT — versions.json disagrees with source; fix it or rebuild with skipChecks';
        return;
      }

      let testsRun = null;
      const testsOk = await step(build, 'kdp host tests', async () => {
        const makeArgs = ['-C', 'firmware/components/kdp_core/host_tests', 'test'];
        const r =
          process.platform === 'win32'
            ? await run('wsl', [...(WSL_DISTRO ? ['-d', WSL_DISTRO] : []), '--', 'bash', '-c',
                `cd '${ROOT.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => `/mnt/${d.toLowerCase()}`)}' && make -s -C firmware/components/kdp_core/host_tests clean test`],
                { onLine: (l) => pushLog(build, l) })
            : await run('make', makeArgs, { onLine: (l) => pushLog(build, l) });
        testsRun = r;
        return r.code === 0;
      });
      if (!testsOk) {
        build.status = 'failed';
        // A toolchain that never started is not a failing protocol core.
        build.error =
          testsRun?.code === -1
            ? 'TOOLING_MISSING — the host-test toolchain (wsl / make / gcc) could not start; see the log'
            : 'HOST_TESTS_FAILED — the KDP core does not pass its contract fixtures';
        return;
      }
    } else {
      pushLog(build, 'CHECKS SKIPPED by explicit developer override');
    }

    let buildRun = null;
    const built = await step(build, `idf.py build (${IDF_IMAGE})`, async () => {
      const r = await run('docker', [
        'run', '--rm',
        // On Linux the container would otherwise leave build/ root-owned.
        ...(process.platform === 'linux' ? ['--user', `${os.userInfo().uid}:${os.userInfo().gid}`] : []),
        '-v', `${ROOT}:/project`,
        '-w', `/project/${target.dir}`,
        IDF_IMAGE, 'idf.py', 'build',
      ], { onLine: (l) => pushLog(build, l) });
      buildRun = r;
      return r.code === 0;
    });
    if (!built) {
      build.status = 'failed';
      build.error =
        buildRun?.code === -1
          ? 'TOOLING_MISSING — docker could not start; see the log'
          : 'BUILD_FAILED — see log';
      return;
    }

    await step(build, 'artifact + manifest', async () => {
      const binPath = path.join(ROOT, target.dir, 'build', target.bin);
      const info = await stat(binPath);
      const sha256 = await sha256File(binPath);
      const firmwareVersion = (await readFile(path.join(ROOT, 'firmware/VERSION'), 'utf8')).trim();
      const versions = JSON.parse(await readFile(path.join(ROOT, 'versions.json'), 'utf8'));
      const git = await gitState();
      const partitionLine = build.log.find((l) => l.includes('Smallest app partition')) ?? null;

      // A real kino.firmware-manifest (packages/schemas/src/firmware.ts) with
      // dev provenance riding as passthrough fields. Versions come from the
      // repository, never invented here.
      build.manifest = {
        schema: 'kino.firmware-manifest',
        version: 1,
        release: firmwareVersion,
        channel: 'dev',
        protocolMin: versions.protocol.kdp,
        protocolMax: versions.protocol.kdp,
        compatibleHardware: [DEVICE_HARDWARE],
        targets: {
          [target.manifestTarget]: { file: target.bin, sha256, version: firmwareVersion },
        },
        // dev-build provenance (passthrough)
        product: 'KINO-D4',
        configSchemaVersion: versions.protocol.configEnvelope,
        espIdfVersion: IDF_IMAGE.split(':')[1],
        chip: target.chip,
        sizeBytes: info.size,
        partitionUsage: partitionLine,
        gitCommit: git.gitCommit,
        gitDirty: git.dirty,
        builtAt: new Date().toISOString(),
        checksRun: !skipChecks,
      };
      build.binaryPath = binPath;
      await writeFile(
        path.join(ROOT, target.dir, 'build', `${target.bin.replace(/\.bin$/, '')}-manifest.json`),
        JSON.stringify(build.manifest, null, 2),
      );
      return true;
    });

    build.status = 'ready';
  } catch (err) {
    build.status = 'failed';
    build.error = err instanceof Error ? err.message : String(err);
  } finally {
    build.finishedAt = new Date().toISOString();
    running = false;
  }
}

/**
 * Only pages served from localhost may call the daemon. `*` made any open
 * website able to spawn Docker builds and read repo paths through the
 * browser (issue #90); binding 127.0.0.1 does not protect against that.
 */
function corsOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' ? origin : null;
  } catch {
    return null;
  }
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  const headers = { 'content-type': 'application/json' };
  if (res.kinoCorsOrigin) {
    headers['access-control-allow-origin'] = res.kinoCorsOrigin;
    headers['access-control-allow-headers'] = 'content-type';
    headers['access-control-allow-methods'] = 'GET,POST,OPTIONS';
  }
  res.writeHead(code, headers);
  res.end(text);
}

function buildView(build, sinceLog = 0) {
  return { ...build, binaryPath: build.binaryPath, log: build.log.slice(sinceLog), logOffset: build.log.length };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  res.kinoCorsOrigin = corsOrigin(req);
  // DNS-rebinding guard: a remote hostname resolving to 127.0.0.1 still
  // carries its own Host header.
  const host = (req.headers.host ?? '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') {
    return json(res, 403, { error: 'daemon only answers localhost' });
  }
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.headers.origin && !res.kinoCorsOrigin) {
    return json(res, 403, { error: 'cross-origin requests are not allowed' });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const docker = await run('docker', ['--version']);
      const firmwareVersion = (await readFile(path.join(ROOT, 'firmware/VERSION'), 'utf8')).trim();
      const git = await gitState();
      return json(res, 200, {
        ok: true,
        daemon: 'kino-firmware-daemon',
        repo: ROOT,
        image: IDF_IMAGE,
        dockerAvailable: docker.code === 0,
        dockerVersion: docker.code === 0 ? docker.out.trim() : null,
        firmwareVersion,
        ...git,
        targets: Object.keys(TARGETS),
        running,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/build') {
      const body = await new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => resolve(data));
      });
      const { target, skipChecks } = JSON.parse(body || '{}');
      if (!TARGETS[target]) return json(res, 400, { error: `target must be one of ${Object.keys(TARGETS).join(', ')}` });
      if (running) return json(res, 409, { error: 'A build is already running' });
      running = true;
      const id = `build_${++buildCounter}`;
      const build = {
        id, target, status: 'running',
        startedAt: new Date().toISOString(), finishedAt: null,
        steps: [], log: [], warnings: 0, errors: 0,
        manifest: null, binaryPath: null, error: null,
      };
      builds.set(id, build);
      void runBuild(build, skipChecks === true);
      return json(res, 202, { id });
    }

    if (req.method === 'GET' && url.pathname === '/api/builds') {
      return json(res, 200, {
        builds: Array.from(builds.values()).map((b) => ({
          id: b.id, target: b.target, status: b.status, startedAt: b.startedAt,
          finishedAt: b.finishedAt, warnings: b.warnings, errors: b.errors,
          error: b.error, manifest: b.manifest,
        })),
      });
    }

    const buildMatch = url.pathname.match(/^\/api\/build\/(build_\d+)$/);
    if (req.method === 'GET' && buildMatch) {
      const build = builds.get(buildMatch[1]);
      if (!build) return json(res, 404, { error: 'no such build' });
      const since = Number(url.searchParams.get('since') ?? 0);
      return json(res, 200, buildView(build, Number.isFinite(since) ? since : 0));
    }

    const binMatch = url.pathname.match(/^\/api\/artifact\/(p4|camnode)\/bin$/);
    if (req.method === 'GET' && binMatch) {
      const target = TARGETS[binMatch[1]];
      const binPath = path.join(ROOT, target.dir, 'build', target.bin);
      try {
        const bytes = await readFile(binPath);
        const headers = { 'content-type': 'application/octet-stream', 'content-length': bytes.length };
        if (res.kinoCorsOrigin) headers['access-control-allow-origin'] = res.kinoCorsOrigin;
        res.writeHead(200, headers);
        return res.end(bytes);
      } catch {
        return json(res, 404, { error: `no built artifact at ${target.dir}/build/${target.bin} — build first` });
      }
    }

    const manifestMatch = url.pathname.match(/^\/api\/artifact\/(p4|camnode)\/manifest$/);
    if (req.method === 'GET' && manifestMatch) {
      const target = TARGETS[manifestMatch[1]];
      const manifestPath = path.join(
        ROOT, target.dir, 'build', `${target.bin.replace(/\.bin$/, '')}-manifest.json`,
      );
      try {
        return json(res, 200, JSON.parse(await readFile(manifestPath, 'utf8')));
      } catch {
        return json(res, 404, { error: 'no manifest — build through the daemon first' });
      }
    }

    return json(res, 404, { error: 'unknown route' });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`kino firmware daemon on http://127.0.0.1:${PORT} (repo ${ROOT}, image ${IDF_IMAGE})`);
});
