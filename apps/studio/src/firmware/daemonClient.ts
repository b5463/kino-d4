// Client for the local firmware build daemon (scripts/firmware-daemon.mjs,
// issue #72). The daemon wraps the ONE canonical build environment
// (espressif/idf:v5.5.1 in Docker — the same image CI uses) so Studio never
// grows a second, subtly different build system. Dev tool: localhost only.
import type { FwManifest, FwPackage } from './manifest';
import { sha256Hex } from './hashing';

/**
 * Follows the daemon's KINO_FWD_PORT: set VITE_KINO_FWD_URL for the Studio
 * dev server when the daemon runs on a non-default port (issue #90).
 */
export const DEFAULT_DAEMON_URL =
  (import.meta.env?.VITE_KINO_FWD_URL as string | undefined) ?? 'http://127.0.0.1:5177';

export type DaemonTarget = 'p4' | 'camnode';

export interface DaemonStatus {
  ok: boolean;
  daemon: string;
  repo: string;
  image: string;
  dockerAvailable: boolean;
  dockerVersion: string | null;
  firmwareVersion: string;
  gitCommit: string;
  dirty: boolean;
  targets: DaemonTarget[];
  running: boolean;
}

export interface DaemonBuildStep {
  name: string;
  status: 'running' | 'pass' | 'fail';
  ms: number | null;
}

/** One target's manifest as the daemon emits it: a real kino.firmware-manifest
 * with dev provenance riding as passthrough fields. */
export interface DaemonManifest {
  schema: string;
  version: number;
  release: string;
  channel: string;
  protocolMin: number;
  protocolMax: number;
  compatibleHardware: string[];
  targets: Record<string, { file: string; sha256: string; version?: string }>;
  espIdfVersion?: string;
  chip?: string;
  sizeBytes?: number;
  partitionUsage?: string | null;
  gitCommit?: string;
  gitDirty?: boolean;
  builtAt?: string;
  checksRun?: boolean;
}

export interface DaemonBuild {
  id: string;
  target: DaemonTarget;
  status: 'running' | 'ready' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  steps: DaemonBuildStep[];
  log: string[];
  logOffset: number;
  warnings: number;
  errors: number;
  manifest: DaemonManifest | null;
  error: string | null;
}

export class FirmwareDaemonError extends Error {}

export class FirmwareDaemonClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = DEFAULT_DAEMON_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch {
      throw new FirmwareDaemonError('Build daemon unreachable — run `npm run firmware:daemon` in the repository.');
    }
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new FirmwareDaemonError(body.error ?? `Daemon answered ${response.status}`);
    return body;
  }

  status(): Promise<DaemonStatus> {
    return this.request<DaemonStatus>('/api/status');
  }

  startBuild(target: DaemonTarget, skipChecks = false): Promise<{ id: string }> {
    return this.request<{ id: string }>('/api/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target, skipChecks }),
    });
  }

  build(id: string, since = 0): Promise<DaemonBuild> {
    return this.request<DaemonBuild>(`/api/build/${id}?since=${since}`);
  }

  artifactManifest(target: DaemonTarget): Promise<DaemonManifest> {
    return this.request<DaemonManifest>(`/api/artifact/${target}/manifest`);
  }

  async artifactBin(target: DaemonTarget): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/artifact/${target}/bin`);
    } catch {
      throw new FirmwareDaemonError('Build daemon unreachable — run `npm run firmware:daemon` in the repository.');
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new FirmwareDaemonError(body?.error ?? `Daemon answered ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

/**
 * Assemble the updater's FwPackage from the daemon's two per-target builds,
 * re-verifying every image against its manifest SHA-256 — the same rule the
 * catalog download path enforces. Both targets must exist and carry the same
 * release, because the updater flashes cameras and P4 as one set.
 */
export async function loadDaemonPackage(
  client: FirmwareDaemonClient,
): Promise<{ ok: true; pkg: FwPackage } | { ok: false; error: string }> {
  try {
    const [p4Manifest, camManifest] = await Promise.all([
      client.artifactManifest('p4'),
      client.artifactManifest('camnode'),
    ]);
    const main = p4Manifest.targets.main;
    const cameraNode = camManifest.targets.cameraNode;
    if (!main) return { ok: false, error: 'P4 manifest has no `main` target — rebuild the P4 through the daemon.' };
    if (!cameraNode) return { ok: false, error: 'Camnode manifest has no `cameraNode` target — rebuild it through the daemon.' };
    if (p4Manifest.release !== camManifest.release) {
      return {
        ok: false,
        error: `Target releases disagree (P4 ${p4Manifest.release}, camnode ${camManifest.release}) — rebuild both from the same tree.`,
      };
    }

    const [p4Image, xiaoImage] = await Promise.all([client.artifactBin('p4'), client.artifactBin('camnode')]);
    if ((await sha256Hex(p4Image)) !== main.sha256.toLowerCase()) {
      return { ok: false, error: 'P4 image failed SHA-256 verification against its manifest.' };
    }
    if ((await sha256Hex(xiaoImage)) !== cameraNode.sha256.toLowerCase()) {
      return { ok: false, error: 'Camnode image failed SHA-256 verification against its manifest.' };
    }

    // Same kino.firmware-manifest → legacy FwManifest mapping the catalog
    // uses (catalog.ts): targets.main → p4, targets.cameraNode → xiao.
    const manifest: FwManifest = {
      schema: 1,
      product: 'kino-v1',
      version: p4Manifest.release,
      protocol: p4Manifest.protocolMin,
      p4: { version: main.version ?? p4Manifest.release, file: main.file, sha256: main.sha256 },
      xiao: { version: cameraNode.version ?? camManifest.release, file: cameraNode.file, sha256: cameraNode.sha256 },
      compatibility: { hardware: p4Manifest.compatibleHardware, minimumProtocol: p4Manifest.protocolMin },
    };
    const dirty = p4Manifest.gitDirty || camManifest.gitDirty;
    const commit = (p4Manifest.gitCommit ?? 'unknown').slice(0, 7);
    return {
      ok: true,
      pkg: { manifest, p4Image, xiaoImage, sourceName: `daemon build ${commit}${dirty ? ' (dirty tree)' : ''}` },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
