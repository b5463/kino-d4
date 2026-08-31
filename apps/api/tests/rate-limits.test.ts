import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildServer } from '../src/server';
import { loadConfig } from '../src/config';
import { newToken } from '../src/auth/tokens';
import { RATE_LIMITS } from '../src/plugins/rateLimits';
import { devices } from '../src/db/schema';

const suffix = randomBytes(2).readUInt16BE(0);
const ip = (offset: number): string => `10.${(suffix >> 8) & 255}.${suffix & 255}.${offset}`;
const app: FastifyInstance = buildServer({
  ...loadConfig(),
  TRUST_PROXY: true,
  LOG_LEVEL: 'silent',
});

async function exhaust(options: InjectOptions, allowed: number): Promise<void> {
  for (let attempt = 0; attempt < allowed; attempt += 1) {
    const response = await app.inject(options);
    expect(response.statusCode, `request ${attempt + 1} was limited early`).not.toBe(429);
  }
  const limited = await app.inject(options);
  expect(limited.statusCode).toBe(429);
  expect(limited.headers['retry-after']).toBeDefined();
}

beforeAll(async () => app.ready(), 60_000);
afterAll(async () => app.close(), 60_000);

describe('shared production rate limits', () => {
  it('limits PIN attempts to five requests per minute and IP', async () => {
    await exhaust(
      {
        method: 'POST',
        url: '/api/rolls/rate-limit-missing/pin',
        headers: { 'x-forwarded-for': ip(1) },
        payload: { pin: '0000' },
      },
      RATE_LIMITS.pinAttempt.max,
    );
  });

  it('limits public guest reads to 300 requests per minute and IP', async () => {
    await exhaust(
      {
        method: 'GET',
        url: '/api/rolls/rate-limit-missing',
        headers: { 'x-forwarded-for': ip(2) },
      },
      RATE_LIMITS.guestRead.max,
    );
  });

  it('limits device uploads to 60 requests per minute and bearer token', async () => {
    await exhaust(
      {
        method: 'POST',
        url: '/api/device/rolls/rate-limit-missing/captures',
        headers: {
          authorization: `Bearer ${newToken('kdt')}`,
          'x-forwarded-for': ip(3),
        },
        payload: {},
      },
      RATE_LIMITS.deviceUpload.max,
    );
  });

  it('locks a device out for an hour after ten unknown Roll join codes', async () => {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/studio/devices/register',
      headers: {
        'x-forwarded-for': ip(4),
        authorization: `Bearer ${app.config.PROVISIONING_TOKEN}`,
      },
      payload: {
        serial: `KD4-RATE-${randomBytes(4).toString('hex')}`,
        product: 'KINO D4',
        hardwareRevision: 'v1',
      },
    });
    expect(registered.statusCode).toBe(200);
    const device = registered.json<{ deviceId: string; deviceToken: string }>();
    const headers = {
      authorization: `Bearer ${device.deviceToken}`,
      'x-forwarded-for': ip(4),
    };

    try {
      for (let attempt = 1; attempt < 10; attempt += 1) {
        const miss = await app.inject({
          method: 'POST',
          url: '/api/device/rolls/join',
          headers,
          payload: { slug: 'ZZZZZZ' },
        });
        expect(miss.statusCode).toBe(404);
      }
      const locked = await app.inject({
        method: 'POST',
        url: '/api/device/rolls/join',
        headers,
        payload: { slug: 'ZZZZZZ' },
      });
      expect(locked.statusCode).toBe(429);
      expect(locked.json()).toMatchObject({ code: 'JOIN_LOCKED' });
    } finally {
      await app.redis.del(`join-misses:${device.deviceId}`);
      await app.db.delete(devices).where(eq(devices.id, device.deviceId));
    }
  });
});
