import { and, eq } from 'drizzle-orm';
import { processingEvents } from '../db/schema';
import { newId } from '../ids';
import type { WorkerDatabase } from './types';

/**
 * `processing_events` is an **append-only log**, and every word of that matters.
 *
 * A worker adds a row; it never updates one. In particular it never touches the
 * `queued` row the API wrote, because the partial unique index over
 * `(capture_id, job) where status = 'queued'` is what makes a second
 * capture-complete a no-op — clearing that row would re-arm the enqueue and the
 * work would be queued twice.
 *
 * The consequence for readers is in `apps/api/src/uploads/uploads.ts`: "have
 * the jobs finished?" is a question about each job's LATEST row, never about
 * all of them.
 */
export type ProcessingStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  /**
   * The enqueue row, retired. Written *only* by `markJobAbandoned` — see the
   * long note there for why one status change is not a hole in the append-only
   * rule.
   */
  | 'superseded'
  /**
   * The job is over and it did not succeed: BullMQ has no attempts left. This is
   * the row that makes a permanent failure *terminal* for readers — a `failed`
   * row on its own only says one attempt died, and four more may follow.
   */
  | 'abandoned';

/**
 * The statuses that mean a job may still change its mind. Exported because the
 * API's `recomputeCaptureStatus` asks the same question of the same rows, and a
 * capture that treated `abandoned` as pending would sit in `processing` forever.
 */
export const PENDING_STATUSES: readonly ProcessingStatus[] = ['queued', 'running', 'failed'];

/**
 * Appends one row.
 *
 * Roll-scoped jobs (`export-roll`, `generate-recap`, `purge-trash`) have no
 * capture to log against — `capture_id` is NOT NULL — so the queue skips this
 * for them and their outcome is BullMQ's own job state. That is a gap this task
 * leaves open on purpose rather than inventing a nullable column the API's
 * readers would then have to understand.
 */
export async function appendProcessingEvent(
  db: WorkerDatabase,
  captureId: string,
  job: string,
  status: ProcessingStatus,
  error?: string,
): Promise<void> {
  await db.insert(processingEvents).values({
    id: newId('pev'),
    captureId,
    job,
    status,
    error: error ?? null,
  });
}

/**
 * Records that a job is permanently over, and unblocks its re-enqueue.
 *
 * ## The problem this solves (board issue #8)
 *
 * The `queued` row does two jobs at once. It is the audit record of an enqueue,
 * and — through the partial unique index over `(capture_id, job) where status =
 * 'queued'` — it is the *lock* that makes a second capture-complete a no-op.
 * That conflation is fine while jobs succeed. When one exhausts its five
 * attempts, the row is still there, so:
 *
 * - no later capture-complete can ever queue that job again (the insert hits the
 *   index and is silently dropped), and
 * - the capture's latest row for that job is `failed`, which the API reads as
 *   "not finished", so the capture stays in `processing` forever.
 *
 * With real handlers that stops being theoretical: a frame that fails to decode
 * five times is a Saturday night, not a bug report.
 *
 * ## The mechanism, and why this one
 *
 * Two writes in one transaction:
 *
 * 1. **Append an `abandoned` row.** New, newest, and carrying the error. This is
 *    what makes the failure terminal to a reader: `DISTINCT ON (job) ... ORDER BY
 *    at DESC` now answers `abandoned` instead of `failed`, and `abandoned` cannot
 *    be confused with a mid-retry failure the way a bare `failed` can.
 * 2. **Retire the `queued` row to `superseded`.** The row keeps its id, its `at`
 *    — so the enqueue timestamp survives — and its place in the log; only the
 *    word changes, and the word it changes to says exactly what happened to it.
 *    The partial index covers `status = 'queued'` and nothing else, so the lock
 *    is released the moment it stops saying `queued`.
 *
 * The alternatives were considered and rejected:
 *
 * - **Deleting the `queued` row** releases the lock too, and loses the only
 *   record that the job was ever enqueued and when. The instruction is that the
 *   log stays intact for audit; a deleted row is not intact.
 * - **A new partial index that ignores terminally-failed jobs** cannot be
 *   written: a partial index's predicate sees one row, and "has this job been
 *   abandoned" is a question about a different row.
 * - **Rewriting the `queued` row into the terminal row** (status and `at`
 *   together) is one write instead of two, and destroys the enqueue timestamp to
 *   save it.
 *
 * So one status field of one row is rewritten, once, and only ever from `queued`
 * to `superseded`. Nothing is deleted, no history is reordered, and every
 * `running`/`failed`/`done` row is exactly as it was — including all five
 * attempts, which is what somebody reading this log actually wants.
 *
 * The `where status = 'queued'` clause is what keeps this job-scoped: a sibling
 * job's lock is a different row and is not touched. The update matching nothing
 * is normal and not an error — a job queued directly by a worker fan-out
 * (Task 25) has no `queued` row to retire.
 */
export async function markJobAbandoned(
  db: WorkerDatabase,
  captureId: string,
  job: string,
  error: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(processingEvents).values({
      id: newId('pev'),
      captureId,
      job,
      status: 'abandoned',
      error,
    });

    await tx
      .update(processingEvents)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(processingEvents.captureId, captureId),
          eq(processingEvents.job, job),
          eq(processingEvents.status, 'queued'),
        ),
      );
  });
}
