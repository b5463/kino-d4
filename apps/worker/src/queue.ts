import { Queue, Worker, type Job, type JobsOptions, type RedisOptions } from 'bullmq';
import { appendProcessingEvent } from './jobs/events';
import { isJobName, type JobCtx, type JobHandler, type JobName, type JobPayload } from './jobs/types';

/**
 * The job queue (03 §19, 05 §11) — asynchronous, idempotent, retryable, and
 * independent.
 *
 * Three properties, three mechanisms:
 *
 * - **Idempotent.** `JobPayload.jobKey` is the BullMQ `jobId`. BullMQ keeps one
 *   job per id, so adding the same key again while that job still exists —
 *   waiting, delayed, active or completed — is a no-op rather than a second
 *   unit of work. Nothing has to check first, which is what makes it safe under
 *   two concurrent capture-completes.
 * - **Retryable.** Five attempts with exponential backoff from 10 s, set on the
 *   job at add time (BullMQ reads the policy from the job, not the worker).
 *   `apps/api/src/queue/producer.ts` mirrors these two numbers and is pinned to
 *   them by a contract test — a producer that disagreed would silently ship a
 *   different retry policy than the one documented here.
 * - **Independent.** Every job runs inside its own try/catch with its own
 *   `processing_events` rows. A handler that throws marks *its* job failed and
 *   touches nothing else, so a dead MP4 render cannot cost a capture its
 *   originals or its thumbnail (07 §26). Handlers share no state: what they get
 *   is the payload and the context, and the context's only write path is
 *   `putDerived`.
 *
 * ## Why a factory and module-level functions
 *
 * `createJobQueue` is the real object: tests need their own queue, on their own
 * prefix, with a backoff measured in milliseconds instead of tens of seconds.
 * `enqueue`/`registerHandler` are the process-wide form the plan names, and
 * they delegate to whatever `configureQueue` built — one queue per process,
 * which is what `main.ts` wants.
 */

/** The queue every KINO job goes through. One queue, many job names. */
export const JOB_QUEUE_NAME = 'kino';

/**
 * Namespaces every BullMQ key in Redis. Not `bull` (BullMQ's default): this
 * Redis also carries the roll event streams, and a prefix that says whose keys
 * these are is the difference between a targeted flush and a guess.
 */
export const JOB_QUEUE_PREFIX = 'kino-jobs';

/** 03 §19: five attempts, exponential backoff starting at ten seconds. */
export const JOB_ATTEMPTS = 5;
export const JOB_BACKOFF_MS = 10_000;

/**
 * What replaces `:` when a `jobKey` becomes a BullMQ `jobId`.
 *
 * `:` is BullMQ's own Redis key separator, and it *rejects* a custom id that
 * contains one — `Custom Id cannot contain :`. (A three-part id slips through
 * today as a compatibility carve-out for old repeatable jobs, which the library
 * says it will drop, so `rollId:job:exportId` working by accident is not
 * something to build on.)
 *
 * The platform's key keeps the shape the plan and `apps/api`'s `jobKeyFor` use
 * — `<captureId>:<jobName>` — because that string is what a person reads in a
 * log. Only the id BullMQ stores is translated. `~` is safe as the replacement:
 * ids here are `<prefix>_<base64url>` and job names are lower-case words joined
 * by hyphens, so neither can contain it, and `jobKeyToJobId` refuses a key that
 * does. The mapping is therefore injective, which is the one property
 * idempotency needs from it — two jobKeys can never land on one jobId.
 */
export const JOB_ID_SEPARATOR = '~';

export function jobKeyToJobId(jobKey: string): string {
  if (jobKey.includes(JOB_ID_SEPARATOR)) {
    throw new Error(`job key ${jobKey} may not contain ${JOB_ID_SEPARATOR}`);
  }
  return jobKey.split(':').join(JOB_ID_SEPARATOR);
}

/**
 * How many jobs one worker process runs at once.
 *
 * Above one because the jobs are wildly uneven — `extract-metadata` is
 * milliseconds, `render-wiggle-mp4` is seconds — and a party-time queue where a
 * render blocks every thumbnail behind it is the failure 07 §26 is about. Kept
 * small because the work is CPU-bound: this is a concurrency limit, not a
 * parallelism claim.
 */
export const JOB_CONCURRENCY = 4;

/**
 * How long Redis keeps a finished job.
 *
 * The durable record is `processing_events` in PostgreSQL; what Redis retention
 * buys is the idempotency window, because a job that has been evicted no longer
 * blocks its own `jobId`. A day covers every retry a party-day capture can
 * produce, and the count cap is what stops a busy roll growing the keyspace
 * without limit. Failures are kept longer — they are the ones somebody reads.
 */
const KEEP_COMPLETED = { age: 24 * 60 * 60, count: 10_000 };
const KEEP_FAILED = { age: 7 * 24 * 60 * 60 };

/** A `processing_events.error` is a breadcrumb, not a log sink. */
const MAX_ERROR_CHARS = 500;

/**
 * Everything that decides what happens to a job once it is added.
 *
 * The retry policy travels **on the job**: BullMQ reads `attempts` and `backoff`
 * from the job it pops, not from the worker that pops it, so whoever adds the
 * job is who sets the policy. `apps/api/src/queue/producer.ts` has the same
 * function for that reason, and the worker's test suite asserts the two return
 * the same object.
 */
export function jobOptionsFor(
  jobKey: string,
  attempts: number = JOB_ATTEMPTS,
  backoffDelay: number = JOB_BACKOFF_MS,
): JobsOptions {
  return {
    // The whole of the idempotency contract, in one option.
    jobId: jobKeyToJobId(jobKey),
    attempts,
    backoff: { type: 'exponential', delay: backoffDelay },
    removeOnComplete: KEEP_COMPLETED,
    removeOnFail: KEEP_FAILED,
  };
}

export interface JobQueueOptions {
  /**
   * Plain connection options rather than a shared client. BullMQ opens its own
   * blocking connection for the worker, and a blocking `BRPOPLPUSH` on a client
   * something else is using would stall that other user for the duration.
   */
  connection: RedisOptions;
  name?: string;
  prefix?: string;
  attempts?: number;
  backoffDelay?: number;
  concurrency?: number;
  /** Where BullMQ's own connection/worker errors go. Defaults to stderr. */
  onError?: (err: Error) => void;
}

export interface JobQueue {
  readonly name: string;
  /** The BullMQ queue itself, for introspection and teardown. */
  readonly queue: Queue<JobPayload, void, JobName>;
  enqueue(name: JobName, payload: JobPayload): Promise<void>;
  registerHandler(name: JobName, fn: JobHandler): void;
  /** Starts consuming. One worker per queue object. */
  start(ctx: JobCtx): Worker<JobPayload, void, JobName>;
  close(): Promise<void>;
  /** Deletes every key of this queue. Tests only — never point it at a live prefix. */
  obliterate(): Promise<void>;
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

export function createJobQueue(options: JobQueueOptions): JobQueue {
  const name = options.name ?? JOB_QUEUE_NAME;
  const prefix = options.prefix ?? JOB_QUEUE_PREFIX;
  const attempts = options.attempts ?? JOB_ATTEMPTS;
  const backoffDelay = options.backoffDelay ?? JOB_BACKOFF_MS;
  const concurrency = options.concurrency ?? JOB_CONCURRENCY;
  const onError =
    options.onError ??
    ((err: Error): void => {
      console.error('[worker] queue error', err);
    });

  // BullMQ's blocking connection requires an unbounded retry setting; a caller
  // that names one wins, so a deployment can still pin its own client options.
  const connection: RedisOptions = { maxRetriesPerRequest: null, ...options.connection };

  const queue = new Queue<JobPayload, void, JobName>(name, { connection, prefix });
  queue.on('error', onError);

  const handlers = new Map<JobName, JobHandler>();
  let worker: Worker<JobPayload, void, JobName> | null = null;

  /**
   * Records an outcome without letting the recording become the outcome.
   *
   * Used only on the failure path: if the log write fails there, the job's real
   * error is the one worth surfacing and swallowing this one keeps it visible.
   * `running`/`done` are not wrapped — a database that cannot record progress
   * is a genuine job failure.
   */
  async function tryAppend(
    ctx: JobCtx,
    captureId: string,
    job: string,
    error: string,
  ): Promise<void> {
    try {
      await appendProcessingEvent(ctx.db, captureId, job, 'failed', error);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function processorFor(ctx: JobCtx) {
    return async function process(job: Job<JobPayload, void, JobName>): Promise<void> {
      const jobName: string = job.name;
      const captureId = typeof job.data.captureId === 'string' ? job.data.captureId : null;
      // `attemptsStarted` counts from 1 the moment the job is picked up, which
      // is exactly what a message reading "attempt 2 of 5" needs. The ceiling
      // comes off the job, not off this queue's configuration: the policy
      // travels with the job, so a producer that set a different count would
      // otherwise have its jobs described by a number that was never theirs.
      const attempt = job.attemptsStarted > 0 ? job.attemptsStarted : job.attemptsMade + 1;
      const attemptLimit = job.opts.attempts ?? attempts;

      try {
        // A queue outlives a deploy, so both of these are reachable in
        // production: an older worker meeting a newer job name, and a build
        // whose handler registration was forgotten. Neither may look like
        // success — an unhandled job that reported `done` would strand a
        // capture in `ready` with nothing rendered.
        if (!isJobName(jobName)) throw new Error(`unknown job name: ${jobName}`);
        const handler = handlers.get(jobName);
        if (handler === undefined) throw new Error(`no handler registered for ${jobName}`);

        if (captureId !== null) await appendProcessingEvent(ctx.db, captureId, jobName, 'running');
        await handler(job.data, ctx);
        if (captureId !== null) await appendProcessingEvent(ctx.db, captureId, jobName, 'done');
      } catch (err) {
        if (captureId !== null) {
          // Every attempt is logged, not just the last: "it failed three times"
          // is what the log is for, and the read that matters — latest row per
          // job — is unaffected by the extra rows.
          await tryAppend(
            ctx,
            captureId,
            jobName,
            `attempt ${attempt}/${attemptLimit}: ${messageOf(err)}`,
          );
        }
        // Rethrown so BullMQ, not this function, decides about retrying.
        throw err;
      }
    };
  }

  async function stopWorker(): Promise<void> {
    if (worker === null) return;
    const running = worker;
    worker = null;
    await running.close();
  }

  return {
    name,
    queue,

    async enqueue(jobName: JobName, payload: JobPayload): Promise<void> {
      await queue.add(jobName, payload, jobOptionsFor(payload.jobKey, attempts, backoffDelay));
    },

    registerHandler(jobName: JobName, fn: JobHandler): void {
      if (handlers.has(jobName)) throw new Error(`handler for ${jobName} is already registered`);
      handlers.set(jobName, fn);
    },

    start(ctx: JobCtx): Worker<JobPayload, void, JobName> {
      if (worker !== null) throw new Error(`queue ${name} is already consuming`);
      const started = new Worker<JobPayload, void, JobName>(name, processorFor(ctx), {
        connection,
        prefix,
        concurrency,
      });
      // Without a listener an emitted 'error' is an uncaught exception, which
      // would take the whole worker process down over a reconnect.
      started.on('error', onError);
      worker = started;
      return started;
    },

    async close(): Promise<void> {
      await stopWorker();
      await queue.close();
    },

    async obliterate(): Promise<void> {
      // Stop consuming first: obliterating under a running worker is how a job
      // gets half-deleted while it is being processed.
      await stopWorker();
      await queue.obliterate({ force: true });
    },
  };
}

/* ------------------------------------------------------- the process queue -- */

let defaultQueue: JobQueue | null = null;

/** Builds the process-wide queue that `enqueue`/`registerHandler` speak to. */
export function configureQueue(options: JobQueueOptions): JobQueue {
  if (defaultQueue !== null) throw new Error('the process queue is already configured');
  defaultQueue = createJobQueue(options);
  return defaultQueue;
}

function current(): JobQueue {
  if (defaultQueue === null) throw new Error('call configureQueue() before using the process queue');
  return defaultQueue;
}

/**
 * Adds a job to the process queue.
 *
 * Nothing in Task 22 calls this: capture-complete is produced by the API
 * (`apps/api/src/queue/producer.ts`), which is the process that knows a capture
 * finished. It is here for the fan-out that is worker-to-worker — Task 25's
 * export and recap jobs queue their own follow-up work.
 */
export async function enqueue(name: JobName, payload: JobPayload): Promise<void> {
  await current().enqueue(name, payload);
}

export function registerHandler(name: JobName, fn: JobHandler): void {
  current().registerHandler(name, fn);
}
