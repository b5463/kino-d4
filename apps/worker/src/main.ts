import { loadWorkerConfig } from './config';
import { createJobRuntime } from './context';
import { registerImageHandlers, registerRollHandlers } from './jobs';
import { createEraser } from './storage/eraser';
import { purgeTrash, PURGE_CRON } from './jobs/purgeTrash';
import { configureQueue, jobOptionsFor } from './queue';

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

  const worker = queue.start(runtime.ctx);
  console.log(`[worker] consuming ${queue.name}`);

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal}: finishing active jobs`);
    // Not forced: an in-flight render is allowed to finish, and anything still
    // waiting stays in the queue for the next process. A half-written
    // derivative is worse than a slow shutdown.
    void worker
      .close()
      .then(() => queue.close())
      .then(() => runtime.close())
      .then(() => eraser.close())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error('[worker] shutdown failed', err);
        process.exit(1);
      });
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

await main();
