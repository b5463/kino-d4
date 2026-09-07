import type { Job } from 'bullmq';
import {
  appendProcessingEvent,
  isCaptureGoneViolation,
  markJobAbandoned,
  truncateError,
} from './events';
import { errorFields, log } from '../log';
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
 * Nothing here may throw. It runs on an event listener, where an exception is
 * an unhandled rejection and not a job failure.
 */
export async function markOutsideFailure(
  ctx: JobCtx,
  job: Job<JobPayload, void, JobName>,
  err: Error,
): Promise<void> {
  const jobName: string = job.name;
  const captureId = typeof job.data.captureId === 'string' ? job.data.captureId : null;
  if (captureId === null) {
    // Roll-scoped work has no capture to log against — `capture_id` is NOT
    // NULL — so its outcome stays BullMQ's own job state, as it already does
    // on the normal path. The row-level truth for those is `export_jobs` /
    // `recap_jobs`, which their handlers move.
    log.warn('job failed outside its processor', {
      jobId: job.id,
      job: jobName,
      reason: err.message,
    });
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

