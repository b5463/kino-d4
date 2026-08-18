import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { loadConfig, type ApiConfig } from '../src/config';
import { newId } from '../src/ids';
import { derivedKey } from '../src/uploads/objectKeys';
import { readRollHistory } from '../src/events/publish';
import { touchRollViewer, VIEWER_STALE_MS } from '../src/events/viewers';
import { TRASH_GRACE_DAYS } from '../src/captures/moderation';
import {
  EXPORT_JOB_NAME,
  EXPORT_URL_TTL_SECONDS,
  exportJobKey,
  exportObjectKey,
} from '../src/exports/exports';
import { createProcessingQueue, jobKeyToJobId } from '../src/queue/producer';
import * as schema from '../src/db/schema';

/**
 * Host moderation and roll export (Task 21), against the real database, real
 * Redis and real MinIO — same house rules as every other suite here:
 *
 *   docker compose -f infra/docker-compose.dev.yml up -d
 *   npm run db:migrate -w @kino/api
 *
 * Captures are inserted directly. What moderation changes is rows and what it
 * announces is Redis entries; driving four cameras through the upload pipeline
 * to produce a row this suite could write in one statement would test Task 18
 * again and this task not at all.
 */
const RUN = randomBytes(4).toString('hex');

const config: ApiConfig = loadConfig();
const app: FastifyInstance = buildServer(config);

const REQUIRED_TABLES = ['captures', 'assets', 'rolls', 'export_jobs'];

const SERIAL = `KD4-T21-${RUN}`;

const createdRollIds: string[] = [];
const storedKeys: string[] = [];
/** Every export jobId this suite minted, for BullMQ teardown. */
const exportJobIds: string[] = [];

let device: { deviceId: string; deviceToken: string };

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

interface CreatedRollResponse {
  rollId: string;
  slug: string;
  hostToken: string;
}

async function createRoll(title = `Moderation roll ${RUN}`): Promise<CreatedRollResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/host/rolls',
    payload: { title },
  });
  expect(res.statusCode).toBe(201);
  const created = res.json<CreatedRollResponse>();
  createdRollIds.push(created.rollId);
  return created;
}

async function insertCapture(
  rollId: string,
  fixture: { visible?: boolean; deletedAt?: Date | null; status?: string } = {},
): Promise<string> {
  const id = newId('cap');
  await app.db.insert(schema.captures).values({
    id,
    captureUuid: randomUUID(),
    rollId,
    deviceId: device.deviceId,
    mode: 'wiggle',
    capturedAt: new Date(),
    frameCount: 4,
    resolution: '1600x1200',
    status: fixture.status ?? 'ready',
    visible: fixture.visible ?? true,
    deletedAt: fixture.deletedAt ?? null,
  });
  return id;
}

/** One ready `thumb` asset, so a capture has something a guest could fetch. */
async function insertAsset(rollId: string, captureId: string): Promise<string> {
  const id = newId('asset');
  await app.db.insert(schema.assets).values({
    id,
    captureId,
    role: 'thumb',
    frameIndex: null,
    mime: 'image/webp',
    width: 480,
    height: 360,
    bytes: 1024,
    sha256: null,
    objectKey: derivedKey(rollId, captureId, 'thumb.webp'),
    status: 'ready',
  });
  return id;
}

interface FeedPage {
  items: { captureId: string }[];
}

async function feedIds(slug: string): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: `/api/rolls/${slug}/captures` });
  expect(res.statusCode).toBe(200);
  return res.json<FeedPage>().items.map((item) => item.captureId);
}

async function auditActions(rollId: string): Promise<string[]> {
  const rows = await app.db
    .select({ action: schema.auditEvents.action, target: schema.auditEvents.target })
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.rollId, rollId))
    .orderBy(schema.auditEvents.at);
  return rows.map((row) => row.action);
}

async function auditRowsFor(rollId: string, action: string): Promise<{ target: string | null }[]> {
  return app.db
    .select({ target: schema.auditEvents.target })
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.rollId, rollId), eq(schema.auditEvents.action, action)));
}

/** Every event a roll has published, oldest first. */
async function publishedEvents(rollId: string): Promise<string[]> {
  const history = await readRollHistory(app.redis, rollId, '0-0');
  return history.map((entry) => entry.event.type);
}

async function captureRow(
  captureId: string,
): Promise<{ visible: boolean; deletedAt: Date | null } | undefined> {
  const [row] = await app.db
    .select({ visible: schema.captures.visible, deletedAt: schema.captures.deletedAt })
    .from(schema.captures)
    .where(eq(schema.captures.id, captureId));
  return row;
}

let migrated = false;

async function assertMigrated(): Promise<void> {
  const rows = await app.db.execute<{ table_name: string }>(sql`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('captures', 'assets', 'rolls', 'export_jobs')
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
      await app.db.delete(schema.assets).where(inArray(schema.assets.captureId, captureIds));
      await app.db.delete(schema.captures).where(inArray(schema.captures.id, captureIds));
    }
    await app.db.delete(schema.exportJobs).where(inArray(schema.exportJobs.rollId, createdRollIds));
    await app.db
      .delete(schema.auditEvents)
      .where(inArray(schema.auditEvents.rollId, createdRollIds));
    await app.db.delete(schema.rollDevices).where(inArray(schema.rollDevices.rollId, createdRollIds));
    await app.db.delete(schema.rolls).where(inArray(schema.rolls.id, createdRollIds));

    await app.redis.del(
      ...createdRollIds.flatMap((id) => [
        `roll:${id}:stream`,
        `roll:${id}:events`,
        `roll:${id}:viewers`,
      ]),
    );
  }
  if (migrated) {
    await app.db.delete(schema.devices).where(eq(schema.devices.serial, SERIAL));
  }

  if (exportJobIds.length > 0) {
    const queue = createProcessingQueue(config);
    try {
      await Promise.all(
        exportJobIds.map(async (jobId) => {
          try {
            await queue.remove(jobKeyToJobId(exportJobKey(jobId)));
          } catch {
            /* the job may already be gone; teardown must not fail on it */
          }
        }),
      );
    } finally {
      await queue.close();
    }
  }

  await app.close();
}, 60_000);

/* ------------------------------------------------------------------ hide -- */

describe('POST /api/host/captures/:captureId/hide (03 §11)', () => {
  it('removes the capture from the guest feed in the same request cycle', async () => {
    const roll = await createRoll();
    const captureId = await insertCapture(roll.rollId);
    await insertAsset(roll.rollId, captureId);

    expect(await feedIds(roll.slug)).toEqual([captureId]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/host/captures/${captureId}/hide`,
      headers: bearer(roll.hostToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ captureId, visible: false, deletedAt: null });

    // No sleep, no retry: the row is committed before the reply is written, so
    // a guest reading immediately after must already miss it.
    expect(await feedIds(roll.slug)).toEqual([]);

    // Retained, not destroyed (03 §11).
    expect(await captureRow(captureId)).toMatchObject({ visible: false, deletedAt: null });
  });

  it('announces capture.hidden and writes one audit row naming the capture', async () => {
    const roll = await createRoll();
    const captureId = await insertCapture(roll.rollId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/host/captures/${captureId}/hide`,
      headers: bearer(roll.hostToken),
    });
    expect(res.statusCode).toBe(200);

    expect(await publishedEvents(roll.rollId)).toEqual(['capture.hidden']);
    expect(await auditRowsFor(roll.rollId, 'capture.hidden')).toEqual([{ target: captureId }]);
  });

  it('is a no-op the second time: no duplicate audit row and no duplicate event', async () => {
    const roll = await createRoll();
    const captureId = await insertCapture(roll.rollId);

    for (const _ of [1, 2]) {
      void _;
      const res = await app.inject({
        method: 'POST',
        url: `/api/host/captures/${captureId}/hide`,
        headers: bearer(roll.hostToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ visible: false });
    }

    expect(await auditActions(roll.rollId)).toEqual(['capture.hidden']);
    expect(await publishedEvents(roll.rollId)).toEqual(['capture.hidden']);
  });

  it('unhide restores the capture to the feed and announces capture.updated', async () => {
    const roll = await createRoll();
    const captureId = await insertCapture(roll.rollId, { visible: false });

    expect(await feedIds(roll.slug)).toEqual([]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/host/captures/${captureId}/unhide`,
      headers: bearer(roll.hostToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ captureId, visible: true });

    expect(await feedIds(roll.slug)).toEqual([captureId]);
    expect(await publishedEvents(roll.rollId)).toEqual(['capture.updated']);
    expect(await auditRowsFor(roll.rollId, 'capture.unhidden')).toEqual([{ target: captureId }]);
  });
});

/* ---------------------------------------------------------------- delete -- */

describe('DELETE /api/host/captures/:captureId (03 §11)', () => {
  it('gives the guest a 404 while the row and its assets stay for the grace period', async () => {
    const roll = await createRoll();
    const captureId = await insertCapture(roll.rollId);
    const assetId = await insertAsset(roll.rollId, captureId);

    const before = Date.now();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/host/captures/${captureId}`,
      headers: bearer(roll.hostToken),
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ captureId: string; deletedAt: string; purgeAfter: string }>();
    expect(body.captureId).toBe(captureId);
    const deletedAt = Date.parse(body.deletedAt);
    expect(deletedAt).toBeGreaterThanOrEqual(before - 1_000);

    // The 7-day grace, read off the reply rather than recomputed by hand.
    const graceMs = TRASH_GRACE_DAYS * 24 * 60 * 60 * 1000;
    expect(Date.parse(body.purgeAfter) - deletedAt).toBe(graceMs);

    // Gone for the guest, both ways in.
    expect(await feedIds(roll.slug)).toEqual([]);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/rolls/${roll.slug}/captures/${captureId}`,
    });
    expect(detail.statusCode).toBe(404);

    // Still there for the host until Task 25's purge job runs: the row survives
    // and so does its asset record, which is what the purge will need to find
    // the bytes.
    expect(await captureRow(captureId)).toMatchObject({ deletedAt: expect.anything() });
    const [asset] = await app.db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(eq(schema.assets.id, assetId));
    expect(asset?.id).toBe(assetId);

    expect(await publishedEvents(roll.rollId)).toEqual(['capture.deleted']);
    expect(await auditRowsFor(roll.rollId, 'capture.deleted')).toEqual([{ target: captureId }]);
  });

  it('leaves the original deletedAt alone when called twice', async () => {
    const roll = await createRoll();
    const captureId = await insertCapture(roll.rollId);

    const first = await app.inject({
      method: 'DELETE',
      url: `/api/host/captures/${captureId}`,
      headers: bearer(roll.hostToken),
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'DELETE',
      url: `/api/host/captures/${captureId}`,
      headers: bearer(roll.hostToken),
    });
    expect(second.statusCode).toBe(200);

    expect(second.json<{ deletedAt: string }>().deletedAt).toBe(
      first.json<{ deletedAt: string }>().deletedAt,
    );
    expect(await auditActions(roll.rollId)).toEqual(['capture.deleted']);
  });

  it('404s an unknown capture id rather than revealing whether it exists elsewhere', async () => {
    const roll = await createRoll();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/host/captures/${newId('cap')}`,
      headers: bearer(roll.hostToken),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('CAPTURE_NOT_FOUND');
  });
});

/* ------------------------------------------------------------ cross-roll -- */

describe("a host token only opens its own roll's captures (07 §25)", () => {
  it('403s every moderation and export route when the token belongs to another roll', async () => {
    const mine = await createRoll('Mine');
    const other = await createRoll('Other');
    const captureId = await insertCapture(mine.rollId);

    const exportRes = await app.inject({
      method: 'POST',
      url: `/api/host/rolls/${mine.rollId}/export`,
      headers: bearer(mine.hostToken),
    });
    expect(exportRes.statusCode).toBe(202);
    const { jobId } = exportRes.json<{ jobId: string }>();
    exportJobIds.push(jobId);

    const attempts: ['POST' | 'DELETE' | 'GET', string][] = [
      ['POST', `/api/host/captures/${captureId}/hide`],
      ['POST', `/api/host/captures/${captureId}/unhide`],
      ['DELETE', `/api/host/captures/${captureId}`],
      ['POST', `/api/host/rolls/${mine.rollId}/export`],
      ['GET', `/api/host/rolls/${mine.rollId}/export/${jobId}`],
    ];

    for (const [method, url] of attempts) {
      const res = await app.inject({ method, url, headers: bearer(other.hostToken) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('INVALID_HOST_TOKEN');
    }

    // And nothing was moderated behind those refusals.
    expect(await captureRow(captureId)).toMatchObject({ visible: true, deletedAt: null });
  });

  it('403s a device token on a capture route rather than 401', async () => {
    const roll = await createRoll();
    const captureId = await insertCapture(roll.rollId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/host/captures/${captureId}/hide`,
      headers: bearer(device.deviceToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('WRONG_TOKEN_SCOPE');
  });
});

/* ---------------------------------------------------------------- export -- */

describe('POST /api/host/rolls/:rollId/export (03 §25)', () => {
  it('records a queued job, hands it to BullMQ and audits the request', async () => {
    const roll = await createRoll();

    const res = await app.inject({
      method: 'POST',
      url: `/api/host/rolls/${roll.rollId}/export`,
      headers: bearer(roll.hostToken),
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json<{ jobId: string }>();
    expect(jobId).toMatch(/^exp_/);
    exportJobIds.push(jobId);

    const [row] = await app.db
      .select({ status: schema.exportJobs.status, rollId: schema.exportJobs.rollId })
      .from(schema.exportJobs)
      .where(eq(schema.exportJobs.id, jobId));
    expect(row).toEqual({ status: 'queued', rollId: roll.rollId });

    const queue = createProcessingQueue(config);
    try {
      const submitted = await queue.getJob(jobKeyToJobId(exportJobKey(jobId)));
      expect(submitted?.name).toBe(EXPORT_JOB_NAME);
      expect(submitted?.data).toMatchObject({ rollId: roll.rollId, jobKey: exportJobKey(jobId) });
    } finally {
      await queue.close();
    }

    expect(await auditRowsFor(roll.rollId, 'roll.exported')).toEqual([{ target: jobId }]);
  });

  it('returns the job already in flight instead of queueing a second one', async () => {
    const roll = await createRoll();

    const first = await app.inject({
      method: 'POST',
      url: `/api/host/rolls/${roll.rollId}/export`,
      headers: bearer(roll.hostToken),
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/host/rolls/${roll.rollId}/export`,
      headers: bearer(roll.hostToken),
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);

    const jobId = first.json<{ jobId: string }>().jobId;
    exportJobIds.push(jobId);
    expect(second.json<{ jobId: string }>().jobId).toBe(jobId);

    const rows = await app.db
      .select({ id: schema.exportJobs.id })
      .from(schema.exportJobs)
      .where(eq(schema.exportJobs.rollId, roll.rollId));
    expect(rows).toHaveLength(1);

    // The second call re-submits under the same id, which BullMQ collapses — one
    // job, not two, and it still carries this roll's payload.
    const queue = createProcessingQueue(config);
    try {
      const submitted = await queue.getJob(jobKeyToJobId(exportJobKey(jobId)));
      expect(submitted?.data).toMatchObject({ rollId: roll.rollId });
    } finally {
      await queue.close();
    }
  });
});

describe('GET /api/host/rolls/:rollId/export/:jobId (03 §25)', () => {
  it('reports the status without a link while the job is still queued', async () => {
    const roll = await createRoll();
    const created = await app.inject({
      method: 'POST',
      url: `/api/host/rolls/${roll.rollId}/export`,
      headers: bearer(roll.hostToken),
    });
    const { jobId } = created.json<{ jobId: string }>();
    exportJobIds.push(jobId);

    const res = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${roll.rollId}/export/${jobId}`,
      headers: bearer(roll.hostToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'queued' });
  });

  it('signs a 24 h link once the ZIP is actually there, and not before', async () => {
    const roll = await createRoll();
    const created = await app.inject({
      method: 'POST',
      url: `/api/host/rolls/${roll.rollId}/export`,
      headers: bearer(roll.hostToken),
    });
    const { jobId } = created.json<{ jobId: string }>();
    exportJobIds.push(jobId);

    // Stand in for Task 25's handler finishing the row but not the object: a
    // 'done' row alone must not produce a link to nothing.
    await app.db
      .update(schema.exportJobs)
      .set({ status: 'done', finishedAt: new Date() })
      .where(eq(schema.exportJobs.id, jobId));

    const missing = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${roll.rollId}/export/${jobId}`,
      headers: bearer(roll.hostToken),
    });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toEqual({ status: 'done' });

    const key = exportObjectKey(roll.rollId, jobId);
    expect(key).toBe(`rolls/${roll.rollId}/derived/exports/${jobId}.zip`);
    await app.s3.send(
      new PutObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: key,
        Body: Buffer.from('PK not really a zip'),
        ContentType: 'application/zip',
      }),
    );
    storedKeys.push(key);

    const res = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${roll.rollId}/export/${jobId}`,
      headers: bearer(roll.hostToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; url?: string }>();
    expect(body.status).toBe('done');
    expect(body.url).toBeDefined();

    const signed = new URL(body.url ?? '');
    expect(signed.pathname).toContain(key);
    expect(signed.searchParams.get('X-Amz-Expires')).toBe(String(EXPORT_URL_TTL_SECONDS));
    expect(EXPORT_URL_TTL_SECONDS).toBe(24 * 60 * 60);

    // The link works, which is the only proof that matters.
    const fetched = await fetch(signed);
    expect(fetched.status).toBe(200);
  });

  it("404s a job id that belongs to a different roll", async () => {
    const mine = await createRoll('Export mine');
    const other = await createRoll('Export other');

    const created = await app.inject({
      method: 'POST',
      url: `/api/host/rolls/${other.rollId}/export`,
      headers: bearer(other.hostToken),
    });
    const { jobId } = created.json<{ jobId: string }>();
    exportJobIds.push(jobId);

    const res = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${mine.rollId}/export/${jobId}`,
      headers: bearer(mine.hostToken),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('EXPORT_JOB_NOT_FOUND');
  });
});

/* ------------------------------------------------------------- dashboard -- */

describe('GET /api/host/rolls/:rollId — the dashboard numbers (03 §10)', () => {
  it('counts the guests watching right now and prunes the ones that stopped', async () => {
    const roll = await createRoll();

    await touchRollViewer(app.redis, roll.rollId, 'guest-a');
    await touchRollViewer(app.redis, roll.rollId, 'guest-b');

    const res = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${roll.rollId}`,
      headers: bearer(roll.hostToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ guests: number }>().guests).toBe(2);

    // Age one of them past the staleness window; the count must drop.
    await app.redis.zadd(
      `roll:${roll.rollId}:viewers`,
      Date.now() - VIEWER_STALE_MS - 1_000,
      'guest-a',
    );
    const after = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${roll.rollId}`,
      headers: bearer(roll.hostToken),
    });
    expect(after.json<{ guests: number }>().guests).toBe(1);
  });

  it('keeps captures/pending/hidden honest across a hide and a delete', async () => {
    const roll = await createRoll();
    const visible = await insertCapture(roll.rollId);
    const pending = await insertCapture(roll.rollId, { status: 'uploading' });
    const doomed = await insertCapture(roll.rollId);

    const counts = async (): Promise<Record<string, number>> => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/host/rolls/${roll.rollId}`,
        headers: bearer(roll.hostToken),
      });
      expect(res.statusCode).toBe(200);
      return res.json<{ counts: Record<string, number> }>().counts;
    };

    expect(await counts()).toEqual({ captures: 3, pending: 1, hidden: 0 });

    await app.inject({
      method: 'POST',
      url: `/api/host/captures/${visible}/hide`,
      headers: bearer(roll.hostToken),
    });
    expect(await counts()).toEqual({ captures: 3, pending: 1, hidden: 1 });

    await app.inject({
      method: 'DELETE',
      url: `/api/host/captures/${doomed}`,
      headers: bearer(roll.hostToken),
    });
    // A trashed capture leaves every dashboard number: the host's own view of
    // the roll is "what is not in the bin".
    expect(await counts()).toEqual({ captures: 2, pending: 1, hidden: 1 });

    void pending;
  });
});
