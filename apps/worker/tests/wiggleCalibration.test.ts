import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { alignmentPlan, wiggleSequence } from '@kino/media';
import { loadWorkerConfig, type WorkerConfig } from '../src/config';
import { createJobRuntime, type JobRuntime } from '../src/context';
import { assets } from '../src/db/schema';
import { captureCalibration } from '../src/jobs/calibration';
import { loadCapture } from '../src/jobs/capture';
import { evenPixels, loadWiggleFrames, WIGGLE_WIDTH } from '../src/jobs/wiggle';
import { renderWiggleWebp } from '../src/jobs/wiggleWebp';

/**
 * Audit #59's render consistency, against the real dev stack (same
 * prerequisites as `wiggleJobs.test.ts`).
 *
 * The provenance blocks are SYNTHETIC — no firmware records `meta.calibration`
 * yet (firmware-contract/commands.md) — which is exactly the point: the
 * TypeScript side is testable now, and the fixture is the shape the device
 * will send.
 */
const RUN = randomBytes(4).toString('hex');

const config: WorkerConfig = loadWorkerConfig();

let runtime: JobRuntime;
let seeder: S3Client;

const deviceId = `dev_t59_${RUN}`;
const rollId = `roll_t59_${RUN}`;
const captureIds: string[] = [];
const writtenKeys: string[] = [];

const FIXTURE_DIR = new URL('../../../packages/test-fixtures/media/', import.meta.url);
const FRAME_COUNT = 4;
const frames: Buffer[] = [];

/** The synthetic capture-time calibration the fixtures carry. */
const CAL = {
  version: `cal-${RUN}`,
  cams: {
    cam1: { x: 0, y: 0, rot: 0 },
    cam2: { x: -6, y: 3, rot: 0 },
    cam3: { x: 4, y: -2, rot: 0.8 },
    cam4: { x: 0, y: 1, rot: 0 },
  },
};

function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

interface NewCaptureOptions {
  provenance?: unknown;
  playback?: unknown;
  look?: string | null;
}

async function newCapture(options: NewCaptureOptions = {}): Promise<string> {
  const captureId = `cap_t59_${RUN}_${captureIds.length}`;
  captureIds.push(captureId);

  await runtime.ctx.db.execute(sql`
    insert into captures
      (id, capture_uuid, roll_id, device_id, mode, look, captured_at, frame_count, resolution,
       provenance, playback, status)
    values
      (${captureId}, ${randomUUID()}, ${rollId}, ${deviceId}, 'wiggle', ${options.look ?? null},
       '2026-08-19T12:00:00Z', ${FRAME_COUNT}, '1600x1200',
       ${options.provenance === undefined ? null : sql`${JSON.stringify(options.provenance)}::jsonb`},
       ${options.playback === undefined ? null : sql`${JSON.stringify(options.playback)}::jsonb`},
       'processing')
  `);

  for (let frameIndex = 1; frameIndex <= FRAME_COUNT; frameIndex += 1) {
    const body = frames[frameIndex - 1];
    if (body === undefined) throw new Error(`no fixture for frame ${frameIndex}`);
    const key = `rolls/${rollId}/captures/${captureId}/original/cam-0${frameIndex}.jpg`;
    await seeder.send(
      new PutObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: 'image/jpeg',
      }),
    );
    writtenKeys.push(key);

    await runtime.ctx.db.insert(assets).values({
      id: `asset_t59_${RUN}_${writtenKeys.length}`,
      captureId,
      role: 'original-frame',
      frameIndex,
      mime: 'image/jpeg',
      width: 1600,
      height: 1200,
      bytes: body.length,
      sha256: sha256Hex(body),
      objectKey: key,
      status: 'ready',
    });
  }

  return captureId;
}

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

  await runtime.ctx.db.execute(sql`
    insert into devices (id, serial, product, hardware_revision, token_hash)
    values (${deviceId}, ${`KD4-T59-${RUN}`}, 'KINO D4', 'v1', ${`hash_${RUN}`})
  `);
  await runtime.ctx.db.execute(sql`
    insert into rolls (id, slug, title, host_token_hash, created_by_device_id)
    values (${rollId}, ${`T59${RUN.toUpperCase()}`}, ${`Calibration roll ${RUN}`}, ${`hash_${RUN}`}, ${deviceId})
  `);
}, 60_000);

afterAll(async () => {
  for (const key of writtenKeys) {
    try {
      await seeder.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
    } catch {
      /* a leftover test object costs a few KB; a failed teardown costs the suite */
    }
  }
  seeder.destroy();

  await runtime.ctx.db.execute(sql`delete from processing_events where capture_id like ${`cap_t59_${RUN}%`}`);
  await runtime.ctx.db.execute(sql`delete from assets where capture_id like ${`cap_t59_${RUN}%`}`);
  await runtime.ctx.db.execute(sql`delete from captures where roll_id = ${rollId}`);
  await runtime.ctx.db.execute(sql`delete from rolls where id = ${rollId}`);
  await runtime.ctx.db.execute(sql`delete from devices where id = ${deviceId}`);
  await runtime.ctx.redis.del(`kino:roll:${rollId}:events`);

  await runtime.close();
}, 60_000);

/* ------------------------------------------------- captureCalibration (pure) */

describe('captureCalibration', () => {
  const wrap = (calibration: unknown) => ({ provenance: { meta: { calibration } } });

  it('parses a well-formed block and clamps to the calibration bounds', () => {
    const parsed = captureCalibration(
      wrap({ version: 'cal-9', cams: { cam1: { x: 35, y: -35, rot: 5.5 } } }),
    );
    expect(parsed).toEqual({
      version: 'cal-9',
      cams: { cam1: { x: 20, y: -20, rot: 2 } },
    });
  });

  it('returns null on anything malformed', () => {
    expect(captureCalibration({ provenance: null })).toBeNull();
    expect(captureCalibration({ provenance: 'device' })).toBeNull();
    expect(captureCalibration({ provenance: { meta: {} } })).toBeNull();
    expect(captureCalibration(wrap('v1'))).toBeNull();
    expect(captureCalibration(wrap({ version: '', cams: { cam1: { x: 0, y: 0, rot: 0 } } }))).toBeNull();
    expect(captureCalibration(wrap({ version: 'v1' }))).toBeNull();
    expect(captureCalibration(wrap({ version: 'v1', cams: {} }))).toBeNull();
    expect(captureCalibration(wrap({ version: 'v1', cams: { cam1: { x: '3', y: 0, rot: 0 } } }))).toBeNull();
    expect(captureCalibration(wrap({ version: 'v1', cams: { cam1: { x: Infinity, y: 0, rot: 0 } } }))).toBeNull();
    expect(captureCalibration(wrap({ version: 'v1', cams: { cam1: { x: 1, y: 2 } } }))).toBeNull();
  });
});

/* ----------------------------------------------------- the aligned decode -- */

describe('loadWiggleFrames with capture-time calibration', () => {
  it(
    'applies the rotate + overlap crop at source resolution, before the resize',
    async () => {
      const captureId = await newCapture({
        provenance: { device: { serial: `KD4-T59-${RUN}` }, meta: { calibration: CAL } },
      });
      const capture = await loadCapture(runtime.ctx.db, captureId);
      const wiggle = await loadWiggleFrames(runtime.ctx, capture);

      // The crop is the shared plan's, computed in SOURCE pixels.
      const offsets = [CAL.cams.cam1, CAL.cams.cam2, CAL.cams.cam3, CAL.cams.cam4];
      const plan = alignmentPlan(1600, 1200, offsets);
      expect(wiggle.aligned).toBe(true);
      expect(wiggle.calibrationVersion).toBe(CAL.version);
      expect(wiggle.crop).toEqual(plan.crop);

      // Height follows the cropped geometry, still even for x264.
      expect(wiggle.height).toBe(evenPixels((WIGGLE_WIDTH * plan.crop.h) / plan.crop.w));
      expect(wiggle.height % 2).toBe(0);
      expect(wiggle.width).toBe(WIGGLE_WIDTH);

      // Every frame decoded to exactly the render geometry, raw RGB.
      for (const frame of wiggle.frames) {
        expect(frame.length).toBe(WIGGLE_WIDTH * wiggle.height * 3);
      }
      expect(wiggle.frames).toHaveLength(FRAME_COUNT);
    },
    120_000,
  );

  it(
    'renders identically with no calibration, a malformed one, and no provenance at all',
    async () => {
      const bare = await newCapture();
      const noCalibration = await newCapture({
        provenance: { device: { serial: `KD4-T59-${RUN}` } },
      });
      const malformed = await newCapture({
        provenance: { device: {}, meta: { calibration: { version: 42, cams: 'nope' } } },
      });

      const render = async (id: string) =>
        loadWiggleFrames(runtime.ctx, await loadCapture(runtime.ctx.db, id));
      const a = await render(bare);
      const b = await render(noCalibration);
      const c = await render(malformed);

      for (const wiggle of [a, b, c]) {
        expect(wiggle.aligned).toBe(false);
        expect(wiggle.calibrationVersion).toBeNull();
        expect(wiggle.crop).toBeNull();
        // The pre-alignment geometry: plain resize of the full frame.
        expect(wiggle.height).toBe(720);
      }

      // Byte-identical frames: absent calibration takes the unchanged path, so
      // nothing about a provenance block that carries no (usable) calibration
      // may leak into the pixels.
      for (let index = 0; index < FRAME_COUNT; index += 1) {
        expect(a.frames[index]?.equals(b.frames[index] ?? Buffer.alloc(0))).toBe(true);
        expect(a.frames[index]?.equals(c.frames[index] ?? Buffer.alloc(0))).toBe(true);
      }
    },
    120_000,
  );

  it(
    'reads fps, loop and direction from the stored playback choice',
    async () => {
      const captureId = await newCapture({
        playback: { fps: 5, loop: 'continuous', direction: 'rtl' },
      });
      const capture = await loadCapture(runtime.ctx.db, captureId);
      const wiggle = await loadWiggleFrames(runtime.ctx, capture);

      expect(wiggle.fps).toBe(5);
      expect(wiggle.delayMs).toBe(200);
      // KDP 'continuous' is media 'sweep': one pass, mirrored for rtl.
      expect(wiggle.order).toEqual(wiggleSequence(FRAME_COUNT, 'sweep', 'rtl'));
    },
    120_000,
  );

  it(
    'clamps a stale fps and defaults a mangled playback block',
    async () => {
      const captureId = await newCapture({ playback: { fps: 99, loop: 'boomerang' } });
      const capture = await loadCapture(runtime.ctx.db, captureId);
      const wiggle = await loadWiggleFrames(runtime.ctx, capture);

      expect(wiggle.fps).toBe(15);
      expect(wiggle.order).toEqual(wiggleSequence(FRAME_COUNT, 'bounce', 'ltr'));
    },
    120_000,
  );
});

/* -------------------------------------------------------- producer identity */

describe('wiggle producer identity', () => {
  it(
    'records calibrationVersion, aligned, crop and look on the baked WebP',
    async () => {
      const captureId = await newCapture({
        provenance: { device: {}, meta: { calibration: CAL } },
        playback: { fps: 12 },
        look: 'party-neg',
      });

      await renderWiggleWebp({ captureId, jobKey: `${captureId}:render-wiggle-webp` }, runtime.ctx);

      const [row] = await runtime.ctx.db
        .select({ producer: assets.producer, objectKey: assets.objectKey })
        .from(assets)
        .where(eq(assets.objectKey, `rolls/${rollId}/captures/${captureId}/derived/wiggle.webp`));
      expect(row).toBeDefined();
      writtenKeys.push(row?.objectKey ?? '');

      const offsets = [CAL.cams.cam1, CAL.cams.cam2, CAL.cams.cam3, CAL.cams.cam4];
      expect(row?.producer).toMatchObject({
        job: 'wiggle-webp',
        fps: 12,
        calibrationVersion: CAL.version,
        aligned: true,
        crop: alignmentPlan(1600, 1200, offsets).crop,
        // Recorded, never applied — the P4 bakes the look into the JPEGs.
        look: 'party-neg',
      });
    },
    120_000,
  );
});
