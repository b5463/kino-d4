import { sql } from 'drizzle-orm';
import { TRASH_GRACE_DAYS } from '@kino/schemas';
import { auditEvents } from '../db/schema';
import { newId } from '../ids';
import { errorFields, log } from '../log';
import type { MediaEraser } from '../storage/eraser';
import { purgeExpiredDerivatives, type DerivedPurgeResult } from './purgeDerivatives';
import { reapStaleUploads, type UploadReapResult } from './purgeUploads';
import type { JobCtx, JobHandler, JobPayload, WorkerDatabase } from './types';

/**
 * `purge-trash` — the end of the grace period (03 §11).
 *
 * Delete is destructive. Task 21 made it *deferred* — `captures.deleted_at` plus a
 * seven-day `purgeAfter` — and nothing enforced it, so the trash was a label. This
 * is the job that makes it true: every capture whose `deleted_at` is older than
 * the grace period loses its objects, then its rows, and leaves one audit event
 * behind saying so.
 *
 * It is the only code in the platform allowed to delete an original. How that is
 * arranged, and why a derivative handler cannot get at it, is the long note in
 * `src/storage/eraser.ts`.
 *
 * ## Objects first, then rows — and why that order is not negotiable
 *
 * The two orders fail differently and only one of the failures is repairable.
 *
 * Rows first: the process dies, and the objects are left in the bucket with
 * nothing that names them. `assets.object_key` was the only link (05 §6) and it is
 * gone, so those bytes are unreachable and undeletable — a guest's photos sitting
 * in storage forever after the host deleted them, which is the one outcome 03 §11
 * cannot tolerate.
 *
 * Objects first: the process dies, and the rows are still there, still expired,
 * still selected by the very next run. The work resumes.
 *
 * ## Re-entrancy, in three parts
 *
 * 1. **The selection is a fact about the world, not a claim on it.** "Captures
 *    whose `deleted_at` is older than the cutoff" is re-evaluated from scratch on
 *    every run. A capture whose objects went and whose rows did not is still
 *    expired, so it is still selected; nothing has to have been marked, and there
 *    is no half-state to recover.
 * 2. **Erasing is idempotent.** `eraseCapture` lists what the folder holds and
 *    deletes it. On a second pass the folder holds nothing, the list is empty, and
 *    it returns 0 — which is a normal outcome and not an error.
 * 3. **The rows go in one transaction, with the audit event inside it.** So the
 *    capture is either fully gone and recorded, or fully present and unrecorded.
 *    There is no state where the audit trail claims a purge that did not finish,
 *    and no state where a purge finished unrecorded.
 *
 * Killing the process at any point therefore costs at most one capture's worth of
 * repeated listing. `tests/rollJobs.test.ts` kills it at the worst moment — after
 * the objects, before the rows — and asserts the next run finishes.
 *
 * ## Why the objects are listed rather than read off the rows
 *
 * See `eraseCapture`. A capture can hold an object no row names, and the rows are
 * about to be deleted; listing the folder is the only pass that can be complete.
 */

/** Re-export the shared retention contract for callers and acceptance tests. */
export { TRASH_GRACE_DAYS };

/** The audit action a purge writes. */
export const PURGE_AUDIT_ACTION = 'capture.purged';

/**
 * How many captures one pass claims.
 *
 * Batched because a party's worth of deletions is a long transaction otherwise,
 * and because a purge that ran for an hour would hold its BullMQ lock for an hour.
 * The loop keeps going until a pass finds nothing, so the batch size bounds the
 * work per query, not the work per run.
 */
export const PURGE_BATCH = 100;

/**
 * A ceiling on one run, so a database with a million expired captures cannot turn
 * the daily purge into an unbounded job. What is left over is picked up tomorrow —
 * or by the next manual run — because the selection is re-derived every time.
 */
export const PURGE_MAX_PER_RUN = 5_000;

/** The daily schedule (03 §11's grace period has day granularity, so does this). */
export const PURGE_CRON = '17 4 * * *';

export interface PurgeResult {
  captures: number;
  objects: number;
  /**
   * Captures this run could not erase. Counted rather than thrown, because one
   * capture's stuck object must not hold the queue behind it — see the note on
   * isolation below.
   */
  failures: number;
  /** Roll-level exports and recaps retired this run (`purgeExpiredDerivatives`). */
  derived: DerivedPurgeResult;
  /** Abandoned upload sessions reaped this run (`reapStaleUploads`). */
  uploads: UploadReapResult;
}

interface ExpiredCapture {
  id: string;
  /**
   * `roll_id`, not `rollId`: `db.execute` returns the driver's own rows, which
   * carry the column names PostgreSQL sent rather than drizzle's camel-cased
   * aliases.
   */
  roll_id: string;
  [column: string]: unknown;
}

/**
 * The expired captures, oldest deletion first.
 *
 * The cutoff is computed by PostgreSQL (`now() - interval`), not by Node. One
 * clock decides, and it is the clock that wrote `deleted_at` — a worker whose
 * container drifted an hour ahead must not purge an hour early.
 *
 * `rollId` narrows the scan to one roll when the payload names one. The scheduled
 * run names none and sweeps everything; a targeted run is what a host support
 * request and this suite's tests both want, and scoping it is the difference
 * between a test that deletes its own fixtures and one that deletes yours.
 */
async function expiredCaptures(
  db: WorkerDatabase,
  rollId: string | null,
  limit: number,
): Promise<ExpiredCapture[]> {
  const rows = await db.execute<ExpiredCapture>(sql`
    select id, roll_id
      from captures
     where deleted_at is not null
       and deleted_at < now() - (${TRASH_GRACE_DAYS} * interval '1 day')
       ${rollId === null ? sql`` : sql`and roll_id = ${rollId}`}
     order by deleted_at asc
     limit ${limit}
  `);
  return Array.from(rows);
}

/**
 * Drops every row that belongs to a capture, and records the purge, atomically.
 *
 * The order inside is dictated by the foreign keys, not by preference:
 * `upload_parts` → `upload_sessions` (which reference `assets.id`) → `reactions`
 * and `processing_events` (which reference `captures.id`) → `assets` → the capture
 * itself. Getting it wrong is a constraint violation rather than a silent leak,
 * which is the right way for this to be wrong.
 *
 * Raw SQL because every statement but one is a delete keyed on a subquery, and
 * spelling those through the query builder would mean mirroring four more tables
 * into this workspace's schema to no benefit.
 */
async function dropCaptureRows(db: WorkerDatabase, capture: ExpiredCapture): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      delete from upload_parts
       where upload_id in (
         select us.id from upload_sessions us
           join assets a on a.id = us.asset_id
          where a.capture_id = ${capture.id})
    `);
    await tx.execute(sql`
      delete from upload_sessions
       where asset_id in (select id from assets where capture_id = ${capture.id})
    `);
    await tx.execute(sql`delete from reactions where capture_id = ${capture.id}`);
    await tx.execute(sql`delete from processing_events where capture_id = ${capture.id}`);
    await tx.execute(sql`delete from assets where capture_id = ${capture.id}`);

    /*
     * The audit row is written in the same transaction as the deletions, for the
     * same reason `claimExportJob` does it: a trail that can lose entries when a
     * later statement fails reads as authoritative while being incomplete.
     *
     * `target` is the capture id — the only durable name the capture has left
     * once its rows are gone. The object count goes in the action's payload
     * position, which `audit_events` does not have, so it goes to the log instead
     * of being smuggled into a text column nobody parses.
     */
    await tx.insert(auditEvents).values({
      id: newId('aud'),
      rollId: capture.roll_id,
      actor: 'system',
      action: PURGE_AUDIT_ACTION,
      target: capture.id,
    });

    await tx.execute(sql`delete from captures where id = ${capture.id}`);
  });
}

/**
 * The handler, built around an eraser.
 *
 * A factory rather than a plain `JobHandler` because the capability this job needs
 * — a client that may delete an original — is deliberately absent from `JobCtx`.
 * `main.ts` mints one and closes over it here; nothing a handler is handed can
 * reach it. See `src/storage/eraser.ts`.
 */
/**
 * One capture's worth of purge, isolated.
 *
 * ## Why one bad object used to stop everything
 *
 * The selection is oldest-deletion-first, and `eraseCapture` throws on the first
 * `DeleteObjects` error. So a single capture whose object storage will not let go
 * of — a lifecycle rule holding one key, a permission that drifted, an
 * object-lock retention nobody remembers setting — threw out of the whole
 * handler on every run. Because it is the *oldest*, it was first in every batch,
 * forever: every capture deleted after it stayed in the bucket and in the
 * database, and the 03 §11 grace period silently stopped meaning anything for
 * the entire deployment. One stuck key, every guest's deleted photo retained.
 *
 * So the failure is recorded and the run continues. What is deliberately *not*
 * relaxed is anything the purge is careful about: objects still go before rows,
 * a capture whose erase failed keeps its rows (so it is selected again next run),
 * the prefix allowlist and the batching inside `eraseCapture` are untouched, and
 * `PURGE_MAX_PER_RUN` still bounds the run. A failure here costs one capture a
 * day, not the platform its retention.
 *
 * @returns the objects erased, or `null` when this capture could not be erased.
 */
async function purgeOneCapture(
  eraser: MediaEraser,
  db: WorkerDatabase,
  capture: ExpiredCapture,
): Promise<number | null> {
  try {
    // Objects first. If this throws, the rows stay and the next run tries
    // again — see the re-entrancy note above.
    const objects = await eraser.eraseCapture(capture.roll_id, capture.id);
    await dropCaptureRows(db, capture);
    log.debug('purged capture', { captureId: capture.id, rollId: capture.roll_id, objects });
    return objects;
  } catch (err) {
    log.error('could not purge capture; its rows are kept for the next run', {
      captureId: capture.id,
      rollId: capture.roll_id,
      ...errorFields(err, log.level === 'debug'),
    });
    return null;
  }
}

/**
 * One retention run, and what it managed.
 *
 * Separate from the handler so the counts are a *value* rather than a log line:
 * `JobHandler` returns void, and "how many captures could not be erased" is the
 * number somebody has to be able to assert on. The handler below is the thin
 * part that turns this into one structured line.
 */
export async function runPurge(
  eraser: MediaEraser,
  ctx: JobCtx,
  rollId: string | null,
): Promise<PurgeResult> {
  const result: PurgeResult = {
      captures: 0,
      objects: 0,
      failures: 0,
      derived: { exports: 0, recaps: 0, objects: 0, failures: 0 },
      uploads: { aborted: 0, multiparts: 0, failures: 0 },
    };

    /*
     * The captures this run has already given up on. Without it the loop cannot
     * terminate: a failed capture keeps its rows, so it is still expired, so the
     * very next `expiredCaptures` returns it first — and the pass would try the
     * same stuck key until the process was killed.
     */
    const skip = new Set<string>();

    while (result.captures + result.failures < PURGE_MAX_PER_RUN) {
      const batch = await expiredCaptures(
        ctx.db,
        rollId,
        Math.min(PURGE_BATCH, PURGE_MAX_PER_RUN - result.captures - result.failures),
      );
      const todo = batch.filter((capture) => !skip.has(capture.id));
      // Either nothing is expired, or everything still expired is something this
      // run has already failed on. Both mean this pass is finished.
      if (todo.length === 0) break;

      for (const capture of todo) {
        const objects = await purgeOneCapture(eraser, ctx.db, capture);
        if (objects === null) {
          result.failures += 1;
          skip.add(capture.id);
          continue;
        }
        result.captures += 1;
        result.objects += objects;
      }
    }

    /*
     * The two roll-level sweeps ride the same schedule rather than becoming job
     * names of their own. `JOB_NAMES` is a contract mirrored by the API
     * (`apps/api/src/uploads/uploads.ts`), and this is retention — the same
     * concern, the same daily cron, the same "delete what the grace period says
     * is over". Both are wrapped so neither can cost the capture purge its run.
     */
    try {
      result.derived = await purgeExpiredDerivatives(ctx);
    } catch (err) {
      log.error('roll derivative purge failed', errorFields(err, log.level === 'debug'));
    }
    try {
      result.uploads = await reapStaleUploads(ctx);
    } catch (err) {
      log.error('upload session reap failed', errorFields(err, log.level === 'debug'));
    }

  return result;
}

export function purgeTrash(eraser: MediaEraser): JobHandler {
  return async (payload: JobPayload, ctx: JobCtx): Promise<void> => {
    const rollId =
      typeof payload.rollId === 'string' && payload.rollId !== '' ? payload.rollId : null;
    const result = await runPurge(eraser, ctx, rollId);

    const touched =
      result.captures +
      result.failures +
      result.derived.exports +
      result.derived.recaps +
      result.uploads.aborted +
      result.derived.failures +
      result.uploads.failures;
    if (touched > 0) {
      log.info('purge-trash finished', {
        captures: result.captures,
        objects: result.objects,
        failures: result.failures,
        exports: result.derived.exports,
        recaps: result.derived.recaps,
        derivedObjects: result.derived.objects,
        derivedFailures: result.derived.failures,
        uploadsAborted: result.uploads.aborted,
        uploadFailures: result.uploads.failures,
      });
    }
  };
}
