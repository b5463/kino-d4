import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { FastifyInstance } from 'fastify';
import { ASSET_ROLES } from '@kino/schemas';
import { buildServer } from '../src/server';
import { loadConfig, type ApiConfig } from '../src/config';
import { newId } from '../src/ids';
import { derivedKey, originalKey } from '../src/uploads/objectKeys';
import { FEED_LIMIT_DEFAULT, FEED_LIMIT_MAX } from '../src/captures/feed';
import {
  ASSET_CACHE_CONTROL,
  ASSET_CACHE_MAX_AGE_SECONDS,
  ASSET_URL_TTL_SECONDS,
  guestMaySeeRole,
} from '../src/captures/delivery';
import * as schema from '../src/db/schema';

/**
 * The guest feed and authorized asset delivery (Task 20), against the real
 * database and real MinIO — same house rules as every other suite here:
 *
 *   docker compose -f infra/docker-compose.dev.yml up -d
 *   npm run db:migrate -w @kino/api
 *
 * Captures and assets are inserted **directly**, not driven through the upload
 * pipeline. 120 captures through init/part/complete would be a few thousand S3
 * round trips to test something that has nothing to do with uploading; what the
 * feed actually reads is rows, so rows are what the fixtures build.
 */
const RUN = randomBytes(4).toString('hex');

const config: ApiConfig = loadConfig();
const app: FastifyInstance = buildServer(config);
const proxyApp: FastifyInstance = buildServer({ ...config, OBJECT_DELIVERY: 'proxy' });

const REQUIRED_TABLES = ['captures', 'assets', 'rolls'];

const SERIAL = `KD4-T20-${RUN}`;

const createdRollIds: string[] = [];
/** Object keys this suite actually put bytes at, for teardown. */
const storedKeys: string[] = [];

let device: { deviceId: string; deviceToken: string };

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

interface CreatedRollResponse {
  rollId: string;
  slug: string;
  guestUrl: string;
  hostUrl: string;
  hostToken: string;
}

async function createRoll(body: Record<string, unknown> = {}): Promise<CreatedRollResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/host/rolls',
    payload: { title: `Feed roll ${RUN}`, ...body },
  });
  expect(res.statusCode).toBe(201);
  const created = res.json<CreatedRollResponse>();
  createdRollIds.push(created.rollId);
  return created;
}

interface CaptureFixture {
  id: string;
  createdAt?: Date;
  visible?: boolean;
  deletedAt?: Date | null;
}

/** Inserts capture rows straight into the table, in one statement. */
async function insertCaptures(rollId: string, fixtures: readonly CaptureFixture[]): Promise<void> {
  if (fixtures.length === 0) return;
  await app.db.insert(schema.captures).values(
    fixtures.map((fixture) => ({
      id: fixture.id,
      captureUuid: randomUUID(),
      rollId,
      deviceId: device.deviceId,
      mode: 'wiggle',
      capturedAt: fixture.createdAt ?? new Date(),
      frameCount: 4,
      resolution: '1600x1200',
      status: 'ready',
      visible: fixture.visible ?? true,
      deletedAt: fixture.deletedAt ?? null,
      ...(fixture.createdAt === undefined ? {} : { createdAt: fixture.createdAt }),
    })),
  );
}

interface AssetFixture {
  role: string;
  frameIndex?: number;
  status?: string;
  mime?: string;
  width?: number | null;
  height?: number | null;
}

/** Inserts asset rows for a capture and returns `{role: assetId}`. */
async function insertAssets(
  rollId: string,
  captureId: string,
  fixtures: readonly AssetFixture[],
): Promise<Record<string, string>> {
  const rows = fixtures.map((fixture) => {
    const mime = fixture.mime ?? 'image/webp';
    const frameIndex = fixture.frameIndex ?? null;
    const objectKey =
      frameIndex === null
        ? derivedKey(rollId, captureId, `${fixture.role}.${mime.split('/')[1] ?? 'bin'}`)
        : originalKey(rollId, captureId, frameIndex);
    return {
      id: newId('asset'),
      captureId,
      role: fixture.role,
      frameIndex,
      mime,
      width: fixture.width === undefined ? 480 : fixture.width,
      height: fixture.height === undefined ? 360 : fixture.height,
      bytes: 1024,
      sha256: null,
      objectKey,
      status: fixture.status ?? 'ready',
    };
  });

  await app.db.insert(schema.assets).values(rows);

  const byRole: Record<string, string> = {};
  for (const row of rows) byRole[row.role] = row.id;
  return byRole;
}

/** Puts real bytes at an asset's key so a presigned GET can be followed. */
async function storeBytes(assetId: string, body: Buffer): Promise<void> {
  const [row] = await app.db
    .select({ objectKey: schema.assets.objectKey, mime: schema.assets.mime })
    .from(schema.assets)
    .where(eq(schema.assets.id, assetId));
  if (row === undefined) throw new Error(`asset ${assetId} vanished`);

  await app.s3.send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: row.objectKey,
      Body: body,
      ContentType: row.mime,
    }),
  );
  storedKeys.push(row.objectKey);
}

interface AssetSummary {
  role: string;
  assetId: string;
  frameIndex: number | null;
  width: number | null;
  height: number | null;
}

interface CaptureView {
  captureId: string;
  mode: string;
  capturedAt: string;
  createdAt: string;
  assets: AssetSummary[];
}

interface FeedPage {
  items: CaptureView[];
  nextCursor: string | null;
  hasMore: boolean;
}

async function feed(
  slug: string,
  query: string = '',
  headers: Record<string, string> = {},
): Promise<FeedPage> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/rolls/${slug}/captures${query}`,
    headers,
  });
  expect(res.statusCode).toBe(200);
  return res.json<FeedPage>();
}

/** Walks every page of a roll's feed and returns the capture ids in order. */
async function walk(slug: string, limit: number): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;

  for (;;) {
    const query = `?limit=${limit}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const page: FeedPage = await feed(slug, query);
    pages += 1;
    ids.push(...page.items.map((item) => item.captureId));

    if (!page.hasMore) {
      expect(page.nextCursor).toBeNull();
      break;
    }
    expect(page.nextCursor).not.toBeNull();
    cursor = page.nextCursor;
    // A cursor that never advances would loop here forever.
    expect(pages).toBeLessThan(50);
  }

  return { ids, pages };
}

let migrated = false;

async function assertMigrated(): Promise<void> {
  const rows = await app.db.execute<{ table_name: string }>(sql`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('captures', 'assets', 'rolls')
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
  await proxyApp.ready();
  await assertMigrated();

  const res = await app.inject({
    method: 'POST',
    url: '/api/studio/devices/register',
    headers: { authorization: `Bearer ${app.config.PROVISIONING_TOKEN}` },
    payload: { serial: SERIAL, product: 'KINO D4', hardwareRevision: 'v1' },
  });
  expect(res.statusCode).toBe(200);
  device = res.json<{ deviceId: string; deviceToken: string }>();
}, 60_000);

afterAll(async () => {
  if (migrated && createdRollIds.length > 0) {
    const captureRows = await app.db
      .select({ id: schema.captures.id })
      .from(schema.captures)
      .where(inArray(schema.captures.rollId, createdRollIds));
    const captureIds = captureRows.map((row) => row.id);

    await Promise.all(
      storedKeys.map(async (Key) => {
        try {
          await app.s3.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key }));
        } catch {
          /* a leftover test object costs a few KB; a failed teardown costs the suite */
        }
      }),
    );

    if (captureIds.length > 0) {
      await app.db.delete(schema.reactions).where(inArray(schema.reactions.captureId, captureIds));
      await app.db.delete(schema.assets).where(inArray(schema.assets.captureId, captureIds));
      await app.db.delete(schema.captures).where(inArray(schema.captures.id, captureIds));
    }
    await app.db.delete(schema.auditEvents).where(inArray(schema.auditEvents.rollId, createdRollIds));
    await app.db.delete(schema.rollDevices).where(inArray(schema.rollDevices.rollId, createdRollIds));
    await app.db.delete(schema.rolls).where(inArray(schema.rolls.id, createdRollIds));
  }
  if (migrated) {
    await app.db.delete(schema.devices).where(eq(schema.devices.serial, SERIAL));
  }
  await proxyApp.close();
  await app.close();
}, 60_000);

/* ------------------------------------------------------------ pagination -- */

describe('GET /api/rolls/:slug/captures — keyset pagination (06 §11)', () => {
  /**
   * 120 captures in 12 groups of 10 that share a `createdAt` to the millisecond.
   * A page boundary at 50 lands *inside* group 5, so a paginator that keys on
   * the timestamp alone either repeats or skips the rest of that group — which
   * is exactly the bug the id tiebreaker exists to prevent.
   */
  const TOTAL = 120;
  const GROUP = 10;

  let roll: CreatedRollResponse;
  let expected: string[];

  beforeAll(async () => {
    roll = await createRoll({ title: `Paginated ${RUN}` });

    const base = Date.UTC(2026, 7, 14, 20, 0, 0);
    const fixtures: CaptureFixture[] = Array.from({ length: TOTAL }, (_unused, i) => ({
      id: newId('cap'),
      createdAt: new Date(base + Math.floor(i / GROUP) * 1_000),
    }));
    await insertCaptures(roll.rollId, fixtures);

    // Newest first, id descending inside a tie — the order the route promises.
    expected = [...fixtures]
      .sort((a, b) => {
        const byTime = (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
        return byTime !== 0 ? byTime : (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
      })
      .map((fixture) => fixture.id);
  }, 60_000);

  it('walks 120 captures in 3 pages with no overlap and no gaps', async () => {
    const { ids, pages } = await walk(roll.slug, 50);

    expect(pages).toBe(3);
    expect(ids).toHaveLength(TOTAL);
    expect(new Set(ids).size).toBe(TOTAL);
    expect(ids).toEqual(expected);
  });

  it('walks the same set at a page size that never aligns with the ties', async () => {
    // 7 divides neither 120 nor the 10-row tie groups, so every page boundary
    // lands mid-group.
    const { ids } = await walk(roll.slug, 7);

    expect(new Set(ids).size).toBe(TOTAL);
    expect(ids).toEqual(expected);
  });

  it('returns newest first', async () => {
    const page = await feed(roll.slug, '?limit=3');
    const times = page.items.map((item) => Date.parse(item.createdAt));

    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(page.items[0]?.captureId).toBe(expected[0]);
  });

  it('defaults to 50 and clamps the limit to 1..100', async () => {
    expect((await feed(roll.slug)).items).toHaveLength(FEED_LIMIT_DEFAULT);
    expect((await feed(roll.slug, '?limit=0')).items).toHaveLength(1);
    expect((await feed(roll.slug, '?limit=-9')).items).toHaveLength(1);
    expect((await feed(roll.slug, '?limit=100000')).items).toHaveLength(FEED_LIMIT_MAX);
  });

  it('rejects a limit that is not a number rather than guessing one', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/rolls/${roll.slug}/captures?limit=fifty`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_LIMIT' });
  });

  it('answers 400, not 500, for a tampered cursor', async () => {
    const good = (await feed(roll.slug, '?limit=5')).nextCursor;
    expect(good).not.toBeNull();

    const tampered = [
      'not-base64-at-all!!',
      Buffer.from('garbage').toString('base64url'),
      Buffer.from("2026-08-14T20:00:00Z|cap_x'; drop table captures; --").toString('base64url'),
      Buffer.from('|').toString('base64url'),
      // A real cursor with one character changed inside its payload.
      Buffer.from(
        Buffer.from(good ?? '', 'base64url').toString('utf8').replace(/\d\|/, 'X|'),
      ).toString('base64url'),
      '',
    ];

    for (const cursor of tampered) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/rolls/${roll.slug}/captures?cursor=${encodeURIComponent(cursor)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'INVALID_CURSOR' });
    }
  });

  /**
   * PostgreSQL keeps microseconds; a JavaScript `Date` keeps milliseconds. A
   * cursor built from the truncated value skips every row that shares the
   * millisecond but not the microsecond — invisible at ms-spaced fixtures and
   * silently lossy on rows the server timestamps itself.
   */
  it('does not lose rows whose createdAt differs below the millisecond', async () => {
    const dense = await createRoll({ title: `Dense ${RUN}` });
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const id = newId('cap');
      ids.push(id);
      // One statement each, so each row gets its own clock reading.
      await insertCaptures(dense.rollId, [{ id }]);
    }

    const walked = await walk(dense.slug, 2);
    expect(new Set(walked.ids).size).toBe(ids.length);
    expect([...walked.ids].sort()).toEqual([...ids].sort());
  });
});

/* ------------------------------------------------------- what a guest sees -- */

describe('GET /api/rolls/:slug/captures — visibility (03 §11)', () => {
  it('omits hidden and deleted captures while the host still counts the hidden ones', async () => {
    const roll = await createRoll({ title: `Moderated ${RUN}` });
    const shown = newId('cap');
    const hidden = newId('cap');
    const deleted = newId('cap');

    await insertCaptures(roll.rollId, [
      { id: shown },
      { id: hidden, visible: false },
      { id: deleted, deletedAt: new Date() },
    ]);

    const page = await feed(roll.slug);
    const ids = page.items.map((item) => item.captureId);
    expect(ids).toEqual([shown]);

    // Hide is not delete: the host's dashboard still knows the photo exists.
    const host = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${roll.rollId}`,
      headers: bearer(roll.hostToken),
    });
    expect(host.statusCode).toBe(200);
    expect(host.json()).toMatchObject({ counts: { captures: 2, hidden: 1 } });
  });

  it('summarises only READY assets, and never the object key', async () => {
    const roll = await createRoll({ title: `Assets ${RUN}` });
    const captureId = newId('cap');
    await insertCaptures(roll.rollId, [{ id: captureId }]);
    const ids = await insertAssets(roll.rollId, captureId, [
      { role: 'thumb', width: 480, height: 360 },
      { role: 'wiggle-webp', status: 'pending' },
      { role: 'metadata', mime: 'application/json', width: null, height: null },
    ]);

    const res = await app.inject({ method: 'GET', url: `/api/rolls/${roll.slug}/captures` });
    expect(res.statusCode).toBe(200);

    const [item] = res.json<FeedPage>().items;
    const roles = (item?.assets ?? []).map((asset) => asset.role);
    expect(roles).toContain('thumb');
    expect(roles).not.toContain('wiggle-webp');

    const thumb = item?.assets.find((asset) => asset.role === 'thumb');
    expect(thumb).toEqual({
      role: 'thumb',
      assetId: ids['thumb'],
      frameIndex: null,
      width: 480,
      height: 360,
    });

    // 05 §6: an object key is a location, never a handle a guest is given.
    expect(res.body).not.toContain('rolls/');
    expect(res.body).not.toContain('objectKey');
    expect(res.body).not.toContain('.webp');
  });

  it('is empty, not an error, for a roll with nothing in it', async () => {
    const roll = await createRoll({ title: `Empty ${RUN}` });
    const page = await feed(roll.slug);

    expect(page).toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it('carries X-Robots-Tag like the rest of the guest URL space', async () => {
    const roll = await createRoll({ title: `Robots ${RUN}` });
    const res = await app.inject({ method: 'GET', url: `/api/rolls/${roll.slug}/captures` });

    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });
});

describe('GET /api/rolls/:slug/captures/:captureId', () => {
  it('returns the capture with all of its ready assets', async () => {
    const roll = await createRoll({ title: `Detail ${RUN}` });
    const captureId = newId('cap');
    await insertCaptures(roll.rollId, [{ id: captureId }]);
    await insertAssets(roll.rollId, captureId, [
      { role: 'thumb' },
      { role: 'kino-still', mime: 'image/jpeg' },
      { role: 'original-frame', frameIndex: 1, mime: 'image/jpeg' },
      { role: 'wiggle-mp4', mime: 'video/mp4', status: 'pending' },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/api/rolls/${roll.slug}/captures/${captureId}`,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      captureId: string;
      reactionCount: number;
      reacted: boolean;
      assets: { role: string; frameIndex: number | null }[];
    }>();
    expect(body.captureId).toBe(captureId);
    expect(body.reactionCount).toBe(0);
    expect(body.reacted).toBe(false);
    expect(body.assets.map((asset) => asset.role).sort()).toEqual([
      'kino-still',
      'original-frame',
      'thumb',
    ]);
    expect(res.body).not.toContain('rolls/');
    expect(body.assets.find((asset) => asset.role === 'original-frame')?.frameIndex).toBe(1);
  });

  it('404s a hidden, a deleted and a foreign roll’s capture alike', async () => {
    const roll = await createRoll({ title: `Detail gates ${RUN}` });
    const other = await createRoll({ title: `Somebody else ${RUN}` });

    const hidden = newId('cap');
    const deleted = newId('cap');
    const foreign = newId('cap');
    await insertCaptures(roll.rollId, [
      { id: hidden, visible: false },
      { id: deleted, deletedAt: new Date() },
    ]);
    await insertCaptures(other.rollId, [{ id: foreign }]);

    for (const captureId of [hidden, deleted, foreign, 'cap_does_not_exist']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/rolls/${roll.slug}/captures/${captureId}`,
      });
      // Identical answers: a different status for the foreign id would turn this
      // route into an oracle for captures in rolls the caller cannot read.
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'CAPTURE_NOT_FOUND' });
    }
  });
});

/** The `kino_guest` cookies on a response — the anonymous identity, nothing else. */
const guestCookies = (response: { cookies: { name: string }[] }): { name: string }[] =>
  response.cookies.filter((cookie) => cookie.name === 'kino_guest');

describe('POST /api/rolls/:slug/captures/:captureId/react', () => {
  it('creates an anonymous session, exposes its state, and toggles the heart off again', async () => {
    const roll = await createRoll({ title: `Reactions ${RUN}`, reactionsEnabled: true });
    const captureId = newId('cap');
    await insertCaptures(roll.rollId, [{ id: captureId }]);

    const first = await app.inject({
      method: 'POST',
      url: `/api/rolls/${roll.slug}/captures/${captureId}/react`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ reactionCount: 1, reacted: true });
    const cookie = first.cookies.find((candidate) => candidate.name === 'kino_guest');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/api/rolls/' });
    const headers = { cookie: `${cookie?.name ?? ''}=${cookie?.value ?? ''}` };

    const detail = await app.inject({
      method: 'GET',
      url: `/api/rolls/${roll.slug}/captures/${captureId}`,
      headers,
    });
    expect(detail.json()).toMatchObject({ reactionCount: 1, reacted: true });

    const second = await app.inject({
      method: 'POST',
      url: `/api/rolls/${roll.slug}/captures/${captureId}/react`,
      headers,
    });
    expect(second.json()).toEqual({ reactionCount: 0, reacted: false });
  });

  it('enforces the Roll switch and capture visibility without creating a reaction', async () => {
    const disabled = await createRoll({ title: `No reactions ${RUN}`, reactionsEnabled: false });
    const captureId = newId('cap');
    await insertCaptures(disabled.rollId, [{ id: captureId }]);

    const disabledResponse = await app.inject({
      method: 'POST',
      url: `/api/rolls/${disabled.slug}/captures/${captureId}/react`,
    });
    expect(disabledResponse.statusCode).toBe(409);
    expect(disabledResponse.json()).toMatchObject({ code: 'REACTIONS_DISABLED' });
    // No anonymous identity was minted. Named specifically rather than asserting
    // "no cookies at all": every guest roll read also carries the roll access
    // stamp, which is issued by the slug gate and says nothing about a guest.
    expect(guestCookies(disabledResponse)).toHaveLength(0);

    const enabled = await createRoll({ title: `Hidden reaction ${RUN}`, reactionsEnabled: true });
    const hidden = newId('cap');
    await insertCaptures(enabled.rollId, [{ id: hidden, visible: false }]);
    const hiddenResponse = await app.inject({
      method: 'POST',
      url: `/api/rolls/${enabled.slug}/captures/${hidden}/react`,
    });
    expect(hiddenResponse.statusCode).toBe(404);
    expect(hiddenResponse.json()).toMatchObject({ code: 'CAPTURE_NOT_FOUND' });
    expect(guestCookies(hiddenResponse)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------ the PIN gate -- */

describe('the PIN gate covers the feed, the detail and the asset (03 §9)', () => {
  it('401s all three routes without the cookie, and opens all three with it', async () => {
    const roll = await createRoll({ title: `Locked ${RUN}`, pin: '4821' });
    const captureId = newId('cap');
    await insertCaptures(roll.rollId, [{ id: captureId }]);
    const ids = await insertAssets(roll.rollId, captureId, [{ role: 'thumb' }]);

    const urls = [
      `/api/rolls/${roll.slug}/captures`,
      `/api/rolls/${roll.slug}/captures/${captureId}`,
      `/api/assets/${ids['thumb'] ?? ''}/content`,
    ];

    for (const url of urls) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'PIN_REQUIRED' });
    }

    const unlock = await app.inject({
      method: 'POST',
      url: `/api/rolls/${roll.slug}/pin`,
      payload: { pin: '4821' },
    });
    expect(unlock.statusCode).toBe(200);
    const cookie = unlock.cookies.find((c) => c.name === `kino_pin_${roll.rollId}`);
    const headers = { cookie: `${cookie?.name ?? ''}=${cookie?.value ?? ''}` };

    for (const url of urls) {
      const res = await app.inject({ method: 'GET', url, headers });
      // The asset route redirects; the two JSON routes answer 200.
      expect([200, 302]).toContain(res.statusCode);
    }
  });

  /**
   * The asset route lives outside `/api/rolls/:slug`, so it cannot reuse
   * `guestRollAccess` — it has to reach the same verdict from the asset id. A
   * cookie minted for one roll must not open another's asset.
   */
  it('does not accept another roll’s PIN cookie', async () => {
    const locked = await createRoll({ title: `Locked A ${RUN}`, pin: '4821' });
    const decoy = await createRoll({ title: `Locked B ${RUN}`, pin: '4821' });

    const captureId = newId('cap');
    await insertCaptures(locked.rollId, [{ id: captureId }]);
    const ids = await insertAssets(locked.rollId, captureId, [{ role: 'thumb' }]);

    const unlock = await app.inject({
      method: 'POST',
      url: `/api/rolls/${decoy.slug}/pin`,
      payload: { pin: '4821' },
    });
    const cookie = unlock.cookies.find((c) => c.name === `kino_pin_${decoy.rollId}`);

    const res = await app.inject({
      method: 'GET',
      url: `/api/assets/${ids['thumb'] ?? ''}/content`,
      headers: { cookie: `${cookie?.name ?? ''}=${cookie?.value ?? ''}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'PIN_REQUIRED' });
  });
});

/* ------------------------------------------------------- asset delivery -- */

describe('GET /api/assets/:assetId/content', () => {
  it('redirects to a presigned URL on the storage endpoint, valid for 60 s', async () => {
    const roll = await createRoll({ title: `Delivery ${RUN}` });
    const captureId = newId('cap');
    await insertCaptures(roll.rollId, [{ id: captureId }]);
    const ids = await insertAssets(roll.rollId, captureId, [{ role: 'thumb' }]);

    const res = await app.inject({
      method: 'GET',
      url: `/api/assets/${ids['thumb'] ?? ''}/content`,
    });

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers['location'] as string);
    const endpoint = new URL(config.S3_ENDPOINT);
    expect(location.host).toBe(endpoint.host);
    expect(location.protocol).toBe(endpoint.protocol);

    expect(location.searchParams.get('X-Amz-Expires')).toBe(String(ASSET_URL_TTL_SECONDS));
    expect(ASSET_URL_TTL_SECONDS).toBe(60);
    expect(location.searchParams.get('X-Amz-Signature')).toBeTruthy();
    // A signature is what authorizes the fetch — the key alone must not (05 §6).
    expect(location.searchParams.get('response-content-disposition')).toBe('inline');

    expect(res.headers['cache-control']).toBe('private, max-age=55');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  /**
   * Browsers and service workers DO cache a 302 that carries an explicit
   * `Cache-Control`, so a cache lifetime at or above the signature's lifetime
   * means a re-requested `<img>` replays the stored Location, follows an expired
   * signature and renders a broken tile until the cache entry ages out. Task
   * 28's PWA caches this exact route.
   *
   * Asserted on the constants, not just the header, so editing *either* number
   * the wrong way fails here rather than in production.
   */
  it('never caches a redirect for longer than its signature is valid', () => {
    expect(ASSET_CACHE_MAX_AGE_SECONDS).toBeLessThan(ASSET_URL_TTL_SECONDS);
    expect(ASSET_CACHE_CONTROL).toBe(`private, max-age=${ASSET_CACHE_MAX_AGE_SECONDS}`);
    // `private` matters as much as the age: the URL is signed for one requester.
    expect(ASSET_CACHE_CONTROL.startsWith('private,')).toBe(true);
  });

  it('signs a URL that storage actually honours', async () => {
    const roll = await createRoll({ title: `Round trip ${RUN}` });
    const captureId = newId('cap');
    await insertCaptures(roll.rollId, [{ id: captureId }]);
    const ids = await insertAssets(roll.rollId, captureId, [{ role: 'thumb' }]);
    const body = randomBytes(64);
    await storeBytes(ids['thumb'] ?? '', body);

    const res = await app.inject({
      method: 'GET',
      url: `/api/assets/${ids['thumb'] ?? ''}/content`,
    });
    expect(res.statusCode).toBe(302);

    const fetched = await fetch(res.headers['location'] as string);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(body)).toBe(true);
  }, 30_000);

  it('streams authorized bytes through the API when production storage is private', async () => {
    const roll = await createRoll({ title: `Proxy round trip ${RUN}` });
    const captureId = newId('cap');
    await insertCaptures(roll.rollId, [{ id: captureId }]);
    const ids = await insertAssets(roll.rollId, captureId, [{ role: 'thumb' }]);
    const body = randomBytes(64);
    await storeBytes(ids['thumb'] ?? '', body);

    const response = await proxyApp.inject({
      method: 'GET',
      url: `/api/assets/${ids['thumb'] ?? ''}/content`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['location']).toBeUndefined();
    expect(response.headers['content-type']).toContain('image/webp');
    expect(response.headers['content-disposition']).toBe('inline');
    expect(response.rawPayload.equals(body)).toBe(true);
  }, 30_000);

  it('404s an unknown asset, an unready asset, and a deleted capture’s assets', async () => {
    const roll = await createRoll({ title: `Gone ${RUN}` });
    const deletedCapture = newId('cap');
    const liveCapture = newId('cap');
    await insertCaptures(roll.rollId, [
      { id: deletedCapture, deletedAt: new Date() },
      { id: liveCapture },
    ]);
    const gone = await insertAssets(roll.rollId, deletedCapture, [{ role: 'thumb' }]);
    const pending = await insertAssets(roll.rollId, liveCapture, [
      { role: 'thumb', status: 'pending' },
    ]);

    const missing = await app.inject({ method: 'GET', url: '/api/assets/asset_nope/content' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });

    const trashed = await app.inject({
      method: 'GET',
      url: `/api/assets/${gone['thumb'] ?? ''}/content`,
    });
    expect(trashed.statusCode).toBe(404);
    expect(trashed.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });

    const unready = await app.inject({
      method: 'GET',
      url: `/api/assets/${pending['thumb'] ?? ''}/content`,
    });
    expect(unready.statusCode).toBe(409);
    expect(unready.json()).toMatchObject({ code: 'ASSET_NOT_READY' });
  });

  it('404s a hidden capture’s assets', async () => {
    const roll = await createRoll({ title: `Hidden asset ${RUN}` });
    const captureId = newId('cap');
    await insertCaptures(roll.rollId, [{ id: captureId, visible: false }]);
    const ids = await insertAssets(roll.rollId, captureId, [{ role: 'thumb' }]);

    const res = await app.inject({
      method: 'GET',
      url: `/api/assets/${ids['thumb'] ?? ''}/content`,
    });
    expect(res.statusCode).toBe(404);
  });
});

/* --------------------------------------------- the guest asset surface -- */

/**
 * Every declared asset role, enumerated against the guest audience.
 *
 * A list of roles rather than a test per role, and asserted **exhaustively**
 * against `ASSET_ROLES`: the bug this covers is a role nobody thought about.
 * `metadata` was published to guests for exactly that reason, and five more
 * roles are declared that no worker produces yet — so a role added to the schema
 * with no decision made about it fails the first expectation here.
 */
describe('which asset roles a guest may see (05 \u00a76)', () => {
  /** The engineering record. Not pixels, and not the guest's to read. */
  const HOST_ONLY: readonly string[] = ['metadata'];
  const GUEST_ROLES = ASSET_ROLES.filter((role) => !HOST_ONLY.includes(role));

  const mimeFor = (role: string): string => {
    if (role === 'metadata') return 'application/json';
    if (role === 'wiggle-mp4') return 'video/mp4';
    if (role === 'gif') return 'image/gif';
    if (role === 'original-frame' || role === 'contact-sheet') return 'image/jpeg';
    return 'image/webp';
  };

  it('accounts for every role in ASSET_ROLES, so a new one cannot slip through unjudged', () => {
    for (const role of ASSET_ROLES) {
      expect(guestMaySeeRole(role), `role ${role} has no decision`).toBe(!HOST_ONLY.includes(role));
    }
  });

  it('names the pixel roles in the feed and omits the host-only ones', async () => {
    const roll = await createRoll({ title: `Roles ${RUN}` });
    const captureId = newId('cap');
    await insertCaptures(roll.rollId, [{ id: captureId }]);
    const ids = await insertAssets(
      roll.rollId,
      captureId,
      ASSET_ROLES.map((role) => ({
        role,
        mime: mimeFor(role),
        ...(role === 'original-frame' ? { frameIndex: 1 } : {}),
      })),
    );

    const detail = await app.inject({
      method: 'GET',
      url: `/api/rolls/${roll.slug}/captures/${captureId}`,
    });
    expect(detail.statusCode).toBe(200);
    const named = detail.json<{ assets: { role: string }[] }>().assets.map((a) => a.role);

    expect([...named].sort()).toEqual([...GUEST_ROLES].sort());

    // The page feed answers the same, from the same predicate.
    const page = await feed(roll.slug);
    const inFeed = (page.items[0]?.assets ?? []).map((asset) => asset.role);
    for (const role of HOST_ONLY) expect(inFeed).not.toContain(role);

    // And knowing the id of a host-only asset does not make it fetchable: 404,
    // the same answer as an id that was never real, so the refusal itself tells
    // a guest nothing.
    for (const role of HOST_ONLY) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/assets/${ids[role] ?? ''}/content`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
    }

    // Every guest role is deliverable, which is the other half of the contract:
    // an id the feed names is an id that can be fetched.
    for (const role of GUEST_ROLES) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/assets/${ids[role] ?? ''}/content`,
      });
      expect(res.statusCode, `role ${role} was not deliverable`).toBe(302);
    }
  });

  /**
   * `metadata.json` is the host's own record — GPS EXIF, the device serial, the
   * object key of every original — so the host token has to open it. Refusing
   * the guest is only correct if somebody can still read it.
   */
  it('serves a host-only role to the roll host and to nobody else', async () => {
    const roll = await createRoll({ title: `Host metadata ${RUN}` });
    const captureId = newId('cap');
    await insertCaptures(roll.rollId, [{ id: captureId }]);
    const ids = await insertAssets(roll.rollId, captureId, [
      { role: 'metadata', mime: 'application/json', width: null, height: null },
    ]);
    const url = `/api/assets/${ids['metadata'] ?? ''}/content`;

    const asHost = await app.inject({ method: 'GET', url, headers: bearer(roll.hostToken) });
    expect(asHost.statusCode).toBe(302);

    // Another roll's host token is not this roll's host.
    const other = await createRoll({ title: `Other host ${RUN}` });
    const asOtherHost = await app.inject({
      method: 'GET',
      url,
      headers: bearer(other.hostToken),
    });
    expect(asOtherHost.statusCode).toBe(404);
  });
});

/* ------------------------------------------------ regenerating the link -- */

/**
 * Rotating the slug has to revoke the *assets* too, or "regenerate guest link"
 * revokes the door and leaves the windows open: the asset route is addressed by
 * asset id and derives the roll from the asset, so every id the leaked link
 * already handed out would keep serving bytes.
 */
describe('POST /api/host/rolls/:rollId/regenerate-slug revokes asset access', () => {
  it('403s an assetId that was readable before the slug was regenerated', async () => {
    const roll = await createRoll({ title: `Revoked ${RUN}` });
    const captureId = newId('cap');
    await insertCaptures(roll.rollId, [{ id: captureId }]);
    const ids = await insertAssets(roll.rollId, captureId, [{ role: 'thumb' }]);
    const assetUrl = `/api/assets/${ids['thumb'] ?? ''}/content`;

    // A guest opens the roll through the link it was given, and the tile loads.
    const opened = await app.inject({ method: 'GET', url: `/api/rolls/${roll.slug}` });
    expect(opened.statusCode).toBe(200);
    const stamp = opened.cookies.find((c) => c.name === `kino_roll_${roll.rollId}`);
    expect(stamp).toMatchObject({ httpOnly: true, path: '/' });
    const stale = { cookie: `${stamp?.name ?? ''}=${stamp?.value ?? ''}` };
    expect((await app.inject({ method: 'GET', url: assetUrl, headers: stale })).statusCode).toBe(
      302,
    );

    // The host regenerates the link.
    const regenerated = await app.inject({
      method: 'POST',
      url: `/api/host/rolls/${roll.rollId}/regenerate-slug`,
      headers: bearer(roll.hostToken),
    });
    expect(regenerated.statusCode).toBe(200);
    const fresh = regenerated.json<{ slug: string }>().slug;
    expect(fresh).not.toBe(roll.slug);

    // The old slug is gone, and — the point of this test — so is the asset the
    // guest already held the id of, with the stamp it was issued under.
    expect((await app.inject({ method: 'GET', url: `/api/rolls/${roll.slug}` })).statusCode).toBe(
      404,
    );
    for (const headers of [stale, {}]) {
      const res = await app.inject({ method: 'GET', url: assetUrl, headers });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'ACCESS_REVOKED' });
    }

    // A guest that opens the roll through the NEW link gets a fresh stamp and
    // the same asset back: this revokes a link, it does not delete photographs.
    const reopened = await app.inject({ method: 'GET', url: `/api/rolls/${fresh}` });
    expect(reopened.statusCode).toBe(200);
    const current = reopened.cookies.find((c) => c.name === `kino_roll_${roll.rollId}`);
    const renewed = { cookie: `${current?.name ?? ''}=${current?.value ?? ''}` };
    expect((await app.inject({ method: 'GET', url: assetUrl, headers: renewed })).statusCode).toBe(
      302,
    );

    // The host never needed a stamp: it is the host who revoked the link.
    expect(
      (await app.inject({ method: 'GET', url: assetUrl, headers: bearer(roll.hostToken) }))
        .statusCode,
    ).toBe(302);
  });
});

describe('downloads by host permission (03 \u00a725)', () => {
  async function rollWithAssets(
    downloadsEnabled: boolean,
  ): Promise<{ roll: CreatedRollResponse; ids: Record<string, string> }> {
    const roll = await createRoll({ title: `Downloads ${downloadsEnabled} ${RUN}`, downloadsEnabled });
    const captureId = newId('cap');
    await insertCaptures(roll.rollId, [{ id: captureId }]);
    const ids = await insertAssets(roll.rollId, captureId, [
      { role: 'thumb' },
      { role: 'wiggle-preview' },
      { role: 'wiggle-webp' },
      { role: 'kino-still', mime: 'image/jpeg' },
      { role: 'original-frame', frameIndex: 1, mime: 'image/jpeg' },
      // A role no worker produces yet. It is exactly the case an allow-list of
      // gated roles would have served for free.
      { role: 'wiggle-mp4', mime: 'video/mp4' },
    ]);
    return { roll, ids };
  }

  const content = async (assetId: string, query = ''): Promise<ReturnType<typeof app.inject>> =>
    app.inject({ method: 'GET', url: `/api/assets/${assetId}/content${query}` });

  it('refuses an original frame while the thumb still serves', async () => {
    const { ids } = await rollWithAssets(false);

    const original = await content(ids['original-frame'] ?? '');
    expect(original.statusCode).toBe(403);
    expect(original.json()).toMatchObject({ code: 'DOWNLOADS_DISABLED' });

    // The gallery still renders: viewing is not downloading.
    for (const role of ['thumb', 'wiggle-webp', 'kino-still']) {
      const res = await content(ids[role] ?? '');
      expect(res.statusCode).toBe(302);
    }
  });

  it('refuses a KINO still asked for as an attachment but serves it inline', async () => {
    const { ids } = await rollWithAssets(false);

    const inline = await content(ids['kino-still'] ?? '');
    expect(inline.statusCode).toBe(302);
    expect(new URL(inline.headers['location'] as string).searchParams.get(
      'response-content-disposition',
    )).toBe('inline');

    const download = await content(ids['kino-still'] ?? '', '?download=1');
    expect(download.statusCode).toBe(403);
    expect(download.json()).toMatchObject({ code: 'DOWNLOADS_DISABLED' });
  });

  it('never gates a thumb or a wiggle preview, even asked for as an attachment', async () => {
    const { ids } = await rollWithAssets(false);

    for (const role of ['thumb', 'wiggle-preview']) {
      const res = await content(ids[role] ?? '', '?download=1');
      expect(res.statusCode).toBe(302);
      expect(
        new URL(res.headers['location'] as string).searchParams.get('response-content-disposition'),
      ).toMatch(/^attachment; filename=/);
    }
  });

  /**
   * The gate is an exception list, not an allow-list, and this is the test that
   * says so. `wiggle-mp4`, `gif`, `contact-sheet`, `enhanced-still` and
   * `enhanced-wiggle` are all declared in `ASSET_ROLES` with no worker producing
   * them yet; under a list of *gated* roles every one of them would have been
   * downloadable from a roll with downloads switched off, the moment it first
   * appeared, with nothing failing to say so.
   */
  it('gates a role that no worker produces yet, rather than serving it', async () => {
    const off = await rollWithAssets(false);

    const refused = await content(off.ids['wiggle-mp4'] ?? '', '?download=1');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'DOWNLOADS_DISABLED' });

    // Still viewable inline: gating a download is not hiding the capture.
    expect((await content(off.ids['wiggle-mp4'] ?? '')).statusCode).toBe(302);
    // And gated only by the switch, not by the role — the host can turn it on.
    const on = await rollWithAssets(true);
    expect((await content(on.ids['wiggle-mp4'] ?? '', '?download=1')).statusCode).toBe(302);
  });

  it('serves originals as attachments once the host allows downloads', async () => {
    const { ids } = await rollWithAssets(true);

    const res = await content(ids['original-frame'] ?? '');
    expect(res.statusCode).toBe(302);
    const disposition = new URL(res.headers['location'] as string).searchParams.get(
      'response-content-disposition',
    );
    // An original is never a display asset: asking for it *is* asking to keep it.
    expect(disposition).toMatch(/^attachment; filename=/);
    expect(disposition).toContain('cam-01');

    const still = await content(ids['kino-still'] ?? '', '?download=1');
    expect(still.statusCode).toBe(302);
  });

  /** Task 19's PWA needs this to decide whether to draw the download control. */
  it('tells the guest whether downloads are on', async () => {
    const off = await createRoll({ title: `Flag off ${RUN}`, downloadsEnabled: false });
    const on = await createRoll({ title: `Flag on ${RUN}` });

    const readFlag = async (slug: string): Promise<unknown> => {
      const res = await app.inject({ method: 'GET', url: `/api/rolls/${slug}` });
      expect(res.statusCode).toBe(200);
      return res.json<{ downloadsEnabled: unknown }>().downloadsEnabled;
    };

    expect(await readFlag(off.slug)).toBe(false);
    expect(await readFlag(on.slug)).toBe(true);
  });
});
