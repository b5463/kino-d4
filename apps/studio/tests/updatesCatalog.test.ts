import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FirmwareManifest } from '@kino/schemas';
import { downloadFirmwarePackage, listFirmwareReleases } from '../src/firmware/catalog';
import { sha256Hex } from '../src/firmware/hashing';
import { setUpdateState, useUpdateStore } from '../src/state/updateStore';
import type { FwPackage } from '../src/firmware/manifest';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

async function manifestFor(p4: Uint8Array, camera: Uint8Array): Promise<FirmwareManifest> {
  return {
    schema: 'kino.firmware-manifest',
    version: 1,
    release: '1.2.3',
    channel: 'stable',
    protocolMin: 1,
    protocolMax: 3,
    compatibleHardware: ['v1'],
    targets: {
      main: { file: 'p4-app.bin', version: '1.2.3', sha256: await sha256Hex(p4) },
      cameraNode: { file: 'xiao-app.bin', version: '1.2.2', sha256: await sha256Hex(camera) },
    },
    updateOrder: ['cameraNode', 'main'],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('firmware catalog', () => {
  it('sends device truth and keeps incompatible releases visible', async () => {
    const manifest = await manifestFor(bytes('p4'), bytes('camera'));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(
        JSON.stringify({
          items: [
            {
              manifest,
              release: manifest.release,
              channel: 'stable',
              publishedAt: '2026-08-20T10:00:00.000Z',
              compatible: false,
              reasons: ['Requires protocol 2–3'],
              notes: null,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await listFirmwareReleases('KINO D4 v1', 1);

    expect(result.ok && result.value[0]).toMatchObject({
      release: '1.2.3',
      compatible: false,
      reasons: ['Requires protocol 2–3'],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'hardware=KINO+D4+v1&protocol=1&channel=stable',
    );
  });

  it('downloads both targets and verifies their SHA-256 before returning a package', async () => {
    const p4 = bytes('verified-p4');
    const camera = bytes('verified-camera');
    const manifest = await manifestFor(p4, camera);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/manifest?')) {
          return new Response(
            JSON.stringify({
              manifest,
              downloads: { main: 'https://objects.test/p4', cameraNode: 'https://objects.test/camera' },
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/p4')) return new Response(p4, { status: 200 });
        if (url.endsWith('/camera')) return new Response(camera, { status: 200 });
        return new Response(null, { status: 404 });
      }),
    );

    const result = await downloadFirmwarePackage('1.2.3');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.p4Image).toEqual(p4);
    expect(result.value.xiaoImage).toEqual(camera);
    expect(result.value.manifest.p4.version).toBe('1.2.3');
    expect(result.value.manifest.xiao.version).toBe('1.2.2');
    expect(result.value.sourceName).toBe('Roll server · 1.2.3');
  });

  it('rejects a hash mismatch before the updater can receive the package', async () => {
    const p4 = bytes('expected-p4');
    const camera = bytes('camera');
    const manifest = await manifestFor(p4, camera);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/manifest?')) {
          return new Response(
            JSON.stringify({
              manifest,
              downloads: { main: 'https://objects.test/p4', cameraNode: 'https://objects.test/camera' },
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/p4')) return new Response(bytes('tampered-p4'), { status: 200 });
        return new Response(camera, { status: 200 });
      }),
    );

    const result = await downloadFirmwarePackage('1.2.3');

    expect(result).toEqual({
      ok: false,
      error: 'P4 image failed SHA-256 verification — download is corrupt',
    });
  });

  it('leaves a previously loaded package intact when the catalog is offline', async () => {
    const cached: FwPackage = {
      manifest: {
        schema: 1,
        product: 'kino-v1',
        version: '1.0.0',
        protocol: 1,
        p4: { version: '1.0.0', file: 'p4.bin', sha256: 'a'.repeat(64) },
        xiao: { version: '1.0.0', file: 'xiao.bin', sha256: 'b'.repeat(64) },
        compatibility: { hardware: ['v1'], minimumProtocol: 1 },
      },
      p4Image: bytes('cached-p4'),
      xiaoImage: bytes('cached-camera'),
      sourceName: 'cached package',
    };
    setUpdateState({ pkg: cached });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));

    const result = await listFirmwareReleases('v1', 1);

    expect(result.ok).toBe(false);
    expect(useUpdateStore.getState().pkg).toBe(cached);
  });
});
