import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import { firmwareManifest } from '@kino/schemas';
import { loadConfig } from '../src/config';
import * as schema from '../src/db/schema';

/**
 * Throwaway-database strategy.
 *
 * Every run DROPs and re-CREATEs a dedicated `kino_test` database, then applies
 * the committed migrations to it from scratch. That is deliberate:
 *
 * - it proves the migration applies to a *clean* database, which is the thing
 *   under test — running against the dev `kino` database would instead prove
 *   only that some earlier run already migrated it;
 * - it makes the suite repeatable. State left behind by a previous run cannot
 *   leak in, because the previous database no longer exists.
 *
 * The dev `kino` database is never touched: it is only used as the connection
 * template (host/credentials) and as the maintenance connection target, which
 * is `postgres`, not `kino`.
 */
const TEST_DATABASE = 'kino_test';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

function databaseUrl(name: string): string {
  const url = new URL(loadConfig().DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

/** `postgres` is the maintenance database; CREATE/DROP DATABASE needs one. */
const adminUrl = databaseUrl('postgres');
const testUrl = databaseUrl(TEST_DATABASE);

/**
 * Drops `kino_test`, and re-creates it when asked. Both ends of the suite drop,
 * so neither an aborted run nor a leftover database can wedge the next one.
 *
 * `WITH (FORCE)` (PostgreSQL 13+) terminates any leftover connection instead of
 * failing on it. Simple protocol: CREATE/DROP DATABASE cannot run as an
 * extended-protocol statement.
 */
async function resetTestDatabase(mode: 'drop' | 'recreate'): Promise<void> {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists "${TEST_DATABASE}" with (force)`).simple();
    if (mode === 'recreate') {
      await admin.unsafe(`create database "${TEST_DATABASE}"`).simple();
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

let client: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

/** Minimal FK parents, seeded once: a capture needs a roll and a device. */
const DEVICE_ID = 'dev_fixture';
const ROLL_ID = 'roll_fixture';

beforeAll(async () => {
  await resetTestDatabase('recreate');
  client = postgres(testUrl, { max: 1, onnotice: () => {} });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });

  await db
    .insert(schema.devices)
    .values({
      id: DEVICE_ID,
      serial: 'KD4-00001',
      product: 'KINO D4',
      hardwareRevision: 'v1',
      tokenHash: 'a'.repeat(64),
    })
    .execute();

  await db
    .insert(schema.rolls)
    .values({
      id: ROLL_ID,
      slug: '7F3K9Q',
      title: 'Fixture roll',
      hostTokenHash: 'b'.repeat(64),
      createdByDeviceId: DEVICE_ID,
    })
    .execute();
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await resetTestDatabase('drop');
}, 60_000);

/**
 * drizzle wraps every driver failure in a `DrizzleQueryError`; the PostgreSQL
 * error — SQLSTATE and the name of the index that rejected the row — is its
 * `cause`. Asserting on the index name (not just on 23505) is the point: it
 * proves *which* uniqueness rule fired, so a row rejected by some unrelated
 * constraint cannot pass for the idempotency anchor.
 */
async function expectUniqueViolation(query: Promise<unknown>, index: string): Promise<void> {
  await expect(query).rejects.toMatchObject({
    cause: { code: '23505', constraint_name: index },
  });
}

describe('migration 0001', () => {
  it('applies to a clean database and creates every table', async () => {
    const rows = await client<{ table_name: string }[]>`
      select table_name
        from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
       order by table_name
    `;

    expect(rows.map((row) => row.table_name)).toEqual([
      'assets',
      'audit_events',
      'captures',
      'devices',
      'firmware_releases',
      'processing_events',
      'reactions',
      'rolls',
      'upload_parts',
      'upload_sessions',
    ]);
  });

  it('creates the idempotency indexes by their contract names', async () => {
    const rows = await client<{ indexname: string }[]>`
      select indexname
        from pg_indexes
       where schemaname = 'public'
         and indexname in ('captures_roll_uuid', 'assets_capture_role_frame')
       order by indexname
    `;

    expect(rows.map((row) => row.indexname)).toEqual([
      'assets_capture_role_frame',
      'captures_roll_uuid',
    ]);
  });
});

describe('idempotency anchors (05§9)', () => {
  it('rejects a second capture with the same (rollId, captureUuid)', async () => {
    const row = {
      id: 'cap_first',
      captureUuid: '11111111-1111-4111-8111-111111111111',
      rollId: ROLL_ID,
      deviceId: DEVICE_ID,
      mode: 'wiggle',
      capturedAt: new Date('2026-08-14T23:42:18Z'),
      frameCount: 4,
      resolution: '1600x1200',
    };

    await db.insert(schema.captures).values(row).execute();

    // Same device retrying the same shutter press: a different row id, but the
    // device-generated UUID is what identifies the capture.
    await expectUniqueViolation(
      db
        .insert(schema.captures)
        .values({ ...row, id: 'cap_retry' })
        .execute(),
      'captures_roll_uuid',
    );
  });

  it('rejects a second asset with the same (captureId, role, frameIndex)', async () => {
    const captureId = 'cap_assets';

    await db
      .insert(schema.captures)
      .values({
        id: captureId,
        captureUuid: '22222222-2222-4222-8222-222222222222',
        rollId: ROLL_ID,
        deviceId: DEVICE_ID,
        mode: 'quad',
        capturedAt: new Date('2026-08-14T23:42:19Z'),
        frameCount: 4,
        resolution: '1600x1200',
      })
      .execute();

    const row = {
      id: 'asset_first',
      captureId,
      role: 'original-frame',
      frameIndex: 0,
      mime: 'image/jpeg',
      objectKey: `rolls/${ROLL_ID}/captures/${captureId}/original/cam-01.jpg`,
    };

    await db.insert(schema.assets).values(row).execute();

    // A *different* object key, so the failure can only come from the
    // (captureId, role, frameIndex) index and not from objectKey's uniqueness.
    await expectUniqueViolation(
      db
        .insert(schema.assets)
        .values({
          ...row,
          id: 'asset_retry',
          objectKey: `rolls/${ROLL_ID}/captures/${captureId}/original/cam-01-retry.jpg`,
        })
        .execute(),
      'assets_capture_role_frame',
    );
  });
});

/**
 * The jsonb columns are typed with the `kino.*` document shapes via drizzle's
 * `$type<...>()`, so a wrong shape is a compile error rather than a surprise at
 * runtime. These two round-trips keep that honest in both directions: the
 * fixtures below would not type-check against a mistyped column, and reading
 * them back proves the driver stores and returns the document unchanged.
 */
describe('jsonb document shapes (05§19)', () => {
  it('round-trips a capture timing block', async () => {
    const captureId = 'cap_timing';

    // All three skews present, one measured as null with a reason — the locked
    // 04§13 rule. An omitted key would not be an allowed substitute.
    const timing = {
      gpioTriggerSkewUs: 41.5,
      vsyncPhaseSkewUs: 1_190,
      effectiveExposureSkewUs: null,
      unavailableReason: 'sensor does not report exposure start',
    };

    await db
      .insert(schema.captures)
      .values({
        id: captureId,
        captureUuid: '33333333-3333-4333-8333-333333333333',
        rollId: ROLL_ID,
        deviceId: DEVICE_ID,
        mode: 'wiggle',
        capturedAt: new Date('2026-08-14T23:42:20Z'),
        frameCount: 4,
        resolution: '1600x1200',
        timing,
      })
      .execute();

    const [stored] = await db
      .select({ timing: schema.captures.timing })
      .from(schema.captures)
      .where(eq(schema.captures.id, captureId));

    expect(stored?.timing).toEqual(timing);
  });

  it('round-trips a firmware manifest', async () => {
    // Parsed through the registry, so the row can only hold a document that is
    // actually a valid `kino.firmware-manifest`.
    const manifest = firmwareManifest.shape.parse({
      schema: 'kino.firmware-manifest',
      version: 1,
      release: '1.4.0',
      channel: 'stable',
      protocolMin: 1,
      protocolMax: 2,
      compatibleHardware: ['KINO-D4-v1'],
      targets: { main: { file: 'main.bin', sha256: 'c'.repeat(64) } },
    });

    await db
      .insert(schema.firmwareReleases)
      .values({
        id: 'fw_fixture',
        release: manifest.release,
        channel: 'stable',
        compatibleHardware: manifest.compatibleHardware,
        protocolMin: manifest.protocolMin,
        protocolMax: manifest.protocolMax,
        manifest,
      })
      .execute();

    const [stored] = await db
      .select({
        compatibleHardware: schema.firmwareReleases.compatibleHardware,
        manifest: schema.firmwareReleases.manifest,
      })
      .from(schema.firmwareReleases)
      .where(eq(schema.firmwareReleases.id, 'fw_fixture'));

    expect(stored?.compatibleHardware).toEqual(['KINO-D4-v1']);
    expect(stored?.manifest).toEqual(manifest);
  });
});
