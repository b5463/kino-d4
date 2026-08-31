import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { loadConfig, type ApiConfig } from '../src/config';
import { newId } from '../src/ids';
import { derivedKey } from '../src/uploads/objectKeys';
import { readRollHistory } from '../src/events/publish';
import { jobKeyFor } from '../src/uploads/uploads';
import { createProcessingQueue, jobKeyToJobId } from '../src/queue/producer';
import * as schema from '../src/db/schema';

/**
 * `PATCH /api/host/captures/:captureId/playback` (audit #59), against the real
 * database and Redis — same house rules as `moderation.test.ts`.
 *
 * A live dev worker may be draining the shared queue while this runs, so
 * nothing here asserts BullMQ state or that a `processing_events` row is still
 * `queued`: the durable claim the route makes is the ROW — one enqueue per
 * (capture, job) — and the row is what is asserted, whatever status the live
 * worker has moved it to by the time we read it.
 */
const RUN = randomBytes(4).toString('hex');

const config: ApiConfig = loadConfig();
const app: FastifyInstance = buildServer(config);

const SERIAL = `KD4-T59A-${RUN}`;

const createdRollIds: string[] = [];
/** Every jobKey this suite may have queued, for BullMQ teardown. */
const queuedJobKeys: string[] = [];

let device: { deviceId: string; deviceToken: string };

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

interface CreatedRollResponse {
  rollId: string;
  slug: string;
  hostToken: string;
}

async function createRoll(): Promise<CreatedRollResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/host/rolls',
    payload: { title: `Playback roll ${RUN}` },
  });
  expect(res.statusCode).toBe(201);
  const created = res.json<CreatedRollResponse>();
  createdRollIds.push(created.rollId);
  return created;
}

async function insertCapture(rollId: string, mode = 'wiggle'): Promise<string> {
  const id = newId('cap');
  await app.db.insert(schema.captures).values({
    id,
    captureUuid: randomUUID(),
    rollId,
    deviceId: device.deviceId,
    mode,
    capturedAt: new Date(),
    frameCount: 4,
    resolution: '1600x1200',
    status: 'ready',
  });
  queuedJobKeys.push(jobKeyFor(id, 'render-wiggle-webp'), jobKeyFor(id, 'render-wiggle-mp4'));
  return id;
}

/** A ready `wiggle-mp4` row, so the capture counts as "MP4 already exists". */
async function insertMp4(rollId: string, captureId: string): Promise<void> {
  await app.db.insert(schema.assets).values({
    id: newId('asset'),
    captureId,
    role: 'wiggle-mp4',
    frameIndex: null,
    mime: 'video/mp4',
    width: 960,
    height: 720,
    bytes: 100_000,
    sha256: null,
    objectKey: derivedKey(rollId, captureId, 'wiggle.mp4'),
    status: 'ready',
  });
}

async function patchPlayback(
  captureId: string,
  hostToken: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: { captureId?: string; playback?: unknown; code?: string } }> {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/host/captures/${captureId}/playback`,
    headers: bearer(hostToken),
    payload,
  });
  return { statusCode: res.statusCode, body: res.json() };
}

async function storedPlayback(captureId: string): Promise<unknown> {
  const [row] = await app.db
    .select({ playback: schema.captures.playback })
    .from(schema.captures)
    .where(eq(schema.captures.id, captureId));
  return row?.playback ?? null;
}

/** The jobs this capture has ever had enqueue rows for, whatever their state. */
async function enqueuedJobs(captureId: string): Promise<string[]> {
  const rows = await app.db
    .selectDistinct({ job: schema.processingEvents.job })
    .from(schema.processingEvents)
    .where(eq(schema.processingEvents.captureId, captureId));
  return rows.map((row) => row.job).sort();
}

beforeAll(async () => {
  await app.ready();
  const tables = await app.db.execute<{ table_name: string }>(sql`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_name in ('captures', 'processing_events')
  `);
  if (Array.from(tables).length < 2) {
    throw new Error('Database is not migrated. Run `npm run db:migrate -w @kino/api` first.');
  }

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
  if (createdRollIds.length > 0) {
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
    await app.db.delete(schema.auditEvents).where(inArray(schema.auditEvents.rollId, createdRollIds));
    await app.db.delete(schema.rollDevices).where(inArray(schema.rollDevices.rollId, createdRollIds));
    await app.db.delete(schema.rolls).where(inArray(schema.rolls.id, createdRollIds));

    await app.redis.del(
      ...createdRollIds.flatMap((id) => [`roll:${id}:stream`, `roll:${id}:events`]),
    );
  }
  await app.db.delete(schema.devices).where(eq(schema.devices.serial, SERIAL));

  // The renders this suite queued point at captures that no longer exist;
  // remove them so the live worker does not spin on MissingCaptureError.
  if (queuedJobKeys.length > 0) {
    const queue = createProcessingQueue(config);
    try {
      await Promise.all(
        queuedJobKeys.map(async (jobKey) => {
          try {
            await queue.remove(jobKeyToJobId(jobKey));
          } catch {
            /* active or already gone; teardown must not fail on it */
          }
        }),
      );
    } finally {
      await queue.close();
    }
  }

  await app.close();
}, 60_000);

describe('PATCH /api/host/captures/:captureId/playback', () => {
  it('persists the choice, re-enqueues the WebP render, and announces the change', async () => {
    const roll = await createRoll();
    const captureId = await insertCapture(roll.rollId);

    const { statusCode, body } = await patchPlayback(captureId, roll.hostToken, {
      fps: 12,
      loop: 'continuous',
      direction: 'rtl',
    });
    expect(statusCode).toBe(200);
    expect(body).toEqual({
      captureId,
      playback: { fps: 12, loop: 'continuous', direction: 'rtl' },
    });

    expect(await storedPlayback(captureId)).toEqual({
      fps: 12,
      loop: 'continuous',
      direction: 'rtl',
    });

    // The WebP render was enqueued; the MP4 was not — no such asset exists yet.
    expect(await enqueuedJobs(captureId)).toEqual(['render-wiggle-webp']);

    // Guests were told to re-fetch.
    const events = await readRollHistory(app.redis, roll.rollId, '0-0');
    expect(events.map((entry) => entry.event)).toContainEqual({
      type: 'capture.updated',
      captureId,
    });

    // The stored choice rides the host feed and the guest views.
    const hostRes = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${roll.rollId}/captures`,
      headers: bearer(roll.hostToken),
    });
    expect(hostRes.statusCode).toBe(200);
    const listed = hostRes
      .json<{ items: { captureId: string; playback: unknown }[] }>()
      .items.find((item) => item.captureId === captureId);
    expect(listed?.playback).toEqual({ fps: 12, loop: 'continuous', direction: 'rtl' });

    const guestRes = await app.inject({
      method: 'GET',
      url: `/api/rolls/${roll.slug}/captures/${captureId}`,
    });
    expect(guestRes.statusCode).toBe(200);
    expect(guestRes.json<{ playback: unknown }>().playback).toEqual({
      fps: 12,
      loop: 'continuous',
      direction: 'rtl',
    });
  });

  it('re-enqueues the MP4 render only when that asset already exists', async () => {
    const roll = await createRoll();
    const captureId = await insertCapture(roll.rollId);
    await insertMp4(roll.rollId, captureId);

    const { statusCode } = await patchPlayback(captureId, roll.hostToken, { fps: 8 });
    expect(statusCode).toBe(200);

    expect(await enqueuedJobs(captureId)).toEqual(['render-wiggle-mp4', 'render-wiggle-webp']);
  });

  it('replaces the stored choice whole, not merged', async () => {
    const roll = await createRoll();
    const captureId = await insertCapture(roll.rollId);

    await patchPlayback(captureId, roll.hostToken, { fps: 6, loop: 'sweep' });
    const { body } = await patchPlayback(captureId, roll.hostToken, { fps: 9 });

    // The earlier loop choice is gone — back to the renderer's default.
    expect(body.playback).toEqual({ fps: 9 });
    expect(await storedPlayback(captureId)).toEqual({ fps: 9 });
  });

  it('refuses vocabulary the KDP contract does not have', async () => {
    const roll = await createRoll();
    const captureId = await insertCapture(roll.rollId);

    for (const payload of [
      { loop: 'boomerang' }, // not a WiggleLoop
      { loop: 'once' }, // @kino/media's word, not KDP's
      { direction: 'down' },
      { fps: 30 }, // outside 5–15
      { fps: 9.5 }, // not an integer
      { speed: 10 }, // unknown field
    ]) {
      const { statusCode } = await patchPlayback(captureId, roll.hostToken, payload);
      expect(statusCode).toBe(400);
    }

    // Nothing was persisted and nothing was queued by the refusals.
    expect(await storedPlayback(captureId)).toBeNull();
    expect(await enqueuedJobs(captureId)).toEqual([]);
  });

  it('does not queue wiggle renders for a non-wiggle capture', async () => {
    const roll = await createRoll();
    const captureId = await insertCapture(roll.rollId, 'quad');

    const { statusCode } = await patchPlayback(captureId, roll.hostToken, { fps: 7 });
    expect(statusCode).toBe(200);

    expect(await storedPlayback(captureId)).toEqual({ fps: 7 });
    expect(await enqueuedJobs(captureId)).toEqual([]);
  });

  it("refuses another roll's host token", async () => {
    const rollA = await createRoll();
    const rollB = await createRoll();
    const captureId = await insertCapture(rollA.rollId);

    const { statusCode } = await patchPlayback(captureId, rollB.hostToken, { fps: 10 });
    expect(statusCode).toBeGreaterThanOrEqual(401);
    expect(statusCode).toBeLessThanOrEqual(404);
    expect(await storedPlayback(captureId)).toBeNull();
  });
});
