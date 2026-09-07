import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { UnrecoverableError } from 'bullmq';
import { ZipFile } from 'yazl';
import { assets, exportJobs } from '../db/schema';
import { exportObjectKey } from '../storage/derived';
import { log } from '../log';
import { jobRowIdOf, loadRollCaptures, requireRollId } from './roll';
import type { JobCtx, JobPayload, WorkerDatabase } from './types';

/**
 * `export-roll` — the host's "download everything", as a ZIP (03 §25).
 *
 * Task 21 built both ends of this and left the middle: the POST claims an
 * `export_jobs` row and queues this job, and `GET
 * /api/host/rolls/:rollId/export/:jobId` answers `{status, url?}`, presigning
 * `rolls/<rollId>/derived/exports/<jobId>.zip` **only when the object is
 * actually there**. This is the part that moves the row and writes the file.
 *
 * ## Originals *and* processed
 *
 * 03 §25 lists both under the host's downloads, so both go in: every `ready`
 * asset of every capture that is not in the trash. Hidden captures are included —
 * hide means "retained for host/archive" (03 §11), and a host's own archive is
 * exactly the place a hidden photo still belongs.
 *
 * ## The entry paths are the bucket's own layout
 *
 * An entry is its object key with `rolls/<rollId>/` removed, so the ZIP unpacks
 * into `captures/<captureId>/original/cam-01.jpg` and
 * `captures/<captureId>/derived/still.webp`. Derived from the key rather than
 * invented, which means the archive is self-describing and there is no second
 * naming scheme to keep in step with 05 §6. A key that somehow did not sit under
 * the roll's prefix is skipped rather than flattened to its basename — a
 * mysterious file at the root of a host's export is worse than an absent one, and
 * the log says which.
 *
 * ## Store, do not deflate
 *
 * Every byte in here is already compressed — JPEG frames, WebP stills, H.264
 * MP4s. Deflating them spends minutes of CPU on a roll to make the archive
 * marginally *larger*. `compress: false` on every entry.
 *
 * ## The ZIP is built on disk, and `done` waits for storage
 *
 * The ruling carried from Task 21's review: **the row does not move to `done`
 * until the object is durable.** The GET returns `{status:'done'}` with no url
 * when the object is missing, which to a host is a finished job that produced
 * nothing and no way to tell that from a broken service. So the order is: write
 * the ZIP to a temp file, upload it, HEAD it, compare the length, and only then
 * write `done`. A failure at any point leaves the row `failed`, which frees
 * `export_jobs_roll_live` so the host's next press claims a fresh row.
 */

/** The job's `export_jobs` row is gone, so there is nothing to export into. */
export class MissingExportJobError extends UnrecoverableError {
  readonly code = 'EXPORT_JOB_NOT_FOUND';

  constructor(jobId: string, rollId: string) {
    super(`export job ${jobId} of roll ${rollId} does not exist`);
    this.name = 'MissingExportJobError';
  }
}

/** The ZIP was uploaded and storage does not have it, or has a different length. */
export class ExportNotDurableError extends Error {
  readonly code = 'EXPORT_NOT_DURABLE';

  constructor(key: string, expected: number, stored: number | null) {
    super(
      `export upload to ${key} was not confirmed by storage: expected ${String(expected)} ` +
        `bytes, storage reports ${stored === null ? 'no object' : `${String(stored)} bytes`}`,
    );
    this.name = 'ExportNotDurableError';
  }
}

/** The staging disk cannot hold the archive this roll would produce. */
export class ExportDiskSpaceError extends Error {
  readonly code = 'EXPORT_NO_DISK_SPACE';

  constructor(dir: string, needed: number, free: number) {
    super(
      `not enough space in ${dir} for this export: needs about ${String(
        Math.ceil(needed / 1_000_000),
      )} MB, ${String(Math.floor(free / 1_000_000))} MB free`,
    );
    this.name = 'ExportDiskSpaceError';
  }
}

/** Asset statuses whose object is actually stored. */
const READY = 'ready';

/**
 * What the archive costs on top of the bytes it stores.
 *
 * Entries are stored, not deflated (see the note above), so the ZIP is the sum
 * of the objects plus a local header and a central-directory record per entry —
 * a few hundred bytes each, which on a 1,900-capture roll is single-digit
 * megabytes. The 5 % is not that arithmetic; it is the refusal to fill a disk to
 * its last byte, because the thing sharing that disk is every other job's temp
 * directory.
 */
const EXPORT_HEADROOM = 1.05;

/**
 * How many bytes the roll's stored assets add up to.
 *
 * Read off `assets.bytes` rather than HEADed one object at a time: a
 * 1,900-capture roll is ~7,600 objects, and 7,600 HEAD requests to answer "will
 * this fit" would cost more than the export. The column is written by the upload
 * path from the length it actually stored, so it is the same number.
 */
async function plannedBytes(
  db: WorkerDatabase,
  captureIds: readonly string[],
): Promise<number> {
  if (captureIds.length === 0) return 0;
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${assets.bytes}), 0)` })
    .from(assets)
    .where(and(inArray(assets.captureId, [...captureIds]), eq(assets.status, READY)));
  return Number(row?.total ?? 0);
}

/**
 * Refuses the job before it starts filling the disk.
 *
 * The failure this replaces is the ugly one: a 1,900-capture roll is around
 * 17 GB, and a worker whose staging volume is smaller than that writes until
 * `ENOSPC` — by which point the volume is full, and every *other* job on this
 * worker (every wiggle render, every recap) fails on its own temp file until
 * somebody notices. Asking first turns a worker-wide outage into one export row
 * that says `failed` and why.
 *
 * A plain `Error`, not an `UnrecoverableError`: a full disk is usually somebody
 * else's export finishing, so the four remaining attempts with their exponential
 * backoff are a real chance rather than four repetitions of the same answer.
 */
async function assertSpaceFor(dir: string, needed: number): Promise<void> {
  const { bsize, bavail } = await statfs(dir);
  // `bavail` is what an unprivileged process may use, which is the number that
  // matters — `bfree` includes the root-reserved blocks this worker cannot have.
  const free = bsize * bavail;
  if (free < needed) throw new ExportDiskSpaceError(dir, needed, free);
}

/**
 * Adds one object as an entry that is fetched only when yazl reaches it.
 *
 * The bug this closes: `addReadStream(await ctx.getObject(key), …)` in a loop
 * opened *every* GET up front, and yazl drains its entries strictly in order, so
 * on a 1,900-capture roll thousands of S3 response bodies sat open and idle
 * waiting their turn. The SDK's socket pool is the first thing that runs out;
 * the ones that get a socket then sit there long enough for the server to close
 * them, and the ZIP dies somewhere in the middle with a read timeout.
 *
 * `addReadStreamLazy` is yazl's own answer: it calls back for the stream at the
 * moment it starts writing that entry, so exactly one object is open at a time —
 * which is also the only number that is *correct* here, since the archive is
 * written sequentially and there is nothing for a second open body to be doing.
 *
 * The callback shape is yazl's `(err, stream)`. On failure the error goes back
 * through it rather than being thrown: yazl turns that into an `error` event on
 * the ZipFile, which `writeZip` is what converts into a rejected build. Throwing
 * out of the callback instead would take the process down, because yazl calls it
 * from its own pump rather than from this function.
 */
function addLazyEntry(zip: ZipFile, ctx: JobCtx, key: string, entry: string): void {
  zip.addReadStreamLazy(entry, { compress: false }, (cb) => {
    ctx.getObject(key).then(
      (body) => {
        cb(null, body);
      },
      (err: unknown) => {
        // yazl's typing insists on a second argument it never reads on the
        // error path; there is no stream to give it.
        cb(err, null as unknown as Readable);
      },
    );
  });
}

/**
 * Claims the row for this attempt.
 *
 * `running` from wherever it was, including `failed`: a retry of the same BullMQ
 * job is the same unit of work on the same row, and leaving it `failed` while the
 * job is plainly running would be a lie the polling host reads. The row id is in
 * the WHERE together with the roll id, so a job cannot move a row that belongs to
 * another roll however its payload is spelled.
 *
 * No row means the API never claimed one or something deleted it, and neither is
 * repaired by waiting — hence `UnrecoverableError`.
 */
async function claimExportRow(db: WorkerDatabase, jobId: string, rollId: string): Promise<void> {
  const claimed = await db
    .update(exportJobs)
    .set({ status: 'running', error: null, finishedAt: null })
    .where(and(eq(exportJobs.id, jobId), eq(exportJobs.rollId, rollId)))
    .returning({ id: exportJobs.id });

  if (claimed.length === 0) throw new MissingExportJobError(jobId, rollId);
}

async function finishExportRow(
  db: WorkerDatabase,
  jobId: string,
  status: 'done' | 'failed',
  error: string | null,
): Promise<void> {
  await db
    .update(exportJobs)
    .set({ status, error, finishedAt: new Date() })
    .where(eq(exportJobs.id, jobId));
}

/** The entry path for an object key, or `null` when the key is not this roll's. */
export function exportEntryPath(rollId: string, objectKey: string): string | null {
  const prefix = `rolls/${rollId}/`;
  return objectKey.startsWith(prefix) ? objectKey.slice(prefix.length) : null;
}

/**
 * Writes the ZIP to `path`.
 *
 * Each object is streamed from storage straight into the archive — the whole
 * point of building on disk is that no part of a gigabyte roll is ever fully in
 * memory. `addReadStream` takes the stream; yazl pulls from it as it writes, and
 * `end()` is what emits the central directory.
 *
 * @returns the entry paths written, for the log and for the tests.
 */
async function writeZip(
  ctx: JobCtx,
  rollId: string,
  path: string,
  captureIds: readonly string[],
): Promise<string[]> {
  const zip = new ZipFile();
  const written: string[] = [];

  /*
   * yazl reports every failure by emitting `error` on the ZipFile — a lazy
   * entry's callback error included — and it does **not** touch `outputStream`
   * when it does. So without this the piped write stream never ends: `drained`
   * neither resolves nor rejects, and an export whose first object is missing
   * hangs instead of failing. (It also means an unhandled `error` event, which
   * on an EventEmitter is a thrown exception in whatever tick yazl is in.)
   *
   * Destroying the source with the error is what turns yazl's event into a
   * rejected `pipeline`, which is the only path this function has for failing —
   * and failing is what moves the `export_jobs` row to `failed` and frees
   * `export_jobs_roll_live` for the host's next press.
   */
  zip.on('error', (err: Error) => {
    (zip.outputStream as Readable).destroy(err);
  });

  // The output is piped before anything is added, so yazl's stream is being
  // drained while the entries are still arriving rather than buffering them.
  const drained = pipeline(zip.outputStream, createWriteStream(path));

  try {
    for (const captureId of captureIds) {
      const rows = await ctx.db
        .select({ objectKey: assets.objectKey, role: assets.role, frameIndex: assets.frameIndex })
        .from(assets)
        .where(and(eq(assets.captureId, captureId), eq(assets.status, READY)));

      // Sorted by key so the archive's order is a function of the roll and not of
      // whatever order PostgreSQL felt like returning.
      for (const row of [...rows].sort((a, b) => a.objectKey.localeCompare(b.objectKey))) {
        const entry = exportEntryPath(rollId, row.objectKey);
        if (entry === null) {
          log.warn('export asset is not under this roll; skipped', {
            rollId,
            objectKey: row.objectKey,
          });
          continue;
        }
        addLazyEntry(zip, ctx, row.objectKey, entry);
        written.push(entry);
      }
    }
  } catch (err) {
    // End the archive before propagating, or the piped write stream never closes
    // and `drained` hangs instead of rejecting.
    zip.end();
    await drained.catch(() => {});
    throw err;
  }

  zip.end();
  await drained;
  return written;
}

export async function exportRoll(payload: JobPayload, ctx: JobCtx): Promise<void> {
  const rollId = requireRollId(payload);
  const jobId = jobRowIdOf(payload);

  await claimExportRow(ctx.db, jobId, rollId);

  try {
    const captures = await loadRollCaptures(ctx.db, rollId, { includeHidden: true });

    const captureIds = captures.map((capture) => capture.id);
    const dir = await mkdtemp(join(tmpdir(), `kino-export-${jobId}-`));
    const zipPath = join(dir, 'export.zip');

    try {
      // Before a single byte is written, and after the directory exists so the
      // question is about the filesystem the ZIP will actually land on.
      const needed = Math.ceil((await plannedBytes(ctx.db, captureIds)) * EXPORT_HEADROOM);
      await assertSpaceFor(dir, needed);

      const entries = await writeZip(
        ctx,
        rollId,
        zipPath,
        captureIds,
      );

      const key = await ctx.putRollDerivedFile(
        rollId,
        `exports/${jobId}.zip`,
        zipPath,
        'application/zip',
      );

      /*
       * Durable before done. The length is compared, not merely the object's
       * existence: a truncated upload leaves an object at the key, and a HEAD that
       * only asked "is something there" would sign a link to a broken archive.
       */
      const { size } = await stat(zipPath);
      const stored = await ctx.statObject(key);
      if (stored === null || stored !== size) {
        throw new ExportNotDurableError(key, size, stored);
      }

      log.info('export written', { jobId, rollId, entries: entries.length, bytes: size, key });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    await finishExportRow(ctx.db, jobId, 'done', null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `failed` rather than left `running`, and that is what frees
    // `export_jobs_roll_live`: a row stuck in `running` would lock the roll out of
    // exporting again for as long as it sat there, which for a host who lost a
    // 4 GB download is forever.
    await finishExportRow(ctx.db, jobId, 'failed', message.slice(0, 500));
    throw err;
  }
}

/** Where the ZIP of one job would be, for a caller that has the ids. */
export function exportKeyFor(rollId: string, jobId: string): string {
  return exportObjectKey(rollId, jobId);
}

/** The statuses a live export row can be in, mirrored from the API's own list. */
export const EXPORT_LIVE_STATUSES = ['queued', 'running'] as const;

/** Whether a roll currently has an export in flight. Used by tests and by logs. */
export async function hasLiveExport(db: WorkerDatabase, rollId: string): Promise<boolean> {
  const rows = await db
    .select({ id: exportJobs.id })
    .from(exportJobs)
    .where(
      and(eq(exportJobs.rollId, rollId), inArray(exportJobs.status, [...EXPORT_LIVE_STATUSES])),
    )
    .limit(1);
  return rows.length > 0;
}
