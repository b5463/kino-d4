import { sha256Hex } from './hashing';
import type { DeviceInfo } from '../protocol/types';

export interface FwManifest {
  schema: number;
  product: string;
  version: string;
  protocol: number;
  p4: { version: string; file: string; sha256: string };
  xiao: { version: string; file: string; sha256: string };
  compatibility: { hardware: string[]; minimumProtocol: number };
  releaseNotes?: string;
}

export interface FwPackage {
  manifest: FwManifest;
  p4Image: Uint8Array;
  xiaoImage: Uint8Array;
  sourceName: string;
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function parseManifest(json: unknown): { ok: true; manifest: FwManifest } | { ok: false; error: string } {
  if (typeof json !== 'object' || json === null) return { ok: false, error: 'manifest.json is not an object' };
  const m = json as Partial<FwManifest>;
  if (m.schema !== 1) return { ok: false, error: `Unsupported manifest schema ${String(m.schema)}` };
  if (m.product !== 'kino-v1') return { ok: false, error: `Package is for "${String(m.product)}", not kino-v1` };
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) {
    return { ok: false, error: 'Package version is missing or malformed' };
  }
  if (typeof m.protocol !== 'number') return { ok: false, error: 'Manifest is missing a protocol version' };
  for (const part of ['p4', 'xiao'] as const) {
    const entry = m[part];
    if (!entry || typeof entry.file !== 'string' || typeof entry.sha256 !== 'string' || typeof entry.version !== 'string') {
      return { ok: false, error: `Manifest ${part} entry is incomplete` };
    }
    if (!/^[0-9a-f]{64}$/i.test(entry.sha256)) {
      return { ok: false, error: `Manifest ${part}.sha256 is not a valid SHA-256 hex digest` };
    }
  }
  if (!m.compatibility || !Array.isArray(m.compatibility.hardware) || typeof m.compatibility.minimumProtocol !== 'number') {
    return { ok: false, error: 'Manifest compatibility block is incomplete' };
  }
  return { ok: true, manifest: m as FwManifest };
}

/** Assemble a package from user-selected files (folder or multi-select). */
export async function loadPackageFromFiles(files: File[]): Promise<{ ok: true; pkg: FwPackage } | { ok: false; error: string }> {
  const byName = new Map<string, File>();
  for (const f of files) {
    // webkitdirectory gives paths like "kino-0.5.0/p4-app.bin" — use basename.
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const base = rel.split('/').pop() ?? f.name;
    if (!byName.has(base)) byName.set(base, f);
  }
  const manifestFile = byName.get('manifest.json');
  if (!manifestFile) return { ok: false, error: 'No manifest.json in the selected package' };

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(await manifestFile.text());
  } catch {
    return { ok: false, error: 'manifest.json is not valid JSON' };
  }
  const parsed = parseManifest(manifestJson);
  if (!parsed.ok) return parsed;
  const manifest = parsed.manifest;

  const readImage = async (
    name: string,
    expectedSha: string,
    label: string,
  ): Promise<{ error: string; bytes?: never } | { bytes: Uint8Array; error?: never }> => {
    const file = byName.get(name);
    if (!file) return { error: `Package is missing ${name}` };
    if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
      return { error: `${name} size ${file.size} bytes is out of range` };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const actual = await sha256Hex(bytes);
    if (actual !== expectedSha.toLowerCase()) {
      return { error: `${label} image failed SHA-256 verification — package is corrupt` };
    }
    return { bytes };
  };

  const p4 = await readImage(manifest.p4.file, manifest.p4.sha256, 'P4');
  if (p4.error !== undefined) return { ok: false, error: p4.error };
  const xiao = await readImage(manifest.xiao.file, manifest.xiao.sha256, 'Camera');
  if (xiao.error !== undefined) return { ok: false, error: xiao.error };

  const dirName = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split('/')[0];
  return {
    ok: true,
    pkg: { manifest, p4Image: p4.bytes, xiaoImage: xiao.bytes, sourceName: dirName || 'selected files' },
  };
}

export interface CompatibilityCheck {
  ok: boolean;
  problems: string[];
}

export function checkCompatibility(manifest: FwManifest, device: DeviceInfo): CompatibilityCheck {
  const problems: string[] = [];
  const hw = device.hardware.toLowerCase();
  if (!manifest.compatibility.hardware.map((h) => h.toLowerCase()).includes(hw)) {
    problems.push(`Package supports hardware ${manifest.compatibility.hardware.join(', ')} — this KINO is ${device.hardware}`);
  }
  if (device.protocol < manifest.compatibility.minimumProtocol) {
    problems.push(
      `Package needs protocol ${manifest.compatibility.minimumProtocol}+, device reports ${device.protocol}.`,
    );
  }
  return { ok: problems.length === 0, problems };
}
