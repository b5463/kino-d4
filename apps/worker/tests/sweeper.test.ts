import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { loadWorkerConfig, type WorkerConfig } from '../src/config';
import { createJobRuntime, type JobRuntime } from '../src/context';
import { createJobQueue, jobKeyToJobId, type JobQueue } from '../src/queue';
import { processingEvents } from '../src/db/schema';
import { sweepQueuedRows, SWEEP_INTERVAL_MS, SWEEP_LIMIT, SWEEP_MIN_AGE_MS } from '../src/sweeper';

/**
 * The queued-row reconcile sweeper (audit API-14), against the real database and
 * Redis. Same house rules as `queue.test.ts`: own prefix, obliterated afterwards.
 *
 * The queue here is never started. What is under test is which rows the sweep
 * picks and what it adds to BullMQ, not what a handler does with them. Every
 * sweep is narrowed to the test's own capture: the dev database is shared with
 * live servers and other suites, and their stale rows are not this suite's.
 */
const RUN = randomBytes(4).toString('hex');
const TEST_PREFIX = `kino-jobs-test-${RUN}`;

const config: WorkerConfig = loadWorkerConfig();

let runtime: JobRuntime;

const deviceId = `dev_sweep_${RUN}`;
const rollId = `roll_sweep_${RUN}`;
const captureIds: string[] = [];
let eventSeq = 0;

const queues: JobQueue[] = [];

function newQueue(): JobQueue {
  const queue = createJobQueue({
    connection: { url: config.REDIS_URL },
    prefix: TEST_PREFIX,
    name: `sweep-${RUN}-${queues.length}`,
    attempts: 1,
    backoffDelay: 5,
  });
  queues.push(queue);
  return queue;
}

async function newCapture(): Promise<string> {
  const captureId = `cap_sweep_${RUN}_${captureIds.length}`;
  await runtime.ctx.db.execute(sql`
    insert into captures
      (id, capture_uuid, roll_id, device_id, mode, captured_at, frame_count, resolution, status)
    values
      (${captureId}, ${randomUUID()}, ${rollId}, ${deviceId}, 'wiggle', now(), 4, '1600x1200', 'processing')
  `);
  captureIds.push(captureId);
  return captureId;
}

/** One event row, `ageMs` in the past. */
async function insertEvent(
  captureId: string,
  job: string,
  status: string,
  ageMs: number,
): Promise<void> {
  eventSeq += 1;
  await runtime.ctx.db.insert(processingEvents).values({
    id: `pev_sweep_${RUN}_${eventSeq}`,
    captureId,
    job,
    status,
    at: new Date(Date.now() - ageMs),
  });
}

const THREE_MINUTES = 3 * 60 * 1000;

beforeAll(async () => {
  runtime = createJobRuntime(config);
  await runtime.ctx.db.execute(sql`
    insert into devices (id, serial, product, hardware_revision, token_hash)
    values (${deviceId}, ${`KD4-SWEEP-${RUN}`}, 'KINO D4', 'v1', ${`hash_${RUN}`})
  `);
  await runtime.ctx.db.execute(sql`
    insert into rolls (id, slug, title, host_token_hash, created_by_device_id)
    values (${rollId}, ${`SW${RUN.toUpperCase()}`}, ${`Sweep roll ${RUN}`}, ${`hash_${RUN}`}, ${deviceId})
  `);
});

afterEach(async () => {
  for (const queue of queues.splice(0)) {
    await queue.obliterate();
    await queue.close();
  }
});

afterAll(async () => {
  await runtime.ctx.db.execute(sql`delete from processing_events where capture_id like ${`cap_sweep_${RUN}%`}`);
  await runtime.ctx.db.execute(sql`delete from captures where roll_id = ${rollId}`);
  await runtime.ctx.db.execute(sql`delete from rolls where id = ${rollId}`);
  await runtime.ctx.db.execute(sql`delete from devices where id = ${deviceId}`);
  await runtime.close();
});

describe('the queued-row reconcile sweeper (audit API-14)', () => {
  it('re-adds the job for a stale queued row that BullMQ does not have, once', async () => {
    const captureId = await newCapture();
    const queue = newQueue();
    await insertEvent(captureId, 'generate-thumbnail', 'queued', THREE_MINUTES);

    const first = await sweepQueuedRows(runtime.ctx.db, queue, { captureIds: [captureId] });
    expect(first).toEqual({ scanned: 1, resubmitted: 1, present: 0, unknown: 0, retained: 0 });

    // Under the id the API would have used, carrying the payload a handler expects.
    const jobKey = `${captureId}:generate-thumbnail`;
    const job = await queue.queue.getJob(jobKeyToJobId(jobKey));
    expect(job?.name).toBe('generate-thumbnail');
    expect(job?.data).toEqual({ captureId, jobKey });
    expect(await queue.queue.getWaitingCount()).toBe(1);

    // Idempotent: the second pass sees the job and adds nothing.
    const second = await sweepQueuedRows(runtime.ctx.db, queue, { captureIds: [captureId] });
    expect(second).toEqual({ scanned: 1, resubmitted: 0, present: 1, unknown: 0, retained: 0 });
    expect(await queue.queue.getWaitingCount()).toBe(1);

    // And it wrote nothing: the row it found is the only row there is.
    const rows = await runtime.ctx.db
      .select({ status: processingEvents.status })
      .from(processingEvents)
      .where(sql`${processingEvents.captureId} = ${captureId}`);
    expect(rows).toEqual([{ status: 'queued' }]);
  });

  it('leaves a fresh queued row alone — the API may still be adding it', async () => {
    const captureId = await newCapture();
    const queue = newQueue();
    await insertEvent(captureId, 'generate-thumbnail', 'queued', 0);

    const report = await sweepQueuedRows(runtime.ctx.db, queue, { captureIds: [captureId] });
    expect(report.scanned).toBe(0);
    expect(await queue.queue.getWaitingCount()).toBe(0);
  });

  it('skips a queued row that a later row has already answered', async () => {
    const captureId = await newCapture();
    const queue = newQueue();
    // The ordinary life of a job: enqueued, run, finished. The `queued` row stays
    // in the log for good and is not a lost job.
    await insertEvent(captureId, 'extract-metadata', 'queued', THREE_MINUTES);
    await insertEvent(captureId, 'extract-metadata', 'running', THREE_MINUTES - 1000);
    await insertEvent(captureId, 'extract-metadata', 'done', THREE_MINUTES - 2000);
    // A job mid-retry is not lost either.
    await insertEvent(captureId, 'render-wiggle-webp', 'queued', THREE_MINUTES);
    await insertEvent(captureId, 'render-wiggle-webp', 'failed', THREE_MINUTES - 1000);

    const report = await sweepQueuedRows(runtime.ctx.db, queue, { captureIds: [captureId] });
    expect(report.scanned).toBe(0);
    expect(await queue.queue.getWaitingCount()).toBe(0);
  });

  it('counts a job name this build does not know and queues nothing for it', async () => {
    const captureId = await newCapture();
    const queue = newQueue();
    await insertEvent(captureId, 'render-hologram', 'queued', THREE_MINUTES);

    const report = await sweepQueuedRows(runtime.ctx.db, queue, { captureIds: [captureId] });
    expect(report).toEqual({ scanned: 1, resubmitted: 0, present: 0, unknown: 1, retained: 0 });
    expect(await queue.queue.getWaitingCount()).toBe(0);
  });

  it('is bounded by the limit and drains a backlog across runs', async () => {
    const captureId = await newCapture();
    const queue = newQueue();
    for (const job of ['generate-thumbnail', 'generate-gallery-still', 'extract-metadata']) {
      await insertEvent(captureId, job, 'queued', THREE_MINUTES);
    }

    const first = await sweepQueuedRows(runtime.ctx.db, queue, { captureIds: [captureId], limit: 2 });
    expect(first.scanned).toBe(2);
    expect(first.resubmitted).toBe(2);

    // The oldest rows go first, so the next run reaches the one that was cut —
    // and re-checks the two already present without adding them again.
    const second = await sweepQueuedRows(runtime.ctx.db, queue, { captureIds: [captureId], limit: 3 });
    expect(second.scanned).toBe(3);
    expect(second.resubmitted).toBe(1);
    expect(second.present).toBe(2);
    expect(await queue.queue.getWaitingCount()).toBe(3);
  });

  it('ships the documented cadence', () => {
    expect(SWEEP_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(SWEEP_MIN_AGE_MS).toBe(2 * 60 * 1000);
    expect(SWEEP_LIMIT).toBe(200);
  });
});
