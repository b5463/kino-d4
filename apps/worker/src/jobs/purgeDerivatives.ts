import { DeleteObjectsCommand, type ObjectIdentifier } from '@aws-sdk/client-s3';
import { and, asc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { exportJobs, recapJobs } from '../db/schema';
import { exportObjectKey, recapObjectKey } from '../storage/derived';
import { errorFields, log } from '../log';
import type { JobCtx, WorkerDatabase } from './types';

/**
 * Retention for the two artifacts that belong to a *roll* (05 §6), not to a
 * capture: `rolls/<rollId>/derived/exports/<jobId>.zip` and
 * `rolls/<rollId>/derived/recap/<jobId>.mp4`.
 *
 * ## The leak
 *
 * `purge-trash` retires a capture's objects when the capture is deleted. Nothing
 * ever retired these. Every press of "download everything" wrote a new ZIP under
 * a new job id and left the previous one in the bucket forever — a 1,900-capture
 * roll is around 17 GB per press — and every recap did the same with an MP4. The
 * host who presses the button three times on a Sunday morning has paid for three
 * copies of their party for as long as the bucket exists.
 *
 * ## 48 hours, and why the row goes too
 *
 * The API already calls these "expiring links" (03 §25): the artifact is a
 * convenience copy of media the platform still holds, produced in minutes and
 * meant to be downloaded that evening. Two days covers a host who queued the
 * export at the party and opened their laptop the next day.
 *
 * The row is deleted with the object rather than left behind, because the key is
 * *computed* from `(rollId, jobId)` — there is no `object_key` column to null
 * out, so the row IS the pointer. A row that says `done` over a deleted object
 * is exactly the state `host-export.ts` logs an error about on every poll and
 * cannot explain to the host; a deleted row is a clean 404 that means "that link
 * has expired", which is what actually happened.
 *
 * ## Objects before rows
 *
 * The same ordering, and the same reason, as `purgeTrash`: the row is the only
 * thing that can name the object, so a run that dropped the row first and then
 * died would leave bytes nothing can ever find. Objects first means a crash
 * costs one repeated delete of an object that is already gone, which S3 treats
 * as success.
 */

/** How long a roll-level artifact outlives the job that produced it. */
export const DERIVED_RETENTION_HOURS = 48;

/** Rows per pass, and the S3 cap on one `DeleteObjects` request. */
export const DERIVED_PURGE_BATCH = 500;

/**
 * The only keys this may delete: one roll's `derived/exports/` or
 * `derived/recap/` folder, with the roll id held to a single path segment.
 *
 * The same discipline as `CAPTURE_SCOPED` in the eraser, and here for the same
 * reason — this is a delete path, and a delete path states what it may address
 * rather than trusting that its callers built the key correctly. Both key
 * builders already assert their segments; this is the check that survives
 * somebody adding a third caller.
 */
const ROLL_DERIVED_SCOPED =
  /^rolls\/[A-Za-z0-9][A-Za-z0-9._-]*\/derived\/(exports|recap)\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface DerivedPurgeResult {
  /** Export rows retired. */
  exports: number;
  /** Recap rows retired. */
  recaps: number;
  /** Objects storage reported as deleted. */
  objects: number;
  /** Objects storage refused to delete; their rows are kept for the next run. */
  failures: number;
}

/** A row that is finished and old enough to lose its artifact. */
interface ExpiredJobRow {
  id: string;
  rollId: string;
  finishedAt: Date | null;
}

/**
 * Whether a finished row is past the retention window, checked again in Node.
 *
 * The SQL below already applies the cutoff, and PostgreSQL's clock is the one
 * that stamped `finished_at`, so this is not the decision — it is a second
 * opinion in front of a delete. It can only ever *refuse* to delete something
 * the database offered (a worker whose container drifted an hour behind waits an
 * hour longer), which is the safe direction to be wrong about destroying a
 * host's archive copy.
 *
 * A row with no `finished_at` is not expired: it is a row whose job never
 * recorded an ending, and this is not the code that decides what to do with it.
 */
export function isExpired(finishedAt: Date | null, now: Date, hours: number): boolean {
  if (finishedAt === null) return false;
  return now.getTime() - finishedAt.getTime() >= hours * 60 * 60 * 1000;
}

/**
 * The finished export or recap rows older than the cutoff.
 *
 * `finished_at` is the clock that matters — a row is expired 48 hours after it
 * *stopped*, not after it was queued — and the cutoff is computed by PostgreSQL
 * so a worker whose container drifted an hour ahead cannot purge an hour early.
 * The same reasoning as `expiredCaptures`.
 *
 * Only `done` and `failed` rows: a row still `queued` or `running` belongs to a
 * job that may yet write the object, and deleting it under a running export is
 * how a host gets a ZIP with no row to describe it.
 */
async function expiredJobRows(
  db: WorkerDatabase,
  table: typeof exportJobs | typeof recapJobs,
  hours: number,
  limit: number,
): Promise<ExpiredJobRow[]> {
  return db
    .select({ id: table.id, rollId: table.rollId, finishedAt: table.finishedAt })
    .from(table)
    .where(
      and(
        or(eq(table.status, 'done'), eq(table.status, 'failed')),
        lt(table.finishedAt, sql`now() - (${hours} * interval '1 hour')`),
      ),
    )
    .orderBy(asc(table.finishedAt))
    .limit(limit);
}

/**
 * Deletes the objects, and reports which keys storage confirmed.
 *
 * `Quiet: false` so `Errors` comes back populated, exactly as the capture eraser
 * asks for it: a key whose delete failed must not have its row dropped, or the
 * bytes are orphaned. A missing object is not an error — S3 reports a delete of
 * a key that was never there as deleted — which is what makes a second pass over
 * a half-finished run harmless.
 */
async function deleteObjects(
  ctx: JobCtx,
  keys: readonly string[],
): Promise<{ deleted: Set<string>; failed: Set<string> }> {
  const deleted = new Set<string>();
  const failed = new Set<string>();
  if (keys.length === 0) return { deleted, failed };

  const objects: ObjectIdentifier[] = keys.map((Key) => ({ Key }));
  const result = await ctx.s3.send(
    new DeleteObjectsCommand({
      Bucket: ctx.bucket,
      Delete: { Objects: objects, Quiet: false },
    }),
  );

  for (const entry of result.Deleted ?? []) {
    if (typeof entry.Key === 'string') deleted.add(entry.Key);
  }
  for (const entry of result.Errors ?? []) {
    if (typeof entry.Key !== 'string') continue;
    failed.add(entry.Key);
    log.warn('could not delete expired roll derivative', {
      key: entry.Key,
      code: entry.Code,
      reason: entry.Message,
    });
  }
  // Storage that answered neither Deleted nor Errors for a key told us nothing;
  // treating that as success would drop the row over an unproven delete.
  for (const key of keys) {
    if (!deleted.has(key) && !failed.has(key)) failed.add(key);
  }
  return { deleted, failed };
}

async function purgeOne(
  ctx: JobCtx,
  table: typeof exportJobs | typeof recapJobs,
  keyFor: (rollId: string, jobId: string) => string,
  hours: number,
  limit: number,
  now: Date,
): Promise<{ rows: number; objects: number; failures: number }> {
  const rows = await expiredJobRows(ctx.db, table, hours, limit);
  if (rows.length === 0) return { rows: 0, objects: 0, failures: 0 };

  const keyByRow = new Map<string, string>();
  for (const row of rows) {
    // A row the query offered but this clock does not agree is old enough is
    // left for the next run. See `isExpired`.
    if (!isExpired(row.finishedAt, now, hours)) continue;
    const key = keyFor(row.rollId, row.id);
    if (!ROLL_DERIVED_SCOPED.test(key)) {
      // Not reachable through the key builders, which assert their own segments.
      // It is here so that if it ever becomes reachable, the answer is a warning
      // and a skipped row rather than a delete outside the allowlist.
      log.warn('expired roll derivative key is out of scope; left alone', { key });
      continue;
    }
    keyByRow.set(row.id, key);
  }

  const { deleted, failed } = await deleteObjects(ctx, [...keyByRow.values()]);

  // Only the rows whose object is provably gone. A row kept because its delete
  // failed is selected again on the next run, which is the whole recovery.
  const retiring = [...keyByRow.entries()]
    .filter(([, key]) => deleted.has(key))
    .map(([id]) => id);
  if (retiring.length > 0) {
    await ctx.db.delete(table).where(inArray(table.id, retiring));
  }

  return { rows: retiring.length, objects: deleted.size, failures: failed.size };
}

/**
 * One pass over both tables.
 *
 * Bounded per run for the same reason the capture purge is: the selection is
 * re-derived from `finished_at` every time, so what does not fit today is picked
 * up tomorrow, and no single run can hold a BullMQ lock for an hour.
 */
export async function purgeExpiredDerivatives(
  ctx: JobCtx,
  hours: number = DERIVED_RETENTION_HOURS,
  limit: number = DERIVED_PURGE_BATCH,
  now: Date = new Date(),
): Promise<DerivedPurgeResult> {
  const result: DerivedPurgeResult = { exports: 0, recaps: 0, objects: 0, failures: 0 };

  for (const [table, keyFor] of [
    [exportJobs, exportObjectKey],
    [recapJobs, recapObjectKey],
  ] as const) {
    try {
      const pass = await purgeOne(ctx, table, keyFor, hours, limit, now);
      if (table === exportJobs) result.exports += pass.rows;
      else result.recaps += pass.rows;
      result.objects += pass.objects;
      result.failures += pass.failures;
    } catch (err) {
      // One table's failure must not cost the other its pass, and neither may
      // cost the capture purge its run — the whole point of this job is that it
      // finishes what it can. The next run re-derives the same selection.
      result.failures += 1;
      log.error('roll derivative purge pass failed', errorFields(err, log.level === 'debug'));
    }
  }

  return result;
}
