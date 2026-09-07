import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildServer } from '../src/server';
import { loadConfig } from '../src/config';
import { newToken } from '../src/auth/tokens';
import { RATE_LIMITS } from '../src/plugins/rateLimits';
import {
  guestMissIndexKey,
  guestMissKey,
  guestSweepKey,
} from '../src/routes/guest-rolls';
import { auditEvents, devices, rolls } from '../src/db/schema';

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
  it('limits PIN attempts per address AND roll, not per address alone', async () => {
    // Sixty a minute, not five: behind the relay a whole venue is one address,
    // and a crowd typing the right PIN at the doors must not 429 itself.
    await exhaust(
      {
        method: 'POST',
        url: '/api/rolls/RATE01/pin',
        headers: { 'x-forwarded-for': ip(1) },
        payload: { pin: '0000' },
      },
      RATE_LIMITS.pinAttempt.max,
    );

    // The same address against a DIFFERENT roll still has its full budget: the
    // key carries the slug, so one roll cannot spend another's.
    const other = await app.inject({
      method: 'POST',
      url: '/api/rolls/RATE02/pin',
      headers: { 'x-forwarded-for': ip(1) },
      payload: { pin: '0000' },
    });
    expect(other.statusCode).not.toBe(429);
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

  it('limits the device status poll to 120 requests per minute and bearer token', async () => {
    await exhaust(
      {
        method: 'GET',
        url: '/api/device/captures/cap_rate_limit_missing/status',
        headers: {
          authorization: `Bearer ${newToken('kdt')}`,
          'x-forwarded-for': ip(5),
        },
      },
      RATE_LIMITS.deviceRead.max,
    );
  });

  it('limits the device roll list to 120 requests per minute and bearer token', async () => {
    // Its own counter: `@fastify/rate-limit` keys the Redis store per route
    // (`RedisStore.child` appends method and URL), so a `groupId` names a
    // budget, it does not pool one across routes.
    await exhaust(
      {
        method: 'GET',
        url: '/api/device/rolls/current',
        headers: {
          authorization: `Bearer ${newToken('kdt')}`,
          'x-forwarded-for': ip(6),
        },
      },
      RATE_LIMITS.deviceRead.max,
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

/**
 * The guest slug oracle. Ten unknown slugs from one address lock that address
 * out of `GET /api/rolls/:slug` for an hour, and while locked a *real* slug
 * gets the very same 404 — a distinct answer would be a second oracle.
 */
describe('guest slug miss lock', () => {
  const missBody = { code: 'ROLL_NOT_FOUND', message: 'no roll with that slug' };
  /** Valid in shape, belongs to no roll. Upper case: the key carries the normalised form. */
  const MISSED_SLUG = 'ZZZZZ2';
  let rollId = '';
  let slug = '';

  beforeAll(async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/host/rolls',
      headers: { 'x-forwarded-for': ip(7) },
      payload: { title: `Miss lock ${suffix}` },
    });
    expect(created.statusCode).toBe(201);
    ({ rollId, slug } = created.json<{ rollId: string; slug: string }>());
  });

  afterAll(async () => {
    // ip(2) is the guest-read exhaustion above: 301 misses on one slug leave a
    // pair lock AND a sweep count behind, and the sweep count is deliberately
    // never cleared by a hit, so every address this file touches is swept here.
    await app.redis.del(
      guestMissKey(ip(2), 'RATE-LIMIT-MISSING'),
      guestMissKey(ip(8), MISSED_SLUG),
      guestMissKey(ip(9), MISSED_SLUG),
      ...[2, 8, 9, 10].map((offset) => guestSweepKey(ip(offset))),
      ...[2, 8, 9, 10].map((offset) => guestMissIndexKey(ip(offset))),
    );
    await app.db.delete(auditEvents).where(eq(auditEvents.rollId, rollId));
    await app.db.delete(rolls).where(eq(rolls.id, rollId));
  });

  it('locks the address AND slug that was missed, and nothing else', async () => {
    const headers = { 'x-forwarded-for': ip(8) };

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const miss = await app.inject({ method: 'GET', url: `/api/rolls/${MISSED_SLUG}`, headers });
      expect(miss.statusCode).toBe(404);
      expect(miss.json()).toEqual(missBody);
    }
    expect(await app.redis.get(guestMissKey(ip(8), MISSED_SLUG))).toBe('10');
    // The count carries its hour.
    expect(await app.redis.ttl(guestMissKey(ip(8), MISSED_SLUG))).toBeGreaterThan(3500);

    // Locked for that pair: the same address asking the same unknown code again
    // gets the miss answer without the roll table being touched.
    const locked = await app.inject({ method: 'GET', url: `/api/rolls/${MISSED_SLUG}`, headers });
    expect(locked.statusCode).toBe(404);
    expect(locked.json()).toEqual(missBody);

    /**
     * The regression this key shape exists for. Behind the relay a whole venue
     * is one address, and the old per-address lock took the party's own gallery
     * away after ten mistyped codes anywhere on the uplink. A second slug from
     * the same address — the venue's real roll — must still answer.
     */
    const secondSlug = await app.inject({ method: 'GET', url: `/api/rolls/${slug}`, headers });
    expect(secondSlug.statusCode).toBe(200);

    // And a second UNKNOWN slug from that address is a fresh count, not a lock.
    const secondMiss = await app.inject({ method: 'GET', url: '/api/rolls/YYYYY9', headers });
    expect(secondMiss.statusCode).toBe(404);
    expect(await app.redis.get(guestMissKey(ip(8), 'YYYYY9'))).toBe('1');
    await app.redis.del(guestMissKey(ip(8), 'YYYYY9'));

    // Another address is unaffected either way.
    const other = await app.inject({
      method: 'GET',
      url: `/api/rolls/${slug}`,
      headers: { 'x-forwarded-for': ip(10) },
    });
    expect(other.statusCode).toBe(200);
  });

  it('clears the pair count on a hit, so hand-typed mistakes stay forgiving', async () => {
    const headers = { 'x-forwarded-for': ip(9) };

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const miss = await app.inject({ method: 'GET', url: `/api/rolls/${MISSED_SLUG}`, headers });
      expect(miss.statusCode).toBe(404);
    }
    expect(await app.redis.get(guestMissKey(ip(9), MISSED_SLUG))).toBe('9');

    /**
     * The hit is on a DIFFERENT slug from the one that was missed, and that is
     * the case worth asserting: a venue fumbles a code, then types its own one
     * correctly. Forgiveness has to reach the fumbled code's count, not just
     * the found slug's own (which never had one).
     */
    const hit = await app.inject({ method: 'GET', url: `/api/rolls/${slug}`, headers });
    expect(hit.statusCode).toBe(200);
    expect(await app.redis.get(guestMissKey(ip(9), MISSED_SLUG))).toBeNull();
    expect(await app.redis.smembers(guestMissIndexKey(ip(9)))).toEqual([]);

    // The sweep count survives that hit on purpose: an enumerator holding one
    // real slug must not be able to reset its own budget.
    expect(Number(await app.redis.get(guestSweepKey(ip(9))))).toBe(9);

    // And the tenth miss after a hit is the first of a new count, not a lock.
    const again = await app.inject({ method: 'GET', url: `/api/rolls/${MISSED_SLUG}`, headers });
    expect(again.statusCode).toBe(404);
    const stillOpen = await app.inject({ method: 'GET', url: `/api/rolls/${slug}`, headers });
    expect(stillOpen.statusCode).toBe(200);
  });
});
