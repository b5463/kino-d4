import type { Job } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { exportJobs, recapJobs } from '../db/schema';
import {
  appendProcessingEvent,
  isCaptureGoneViolation,
  markJobAbandoned,
  truncateError,
} from './events';
import { errorFields, log } from '../log';
import { jobRowIdOf } from './roll';
import type { JobCtx, JobName, JobPayload } from './types';

/**
 * Writes the rows a failure *outside* the processor would otherwise never
 * produce.
 *
 * The case is a job killed mid-render. BullMQ finds it unlocked in `active`,
 * counts a stall, and past `maxStalledCount` it stamps a deferred failure on
 * the job hash and pushes it back to wait (bullmq 6.1.2,
 * `moveStalledJobsToWait`). The next worker to pick it up sees that stamp in
 * `getUnrecoverableErrorMessage`, fails it *without calling the processor*,
 * and emits `failed`. Nothing in `processorFor` ever runs, so no `failed` row
 * and no `abandoned` row are written — and the capture's newest row is still
 * the API's `queued` one. The capture sits in `processing` forever, its
 * enqueue lock held, with nothing running and nothing to say so.
 *
 * So the same two rows the terminal path writes are written here. The failure
 * is unconditionally terminal: BullMQ reaches this only through
 * `UnrecoverableError`, which spends no further attempts.
 *
 * Roll-scoped work has no capture row to write against, and the same argument
 * applies to the row it *does* have — see `failRollJobRow`.
 *
 * Nothing here may throw. It runs on an event listener, where an exception is
 * an unhandled rejection and not a job failure.
 */
/** The roll-scoped job names, and the table each one's row lives in. */
const ROLL_JOB_TABLES = {
  'export-roll': exportJobs,
  'generate-recap': recapJobs,
} as const;

/** Statuses a row can be left in by a job that never got to finish. */
const NON_TERMINAL = ['queued', 'running'] as const;

/**
 * Fails the `export_jobs` / `recap_jobs` row of a roll-scoped job that died
 * outside its processor.
 *
 * ## What went wrong without this
 *
 * The handler is what moves that row, and on this path the handler never ran:
 * BullMQ found the job unlocked in `active`, counted a stall and failed it with
 * a deferred `UnrecoverableError`, so `processorFor` was never called. The row
 * therefore stays exactly where `claimExportRow` / `claimRecapRow` left it —
 * `running`, or `queued` if it was killed before its first pickup — and three
 * things follow from that one row:
 *
 * 1. `export_jobs_roll_live` / `recap_jobs_roll_live` are partial unique
 *    indexes over `status in ('queued','running')`, so the roll has a live job
 *    forever and the host's next press is refused. They can never export again.
 * 2. `purgeExpiredDerivatives` only selects `done` and `failed` rows, so the
 *    partial ZIP the killed job left in the bucket is never reclaimed — 17 GB
 *    on a 1,900-capture roll.
 * 3. The host's poll reads `running` and shows a progress state that will never
 *    move.
 *
 * `failed` is the honest word and it fixes all three: the index frees, the
 * purge can see the row, and the host gets a button they can press again.
 * `finished_at` is stamped because it is the clock retention counts from — a
 * `failed` row with a null `finished_at` is not expired and never will be
 * (`isExpired`).
 *
 * ## Why the WHERE is narrow
 *
 * Only a row that is still `queued`/`running` is touched. A row that already
 * says `done` belongs to a job that finished and uploaded its artifact before
 * something killed the *process*; overwriting that with `failed` would delete a
 * host's finished export out from under them on the next retention pass. An
 * already-`failed` row needs nothing.
 *
 * The row id comes out of the job key, the same way the handlers read it, and
 * the roll id is in the WHERE beside it so a job cannot fail a row that belongs
 * to another roll however its payload is spelled.
 *
 * Nothing here may throw — see the note on `markOutsideFailure`.
 */
async function failRollJobRow(
  ctx: JobCtx,
  job: Job<JobPayload, void, JobName>,
  err: Error,
): Promise<void> {
  const table = ROLL_JOB_TABLES[job.name as keyof typeof ROLL_JOB_TABLES] ?? null;
  if (table === null) return;

  const rollId = job.data.rollId;
  if (typeof rollId !== 'string' || rollId === '') return;

  try {
    const rowId = jobRowIdOf(job.data);
    const failed = await ctx.db
      .update(table)
      .set({
        status: 'failed',
        error: `failed outside the processor: ${truncateError(err)}`,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(table.id, rowId),
          eq(table.rollId, rollId),
          inArray(table.status, [...NON_TERMINAL]),
        ),
      )
      .returning({ id: table.id });

    if (failed.length > 0) {
      log.warn('failed the roll job row of a job that died outside its processor', {
        jobId: job.id,
        job: job.name,
        rollId,
        rowId,
      });
    }
  } catch (writeErr) {
    log.error('could not fail the roll job row for a failure outside the processor', {
      jobId: job.id,
      job: job.name,
      rollId,
      ...errorFields(writeErr, log.level === 'debug'),
    });
  }
}

export async function markOutsideFailure(
  ctx: JobCtx,
  job: Job<JobPayload, void, JobName>,
  err: Error,
): Promise<void> {
  const jobName: string = job.name;
  const captureId = typeof job.data.captureId === 'string' ? job.data.captureId : null;
  if (captureId === null) {
    // Roll-scoped work has no capture to log against — `capture_id` is NOT
    // NULL — so the row-level truth for those is `export_jobs` / `recap_jobs`.
    // On *this* path their handler never ran, so nothing moved that row.
    log.warn('job failed outside its processor', {
      jobId: job.id,
      job: jobName,
      reason: err.message,
    });
    await failRollJobRow(ctx, job, err);
    return;
  }

  log.warn('job failed outside its processor; recording it against the capture', {
    jobId: job.id,
    job: jobName,
    captureId,
    reason: err.message,
  });

  try {
    const reason = `failed outside the processor: ${truncateError(err)}`;
    await appendProcessingEvent(ctx.db, captureId, jobName, 'failed', reason);
    await markJobAbandoned(ctx.db, captureId, jobName, reason);
  } catch (writeErr) {
    if (isCaptureGoneViolation(writeErr)) return;
    log.error('could not record a failure that happened outside the processor', {
      jobId: job.id,
      job: jobName,
      captureId,
      ...errorFields(writeErr, log.level === 'debug'),
    });
  }
}

