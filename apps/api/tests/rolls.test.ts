import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { loadConfig, type ApiConfig } from '../src/config';
import { hashToken } from '../src/auth/tokens';
import { SLUG_ALPHABET, SLUG_PATTERN, newSlug } from '../src/rolls/slug';
import {
  assertRollAcceptsUploads,
  guestUrlFor,
  hostUrlFor,
  isSlugCollision,
} from '../src/rolls/rolls';
import * as schema from '../src/db/schema';

/**
 * Roll lifecycle (Task 17), against the real database — same house rules as
 * `auth.test.ts`: the dev services must be up AND migrated, and everything this
 * suite writes is namespaced by a per-run id so an aborted run cannot collide
 * with the next one on `devices.serial`.
 *
 *   docker compose -f infra/docker-compose.dev.yml up -d
 *   npm run db:migrate -w @kino/api
 *
 * Rolls here are created *through the API*, so their ids and slugs are not
 * known up front; `track()` records every id the suite causes to exist and
 * `afterAll` deletes them children-first.
 */
const RUN = randomBytes(4).toString('hex');

const config: ApiConfig = loadConfig();
const app: FastifyInstance = buildServer(config);

const REQUIRED_TABLES = ['devices', 'rolls', 'roll_devices', 'audit_events'];

const SERIAL_A = `KD4-T17-${RUN}-A`;
const SERIAL_B = `KD4-T17-${RUN}-B`;
const SERIALS = [SERIAL_A, SERIAL_B];

/** Every roll id this suite creates, in creation order, for cleanup. */
const createdRollIds: string[] = [];

function track<T extends { rollId: string }>(created: T): T {
  createdRollIds.push(created.rollId);
  return created;
}

let deviceA: { deviceId: string; deviceToken: string };
let deviceB: { deviceId: string; deviceToken: string };

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

interface CreatedRollResponse {
  rollId: string;
  slug: string;
  guestUrl: string;
  hostUrl: string;
  hostToken: string;
}

async function register(serial: string): Promise<{ deviceId: string; deviceToken: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/studio/devices/register',
    // The provisioning secret this endpoint is gated on. Read off the server's
    // own config rather than hard-coded, so a bench with a real one in
    // `infra/.env` runs the suite unchanged.
    headers: { authorization: `Bearer ${app.config.PROVISIONING_TOKEN}` },
    payload: { serial, product: 'KINO D4', hardwareRevision: 'v1' },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ deviceId: string; deviceToken: string }>();
}

/** Creates a roll as `deviceA` unless told otherwise, and registers it for cleanup. */
async function createAsDevice(
  body: Record<string, unknown> = {},
  token: string = deviceA.deviceToken,
): Promise<CreatedRollResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/device/rolls',
    headers: bearer(token),
    payload: { title: `Roll ${RUN}`, ...body },
  });
  expect(res.statusCode).toBe(201);
  return track(res.json<CreatedRollResponse>());
}

async function createAsHost(body: Record<string, unknown> = {}): Promise<CreatedRollResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/host/rolls',
    payload: { title: `Host roll ${RUN}`, ...body },
  });
  expect(res.statusCode).toBe(201);
  return track(res.json<CreatedRollResponse>());
}

let migrated = false;

async function assertMigrated(): Promise<void> {
  const rows = await app.db.execute<{ table_name: string }>(sql`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('devices', 'rolls', 'roll_devices', 'audit_events')
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

/** Audit actions recorded against a roll, most recent last. */
async function auditActions(rollId: string): Promise<string[]> {
  const rows = await app.db
    .select({ action: schema.auditEvents.action, at: schema.auditEvents.at })
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.rollId, rollId))
    .orderBy(schema.auditEvents.at);
  return rows.map((row) => row.action);
}

async function rollRow(rollId: string): Promise<typeof schema.rolls.$inferSelect> {
  const [row] = await app.db.select().from(schema.rolls).where(eq(schema.rolls.id, rollId));
  if (row === undefined) throw new Error(`roll ${rollId} vanished`);
  return row;
}

beforeAll(async () => {
  await app.ready();
  await assertMigrated();

  deviceA = await register(SERIAL_A);
  deviceB = await register(SERIAL_B);
}, 60_000);

afterAll(async () => {
  if (migrated && createdRollIds.length > 0) {
    // Children before parents: audit_events and roll_devices both reference rolls.
    const { auditEvents, rollDevices, rolls } = schema;
    await app.db.delete(auditEvents).where(inArray(auditEvents.rollId, createdRollIds));
    await app.db.delete(rollDevices).where(inArray(rollDevices.rollId, createdRollIds));
    await app.db.delete(rolls).where(inArray(rolls.id, createdRollIds));
  }
  if (migrated) {
    await app.db.delete(schema.devices).where(inArray(schema.devices.serial, SERIALS));
  }
  await app.close();
}, 60_000);

describe('slug (05 §14)', () => {
  it('draws 6 characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 512; i += 1) {
      const slug = newSlug();
      expect(slug).toMatch(SLUG_PATTERN);
      expect(slug).toHaveLength(6);
    }
  });

  it('excludes every character pair a human can misread', () => {
    // 0/O, 1/I/L are the whole reason the alphabet is 31 characters, not 36:
    // a slug gets read off a phone screen and typed into another one.
    for (const banned of ['0', 'O', '1', 'I', 'L']) {
      expect(SLUG_ALPHABET).not.toContain(banned);
    }
    expect(SLUG_ALPHABET).toHaveLength(31);
  });

  it('uses every character of the alphabet, so no value is unreachable', () => {
    // Rejection sampling done wrong silently narrows the alphabet, which is
    // invisible in a regex check but halves the keyspace.
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) for (const ch of newSlug()) seen.add(ch);
    expect(seen.size).toBe(SLUG_ALPHABET.length);
  });

  it('does not repeat', () => {
    const drawn = new Set(Array.from({ length: 2_000 }, () => newSlug()));
    // 31^6 is ~887M, so 2000 draws colliding would mean the generator is broken.
    expect(drawn.size).toBe(2_000);
  });

  /**
   * The retry loop in `rolls.ts` only works if it can recognise a slug
   * collision, and that depends on the error shape the driver actually throws —
   * which drizzle wraps or does not wrap depending on its version. Provoking a
   * REAL unique violation is the only way to test that honestly; a fabricated
   * error object would just assert my own assumption back at me.
   */
  it('recognises a real slug collision, which is what makes the retry work', async () => {
    const created = await createAsHost({ title: 'Collision bait' });

    let thrown: unknown;
    try {
      await app.db
        .insert(schema.rolls)
        .values({
          id: `roll_collision_${RUN}`,
          slug: created.slug, // Already taken.
          title: 'Duplicate slug',
          hostTokenHash: 'not-a-real-hash',
        })
        .execute();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect(isSlugCollision(thrown)).toBe(true);
    // And it must NOT match every unique violation — a device-serial clash is a
    // caller error to report, not something to retry with a new slug.
    expect(isSlugCollision(new Error('boom'))).toBe(false);
  });
});

describe('public URLs', () => {
  it('builds the guest and host links from PUBLIC_BASE_URL', () => {
    expect(guestUrlFor(config, 'ABC234')).toBe(`${config.PUBLIC_BASE_URL}/r/ABC234`);
    expect(hostUrlFor(config, 'hrt_xyz')).toBe(`${config.PUBLIC_BASE_URL}/host#token=hrt_xyz`);
  });

  it('does not double a trailing slash on the base', () => {
    const trailing = { ...config, PUBLIC_BASE_URL: 'https://kino.example/' };
    expect(guestUrlFor(trailing, 'ABC234')).toBe('https://kino.example/r/ABC234');
    expect(hostUrlFor(trailing, 'hrt_xyz')).toBe('https://kino.example/host#token=hrt_xyz');
  });
});

describe('POST /api/device/rolls (03 §8)', () => {
  it('creates a roll and returns the slug, both URLs and the host token', async () => {
    const created = await createAsDevice({ title: 'Friday House Party' });

    expect(created.rollId).toMatch(/^roll_/);
    expect(created.slug).toMatch(SLUG_PATTERN);
    expect(created.hostToken).toMatch(/^hrt_[A-Za-z0-9_-]{43}$/);
    expect(created.guestUrl).toBe(`${config.PUBLIC_BASE_URL}/r/${created.slug}`);
    expect(created.hostUrl).toBe(`${config.PUBLIC_BASE_URL}/host#token=${created.hostToken}`);

    const row = await rollRow(created.rollId);
    expect(row.title).toBe('Friday House Party');
    expect(row.status).toBe('live');
    expect(row.privacy).toBe('unlisted');
    expect(row.createdByDeviceId).toBe(deviceA.deviceId);
    // The plaintext host token exists in the creation response and nowhere else.
    expect(row.hostTokenHash).toBe(hashToken(created.hostToken));
    expect(row.hostTokenHash).not.toBe(created.hostToken);
  });

  it('accepts a PIN at creation and marks the roll pin-protected', async () => {
    const created = await createAsDevice({ title: 'Locked', pin: '4821' });
    const row = await rollRow(created.rollId);

    expect(row.privacy).toBe('pin');
    expect(row.pinHash).toMatch(/^scrypt\$/);
    expect(row.pinHash).not.toContain('4821');
  });

  it('honours downloadsEnabled', async () => {
    const created = await createAsDevice({ title: 'No downloads', downloadsEnabled: false });
    expect((await rollRow(created.rollId)).downloadsEnabled).toBe(false);
  });

  it('requires a device token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/device/rolls',
      payload: { title: 'Anonymous' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'DEVICE_TOKEN_REQUIRED' });
  });

  /**
   * `privacy` is derived from `pin`, so a client that sends it and gets a 201
   * would believe it had locked a roll that is in fact wide open. That is the
   * failure the strict bodies exist to prevent.
   */
  it('rejects an unknown field rather than silently dropping it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/device/rolls',
      headers: bearer(deviceA.deviceToken),
      payload: { title: 'Sneaky', privacy: 'pin' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_BODY' });
  });

  it('rejects a body with no title', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/device/rolls',
      headers: bearer(deviceA.deviceToken),
      payload: { downloadsEnabled: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_BODY' });
  });
});

describe('POST /api/device/rolls/join (07 §25)', () => {
  it('lets a second device join by slug and unlocks requireDeviceRoll', async () => {
    const created = await createAsDevice({ title: 'Joinable' });

    // Before joining, deviceB is a stranger to this roll.
    const before = await app.inject({
      method: 'GET',
      url: `/api/device/rolls/${created.rollId}/ping`,
      headers: bearer(deviceB.deviceToken),
    });
    expect(before.statusCode).toBe(403);
    expect(before.json()).toMatchObject({ code: 'DEVICE_NOT_IN_ROLL' });

    const join = await app.inject({
      method: 'POST',
      url: '/api/device/rolls/join',
      headers: bearer(deviceB.deviceToken),
      payload: { slug: created.slug },
    });
    expect(join.statusCode).toBe(200);
    // guestUrl comes from the server so a joining device never fabricates
    // one from its own origin (issue #86).
    expect(join.json()).toEqual({
      rollId: created.rollId,
      title: 'Joinable',
      status: 'live',
      guestUrl: expect.stringMatching(new RegExp(`/r/${created.slug}$`)) as unknown,
    });

    // The join row is the mechanism Task 16's requireDeviceRoll depends on.
    const [link] = await app.db
      .select()
      .from(schema.rollDevices)
      .where(
        and(
          eq(schema.rollDevices.rollId, created.rollId),
          eq(schema.rollDevices.deviceId, deviceB.deviceId),
        ),
      );
    expect(link).toBeDefined();

    const after = await app.inject({
      method: 'GET',
      url: `/api/device/rolls/${created.rollId}/ping`,
      headers: bearer(deviceB.deviceToken),
    });
    expect(after.statusCode).toBe(200);
  });

  it('is idempotent', async () => {
    const created = await createAsDevice({ title: 'Join twice' });
    const payload = { slug: created.slug };

    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/device/rolls/join',
        headers: bearer(deviceB.deviceToken),
        payload,
      });
      expect(res.statusCode).toBe(200);
    }

    const links = await app.db
      .select()
      .from(schema.rollDevices)
      .where(eq(schema.rollDevices.rollId, created.rollId));
    expect(links).toHaveLength(1);
  });

  it('answers 404 for an unknown slug', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/device/rolls/join',
      headers: bearer(deviceB.deviceToken),
      payload: { slug: 'ZZZZZZ' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'ROLL_NOT_FOUND' });
  });

  it('requires a device token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/device/rolls/join',
      payload: { slug: 'ZZZZZZ' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/device/rolls/current (03 §17)', () => {
  it('lists rolls the device created and rolls it joined, and nothing else', async () => {
    const mine = await createAsDevice({ title: 'Mine' });
    const joined = await createAsDevice({ title: 'Theirs' }, deviceB.deviceToken);
    const strangers = await createAsDevice({ title: 'Strangers' }, deviceB.deviceToken);

    await app.inject({
      method: 'POST',
      url: '/api/device/rolls/join',
      headers: bearer(deviceA.deviceToken),
      payload: { slug: joined.slug },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/device/rolls/current',
      headers: bearer(deviceA.deviceToken),
    });
    expect(res.statusCode).toBe(200);

    const ids = res.json<{ rolls: { rollId: string }[] }>().rolls.map((r) => r.rollId);
    expect(ids).toContain(mine.rollId);
    expect(ids).toContain(joined.rollId);
    expect(ids).not.toContain(strangers.rollId);
  });

  it('drops a roll once it is closed', async () => {
    const created = await createAsDevice({ title: 'Will close' });
    const listed = async (): Promise<string[]> => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/device/rolls/current',
        headers: bearer(deviceA.deviceToken),
      });
      return res.json<{ rolls: { rollId: string }[] }>().rolls.map((r) => r.rollId);
    };

    expect(await listed()).toContain(created.rollId);

    const close = await app.inject({
      method: 'PATCH',
      url: `/api/host/rolls/${created.rollId}`,
      headers: bearer(created.hostToken),
      payload: { status: 'closed' },
    });
    expect(close.statusCode).toBe(200);

    expect(await listed()).not.toContain(created.rollId);
  });

  it('never returns a credential hash', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/device/rolls/current',
      headers: bearer(deviceA.deviceToken),
    });

    expect(res.body).not.toContain('hostTokenHash');
    expect(res.body).not.toContain('pinHash');
    expect(res.body).not.toContain('hrt_');
  });
});

describe('POST /api/host/rolls (03 §8, host web)', () => {
  it('creates a roll with its own host token and no owning device', async () => {
    const created = await createAsHost({ title: 'From the web' });

    expect(created.slug).toMatch(SLUG_PATTERN);
    expect(created.hostToken).toMatch(/^hrt_/);

    const row = await rollRow(created.rollId);
    expect(row.createdByDeviceId).toBeNull();
    expect(row.hostTokenHash).toBe(hashToken(created.hostToken));

    // And the token it just minted actually opens the roll.
    const res = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${created.rollId}`,
      headers: bearer(created.hostToken),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/host/rolls/:rollId', () => {
  it('returns the full roll with placeholder counts', async () => {
    const created = await createAsHost({ title: 'Dashboard' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${created.rollId}`,
      headers: bearer(created.hostToken),
    });
    expect(res.statusCode).toBe(200);

    expect(res.json()).toMatchObject({
      rollId: created.rollId,
      slug: created.slug,
      title: 'Dashboard',
      status: 'live',
      privacy: 'unlisted',
      hasPin: false,
      downloadsEnabled: true,
      guestUrl: created.guestUrl,
      // Captures do not exist until Task 18; these are honest zeros.
      counts: { captures: 0, pending: 0, hidden: 0 },
    });
  });

  it('reports the creating camera serial, while web-created rolls report none', async () => {
    const deviceRoll = await createAsDevice({ title: 'Camera dashboard' });
    const webRoll = await createAsHost({ title: 'Web dashboard' });

    const deviceResponse = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${deviceRoll.rollId}`,
      headers: bearer(deviceRoll.hostToken),
    });
    expect(deviceResponse.json()).toMatchObject({ deviceSerial: SERIAL_A });

    const webResponse = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${webRoll.rollId}`,
      headers: bearer(webRoll.hostToken),
    });
    expect(webResponse.json()).toMatchObject({ deviceSerial: null });
  });

  it('never leaks a credential hash', async () => {
    const created = await createAsHost({ title: 'Secretive', pin: '4821' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${created.rollId}`,
      headers: bearer(created.hostToken),
    });

    const body = res.json<Record<string, unknown>>();
    expect(Object.keys(body)).not.toContain('hostTokenHash');
    expect(Object.keys(body)).not.toContain('pinHash');
    expect(res.body).not.toContain(hashToken(created.hostToken));
    expect(res.body).not.toContain('4821');
    // The host does get told there IS a PIN — just never what it is.
    expect(body).toMatchObject({ hasPin: true, privacy: 'pin' });
  });

  it('refuses another roll’s host token', async () => {
    const mine = await createAsHost({ title: 'Mine' });
    const other = await createAsHost({ title: 'Other' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${mine.rollId}`,
      headers: bearer(other.hostToken),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'INVALID_HOST_TOKEN' });
  });

  it('refuses a device token with 403 (07 §25 regression)', async () => {
    const created = await createAsHost({ title: 'Device keep out' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${created.rollId}`,
      headers: bearer(deviceA.deviceToken),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'WRONG_TOKEN_SCOPE' });
  });
});

describe('GET /api/host/session', () => {
  it('resolves the owning Roll from the host token alone', async () => {
    const created = await createAsHost({ title: 'Token-owned dashboard' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/host/session',
      headers: bearer(created.hostToken),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rollId: created.rollId, title: 'Token-owned dashboard' });
    expect(res.body).not.toContain(hashToken(created.hostToken));
  });

  it('rejects an unknown or wrong-scope token without revealing a Roll', async () => {
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/host/session',
      headers: bearer('hrt_unknown'),
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toMatchObject({ code: 'INVALID_HOST_TOKEN' });

    const device = await app.inject({
      method: 'GET',
      url: '/api/host/session',
      headers: bearer(deviceA.deviceToken),
    });
    expect(device.statusCode).toBe(403);
    expect(device.json()).toMatchObject({ code: 'WRONG_TOKEN_SCOPE' });
  });
});

describe('PATCH /api/host/rolls/:rollId', () => {
  it('renames, and writes an audit row naming the OLD title', async () => {
    const created = await createAsHost({ title: 'Before' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/host/rolls/${created.rollId}`,
      headers: bearer(created.hostToken),
      payload: { title: 'After' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: 'After' });
    expect((await rollRow(created.rollId)).title).toBe('After');

    expect(await auditActions(created.rollId)).toContain('roll.renamed');
    const [event] = await app.db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.rollId, created.rollId),
          eq(schema.auditEvents.action, 'roll.renamed'),
        ),
      );
    expect(event?.actor).toBe('host');
    // The row now says 'After'; the audit trail is the only place 'Before' survives.
    expect(event?.target).toBe('Before');
  });

  it('toggles downloads', async () => {
    const created = await createAsHost({ title: 'Downloads' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/host/rolls/${created.rollId}`,
      headers: bearer(created.hostToken),
      payload: { downloadsEnabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ downloadsEnabled: false });
    expect(await auditActions(created.rollId)).toContain('roll.downloads-disabled');
  });

  it('rejects an empty patch', async () => {
    const created = await createAsHost({ title: 'Nothing to do' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/host/rolls/${created.rollId}`,
      headers: bearer(created.hostToken),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'NO_UPDATE_FIELDS' });
  });

  it('refuses a device token with 403 (07 §25 regression)', async () => {
    const created = await createAsHost({ title: 'Device keep out' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/host/rolls/${created.rollId}`,
      headers: bearer(deviceA.deviceToken),
      payload: { title: 'Hijacked' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'WRONG_TOKEN_SCOPE' });
    expect((await rollRow(created.rollId)).title).toBe('Device keep out');
  });
});

describe('roll states (03 §22)', () => {
  const patchStatus = async (
    created: CreatedRollResponse,
    status: string,
  ): Promise<ReturnType<FastifyInstance['inject']>> =>
    app.inject({
      method: 'PATCH',
      url: `/api/host/rolls/${created.rollId}`,
      headers: bearer(created.hostToken),
      payload: { status },
    });

  it('closes a live roll, stamps closedAt, and audits it', async () => {
    const created = await createAsHost({ title: 'Closing time' });

    const res = await patchStatus(created, 'closed');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'closed' });

    const row = await rollRow(created.rollId);
    expect(row.status).toBe('closed');
    expect(row.closedAt).not.toBeNull();
    expect(await auditActions(created.rollId)).toContain('roll.closed');
  });

  it('reopens a closed roll and clears closedAt', async () => {
    const created = await createAsHost({ title: 'Reopen me' });

    expect((await patchStatus(created, 'closed')).statusCode).toBe(200);
    expect((await patchStatus(created, 'live')).statusCode).toBe(200);

    const row = await rollRow(created.rollId);
    expect(row.status).toBe('live');
    expect(row.closedAt).toBeNull();
    expect(await auditActions(created.rollId)).toContain('roll.reopened');
  });

  it('archives a closed roll, and archived is terminal', async () => {
    const created = await createAsHost({ title: 'Archive me' });

    expect((await patchStatus(created, 'closed')).statusCode).toBe(200);
    expect((await patchStatus(created, 'archived')).statusCode).toBe(200);
    expect(await auditActions(created.rollId)).toContain('roll.archived');

    for (const target of ['live', 'closed']) {
      const res = await patchStatus(created, target);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'INVALID_STATE' });
    }
    expect((await rollRow(created.rollId)).status).toBe('archived');
  });

  it('refuses to archive a roll that was never closed', async () => {
    const created = await createAsHost({ title: 'Straight to archive' });

    const res = await patchStatus(created, 'archived');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_STATE' });
    expect((await rollRow(created.rollId)).status).toBe('live');
  });

  it('refuses a status outside the V1 set', async () => {
    const created = await createAsHost({ title: 'Bad status' });

    for (const target of ['trash', 'draft', 'LIVE', '']) {
      const res = await patchStatus(created, target);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'INVALID_BODY' });
    }
  });

  it('closing shuts the upload gate that Task 18 consumes', async () => {
    const created = await createAsHost({ title: 'Upload gate' });

    // Live: the gate is open.
    const live = await rollRow(created.rollId);
    expect(() => assertRollAcceptsUploads(live)).not.toThrow();

    expect((await patchStatus(created, 'closed')).statusCode).toBe(200);

    const closed = await rollRow(created.rollId);
    expect(() => assertRollAcceptsUploads(closed)).toThrow(
      expect.objectContaining({ code: 'ROLL_CLOSED', statusCode: 409 }) as unknown as Error,
    );

    // Archived is not uploadable either — the gate is an allow-list, not a
    // "closed" special case.
    expect((await patchStatus(created, 'archived')).statusCode).toBe(200);
    const archived = await rollRow(created.rollId);
    expect(() => assertRollAcceptsUploads(archived)).toThrow(
      expect.objectContaining({ code: 'ROLL_CLOSED' }) as unknown as Error,
    );
  });

  it('reopening opens the upload gate again', async () => {
    const created = await createAsHost({ title: 'Reopened gate' });

    expect((await patchStatus(created, 'closed')).statusCode).toBe(200);
    expect((await patchStatus(created, 'live')).statusCode).toBe(200);

    const reopened = await rollRow(created.rollId);
    expect(() => assertRollAcceptsUploads(reopened)).not.toThrow();
  });

  it('keeps a closed roll readable for guests (03 §22)', async () => {
    const created = await createAsHost({ title: 'Closed but readable' });
    expect((await patchStatus(created, 'closed')).statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: `/api/rolls/${created.slug}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: 'Closed but readable', status: 'closed' });
  });
});

describe('PIN management via PATCH', () => {
  const cookieHeader = (name: string, value: string): Record<string, string> => ({
    cookie: `${name}=${value}`,
  });

  it('sets a PIN, locking the guest view, and invalidates it again on change', async () => {
    const created = await createAsHost({ title: 'PIN later' });
    const guest = `/api/rolls/${created.slug}`;

    // Unlisted to begin with: readable by anyone with the link.
    expect((await app.inject({ method: 'GET', url: guest })).statusCode).toBe(200);

    const set = await app.inject({
      method: 'PATCH',
      url: `/api/host/rolls/${created.rollId}`,
      headers: bearer(created.hostToken),
      payload: { pin: '4821' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ privacy: 'pin', hasPin: true });
    expect(await auditActions(created.rollId)).toContain('roll.pin-changed');
    // The PATCH response must not echo the PIN back in any form.
    expect(set.body).not.toContain('4821');

    const locked = await app.inject({ method: 'GET', url: guest });
    expect(locked.statusCode).toBe(401);
    expect(locked.json()).toMatchObject({ code: 'PIN_REQUIRED' });

    const unlock = await app.inject({
      method: 'POST',
      url: `/api/rolls/${created.slug}/pin`,
      payload: { pin: '4821' },
    });
    expect(unlock.statusCode).toBe(200);
    const cookie = unlock.cookies.find((c) => c.name === `kino_pin_${created.rollId}`);
    expect(cookie).toBeDefined();
    const asHeader = cookieHeader(cookie?.name ?? '', cookie?.value ?? '');

    expect((await app.inject({ method: 'GET', url: guest, headers: asHeader })).statusCode).toBe(
      200,
    );

    // Rotating the PIN must invalidate the session issued under the old one:
    // that is precisely what a host who rotates a leaked PIN is asking for.
    const rotate = await app.inject({
      method: 'PATCH',
      url: `/api/host/rolls/${created.rollId}`,
      headers: bearer(created.hostToken),
      payload: { pin: '9075' },
    });
    expect(rotate.statusCode).toBe(200);

    const stale = await app.inject({ method: 'GET', url: guest, headers: asHeader });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ code: 'PIN_REQUIRED' });
  });

  it('clears a PIN with an explicit null, returning the roll to unlisted', async () => {
    const created = await createAsHost({ title: 'PIN off', pin: '4821' });
    const guest = `/api/rolls/${created.slug}`;

    expect((await app.inject({ method: 'GET', url: guest })).statusCode).toBe(401);

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/host/rolls/${created.rollId}`,
      headers: bearer(created.hostToken),
      payload: { pin: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ privacy: 'unlisted', hasPin: false });
    expect(await auditActions(created.rollId)).toContain('roll.pin-cleared');

    expect((await rollRow(created.rollId)).pinHash).toBeNull();
    expect((await app.inject({ method: 'GET', url: guest })).statusCode).toBe(200);
  });

  it('refuses a PIN too short to be worth hashing', async () => {
    const created = await createAsHost({ title: 'Short PIN' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/host/rolls/${created.rollId}`,
      headers: bearer(created.hostToken),
      payload: { pin: '1' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_BODY' });
  });
});

describe('POST /api/host/rolls/:rollId/regenerate-slug', () => {
  it('mints a new slug and kills the old one', async () => {
    const created = await createAsHost({ title: 'Rotate the link' });

    expect((await app.inject({ method: 'GET', url: `/api/rolls/${created.slug}` })).statusCode).toBe(
      200,
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/host/rolls/${created.rollId}/regenerate-slug`,
      headers: bearer(created.hostToken),
    });

    expect(res.statusCode).toBe(200);
    const { slug, guestUrl } = res.json<{ slug: string; guestUrl: string }>();
    expect(slug).toMatch(SLUG_PATTERN);
    expect(slug).not.toBe(created.slug);
    expect(guestUrl).toBe(`${config.PUBLIC_BASE_URL}/r/${slug}`);

    // The whole point: the leaked link stops working.
    const old = await app.inject({ method: 'GET', url: `/api/rolls/${created.slug}` });
    expect(old.statusCode).toBe(404);
    expect(old.json()).toMatchObject({ code: 'ROLL_NOT_FOUND' });

    expect((await app.inject({ method: 'GET', url: `/api/rolls/${slug}` })).statusCode).toBe(200);

    // The old slug is destroyed by the update, so the audit row is where it survives.
    const [event] = await app.db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.rollId, created.rollId),
          eq(schema.auditEvents.action, 'roll.slug-regenerated'),
        ),
      );
    expect(event?.actor).toBe('host');
    expect(event?.target).toBe(created.slug);
  });

  it('refuses another roll’s host token', async () => {
    const mine = await createAsHost({ title: 'Mine' });
    const other = await createAsHost({ title: 'Other' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/host/rolls/${mine.rollId}/regenerate-slug`,
      headers: bearer(other.hostToken),
    });

    expect(res.statusCode).toBe(403);
    expect((await rollRow(mine.rollId)).slug).toBe(mine.slug);
  });
});

describe('GET /api/rolls/:slug (guest, 03 §9)', () => {
  it('reads with no authentication at all', async () => {
    const created = await createAsHost({ title: 'Anyone with the link' });

    const res = await app.inject({ method: 'GET', url: `/api/rolls/${created.slug}` });

    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      title: 'Anyone with the link',
      status: 'live',
      // Captures arrive in Task 18; until then the count is honestly zero.
      photoCount: 0,
    });
    expect(typeof body['createdAt']).toBe('string');
  });

  it('tells a guest nothing beyond the documented fields', async () => {
    const created = await createAsHost({ title: 'Minimal', pin: '4821' });

    const unlock = await app.inject({
      method: 'POST',
      url: `/api/rolls/${created.slug}/pin`,
      payload: { pin: '4821' },
    });
    const cookie = unlock.cookies.find((c) => c.name === `kino_pin_${created.rollId}`);

    const res = await app.inject({
      method: 'GET',
      url: `/api/rolls/${created.slug}`,
      headers: { cookie: `${cookie?.name}=${cookie?.value}` },
    });

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json<Record<string, unknown>>()).sort()).toEqual([
      'closedAt',
      'createdAt',
      // Task 20: the PWA needs it to decide whether to draw the download control.
      'downloadsEnabled',
      'photoCount',
      // Task 29: same principle for an optional anonymous reaction control.
      'reactionsEnabled',
      'status',
      'title',
    ]);
    // No internal id, no host token hash, no PIN hash, no slug-adjacent secrets.
    expect(res.body).not.toContain(created.rollId);
    expect(res.body).not.toContain('scrypt$');
  });

  it('answers 404 for an unknown slug', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/rolls/ZZZZZZ' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'ROLL_NOT_FOUND' });
  });
});

/**
 * A slug is stored upper case because the alphabet is upper case, but a guest
 * types what is on the screen — and phone keyboards, autocorrect and
 * copy-paste-with-whitespace all produce something else. Every site that
 * resolves a slug must agree, or a guest ends up on a roll that is readable but
 * not unlockable.
 */
describe('slug normalization at every resolution site', () => {
  it('resolves a lowercase slug on the guest read', async () => {
    const created = await createAsHost({ title: 'Lowercase link' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/rolls/${created.slug.toLowerCase()}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: 'Lowercase link' });
  });

  /**
   * The half that must not be forgotten. A guest who reaches the roll in
   * lowercase then hits the PIN gate has to be able to unlock it at that same
   * casing — otherwise the PIN prompt is a dead end with no error explaining it.
   */
  it('resolves a lowercase slug on the PIN exchange, and the cookie then works', async () => {
    const created = await createAsHost({ title: 'Lowercase PIN', pin: '4821' });
    const lower = created.slug.toLowerCase();

    const locked = await app.inject({ method: 'GET', url: `/api/rolls/${lower}` });
    expect(locked.statusCode).toBe(401);
    expect(locked.json()).toMatchObject({ code: 'PIN_REQUIRED' });

    const unlock = await app.inject({
      method: 'POST',
      url: `/api/rolls/${lower}/pin`,
      payload: { pin: '4821' },
    });
    expect(unlock.statusCode).toBe(200);

    // The cookie is keyed on the roll id, not the slug, so it must open the
    // roll at either casing.
    const cookie = unlock.cookies.find((c) => c.name === `kino_pin_${created.rollId}`);
    expect(cookie).toBeDefined();
    const asHeader = { cookie: `${cookie?.name}=${cookie?.value}` };

    for (const slug of [lower, created.slug]) {
      const read = await app.inject({
        method: 'GET',
        url: `/api/rolls/${slug}`,
        headers: asHeader,
      });
      expect(read.statusCode).toBe(200);
    }
  });

  it('resolves a lowercase and whitespace-padded slug on device join', async () => {
    const created = await createAsDevice({ title: 'Lowercase join' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/device/rolls/join',
      headers: bearer(deviceB.deviceToken),
      payload: { slug: `  ${created.slug.toLowerCase()}  ` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rollId: created.rollId });
  });

  it('still rejects a slug that is not in the alphabet at all', async () => {
    // Normalising must not become "accept anything": `0`, `O`, `1`, `I` and `L`
    // are excluded from the alphabet and uppercasing does not rescue them.
    const res = await app.inject({
      method: 'POST',
      url: '/api/device/rolls/join',
      headers: bearer(deviceB.deviceToken),
      payload: { slug: 'oi01lz' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_BODY' });
  });
});

describe('X-Robots-Tag on the guest URL space (03 §9)', () => {
  const robots = 'noindex, nofollow';

  it('is set on every /api/rolls/* response, whatever the outcome', async () => {
    const created = await createAsHost({ title: 'Robots', pin: '4821' });

    const responses = [
      // 401 — PIN gate, before any cookie exists.
      await app.inject({ method: 'GET', url: `/api/rolls/${created.slug}` }),
      // 404 — unknown slug.
      await app.inject({ method: 'GET', url: '/api/rolls/ZZZZZZ' }),
      // 401 — wrong PIN on the Task 16 exchange route.
      await app.inject({
        method: 'POST',
        url: `/api/rolls/${created.slug}/pin`,
        payload: { pin: '0000' },
      }),
      // 200 — the successful PIN exchange, which is also under /api/rolls/.
      await app.inject({
        method: 'POST',
        url: `/api/rolls/${created.slug}/pin`,
        payload: { pin: '4821' },
      }),
    ];

    for (const res of responses) {
      expect(res.headers['x-robots-tag']).toBe(robots);
    }
  });

  it('is set on a successful guest read', async () => {
    const created = await createAsHost({ title: 'Indexable? No.' });
    const res = await app.inject({ method: 'GET', url: `/api/rolls/${created.slug}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-robots-tag']).toBe(robots);
  });

  it('does not leak onto the host or device URL spaces', async () => {
    const created = await createAsHost({ title: 'Host space' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${created.rollId}`,
      headers: bearer(created.hostToken),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-robots-tag']).toBeUndefined();
  });
});
