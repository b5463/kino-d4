import { Queue, type JobsOptions } from 'bullmq';
import type { ApiConfig } from '../config';
import type { JobName, JobPayload } from '../uploads/uploads';

/**
 * The API's half of the job queue: it **produces**, it never consumes.
 *
 * `apps/worker` is the process that runs the work (05 §11), and it owns
 * `src/queue.ts` — the file below mirrors that module's wire contract and
 * nothing else. Mirrored rather than imported because the two are separate
 * workspaces: a dependency from the API on the worker would put bullmq, a
 * database schema and every future handler's imports into the process that
 * answers cameras, to reuse five constants.
 *
 * Mirroring is only safe if it is checked, so it is: `apps/worker`'s test suite
 * imports both modules and asserts the queue name, the prefix and the full job
 * options are identical. A drift here is not a subtle bug — it is jobs written
 * to a queue nobody reads — and the check is what stops it shipping.
 */

/** MUST match `apps/worker/src/queue.ts`. */
export const JOB_QUEUE_NAME = 'kino';
export const JOB_QUEUE_PREFIX = 'kino-jobs';
export const JOB_ATTEMPTS = 5;
export const JOB_BACKOFF_MS = 10_000;
export const JOB_ID_SEPARATOR = '~';
const KEEP_COMPLETED = { age: 24 * 60 * 60, count: 10_000 };
const KEEP_FAILED = { age: 7 * 24 * 60 * 60 };

/**
 * `jobKey` is the platform's name for a unit of work — `<captureId>:<jobName>`
 * — and BullMQ refuses a custom id containing `:`, which is its own Redis key
 * separator. The key keeps its readable shape and only the stored id is
 * translated; `~` cannot appear in an id or a job name, so the mapping is
 * injective and two jobKeys can never collide on one jobId.
 */
export function jobKeyToJobId(jobKey: string): string {
  if (jobKey.includes(JOB_ID_SEPARATOR)) {
    throw new Error(`job key ${jobKey} may not contain ${JOB_ID_SEPARATOR}`);
  }
  return jobKey.split(':').join(JOB_ID_SEPARATOR);
}

/**
 * Everything that decides what happens to a job after it is added.
 *
 * The retry policy travels **on the job**, not on the worker: BullMQ reads
 * `attempts` and `backoff` from the job it pops, so a producer that omitted
 * them would queue work that never retries no matter what the worker believes.
 */
export function jobOptionsFor(jobKey: string): JobsOptions {
  return {
    jobId: jobKeyToJobId(jobKey),
    attempts: JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: JOB_BACKOFF_MS },
    removeOnComplete: KEEP_COMPLETED,
    removeOnFail: KEEP_FAILED,
  };
}

export type ProcessingQueue = Queue<JobPayload, void, JobName>;

/**
 * A producer connection of its own, not `app.redis`.
 *
 * BullMQ wants `maxRetriesPerRequest: null`, the API's shared client is
 * deliberately capped at 2 so a health probe fails fast, and one of those two
 * has to give. A separate connection lets both be right.
 */
export function createProcessingQueue(
  config: Pick<ApiConfig, 'REDIS_URL' | 'JOB_QUEUE_PREFIX'>,
): ProcessingQueue {
  return new Queue<JobPayload, void, JobName>(JOB_QUEUE_NAME, {
    connection: { url: config.REDIS_URL, maxRetriesPerRequest: null },
    prefix: config.JOB_QUEUE_PREFIX,
  });
}

/**
 * Adds one job, clearing whatever is left of the last one under that id.
 *
 * ## Why the remove is not optional
 *
 * BullMQ's `add()` is a no-op whenever the job hash exists — **in any state**,
 * not only the live ones. The script checks `EXISTS <prefix><jobId>` and returns
 * the existing id (bullmq 6.1.2, `scripts/addStandardJob-9.js`,
 * `handleDuplicatedJob`). Retention keeps a terminally failed job for seven days
 * (`KEEP_FAILED`) and a completed one for a day (`KEEP_COMPLETED`), so a job that
 * exhausted its five attempts leaves a receipt in Redis that swallows every
 * later add of the same key for a week.
 *
 * That used to be harmless because a failed job also left its `queued` row in
 * place, which blocked the enqueue upstream. It stopped being harmless when the
 * worker started retiring that row: `markJobAbandoned` frees the lock, the next
 * capture-complete writes a fresh `queued` row — and this `add` silently does
 * nothing, because the week-old failure is still sitting on the id. The capture
 * waits in `processing` behind a row whose job was never queued.
 *
 * So the receipt goes first, exactly as `resubmitJob` already does it. Nothing
 * about idempotency is given up: `remove` returns 0 for an **active** job and
 * leaves it alone (`removeJob`'s script refuses a locked job), in which case the
 * add is a no-op and the running job keeps its lock — so two concurrent
 * capture-completes still produce one unit of work, which is the property 03 §19
 * actually asks for. A job that is merely waiting is removed and immediately
 * re-added with the same payload, which is the same job.
 */
export async function submitJob(
  queue: ProcessingQueue,
  name: JobName,
  payload: JobPayload,
): Promise<void> {
  await queue.remove(jobKeyToJobId(payload.jobKey));
  await queue.add(name, payload, jobOptionsFor(payload.jobKey));
}

/**
 * Adds one job that must run again even though it already ran.
 *
 * The idempotency that protects capture-complete works against a re-render:
 * a *completed* job is retained in Redis for a day (`KEEP_COMPLETED`), and a
 * retained job blocks its own `jobId`, so a plain add after a playback change
 * would be a silent no-op and the files would keep the old settings.
 *
 * `submitJob` now clears the id itself, for the same reason and by the same
 * mechanism, so this is a name rather than a second behaviour: a re-render and a
 * recovery from a retained failure are the same two Redis calls. It is kept as
 * its own function because the *intent* differs and the call sites read better
 * for saying which one they mean.
 *
 * `remove` returns 0 for a job that is missing — fine, nothing to clear — or
 * **active**, in which case the add is also a no-op and the running render keeps
 * its lock. That last case can bake the previous settings; the row the handler
 * reads at run time usually saves it, and a second PATCH re-queues cleanly once
 * the job finishes.
 */
export async function resubmitJob(
  queue: ProcessingQueue,
  name: JobName,
  payload: JobPayload,
): Promise<void> {
  await submitJob(queue, name, payload);
}
