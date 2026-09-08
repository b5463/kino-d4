import { and, eq } from 'drizzle-orm';
import { processingEvents } from '../db/schema';
import { newId } from '../ids';
import type { WorkerDatabase, WorkerTransaction } from './types';

/**
 * `processing_events` is an **append-only log**, with one exception that is
 * spelled out in both places it happens.
 *
 * A worker adds rows. The single field it ever rewrites is the `queued` row's
 * `status`, and only ever from `queued` to `superseded`, when the job that row
 * enqueued is over — `markJobSucceeded` on the good path, `markJobAbandoned` on
 * the terminal-failure one. Nothing is deleted, no `at` is moved, and no
 * `running`/`failed`/`done` row is ever touched.
 *
 * That rewrite is not optional, because the `queued` row does two jobs at once:
 * it is the audit record of an enqueue, and — through the partial unique index
 * over `(capture_id, job) where status = 'queued'` — it is the *lock* that makes
 * a second capture-complete a no-op. A lock the finished job never gives back is
 * a job that can never be queued again, which is a re-render the platform
 * documents and cannot perform.
 *
 * **The idempotency the queue relies on is not this row.** Two concurrent runs
 * of one `(capture, job)` are prevented by BullMQ's `jobId` (`queue.ts`, and
 * `submitJob` in the API's producer, which `remove`s before it `add`s and gets a
 * refusal for a job that is *active* and locked). The `queued` row prevents a
 * duplicate **enqueue**, which is a different thing: retiring it once the work
 * is finished re-arms the enqueue and cannot re-arm a concurrent run.
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
   * The enqueue row, retired. Written *only* by `markJobSucceeded` and
   * `markJobAbandoned` — see the long note on `retireQueuedRow` for why one
   * status change is not a hole in the append-only rule.
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
 * A `processing_events.error` is a breadcrumb, not a log sink.
 *
 * Here rather than in `queue.ts` because it is a fact about this column: two
 * callers now write an error into it — the processor's own failure path and the
 * queue's stalled-job recorder — and both have to agree on the ceiling.
 */
export const MAX_ERROR_CHARS = 500;

/** An error as one short line, safe to put in `processing_events.error`. */
export function truncateError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

/** PostgreSQL's SQLSTATE for a foreign-key violation. */
const FOREIGN_KEY_VIOLATION = '23503';

/** The constraint that ties an event row to its capture. */
const CAPTURE_FK = 'processing_events_capture_id_captures_id_fk';

/**
 * Whether a failed write says the capture row is gone.
 *
 * The write path here is `drizzle → postgres.js`, and drizzle wraps the driver's
 * error in a `DrizzleQueryError` whose `cause` is the `PostgresError` carrying
 * `code` and `constraint_name`. Both layers are checked, so this keeps working
 * whether or not a future drizzle stops wrapping.
 *
 * Why the queue wants to know: a job for a capture that was trashed and purged
 * between enqueue and pickup cannot record anything — its `running` row hits
 * this constraint before the handler even starts — and a job that cannot record
 * its own failure used to retry all five attempts, each one failing the same way.
 * The capture is not coming back, so the honest outcome is to drop the job.
 */
export function isCaptureGoneViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const record = current as Record<string, unknown>;
    if (record['code'] === FOREIGN_KEY_VIOLATION && record['constraint_name'] === CAPTURE_FK) {
      return true;
    }
    current = record['cause'];
  }
  return false;
}

/**
 * Retires the `queued` row of one job, releasing its enqueue lock.
 *
 * ## The problem this solves (board issue #8, and the success half of it)
 *
 * The `queued` row does two jobs at once. It is the audit record of an enqueue,
 * and — through the partial unique index over `(capture_id, job) where status =
 * 'queued'` — it is the *lock* that makes a second capture-complete a no-op.
 * That conflation is fine while a job is in flight. Once it is over, in either
 * direction, the row is still there, so:
 *
 * - no later capture-complete can ever queue that job again (the insert hits the
 *   index and is silently dropped), and
 * - on the failure path the capture's latest row for that job is `failed`, which
 *   the API reads as "not finished", so the capture stays in `processing`
 *   forever.
 *
 * Neither is theoretical. A frame that fails to decode five times is a Saturday
 * night, not a bug report — and on the *success* path the same stuck row made
 * both documented re-render routes (the host's re-render button and the API's
 * own re-enqueue after a late frame lands) silent no-ops, so a wiggle baked
 * before camera 3's upload arrived stayed three frames forever with nothing in
 * the log to say why.
 *
 * ## The mechanism, and why this one
 *
 * The row keeps its id, its `at` — so the enqueue timestamp survives — and its
 * place in the log; only the word changes, and the word it changes to says
 * exactly what happened to it. The partial index covers `status = 'queued'` and
 * nothing else, so the lock is released the moment the row stops saying
 * `queued`.
 *
 * The alternatives were considered and rejected:
 *
 * - **Deleting the `queued` row** releases the lock too, and loses the only
 *   record that the job was ever enqueued and when. The instruction is that the
 *   log stays intact for audit; a deleted row is not intact.
 * - **A new partial index that ignores finished jobs** cannot be written: a
 *   partial index's predicate sees one row, and "is this job over" is a question
 *   about a different row.
 * - **Rewriting the `queued` row into the terminal row** (status and `at`
 *   together) is one write instead of two, and destroys the enqueue timestamp to
 *   save it.
 *
 * ## What this does *not* release
 *
 * A concurrent run. Two runs of one `(capture, job)` are prevented by BullMQ's
 * `jobId`, which is the `jobKey` (`queue.ts`): `add()` with an existing id is a
 * no-op in every state, and the API's `submitJob` — which `remove`s first —
 * gets 0 back for a job that is active and locked, so its add is a no-op too.
 * That mechanism is untouched here. What is released is the ability to *enqueue*
 * the job again, which is only reachable once this job's own BullMQ record is
 * gone or finished.
 *
 * The `where status = 'queued'` clause is what keeps this job-scoped: a sibling
 * job's lock is a different row and is not touched. The update matching nothing
 * is normal and not an error — a job queued directly by a worker fan-out
 * (Task 25) has no `queued` row to retire.
 */
function retireQueuedRow(
  tx: WorkerTransaction,
  captureId: string,
  job: string,
): Promise<unknown> {
  return tx
    .update(processingEvents)
    .set({ status: 'superseded' })
    .where(
      and(
        eq(processingEvents.captureId, captureId),
        eq(processingEvents.job, job),
        eq(processingEvents.status, 'queued'),
      ),
    );
}

/**
 * Records that a job finished, and unblocks its re-enqueue.
 *
 * Two writes in one transaction, so a crash between them cannot leave a `done`
 * row over a live lock or a released lock with nothing saying the work is
 * finished:
 *
 * 1. **Append the `done` row.** Newest, and what makes the job finished to a
 *    reader — `recomputeCaptureStatus` reads the latest row per job.
 * 2. **Retire the `queued` row.** See `retireQueuedRow`: this is what makes a
 *    re-render possible at all.
 */
export async function markJobSucceeded(
  db: WorkerDatabase,
  captureId: string,
  job: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(processingEvents).values({
      id: newId('pev'),
      captureId,
      job,
      status: 'done',
      error: null,
    });

    await retireQueuedRow(tx, captureId, job);
  });
}

/**
 * Records that a job is permanently over, and unblocks its re-enqueue.
 *
 * The same two writes as `markJobSucceeded`, with the terminal word instead of
 * `done`. `abandoned` is what makes the failure final to a reader: `DISTINCT ON
 * (job) ... ORDER BY at DESC` answers `abandoned` instead of `failed`, and
 * `abandoned` cannot be confused with a mid-retry failure the way a bare
 * `failed` can. Every `running`/`failed` row stays exactly as it was —
 * including all five attempts, which is what somebody reading this log wants.
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

    await retireQueuedRow(tx, captureId, job);
  });
}
