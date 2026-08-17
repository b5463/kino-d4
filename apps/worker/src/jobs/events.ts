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
export type ProcessingStatus = 'queued' | 'running' | 'done' | 'failed';

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
