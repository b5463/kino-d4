import { describe, it, expect, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { loadConfig } from '../src/config';

// Precondition: the dev services must be running.
//   docker compose -f infra/docker-compose.dev.yml up -d
// See apps/api/README.md.

const app: FastifyInstance = buildServer(loadConfig());

afterAll(async () => {
  await app.close();
});

describe('GET /api/healthz', () => {
  it('reports every backing service reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: true, redis: true, storage: true });
  }, 30_000);

  // Guards against the probes degrading into hardcoded `true`s.
  it('reports 503 when nothing is reachable', async () => {
    const unreachable = buildServer(
      loadConfig({
        DATABASE_URL: 'postgres://kino:kino@127.0.0.1:1/kino',
        REDIS_URL: 'redis://127.0.0.1:1',
        S3_ENDPOINT: 'http://127.0.0.1:1',
        LOG_LEVEL: 'silent',
      }),
    );

    try {
      const res = await unreachable.inject({ method: 'GET', url: '/api/healthz' });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ ok: false, db: false, redis: false, storage: false });
    } finally {
      await unreachable.close();
    }
  }, 30_000);
});
