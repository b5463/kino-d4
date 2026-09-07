import { availableParallelism } from 'node:os';
import sharp from 'sharp';
import { JOB_CONCURRENCY } from '../queue';
import { log } from '../log';

/**
 * Sizing libvips against the container, once, at start.
 *
 * ## The arithmetic
 *
 * sharp hands each pipeline to libvips, and libvips defaults its thread pool to
 * **the machine's CPU count, per pipeline**. This worker runs `JOB_CONCURRENCY`
 * = 4 jobs at a time and most of them are sharp pipelines, so on an 8-core host
 * that is 4 × 8 = 32 worker threads fighting over 8 cores — plus the four
 * ffmpeg processes a render batch can spawn. Oversubscription like that does not
 * make anything faster; it makes every job slower by the same factor and turns a
 * 2 GB container into an OOM kill, because each of those threads carries its own
 * tile buffers.
 *
 * So: `floor(cores / JOB_CONCURRENCY)`, at least 1. Four jobs × two threads on an
 * 8-core box is 8 threads for 8 cores, which is the number that was meant all
 * along. On a 2-core box it is 4 × 1 — one thread per job, no oversubscription,
 * and the concurrency limit is doing the scheduling instead of the thread pool.
 *
 * `availableParallelism()` rather than `cpus().length`, because it respects the
 * cgroup CPU quota a container is actually given; `cpus()` reports the host's
 * cores and would size the pool for a machine this process cannot have.
 *
 * ## And the cache
 *
 * Off. libvips keeps a cache of recent operations — 50 MB, 20 open files and 200
 * items by default — which pays for itself when the same image is processed
 * repeatedly with different parameters. Nothing here does that: every handler
 * fetches an object, runs one pipeline over it, and never looks at those bytes
 * again. What the cache holds is therefore always bytes nobody will ask for, and
 * the file half holds descriptors open on temp files this worker is about to
 * delete. Leaving it at the default costs memory in the one place — a small
 * container — where memory is what runs out first.
 */
export interface SharpTuning {
  /** libvips threads per pipeline. */
  concurrency: number;
  /** Detected parallelism, for the log line. */
  cores: number;
}

export function pinSharpRuntime(jobConcurrency: number = JOB_CONCURRENCY): SharpTuning {
  const cores = availableParallelism();
  const concurrency = Math.max(1, Math.floor(cores / Math.max(1, jobConcurrency)));

  sharp.concurrency(concurrency);
  sharp.cache(false);

  log.info('sharp pinned', { cores, jobConcurrency, libvipsThreadsPerPipeline: concurrency });
  return { concurrency, cores };
}
