import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildServer } from '../src/server';
import { loadConfig } from '../src/config';
import { devices } from '../src/db/schema';

const RUN = randomBytes(5).toString('hex');
const SERIAL = `KD4-METRICS-${RUN}`;
const TOKEN = `metrics-${randomBytes(24).toString('hex')}`;
const app = buildServer(
  loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', METRICS_TOKEN: TOKEN }),
);

let deviceToken = '';

beforeAll(async () => {
  await app.ready();
  const registered = await app.inject({
    method: 'POST',
    url: '/api/studio/devices/register',
    payload: { serial: SERIAL, product: 'KINO D4', hardwareRevision: 'v1' },
  });
  deviceToken = registered.json<{ deviceToken: string }>().deviceToken;
  await app.inject({
    method: 'GET',
    url: '/api/device/ping',
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  await app.inject({
    method: 'POST',
    url: '/api/device/captures/not-real/complete',
    headers: { authorization: `Bearer ${deviceToken}` },
  });
}, 30_000);

afterAll(async () => {
  await app.db.delete(devices).where(eq(devices.serial, SERIAL));
  await app.close();
});

describe('GET /api/metrics', () => {
  it('requires the dedicated bearer token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/metrics' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/metrics',
          headers: { authorization: 'Bearer wrong-token' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('exports standard Prometheus text for every required application signal', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    for (const metric of [
      'kino_http_request_duration_seconds',
      'kino_http_errors_total',
      'kino_upload_failures_total 1',
      'kino_queue_jobs',
      'kino_worker_failures',
      'kino_object_storage_bytes',
      'kino_sse_connections',
      'kino_active_devices 1',
    ]) {
      expect(response.body).toContain(metric);
    }
    expect(response.body).not.toContain(TOKEN);
    expect(response.body).not.toContain(deviceToken);
  }, 30_000);
});
