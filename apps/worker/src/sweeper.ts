import { and, asc, eq, gte, inArray, lt, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { processingEvents } from './db/schema';
import { isJobName, jobKeyFor, type WorkerDatabase } from './jobs/types';
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

  const report: SweepReport = { scanned: rows.length, resubmitted: 0, present: 0, unknown: 0 };

  for (const row of rows) {
    if (!isJobName(row.job)) {
      report.unknown += 1;
      continue;
    }
    const jobKey = jobKeyFor(row.captureId, row.job);
    const existing = await queue.queue.getJob(jobKeyToJobId(jobKey));
    if (existing !== undefined) {
      report.present += 1;
      continue;
    }
    await queue.enqueue(row.job, { captureId: row.captureId, jobKey });
    report.resubmitted += 1;
  }

  return report;
}

/** One line a person can grep for. */
export function describeSweep(report: SweepReport): string {
  return (
    `sweep: ${report.scanned} stale queued row(s), ` +
    `${report.resubmitted} resubmitted, ${report.present} present, ${report.unknown} unknown job name(s)`
  );
}
