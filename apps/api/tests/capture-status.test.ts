import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { loadConfig, type ApiConfig } from '../src/config';
import { newId } from '../src/ids';
import { derivedKey, originalKey } from '../src/uploads/objectKeys';
import { CONVERGE_CONCURRENCY } from '../src/uploads/uploads';
import * as schema from '../src/db/schema';

/**
 * Task 21b: a capture's status converges on read.
 *
 * `recomputeCaptureStatus` is only ever called by the three device endpoints,
 * and the one that queues the derivative jobs runs *before* any of them execute.
 * Nothing runs after a job finishes — the worker is independent of the API by
 * 05 §11 — so a fully processed capture kept a stored `processing` forever and
 * 03 §10's Pending count never drained. These tests drive that from the rows a
 * worker actually writes.
 *
 * Same house rules as the other suites here: real database, no mocks.
 *
 *   docker compose -f infra/docker-compose.dev.yml up -d
 *   npm run db:migrate -w @kino/api
 *
 * Rows are inserted directly rather than driven through init/part/complete.
 * What is under test is a read deriving a status from rows, and the rows are the
 * only input it has; putting real bytes in MinIO first would test the uploader.
 */
const RUN = randomBytes(4).toString('hex');

const config: ApiConfig = loadConfig();
const app: FastifyInstance = buildServer(config);

const SERIAL = `KD4-T21B-${RUN}`;

const createdRollIds: string[] = [];

let device: { deviceId: string; deviceToken: string };

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

interface CreatedRollResponse {
  rollId: string;
  slug: string;
  hostToken: string;
}

async function createRoll(title: string): Promise<CreatedRollResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/host/rolls',
    payload: { title },
  });
  expect(res.statusCode).toBe(201);
  const created = res.json<CreatedRollResponse>();
  createdRollIds.push(created.rollId);

  // The device endpoints resolve the roll from the capture and demand
  // created-or-joined, so the fixture device has to be in the roll.
  const joined = await app.inject({
    method: 'POST',
    url: '/api/device/rolls/join',
    headers: bearer(device.deviceToken),
    payload: { slug: created.slug },
  });
  expect(joined.statusCode).toBe(200);
  return created;
}

/* ------------------------------------------------------------- fixtures -- */

interface AssetFixture {
  role: string;
  frameIndex?: number;
  status?: string;
}

/** One event row, as a worker writes it: job, status, and when. */
interface EventFixture {
  job: string;
  status: string;
  /** Seconds after the capture's own clock, so the log has a real order. */
  atOffset?: number;
}

interface CaptureFixture {
  /** What the API last stored. `processing` is what capture-complete leaves. */
  status: string;
  assets?: readonly AssetFixture[];
  events?: readonly EventFixture[];
  visible?: boolean;
  /** Set to `BLOCK_LOOK` to make this capture's own UPDATE raise. */
  look?: string;
}

const EPOCH = new Date('2026-08-01T12:00:00.000Z');

async function seedCapture(rollId: string, fixture: CaptureFixture): Promise<string> {
  const captureId = newId('cap');

  await app.db.insert(schema.captures).values({
    id: captureId,
    captureUuid: randomUUID(),
    rollId,
    deviceId: device.deviceId,
    mode: 'wiggle',
    capturedAt: EPOCH,
    frameCount: 4,
    resolution: '1600x1200',
    status: fixture.status,
    visible: fixture.visible ?? true,
    look: fixture.look ?? null,
  });

  const assetFixtures = fixture.assets ?? [];
  if (assetFixtures.length > 0) {
    await app.db.insert(schema.assets).values(
      assetFixtures.map((asset) => {
        const frameIndex = asset.frameIndex ?? null;
        return {
          id: newId('asset'),
          captureId,
          role: asset.role,
          frameIndex,
          mime: frameIndex === null ? 'image/webp' : 'image/jpeg',
          width: 480,
          height: 360,
          bytes: 1024,
          sha256: null,
          objectKey:
            frameIndex === null
              ? derivedKey(rollId, captureId, `${asset.role}.webp`)
              : originalKey(rollId, captureId, frameIndex),
          status: asset.status ?? 'ready',
        };
      }),
    );
  }

  const eventFixtures = fixture.events ?? [];
  if (eventFixtures.length > 0) {
    await app.db.insert(schema.processingEvents).values(
      eventFixtures.map((event) => ({
        id: newId('pev'),
        captureId,
        job: event.job,
        status: event.status,
        at: new Date(EPOCH.getTime() + (event.atOffset ?? 0) * 1000),
      })),
    );
  }

  return captureId;
}

/**
 * A capture whose whole pipeline finished, exactly as the worker leaves it: the
 * enqueue's `queued` row, then `running`, then `done`, per job — and the derived
 * asset rows the handlers wrote.
 */
function processedCapture(): CaptureFixture {
  return {
    status: 'processing',
    assets: [
      { role: 'original-frame', frameIndex: 1 },
      { role: 'original-frame', frameIndex: 2 },
      { role: 'thumb' },
      { role: 'kino-still' },
      { role: 'wiggle-webp' },
    ],
    events: [
      { job: 'extract-metadata', status: 'queued', atOffset: 0 },
      { job: 'extract-metadata', status: 'running', atOffset: 1 },
      { job: 'extract-metadata', status: 'done', atOffset: 2 },
      { job: 'generate-thumbnail', status: 'queued', atOffset: 0 },
      { job: 'generate-thumbnail', status: 'running', atOffset: 1 },
      { job: 'generate-thumbnail', status: 'done', atOffset: 3 },
      { job: 'render-wiggle-webp', status: 'queued', atOffset: 0 },
      { job: 'render-wiggle-webp', status: 'done', atOffset: 4 },
    ],
  };
}

/** The same pipeline, except one job's attempts ran out (Task 22's policy). */
function abandonedCapture(): CaptureFixture {
  const fixture = processedCapture();
  return {
    ...fixture,
    events: [
      ...(fixture.events ?? []).filter((event) => event.job !== 'render-wiggle-webp'),
      // The enqueue's row is retired so the partial unique index does not stay
      // armed, and the give-up is appended after it.
      { job: 'render-wiggle-webp', status: 'superseded', atOffset: 5 },
      { job: 'render-wiggle-webp', status: 'abandoned', atOffset: 5 },
    ],
  };
}

/* --------------------------------------------------------------- readers -- */

async function storedStatus(captureId: string): Promise<string> {
  const [row] = await app.db
    .select({ status: schema.captures.status })
    .from(schema.captures)
    .where(eq(schema.captures.id, captureId));
  if (row === undefined) throw new Error(`capture ${captureId} vanished`);
  return row.status;
}

async function deviceStatus(captureId: string): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/device/captures/${captureId}/status`,
    headers: bearer(device.deviceToken),
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ status: string }>().status;
}

interface FeedItem {
  captureId: string;
  status: string;
}

async function guestFeedStatuses(slug: string): Promise<Map<string, string>> {
  const res = await app.inject({ method: 'GET', url: `/api/rolls/${slug}/captures` });
  expect(res.statusCode).toBe(200);
  const page = res.json<{ items: FeedItem[] }>();
  return new Map(page.items.map((item) => [item.captureId, item.status]));
}

async function guestDetailStatus(slug: string, captureId: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: `/api/rolls/${slug}/captures/${captureId}` });
  expect(res.statusCode).toBe(200);
  return res.json<{ status: string }>().status;
}

async function hostListStatuses(roll: CreatedRollResponse): Promise<Map<string, string>> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/host/rolls/${roll.rollId}/captures`,
    headers: bearer(roll.hostToken),
  });
  expect(res.statusCode).toBe(200);
  const page = res.json<{ items: FeedItem[] }>();
  return new Map(page.items.map((item) => [item.captureId, item.status]));
}

/** The raw reply, for the cases that assert the request survives at all. */
async function deviceStatusReply(captureId: string): Promise<{ code: number; status: string }> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/device/captures/${captureId}/status`,
    headers: bearer(device.deviceToken),
  });
  return { code: res.statusCode, status: res.json<{ status: string }>().status };
}

interface Counts {
  captures: number;
  pending: number;
  hidden: number;
}

async function dashboardCounts(roll: CreatedRollResponse): Promise<Counts> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/host/rolls/${roll.rollId}`,
    headers: bearer(roll.hostToken),
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ counts: Counts }>().counts;
}

/** The guest feed's raw reply, so a test can assert it is not a 500. */
async function guestFeedReply(slug: string): Promise<{ code: number; items: FeedItem[] }> {
  const res = await app.inject({ method: 'GET', url: `/api/rolls/${slug}/captures` });
  return { code: res.statusCode, items: res.json<{ items: FeedItem[] }>().items };
}

/* ----------------------------------------------------------------- setup -- */

let migrated = false;

async function assertMigrated(): Promise<void> {
  const rows = await app.db.execute<{ table_name: string }>(sql`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('captures', 'assets', 'rolls', 'processing_events')
  `);
  const present = new Set(Array.from(rows).map((row) => row.table_name));
  const missing = ['captures', 'assets', 'rolls', 'processing_events'].filter(
    (table) => !present.has(table),
  );
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

  const res = await app.inject({
    method: 'POST',
    url: '/api/studio/devices/register',
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

    if (captureIds.length > 0) {
      await app.db
        .delete(schema.processingEvents)
        .where(inArray(schema.processingEvents.captureId, captureIds));
      await app.db.delete(schema.assets).where(inArray(schema.assets.captureId, captureIds));
      await app.db.delete(schema.captures).where(inArray(schema.captures.id, captureIds));
    }
    await app.db
      .delete(schema.auditEvents)
      .where(inArray(schema.auditEvents.rollId, createdRollIds));
    await app.db
      .delete(schema.rollDevices)
      .where(inArray(schema.rollDevices.rollId, createdRollIds));
    await app.db.delete(schema.rolls).where(inArray(schema.rolls.id, createdRollIds));
  }
  if (migrated) {
    await app.db.delete(schema.devices).where(eq(schema.devices.serial, SERIAL));
  }
  await app.close();
}, 60_000);

/* ------------------------------------------------------------------ tests -- */

describe('a processed capture reaches ready (05 §8)', () => {
  let roll: CreatedRollResponse;
  let captureId: string;

  beforeAll(async () => {
    roll = await createRoll(`Processed ${RUN}`);
    captureId = await seedCapture(roll.rollId, processedCapture());
    // The precondition: capture-complete stored `processing`, and every job then
    // finished without anything calling back into the API.
    expect(await storedStatus(captureId)).toBe('processing');
  });

  it('reports ready from the device status route and persists it', async () => {
    expect(await deviceStatus(captureId)).toBe('ready');
    expect(await storedStatus(captureId)).toBe('ready');
  });

  it('is stable on a second read', async () => {
    expect(await deviceStatus(captureId)).toBe('ready');
    expect(await deviceStatus(captureId)).toBe('ready');
    expect(await storedStatus(captureId)).toBe('ready');
  });

  it('reports ready in the guest feed and the guest capture detail', async () => {
    const fresh = await seedCapture(roll.rollId, processedCapture());

    const feed = await guestFeedStatuses(roll.slug);
    expect(feed.get(fresh)).toBe('ready');

    const detailOnly = await seedCapture(roll.rollId, processedCapture());
    expect(await guestDetailStatus(roll.slug, detailOnly)).toBe('ready');
  });

  it('reports ready in the host capture list', async () => {
    const fresh = await seedCapture(roll.rollId, processedCapture());
    const list = await hostListStatuses(roll);
    expect(list.get(fresh)).toBe('ready');
  });
});

describe("the host dashboard's Pending count drains (03 §10)", () => {
  it('counts a processed capture as settled', async () => {
    const roll = await createRoll(`Pending ${RUN}`);
    const captureId = await seedCapture(roll.rollId, processedCapture());

    const counts = await dashboardCounts(roll);
    expect(counts.captures).toBe(1);
    expect(counts.pending).toBe(0);
    expect(await storedStatus(captureId)).toBe('ready');
  });

  it('still counts a capture mid-pipeline as pending', async () => {
    const roll = await createRoll(`Pending mixed ${RUN}`);
    await seedCapture(roll.rollId, processedCapture());
    await seedCapture(roll.rollId, {
      status: 'processing',
      assets: [{ role: 'original-frame', frameIndex: 1 }],
      events: [
        { job: 'extract-metadata', status: 'queued', atOffset: 0 },
        { job: 'extract-metadata', status: 'done', atOffset: 1 },
        { job: 'generate-thumbnail', status: 'queued', atOffset: 0 },
      ],
    });

    const counts = await dashboardCounts(roll);
    expect(counts.captures).toBe(2);
    expect(counts.pending).toBe(1);
  });
});

describe('an abandoned job yields partial', () => {
  it('reads partial and treats it as settled', async () => {
    const roll = await createRoll(`Abandoned ${RUN}`);
    const captureId = await seedCapture(roll.rollId, abandonedCapture());

    expect(await deviceStatus(captureId)).toBe('partial');
    expect(await storedStatus(captureId)).toBe('partial');

    const counts = await dashboardCounts(roll);
    expect(counts.captures).toBe(1);
    // Settled, not pending: nothing is going to move it again.
    expect(counts.pending).toBe(0);

    // And it does not drift back on the next read.
    expect(await deviceStatus(captureId)).toBe('partial');
    expect((await guestFeedStatuses(roll.slug)).get(captureId)).toBe('partial');
  });
});

describe('a capture mid-pipeline is not reported as finished', () => {
  it('stays processing while a job is still queued or running', async () => {
    const roll = await createRoll(`Mid ${RUN}`);
    const queuedStill = await seedCapture(roll.rollId, {
      status: 'processing',
      assets: [{ role: 'original-frame', frameIndex: 1 }, { role: 'thumb' }],
      events: [
        { job: 'extract-metadata', status: 'queued', atOffset: 0 },
        { job: 'extract-metadata', status: 'done', atOffset: 2 },
        { job: 'generate-thumbnail', status: 'queued', atOffset: 0 },
      ],
    });
    const runningStill = await seedCapture(roll.rollId, {
      status: 'processing',
      assets: [{ role: 'original-frame', frameIndex: 1 }, { role: 'thumb' }],
      events: [
        { job: 'extract-metadata', status: 'queued', atOffset: 0 },
        { job: 'extract-metadata', status: 'done', atOffset: 2 },
        { job: 'generate-thumbnail', status: 'queued', atOffset: 0 },
        { job: 'generate-thumbnail', status: 'running', atOffset: 1 },
      ],
    });

    expect(await deviceStatus(queuedStill)).toBe('processing');
    expect(await deviceStatus(runningStill)).toBe('processing');

    const feed = await guestFeedStatuses(roll.slug);
    expect(feed.get(queuedStill)).toBe('processing');
    expect(feed.get(runningStill)).toBe('processing');
  });
});

describe('settled captures are not recomputed', () => {
  /**
   * The proof is a stored status the recompute would *disagree* with: a capture
   * marked `ready` whose tables hold no assets and no events recomputes to
   * `created`. If a page recomputed it, the response and the column would both
   * change. Both staying put is the only outcome consistent with the row having
   * been skipped, and it is observable rather than inferred from a spy.
   */
  it('leaves a terminal row untouched while converging its non-terminal neighbour', async () => {
    const roll = await createRoll(`Skip ${RUN}`);
    const settled = await seedCapture(roll.rollId, { status: 'ready' });
    const failed = await seedCapture(roll.rollId, { status: 'failed' });
    const partial = await seedCapture(roll.rollId, { status: 'partial' });
    const unsettled = await seedCapture(roll.rollId, processedCapture());

    const hostList = await hostListStatuses(roll);
    expect(hostList.get(settled)).toBe('ready');
    expect(hostList.get(failed)).toBe('failed');
    expect(hostList.get(partial)).toBe('partial');
    expect(hostList.get(unsettled)).toBe('ready');

    // No write happened for the three terminal rows: a recompute would have
    // stored `created` for each of them.
    expect(await storedStatus(settled)).toBe('ready');
    expect(await storedStatus(failed)).toBe('failed');
    expect(await storedStatus(partial)).toBe('partial');
    // The one that was recomputed is the one that needed it.
    expect(await storedStatus(unsettled)).toBe('ready');

    // Same story through the guest feed and the dashboard count.
    const feed = await guestFeedStatuses(roll.slug);
    expect(feed.get(settled)).toBe('ready');
    expect(await storedStatus(settled)).toBe('ready');
    expect((await dashboardCounts(roll)).pending).toBe(0);
  });
});

describe('a recompute that fails does not fail the read', () => {
  /**
   * The failure is forced in the database, not mocked: a `BEFORE UPDATE` trigger
   * on `captures` raises for any row carrying `look = 'block-converge'`. That is
   * the real failure mode this guards against — a lock timeout, a transient pool
   * error, a read-only connection — arriving through the real code path, rather
   * than a stubbed module that proves only that the stub was called.
   */
  const BLOCK_LOOK = 'block-converge';

  let roll: CreatedRollResponse;
  let blocked: string;
  let healthy: string;

  beforeAll(async () => {
    await app.db.execute(sql`
      create or replace function kino_t21b_block() returns trigger language plpgsql as $$
      begin
        if new.look = 'block-converge' then
          raise exception 'forced converge failure for %', new.id;
        end if;
        return new;
      end;
      $$
    `);
    await app.db.execute(sql`
      create trigger kino_t21b_block before update on captures
        for each row execute function kino_t21b_block()
    `);

    roll = await createRoll(`Converge failure ${RUN}`);
    blocked = await seedCapture(roll.rollId, { ...processedCapture(), look: BLOCK_LOOK });
    healthy = await seedCapture(roll.rollId, processedCapture());
  });

  afterAll(async () => {
    await app.db.execute(sql`drop trigger if exists kino_t21b_block on captures`);
    await app.db.execute(sql`drop function if exists kino_t21b_block()`);
  });

  it('serves the guest feed with a stale status for the row that failed', async () => {
    const page = await guestFeedReply(roll.slug);
    expect(page.code).toBe(200);

    const byId = new Map(page.items.map((item) => [item.captureId, item.status]));
    // Stale rather than wrong: the value the column already held.
    expect(byId.get(blocked)).toBe('processing');
    // And the failure is contained — its neighbour on the same page converged.
    expect(byId.get(healthy)).toBe('ready');

    expect(await storedStatus(blocked)).toBe('processing');
    expect(await storedStatus(healthy)).toBe('ready');
  });

  it('serves the device status route and the guest detail rather than a 500', async () => {
    const reply = await deviceStatusReply(blocked);
    expect(reply.code).toBe(200);
    expect(reply.status).toBe('processing');

    expect(await guestDetailStatus(roll.slug, blocked)).toBe('processing');
  });

  it('still renders the dashboard counts', async () => {
    const counts = await dashboardCounts(roll);
    expect(counts.captures).toBe(2);
    // The blocked capture stays pending, which is honest: it is the one number
    // nobody could refresh.
    expect(counts.pending).toBe(1);
  });
});

describe('the bounded fan-out converges every row', () => {
  /**
   * More unsettled captures on one page than `CONVERGE_CONCURRENCY` allows in
   * flight, so the bounded map has to come back for the rest. An off-by-one in the
   * cursor would leave the tail on `processing`.
   */
  it('converges a page larger than the concurrency cap', async () => {
    expect(CONVERGE_CONCURRENCY).toBeLessThan(7);

    const roll = await createRoll(`Bounded ${RUN}`);
    const ids: string[] = [];
    for (let n = 0; n < 7; n += 1) {
      ids.push(await seedCapture(roll.rollId, processedCapture()));
    }

    const feed = await guestFeedStatuses(roll.slug);
    for (const id of ids) expect(feed.get(id)).toBe('ready');
    for (const id of ids) expect(await storedStatus(id)).toBe('ready');
    expect((await dashboardCounts(roll)).pending).toBe(0);
  });
});
