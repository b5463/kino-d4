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
export function createProcessingQueue(config: Pick<ApiConfig, 'REDIS_URL'>): ProcessingQueue {
  return new Queue<JobPayload, void, JobName>(JOB_QUEUE_NAME, {
    connection: { url: config.REDIS_URL, maxRetriesPerRequest: null },
    prefix: JOB_QUEUE_PREFIX,
  });
}

/**
 * Adds one job. Adding the same `jobKey` again while that job still exists is a
 * no-op inside BullMQ, so this needs no pre-check of its own (03 §19).
 */
export async function submitJob(
  queue: ProcessingQueue,
  name: JobName,
  payload: JobPayload,
): Promise<void> {
  await queue.add(name, payload, jobOptionsFor(payload.jobKey));
}
