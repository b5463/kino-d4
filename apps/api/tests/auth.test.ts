import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { loadConfig } from '../src/config';
import { hashToken, newToken } from '../src/auth/tokens';
import { hashPin, verifyPin } from '../src/auth/pins';
import { DEV_COOKIE_SECRET } from '../src/config';
import * as schema from '../src/db/schema';

/**
 * Auth is the first feature whose tests exercise real routes against real
 * tables, so — unlike `db.test.ts`, which owns a throwaway `kino_test`
 * database — this suite runs against the configured database (the dev `kino`
 * one locally, the CI service database in CI) and cleans up after itself.
 *
 * Everything it writes is namespaced by a per-run id, so a leftover row from an
 * aborted run cannot collide with the `devices.serial` / `rolls.slug` unique
 * constraints on the next one.
 *
 * Precondition: the dev services must be running AND migrated.
 *   docker compose -f infra/docker-compose.dev.yml up -d
 *   npm run db:migrate -w @kino/api
 * `beforeAll` probes for the tables and says so explicitly if they are absent.
 */
const RUN = randomBytes(4).toString('hex');

const app: FastifyInstance = buildServer(loadConfig());

/** Tables this suite reads or writes; the probe below names the missing ones. */
const REQUIRED_TABLES = ['devices', 'rolls', 'roll_devices'];

const SERIAL_A = `KD4-T16-${RUN}-A`;
const SERIAL_B = `KD4-T16-${RUN}-B`;
const SERIALS = [SERIAL_A, SERIAL_B];

const ROLL_OPEN = `roll_t16_${RUN}_open`;
const ROLL_OTHER = `roll_t16_${RUN}_other`;
const ROLL_PIN = `roll_t16_${RUN}_pin`;
const ROLL_PIN_ROTATE = `roll_t16_${RUN}_rot`;
const ROLL_IDS = [ROLL_OPEN, ROLL_OTHER, ROLL_PIN, ROLL_PIN_ROTATE];

const slugOf = (roll: string): string => `T16${RUN.toUpperCase()}${roll.slice(-3).toUpperCase()}`;

const PIN = '4821';
const ROTATED_PIN = '9075';

/** Filled by `beforeAll`; the register route is the only issuer of a device token. */
let deviceA: { deviceId: string; deviceToken: string };
let deviceB: { deviceId: string; deviceToken: string };

const hostTokenOpen = newToken('hrt');
const hostTokenOther = newToken('hrt');

interface RegisterResponse {
  deviceId: string;
  deviceToken: string;
}

async function register(body: Record<string, unknown>): Promise<RegisterResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/studio/devices/register',
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  return res.json<RegisterResponse>();
}

/**
 * Set once the schema probe passes. `afterAll` checks it so that an unmigrated
 * database produces the single actionable error below, rather than that error
 * plus a second "relation ... does not exist" from the cleanup.
 */
let migrated = false;

/**
 * Turns "relation roll_devices does not exist" — which drizzle reports from
 * whichever query happens to run first, several frames deep — into the one
 * sentence that actually fixes it.
 */
async function assertMigrated(): Promise<void> {
  const rows = await app.db.execute<{ table_name: string }>(sql`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('devices', 'rolls', 'roll_devices')
  `);

  const present = new Set(Array.from(rows).map((row) => row.table_name));
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));

  if (missing.length > 0) {
    throw new Error(
      `Database is not migrated: missing table(s) ${missing.join(', ')}. ` +
        'Run `npm run db:migrate -w @kino/api` against DATABASE_URL and re-run the tests.',
    );
  }

  migrated = true;
}

beforeAll(async () => {
  await app.ready();
  await assertMigrated();

  deviceA = await register({
    serial: SERIAL_A,
    product: 'KINO D4',
    hardwareRevision: 'v1',
    name: 'Bench A',
  });
  deviceB = await register({ serial: SERIAL_B, product: 'KINO D4', hardwareRevision: 'v1' });

  await app.db
    .insert(schema.rolls)
    .values([
      {
        id: ROLL_OPEN,
        slug: slugOf(ROLL_OPEN),
        title: 'Open roll',
        hostTokenHash: hostTokenOpen.hash,
        createdByDeviceId: deviceA.deviceId,
      },
      {
        id: ROLL_OTHER,
        slug: slugOf(ROLL_OTHER),
        title: 'Another host roll',
        hostTokenHash: hostTokenOther.hash,
        createdByDeviceId: deviceB.deviceId,
      },
      {
        id: ROLL_PIN,
        slug: slugOf(ROLL_PIN),
        title: 'PIN roll',
        privacy: 'pin',
        pinHash: await hashPin(PIN),
        hostTokenHash: newToken('hrt').hash,
        createdByDeviceId: deviceA.deviceId,
      },
      {
        id: ROLL_PIN_ROTATE,
        slug: slugOf(ROLL_PIN_ROTATE),
        title: 'PIN roll whose PIN gets rotated',
        privacy: 'pin',
        pinHash: await hashPin(PIN),
        hostTokenHash: newToken('hrt').hash,
        createdByDeviceId: deviceA.deviceId,
      },
    ])
    .execute();

  // deviceB did not create ROLL_OPEN; it joined it. deviceA is the creator.
  await app.db
    .insert(schema.rollDevices)
    .values({ rollId: ROLL_OPEN, deviceId: deviceB.deviceId })
    .execute();
}, 60_000);

afterAll(async () => {
  // Children before parents: roll_devices references both of the others.
  if (migrated) {
    await app.db.delete(schema.rollDevices).where(inArray(schema.rollDevices.rollId, ROLL_IDS));
    await app.db.delete(schema.rolls).where(inArray(schema.rolls.id, ROLL_IDS));
    await app.db.delete(schema.devices).where(inArray(schema.devices.serial, SERIALS));
  }
  await app.close();
}, 60_000);

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

describe('token primitives', () => {
  it('mints a prefixed, URL-safe token and its sha256 hash', () => {
    const { token, hash } = newToken('kdt');

    // `kdt_` + base64url(32 bytes) = 4 + 43 characters.
    expect(token).toMatch(/^kdt_[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // The hash covers the FULL token string, prefix included — so a `kdt_` and
    // an `hrt_` token can never share a hash even if the random half collides.
    expect(hash).toBe(hashToken(token));
  });

  it('never repeats a token', () => {
    const minted = new Set(Array.from({ length: 64 }, () => newToken('hrt').token));
    expect(minted.size).toBe(64);
    for (const token of minted) expect(token.startsWith('hrt_')).toBe(true);
  });
});

describe('PIN hashing', () => {
  it('accepts the right PIN', async () => {
    await expect(verifyPin(PIN, await hashPin(PIN))).resolves.toBe(true);
  });

  it('rejects the wrong PIN', async () => {
    const stored = await hashPin(PIN);

    await expect(verifyPin(ROTATED_PIN, stored)).resolves.toBe(false);
    await expect(verifyPin('', stored)).resolves.toBe(false);
    // A prefix of the right PIN must not pass.
    await expect(verifyPin(PIN.slice(0, -1), stored)).resolves.toBe(false);
  });

  /**
   * The documented invariant in pins.ts: a roll marked `privacy: 'pin'` with no
   * `pin_hash` is a misconfiguration, and the safe reading of a missing lock is
   * "locked", not "open". If this ever returned true, every PIN roll whose hash
   * failed to write would silently become public.
   */
  it('treats a missing stored hash as locked, not open', async () => {
    await expect(verifyPin(PIN, null)).resolves.toBe(false);
    await expect(verifyPin('', null)).resolves.toBe(false);
    // Unparseable stored values are equally closed.
    await expect(verifyPin(PIN, 'not-a-scrypt-hash')).resolves.toBe(false);
    await expect(verifyPin(PIN, 'scrypt$16384$8$1$onlyfiveparts')).resolves.toBe(false);
  });

  it('salts, so the same PIN hashes differently every time', async () => {
    const stored = await hashPin(PIN);

    expect(stored).not.toContain(PIN);
    await expect(hashPin(PIN)).resolves.not.toBe(stored);
  });
});

describe('POST /api/studio/devices/register', () => {
  it('returns a kdt_ token and stores only its hash', async () => {
    expect(deviceA.deviceId).toMatch(/^dev_/);
    expect(deviceA.deviceToken).toMatch(/^kdt_[A-Za-z0-9_-]{43}$/);

    const [row] = await app.db
      .select({ tokenHash: schema.devices.tokenHash, serial: schema.devices.serial })
      .from(schema.devices)
      .where(eq(schema.devices.id, deviceA.deviceId));

    expect(row?.serial).toBe(SERIAL_A);
    expect(row?.tokenHash).toBe(hashToken(deviceA.deviceToken));
    // The plaintext token exists in exactly one place: the response above.
    expect(row?.tokenHash).not.toBe(deviceA.deviceToken);
  });

  it('rejects a body that is missing required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/studio/devices/register',
      payload: { serial: SERIAL_A },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_BODY' });
  });
});

describe('device tokens (03 §17)', () => {
  it('authenticates /api/device/ping', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/device/ping',
      headers: bearer(deviceA.deviceToken),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      scope: 'device',
      deviceId: deviceA.deviceId,
      serial: SERIAL_A,
    });
  });

  it('rejects a tampered token with 401', async () => {
    // Same shape, same prefix, one character different in the random half.
    const last = deviceA.deviceToken.slice(-1);
    const tampered = deviceA.deviceToken.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect(tampered).not.toBe(deviceA.deviceToken);

    const res = await app.inject({
      method: 'GET',
      url: '/api/device/ping',
      headers: bearer(tampered),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'INVALID_DEVICE_TOKEN' });
  });

  it('rejects a missing Authorization header with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/device/ping' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'DEVICE_TOKEN_REQUIRED' });
  });

  it('re-registering the same serial rotates the token', async () => {
    const rotated = await register({
      serial: SERIAL_A,
      product: 'KINO D4',
      hardwareRevision: 'v1',
    });

    // Physical possession is the trust anchor, so the device row is the same
    // one — only its credential changes.
    expect(rotated.deviceId).toBe(deviceA.deviceId);
    expect(rotated.deviceToken).not.toBe(deviceA.deviceToken);

    const stale = await app.inject({
      method: 'GET',
      url: '/api/device/ping',
      headers: bearer(deviceA.deviceToken),
    });
    expect(stale.statusCode).toBe(401);

    const fresh = await app.inject({
      method: 'GET',
      url: '/api/device/ping',
      headers: bearer(rotated.deviceToken),
    });
    expect(fresh.statusCode).toBe(200);

    deviceA = rotated;
  });
});

describe('device scoping to rolls (07 §25)', () => {
  it('lets the creating device reach its roll', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/device/rolls/${ROLL_OPEN}/ping`,
      headers: bearer(deviceA.deviceToken),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ scope: 'device', rollId: ROLL_OPEN });
  });

  it('lets a joined device reach the same roll', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/device/rolls/${ROLL_OPEN}/ping`,
      headers: bearer(deviceB.deviceToken),
    });

    expect(res.statusCode).toBe(200);
  });

  it('refuses a roll the device neither created nor joined', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/device/rolls/${ROLL_PIN}/ping`,
      headers: bearer(deviceB.deviceToken),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'DEVICE_NOT_IN_ROLL' });
  });
});

describe('host tokens (05 §12)', () => {
  it('operates the roll it belongs to', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${ROLL_OPEN}/ping`,
      headers: bearer(hostTokenOpen.token),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      scope: 'host',
      rollId: ROLL_OPEN,
      slug: slugOf(ROLL_OPEN),
    });
  });

  it('cannot operate a different roll', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${ROLL_OTHER}/ping`,
      headers: bearer(hostTokenOpen.token),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'INVALID_HOST_TOKEN' });
  });

  it('answers 404 for a roll that does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/host/rolls/roll_does_not_exist/ping',
      headers: bearer(hostTokenOpen.token),
    });

    expect(res.statusCode).toBe(404);
  });

  it('never exposes credential hashes in host roll context', async () => {
    // requireHost is where `hostTokenHash` is actually read, so it is the most
    // likely place for it to get re-attached to the request by accident.
    const res = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${ROLL_OPEN}/context`,
      headers: bearer(hostTokenOpen.token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();

    expect(Object.keys(body)).not.toContain('hostTokenHash');
    expect(Object.keys(body)).not.toContain('pinHash');
    expect(body).toMatchObject({ id: ROLL_OPEN });
    expect(JSON.stringify(body)).not.toContain(hostTokenOpen.hash);
  });
});

describe('token scopes do not cross (07 §25)', () => {
  it('refuses a device token on a host route with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${ROLL_OPEN}/ping`,
      headers: bearer(deviceA.deviceToken),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'WRONG_TOKEN_SCOPE' });
  });

  it('refuses a host token on a device route with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/device/ping',
      headers: bearer(hostTokenOpen.token),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'WRONG_TOKEN_SCOPE' });
  });

  it('refuses to register a device-scoped route outside /api/device (boot check)', async () => {
    const probe = buildServer(loadConfig({ ...process.env, LOG_LEVEL: 'silent' }));
    probe.register(async (instance) => {
      instance.get(
        '/api/host/rolls/:rollId/sneaky',
        { preHandler: instance.requireDevice },
        async () => ({ ok: true }),
      );
    });

    try {
      await expect(probe.ready()).rejects.toThrow(/\/api\/device\//);
    } finally {
      await probe.close().catch(() => {});
    }
  });
});

describe('fail-closed hardening', () => {
  const REAL_SECRET = 'a-real-production-cookie-secret-value';

  /**
   * The check asks "is this provably development?", not "is this production?".
   * Keying it the other way would fail OPEN on the most likely deployment
   * mistake there is — forgetting to set NODE_ENV at all.
   */
  it('refuses the published dev cookie secret unless NODE_ENV is development or test', () => {
    // Unset NODE_ENV: the mistake that must not be the safe one.
    expect(() => loadConfig({})).toThrow(/COOKIE_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/COOKIE_SECRET/);
    // An unrecognised environment is refused too, not waved through.
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(/COOKIE_SECRET/);
  });

  it('allows the dev default only in development and test', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).COOKIE_SECRET).toBe(DEV_COOKIE_SECRET);
    expect(loadConfig({ NODE_ENV: 'test' }).COOKIE_SECRET).toBe(DEV_COOKIE_SECRET);
  });

  it('accepts any environment once a real secret is supplied', () => {
    const config = loadConfig({ NODE_ENV: 'production', COOKIE_SECRET: REAL_SECRET });
    expect(config.COOKIE_SECRET).toBe(REAL_SECRET);
  });

  it('names the offending variable without printing any secret value', () => {
    // 05 §13: config errors report names, never values.
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(DEV_COOKIE_SECRET) as unknown as string,
      }),
    );
  });

  it('registers the diagnostic routes only when NODE_ENV is test', async () => {
    const probe = buildServer(
      loadConfig({
        ...process.env,
        NODE_ENV: 'production',
        COOKIE_SECRET: REAL_SECRET,
        LOG_LEVEL: 'silent',
      }),
    );

    try {
      await probe.ready();

      // Every diagnostic route, the two `/context` probes included — those are
      // the ones that return the roll context verbatim, so they are the most
      // valuable to a prober and the least acceptable to leave registered.
      const gated = [
        '/api/device/ping',
        `/api/device/rolls/${ROLL_OPEN}/ping`,
        `/api/host/rolls/${ROLL_OPEN}/ping`,
        `/api/rolls/${slugOf(ROLL_OPEN)}/ping`,
        `/api/rolls/${slugOf(ROLL_OPEN)}/context`,
        `/api/host/rolls/${ROLL_OPEN}/context`,
      ];
      for (const url of gated) {
        const res = await probe.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(404);
      }

      // The gate is selective, not a kill switch: real routes still answer.
      const register = await probe.inject({
        method: 'POST',
        url: '/api/studio/devices/register',
        payload: {},
      });
      expect(register.statusCode).toBe(400);
    } finally {
      await probe.close().catch(() => {});
    }
  }, 30_000);
});

describe('guest access and the PIN session (03 §18)', () => {
  const pinUrl = (roll: string): string => `/api/rolls/${slugOf(roll)}/pin`;
  const guestUrl = (roll: string): string => `/api/rolls/${slugOf(roll)}/ping`;

  it('reads an unlisted roll with no cookie at all', async () => {
    const res = await app.inject({ method: 'GET', url: guestUrl(ROLL_OPEN) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ scope: 'guest', rollId: ROLL_OPEN, privacy: 'unlisted' });
  });

  it('answers 404 for an unknown slug', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/rolls/NOSUCH/ping' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'ROLL_NOT_FOUND' });
  });

  it('demands a PIN before reading a pin-protected roll', async () => {
    const res = await app.inject({ method: 'GET', url: guestUrl(ROLL_PIN) });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'PIN_REQUIRED' });
  });

  it('rejects the wrong PIN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: pinUrl(ROLL_PIN),
      payload: { pin: '0000' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'INVALID_PIN' });
    expect(res.cookies).toEqual([]);
  });

  it('accepts the right PIN, sets a cookie, and unlocks subsequent reads', async () => {
    const unlock = await app.inject({
      method: 'POST',
      url: pinUrl(ROLL_PIN),
      payload: { pin: PIN },
    });

    expect(unlock.statusCode).toBe(200);

    const cookie = unlock.cookies.find((c) => c.name === `kino_pin_${ROLL_PIN}`);
    expect(cookie).toBeDefined();
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    // The PIN itself must never travel back to the client in any form.
    expect(cookie?.value).not.toContain(PIN);

    const read = await app.inject({
      method: 'GET',
      url: guestUrl(ROLL_PIN),
      headers: { cookie: `${cookie?.name}=${cookie?.value}` },
    });

    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ scope: 'guest', rollId: ROLL_PIN, privacy: 'pin' });
  });

  it('refuses an unsigned cookie value', async () => {
    // A guest who guesses the cookie NAME still cannot mint its value.
    const res = await app.inject({
      method: 'GET',
      url: guestUrl(ROLL_PIN),
      headers: { cookie: `kino_pin_${ROLL_PIN}=${ROLL_PIN}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'PIN_REQUIRED' });
  });

  /**
   * `request.roll` is what a handler reaches for, and `return rollOf(request)`
   * is the obvious one-liner. If the credential hashes rode along in that
   * object, that line would hand a guest the roll's host token hash and PIN
   * hash. The `/context` probes return the context object verbatim so this is
   * asserted rather than assumed.
   */
  it('never exposes credential hashes in guest roll context', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/rolls/${slugOf(ROLL_OPEN)}/context` });

    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();

    expect(Object.keys(body)).not.toContain('hostTokenHash');
    expect(Object.keys(body)).not.toContain('pinHash');
    // Guards the premise: a probe that returned {} would pass the two above.
    expect(body).toMatchObject({ id: ROLL_OPEN, slug: slugOf(ROLL_OPEN), privacy: 'unlisted' });
    // And no value anywhere in the payload is a stored hash.
    expect(JSON.stringify(body)).not.toContain(hostTokenOpen.hash);
  });

  it('invalidates an issued cookie when the roll PIN changes', async () => {
    const unlock = await app.inject({
      method: 'POST',
      url: pinUrl(ROLL_PIN_ROTATE),
      payload: { pin: PIN },
    });
    expect(unlock.statusCode).toBe(200);
    const cookie = unlock.cookies.find((c) => c.name === `kino_pin_${ROLL_PIN_ROTATE}`);
    const asHeader = { cookie: `${cookie?.name}=${cookie?.value}` };

    const before = await app.inject({
      method: 'GET',
      url: guestUrl(ROLL_PIN_ROTATE),
      headers: asHeader,
    });
    expect(before.statusCode).toBe(200);

    await app.db
      .update(schema.rolls)
      .set({ pinHash: await hashPin(ROTATED_PIN) })
      .where(eq(schema.rolls.id, ROLL_PIN_ROTATE))
      .execute();

    const after = await app.inject({
      method: 'GET',
      url: guestUrl(ROLL_PIN_ROTATE),
      headers: asHeader,
    });

    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ code: 'PIN_REQUIRED' });
  });
});
