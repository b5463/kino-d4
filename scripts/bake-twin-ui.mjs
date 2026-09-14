#!/usr/bin/env node
// Build KINO Twin's device screen - the P4 firmware's ui.c as WebAssembly -
// and place it where the Twin loads it.
//
//   npm run twin:ui:bake            build firmware/p4/twin_ui/kino-ui.wasm and
//                                   copy it to apps/twin/src/display/firmware/
//   npm run twin:ui:check           build into a temp dir and compare with the
//                                   committed artifact; fail on drift
//   npm run twin:ui:bake -- --w98   the private variant with the real menu
//                                   artwork, into apps/twin/public/ (ignored
//                                   by git; see THIRD_PARTY_NOTICES.md, #134)
//
// The toolchain is wasi-sdk, pinned here by version and digest the way the
// firmware pins espressif/idf. Set WASI_SDK to an unpacked root, or let this
// script fetch the pinned release into .cache/ (gitignored) on first use.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'firmware', 'p4', 'twin_ui');
const OUT = join(root, 'apps', 'twin', 'src', 'display', 'firmware', 'kino-ui.wasm');
const OUT_W98 = join(root, 'apps', 'twin', 'public', 'kino-ui.w98.wasm');

// wasi-sdk 34.0. The digests are the release's own (SHA-256 of the tarball).
const WASI_SDK_VERSION = '34';
const WASI_SDK_ASSETS = {
  'darwin-arm64': { name: 'wasi-sdk-34.0-arm64-macos.tar.gz', sha256: null },
  'darwin-x64': { name: 'wasi-sdk-34.0-x86_64-macos.tar.gz', sha256: null },
  'linux-x64': { name: 'wasi-sdk-34.0-x86_64-linux.tar.gz', sha256: null },
  'linux-arm64': { name: 'wasi-sdk-34.0-arm64-linux.tar.gz', sha256: null },
};

const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const w98 = args.has('--w98');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function findWasiSdk() {
  if (process.env.WASI_SDK) {
    if (!existsSync(join(process.env.WASI_SDK, 'bin', 'clang'))) {
      throw new Error(`WASI_SDK=${process.env.WASI_SDK} has no bin/clang`);
    }
    return process.env.WASI_SDK;
  }
  const key = `${process.platform}-${process.arch}`;
  const asset = WASI_SDK_ASSETS[key];
  if (!asset) throw new Error(`no pinned wasi-sdk for ${key}; set WASI_SDK to an unpacked release`);
  const cache = join(root, '.cache', 'wasi-sdk');
  const dir = join(cache, asset.name.replace(/\.tar\.gz$/, ''));
  if (existsSync(join(dir, 'bin', 'clang'))) return dir;
  mkdirSync(cache, { recursive: true });
  const url = `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/${asset.name}`;
  console.log(`[twin-ui] fetching ${url}`);
  const tar = join(cache, asset.name);
  const curl = spawnSync('curl', ['-sSL', '-o', tar, url], { stdio: 'inherit' });
  if (curl.status !== 0) throw new Error('wasi-sdk download failed');
  if (asset.sha256 && sha256(tar) !== asset.sha256) throw new Error('wasi-sdk digest mismatch');
  const untar = spawnSync('tar', ['xzf', tar, '-C', cache], { stdio: 'inherit' });
  if (untar.status !== 0) throw new Error('wasi-sdk unpack failed');
  rmSync(tar);
  if (!existsSync(join(dir, 'bin', 'clang'))) throw new Error(`unpacked wasi-sdk has no bin/clang at ${dir}`);
  return dir;
}

function build(wasiSdk, icons) {
  const make = spawnSync('make', ['-C', SRC, '-B', `WASI_SDK=${wasiSdk}`, `ICONS=${icons}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (make.status !== 0) {
    process.stderr.write(make.stdout ?? '');
    process.stderr.write(make.stderr ?? '');
    throw new Error('make failed');
  }
  const built = join(SRC, 'kino-ui.wasm');
  if (!existsSync(built)) throw new Error('make produced no kino-ui.wasm');
  return built;
}

const wasiSdk = findWasiSdk();
const built = build(wasiSdk, w98 ? 'w98' : 'placeholder');

if (check) {
  if (!existsSync(OUT)) {
    console.error(`[twin-ui] ${OUT} is missing - run npm run twin:ui:bake`);
    process.exit(1);
  }
  const a = sha256(built);
  const b = sha256(OUT);
  if (a !== b) {
    console.error(`[twin-ui] drift: built ${a.slice(0, 12)} != committed ${b.slice(0, 12)} - run npm run twin:ui:bake`);
    process.exit(1);
  }
  console.log(`[twin-ui] committed kino-ui.wasm matches the source (${a.slice(0, 12)})`);
} else {
  const dest = w98 ? OUT_W98 : OUT;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(built, dest);
  console.log(`[twin-ui] wrote ${dest} (${readFileSync(dest).length} bytes, icons: ${w98 ? 'w98 (private)' : 'placeholder'})`);
}
