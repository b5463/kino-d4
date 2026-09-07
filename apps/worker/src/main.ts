import { loadWorkerConfig } from './config';
import { createJobRuntime } from './context';
import { registerImageHandlers, registerRollHandlers } from './jobs';
import { pinSharpRuntime } from './images/tuning';
import { configureLogger, errorFields, log } from './log';
import { createEraser } from './storage/eraser';
import { purgeTrash, PURGE_CRON } from './jobs/purgeTrash';
import { configureQueue, jobOptionsFor, SHUTDOWN_GRACE_MS } from './queue';
import { describeSweep, SWEEP_INTERVAL_MS, sweepQueuedRows } from './sweeper';

/**
 * The worker process.
 *
 * It is a separate process from the API on purpose (05 §11). The API answers a
 * camera in milliseconds; a wiggle render takes seconds and pins a core. Sharing
 * an event loop between the two means a party's worth of renders decides how
 * fast the next upload is acknowledged, and 07 §26's "a failed MP4 must not
 * affect originals" is much easier to hold when the thing that can fail is not
 * inside the process that holds the upload.
 *
 * Tasks 23–25 register the capture derivatives, recap, optional enhancement,
 * roll export, and retention purge. A name outside those registries still fails
 * loudly rather than reporting work done that nobody did.
 */
async function main(): Promise<void> {
  const config = loadWorkerConfig();
  // Before anything else logs: `loadWorkerConfig` is what can refuse to boot,
  // and its refusal should still be readable at the default level.
  configureLogger(config.LOG_LEVEL);

  // Once, at start, before any handler builds a pipeline. See the arithmetic in
  // `images/tuning.ts`.
  pinSharpRuntime();

  const runtime = createJobRuntime(config);
  const eraser = createEraser(config);
  const queue = configureQueue({
    connection: { url: config.REDIS_URL },
    prefix: config.JOB_QUEUE_PREFIX,
  });

  /*
   * Each handler is an independent function of (payload, ctx) — no shared state,
   * no ordering between them, and `ctx.putDerived` as its only write path.
   * Roll-scoped handlers have a separate registry because their payloads and
   * state do not belong to a single capture.
   */
  registerImageHandlers(queue);
  registerRollHandlers(queue);
  queue.registerHandler('purge-trash', purgeTrash(eraser));

  const { jobId: _jobId, ...purgeOptions } = jobOptionsFor('system:purge-trash');
  await queue.queue.upsertJobScheduler(
    'purge-trash',
    { pattern: PURGE_CRON },
    {
      name: 'purge-trash',
      data: { jobKey: 'system:purge-trash' },
      opts: purgeOptions,
    },
  );

  queue.start(runtime.ctx);
  log.info('consuming', { queue: queue.name, level: config.LOG_LEVEL });

  // The queued-row reconcile sweep (audit API-14): once now, because a restart
  // is exactly when a lost add is most likely to have happened, then every five
  // minutes. A sweep that fails is logged and the next one runs anyway.
  const sweep = async (): Promise<void> => {
    try {
      const report = await sweepQueuedRows(runtime.ctx.db, queue);
      // At debug when there was nothing to do — a five-minute heartbeat saying
      // "0 rows" is the kind of line that trains people to stop reading logs.
      const line = describeSweep(report);
      if (report.resubmitted > 0 || report.unknown > 0) log.info(line, { ...report });
      else log.debug(line, { ...report });
    } catch (err) {
      log.error('sweep failed', errorFields(err, log.level === 'debug'));
    }
  };
  void sweep();
  const sweeper = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    clearInterval(sweeper);
    log.info('shutting down', { signal, graceMs: SHUTDOWN_GRACE_MS });
    /*
     * Bounded, and that bound is the whole point. An in-flight render is still
     * allowed to finish — a half-written derivative is worse than a slow
     * shutdown — but only until the deadline, because the runtime does not wait
     * either: Docker sends SIGTERM, counts to ten, and sends SIGKILL. An
     * unbounded `close()` therefore does not protect the render, it just makes
     * sure the process is killed while it still holds the job's lock, which is
     * exactly the stall the queue's stalled-job handling then has to clean up.
     *
     * `worker` is closed through the queue so both the worker and the queue's
     * own connection go, in that order.
     */
    void queue
      .close(SHUTDOWN_GRACE_MS)
      .then((stragglers) => {
        if (stragglers.length > 0) {
          // Named, so the operator knows which render was cut off rather than
          // finding out from a capture stuck in `processing` tomorrow.
          log.warn('forced shutdown with jobs still running', { jobs: stragglers });
        }
      })
      .then(() => runtime.close())
      .then(() => eraser.close())
      .then(() => {
        process.exit(0);
      })
      .catch((err: unknown) => {
        log.error('shutdown failed', errorFields(err, true));
        process.exit(1);
      });
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

await main();
