/**
 * The worker's timing knobs: how long a job's lock is good for, how often a
 * lapsed one is looked for, and how long a shutdown waits.
 *
 * Their own module because every one of them is a paragraph of reasoning about
 * BullMQ's behaviour rather than a number, and because `queue.ts` is where the
 * queue's *contract* lives — the ids, the retry policy, the terminal rules. A
 * reader tuning a deployment wants these four together; a reader following a
 * job through the processor does not want to read past them first.
 */

/**
 * How long a worker's claim on a job is good for before another worker may
 * take it.
 *
 * BullMQ's default is 30 s, and the lock is renewed automatically every
 * `lockDuration / 2` for as long as the job is active (bullmq 6.1.2,
 * `LockManager`). Renewal happens on this process's event loop, which is the
 * catch: a `render-recap` that spends ninety seconds inside one synchronous
 * sharp call, or a `export-roll` whose ZIP write blocks, does not get to run the
 * renewal timer — and a lock that lapses is a job another worker starts while
 * this one is still writing its output. Two workers packing the same ZIP to the
 * same key is the failure; the second one wins the race to `putRollDerivedFile`
 * and the host downloads whichever half finished last.
 *
 * Five minutes is chosen against the *renewal* interval, not the job: it means
 * the loop has to be blocked for 2.5 minutes straight before a lock is even at
 * risk, which no single operation in this worker comes close to. It is not a
 * budget for a long job — the renewal is what covers a ninety-minute recap.
 */
export const JOB_LOCK_DURATION_MS = 5 * 60 * 1000;

/**
 * How often this worker looks for jobs whose lock lapsed.
 *
 * Kept at BullMQ's 30 s default and stated explicitly, because it is now much
 * shorter than `lockDuration` and that is deliberate: the check is cheap, and a
 * job orphaned by a `SIGKILL` should be found in seconds even though the lock it
 * left behind takes five minutes to expire.
 */
export const JOB_STALLED_INTERVAL_MS = 30 * 1000;

/**
 * How many times a job may be found unlocked-in-active before it is failed
 * outright. BullMQ's default of 1, stated because `markOutsideFailure` below
 * depends on the behaviour: past this count the job is failed *outside* the
 * processor, which is exactly the case that used to leave no database row.
 */
export const JOB_MAX_STALLED_COUNT = 1;

/**
 * How long `close()` waits for active jobs before it stops waiting.
 *
 * `worker.close()` on its own waits for every active job with no deadline, which
 * reads like the careful thing to do and is not: Docker sends `SIGTERM`, waits
 * ten seconds, and sends `SIGKILL`. A ninety-minute recap therefore does not get
 * to finish — it gets killed mid-render with its lock held, which is precisely
 * the stall this file's `markStalledFailure` exists to clean up after.
 *
 * Eight seconds fits inside Docker's ten with room for the database, Redis and
 * S3 clients to close afterwards. Anything still running past it is force-closed
 * and named in the log, so the operator sees which render was cut off rather
 * than inferring it from a silence.
 */
export const SHUTDOWN_GRACE_MS = 8_000;
