import { loadWorkerConfig } from './config';
import { createJobRuntime } from './context';
import { configureQueue } from './queue';

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
 * Registering handlers is Tasks 23–25's job. Until then this process starts,
 * connects, consumes — and fails every job it is given, loudly, with a
 * `processing_events` row saying no handler was registered. That is the correct
 * behaviour for a scaffold: the alternative, reporting work done that nobody
 * did, would leave captures claiming derivatives that do not exist.
 */
async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const runtime = createJobRuntime(config);
  const queue = configureQueue({ connection: { url: config.REDIS_URL } });

  /*
   * Tasks 23–25 register the real handlers here, e.g.
   *
   *   registerHandler('generate-thumbnail', generateThumbnail);
   *
   * Each one is an independent function of (payload, ctx) — no shared state, no
   * ordering between them, and `ctx.putDerived` as its only write path.
   */

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
