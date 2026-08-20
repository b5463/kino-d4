import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { UnrecoverableError } from 'bullmq';
import { ZipFile } from 'yazl';
import { assets, exportJobs } from '../db/schema';
import { exportObjectKey } from '../storage/derived';
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

/** Asset statuses whose object is actually stored. */
const READY = 'ready';

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
          console.warn(
            `[worker] export ${rollId}: asset ${row.objectKey} is not under this roll; skipped`,
          );
          continue;
        }
        zip.addReadStream(await ctx.getObject(row.objectKey), entry, { compress: false });
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

    const dir = await mkdtemp(join(tmpdir(), `kino-export-${jobId}-`));
    const zipPath = join(dir, 'export.zip');

    try {
      const entries = await writeZip(
        ctx,
        rollId,
        zipPath,
        captures.map((capture) => capture.id),
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

      console.log(
        `[worker] export ${jobId}: ${String(entries.length)} entries, ${String(size)} bytes at ${key}`,
      );
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
