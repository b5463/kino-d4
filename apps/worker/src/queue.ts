import {
  Queue,
  UnrecoverableError,
  Worker,
  type Job,
  type JobsOptions,
  type RedisOptions,
} from 'bullmq';
import { availableParallelism } from 'node:os';
import {
  appendProcessingEvent,
  isCaptureGoneViolation,
  markJobAbandoned,
  markJobSucceeded,
  truncateError,
} from './jobs/events';
import { errorFields, log } from './log';
import { markOutsideFailure } from './jobs/outsideFailure';
import {
  JOB_LOCK_DURATION_MS,
  JOB_MAX_STALLED_COUNT,
  JOB_STALLED_INTERVAL_MS,
} from './queueTiming';
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
 * - **Terminal.** A job that is over is *finished*, and says so, in both
 *   directions: `markJobSucceeded` appends `done` and `markJobAbandoned`
 *   appends `abandoned`, and both retire the `queued` row the API wrote.
 *   Without that retirement a finished job left its enqueue lock in place, so
 *   no later capture-complete could ever re-queue it — on the failure path that
 *   also left the capture in `processing` forever, because its latest row said
 *   `failed` and a `failed` row is indistinguishable from "attempt 2 of 5"; on
 *   the success path it made every re-render a silent no-op. Retiring the row
 *   does not weaken the idempotency above: two concurrent runs of one
 *   `(capture, job)` are stopped by the `jobId`, not by that row. See the long
 *   note on `retireQueuedRow` for why the mechanism is a supersede rather than
 *   a delete.
 *   A job whose *capture row* is gone is terminal in a different way: nothing can
 *   be recorded against it and nobody is waiting for it, so the processor drops
 *   it — one warning, no rows, and BullMQ files it as complete. See the catch
 *   block in `processorFor`.
 * - **Independent.** Every job runs inside its own try/catch with its own
 *   `processing_events` rows. A handler that throws marks *its* job failed and
 *   touches nothing else, so a dead MP4 render cannot cost a capture its
 *   originals or its thumbnail (07 §26). Handlers share no state: what they get
 *   is the payload and the context, and the context's only write path is
 *   `putDerived`.
 *
 * ## Why a factory
 *
 * `createJobQueue` is the real object: tests need their own queue, on their own
 * prefix, with a backoff measured in milliseconds instead of tens of seconds.
 * `configureQueue` is the same thing with a one-per-process guard, which is
 * what `main.ts` wants; callers hold the object it returns and call
 * `queue.enqueue` / `queue.registerHandler` on it.
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

/**
 * The worker's timing knobs live in `queueTiming.ts`, re-exported here so that
 * `main.ts` and the tests keep one import for "the queue's constants".
 */
export {
  JOB_LOCK_DURATION_MS,
  JOB_MAX_STALLED_COUNT,
  JOB_STALLED_INTERVAL_MS,
  SHUTDOWN_GRACE_MS,
} from './queueTiming';

export function jobKeyToJobId(jobKey: string): string {
  if (jobKey.includes(JOB_ID_SEPARATOR)) {
    throw new Error(`job key ${jobKey} may not contain ${JOB_ID_SEPARATOR}`);
  }
  return jobKey.split(':').join(JOB_ID_SEPARATOR);
}

/** The most jobs one worker runs at once, whatever the box. */
export const JOB_CONCURRENCY_MAX = 4;

/**
 * How many jobs one worker process runs at once: `floor(cores / 2)`, at least
 * 1, at most 4.
 *
 * Above one because the jobs are wildly uneven — `extract-metadata` is
 * milliseconds, `render-wiggle-mp4` is seconds — and a party-time queue where a
 * render blocks every thumbnail behind it is the failure 07 §26 is about.
 *
 * ## Why it is derived and not 4
 *
 * The work is CPU-bound, and `images/tuning.ts` gives libvips
 * `floor(cores / JOB_CONCURRENCY)` threads per pipeline, floored at 1. A fixed
 * 4 therefore stopped being a limit on a small box and became oversubscription:
 * on a 2-core container it is 4 jobs × 1 thread = 4 runnable CPU-bound threads
 * for 2 cores, plus up to 4 ffmpeg processes. Nothing finishes sooner; every job
 * takes ~2× longer, and four jobs' worth of decoded frames sit in memory at once
 * (~45 MB each at 1600×1200) instead of one's.
 *
 * `cores / 2` keeps the product at the core count on every size: 8 cores → 4
 * jobs × 2 threads; 4 → 2 × 2; 2 → 1 × 2. The cap at 4 is memory and the ffmpeg
 * processes, not CPU — a 32-core box would otherwise run 16 renders and hold 16
 * jobs' pixel buffers.
 *
 * `availableParallelism()` rather than `cpus().length`, for the reason
 * `images/tuning.ts` spells out: it respects the cgroup CPU quota the container
 * was actually given.
 */
export const JOB_CONCURRENCY = Math.min(
  JOB_CONCURRENCY_MAX,
  Math.max(1, Math.floor(availableParallelism() / 2)),
);

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
  /** Where a dropped job is reported — not an error, somebody should still see it. */
  onWarn?: (message: string) => void;
}

export interface JobQueue {
  readonly name: string;
  /** The BullMQ queue itself, for introspection and teardown. */
  readonly queue: Queue<JobPayload, void, JobName>;
  enqueue(name: JobName, payload: JobPayload): Promise<void>;
  registerHandler(name: JobName, fn: JobHandler): void;
  /** Starts consuming. One worker per queue object. */
  start(ctx: JobCtx): Worker<JobPayload, void, JobName>;
  /**
   * Stops consuming and closes the connections.
   *
   * `graceMs` bounds the wait for active jobs; past it the worker is force
   * closed. Omit it for the unbounded wait a test wants, where nothing is going
   * to send a `SIGKILL` in ten seconds.
   *
   * @returns the names of the jobs that were still running when the deadline
   *          passed, so the caller can say which ones were cut off.
   */
  close(graceMs?: number): Promise<string[]>;
  /** Deletes every key of this queue. Tests only — never point it at a live prefix. */
  obliterate(): Promise<void>;
}

/**
 * Whether BullMQ is done with this job.
 *
 * Two ways to be finished: the attempts ran out, or the handler said not to try
 * again. `UnrecoverableError` is BullMQ's own signal for the second — a handler
 * that throws it skips the remaining attempts — so a terminal check that only
 * counted attempts would leave exactly those jobs blocking their own re-enqueue,
 * which is the failure this is here to prevent.
 */
function isTerminal(err: unknown, attempt: number, attemptLimit: number): boolean {
  return err instanceof UnrecoverableError || attempt >= attemptLimit;
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
      log.error('queue error', errorFields(err, log.level === 'debug'));
    });
  const onWarn =
    options.onWarn ??
    ((message: string): void => {
      log.warn(message);
    });

  // BullMQ's blocking connection requires an unbounded retry setting; a caller
  // that names one wins, so a deployment can still pin its own client options.
  const connection: RedisOptions = { maxRetriesPerRequest: null, ...options.connection };

  const queue = new Queue<JobPayload, void, JobName>(name, { connection, prefix });
  queue.on('error', onError);

  const handlers = new Map<JobName, JobHandler>();
  let worker: Worker<JobPayload, void, JobName> | null = null;

  /**
   * The jobs whose processor actually ran.
   *
   * A `WeakSet` of the job objects rather than a set of ids, because the ids
   * would need clearing and these do not — the entry goes when BullMQ drops its
   * reference to the job. It answers exactly one question, asked in the `failed`
   * listener: did this failure come out of `process()`, or did BullMQ produce it
   * on its own?
   */
  const processorRan = new WeakSet<Job<JobPayload, void, JobName>>();

  /** Job id → job name, for the jobs running right now. Read at shutdown. */
  const running = new Map<string, string>();

  /**
   * Records an outcome without letting the recording become the outcome.
   *
   * Used only on the failure path: if the log write fails there, the job's real
   * error is the one worth surfacing and swallowing this one keeps it visible.
   * `running`/`done` are not wrapped — a database that cannot record progress
   * is a genuine job failure.
   *
   * Returns `false` when the write failed *because the capture row is gone*:
   * the caller drops the job at that point instead of retrying into the same
   * constraint four more times.
   */
  async function tryLog(what: string, write: () => Promise<void>): Promise<boolean> {
    try {
      await write();
      return true;
    } catch (err) {
      if (isCaptureGoneViolation(err)) return false;
      onError(
        new Error(`could not record ${what}: ${truncateError(err)}`, {
          cause: err instanceof Error ? err : undefined,
        }),
      );
      return true;
    }
  }

  function processorFor(ctx: JobCtx) {
    return async function process(job: Job<JobPayload, void, JobName>): Promise<void> {
      processorRan.add(job);
      if (job.id !== undefined) running.set(job.id, job.name);
      try {
        return await runJob(ctx, job);
      } finally {
        if (job.id !== undefined) running.delete(job.id);
      }
    };
  }

  /** The job itself, as it always was; only the bookkeeping above is new. */
  async function runJob(ctx: JobCtx, job: Job<JobPayload, void, JobName>): Promise<void> {
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
      // `markJobSucceeded`, not a bare `done` append: the `done` row and the
      // retirement of the API's `queued` row are one transaction, because a
      // `done` row over a live enqueue lock is a job nothing can ever queue
      // again. See the note on `retireQueuedRow`.
      if (captureId !== null) await markJobSucceeded(ctx.db, captureId, jobName);
    } catch (err) {
      if (captureId !== null) {
        // The capture row is gone — trashed and purged, or a test's fixture
        // deleted under a job it queued. The `running` insert above is
        // usually what says so, before the handler ever ran. Nothing can be
        // recorded against a capture that does not exist, and nothing is
        // waiting for the derivative, so the job is *dropped*: one warning,
        // no rows, a normal return so BullMQ files it as complete rather
        // than retrying into the same constraint five times over.
        if (isCaptureGoneViolation(err)) {
          onWarn(`dropped ${jobName} for ${captureId}: the capture row no longer exists`);
          return;
        }

        // Every attempt is logged, not just the last: "it failed three times"
        // is what the log is for, and the read that matters — latest row per
        // job — is unaffected by the extra rows.
        const recorded = await tryLog('a failed attempt', () =>
          appendProcessingEvent(
            ctx.db,
            captureId,
            jobName,
            'failed',
            `attempt ${attempt}/${attemptLimit}: ${truncateError(err)}`,
          ),
        );
        // Same drop, reached the other way round: the handler failed (often
        // with `MissingCaptureError`) and the capture vanished before or
        // while it ran, so even the failure cannot be written down.
        if (!recorded) {
          onWarn(
            `dropped ${jobName} for ${captureId}: the capture row no longer exists (${truncateError(err)})`,
          );
          return;
        }

        // This was the last attempt, so the job is over. Both writes are
        // tolerated failures for the same reason the one above is: the job's
        // own error is what somebody needs to see, and losing this row to a
        // database blip must not replace it.
        if (isTerminal(err, attempt, attemptLimit)) {
          await tryLog('a terminal failure', () =>
            markJobAbandoned(
              ctx.db,
              captureId,
              jobName,
              `abandoned after ${attempt}/${attemptLimit} attempts: ${truncateError(err)}`,
            ),
          );
        }
      }
      // Rethrown so BullMQ, not this function, decides about retrying.
      throw err;
    }
  }

  /**
   * Stops the worker, with a deadline when one is given.
   *
   * The obvious shape — race `close()` against a timer and call `close(true)` if
   * the timer wins — does not work, and it fails silently. `Worker.close()`
   * memoises its own promise: a second call returns the first one and **ignores
   * `force`** (bullmq 6.1.2, `Worker.close`). So the forced close would be a
   * no-op awaiting the polite close that is already stuck.
   *
   * The order that does work is: stop taking new jobs, watch the jobs that are
   * already running, and then close once — forced only if any are left.
   * `pause(true)` is the "stop fetching, do not wait" call, and `running` is the
   * map the processor maintains, so the wait is over exactly when the last
   * handler returns rather than a poll interval later.
   */
  async function stopWorker(graceMs?: number): Promise<string[]> {
    if (worker === null) return [];
    const stopping = worker;
    worker = null;

    if (graceMs === undefined) {
      await stopping.close();
      return [];
    }

    // No new jobs from here on, so `running` can only shrink.
    await stopping.pause(true);

    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve) => {
        if (running.size === 0) {
          resolve();
          return;
        }
        // 100 ms: the wait ends on the job's own completion, and this only
        // decides how soon that is noticed. Short enough to be invisible inside
        // an eight-second budget, long enough not to spin.
        timer = setInterval(() => {
          if (running.size === 0) resolve();
        }, 100);
        timer.unref();
        setTimeout(resolve, graceMs).unref();
      });
    } finally {
      if (timer !== undefined) clearInterval(timer);
    }

    const stragglers = [...running.values()];
    // Forced only when something is still running: those jobs are about to be
    // killed by the runtime anyway, and a forced close at least gives the
    // connections back. Their locks then lapse, the stalled checker on the next
    // worker finds them, and `markOutsideFailure` writes the row that says so.
    await stopping.close(stragglers.length > 0);
    return stragglers;
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
        lockDuration: JOB_LOCK_DURATION_MS,
        stalledInterval: JOB_STALLED_INTERVAL_MS,
        maxStalledCount: JOB_MAX_STALLED_COUNT,
      });
      // Without a listener an emitted 'error' is an uncaught exception, which
      // would take the whole worker process down over a reconnect.
      started.on('error', onError);
      /*
       * The other half of the terminal contract. `processorFor` writes the rows
       * for a failure it produced; this catches the ones it did not — a job
       * whose lock lapsed and stalled out, which BullMQ fails without ever
       * calling the processor. Without it that job leaves no `failed` row, no
       * `abandoned` row, and a capture pinned in `processing` behind a `queued`
       * row nothing will ever clear.
       */
      started.on('failed', (job, err) => {
        if (job === undefined || processorRan.has(job)) return;
        void markOutsideFailure(ctx, job, err);
      });
      worker = started;
      return started;
    },

    async close(graceMs?: number): Promise<string[]> {
      const stragglers = await stopWorker(graceMs);
      await queue.close();
      return stragglers;
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

/*
 * The process-wide `enqueue`/`registerHandler` wrappers that used to live here
 * are gone. Both had zero callers — `main.ts` and every test hold the object
 * `configureQueue` returns and call `queue.enqueue` / `queue.registerHandler`
 * on it — and `enqueue`'s docstring described a fan-out that does not exist:
 * Task 25's export and recap jobs do not queue follow-up work, and the sweeper
 * (`sweeper.ts`) is the only worker-side producer there is, through `JobQueue`.
 *
 * It was also the wrong shape to copy from. `queue.add()` is a no-op against an
 * existing `jobId` **in every state**, retained completions and failures
 * included, so a producer that wants the work to actually run has to `remove`
 * first — which the API's `submitJob` does and this did not. `sweepQueuedRows`
 * is the worker's version of that, and it removes a finished job before it
 * re-adds one (see `TERMINAL_JOB_STATES`).
 */
