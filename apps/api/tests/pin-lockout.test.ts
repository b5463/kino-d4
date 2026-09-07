import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { loadConfig } from '../src/config';
import { PIN_ATTEMPT_LIMIT, pinAttemptKey } from '../src/auth/pinLockout';
import * as schema from '../src/db/schema';

/**
 * The per-roll PIN attempt counter.
 *
 * Before it, the only defence on `POST /api/rolls/:slug/pin` was five attempts
 * a minute per source address, and behind the relay that number is wrong in
 * both directions: a venue is one address, so a crowd typing the right PIN
 * locks itself out, while an attacker spread over many addresses keeps five
 * guesses each against a four-digit PIN and the roll never notices.
 *
 * So the two tests that matter are the two halves of that: a roll that has
 * taken its wrong answers stops answering, and a roll that has not is entirely
 * unaffected — the counter is on the roll, not on the server.
 *
 * Runs against the real database and real Redis; the dev stack must be up and
 * migrated, same as every other route suite here.
 */
const RUN = randomBytes(4).toString('hex');
const app: FastifyInstance = buildServer({ ...loadConfig(), TRUST_PROXY: true, LOG_LEVEL: 'silent' });

const PIN_A = '4821';
const PIN_B = '9075';

const createdRollIds: string[] = [];
let deviceId = '';
let rollA: { rollId: string; slug: string };
let rollB: { rollId: string; slug: string };

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/**
 * A distinct source address per test, so the per-address REQUEST limit (sixty a
 * minute per address and roll) can never be what a test observes. The thing
 * under test is the per-roll counter, and the two must not be confused.
 */
const suffix = randomBytes(2).readUInt16BE(0);
const ip = (offset: number): string => `10.${(suffix >> 8) & 255}.${suffix & 255}.${offset}`;

async function attempt(slug: string, pin: string, from: string) {
  return app.inject({
    method: 'POST',
    url: `/api/rolls/${slug}/pin`,
    headers: { 'x-forwarded-for': from },
    payload: { pin },
  });
}

beforeAll(async () => {
  await app.ready();
  const registered = await app.inject({
    method: 'POST',
    url: '/api/studio/devices/register',
    headers: bearer(app.config.PROVISIONING_TOKEN),
    payload: { serial: `KD4-PIN-${RUN}`, product: 'KINO D4', hardwareRevision: 'v1' },
  });
  expect(registered.statusCode).toBe(200);
  const device = registered.json<{ deviceId: string; deviceToken: string }>();
  deviceId = device.deviceId;

  const create = async (pin: string): Promise<{ rollId: string; slug: string }> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/device/rolls',
      headers: bearer(device.deviceToken),
      payload: { title: `PIN lockout ${RUN}`, pin },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ rollId: string; slug: string }>();
    createdRollIds.push(created.rollId);
    return created;
  };
  rollA = await create(PIN_A);
  rollB = await create(PIN_B);
}, 60_000);

afterAll(async () => {
  for (const id of createdRollIds) await app.redis.del(pinAttemptKey(id));
  if (createdRollIds.length > 0) {
    await app.db.delete(schema.rolls).where(inArray(schema.rolls.id, createdRollIds));
  }
  if (deviceId !== '') {
    await app.db.delete(schema.devices).where(eq(schema.devices.id, deviceId));
  }
  await app.close();
}, 60_000);

describe('per-roll PIN lockout', () => {
  it('closes one roll after N wrong PINs and leaves an unrelated roll open', async () => {
    const from = ip(1);

    for (let guess = 1; guess < PIN_ATTEMPT_LIMIT; guess += 1) {
      const wrong = await attempt(rollA.slug, '0000', from);
      expect(wrong.statusCode, `attempt ${guess} was not a plain 401`).toBe(401);
      expect(wrong.json()).toMatchObject({ code: 'INVALID_PIN' });
    }

    // The attempt that trips it says so, rather than answering 401 and leaving
    // the caller to discover the lock on the next request.
    const tripping = await attempt(rollA.slug, '0000', from);
    expect(tripping.statusCode).toBe(429);
    expect(tripping.json()).toMatchObject({ code: 'PIN_LOCKED' });
    expect(Number(tripping.headers['retry-after'])).toBeGreaterThan(0);

    /**
     * Locked means locked to the *correct* PIN too. A lockout that still let
     * the right answer through would be no lockout at all — the attacker's last
     * guess is by definition the right one.
     */
    const correct = await attempt(rollA.slug, PIN_A, from);
    expect(correct.statusCode).toBe(429);
    expect(correct.json()).toMatchObject({ code: 'PIN_LOCKED' });

    /**
     * And the half that keeps this usable at a party: the counter is on the
     * ROLL. Another roll, same address, same second — its PIN still opens it.
     * A shared uplink is not a shared fate.
     */
    const other = await attempt(rollB.slug, PIN_B, from);
    expect(other.statusCode).toBe(200);
    expect(other.json()).toMatchObject({ ok: true });

    // A different address gets the same refusal on roll A: the lock follows the
    // roll, which is what makes it survive a distributed attacker.
    const elsewhere = await attempt(rollA.slug, PIN_A, ip(2));
    expect(elsewhere.statusCode).toBe(429);
    expect(elsewhere.json()).toMatchObject({ code: 'PIN_LOCKED' });
  });

  it('clears the count when a guest gets in, so a fumbling crowd is forgiven', async () => {
    const from = ip(3);
    await app.redis.del(pinAttemptKey(rollB.rollId));

    for (let guess = 1; guess < PIN_ATTEMPT_LIMIT; guess += 1) {
      expect((await attempt(rollB.slug, '1111', from)).statusCode).toBe(401);
    }
    expect(Number(await app.redis.get(pinAttemptKey(rollB.rollId)))).toBe(PIN_ATTEMPT_LIMIT - 1);

    const opened = await attempt(rollB.slug, PIN_B, from);
    expect(opened.statusCode).toBe(200);
    expect(await app.redis.get(pinAttemptKey(rollB.rollId))).toBeNull();

    // So the next wrong answer starts a new count rather than tripping the lock.
    const after = await attempt(rollB.slug, '1111', from);
    expect(after.statusCode).toBe(401);
  });

  it('sets the count with an expiry, so a lockout is not permanent', async () => {
    const from = ip(4);
    await app.redis.del(pinAttemptKey(rollB.rollId));
    expect((await attempt(rollB.slug, '2222', from)).statusCode).toBe(401);
    // The window opens on the FIRST failure, not on each one: a steady attacker
    // must not be able to hold it open by keeping the count warm.
    expect(await app.redis.ttl(pinAttemptKey(rollB.rollId))).toBeGreaterThan(0);
  });
});
