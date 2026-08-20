import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { execa } from 'execa';
import ffprobeStatic from 'ffprobe-static';
import { loadWorkerConfig, type WorkerConfig } from '../src/config';
import { createJobRuntime, type JobRuntime } from '../src/context';
import { assets, recapJobs } from '../src/db/schema';
import { ROLL_HANDLERS } from '../src/jobs';
import {
  AI_ENHANCE_SKIP,
  aiEnhance,
  ENHANCED_ROLES,
  WIGGLE_SAFE_OPERATIONS,
} from '../src/jobs/aiEnhance';
import {
  generateRecap,
  RECAP_FPS,
  RECAP_SEGMENT_FRAMES,
  RECAP_SEGMENT_SECONDS,
  RECAP_WIDTH,
  recapTitleCardText,
  renderTitleCard,
} from '../src/jobs/recap';
import { recapObjectKey } from '../src/storage/derived';
import { rollStreamKey } from '../src/events/publish';

/**
 * Task 25's recap render and the AI-enhance stub, against the real dev stack:
 *
 *   docker compose -f infra/docker-compose.dev.yml up -d
 *   npm run db:migrate -w @kino/api
 *
 * The recap assertions are about the *file*: ffprobe decides whether the MP4 is
 * playable, how wide it is and how many frames it holds. A recap that ffmpeg
 * reported writing and no demuxer can open is the failure this suite exists to
 * catch.
 */
const RUN = randomBytes(4).toString('hex');

const config: WorkerConfig = loadWorkerConfig();

let runtime: JobRuntime;

/** An UNGUARDED client: `runtime.ctx.s3` refuses writes under `original/` (01 §7). */
let seeder: S3Client;

const deviceId = `dev_t25r_${RUN}`;
const rollId = `roll_t25r_${RUN}`;
const ROLL_TITLE = `Recap roll ${RUN}`;
const ROLL_CREATED_AT = '2026-08-14T18:30:00Z';

const captureIds: string[] = [];
const writtenKeys: string[] = [];

const FIXTURE_DIR = new URL('../../../packages/test-fixtures/media/', import.meta.url);
const frames: Buffer[] = [];

function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function originalKeyFor(captureId: string, frameIndex: number): string {
  const cam = String(frameIndex).padStart(2, '0');
  return `rolls/${rollId}/captures/${captureId}/original/cam-${cam}.jpg`;
}

/** Seeds one capture with `frameCount` stored original frames. */
async function newCapture(mode: string, frameCount: number, capturedAt: string): Promise<string> {
  const captureId = `cap_t25r_${RUN}_${captureIds.length}`;
  captureIds.push(captureId);

  await runtime.ctx.db.execute(sql`
    insert into captures
      (id, capture_uuid, roll_id, device_id, mode, look, captured_at, frame_count,
       resolution, timing, status, visible)
    values
      (${captureId}, ${randomUUID()}, ${rollId}, ${deviceId}, ${mode}, null,
       ${capturedAt}, ${frameCount}, '1600x1200', null, 'ready', true)
  `);

  for (let frameIndex = 1; frameIndex <= frameCount; frameIndex += 1) {
    const body = frames[(frameIndex - 1) % frames.length];
    if (body === undefined) throw new Error(`no fixture for frame ${frameIndex}`);

    const key = originalKeyFor(captureId, frameIndex);
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
      id: `asset_t25r_${RUN}_${writtenKeys.length}`,
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

async function objectBytes(key: string): Promise<Buffer> {
  const stream = await runtime.ctx.getObject(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

interface Probe {
  width: number;
  height: number;
  frames: number;
  codec: string;
  pixelFormat: string;
  duration: number;
  formats: string;
}

/** `FFPROBE_PATH` if the operator set one, else the `ffprobe-static` build. */
function probeBinary(): string {
  const configured = process.env['FFPROBE_PATH'];
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  return ffprobeStatic.path;
}

async function probeMp4(body: Buffer): Promise<Probe> {
  const dir = await mkdtemp(join(tmpdir(), `kino-probe-${RUN}-`));
  const path = join(dir, 'recap.mp4');
  try {
    await writeFile(path, body);
    const { stdout } = await execa(probeBinary(), [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-count_frames',
      '-show_entries',
      'stream=width,height,nb_read_frames,codec_name,pix_fmt:format=duration,format_name',
      '-of',
      'json',
      path,
    ]);
    const parsed = JSON.parse(stdout) as {
      streams?: {
        width?: number;
        height?: number;
        nb_read_frames?: string;
        codec_name?: string;
        pix_fmt?: string;
      }[];
      format?: { duration?: string; format_name?: string };
    };
    const stream = parsed.streams?.[0];
    if (stream === undefined) throw new Error('ffprobe found no video stream');
    return {
      width: stream.width ?? 0,
      height: stream.height ?? 0,
      frames: Number(stream.nb_read_frames ?? '0'),
      codec: stream.codec_name ?? '',
      pixelFormat: stream.pix_fmt ?? '',
      duration: Number(parsed.format?.duration ?? '0'),
      formats: parsed.format?.format_name ?? '',
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

  for (let frameIndex = 1; frameIndex <= 4; frameIndex += 1) {
    const name = `frame-${String(frameIndex).padStart(2, '0')}.jpg`;
    frames.push(await readFile(fileURLToPath(new URL(name, FIXTURE_DIR))));
  }

  const tables = await runtime.ctx.db.execute<{ table_name: string }>(sql`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('captures', 'assets', 'recap_jobs')
  `);
  if (Array.from(tables).length < 3) {
    throw new Error(
      'Database is not migrated: captures/assets/recap_jobs missing. ' +
        'Run `npm run db:migrate -w @kino/api` against DATABASE_URL and re-run the tests.',
    );
  }

  await runtime.ctx.db.execute(sql`
    insert into devices (id, serial, product, hardware_revision, token_hash)
    values (${deviceId}, ${`KD4-T25R-${RUN}`}, 'KINO D4', 'v1', ${`hash_${RUN}`})
  `);
  await runtime.ctx.db.execute(sql`
    insert into rolls (id, slug, title, host_token_hash, created_by_device_id, created_at)
    values (${rollId}, ${`R25${RUN.toUpperCase()}`}, ${ROLL_TITLE}, ${`hash_${RUN}`},
            ${deviceId}, ${ROLL_CREATED_AT})
  `);

  // Chronological order is the recap's whole structure, so the rows are seeded
  // out of order on purpose: the wiggle was captured *second*.
  await newCapture('single', 1, '2026-08-14T20:05:00Z');
  await newCapture('wiggle', 4, '2026-08-14T19:10:00Z');
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
  await runtime.ctx.db.execute(sql`delete from recap_jobs where roll_id = ${rollId}`);
  await runtime.ctx.db.execute(
    sql`delete from processing_events where capture_id like ${`cap_t25r_${RUN}%`}`,
  );
  await runtime.ctx.db.execute(sql`delete from assets where capture_id like ${`cap_t25r_${RUN}%`}`);
  await runtime.ctx.db.execute(sql`delete from captures where roll_id = ${rollId}`);
  await runtime.ctx.db.execute(sql`delete from audit_events where roll_id = ${rollId}`);
  await runtime.ctx.db.execute(sql`delete from rolls where id = ${rollId}`);
  await runtime.ctx.db.execute(sql`delete from devices where id = ${deviceId}`);
  await runtime.close();
});

/* ------------------------------------------------------------------ tests -- */

describe('generate-recap', () => {
  const recapId = `rcp_t25r_${RUN}`;
  const jobKey = `${recapId}:generate-recap`;

  it('is registered under its job name', () => {
    expect(ROLL_HANDLERS['generate-recap']).toBeDefined();
  });

  it('renders a playable MP4 with a title card and one segment per capture', async () => {
    await generateRecap({ rollId, jobKey }, runtime.ctx);

    const key = recapObjectKey(rollId, recapId);
    writtenKeys.push(key);

    const body = await objectBytes(key);
    const probe = await probeMp4(body);

    expect(probe.codec).toBe('h264');
    expect(probe.formats).toContain('mp4');
    expect(probe.pixelFormat).toBe('yuv420p');
    expect(probe.width).toBe(RECAP_WIDTH);
    // Even height, or libx264 with yuv420p could not have encoded it at all.
    expect(probe.height % 2).toBe(0);

    // One segment per capture PLUS the title card: two captures is three
    // segments, and "at least captureCount segments" is the floor.
    const segments = captureIds.length + 1;
    expect(probe.frames).toBeGreaterThanOrEqual(captureIds.length * RECAP_SEGMENT_FRAMES);
    expect(probe.frames).toBe(segments * RECAP_SEGMENT_FRAMES);
    expect(probe.duration).toBeCloseTo(segments * RECAP_SEGMENT_SECONDS, 1);
    expect(RECAP_SEGMENT_FRAMES).toBe(Math.round(RECAP_SEGMENT_SECONDS * RECAP_FPS));
  });

  it('records exactly one state row, marked done', async () => {
    const rows = await runtime.ctx.db
      .select()
      .from(recapJobs)
      .where(eq(recapJobs.rollId, rollId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(recapId);
    expect(rows[0]?.status).toBe('done');
    expect(rows[0]?.error).toBeNull();
    expect(rows[0]?.finishedAt).not.toBeNull();
  });

  it('is idempotent: a re-run lands on the same key and the same single row', async () => {
    const key = recapObjectKey(rollId, recapId);
    const before = await objectBytes(key);

    await generateRecap({ rollId, jobKey }, runtime.ctx);

    const after = await objectBytes(key);
    // Same geometry, same segment count, same file size class — the render is a
    // function of the roll, not of how many times it has run.
    expect(after.length).toBeGreaterThan(0);
    expect(Math.abs(after.length - before.length)).toBeLessThan(before.length);

    const rows = await runtime.ctx.db
      .select()
      .from(recapJobs)
      .where(eq(recapJobs.rollId, rollId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('done');
  });

  it('titles the card with the roll title and its date, and nothing else', () => {
    expect(recapTitleCardText(ROLL_TITLE, new Date(ROLL_CREATED_AT))).toBe(
      `${ROLL_TITLE} — 2026-08-14`,
    );
  });

  it('draws type on dark grey rather than an empty grey field', async () => {
    const card = await renderTitleCard(recapTitleCardText(ROLL_TITLE, new Date()), 320, 180);
    expect(card).toHaveLength(320 * 180 * 3);

    // The background is the dark grey 03 §21 asks for, read off a corner.
    expect([card[0], card[1], card[2]]).toEqual([0x2a, 0x2a, 0x2a]);

    /*
     * And something is actually drawn on it. A card whose text failed to render —
     * no fontconfig, a font name the host does not have — is a uniform field, and
     * a frame-count assertion cannot tell that from a title card. So: at least one
     * pixel is lighter than the background by a wide margin.
     */
    let brightest = 0;
    for (let at = 0; at < card.length; at += 3) brightest = Math.max(brightest, card[at] ?? 0);
    expect(brightest).toBeGreaterThan(0x80);
  });

  it('writes no processing_events row: a recap belongs to no capture', async () => {
    const rows = await runtime.ctx.db.execute<{ n: string }>(
      sql`select count(*)::text as n from processing_events where capture_id like ${`cap_t25r_${RUN}%`}`,
    );
    expect(Array.from(rows)[0]?.n).toBe('0');
  });
});

describe('ai-enhance', () => {
  it('is registered under its job name', () => {
    expect(ROLL_HANDLERS['ai-enhance']).toBeDefined();
  });

  it('skips with a marker rather than pretending to have enhanced anything', async () => {
    const captureId = captureIds[0];
    if (captureId === undefined) throw new Error('no seeded capture');

    const result = await aiEnhance({ captureId, jobKey: `${captureId}:ai-enhance` }, runtime.ctx);
    expect(result).toEqual({ skipped: AI_ENHANCE_SKIP });
  });

  it('writes no asset row and publishes no event', async () => {
    const captureId = captureIds[0];
    if (captureId === undefined) throw new Error('no seeded capture');

    const before = await runtime.ctx.redis.xlen(rollStreamKey(rollId));

    await aiEnhance({ captureId, jobKey: `${captureId}:ai-enhance` }, runtime.ctx);

    const rows = await runtime.ctx.db.select().from(assets).where(eq(assets.captureId, captureId));
    for (const row of rows) {
      expect(ENHANCED_ROLES).not.toContain(row.role);
    }
    expect(await runtime.ctx.redis.xlen(rollStreamKey(rollId))).toBe(before);
  });

  it('commits to the wiggle-safe operation list and the two enhanced roles', () => {
    // The interface is the deliverable (03 §20). A later implementation that
    // dropped one of these is a different contract, and this is what says so.
    expect(ENHANCED_ROLES).toEqual(['enhanced-still', 'enhanced-wiggle']);
    expect(WIGGLE_SAFE_OPERATIONS).toEqual([
      'mild-denoise',
      'jpeg-cleanup',
      'restrained-deblur',
      'upscale-1.5x-to-2x',
      'preserve-grain',
    ]);
    expect(WIGGLE_SAFE_OPERATIONS).not.toContain('face-reconstruction');
  });
});
