import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { loadConfig, type ApiConfig } from '../src/config';
import { newId } from '../src/ids';
import { originalKey } from '../src/uploads/objectKeys';
import * as schema from '../src/db/schema';

/**
 * `POST /api/rolls/:slug/captures/:captureId/renders` (issue #79) — the lazy
 * render request behind SAVE WIGGLE and the social formats. Same house rules as
 * the other API suites: the dev stack must be up and migrated.
 *
 * The assertions stop at the `processing_events` log rather than the finished
 * bytes: a dev worker may be draining the shared queue while this suite runs,
 * so a row's `status` — and whether a BullMQ entry still exists — is not this
 * suite's to pin. What IS pinned: the route's answers, and that a row for the
 * right job appears exactly once.
 */
const RUN = randomBytes(4).toString('hex');

const config: ApiConfig = loadConfig();
const app: FastifyInstance = buildServer(config);

const SERIAL = `KD4-T79-${RUN}`;
const createdRollIds: string[] = [];
let device: { deviceId: string; deviceToken: string };

interface CreatedRollResponse {
  rollId: string;
  slug: string;
}

async function createRoll(body: Record<string, unknown> = {}): Promise<CreatedRollResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/host/rolls',
    payload: { title: `Renders roll ${RUN}`, ...body },
  });
  expect(res.statusCode).toBe(201);
  const created = res.json<CreatedRollResponse>();
  createdRollIds.push(created.rollId);
  return created;
}

async function insertCapture(rollId: string, mode = 'wiggle'): Promise<string> {
  const captureId = newId('cap');
  await app.db.insert(schema.captures).values({
    id: captureId,
    captureUuid: randomUUID(),
    rollId,
    deviceId: device.deviceId,
    mode,
    capturedAt: new Date(),
    frameCount: mode === 'single' ? 1 : 4,
    resolution: '1600x1200',
    status: 'ready',
    visible: true,
  });
  await app.db.insert(schema.assets).values(
    Array.from({ length: mode === 'single' ? 1 : 4 }, (_unused, index) => ({
      id: newId('asset'),
      captureId,
      role: 'original-frame',
      frameIndex: index + 1,
      mime: 'image/jpeg',
      width: 1600,
      height: 1200,
      bytes: 1024,
      objectKey: originalKey(rollId, captureId, index + 1),
      status: 'ready',
    })),
  );
  return captureId;
}

async function requestRender(
  slug: string,
  captureId: string,
  role: unknown,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/rolls/${slug}/captures/${captureId}/renders`,
    payload: { role },
  });
  return { statusCode: res.statusCode, body: res.json<Record<string, unknown>>() };
}

async function eventRowsFor(captureId: string, job: string): Promise<{ status: string }[]> {
  return app.db
    .select({ status: schema.processingEvents.status })
    .from(schema.processingEvents)
    .where(
      and(
        eq(schema.processingEvents.captureId, captureId),
        eq(schema.processingEvents.job, job),
      ),
    );
}

beforeAll(async () => {
  await app.ready();

  const tables = await app.db.execute<{ table_name: string }>(sql`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('captures', 'assets', 'rolls', 'processing_events')
  `);
  if (Array.from(tables).length < 4) {
    throw new Error(
      'Database is not migrated. Run `npm run db:migrate -w @kino/api` and re-run the tests.',
    );
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
  }
  await app.db.delete(schema.devices).where(eq(schema.devices.serial, SERIAL));
  await app.close();
}, 60_000);

describe('POST /api/rolls/:slug/captures/:captureId/renders', () => {
  it('202s a social render and logs exactly one processing row for the shared job', async () => {
    const roll = await createRoll();
    const captureId = await insertCapture(roll.rollId);

    const first = await requestRender(roll.slug, captureId, 'social-9x16');
    expect(first.statusCode).toBe(202);
    expect(first.body['job']).toBe('render-social-formats');
    expect(first.body['role']).toBe('social-9x16');

    // A second format rides the same job: still 202, still one queued row —
    // the partial unique index and the jobKey both collapse it.
    const second = await requestRender(roll.slug, captureId, 'social-1x1');
    expect(second.statusCode).toBe(202);
    expect(second.body['job']).toBe('render-social-formats');

    const rows = await eventRowsFor(captureId, 'render-social-formats');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // Exactly one enqueue happened. Later rows (running/failed from a live dev
    // worker) may exist; a SECOND queued row must not.
    expect(rows.filter((row) => row.status === 'queued').length).toBeLessThanOrEqual(1);
  });

  it('202s a wiggle MP4 render for a wiggle capture', async () => {
    const roll = await createRoll();
    const captureId = await insertCapture(roll.rollId);

    const res = await requestRender(roll.slug, captureId, 'wiggle-mp4');
    expect(res.statusCode).toBe(202);
    expect(res.body['job']).toBe('render-wiggle-mp4');
    expect((await eventRowsFor(captureId, 'render-wiggle-mp4')).length).toBeGreaterThanOrEqual(1);
  });

  it('refuses a wiggle MP4 for a capture that is not a wiggle', async () => {
    const roll = await createRoll();
    const captureId = await insertCapture(roll.rollId, 'single');

    const res = await requestRender(roll.slug, captureId, 'wiggle-mp4');
    expect(res.statusCode).toBe(409);
    expect(res.body['code']).toBe('NOT_A_WIGGLE');
    expect(await eventRowsFor(captureId, 'render-wiggle-mp4')).toEqual([]);
  });

  it('refuses every render when the host turned downloads off', async () => {
    const roll = await createRoll({ downloadsEnabled: false });
    const captureId = await insertCapture(roll.rollId);

    const res = await requestRender(roll.slug, captureId, 'social-4x5');
    expect(res.statusCode).toBe(403);
    expect(res.body['code']).toBe('DOWNLOADS_DISABLED');
    expect(await eventRowsFor(captureId, 'render-social-formats')).toEqual([]);
  });

  it('400s a role that is not renderable', async () => {
    const roll = await createRoll();
    const captureId = await insertCapture(roll.rollId);

    for (const role of ['thumb', 'original-frame', '', 42, null]) {
      const res = await requestRender(roll.slug, captureId, role);
      expect(res.statusCode).toBe(400);
      expect(res.body['code']).toBe('ROLE_NOT_RENDERABLE');
    }
  });

  it('404s a capture that does not exist on this roll', async () => {
    const roll = await createRoll();
    const other = await createRoll();
    const foreign = await insertCapture(other.rollId);

    for (const captureId of ['cap_never_real', foreign]) {
      const res = await requestRender(roll.slug, captureId, 'social-1x1');
      expect(res.statusCode).toBe(404);
      expect(res.body['code']).toBe('CAPTURE_NOT_FOUND');
    }
  });
});
