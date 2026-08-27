import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { loadWorkerConfig, type WorkerConfig } from '../src/config';
import { createJobRuntime, type JobRuntime } from '../src/context';
import {
  createJobQueue,
  jobKeyToJobId,
  type JobQueue,
  type JobQueueOptions,
} from '../src/queue';
import { processingEvents } from '../src/db/schema';

/**
 * The worker scaffold (Task 22), against a real Redis, a real database and real
 * MinIO — the dev stack must be up AND migrated:
 *
 *   docker compose -f infra/docker-compose.dev.yml up -d
 *   npm run db:migrate -w @kino/api
 *
 * Handlers here are fakes. Task 22 is the queue, not the work: what is under
 * test is that the same `jobKey` runs once, that a handler which throws is
 * recorded and contained, and that retries stop where the policy says they do.
 *
 * Every queue is created under a test-only prefix and obliterated afterwards,
 * so a rerun starts from an empty keyspace and nothing here can touch the
 * `kino-jobs` prefix the API's producer writes to.
 */
const RUN = randomBytes(4).toString('hex');

/** Never `kino-jobs`: a test must not be able to obliterate real queue data. */
const TEST_PREFIX = `kino-jobs-test-${RUN}`;

const config: WorkerConfig = loadWorkerConfig();

let runtime: JobRuntime;

/** Fixture rows, deleted children-first in `afterAll`. */
const deviceId = `dev_t22_${RUN}`;
const rollId = `roll_t22_${RUN}`;
const captureIds: string[] = [];
const writtenKeys: string[] = [];

const queues: JobQueue[] = [];

function newQueue(overrides: Partial<JobQueueOptions> = {}): JobQueue {
  const queue = createJobQueue({
    connection: { url: config.REDIS_URL },
    prefix: TEST_PREFIX,
    name: `t22-${RUN}-${queues.length}`,
    // One attempt unless a test is about retrying, so a fake handler that
    // throws settles immediately instead of sitting in a backoff.
    attempts: 1,
    backoffDelay: 5,
    ...overrides,
  });
  queues.push(queue);
  return queue;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  what: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** A capture row of its own per test, so no two tests share an event log. */
async function newCapture(): Promise<string> {
  const captureId = `cap_t22_${RUN}_${captureIds.length}`;
  await runtime.ctx.db.execute(sql`
    insert into captures
      (id, capture_uuid, roll_id, device_id, mode, captured_at, frame_count, resolution, status)
    values
      (${captureId}, ${randomUUID()}, ${rollId}, ${deviceId}, 'wiggle', now(), 4, '1600x1200', 'processing')
  `);
  captureIds.push(captureId);
  return captureId;
}

/** The capture's processing log, oldest first — the shape the API reads back. */
async function eventsFor(captureId: string): Promise<{ job: string; status: string }[]> {
  return runtime.ctx.db
    .select({ job: processingEvents.job, status: processingEvents.status })
    .from(processingEvents)
    .where(eq(processingEvents.captureId, captureId))
    .orderBy(asc(processingEvents.at), asc(processingEvents.id));
}

function statusesOf(rows: { job: string; status: string }[], job: string): string[] {
  return rows.filter((row) => row.job === job).map((row) => row.status);
}

beforeAll(async () => {
  runtime = createJobRuntime(config);

  const tables = await runtime.ctx.db.execute<{ table_name: string }>(sql`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('captures', 'processing_events')
  `);
  if (Array.from(tables).length < 2) {
    throw new Error(
      'Database is not migrated: captures/processing_events missing. ' +
        'Run `npm run db:migrate -w @kino/api` against DATABASE_URL and re-run the tests.',
    );
  }

  // A capture needs a device and a roll to point at; both are FK targets and
  // nothing here reads them back.
  await runtime.ctx.db.execute(sql`
    insert into devices (id, serial, product, hardware_revision, token_hash)
    values (${deviceId}, ${`KD4-T22-${RUN}`}, 'KINO D4', 'v1', ${`hash_${RUN}`})
  `);
  await runtime.ctx.db.execute(sql`
    insert into rolls (id, slug, title, host_token_hash, created_by_device_id)
    values (${rollId}, ${`T22${RUN.toUpperCase()}`}, ${`Worker roll ${RUN}`}, ${`hash_${RUN}`}, ${deviceId})
  `);
});

afterEach(async () => {
  for (const queue of queues.splice(0)) {
    await queue.obliterate();
    await queue.close();
  }
});

afterAll(async () => {
  for (const key of writtenKeys) {
    try {
      await runtime.ctx.s3.send(
        new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
      );
    } catch {
      /* a leftover test object costs a few KB; a failed teardown costs the suite */
    }
  }

  await runtime.ctx.db.execute(sql`delete from processing_events where capture_id like ${`cap_t22_${RUN}%`}`);
  await runtime.ctx.db.execute(sql`delete from captures where roll_id = ${rollId}`);
  await runtime.ctx.db.execute(sql`delete from rolls where id = ${rollId}`);
  await runtime.ctx.db.execute(sql`delete from devices where id = ${deviceId}`);

  await runtime.close();
});

describe('idempotency: the jobKey is the jobId (03 §19)', () => {
  it('runs a job once however many times the same jobKey is enqueued', async () => {
    const captureId = await newCapture();
    const queue = newQueue();
    const jobKey = `${captureId}:extract-metadata`;

    let runs = 0;
    queue.registerHandler('extract-metadata', async () => {
      runs += 1;
    });

    // Enqueued three times before anything consumes: BullMQ keeps one job per
    // jobId, so the second and third calls are no-ops rather than duplicates.
    await queue.enqueue('extract-metadata', { captureId, jobKey });
    await queue.enqueue('extract-metadata', { captureId, jobKey });
    await queue.enqueue('extract-metadata', { captureId, jobKey });
    expect(await queue.queue.getWaitingCount()).toBe(1);

    queue.start(runtime.ctx);
    await waitFor('the job to run', () => runs > 0);
    // Long enough that a duplicate would have been picked up by now.
    await sleep(300);

    expect(runs).toBe(1);
    expect(statusesOf(await eventsFor(captureId), 'extract-metadata')).toEqual(['running', 'done']);
  });

  it('is still a no-op when the job is re-enqueued while it sits completed', async () => {
    const captureId = await newCapture();
    const queue = newQueue();
    const jobKey = `${captureId}:generate-thumbnail`;

    let runs = 0;
    queue.registerHandler('generate-thumbnail', async () => {
      runs += 1;
    });

    queue.start(runtime.ctx);
    await queue.enqueue('generate-thumbnail', { captureId, jobKey });
    await waitFor('the first run', () => runs === 1);

    // The API's capture-complete is retryable, so this is the real second call:
    // the job is finished but still recorded under its id, and BullMQ refuses to
    // add another with the same one.
    await queue.enqueue('generate-thumbnail', { captureId, jobKey });
    await sleep(300);
    expect(runs).toBe(1);
  });
});

describe('independence: one failure touches nothing else (07 §26)', () => {
  it('records a throwing handler as failed and still runs the other job of that capture', async () => {
    const captureId = await newCapture();
    const queue = newQueue();

    let thumbnails = 0;
    queue.registerHandler('render-wiggle-webp', async () => {
      throw new Error('ffmpeg exploded');
    });
    queue.registerHandler('generate-thumbnail', async () => {
      thumbnails += 1;
    });

    await queue.enqueue('render-wiggle-webp', {
      captureId,
      jobKey: `${captureId}:render-wiggle-webp`,
    });
    await queue.enqueue('generate-thumbnail', {
      captureId,
      jobKey: `${captureId}:generate-thumbnail`,
    });
    queue.start(runtime.ctx);

    await waitFor('both jobs to settle', async () => {
      const rows = await eventsFor(captureId);
      return (
        // `abandoned`, not `failed`. The terminal-failure path writes
        // `abandoned` *after* `failed`, and the assertion below requires it —
        // so gating on `failed` let the assertion run one row early and the
        // test failed intermittently under load with
        // ['running','failed'] !== ['running','failed','abandoned'].
        // Wait for the last row the assertion needs, not the first.
        statusesOf(rows, 'render-wiggle-webp').includes('abandoned') &&
        statusesOf(rows, 'generate-thumbnail').includes('done')
      );
    });

    const rows = await eventsFor(captureId);
    // The MP4/webp render died; the thumbnail is untouched by it, which is the
    // whole of 07 §26 in one assertion. `abandoned` closes the render out — this
    // queue is configured for a single attempt, so the first failure is also the
    // last (Task 23's terminal-failure policy).
    expect(statusesOf(rows, 'render-wiggle-webp')).toEqual(['running', 'failed', 'abandoned']);
    expect(statusesOf(rows, 'generate-thumbnail')).toEqual(['running', 'done']);
    expect(thumbnails).toBe(1);
  });

  it('fails a job whose name has no handler instead of reporting it done', async () => {
    const captureId = await newCapture();
    const queue = newQueue();

    await queue.enqueue('ai-enhance', { captureId, jobKey: `${captureId}:ai-enhance` });
    queue.start(runtime.ctx);

    await waitFor('the unhandled job to be recorded', async () =>
      statusesOf(await eventsFor(captureId), 'ai-enhance').includes('failed'),
    );
    // No `running` row: the name was rejected before a handler could be looked
    // up. `abandoned` follows because a job with no handler has nothing to retry
    // into — a redeploy that adds one re-queues the work, which is exactly what
    // the released enqueue block is for.
    expect(statusesOf(await eventsFor(captureId), 'ai-enhance')).toEqual(['failed', 'abandoned']);
  });
});

describe('retry policy', () => {
  it('stops at the configured attempt count', async () => {
    const captureId = await newCapture();
    const queue = newQueue({ attempts: 3, backoffDelay: 10 });

    let calls = 0;
    queue.registerHandler('extract-metadata', async () => {
      calls += 1;
      throw new Error('still broken');
    });

    const jobKey = `${captureId}:extract-metadata`;
    await queue.enqueue('extract-metadata', { captureId, jobKey });
    queue.start(runtime.ctx);

    await waitFor('the job to exhaust its attempts', async () => {
      const job = await queue.queue.getJob(jobKeyToJobId(jobKey));
      return (await job?.isFailed()) === true;
    });
    await sleep(300);

    expect(calls).toBe(3);
    // Every attempt is logged, so the log says how many times it was tried, and
    // the last one is followed by the row that says there will not be a fourth.
    expect(statusesOf(await eventsFor(captureId), 'extract-metadata')).toEqual([
      'running',
      'failed',
      'running',
      'failed',
      'running',
      'failed',
      'abandoned',
    ]);
  });

  it('defaults to 5 attempts and a 10 s exponential backoff (03 §19)', async () => {
    const captureId = await newCapture();
    // No attempts/backoff override: this reads the shipped policy.
    const queue = createJobQueue({
      connection: { url: config.REDIS_URL },
      prefix: TEST_PREFIX,
      name: `t22-${RUN}-policy`,
    });
    queues.push(queue);

    const jobKey = `${captureId}:purge-trash`;
    await queue.enqueue('purge-trash', { captureId, jobKey });

    const job = await queue.queue.getJob(jobKeyToJobId(jobKey));
    expect(job?.opts.attempts).toBe(5);
    expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 10_000 });
  });
});

/**
 * The API produces and the worker consumes, and the two live in separate
 * workspaces with separate copies of the transport constants — see the header of
 * `apps/api/src/queue/producer.ts` for why they are not shared through a module.
 *
 * This is the check that makes the copy safe. A queue name, a prefix or a retry
 * policy that drifted would not fail loudly anywhere else: capture-complete
 * would go on answering 200 while writing jobs into a queue nothing reads.
 */
describe('the API producer and this worker agree on the wire contract', () => {
  it('uses the same queue, prefix and job options', async () => {
    const producer = await import('../../api/src/queue/producer');
    const worker = await import('../src/queue');

    expect(producer.JOB_QUEUE_NAME).toBe(worker.JOB_QUEUE_NAME);
    expect(producer.JOB_QUEUE_PREFIX).toBe(worker.JOB_QUEUE_PREFIX);
    expect(producer.JOB_ATTEMPTS).toBe(worker.JOB_ATTEMPTS);
    expect(producer.JOB_BACKOFF_MS).toBe(worker.JOB_BACKOFF_MS);
    expect(producer.JOB_ID_SEPARATOR).toBe(worker.JOB_ID_SEPARATOR);

    const jobKey = 'cap_contract:generate-thumbnail';
    expect(producer.jobKeyToJobId(jobKey)).toBe(worker.jobKeyToJobId(jobKey));
    // Covers the retention settings too, which is why this compares the whole
    // options object rather than the constants one by one.
    expect(producer.jobOptionsFor(jobKey)).toEqual(worker.jobOptionsFor(jobKey));
  });
});

describe('jobKey → BullMQ jobId', () => {
  it('replaces the separator BullMQ reserves, injectively', () => {
    expect(jobKeyToJobId('cap_abc:generate-thumbnail')).toBe('cap_abc~generate-thumbnail');
    expect(jobKeyToJobId('roll_abc:export-roll:exp_1')).toBe('roll_abc~export-roll~exp_1');

    // Two different keys must never land on one id, so a key that already
    // carries the replacement character is refused rather than folded.
    expect(() => jobKeyToJobId('cap~abc:generate-thumbnail')).toThrow(/may not contain/);
  });
});

describe('putDerived is the only write path (01 §7)', () => {
  it('writes under derived/ and hands back the key', async () => {
    const captureId = await newCapture();
    const body = randomBytes(64);

    const key = await runtime.ctx.putDerived(rollId, captureId, 'thumb.webp', body, 'image/webp');
    writtenKeys.push(key);
    expect(key).toBe(`rolls/${rollId}/captures/${captureId}/derived/thumb.webp`);

    const stream = await runtime.ctx.getObject(key);
    expect(await collect(stream)).toEqual(body);
  });

  it('refuses a name that would land under original/', async () => {
    const captureId = await newCapture();
    const body = randomBytes(16);

    await expect(
      runtime.ctx.putDerived(rollId, captureId, 'original/cam-01.jpg', body, 'image/jpeg'),
    ).rejects.toThrow(/original/i);
  });

  it('refuses a name that tries to climb out of the capture folder', async () => {
    const captureId = await newCapture();
    const body = randomBytes(16);

    await expect(
      runtime.ctx.putDerived(rollId, captureId, '../original/cam-01.jpg', body, 'image/jpeg'),
    ).rejects.toThrow(/unsafe/i);
  });
});

/**
 * `ctx.s3` is a whole client, handed to handlers so they can read the frames
 * they work on — which left 01 §7 one `PutObjectCommand` away from being broken
 * by a handler author who did not know the rule. These tests are about the
 * client itself: every call below is one a Task 23–25 handler could make.
 */
describe('the shared S3 client refuses to write an original (01 §7)', () => {
  const originalKey = (captureId: string): string =>
    `rolls/${rollId}/captures/${captureId}/original/cam-01.jpg`;

  it('rejects a handler writing an original directly through ctx.s3', async () => {
    const captureId = await newCapture();

    await expect(
      runtime.ctx.s3.send(
        new PutObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: originalKey(captureId),
          Body: randomBytes(16),
          ContentType: 'image/jpeg',
        }),
      ),
    ).rejects.toThrow(/originals are immutable/i);
  });

  it('rejects deleting one, singly or in a batch', async () => {
    const captureId = await newCapture();

    await expect(
      runtime.ctx.s3.send(
        new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: originalKey(captureId) }),
      ),
    ).rejects.toThrow(/originals are immutable/i);

    // The batch form carries its keys somewhere else entirely, which is exactly
    // how a guard that only knew about `Key` would be walked around.
    await expect(
      runtime.ctx.s3.send(
        new DeleteObjectsCommand({
          Bucket: config.S3_BUCKET,
          Delete: { Objects: [{ Key: originalKey(captureId) }] },
        }),
      ),
    ).rejects.toThrow(/originals are immutable/i);
  });

  it('lets the same call through for a derived key', async () => {
    const captureId = await newCapture();
    const key = `rolls/${rollId}/captures/${captureId}/derived/direct.webp`;
    const body = randomBytes(32);

    await runtime.ctx.s3.send(
      new PutObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: 'image/webp',
      }),
    );
    writtenKeys.push(key);

    expect(await collect(await runtime.ctx.getObject(key))).toEqual(body);
  });

  it('still lets a handler read an original', async () => {
    // Reads are untouched by the guard — a renderer that could not open the
    // frames would have nothing to render.
    await expect(runtime.ctx.getObject(originalKey('cap_does_not_exist'))).rejects.toThrow(
      /NoSuchKey|not exist/i,
    );
  });
});

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}
