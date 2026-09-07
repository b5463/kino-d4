#!/usr/bin/env node

// Per-camera thumbnail backfill for KINO Roll.
//
// `generate-thumbnail` now writes one thumb per camera alongside the
// capture-level tile (apps/worker/src/jobs/thumbnail.ts), which is what takes a
// capture page from 754 kB of original JPEGs down to 293 kB. Captures processed
// before that change have only the capture-level row, so their pages still
// fetch four full originals to fill eight boxes none of which is wider than
// 195 CSS px.
//
// There is nothing to migrate: the fix is to run the existing job again. It is
// idempotent by construction — its only inputs are the stored `original-frame`
// objects, and `publishDerived` upserts on `(captureId, role, frameIndex)` — so
// this script queues work, it does not transform data.
//
// Measured on the bench, 2026-09-06: ~550 ms and ~110 kB of new objects per
// four-camera capture. A 1,900-capture roll is therefore about 17 minutes of
// worker time and about 210 MB of new objects.
//
// Dry run is the default. Nothing is queued without `--apply`.
//
// See docs/runbooks/thumbnail-backfill.md.

import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from '../../apps/api/src/db/schema';
import { assets, captures, rolls } from '../../apps/api/src/db/schema';
import { createProcessingQueue, submitJob } from '../../apps/api/src/queue/producer';
import { enqueueProcessingJobs } from '../../apps/api/src/uploads/uploads';

const JOB = 'generate-thumbnail' as const;

/**
 * Measured per capture on the bench roll, four cameras, 2026-09-06. Used only
 * to turn a capture count into a duration an operator can plan around; the run
 * reports what it actually took.
 */
const MEASURED_MS_PER_CAPTURE = 550;

/**
 * ~110 kB of new objects per four-camera capture, i.e. ~27.5 kB per frame
 * thumb. A fallback only: the estimate prefers the mean size of the per-camera
 * thumbs this deployment has already written, because a 720 px WebP of a party
 * photograph is not the same size everywhere.
 */
const FALLBACK_FRAME_THUMB_BYTES = 27_500;

/** The worker writes per-camera thumbs only where there are at least two frames. */
const MIN_FRAMES = 2;

interface Options {
  databaseUrl: string;
  redisUrl: string;
  queuePrefix: string;
  /** Roll slug or roll id. Empty means every roll. */
  roll: string | null;
  allRolls: boolean;
  apply: boolean;
  batchSize: number;
  pauseMs: number;
  limit: number | null;
  statePath: string | null;
}

/** Where a run stopped, so a later one need not re-scan what it already did. */
interface State {
  roll: string | null;
  cursorCreatedAt: string;
  cursorId: string;
  capturesQueued: number;
  framesQueued: number;
  updatedAt: string;
}

interface Candidate {
  captureId: string;
  rollId: string;
  createdAt: Date;
  /** Stored `original-frame` rows, i.e. how many thumbs this capture is missing. */
  frames: number;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    databaseUrl: process.env['DATABASE_URL'] ?? 'postgres://kino:kino@localhost:5435/kino',
    redisUrl: process.env['REDIS_URL'] ?? 'redis://localhost:6380',
    queuePrefix: process.env['JOB_QUEUE_PREFIX'] ?? 'kino-jobs',
    roll: null,
    allRolls: false,
    apply: false,
    batchSize: 100,
    pauseMs: 1_000,
    limit: null,
    statePath: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${argv[i]} requires a value`);
      i += 1;
      return value;
    };
    const flag = argv[i];
    if (flag === '--roll') options.roll = next();
    else if (flag === '--all-rolls') options.allRolls = true;
    else if (flag === '--apply') options.apply = true;
    else if (flag === '--dry-run') options.apply = false;
    else if (flag === '--batch') options.batchSize = Number(next());
    else if (flag === '--pause') options.pauseMs = Number(next());
    else if (flag === '--limit') options.limit = Number(next());
    else if (flag === '--state') options.statePath = resolve(next());
    else if (flag === '--database-url') options.databaseUrl = next();
    else if (flag === '--redis-url') options.redisUrl = next();
    else if (flag === '--queue-prefix') options.queuePrefix = next();
    else throw new Error(`unknown option: ${flag}`);
  }

  // Naming the target is not a formality: "all rolls" on a production database
  // is a decision, so it has to be typed out rather than reached by omission.
  if (options.roll === null && !options.allRolls) {
    throw new Error('name a roll with --roll <slug|id>, or say --all-rolls');
  }
  if (options.roll !== null && options.allRolls) {
    throw new Error('--roll and --all-rolls are mutually exclusive');
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
    throw new Error('--batch must be a positive integer');
  }
  if (!Number.isFinite(options.pauseMs) || options.pauseMs < 0) {
    throw new Error('--pause must be a non-negative number of milliseconds');
  }
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  return options;
}

function printUsage(): void {
  console.log(`Usage: npx tsx infra/scripts/backfill-thumbnails.ts --roll <slug|id> [options]

Re-queues the idempotent \`generate-thumbnail\` job for captures that have no
per-camera thumbnails, so old captures stop sending four full originals to fill
a capture page. Dry run unless --apply is given.

  --roll SLUG|ID    one roll, by public slug or roll id
  --all-rolls       every roll in the database (say it deliberately)
  --apply           actually queue; without it nothing is written
  --dry-run         the default; report what --apply would queue
  --batch N         captures per batch (default 100)
  --pause MS        wait between batches, to keep the live queue short (default 1000)
  --limit N         stop after N captures this run
  --state FILE      write/read progress, to resume a long run without re-scanning
  --database-url U  default: DATABASE_URL, else the dev database
  --redis-url U     default: REDIS_URL, else the dev Redis
  --queue-prefix P  default: JOB_QUEUE_PREFIX, else kino-jobs

Safe to run twice. A capture that already has per-camera thumbs drops out of the
selection, and a capture whose job is still queued is left alone by the
\`processing_events\` unique index. Re-running is the simplest resume; --state
only saves the re-scan.

Queueing a job moves a settled capture back to \`processing\` until the worker
writes \`done\`, so the host dashboard's Pending count rises during the run.
That is honest — the platform does owe those captures a derivative — but do not
start a large backfill during a live party.`);
}

/** The roll this run is about, or null for every roll. */
async function resolveRoll(
  db: ReturnType<typeof drizzle<typeof schema>>,
  roll: string | null,
): Promise<{ id: string; slug: string; title: string } | null> {
  if (roll === null) return null;
  const [row] = await db
    .select({ id: rolls.id, slug: rolls.slug, title: rolls.title })
    .from(rolls)
    .where(or(eq(rolls.slug, roll), eq(rolls.id, roll)))
    .limit(1);
  if (row === undefined) throw new Error(`no roll with slug or id ${roll}`);
  return row;
}

/**
 * The captures that are missing per-camera thumbs, oldest first.
 *
 * Two conditions, and both are the worker's own rules rather than a guess about
 * them:
 *
 * - at least `MIN_FRAMES` stored `original-frame` rows, because `originalFrames`
 *   filters to `status = 'ready'` with a frame index, and the handler skips the
 *   per-camera pass below two frames (one stored frame *is* the capture-level
 *   thumb, so a per-camera copy would be the same bytes under a second name);
 * - no `thumb` row with a frame index, which is exactly what the job writes.
 *   This is what makes the selection its own resume: a capture the worker has
 *   finished cannot come back.
 *
 * Keyset pagination on `(created_at, id)` — the order
 * `captures_roll_created` already indexes — rather than OFFSET, because rows
 * leave the result set while the run is in progress and an offset would then
 * skip the ones that shifted under it.
 */
async function nextCandidates(
  db: ReturnType<typeof drizzle<typeof schema>>,
  rollId: string | null,
  after: { createdAt: Date; id: string } | null,
  limit: number,
): Promise<Candidate[]> {
  const frames = sql`(
    select count(*) from ${assets}
    where ${assets.captureId} = ${captures.id}
      and ${assets.role} = 'original-frame'
      and ${assets.status} = 'ready'
      and ${assets.frameIndex} is not null
  )`;
  const hasFrameThumb = sql`exists (
    select 1 from ${assets}
    where ${assets.captureId} = ${captures.id}
      and ${assets.role} = 'thumb'
      and ${assets.frameIndex} is not null
  )`;

  const rows = await db
    .select({
      captureId: captures.id,
      rollId: captures.rollId,
      createdAt: captures.createdAt,
    })
    .from(captures)
    .where(
      and(
        isNull(captures.deletedAt),
        rollId === null ? sql`true` : eq(captures.rollId, rollId),
        after === null
          ? sql`true`
          : or(
              gt(captures.createdAt, after.createdAt),
              and(eq(captures.createdAt, after.createdAt), gt(captures.id, after.id)),
            ),
        sql`${frames} >= ${MIN_FRAMES}`,
        sql`not ${hasFrameThumb}`,
      ),
    )
    .orderBy(asc(captures.createdAt), asc(captures.id))
    .limit(limit);
  if (rows.length === 0) return [];

  // Counted in a second, grouped query rather than as a third correlated
  // subquery in the SELECT list: the same predicate that filters is not the
  // same thing as a number to report, and one GROUP BY over this batch's ids is
  // both cheaper and readable.
  const counted = await db
    .select({ captureId: assets.captureId, frames: sql<string>`count(*)` })
    .from(assets)
    .where(
      and(
        inArray(
          assets.captureId,
          rows.map((row) => row.captureId),
        ),
        eq(assets.role, 'original-frame'),
        eq(assets.status, 'ready'),
        sql`${assets.frameIndex} is not null`,
      ),
    )
    .groupBy(assets.captureId);
  const framesByCapture = new Map(counted.map((row) => [row.captureId, Number(row.frames)]));

  return rows.map((row) => ({ ...row, frames: framesByCapture.get(row.captureId) ?? 0 }));
}

/**
 * Bytes per frame thumb, measured from this deployment where it can be.
 *
 * A constant from the bench is a fine sanity check and a poor forecast: the size
 * of a 720 px WebP depends on the pictures. Once any capture has been
 * backfilled, the mean of those rows is the honest number, and the report says
 * which of the two it used.
 */
async function frameThumbBytes(
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<{ bytes: number; source: 'measured' | 'bench-constant'; samples: number }> {
  const [row] = await db
    .select({
      mean: sql<string | null>`avg(${assets.bytes})`,
      samples: sql<string>`count(*)`,
    })
    .from(assets)
    .where(
      and(
        eq(assets.role, 'thumb'),
        eq(assets.status, 'ready'),
        sql`${assets.frameIndex} is not null`,
        sql`${assets.bytes} is not null`,
      ),
    );

  const samples = Number(row?.samples ?? 0);
  const mean = row?.mean === null || row?.mean === undefined ? null : Number(row.mean);
  if (mean === null || !Number.isFinite(mean) || samples === 0) {
    return { bytes: FALLBACK_FRAME_THUMB_BYTES, source: 'bench-constant', samples: 0 };
  }
  return { bytes: Math.round(mean), source: 'measured', samples };
}

async function readState(path: string | null): Promise<State | null> {
  if (path === null) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as State;
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  const client = postgres(options.databaseUrl, { max: 4, connect_timeout: 5, onnotice: () => {} });
  const db = drizzle(client, { schema });
  const queue = options.apply
    ? createProcessingQueue({ REDIS_URL: options.redisUrl, JOB_QUEUE_PREFIX: options.queuePrefix })
    : null;

  // Finish the batch in hand, then stop: a half-written batch is not a problem
  // (every layer is idempotent), but an operator who pressed Ctrl-C deserves a
  // summary and a resumable cursor rather than a stack trace.
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    console.error('stopping after this batch');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    const roll = await resolveRoll(db, options.roll);
    const resumed = await readState(options.statePath);
    const perFrame = await frameThumbBytes(db);

    let cursor: { createdAt: Date; id: string } | null =
      resumed === null || resumed.roll !== options.roll
        ? null
        : { createdAt: new Date(resumed.cursorCreatedAt), id: resumed.cursorId };
    if (resumed !== null && cursor === null && options.statePath !== null) {
      console.error(`state file is for roll ${String(resumed.roll)}; scanning from the start`);
    }

    let scanned = 0;
    let framesTotal = 0;
    let queued = 0;
    let framesQueued = 0;
    let alreadyQueued = 0;

    for (;;) {
      const room =
        options.limit === null ? options.batchSize : Math.min(options.batchSize, options.limit - scanned);
      if (room <= 0) break;

      const batch: Candidate[] = await nextCandidates(db, roll?.id ?? null, cursor, room);
      if (batch.length === 0) break;

      for (const candidate of batch) {
        scanned += 1;
        framesTotal += candidate.frames;
        if (queue !== null) {
          // The `queued` row is the dedupe, and it is the API's own function
          // that writes it: the partial unique index over `status = 'queued'`
          // is what makes a second run — or a run that races the API — a no-op
          // rather than double work. An empty answer means a live enqueue is
          // already in the log, so there is nothing for this run to submit.
          const jobs = await enqueueProcessingJobs(db, candidate.captureId, [JOB]);
          if (jobs.length === 0) {
            alreadyQueued += 1;
            continue;
          }
          for (const job of jobs) await submitJob(queue, job.name, job.payload);
          queued += 1;
          framesQueued += candidate.frames;
        }
      }

      const last = batch[batch.length - 1];
      if (last === undefined) break;
      cursor = { createdAt: last.createdAt, id: last.captureId };

      if (options.statePath !== null && queue !== null) {
        const state: State = {
          roll: options.roll,
          cursorCreatedAt: cursor.createdAt.toISOString(),
          cursorId: cursor.id,
          capturesQueued: (resumed?.capturesQueued ?? 0) + queued,
          framesQueued: (resumed?.framesQueued ?? 0) + framesQueued,
          updatedAt: new Date().toISOString(),
        };
        await writeFile(options.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      }

      if (stopping) break;
      if (batch.length < room) break;
      if (options.pauseMs > 0 && queue !== null) await sleep(options.pauseMs);
    }

    const estimateBytes = framesTotal * perFrame.bytes;
    console.log(
      JSON.stringify(
        {
          mode: options.apply ? 'apply' : 'dry-run',
          roll: roll === null ? 'all-rolls' : { id: roll.id, slug: roll.slug, title: roll.title },
          capturesMissingFrameThumbs: scanned,
          frameThumbsToWrite: framesTotal,
          estimate: {
            newObjects: framesTotal,
            newBytes: estimateBytes,
            newMegabytes: Math.round((estimateBytes / 1_000_000) * 10) / 10,
            bytesPerFrameThumb: perFrame.bytes,
            bytesBasis: perFrame.source,
            bytesSamples: perFrame.samples,
            workerMinutes: Math.round((scanned * MEASURED_MS_PER_CAPTURE) / 6_000) / 10,
          },
          queued: options.apply ? { captures: queued, frameThumbs: framesQueued, alreadyQueued } : null,
          stoppedEarly: stopping,
          // Only meaningful for a run that queued something. A dry run scanned
          // the same rows and changed nothing, so there is nothing to resume.
          resumeCursor:
            !options.apply || cursor === null
              ? null
              : { createdAt: cursor.createdAt.toISOString(), id: cursor.id },
          elapsedMs: Date.now() - startedAt,
        },
        null,
        2,
      ),
    );
    if (stopping) process.exitCode = 1;
  } finally {
    if (queue !== null) await queue.close();
    await client.end({ timeout: 5 });
  }
}

const invoked = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`thumbnail backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
