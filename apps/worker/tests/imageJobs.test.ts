import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { UnrecoverableError } from 'bullmq';
import sharp from 'sharp';
import { loadWorkerConfig, type WorkerConfig } from '../src/config';
import { createJobRuntime, type JobRuntime } from '../src/context';
import { createJobQueue, jobKeyToJobId, type JobQueue, type JobQueueOptions } from '../src/queue';
import { assets, processingEvents } from '../src/db/schema';
import { registerImageHandlers } from '../src/jobs';
import { generateThumbnail } from '../src/jobs/thumbnail';
import { generateGalleryStill } from '../src/jobs/galleryStill';
import {
  CONTACT_SHEET_CELL_WIDTH,
  CONTACT_SHEET_GUTTER,
  contactSheetWidth,
  renderContactSheet,
} from '../src/jobs/contactSheet';
import { extractMetadata } from '../src/jobs/metadata';
import { renderSocialFormats } from '../src/jobs/socialFormats';
import { MissingCaptureError } from '../src/jobs/capture';
import { aiEnhance, ENHANCED_ROLES } from '../src/jobs/aiEnhance';
import {
  GALLERY_STILL_WIDTH,
  SOCIAL_1X1,
  SOCIAL_4X5,
  SOCIAL_9X16,
  THUMBNAIL_QUALITY,
  THUMBNAIL_WIDTH,
} from '../src/images/sizes';
import { rollStreamKey } from '../src/events/publish';

/**
 * Task 23's image jobs, against a real Redis, a real database and real MinIO —
 * the dev stack must be up AND migrated:
 *
 *   docker compose -f infra/docker-compose.dev.yml up -d
 *   npm run db:migrate -w @kino/api
 *
 * These are the first handlers that produce bytes, so the assertions are about
 * the bytes: a thumbnail's actual width and format read back out of storage, a
 * contact sheet's actual geometry, an EXIF block that survived a round trip.
 * Nothing here trusts a handler's own account of what it wrote.
 *
 * The frames are the committed fixtures in `packages/test-fixtures/media/` at
 * the real D4 frame size (01 §2), each carrying a white marker bar at a
 * position that encodes its camera index — which is how a test proves *which*
 * frame a handler chose rather than assuming it read the filename it was given.
 */
const RUN = randomBytes(4).toString('hex');

const TEST_PREFIX = `kino-jobs-test-${RUN}`;

const config: WorkerConfig = loadWorkerConfig();

let runtime: JobRuntime;

/**
 * An UNGUARDED client, for seeding `original/` frames.
 *
 * `runtime.ctx.s3` refuses every write under `original/` (01 §7) and that is
 * the property Task 22 tests. Originals are written by the API on a device's
 * behalf, so a test that plays the device's part needs a client that is not the
 * worker's.
 */
let seeder: S3Client;

const deviceId = `dev_t23_${RUN}`;
const rollId = `roll_t23_${RUN}`;
const captureIds: string[] = [];
const writtenKeys: string[] = [];

const queues: JobQueue[] = [];

const FIXTURE_DIR = new URL('../../../packages/test-fixtures/media/', import.meta.url);

/** The fixtures, read once — four 1600×1200 JPEGs, one per camera. */
const FRAME_COUNT = 4;
const frames: Buffer[] = [];

function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function newQueue(overrides: Partial<JobQueueOptions> = {}): JobQueue {
  const queue = createJobQueue({
    connection: { url: config.REDIS_URL },
    prefix: TEST_PREFIX,
    name: `t23-${RUN}-${queues.length}`,
    attempts: 1,
    backoffDelay: 5,
    ...overrides,
  });
  queues.push(queue);
  return queue;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  what: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 25_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/* --------------------------------------------------------------- fixtures -- */

function originalKeyFor(captureId: string, frameIndex: number): string {
  const cam = String(frameIndex).padStart(2, '0');
  return `rolls/${rollId}/captures/${captureId}/original/cam-${cam}.jpg`;
}

interface NewCaptureOptions {
  frameCount?: number;
  mode?: string;
  look?: string | null;
  /** Frames to seed, 1-based. Defaults to every frame of `frameCount`. */
  frameIndexes?: number[];
}

/**
 * A capture with its original frames in MinIO and its asset rows in the
 * database — the state a worker actually meets after capture-complete.
 */
async function newCapture(options: NewCaptureOptions = {}): Promise<string> {
  const frameCount = options.frameCount ?? FRAME_COUNT;
  const captureId = `cap_t23_${RUN}_${captureIds.length}`;
  captureIds.push(captureId);

  await runtime.ctx.db.execute(sql`
    insert into captures
      (id, capture_uuid, roll_id, device_id, mode, look, captured_at, frame_count, resolution, timing, status)
    values
      (${captureId}, ${randomUUID()}, ${rollId}, ${deviceId}, ${options.mode ?? 'wiggle'},
       ${options.look ?? null}, '2026-08-18T12:00:00Z', ${frameCount}, '1600x1200',
       ${sql`${JSON.stringify({
         gpioTriggerSkewUs: 42,
         vsyncPhaseSkewUs: null,
         effectiveExposureSkewUs: null,
         unavailableReason: 'test fixture',
       })}::jsonb`},
       'processing')
  `);

  for (const frameIndex of options.frameIndexes ?? range(1, frameCount)) {
    const body = frames[(frameIndex - 1) % frames.length];
    if (body === undefined) throw new Error(`no fixture for frame ${frameIndex}`);
    await seedAsset(captureId, {
      role: 'original-frame',
      frameIndex,
      mime: 'image/jpeg',
      key: originalKeyFor(captureId, frameIndex),
      body,
      width: 1600,
      height: 1200,
    });
  }

  return captureId;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
}

interface SeedAssetOptions {
  role: string;
  frameIndex?: number | null;
  mime: string;
  key: string;
  body: Buffer;
  width?: number;
  height?: number;
  status?: string;
}

/** Writes the object with the unguarded client and the row the API would write. */
async function seedAsset(captureId: string, options: SeedAssetOptions): Promise<void> {
  await seeder.send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: options.key,
      Body: options.body,
      ContentType: options.mime,
    }),
  );
  writtenKeys.push(options.key);

  await runtime.ctx.db.insert(assets).values({
    id: `asset_t23_${RUN}_${writtenKeys.length}`,
    captureId,
    role: options.role,
    frameIndex: options.frameIndex ?? null,
    mime: options.mime,
    width: options.width ?? null,
    height: options.height ?? null,
    bytes: options.body.length,
    sha256: sha256Hex(options.body),
    objectKey: options.key,
    status: options.status ?? 'ready',
  });
}

/* ----------------------------------------------------------------- reads -- */

async function assetRows(
  captureId: string,
): Promise<
  {
    role: string;
    status: string;
    mime: string;
    width: number | null;
    height: number | null;
    bytes: number | null;
    sha256: string | null;
    objectKey: string;
  }[]
> {
  return runtime.ctx.db
    .select({
      role: assets.role,
      status: assets.status,
      mime: assets.mime,
      width: assets.width,
      height: assets.height,
      bytes: assets.bytes,
      sha256: assets.sha256,
      objectKey: assets.objectKey,
    })
    .from(assets)
    .where(eq(assets.captureId, captureId))
    .orderBy(asc(assets.role), asc(assets.frameIndex));
}

async function assetsWithRole(
  captureId: string,
  role: string,
): Promise<Awaited<ReturnType<typeof assetRows>>> {
  return (await assetRows(captureId)).filter((row) => row.role === role);
}

async function objectBytes(key: string): Promise<Buffer> {
  const stream = await runtime.ctx.getObject(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

async function eventsFor(captureId: string): Promise<{ job: string; status: string }[]> {
  return runtime.ctx.db
    .select({ job: processingEvents.job, status: processingEvents.status })
    .from(processingEvents)
    .where(eq(processingEvents.captureId, captureId))
    .orderBy(asc(processingEvents.at), asc(processingEvents.id));
}

function statusesOf(rows: { job: string; status: string }[], job: string): string[] {
  return rows.filter((row) => row.job === job).map((row) => row.status);
}

/** Every `processing.completed` role announced on the roll's stream (05 §10). */
async function publishedRoles(captureId: string): Promise<string[]> {
  const entries = await runtime.ctx.redis.xrange(rollStreamKey(rollId), '-', '+');
  const roles: string[] = [];
  for (const [, fields] of entries) {
    for (let i = 0; i + 1 < fields.length; i += 2) {
      if (fields[i] !== 'event') continue;
      const raw = fields[i + 1];
      if (raw === undefined) continue;
      const event = JSON.parse(raw) as { type?: string; captureId?: string; role?: string };
      if (event.type === 'processing.completed' && event.captureId === captureId) {
        roles.push(event.role ?? '');
      }
    }
  }
  return roles;
}

/**
 * Which camera a rendered image came from, read out of the pixels.
 *
 * Each fixture carries a white marker bar at a position that encodes its index,
 * so sampling the bright column of a derivative names the source frame. This is
 * the difference between "a thumbnail exists" and "the thumbnail is of the frame
 * the rule says it should be".
 */
async function markerFrameIndex(image: Buffer): Promise<number> {
  const { data, info } = await sharp(image)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // The marker sits at 400..800 of 1200 rows in the source; sample the middle
  // row, which is inside it at every scale.
  const row = Math.floor(info.height / 2);
  let best = -1;
  let bestX = -1;
  for (let x = 0; x < info.width; x += 1) {
    const at = (row * info.width + x) * info.channels;
    const sum = (data[at] ?? 0) + (data[at + 1] ?? 0) + (data[at + 2] ?? 0);
    if (sum > best) {
      best = sum;
      bestX = x;
    }
  }
  // Invert the fixture's `markerLeft`: 120 + (i - 1) * 340, in source pixels,
  // scaled to this image's width.
  const sourceX = (bestX / info.width) * 1600;
  return Math.round((sourceX - 120 - 80) / 340) + 1;
}

/* ------------------------------------------------------------- lifecycle -- */

beforeAll(async () => {
  runtime = createJobRuntime(config);
  seeder = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
  });

  for (let frameIndex = 1; frameIndex <= FRAME_COUNT; frameIndex += 1) {
    const name = `frame-${String(frameIndex).padStart(2, '0')}.jpg`;
    frames.push(await readFile(fileURLToPath(new URL(name, FIXTURE_DIR))));
  }

  const tables = await runtime.ctx.db.execute<{ table_name: string }>(sql`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('captures', 'assets', 'processing_events')
  `);
  if (Array.from(tables).length < 3) {
    throw new Error(
      'Database is not migrated: captures/assets/processing_events missing. ' +
        'Run `npm run db:migrate -w @kino/api` against DATABASE_URL and re-run the tests.',
    );
  }

  await runtime.ctx.db.execute(sql`
    insert into devices (id, serial, product, hardware_revision, token_hash)
    values (${deviceId}, ${`KD4-T23-${RUN}`}, 'KINO D4', 'v1', ${`hash_${RUN}`})
  `);
  await runtime.ctx.db.execute(sql`
    insert into rolls (id, slug, title, host_token_hash, created_by_device_id)
    values (${rollId}, ${`T23${RUN.toUpperCase()}`}, ${`Image roll ${RUN}`}, ${`hash_${RUN}`}, ${deviceId})
  `);
});

afterEach(async () => {
  for (const queue of queues.splice(0)) {
    await queue.obliterate();
    await queue.close();
  }
});

afterAll(async () => {
  for (const key of writtenKeys) {
    try {
      await seeder.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
    } catch {
      /* a leftover test object costs a few KB; a failed teardown costs the suite */
    }
  }
  seeder.destroy();

  await runtime.ctx.redis.del(rollStreamKey(rollId));
  await runtime.ctx.db.execute(sql`delete from processing_events where capture_id like ${`cap_t23_${RUN}%`}`);
  await runtime.ctx.db.execute(sql`delete from assets where capture_id like ${`cap_t23_${RUN}%`}`);
  await runtime.ctx.db.execute(sql`delete from captures where roll_id = ${rollId}`);
  await runtime.ctx.db.execute(sql`delete from rolls where id = ${rollId}`);
  await runtime.ctx.db.execute(sql`delete from devices where id = ${deviceId}`);

  await runtime.close();
});

/* --------------------------------------------------------- the handlers -- */

describe('generate-thumbnail', () => {
  it('writes a 480 px WebP of the middle frame, with a ready asset row and an event', async () => {
    const captureId = await newCapture();
    const jobKey = `${captureId}:generate-thumbnail`;

    await generateThumbnail({ captureId, jobKey }, runtime.ctx);

    const [row] = await assetsWithRole(captureId, 'thumb');
    expect(row).toBeDefined();
    expect(row?.status).toBe('ready');
    expect(row?.mime).toBe('image/webp');
    expect(row?.objectKey).toBe(`rolls/${rollId}/captures/${captureId}/derived/thumb.webp`);
    if (row !== undefined) writtenKeys.push(row.objectKey);

    const body = await objectBytes(row?.objectKey ?? '');
    const meta = await sharp(body).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(THUMBNAIL_WIDTH);
    expect(THUMBNAIL_WIDTH).toBe(480);
    // 1600×1200 at 480 wide is 360 tall: the aspect ratio is preserved, never
    // cropped — a thumbnail that lied about the frame's shape would misplace
    // every tile in the guest feed.
    expect(meta.height).toBe(360);

    // The row is a description of these exact bytes, not of the plan.
    expect(row?.bytes).toBe(body.length);
    expect(row?.sha256).toBe(sha256Hex(body));
    expect(row?.width).toBe(meta.width);
    expect(row?.height).toBe(meta.height);

    expect(await publishedRoles(captureId)).toEqual(['thumb']);
  });

  it('takes the frame at floor(frameCount / 2) when no still was uploaded', async () => {
    // Four frames → frame 2, the centre-ish viewpoint (CAM2 is also the
    // metering camera on the V1 rig).
    const captureId = await newCapture();
    await generateThumbnail({ captureId, jobKey: `${captureId}:generate-thumbnail` }, runtime.ctx);

    const [row] = await assetsWithRole(captureId, 'thumb');
    if (row !== undefined) writtenKeys.push(row.objectKey);
    expect(await markerFrameIndex(await objectBytes(row?.objectKey ?? ''))).toBe(2);
  });

  it('prefers a kino-still the device uploaded over any original frame', async () => {
    const captureId = await newCapture();
    // A still that is unmistakably frame 4, so the source rule is observable.
    const still = frames[3];
    if (still === undefined) throw new Error('missing fixture');
    await seedAsset(captureId, {
      role: 'kino-still',
      mime: 'image/jpeg',
      key: `rolls/${rollId}/captures/${captureId}/derived/still-device.jpg`,
      body: still,
      width: 1600,
      height: 1200,
    });

    await generateThumbnail({ captureId, jobKey: `${captureId}:generate-thumbnail` }, runtime.ctx);

    const [row] = await assetsWithRole(captureId, 'thumb');
    if (row !== undefined) writtenKeys.push(row.objectKey);
    expect(await markerFrameIndex(await objectBytes(row?.objectKey ?? ''))).toBe(4);
  });

  it('ignores the gallery job own output and reads the frame (order independence)', async () => {
    /**
     * Both jobs are queued by the same capture-complete, so BullMQ decides which
     * runs first. `generate-gallery-still` writes role `kino-still` at
     * `derived/still.webp`; if the thumbnail counted that as an uploaded still,
     * it would re-encode a 1280 px WebP q82 down to 480 px q70 — WebP→WebP
     * generation loss — and its bytes would depend on who won the race. Jobs that
     * are idempotent (03 §19) cannot have order-dependent output.
     *
     * The discriminator is the *bytes*: a thumbnail derived from the frame and one
     * derived from the still are both 480 px WebP of camera 2, so nothing about
     * their dimensions or their marker pixel tells them apart.
     */
    const captureId = await newCapture();

    // The adversarial order: the still exists before the thumbnail runs.
    await generateGalleryStill(
      { captureId, jobKey: `${captureId}:generate-gallery-still` },
      runtime.ctx,
    );
    const [still] = await assetsWithRole(captureId, 'kino-still');
    expect(still?.objectKey).toBe(`rolls/${rollId}/captures/${captureId}/derived/still.webp`);
    if (still !== undefined) writtenKeys.push(still.objectKey);

    await generateThumbnail({ captureId, jobKey: `${captureId}:generate-thumbnail` }, runtime.ctx);
    const [thumb] = await assetsWithRole(captureId, 'thumb');
    if (thumb !== undefined) writtenKeys.push(thumb.objectKey);
    const produced = await objectBytes(thumb?.objectKey ?? '');

    // What a thumbnail of the original middle frame is, encoded exactly as the
    // handler encodes it. Frame 2 of 4 = index 1 in the fixture array.
    const fromFrame = await sharp(frames[1])
      .rotate()
      .resize({ width: THUMBNAIL_WIDTH })
      .webp({ quality: THUMBNAIL_QUALITY })
      .toBuffer();

    expect(sha256Hex(produced)).toBe(sha256Hex(fromFrame));
    expect(thumb?.sha256).toBe(sha256Hex(fromFrame));
  });

  it('reads the frame even when the worker own still shows another camera', async () => {
    // The same rule stated so it cannot pass by coincidence: a still at the
    // gallery job's own key, holding camera 4, must not become the thumbnail's
    // source. If it did, the marker would read 4 instead of 2.
    const captureId = await newCapture();
    const other = frames[3];
    if (other === undefined) throw new Error('missing fixture');

    await seedAsset(captureId, {
      role: 'kino-still',
      mime: 'image/webp',
      key: `rolls/${rollId}/captures/${captureId}/derived/still.webp`,
      body: await sharp(other).resize({ width: GALLERY_STILL_WIDTH }).webp().toBuffer(),
      width: GALLERY_STILL_WIDTH,
      height: 960,
    });

    await generateThumbnail({ captureId, jobKey: `${captureId}:generate-thumbnail` }, runtime.ctx);
    const [thumb] = await assetsWithRole(captureId, 'thumb');
    if (thumb !== undefined) writtenKeys.push(thumb.objectKey);
    expect(await markerFrameIndex(await objectBytes(thumb?.objectKey ?? ''))).toBe(2);
  });

  it('produces one asset row however many times it runs (05 §9)', async () => {
    const captureId = await newCapture();
    const payload = { captureId, jobKey: `${captureId}:generate-thumbnail` };

    await generateThumbnail(payload, runtime.ctx);
    const first = await assetsWithRole(captureId, 'thumb');
    await generateThumbnail(payload, runtime.ctx);
    const second = await assetsWithRole(captureId, 'thumb');

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // Same key, same digest: a rerun rewrites the derivative in place rather
    // than growing a second row the feed would have to choose between.
    expect(second[0]?.objectKey).toBe(first[0]?.objectKey);
    expect(second[0]?.sha256).toBe(first[0]?.sha256);
    if (first[0] !== undefined) writtenKeys.push(first[0].objectKey);
  });
});

describe('generate-gallery-still', () => {
  it('writes a 1280 px WebP still with a ready asset row', async () => {
    const captureId = await newCapture();
    await generateGalleryStill(
      { captureId, jobKey: `${captureId}:generate-gallery-still` },
      runtime.ctx,
    );

    const [row] = await assetsWithRole(captureId, 'kino-still');
    expect(row?.status).toBe('ready');
    expect(row?.mime).toBe('image/webp');
    expect(row?.objectKey).toBe(`rolls/${rollId}/captures/${captureId}/derived/still.webp`);
    if (row !== undefined) writtenKeys.push(row.objectKey);

    const meta = await sharp(await objectBytes(row?.objectKey ?? '')).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(GALLERY_STILL_WIDTH);
    expect(GALLERY_STILL_WIDTH).toBe(1280);
    expect(meta.height).toBe(960);
    expect(await publishedRoles(captureId)).toEqual(['kino-still']);
  });

  it('does nothing when the device already uploaded a kino-still (03 §4)', async () => {
    const captureId = await newCapture();
    const still = frames[0];
    if (still === undefined) throw new Error('missing fixture');
    const deviceKey = `rolls/${rollId}/captures/${captureId}/derived/still-device.jpg`;
    await seedAsset(captureId, {
      role: 'kino-still',
      mime: 'image/jpeg',
      key: deviceKey,
      body: still,
      width: 1600,
      height: 1200,
    });

    await generateGalleryStill(
      { captureId, jobKey: `${captureId}:generate-gallery-still` },
      runtime.ctx,
    );

    // Device previews take priority and workers fill gaps: the row is still the
    // device's, byte for byte, and no second still was written.
    const rows = await assetsWithRole(captureId, 'kino-still');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.objectKey).toBe(deviceKey);
    expect(rows[0]?.mime).toBe('image/jpeg');
    expect(rows[0]?.sha256).toBe(sha256Hex(still));
    // A skipped job announces nothing: there is no new derivative to fetch.
    expect(await publishedRoles(captureId)).toEqual([]);
  });
});

describe('render-social-formats', () => {
  it('writes all three crops at their exact social dimensions, as JPEG, with events', async () => {
    const captureId = await newCapture();
    await renderSocialFormats(
      { captureId, jobKey: `${captureId}:render-social-formats` },
      runtime.ctx,
    );

    for (const format of [SOCIAL_9X16, SOCIAL_4X5, SOCIAL_1X1]) {
      const [row] = await assetsWithRole(captureId, format.role);
      expect(row).toBeDefined();
      expect(row?.status).toBe('ready');
      expect(row?.mime).toBe('image/jpeg');
      expect(row?.objectKey).toBe(
        `rolls/${rollId}/captures/${captureId}/derived/${format.role}.jpg`,
      );
      if (row !== undefined) writtenKeys.push(row.objectKey);

      const body = await objectBytes(row?.objectKey ?? '');
      const meta = await sharp(body).metadata();
      expect(meta.format).toBe('jpeg');
      // The exact platform sizes, spelled out: story, portrait post, square.
      expect([meta.width, meta.height]).toEqual([format.width, format.height]);
      expect(row?.width).toBe(format.width);
      expect(row?.height).toBe(format.height);
      expect(row?.bytes).toBe(body.length);
      expect(row?.sha256).toBe(sha256Hex(body));
    }

    expect(SOCIAL_9X16.width).toBe(1080);
    expect(SOCIAL_9X16.height).toBe(1920);
    expect(SOCIAL_4X5.height).toBe(1350);
    expect(SOCIAL_1X1.height).toBe(1080);

    expect((await publishedRoles(captureId)).sort()).toEqual(
      ['social-1x1', 'social-4x5', 'social-9x16'].sort(),
    );
  });

  it('produces one row per format however many times it runs', async () => {
    const captureId = await newCapture();
    const payload = { captureId, jobKey: `${captureId}:render-social-formats` };

    await renderSocialFormats(payload, runtime.ctx);
    await renderSocialFormats(payload, runtime.ctx);

    for (const format of [SOCIAL_9X16, SOCIAL_4X5, SOCIAL_1X1]) {
      const rows = await assetsWithRole(captureId, format.role);
      expect(rows).toHaveLength(1);
      if (rows[0] !== undefined) writtenKeys.push(rows[0].objectKey);
    }
  });
});

describe('render-contact-sheet', () => {
  it('is n cells across with the gutters between them', async () => {
    const captureId = await newCapture();
    await renderContactSheet(
      { captureId, jobKey: `${captureId}:render-contact-sheet` },
      runtime.ctx,
    );

    const [row] = await assetsWithRole(captureId, 'contact-sheet');
    expect(row?.status).toBe('ready');
    expect(row?.mime).toBe('image/jpeg');
    expect(row?.objectKey).toBe(
      `rolls/${rollId}/captures/${captureId}/derived/contact-sheet.jpg`,
    );
    if (row !== undefined) writtenKeys.push(row.objectKey);

    const body = await objectBytes(row?.objectKey ?? '');
    const meta = await sharp(body).metadata();
    expect(meta.format).toBe('jpeg');
    // The geometry, spelled out rather than delegated: 4 cells of 320 with
    // three 8 px gutters between them.
    expect(meta.width).toBe(4 * 320 + 3 * 8);
    expect(meta.width).toBe(contactSheetWidth(4));
    expect(CONTACT_SHEET_CELL_WIDTH).toBe(320);
    expect(CONTACT_SHEET_GUTTER).toBe(8);
    // One row: the height is one 4:3 cell, not a grid.
    expect(meta.height).toBe(240);
    expect(row?.width).toBe(meta.width);
    expect(row?.height).toBe(meta.height);
    expect(await publishedRoles(captureId)).toEqual(['contact-sheet']);
  });

  it('lays the cameras out left to right in frame order', async () => {
    const captureId = await newCapture();
    await renderContactSheet(
      { captureId, jobKey: `${captureId}:render-contact-sheet` },
      runtime.ctx,
    );
    const [row] = await assetsWithRole(captureId, 'contact-sheet');
    if (row !== undefined) writtenKeys.push(row.objectKey);
    const sheet = await objectBytes(row?.objectKey ?? '');

    for (const frameIndex of [1, 2, 3, 4]) {
      const cell = await sharp(sheet)
        .extract({
          left: (frameIndex - 1) * (CONTACT_SHEET_CELL_WIDTH + CONTACT_SHEET_GUTTER),
          top: 0,
          width: CONTACT_SHEET_CELL_WIDTH,
          height: 240,
        })
        .jpeg()
        .toBuffer();
      expect(await markerFrameIndex(cell)).toBe(frameIndex);
    }
  });

  it('scales its width with the frame count', async () => {
    const captureId = await newCapture({ frameCount: 3, frameIndexes: [1, 2, 3] });
    await renderContactSheet(
      { captureId, jobKey: `${captureId}:render-contact-sheet` },
      runtime.ctx,
    );
    const [row] = await assetsWithRole(captureId, 'contact-sheet');
    if (row !== undefined) writtenKeys.push(row.objectKey);
    expect((await sharp(await objectBytes(row?.objectKey ?? '')).metadata()).width).toBe(
      3 * 320 + 2 * 8,
    );
  });

  it('labels each cell CAM1..CAMn in its bottom-left corner', async () => {
    const captureId = await newCapture();
    await renderContactSheet(
      { captureId, jobKey: `${captureId}:render-contact-sheet` },
      runtime.ctx,
    );
    const [row] = await assetsWithRole(captureId, 'contact-sheet');
    if (row !== undefined) writtenKeys.push(row.objectKey);
    const sheet = await objectBytes(row?.objectKey ?? '');

    // The label is white on a dark plate, drawn over flat fixture colour, so
    // "is there a label here" is answerable in pixels: the bottom-left corner
    // of every cell must contain both near-black plate and near-white glyph
    // pixels, and the same corner of the cell's top half must not.
    for (const frameIndex of [1, 2, 3, 4]) {
      const left = (frameIndex - 1) * (CONTACT_SHEET_CELL_WIDTH + CONTACT_SHEET_GUTTER);
      const corner = await inkCounts(sheet, { left: left + 2, top: 200, width: 90, height: 38 });
      expect(corner.dark).toBeGreaterThan(100);
      expect(corner.light).toBeGreaterThan(20);

      const above = await inkCounts(sheet, { left: left + 2, top: 20, width: 90, height: 38 });
      expect(above.light).toBe(0);
    }
  });
});

async function inkCounts(
  image: Buffer,
  region: { left: number; top: number; width: number; height: number },
): Promise<{ dark: number; light: number }> {
  const { data, info } = await sharp(image)
    .extract(region)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let dark = 0;
  let light = 0;
  for (let at = 0; at + info.channels <= data.length; at += info.channels) {
    const sum = (data[at] ?? 0) + (data[at + 1] ?? 0) + (data[at + 2] ?? 0);
    if (sum < 90) dark += 1;
    if (sum > 690) light += 1;
  }
  return { dark, light };
}

describe('extract-metadata', () => {
  it('writes the capture row and frame 1 EXIF as JSON', async () => {
    const captureId = await newCapture({ look: 'kodachrome' });
    await extractMetadata({ captureId, jobKey: `${captureId}:extract-metadata` }, runtime.ctx);

    const [row] = await assetsWithRole(captureId, 'metadata');
    expect(row?.status).toBe('ready');
    expect(row?.mime).toBe('application/json');
    expect(row?.objectKey).toBe(`rolls/${rollId}/captures/${captureId}/derived/metadata.json`);
    if (row !== undefined) writtenKeys.push(row.objectKey);
    // A JSON document has no pixels, and a row claiming otherwise would be a
    // lie the gallery would try to lay out.
    expect(row?.width).toBeNull();
    expect(row?.height).toBeNull();

    const body = await objectBytes(row?.objectKey ?? '');
    expect(row?.bytes).toBe(body.length);
    expect(row?.sha256).toBe(sha256Hex(body));

    const doc = JSON.parse(body.toString('utf8')) as {
      captureId: string;
      rollId: string;
      mode: string;
      look: string | null;
      frameCount: number;
      resolution: string;
      capturedAt: string;
      timing: { gpioTriggerSkewUs: number | null } | null;
      exif: Record<string, unknown> | null;
      exifSourceFrame: number | null;
    };

    expect(doc.captureId).toBe(captureId);
    expect(doc.rollId).toBe(rollId);
    expect(doc.mode).toBe('wiggle');
    expect(doc.look).toBe('kodachrome');
    expect(doc.frameCount).toBe(4);
    expect(doc.resolution).toBe('1600x1200');
    expect(doc.capturedAt).toBe('2026-08-18T12:00:00.000Z');
    // The three skews are distinct measurements and are never conflated (04 §14).
    expect(doc.timing?.gpioTriggerSkewUs).toBe(42);

    // EXIF comes from frame 1, and the fixtures name their own camera in it, so
    // this asserts *which* frame was read rather than that some EXIF exists.
    expect(doc.exifSourceFrame).toBe(1);
    expect(doc.exif?.Make).toBe('KINO');
    expect(doc.exif?.Model).toBe('KINO D4');
    expect(String(doc.exif?.Software)).toContain('cam-01');
  });

  it('still records the capture fields of its own when a frame carries no EXIF', async () => {
    const captureId = await newCapture({ frameIndexes: [] });
    const plain = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#123456' },
    })
      .jpeg()
      .toBuffer();
    await seedAsset(captureId, {
      role: 'original-frame',
      frameIndex: 1,
      mime: 'image/jpeg',
      key: originalKeyFor(captureId, 1),
      body: plain,
      width: 64,
      height: 48,
    });

    await extractMetadata({ captureId, jobKey: `${captureId}:extract-metadata` }, runtime.ctx);

    const [row] = await assetsWithRole(captureId, 'metadata');
    if (row !== undefined) writtenKeys.push(row.objectKey);
    const doc = JSON.parse((await objectBytes(row?.objectKey ?? '')).toString('utf8')) as {
      captureId: string;
      exif: Record<string, unknown> | null;
    };
    // No EXIF is `null`, never a missing key: an absent field reads as "this
    // build has no such concept".
    expect(doc.captureId).toBe(captureId);
    expect(doc.exif).toBeNull();
  });
});

/* -------------------------------------------------------- 07 §26 in anger -- */

describe('a failing job destroys nothing else (07 §26)', () => {
  it('leaves the thumbnail, the still and every original intact', async () => {
    const captureId = await newCapture();
    const queue = newQueue();
    registerImageHandlers(queue);

    // The contact sheet is the job that dies. It is registered last, so
    // replacing it is the whole of the arrangement.
    const sheetJob = 'render-contact-sheet';

    await generateThumbnail({ captureId, jobKey: `${captureId}:generate-thumbnail` }, runtime.ctx);
    await generateGalleryStill(
      { captureId, jobKey: `${captureId}:generate-gallery-still` },
      runtime.ctx,
    );
    const before = await assetRows(captureId);
    for (const row of before) if (row.objectKey.includes('/derived/')) writtenKeys.push(row.objectKey);

    // A capture whose contact sheet cannot be rendered: the frame objects are
    // there, but the sheet handler is handed a capture with a frame row whose
    // object was never written, which is a real production failure mode.
    const brokenId = await newCapture({ frameIndexes: [1, 2] });
    await runtime.ctx.db.insert(assets).values({
      id: `asset_t23_${RUN}_ghost`,
      captureId: brokenId,
      role: 'original-frame',
      frameIndex: 3,
      mime: 'image/jpeg',
      objectKey: originalKeyFor(brokenId, 3),
      status: 'ready',
    });

    await expect(
      renderContactSheet({ captureId: brokenId, jobKey: `${brokenId}:${sheetJob}` }, runtime.ctx),
    ).rejects.toThrow();

    // Nothing of the healthy capture moved, and no contact-sheet row was left
    // behind claiming a derivative that does not exist.
    expect(await assetRows(captureId)).toEqual(before);
    expect(await assetsWithRole(brokenId, 'contact-sheet')).toEqual([]);

    // And every original is still exactly the bytes that were uploaded.
    for (const frameIndex of [1, 2]) {
      const body = await objectBytes(originalKeyFor(brokenId, frameIndex));
      expect(sha256Hex(body)).toBe(sha256Hex(frames[frameIndex - 1] ?? Buffer.alloc(0)));
    }
  });
});

/* ---------------------------------------------------- through the queue -- */

describe('registered on the queue', () => {
  it('runs the real handlers end to end and logs done', async () => {
    const captureId = await newCapture();
    const queue = newQueue();
    registerImageHandlers(queue);
    queue.start(runtime.ctx);

    for (const job of ['generate-thumbnail', 'extract-metadata'] as const) {
      await queue.enqueue(job, { captureId, jobKey: `${captureId}:${job}` });
    }

    await waitFor('both jobs to finish', async () => {
      const rows = await eventsFor(captureId);
      return (
        statusesOf(rows, 'generate-thumbnail').includes('done') &&
        statusesOf(rows, 'extract-metadata').includes('done')
      );
    });

    const roles = (await assetRows(captureId)).map((row) => row.role);
    expect(roles).toContain('thumb');
    expect(roles).toContain('metadata');
    for (const row of await assetRows(captureId)) {
      if (row.objectKey.includes('/derived/')) writtenKeys.push(row.objectKey);
    }
    expect((await publishedRoles(captureId)).sort()).toEqual(['metadata', 'thumb']);
  });
});

/**
 * A capture deleted between capture-complete and the job running is a normal
 * race. Burning five attempts on it — ten seconds, then twenty, then forty —
 * buys nothing, so the error says so in the only way BullMQ acts on.
 */
describe('a job pointed at a capture that is gone gives up at once', () => {
  it('throws an unrecoverable error rather than one BullMQ will retry', async () => {
    const missing = `cap_t23_${RUN}_absent`;

    const thrown = await generateThumbnail(
      { captureId: missing, jobKey: `${missing}:generate-thumbnail` },
      runtime.ctx,
    ).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(MissingCaptureError);
    // The property that actually stops the retries: anything else here and the
    // comment on MissingCaptureError would be a claim the code does not honour.
    expect(thrown).toBeInstanceOf(UnrecoverableError);
    expect((thrown as MissingCaptureError).code).toBe('CAPTURE_NOT_FOUND');
  });
});

/* --------------------------------------------------- the event mirror -- */

/**
 * `src/events/publish.ts` is a narrow mirror of the API's event publisher, for
 * the same reason `src/db/schema.ts` mirrors one table. This is the check that
 * makes the copy safe: a stream key or a channel name that drifted would not
 * fail anywhere else — the worker would go on writing events into keys nothing
 * reads, and every guest's tile would stay a placeholder until a page reload.
 */
describe('the worker and the API agree on the roll event wire', () => {
  it('uses the same keys, and publishes what the API can parse', async () => {
    const api = await import('../../api/src/events/publish');
    const worker = await import('../src/events/publish');

    expect(worker.rollStreamKey('roll_x')).toBe(api.rollStreamKey('roll_x'));
    expect(worker.rollEventChannel('roll_x')).toBe(api.rollEventChannel('roll_x'));
    expect(worker.ROLL_STREAM_MAXLEN).toBe(api.ROLL_STREAM_MAXLEN);

    // `.strict()` on the API's parser is the real assertion here: an extra field
    // on the worker's event, or a missing one, is rejected rather than delivered.
    const event = { type: 'processing.completed', captureId: 'cap_x', role: 'thumb' } as const;
    expect(api.parseRollEvent(JSON.stringify(event))).toEqual(event);
  });
});

/* ------------------------------------------------ terminal failure (#8) -- */

describe('a job that exhausts its attempts stops blocking its own re-enqueue', () => {
  it('appends failed and abandoned rows and releases the queued row', async () => {
    const captureId = await newCapture();
    const queue = newQueue({ attempts: 3, backoffDelay: 10 });
    const job = 'render-wiggle-webp';
    const jobKey = `${captureId}:${job}`;

    // The row the API's capture-complete writes, and the one whose survival is
    // the bug: while it exists, no later complete can queue this job again.
    await runtime.ctx.db.insert(processingEvents).values({
      id: `pev_t23_${RUN}_q`,
      captureId,
      job,
      status: 'queued',
    });

    queue.registerHandler(job, async () => {
      throw new Error('render died');
    });
    await queue.enqueue(job, { captureId, jobKey });
    queue.start(runtime.ctx);

    await waitFor('the job to exhaust its attempts', async () => {
      const bull = await queue.queue.getJob(jobKeyToJobId(jobKey));
      return (await bull?.isFailed()) === true;
    });
    await waitFor('the abandoned row', async () =>
      statusesOf(await eventsFor(captureId), job).includes('abandoned'),
    );

    // Every attempt is still in the log — the audit trail is not rewritten —
    // and the terminal row is appended after the last failure.
    expect(statusesOf(await eventsFor(captureId), job)).toEqual([
      'superseded',
      'running',
      'failed',
      'running',
      'failed',
      'running',
      'failed',
      'abandoned',
    ]);

    // The enqueue block is gone: the partial unique index only covers
    // `status = 'queued'`, and the superseded row no longer matches it.
    const stillQueued = await runtime.ctx.db
      .select({ id: processingEvents.id })
      .from(processingEvents)
      .where(
        and(
          eq(processingEvents.captureId, captureId),
          eq(processingEvents.job, job),
          eq(processingEvents.status, 'queued'),
        ),
      );
    expect(stillQueued).toEqual([]);

    /**
     * And the capture reaches a terminal answer instead of sitting in
     * `processing` forever. The API owns this function — the worker cannot call
     * it, for the same reason it cannot import the API's schema — so this is the
     * same kind of cross-workspace contract check as the producer test in
     * `queue.test.ts`: it pins the reader to the rows this worker writes.
     */
    const { recomputeCaptureStatus } = await import('../../api/src/uploads/uploads');
    type ApiDatabase = Parameters<typeof recomputeCaptureStatus>[0];
    expect(await recomputeCaptureStatus(runtime.ctx.db as unknown as ApiDatabase, captureId)).toBe(
      'partial',
    );

    // Which is the point: the work can be queued again.
    await runtime.ctx.db.insert(processingEvents).values({
      id: `pev_t23_${RUN}_q2`,
      captureId,
      job,
      status: 'queued',
    });
    expect(statusesOf(await eventsFor(captureId), job)).toContain('queued');
  });

  it('does not touch a sibling job that is still queued', async () => {
    const captureId = await newCapture();
    const queue = newQueue({ attempts: 1, backoffDelay: 5 });
    const dying = 'render-wiggle-mp4';
    const sibling = 'generate-thumbnail';

    await runtime.ctx.db.insert(processingEvents).values([
      { id: `pev_t23_${RUN}_s1`, captureId, job: dying, status: 'queued' },
      { id: `pev_t23_${RUN}_s2`, captureId, job: sibling, status: 'queued' },
    ]);

    queue.registerHandler(dying, async () => {
      throw new Error('ffmpeg exploded');
    });
    await queue.enqueue(dying, { captureId, jobKey: `${captureId}:${dying}` });
    queue.start(runtime.ctx);

    await waitFor('the abandoned row', async () =>
      statusesOf(await eventsFor(captureId), dying).includes('abandoned'),
    );

    // The sibling's enqueue block is exactly where it was: releasing one job's
    // lock must not release another's.
    expect(statusesOf(await eventsFor(captureId), sibling)).toEqual(['queued']);
  });
});

describe('ai-enhance (audit #62)', () => {
  const saved = { mode: process.env.AI_MODE, provider: process.env.AI_PROVIDER };

  afterEach(() => {
    if (saved.mode === undefined) delete process.env.AI_MODE;
    else process.env.AI_MODE = saved.mode;
    if (saved.provider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = saved.provider;
  });

  it('writes nothing at all with the default OFF gate', async () => {
    delete process.env.AI_MODE;
    delete process.env.AI_PROVIDER;
    const captureId = await newCapture();

    const result = await aiEnhance({ captureId, jobKey: `${captureId}:ai-enhance` }, runtime.ctx);

    expect(result.skipped).toBe('AI_ENHANCE_DISABLED');
    expect(await publishedRoles(captureId)).toEqual([]);
    const rows = await assetRows(captureId);
    expect(rows.every((row) => !ENHANCED_ROLES.includes(row.role as (typeof ENHANCED_ROLES)[number]))).toBe(true);
  });

  it('SUBTLE on the local provider publishes both roles with full provenance', async () => {
    process.env.AI_MODE = 'subtle';
    process.env.AI_PROVIDER = 'local';
    const captureId = await newCapture();

    const result = await aiEnhance({ captureId, jobKey: `${captureId}:ai-enhance` }, runtime.ctx);
    expect(result.skipped).toBe('');

    const still = (await assetsWithRole(captureId, 'enhanced-still'))[0];
    const wiggle = (await assetsWithRole(captureId, 'enhanced-wiggle'))[0];
    expect(still).toBeDefined();
    expect(wiggle).toBeDefined();
    expect(still?.mime).toBe('image/webp');
    expect(wiggle?.mime).toBe('image/webp');

    // The bytes are real images of the declared size, read back out of storage.
    const stillMeta = await sharp(await objectBytes(still!.objectKey)).metadata();
    expect(stillMeta.format).toBe('webp');
    const wiggleMeta = await sharp(await objectBytes(wiggle!.objectKey)).metadata();
    expect(wiggleMeta.format).toBe('webp');
    expect(wiggleMeta.pages).toBeGreaterThan(1);

    // Provenance: which provider, which operations, at which strength.
    const [producer] = await runtime.ctx.db
      .select({ producer: assets.producer })
      .from(assets)
      .where(and(eq(assets.captureId, captureId), eq(assets.role, 'enhanced-still')));
    const recorded = producer?.producer as Record<string, unknown> | null;
    expect(recorded?.job).toBe('ai-enhance');
    expect(recorded?.mode).toBe('subtle');
    expect(recorded?.provider).toMatchObject({ kind: 'local', name: 'kino-local-sharp' });
    expect(recorded?.sourceRole).toBe('original-frame');
    expect(Array.isArray(recorded?.operations)).toBe(true);

    // The originals and the KINO renders are untouched by the enhancement.
    const originals = await assetsWithRole(captureId, 'original-frame');
    expect(originals).toHaveLength(FRAME_COUNT);
  });

  it('a forbidden CUSTOM operation is refused unrecoverably, and writes nothing', async () => {
    process.env.AI_MODE = 'custom';
    process.env.AI_PROVIDER = 'local';
    process.env.AI_OPERATIONS = 'mild-denoise,face-reconstruction';
    const captureId = await newCapture();

    await expect(aiEnhance({ captureId, jobKey: `${captureId}:ai-enhance` }, runtime.ctx)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(await publishedRoles(captureId)).toEqual([]);
    delete process.env.AI_OPERATIONS;
  });
});
