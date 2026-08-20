import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { firmwareManifest, type FirmwareManifest } from '@kino/schemas';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { loadConfig } from '../src/config';
import { firmwareReleases } from '../src/db/schema';

const RUN = randomBytes(4).toString('hex');
const IDS = [`fw_${RUN}_stable`, `fw_${RUN}_beta`, `fw_${RUN}_other`, `fw_${RUN}_unsafe`];
const app: FastifyInstance = buildServer(loadConfig());

function manifest(
  release: string,
  channel: string,
  hardware: string[],
  protocolMin = 1,
  file = 'p4-app.bin',
): FirmwareManifest {
  return firmwareManifest.shape.parse({
    schema: 'kino.firmware-manifest',
    version: 1,
    release,
    channel,
    protocolMin,
    protocolMax: 3,
    compatibleHardware: hardware,
    targets: {
      main: { file, sha256: 'a'.repeat(64), version: release },
      cameraNode: { file: 'xiao-app.bin', sha256: 'b'.repeat(64), version: release },
    },
  });
}

beforeAll(async () => {
  await app.ready();
  const rows = [
    { id: IDS[0]!, doc: manifest(`1.0.${RUN.slice(0, 2)}`, 'stable', ['v1']) },
    { id: IDS[1]!, doc: manifest(`1.0.${RUN.slice(0, 2)}`, 'beta', ['v1']) },
    { id: IDS[2]!, doc: manifest(`2.0.${RUN.slice(0, 2)}`, 'stable', ['v2'], 2) },
    { id: IDS[3]!, doc: manifest(`3.0.${RUN.slice(0, 2)}`, 'stable', ['v1'], 1, '../escape.bin') },
  ];
  await app.db.insert(firmwareReleases).values(
    rows.map(({ id, doc }, index) => ({
      id,
      release: doc.release,
      channel: doc.channel ?? 'stable',
      compatibleHardware: doc.compatibleHardware,
      protocolMin: doc.protocolMin,
      protocolMax: doc.protocolMax,
      manifest: doc,
      notes: index === 0 ? 'Stable release notes' : null,
      publishedAt: new Date(Date.UTC(2026, 7, 20, 10, index)),
    })),
  );
}, 60_000);

afterAll(async () => {
  await app.db.delete(firmwareReleases).where(inArray(firmwareReleases.id, IDS));
  await app.close();
}, 60_000);

describe('firmware catalog API', () => {
  it('requires device hardware and validates protocol', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/firmware/releases' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'HARDWARE_REQUIRED' });

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/firmware/releases?hardware=v1&protocol=old',
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'INVALID_PROTOCOL' });
  });

  it('returns only the requested channel and marks incompatible releases without hiding them', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/firmware/releases?hardware=v1&protocol=1&channel=stable',
    });
    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: Array<Record<string, unknown>> }>().items.filter(
      (item) => IDS.some((id) => String(id).includes(RUN)) && String(item.release).endsWith(RUN.slice(0, 2)),
    );
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.channel === 'stable')).toBe(true);
    expect(items.find((item) => String(item.release).startsWith('1.0.'))).toMatchObject({
      compatible: true,
      reasons: [],
      notes: 'Stable release notes',
    });
    expect(items.find((item) => String(item.release).startsWith('2.0.'))).toMatchObject({
      compatible: false,
      reasons: ['Requires hardware v2', 'Requires protocol 2–3'],
    });
  });

  it('selects the manifest by both release and channel and signs the firmware bucket', async () => {
    const release = `1.0.${RUN.slice(0, 2)}`;
    const stable = await app.inject({
      method: 'GET',
      url: `/api/firmware/releases/${release}/manifest?channel=stable`,
    });
    expect(stable.statusCode).toBe(200);
    const body = stable.json<{ manifest: FirmwareManifest; downloads: Record<string, string> }>();
    expect(body.manifest.channel).toBe('stable');
    expect(body.downloads.main).toContain(
      `/${app.config.S3_FIRMWARE_BUCKET}/firmware/stable/${release}/p4-app.bin`,
    );

    const beta = await app.inject({
      method: 'GET',
      url: `/api/firmware/releases/${release}/manifest?channel=beta`,
    });
    expect(beta.statusCode).toBe(200);
    expect(beta.json<{ manifest: FirmwareManifest }>().manifest.channel).toBe('beta');
  });

  it('refuses an unsafe object path stored in a manifest', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/firmware/releases/3.0.${RUN.slice(0, 2)}/manifest`,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'INVALID_FIRMWARE_FILE' });
  });
});
