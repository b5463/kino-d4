import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { execa } from 'execa';
import ffprobeStatic from 'ffprobe-static';
import sharp from 'sharp';
import { wiggleSequence, WIGGLE_FPS_DEFAULT } from '@kino/media';
import { loadWorkerConfig, type WorkerConfig } from '../src/config';
import { createJobRuntime, type JobRuntime } from '../src/context';
import { assets } from '../src/db/schema';
import { IMAGE_HANDLERS } from '../src/jobs';
import { renderWiggleWebp } from '../src/jobs/wiggleWebp';
import { renderWiggleMp4, resolveFfmpegPath } from '../src/jobs/wiggleMp4';
import { MissingCaptureError } from '../src/jobs/capture';
import { evenPixels, WIGGLE_MP4_LOOPS, WIGGLE_WIDTH } from '../src/jobs/wiggle';
import { rollStreamKey } from '../src/events/publish';

/**
 * Task 24's wiggle renders, against a real database, a real Redis and real
 * MinIO, with the real encoders:
 *
 *   docker compose -f infra/docker-compose.dev.yml up -d
 *   npm run db:migrate -w @kino/api
 *
 * The assertions are about the files. An animated WebP is asserted from its RIFF
 * chunks (`VP8X` + `ANIM`) and its decoded page count, not from sharp's promise
 * that it wrote one; the MP4 is probed with ffprobe. `ffmpeg-static` ships only
 * `ffmpeg`, so the probe binary comes from `ffprobe-static`, a devDependency —
 * the worker itself never probes anything.
 */
const RUN = randomBytes(4).toString('hex');

const config: WorkerConfig = loadWorkerConfig();

let runtime: JobRuntime;

/** An UNGUARDED client: `runtime.ctx.s3` refuses writes under `original/` (01 §7). */
let seeder: S3Client;

const deviceId = `dev_t24_${RUN}`;
const rollId = `roll_t24_${RUN}`;
const captureIds: string[] = [];
const writtenKeys: string[] = [];

const FIXTURE_DIR = new URL('../../../packages/test-fixtures/media/', import.meta.url);
const FRAME_COUNT = 4;
const frames: Buffer[] = [];

/** The order both renders use: 01 §8's default, over four stored frames. */
const SEQUENCE = wiggleSequence(FRAME_COUNT, 'bounce', 'ltr');

function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function originalKeyFor(captureId: string, frameIndex: number): string {
  const cam = String(frameIndex).padStart(2, '0');
  return `rolls/${rollId}/captures/${captureId}/original/cam-${cam}.jpg`;
}

interface NewCaptureOptions {
  frameCount?: number;
  /** Frames to seed, 1-based. Defaults to every frame of `frameCount`. */
  frameIndexes?: number[];
  /** Re-encode each fixture to these dimensions before seeding. */
  sourceSize?: { width: number; height: number };
}

async function newCapture(options: NewCaptureOptions = {}): Promise<string> {
  const frameCount = options.frameCount ?? FRAME_COUNT;
  const captureId = `cap_t24_${RUN}_${captureIds.length}`;
  captureIds.push(captureId);

  const size = options.sourceSize ?? { width: 1600, height: 1200 };

  await runtime.ctx.db.execute(sql`
    insert into captures
      (id, capture_uuid, roll_id, device_id, mode, look, captured_at, frame_count, resolution, timing, status)
    values
      (${captureId}, ${randomUUID()}, ${rollId}, ${deviceId}, 'wiggle', null,
       '2026-08-19T12:00:00Z', ${frameCount}, ${`${size.width}x${size.height}`},
       ${sql`${JSON.stringify({
         gpioTriggerSkewUs: 42,
         vsyncPhaseSkewUs: null,
         effectiveExposureSkewUs: null,
         unavailableReason: 'test fixture',
       })}::jsonb`},
       'processing')
  `);

  for (const frameIndex of options.frameIndexes ?? range(1, frameCount)) {
    const fixture = frames[(frameIndex - 1) % frames.length];
    if (fixture === undefined) throw new Error(`no fixture for frame ${frameIndex}`);

    const body =
      options.sourceSize === undefined
        ? fixture
        : await sharp(fixture)
            .resize({ width: size.width, height: size.height, fit: 'fill' })
            .jpeg({ quality: 90 })
            .toBuffer();

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
      id: `asset_t24_${RUN}_${writtenKeys.length}`,
      captureId,
      role: 'original-frame',
      frameIndex,
      mime: 'image/jpeg',
      width: size.width,
      height: size.height,
      bytes: body.length,
      sha256: sha256Hex(body),
      objectKey: key,
      status: 'ready',
    });
  }

  return captureId;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
}

interface AssetSnapshot {
  role: string;
  status: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  sha256: string | null;
  objectKey: string;
}

async function assetsWithRole(captureId: string, role: string): Promise<AssetSnapshot[]> {
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
    .orderBy(asc(assets.role))
    .then((rows) => rows.filter((row) => row.role === role));
}

async function objectBytes(key: string): Promise<Buffer> {
  const stream = await runtime.ctx.getObject(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** Every `processing.completed` role announced for a capture (05 §10). */
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

/** The RIFF chunk ids present in a WebP file, in order. */
function riffChunks(body: Buffer): string[] {
  expect(body.subarray(0, 4).toString('latin1')).toBe('RIFF');
  expect(body.subarray(8, 12).toString('latin1')).toBe('WEBP');

  const chunks: string[] = [];
  let at = 12;
  while (at + 8 <= body.length) {
    const id = body.subarray(at, at + 4).toString('latin1');
    const size = body.readUInt32LE(at + 4);
    chunks.push(id);
    at += 8 + size + (size % 2);
  }
  return chunks;
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

/**
 * The ffprobe to run: `FFPROBE_PATH` if the operator set one, else the
 * `ffprobe-static` build. Same precedence as the worker's own `FFMPEG_PATH`, so a
 * machine with system ffmpeg tools needs neither download.
 */
function probeBinary(): string {
  const configured = process.env['FFPROBE_PATH'];
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  return ffprobeStatic.path;
}

/** What ffprobe says the MP4 actually is. */
async function probeMp4(body: Buffer): Promise<Probe> {
  const dir = await mkdtemp(join(tmpdir(), `kino-probe-${RUN}-`));
  const path = join(dir, 'wiggle.mp4');
  try {
    await writeFile(path, body);
    const { stdout } = await execa(probeBinary(), [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,nb_frames,codec_name,pix_fmt:format=duration,format_name',
      '-of',
      'json',
      path,
    ]);
    const parsed = JSON.parse(stdout) as {
      streams?: {
        width?: number;
        height?: number;
        nb_frames?: string;
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
      frames: Number(stream.nb_frames ?? '0'),
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
    values (${deviceId}, ${`KD4-T24-${RUN}`}, 'KINO D4', 'v1', ${`hash_${RUN}`})
  `);
  await runtime.ctx.db.execute(sql`
    insert into rolls (id, slug, title, host_token_hash, created_by_device_id)
    values (${rollId}, ${`T24${RUN.toUpperCase()}`}, ${`Wiggle roll ${RUN}`}, ${`hash_${RUN}`}, ${deviceId})
  `);
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
  await runtime.ctx.db.execute(
    sql`delete from processing_events where capture_id like ${`cap_t24_${RUN}%`}`,
  );
  await runtime.ctx.db.execute(sql`delete from assets where capture_id like ${`cap_t24_${RUN}%`}`);
  await runtime.ctx.db.execute(sql`delete from captures where roll_id = ${rollId}`);
  await runtime.ctx.db.execute(sql`delete from rolls where id = ${rollId}`);
  await runtime.ctx.db.execute(sql`delete from devices where id = ${deviceId}`);

  await runtime.close();
}, 60_000);

/* ---------------------------------------------------------- the handlers -- */

describe('render-wiggle-webp', () => {
  it(
    'writes an animated WebP of the whole sequence, with a ready row and an event',
    async () => {
      const captureId = await newCapture();

      await renderWiggleWebp({ captureId, jobKey: `${captureId}:render-wiggle-webp` }, runtime.ctx);

      const [row] = await assetsWithRole(captureId, 'wiggle-webp');
      expect(row).toBeDefined();
      expect(row?.status).toBe('ready');
      expect(row?.mime).toBe('image/webp');
      expect(row?.width).toBe(WIGGLE_WIDTH);
      expect(row?.height).toBe(720);
      expect(row?.objectKey).toBe(
        `rolls/${rollId}/captures/${captureId}/derived/wiggle.webp`,
      );
      writtenKeys.push(row?.objectKey ?? '');

      const body = await objectBytes(row?.objectKey ?? '');
      expect(body.length).toBe(row?.bytes);
      expect(sha256Hex(body)).toBe(row?.sha256);

      // An animated WebP is an extended file with an animation header. A still
      // WebP has neither chunk, so this is the assertion that separates a
      // wigglegram from a picture of its first frame.
      const chunks = riffChunks(body);
      expect(chunks[0]).toBe('VP8X');
      expect(chunks).toContain('ANIM');
      expect(chunks.filter((id) => id === 'ANMF').length).toBeGreaterThanOrEqual(SEQUENCE.length);

      const meta = await sharp(body, { animated: true }).metadata();
      expect(meta.pages).toBeGreaterThanOrEqual(SEQUENCE.length);
      expect(meta.width).toBe(WIGGLE_WIDTH);
      expect(meta.pageHeight).toBe(720);
      // Loops forever (03 §13: the wiggle just plays).
      expect(meta.loop).toBe(0);
      expect(meta.delay?.[0]).toBe(Math.round(1000 / WIGGLE_FPS_DEFAULT));

      expect(await publishedRoles(captureId)).toContain('wiggle-webp');
    },
    120_000,
  );

  it(
    'lands on one asset row when it runs twice',
    async () => {
      const captureId = await newCapture();
      const payload = { captureId, jobKey: `${captureId}:render-wiggle-webp` };

      await renderWiggleWebp(payload, runtime.ctx);
      await renderWiggleWebp(payload, runtime.ctx);

      const rows = await assetsWithRole(captureId, 'wiggle-webp');
      expect(rows).toHaveLength(1);
      writtenKeys.push(rows[0]?.objectKey ?? '');
      expect(rows[0]?.status).toBe('ready');
    },
    120_000,
  );

  it('is unrecoverable for a capture that does not exist', async () => {
    const captureId = `cap_t24_${RUN}_missing`;
    await expect(
      renderWiggleWebp({ captureId, jobKey: `${captureId}:render-wiggle-webp` }, runtime.ctx),
    ).rejects.toBeInstanceOf(MissingCaptureError);
  });

  it(
    'refuses a capture with one stored frame, retryably',
    async () => {
      const captureId = await newCapture({ frameIndexes: [1] });
      const error = await renderWiggleWebp(
        { captureId, jobKey: `${captureId}:render-wiggle-webp` },
        runtime.ctx,
      ).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(MissingCaptureError);
      expect((error as Error).message).toMatch(/two frames/i);
      expect(await assetsWithRole(captureId, 'wiggle-webp')).toHaveLength(0);
    },
    60_000,
  );
});

describe('render-wiggle-mp4', () => {
  it(
    'writes an H.264 MP4 of the sequence looped four times',
    async () => {
      const captureId = await newCapture();

      await renderWiggleMp4({ captureId, jobKey: `${captureId}:render-wiggle-mp4` }, runtime.ctx);

      const [row] = await assetsWithRole(captureId, 'wiggle-mp4');
      expect(row).toBeDefined();
      expect(row?.status).toBe('ready');
      expect(row?.mime).toBe('video/mp4');
      expect(row?.width).toBe(WIGGLE_WIDTH);
      expect(row?.height).toBe(720);
      expect(row?.objectKey).toBe(`rolls/${rollId}/captures/${captureId}/derived/wiggle.mp4`);
      writtenKeys.push(row?.objectKey ?? '');

      const body = await objectBytes(row?.objectKey ?? '');
      expect(body.length).toBe(row?.bytes);
      expect(sha256Hex(body)).toBe(row?.sha256);

      const probe = await probeMp4(body);
      expect(probe.codec).toBe('h264');
      expect(probe.pixelFormat).toBe('yuv420p');
      expect(probe.width).toBe(WIGGLE_WIDTH);
      expect(probe.height).toBe(720);
      expect(probe.frames).toBe(SEQUENCE.length * WIGGLE_MP4_LOOPS);
      expect(probe.duration).toBeCloseTo(
        (SEQUENCE.length * WIGGLE_MP4_LOOPS) / WIGGLE_FPS_DEFAULT,
        1,
      );
      expect(probe.formats).toContain('mp4');

      expect(await publishedRoles(captureId)).toContain('wiggle-mp4');
    },
    180_000,
  );

  it(
    'lands on one asset row when it runs twice',
    async () => {
      const captureId = await newCapture();
      const payload = { captureId, jobKey: `${captureId}:render-wiggle-mp4` };

      await renderWiggleMp4(payload, runtime.ctx);
      await renderWiggleMp4(payload, runtime.ctx);

      const rows = await assetsWithRole(captureId, 'wiggle-mp4');
      expect(rows).toHaveLength(1);
      writtenKeys.push(rows[0]?.objectKey ?? '');
    },
    240_000,
  );
});

describe('even dimensions', () => {
  it('rounds an odd height down', () => {
    expect(evenPixels(721)).toBe(720);
    expect(evenPixels(720)).toBe(720);
    expect(evenPixels(1)).toBe(2);
    expect(evenPixels(0)).toBe(2);
  });

  it(
    'renders a source whose scaled height would be odd at an even height',
    async () => {
      // 960 × 1201 / 1600 = 720.6 → 721, which libx264 rejects with yuv420p.
      const captureId = await newCapture({ sourceSize: { width: 1600, height: 1201 } });
      const payload = { captureId, jobKey: `${captureId}:render-wiggle-mp4` };

      await renderWiggleWebp({ ...payload, jobKey: `${captureId}:render-wiggle-webp` }, runtime.ctx);
      await renderWiggleMp4(payload, runtime.ctx);

      const [webp] = await assetsWithRole(captureId, 'wiggle-webp');
      const [mp4] = await assetsWithRole(captureId, 'wiggle-mp4');
      writtenKeys.push(webp?.objectKey ?? '', mp4?.objectKey ?? '');

      expect(webp?.height).toBe(720);
      expect(mp4?.height).toBe(720);

      // Both renders show the same crop of the same frames, so a guest who
      // downloads the MP4 gets the wiggle they watched as a WebP.
      const probe = await probeMp4(await objectBytes(mp4?.objectKey ?? ''));
      expect(probe.height % 2).toBe(0);
      expect(probe.height).toBe(webp?.height);
      expect(probe.width).toBe(webp?.width);
    },
    240_000,
  );
});

describe('handler registration', () => {
  it('binds both render job names', () => {
    expect(IMAGE_HANDLERS['render-wiggle-webp']).toBe(renderWiggleWebp);
    expect(IMAGE_HANDLERS['render-wiggle-mp4']).toBe(renderWiggleMp4);
  });
});

describe('resolveFfmpegPath', () => {
  it('prefers FFMPEG_PATH over the bundled build', async () => {
    await expect(resolveFfmpegPath({ FFMPEG_PATH: '/usr/bin/ffmpeg' })).resolves.toBe(
      '/usr/bin/ffmpeg',
    );
    await expect(resolveFfmpegPath({ FFMPEG_PATH: '  /opt/ffmpeg  ' })).resolves.toBe(
      '/opt/ffmpeg',
    );
  });

  it('falls back to the bundled build when the variable is unset or blank', async () => {
    for (const env of [{}, { FFMPEG_PATH: '' }, { FFMPEG_PATH: '   ' }]) {
      const resolved = await resolveFfmpegPath(env);
      expect(resolved.length).toBeGreaterThan(0);
      expect(resolved).toMatch(/ffmpeg/);
    }
  });

  it('is the path the renders actually ran with', async () => {
    // The suite above encoded a real MP4, so whatever this resolves to is
    // executable — assert that rather than restating the resolution rules.
    const { stdout } = await execa(await resolveFfmpegPath(), ['-hide_banner', '-version']);
    expect(stdout).toMatch(/^ffmpeg version/);
  });
});
