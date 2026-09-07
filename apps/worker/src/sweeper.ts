import { and, asc, eq, gte, inArray, lt, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { processingEvents } from './db/schema';
import { errorFields, log } from './log';
import { isJobName, jobKeyFor, type JobName, type JobPayload, type WorkerDatabase } from './jobs/types';
import { jobKeyToJobId, type JobQueue } from './queue';

/**
 * The queued-row reconcile sweeper (audit API-14).
 *
 * The API writes a `queued` row *before* it adds the BullMQ job, and it swallows
 * an add that fails — the row is committed, and a 500 would tell a camera its
 * capture did not complete when it did (`device-captures.ts`, `submit`). That is
 * the right trade at the request, and it leaves one hole: a row whose job was
 * never added, or whose job Redis lost, sits at `queued` for good. The partial
 * unique index makes every later capture-complete a no-op for that job, and
 * `recomputeCaptureStatus` reads the `queued` row as "still working", so the
 * capture is pinned in `processing`.
 *
 * This is the other half. Every few minutes the worker looks for `queued` rows
 * old enough that the API's own add must have happened by now, asks BullMQ
 * whether the job exists under the id the row implies, and re-adds the ones that
 * do not. Nothing is written to the database: the row already says the work is
 * owed, and the job's own `running`/`done` rows follow as usual once it runs.
 *
 * Idempotent by construction. The `jobKey` is the BullMQ `jobId`, so a re-add
 * racing the API's late add is a no-op for whichever comes second, and a row
 * whose job is present — waiting, delayed in a backoff, active, or completed
 * and retained — is left alone. A queued row that has a *later* row for the
 * same job is not a lost job: the worker has already picked it up, and the
 * `queued` row is simply the enqueue record the log keeps (see `jobs/events.ts`).
 */

/** How often the sweep runs. Five minutes: this is a safety net, not a scheduler. */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How old a `queued` row must be before it counts as suspicious. Two minutes is
 * far past any request's lifetime, so a row this old with no job is a lost one
 * and not an add still in flight.
 */
export const SWEEP_MIN_AGE_MS = 2 * 60 * 1000;

/** Rows per sweep. Bounded so a backlog is drained over several runs, not one. */
export const SWEEP_LIMIT = 200;

export interface SweepReport {
  /** Stale `queued` rows examined this run (at most `limit`). */
  scanned: number;
  /** Rows whose job was missing from BullMQ and was re-added. */
  resubmitted: number;
  /** Rows whose job was found in BullMQ and left alone. */
  present: number;
  /** Rows naming a job this build does not know — logged, never queued. */
  unknown: number;
  /**
   * Rows whose job was still in Redis but *finished* — a retained failure or
   * completion — and was therefore cleared and re-added. A subset of
   * `resubmitted`; counted separately because it is the case that used to be
   * silently miscounted as `present`.
   */
  retained: number;
}

/**
 * BullMQ states that mean the job is over.
 *
 * A retained job in one of these is not work in flight, it is a receipt.
 * `removeOnFail: {age: 7d}` keeps a terminally failed job in Redis for a week,
 * and — this is the part that bites — `add()` with an existing `jobId` is a
 * **no-op in every state**, not just the live ones: `addStandardJob`'s script
 * checks `EXISTS <prefix><jobId>` and returns the existing id if the hash is
 * there (bullmq 6.1.2, `scripts/addStandardJob-9.js`). So once
 * `markJobAbandoned` frees the `queued` lock and a later capture-complete writes
 * a fresh `queued` row, nothing gets behind it — and this sweeper, which asked
 * only "does `getJob` find something", counted the receipt as the job and never
 * re-added it. A capture could sit in `processing` for seven days.
 *
 * `unknown` is deliberately absent: `getJob` returned a job, so something is
 * there, and re-adding over a state this build cannot name is a guess. It is
 * counted as present and left for the next sweep.
 */
export const TERMINAL_JOB_STATES: ReadonlySet<string> = new Set(['completed', 'failed']);

/**
 * The three things a sweep does to BullMQ, and nothing else.
 *
 * Narrow on purpose: the decision below is the part worth testing, and a fake
 * that has to satisfy the whole `Queue` type is a fake nobody writes.
 */
export interface SweepQueue {
  getJob(jobId: string): Promise<{ getState(): Promise<string> } | undefined>;
  /** Returns 0 when there was nothing to remove, or the job is active and locked. */
  remove(jobId: string): Promise<number>;
  enqueue(name: JobName, payload: JobPayload): Promise<void>;
}

/** The real queue, seen through `SweepQueue`. */
export function sweepQueueOf(queue: JobQueue): SweepQueue {
  return {
    getJob: (jobId) => queue.queue.getJob(jobId),
    remove: (jobId) => queue.queue.remove(jobId),
    enqueue: (name, payload) => queue.enqueue(name, payload),
  };
}

/** What one stale row turned out to be. */
export type RowOutcome = 'present' | 'resubmitted' | 'retained';

/**
 * Decides one stale `queued` row, and acts on it.
 *
 * Three answers:
 *
 * - **present** — a job exists and is waiting, delayed in a backoff, or active.
 *   Nothing to do; the row is the enqueue record of work that is still coming.
 * - **retained** — a job exists and is finished. The receipt is removed and the
 *   work re-added, because the row says the work is still owed and the receipt is
 *   the only thing standing in the way. Removing first is not optional: the add
 *   would otherwise be a no-op against the same id.
 * - **resubmitted** — no job at all, the original case this sweeper was written
 *   for: an add the API lost, or a job Redis dropped.
 *
 * `remove` answering 0 is fine and is not checked: the job went between the
 * `getState` and the `remove` (so the add works), or it is active and locked (so
 * the add is a no-op and the running job keeps its lock, which is the outcome
 * anyone would want).
 */
export async function reconcileQueuedRow(
  queue: SweepQueue,
  captureId: string,
  job: JobName,
): Promise<RowOutcome> {
  const jobKey = jobKeyFor(captureId, job);
  const jobId = jobKeyToJobId(jobKey);

  const existing = await queue.getJob(jobId);
  if (existing !== undefined) {
    const state = await existing.getState();
    if (!TERMINAL_JOB_STATES.has(state)) return 'present';
    await queue.remove(jobId);
    await queue.enqueue(job, { captureId, jobKey });
    return 'retained';
  }

  await queue.enqueue(job, { captureId, jobKey });
  return 'resubmitted';
}

export interface SweepOptions {
  minAgeMs?: number;
  limit?: number;
  /** Injectable clock, so a test can age rows without sleeping. */
  now?: () => Date;
  /**
   * Narrows the sweep to these captures. Production passes nothing and sweeps
   * everything; a test on the shared dev database passes its own fixtures so
   * another suite's leftovers cannot change its counts.
   */
  captureIds?: readonly string[];
}

/**
 * One sweep. Returns the counts so the caller can log them; throws only if the
 * *query* fails — a single re-add that fails is counted as not resubmitted and
 * the next run tries it again.
 */
export async function sweepQueuedRows(
  db: WorkerDatabase,
  queue: JobQueue,
  options: SweepOptions = {},
): Promise<SweepReport> {
  const minAgeMs = options.minAgeMs ?? SWEEP_MIN_AGE_MS;
  const limit = options.limit ?? SWEEP_LIMIT;
  const now = options.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - minAgeMs);

  // "No later row for this job": the row is the job's newest word, which is
  // what makes it a lost enqueue rather than the record of one that ran.
  const later = alias(processingEvents, 'later');
  const rows = await db
    .select({
      captureId: processingEvents.captureId,
      job: processingEvents.job,
    })
    .from(processingEvents)
    .where(
      and(
        eq(processingEvents.status, 'queued'),
        lt(processingEvents.at, cutoff),
        options.captureIds === undefined
          ? undefined
          : inArray(processingEvents.captureId, [...options.captureIds]),
        notExists(
          db
            .select({ one: sql`1` })
            .from(later)
            .where(
              and(
                eq(later.captureId, processingEvents.captureId),
                eq(later.job, processingEvents.job),
                ne(later.id, processingEvents.id),
                gte(later.at, processingEvents.at),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(processingEvents.at), asc(processingEvents.id))
    .limit(limit);

  const report: SweepReport = {
    scanned: rows.length,
    resubmitted: 0,
    present: 0,
    unknown: 0,
    retained: 0,
  };

  const sweepQueue = sweepQueueOf(queue);

  for (const row of rows) {
    if (!isJobName(row.job)) {
      report.unknown += 1;
      continue;
    }
    try {
      const outcome = await reconcileQueuedRow(sweepQueue, row.captureId, row.job);
      if (outcome === 'present') report.present += 1;
      else {
        report.resubmitted += 1;
        if (outcome === 'retained') report.retained += 1;
      }
    } catch (err) {
      // One row that could not be reconciled is not the sweep's problem to
      // solve: it stays `queued`, it is still stale, and the next run tries it
      // again. Throwing here would cost every row behind it its turn.
      log.warn('could not reconcile a stale queued row', {
        captureId: row.captureId,
        job: row.job,
        ...errorFields(err, log.level === 'debug'),
      });
    }
  }

  return report;
}

/** One line a person can grep for. */
export function describeSweep(report: SweepReport): string {
  return (
    `sweep: ${report.scanned} stale queued row(s), ` +
    `${report.resubmitted} resubmitted (${report.retained} over a finished job), ` +
    `${report.present} present, ${report.unknown} unknown job name(s)`
  );
}
