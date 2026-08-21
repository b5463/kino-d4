import { firmwareManifest, type FirmwareManifest } from '@kino/schemas';
import { sha256Hex } from './hashing';
import { parseManifest, type FwPackage } from './manifest';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface CatalogRelease {
  manifest: FirmwareManifest;
  release: string;
  channel: string;
  publishedAt: string;
  compatible: boolean;
  reasons: string[];
  notes: string | null;
}

interface CatalogListResponse {
  items: CatalogRelease[];
}

interface CatalogManifestResponse {
  manifest: FirmwareManifest;
  downloads: Record<string, string>;
}

export type CatalogResult<T> = { ok: true; value: T } | { ok: false; error: string };

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function serverError(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return fallback;
}

export async function listFirmwareReleases(
  hardware: string,
  protocol: number,
  channel = 'stable',
  baseUrl = '',
): Promise<CatalogResult<CatalogRelease[]>> {
  const query = new URLSearchParams({ hardware, protocol: String(protocol), channel });
  try {
    const response = await fetch(endpoint(baseUrl, `/api/firmware/releases?${query}`));
    const body = await readJson(response);
    if (!response.ok) {
      return { ok: false, error: serverError(body, `Firmware catalog returned ${response.status}`) };
    }
    if (
      typeof body !== 'object' ||
      body === null ||
      !Array.isArray((body as CatalogListResponse).items)
    ) {
      return { ok: false, error: 'Firmware catalog response is malformed' };
    }

    const items: CatalogRelease[] = [];
    for (const rawItem of (body as CatalogListResponse).items as unknown[]) {
      if (typeof rawItem !== 'object' || rawItem === null) {
        return { ok: false, error: 'Firmware catalog contains a malformed release' };
      }
      const item = rawItem as Record<string, unknown>;
      const parsed = firmwareManifest.shape.safeParse(item.manifest);
      if (
        !parsed.success ||
        typeof item.compatible !== 'boolean' ||
        !Array.isArray(item.reasons) ||
        !item.reasons.every((reason) => typeof reason === 'string') ||
        typeof item.release !== 'string' ||
        typeof item.channel !== 'string' ||
        typeof item.publishedAt !== 'string' ||
        (item.notes !== null && typeof item.notes !== 'string')
      ) {
        return { ok: false, error: 'Firmware catalog contains a malformed release' };
      }
      items.push({
        manifest: parsed.data,
        release: item.release,
        channel: item.channel,
        publishedAt: item.publishedAt,
        compatible: item.compatible,
        reasons: item.reasons as string[],
        notes: item.notes,
      });
    }
    return { ok: true, value: items };
  } catch {
    return {
      ok: false,
      error: 'Firmware catalog is offline. A loaded local package is still available.',
    };
  }
}

async function downloadImage(
  url: string,
  expectedSha: string,
  label: string,
): Promise<CatalogResult<Uint8Array>> {
  try {
    const response = await fetch(url);
    if (!response.ok) return { ok: false, error: `${label} download returned ${response.status}` };
    const declaredBytes = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_IMAGE_BYTES) {
      return { ok: false, error: `${label} image is larger than 4 MB` };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: `${label} image size ${bytes.length} bytes is out of range` };
    }
    if ((await sha256Hex(bytes)) !== expectedSha.toLowerCase()) {
      return { ok: false, error: `${label} image failed SHA-256 verification — download is corrupt` };
    }
    return { ok: true, value: bytes };
  } catch {
    return { ok: false, error: `${label} image could not be downloaded` };
  }
}

export async function downloadFirmwarePackage(
  release: string,
  channel = 'stable',
  baseUrl = '',
): Promise<CatalogResult<FwPackage>> {
  const query = new URLSearchParams({ channel });
  let body: unknown;
  try {
    const response = await fetch(
      endpoint(baseUrl, `/api/firmware/releases/${encodeURIComponent(release)}/manifest?${query}`),
    );
    body = await readJson(response);
    if (!response.ok) {
      return { ok: false, error: serverError(body, `Firmware manifest returned ${response.status}`) };
    }
  } catch {
    return { ok: false, error: 'Firmware manifest could not be downloaded' };
  }

  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Firmware manifest response is malformed' };
  }
  const response = body as CatalogManifestResponse;
  const parsed = firmwareManifest.shape.safeParse(response.manifest);
  if (!parsed.success || typeof response.downloads !== 'object' || response.downloads === null) {
    return { ok: false, error: 'Firmware manifest response is malformed' };
  }

  const main = parsed.data.targets.main;
  const cameraNode = parsed.data.targets.cameraNode;
  const mainUrl = response.downloads.main;
  const cameraNodeUrl = response.downloads.cameraNode;
  if (!main || !cameraNode || typeof mainUrl !== 'string' || typeof cameraNodeUrl !== 'string') {
    return { ok: false, error: 'This KINO D4 package must contain main and cameraNode targets' };
  }

  const [p4Image, xiaoImage] = await Promise.all([
    downloadImage(mainUrl, main.sha256, 'P4'),
    downloadImage(cameraNodeUrl, cameraNode.sha256, 'Camera'),
  ]);
  if (!p4Image.ok) return p4Image;
  if (!xiaoImage.ok) return xiaoImage;

  const legacy = parseManifest({
    schema: 1,
    product: 'kino-v1',
    version: parsed.data.release,
    protocol: parsed.data.protocolMin,
    p4: { version: main.version ?? parsed.data.release, file: main.file, sha256: main.sha256 },
    xiao: {
      version: cameraNode.version ?? parsed.data.release,
      file: cameraNode.file,
      sha256: cameraNode.sha256,
    },
    compatibility: {
      hardware: parsed.data.compatibleHardware,
      minimumProtocol: parsed.data.protocolMin,
    },
  });
  if (!legacy.ok) return legacy;

  return {
    ok: true,
    value: {
      manifest: legacy.manifest,
      p4Image: p4Image.value,
      xiaoImage: xiaoImage.value,
      sourceName: `Roll server · ${parsed.data.release}`,
    },
  };
}
