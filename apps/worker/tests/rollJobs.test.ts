import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadWorkerConfig, type WorkerConfig } from '../src/config';
import { createJobRuntime, type JobRuntime } from '../src/context';
import { assets, auditEvents, captures, exportJobs } from '../src/db/schema';
import { ROLL_HANDLERS } from '../src/jobs';
import { exportRoll, MissingExportJobError } from '../src/jobs/exportRoll';
import { PURGE_AUDIT_ACTION, purgeTrash, TRASH_GRACE_DAYS } from '../src/jobs/purgeTrash';
import {
  createEraser,
  EraseCommandError,
  EraseScopeError,
  type MediaEraser,
} from '../src/storage/eraser';
import { exportObjectKey, OriginalWriteError } from '../src/storage/derived';
import type { JobCtx } from '../src/jobs/types';

/**
 * Task 25's roll export and trash purge, against the real dev stack:
 *
 *   docker compose -f infra/docker-compose.dev.yml up -d
 *   npm run db:migrate -w @kino/api
 *
 * The export assertions are about the ZIP the host would actually be handed: it
 * is parsed out of object storage, its central directory is read, and the key is
 * the one Task 21's polling route presigns. The purge assertions are about the
 * bucket as much as the database — a purge that dropped the rows and left the
 * bytes would pass a rows-only test and orphan every frame it touched.
 */
const RUN = randomBytes(4).toString('hex');

const config: WorkerConfig = loadWorkerConfig();

let runtime: JobRuntime;

/** An UNGUARDED client, for seeding originals and for reading the bucket back. */
let seeder: S3Client;

const deviceId = `dev_t25x_${RUN}`;
const rollId = `roll_t25x_${RUN}`;

const writtenKeys: string[] = [];
let fixture: Buffer;

function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

interface SeedOptions {
  /** How long ago the capture was moved to trash, in days. `null` = not deleted. */
  deletedDaysAgo?: number | null;
  /** Seed the object as well as the row. */
  storeObjects?: boolean;
}

/** Seeds one two-frame capture and returns its id. */
async function newCapture(name: string, options: SeedOptions = {}): Promise<string> {
  const captureId = `cap_t25x_${RUN}_${name}`;
  const deletedDaysAgo = options.deletedDaysAgo ?? null;

  await runtime.ctx.db.execute(sql`
    insert into captures
      (id, capture_uuid, roll_id, device_id, mode, look, captured_at, frame_count,
       resolution, timing, status, visible, deleted_at)
    values
      (${captureId}, ${randomUUID()}, ${rollId}, ${deviceId}, 'wiggle', null,
       '2026-08-14T19:00:00Z', 2, '1600x1200', null, 'ready', true,
       ${deletedDaysAgo === null ? null : sql`now() - (${String(deletedDaysAgo)} || ' days')::interval`})
  `);

  for (let frameIndex = 1; frameIndex <= 2; frameIndex += 1) {
    const key = `rolls/${rollId}/captures/${captureId}/original/cam-0${String(frameIndex)}.jpg`;

    if (options.storeObjects !== false) {
      await seeder.send(
        new PutObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: key,
          Body: fixture,
          ContentType: 'image/jpeg',
        }),
      );
      writtenKeys.push(key);
    }

    await runtime.ctx.db.insert(assets).values({
      id: `asset_t25x_${RUN}_${name}_${String(frameIndex)}`,
      captureId,
      role: 'original-frame',
      frameIndex,
      mime: 'image/jpeg',
      width: 1600,
      height: 1200,
      bytes: fixture.length,
      sha256: sha256Hex(fixture),
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

/**
 * The file names in a ZIP's central directory.
 *
 * Read from the archive itself rather than trusted from the writer, and with no
 * new dependency: the central directory is a run of `PK\x01\x02` records, each
 * carrying its own name length at a fixed offset. A ZIP whose local headers were
 * fine and whose directory was not is unopenable by every real unzip, so this is
 * the half worth checking.
 */
function zipEntryNames(body: Buffer): string[] {
  const SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const names: string[] = [];
  let at = body.indexOf(SIGNATURE);
  while (at !== -1) {
    const nameLength = body.readUInt16LE(at + 28);
    const extraLength = body.readUInt16LE(at + 30);
    const commentLength = body.readUInt16LE(at + 32);
    names.push(body.subarray(at + 46, at + 46 + nameLength).toString('utf8'));
    at = body.indexOf(SIGNATURE, at + 46 + nameLength + extraLength + commentLength);
  }
  return names;
}

async function claimExport(status = 'queued'): Promise<string> {
  const jobId = `exp_t25x_${RUN}_${randomBytes(3).toString('hex')}`;
  await runtime.ctx.db.insert(exportJobs).values({ id: jobId, rollId, status });
  return jobId;
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

  fixture = await readFile(
    fileURLToPath(new URL('../../../packages/test-fixtures/media/frame-01.jpg', import.meta.url)),
  );

  const tables = await runtime.ctx.db.execute<{ table_name: string }>(sql`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('captures', 'assets', 'export_jobs', 'audit_events')
  `);
  if (Array.from(tables).length < 4) {
    throw new Error(
      'Database is not migrated. Run `npm run db:migrate -w @kino/api` and re-run the tests.',
    );
  }

  await runtime.ctx.db.execute(sql`
    insert into devices (id, serial, product, hardware_revision, token_hash)
    values (${deviceId}, ${`KD4-T25X-${RUN}`}, 'KINO D4', 'v1', ${`hash_${RUN}`})
  `);
  await runtime.ctx.db.execute(sql`
    insert into rolls (id, slug, title, host_token_hash, created_by_device_id)
    values (${rollId}, ${`X25${RUN.toUpperCase()}`}, ${`Export roll ${RUN}`}, ${`hash_${RUN}`}, ${deviceId})
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

  await runtime.ctx.db.execute(sql`delete from export_jobs where roll_id = ${rollId}`);
  await runtime.ctx.db.execute(
    sql`delete from processing_events where capture_id like ${`cap_t25x_${RUN}%`}`,
  );
  await runtime.ctx.db.execute(sql`delete from assets where capture_id like ${`cap_t25x_${RUN}%`}`);
  await runtime.ctx.db.execute(sql`delete from captures where roll_id = ${rollId}`);
  await runtime.ctx.db.execute(sql`delete from audit_events where roll_id = ${rollId}`);
  await runtime.ctx.db.execute(sql`delete from rolls where id = ${rollId}`);
  await runtime.ctx.db.execute(sql`delete from devices where id = ${deviceId}`);
  await runtime.close();
});

/* ----------------------------------------------------------- export-roll -- */

describe('export-roll', () => {
  it('is registered under its job name', () => {
    expect(ROLL_HANDLERS['export-roll']).toBeDefined();
  });

  it('builds a ZIP at the key Task 21 presigns and marks the row done', async () => {
    const captureId = await newCapture('exp');
    const jobId = await claimExport();

    await exportRoll({ rollId, jobKey: `${jobId}:export-roll` }, runtime.ctx);

    const key = exportObjectKey(rollId, jobId);
    writtenKeys.push(key);

    // Verbatim the shape `apps/api/src/exports/exports.ts` computes. The route
    // presigns this exact string, so a drift here is a link to nothing.
    expect(key).toBe(`rolls/${rollId}/derived/exports/${jobId}.zip`);

    const body = await objectBytes(key);
    expect(body.subarray(0, 2).toString('latin1')).toBe('PK');

    const names = zipEntryNames(body);
    expect(names).toContain(`captures/${captureId}/original/cam-01.jpg`);
    expect(names).toContain(`captures/${captureId}/original/cam-02.jpg`);

    // The polling route's own pre-signature check, run against the same bucket.
    expect(await runtime.ctx.statObject(key)).toBe(body.length);

    const [row] = await runtime.ctx.db
      .select()
      .from(exportJobs)
      .where(eq(exportJobs.id, jobId));
    expect(row?.status).toBe('done');
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.error).toBeNull();
  });

  it('writes done only after storage has confirmed the object', async () => {
    const jobId = await claimExport();

    /*
     * The durable-before-done ruling, tested by watching the row *at the moment*
     * the confirmation runs. Asserting only the end state cannot tell the two
     * orders apart — a handler that wrote `done` first and then failed would land
     * on `failed` either way — so the check has to be inside the window.
     */
    let statusAtConfirmation: string | undefined;
    const watched: JobCtx = {
      ...runtime.ctx,
      statObject: async () => {
        const [row] = await runtime.ctx.db
          .select()
          .from(exportJobs)
          .where(eq(exportJobs.id, jobId));
        statusAtConfirmation = row?.status;
        // And the confirmation itself fails, which must not produce a `done` row.
        return null;
      },
    };

    await expect(exportRoll({ rollId, jobKey: `${jobId}:export-roll` }, watched)).rejects.toThrow(
      /not confirmed by storage/,
    );

    writtenKeys.push(exportObjectKey(rollId, jobId));

    expect(statusAtConfirmation).toBe('running');
    const [row] = await runtime.ctx.db
      .select()
      .from(exportJobs)
      .where(eq(exportJobs.id, jobId));
    expect(row?.status).toBe('failed');
  });

  it('marks the row failed on error, freeing the one-live-export index', async () => {
    const jobId = await claimExport();

    // An asset row whose object was never stored: the ZIP build reads it and the
    // read is what fails.
    await newCapture('ghost', { storeObjects: false });

    await expect(
      exportRoll({ rollId, jobKey: `${jobId}:export-roll` }, runtime.ctx),
    ).rejects.toThrow();

    const [row] = await runtime.ctx.db
      .select()
      .from(exportJobs)
      .where(eq(exportJobs.id, jobId));
    expect(row?.status).toBe('failed');
    expect(row?.error).toBeTruthy();

    // `export_jobs_roll_live` covers queued|running only, so a failed row leaves
    // the roll free to export again — which is the point of marking it.
    const next = await claimExport();
    expect(next).not.toBe(jobId);
  });

  it('does not retry a job whose row is gone', async () => {
    await expect(
      exportRoll({ rollId, jobKey: `exp_t25x_${RUN}_absent:export-roll` }, runtime.ctx),
    ).rejects.toBeInstanceOf(MissingExportJobError);
  });
});

/* ----------------------------------------------------------- purge-trash -- */

describe('purge-trash', () => {
  it('is registered under its job name', () => {
    expect(ROLL_HANDLERS['purge-trash']).toBeUndefined();
    // It is NOT in `ROLL_HANDLERS`: the purge is the one handler that needs a
    // capability no `JobCtx` carries, so it is registered by `main.ts` from a
    // factory rather than looked up in a table. See `storage/eraser.ts`.
  });

  it('hard-deletes objects AND rows past the grace period, and audits it', async () => {
    const expired = await newCapture('expired', { deletedDaysAgo: TRASH_GRACE_DAYS + 1 });
    const fresh = await newCapture('fresh', { deletedDaysAgo: 1 });

    const expiredKey = `rolls/${rollId}/captures/${expired}/original/cam-01.jpg`;
    const freshKey = `rolls/${rollId}/captures/${fresh}/original/cam-01.jpg`;
    expect(await runtime.ctx.statObject(expiredKey)).not.toBeNull();

    /*
     * The objects-before-rows ordering, watched from inside. Rows first would leave
     * `assets.object_key` — the only name those bytes have (05 §6) — deleted while
     * the bytes remain, which no end-state assertion can distinguish from the
     * correct order once both steps have run.
     */
    let assetRowsWhenErased = -1;
    const eraser = createEraser(config);
    const watched: MediaEraser = {
      eraseCapture: async (watchedRoll, watchedCapture) => {
        assetRowsWhenErased = (
          await runtime.ctx.db.select().from(assets).where(eq(assets.captureId, watchedCapture))
        ).length;
        return eraser.eraseCapture(watchedRoll, watchedCapture);
      },
      close: () => {
        eraser.close();
      },
    };
    try {
      await purgeTrash(watched)({ rollId, jobKey: 'system:purge-trash' }, runtime.ctx);
    } finally {
      watched.close();
    }
    expect(assetRowsWhenErased).toBe(2);

    // Objects first, then rows — both gone.
    expect(await runtime.ctx.statObject(expiredKey)).toBeNull();
    const rows = await runtime.ctx.db.select().from(captures).where(eq(captures.id, expired));
    expect(rows).toHaveLength(0);
    const assetRows = await runtime.ctx.db
      .select()
      .from(assets)
      .where(eq(assets.captureId, expired));
    expect(assetRows).toHaveLength(0);

    // One audit event per purge (03 §11: delete is destructive, so it is recorded).
    const audit = await runtime.ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.target, expired));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe(PURGE_AUDIT_ACTION);
    expect(audit[0]?.actor).toBe('system');
    expect(audit[0]?.rollId).toBe(rollId);

    // The capture still inside its grace period is untouched, bytes and rows.
    expect(await runtime.ctx.statObject(freshKey)).not.toBeNull();
    expect(
      await runtime.ctx.db.select().from(captures).where(eq(captures.id, fresh)),
    ).toHaveLength(1);
  });

  it('is re-entrant: a run interrupted after the objects finishes the rows', async () => {
    const half = await newCapture('half', { deletedDaysAgo: TRASH_GRACE_DAYS + 2 });

    // Exactly the state a kill between the two steps leaves behind: no objects,
    // all rows. The next run must finish the job rather than orphan them.
    for (let frameIndex = 1; frameIndex <= 2; frameIndex += 1) {
      await seeder.send(
        new DeleteObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: `rolls/${rollId}/captures/${half}/original/cam-0${String(frameIndex)}.jpg`,
        }),
      );
    }

    const eraser = createEraser(config);
    try {
      await purgeTrash(eraser)({ rollId, jobKey: 'system:purge-trash' }, runtime.ctx);
      // And running it again over nothing is a no-op, not a failure.
      await purgeTrash(eraser)({ rollId, jobKey: 'system:purge-trash' }, runtime.ctx);
    } finally {
      eraser.close();
    }

    expect(await runtime.ctx.db.select().from(captures).where(eq(captures.id, half))).toHaveLength(
      0,
    );
    const audit = await runtime.ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.target, half));
    expect(audit).toHaveLength(1);
  });
});

/* ------------------------------------------------- the deletion boundary -- */

describe('the purge escape', () => {
  it('leaves a derivative handler unable to delete an original', async () => {
    const captureId = await newCapture('guard');
    const original = `rolls/${rollId}/captures/${captureId}/original/cam-01.jpg`;

    // `ctx.s3` is the only S3 client a handler is handed, and this is what it
    // says to a delete under `original/`.
    await expect(
      runtime.ctx.s3.send(
        new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: original }),
      ),
    ).rejects.toBeInstanceOf(OriginalWriteError);

    // The object is still there, which is the assertion that matters.
    expect(await runtime.ctx.statObject(original)).not.toBeNull();

    // And the eraser is not reachable *through* the context: there is no member
    // of `JobCtx` that can delete anything.
    expect(Object.keys(runtime.ctx).sort()).toEqual([
      'db',
      'getObject',
      'putDerived',
      'putRollDerivedFile',
      'redis',
      's3',
      'statObject',
    ]);
  });

  it('is a delete-only client: the eraser cannot write a byte anywhere', async () => {
    const eraser = createEraser(config);
    try {
      // Reaching inside on purpose: the trade this escape makes is that it gains
      // delete-on-original and loses every write, and that half has to be
      // checked too. `createEraser` exposes no put, so the guard is asserted
      // through a client built the same way.
      const client = new S3Client({
        endpoint: config.S3_ENDPOINT,
        region: config.S3_REGION,
        forcePathStyle: true,
        credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
      });
      const { guardEraseOnly } = await import('../src/storage/eraser');
      guardEraseOnly(client);

      await expect(
        client.send(
          new PutObjectCommand({
            Bucket: config.S3_BUCKET,
            Key: `rolls/${rollId}/captures/cap_x/derived/thumb.webp`,
            Body: Buffer.from('no'),
          }),
        ),
      ).rejects.toBeInstanceOf(EraseCommandError);

      await expect(
        client.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: `rolls/${rollId}/` })),
      ).rejects.toBeInstanceOf(EraseScopeError);

      client.destroy();
    } finally {
      eraser.close();
    }
  });

  it('refuses to erase outside one capture folder', async () => {
    const eraser = createEraser(config);
    try {
      await expect(eraser.eraseCapture('..', 'cap_x')).rejects.toThrow();
      await expect(eraser.eraseCapture(rollId, '')).rejects.toThrow();
    } finally {
      eraser.close();
    }
  });
});
