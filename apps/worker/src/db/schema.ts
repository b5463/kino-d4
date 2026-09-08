import { desc, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * The tables a worker touches: **nine** of them —
 * `processing_events`, `captures`, `assets`, `upload_sessions`, `rolls`,
 * `audit_events`, `reactions`, `export_jobs`, `recap_jobs`.
 *
 * (It said three for a while, which was true of Task 23 and of nothing since.
 * The count is worth stating because it is the first thing a reader wants and
 * the last thing anyone updates.)
 *
 * **`apps/api/src/db/schema.ts` is the source of truth** — it owns the full
 * schema and the migrations that create it. This file is a mirror, for two
 * reasons:
 *
 * 1. The two workspaces cannot share a module without one depending on the
 *    other, and a worker that imports the API's schema would be importing its
 *    Fastify plugins' type surface with it. 05 §11 wants these independent.
 * 2. The risk of mirroring is *checked*: `tests/queue.test.ts`,
 *    `tests/imageJobs.test.ts` and `tests/rollJobs.test.ts` write and read these
 *    rows against the real migrated database, so a column that drifts fails the
 *    suite rather than a deployment.
 *
 * Nothing here is authoritative. If this file and the API's schema disagree,
 * the API's is right and this one is a bug.
 *
 * ## Narrow in one direction only (audit #12)
 *
 * A mirror may leave a **nullable** column out: nothing here reads it, and an
 * insert that omits it still succeeds. It may not leave out a `NOT NULL` column
 * with no default, and it may not drop a default — both turn a compile-time
 * question into a run-time one. `upload_sessions` had lost four NOT NULL
 * columns, and `assets.status` / `captures.status` / `captures.visible` /
 * `captures.created_at` had lost their defaults, so drizzle believed an insert
 * had to supply them (or, worse for the reader, that the database had no
 * opinion).
 *
 * Foreign keys and indexes are declared for the same reason the two unique
 * indexes always were: drizzle's `onConflict` inference reads them, the FK
 * *name* is what `isCaptureGoneViolation` matches on, and an index a reader
 * cannot see here is an index they will assume is missing. Nothing here creates
 * any of it — the API's migrations do. `captures.device_id` is the one FK left
 * undeclared, because `devices` is not mirrored and nothing in this workspace
 * has a reason to mirror it.
 */
export const processingEvents = pgTable(
  'processing_events',
  {
    id: text('id').primaryKey(),
    /**
     * The FK is declared because its *name* is load-bearing:
     * `isCaptureGoneViolation` matches
     * `processing_events_capture_id_captures_id_fk`, which is what drizzle's
     * naming produces from this line, and that check is how the queue tells "the
     * capture was purged under this job" from a real failure.
     */
    captureId: text('capture_id')
      .notNull()
      .references(() => captures.id),
    job: text('job').notNull(), // 'render-wiggle-webp', ...
    /**
     * queued|running|done|failed|superseded|abandoned.
     *
     * The last two are this workspace's: `superseded` is the retired enqueue row
     * and `abandoned` is a job that is over and did not succeed — both written by
     * `jobs/events.ts`, and both absent from the API's own comment on this column
     * because the API never writes them. It does *read* them:
     * `recomputeCaptureStatus` treats `abandoned` as terminal.
     */
    status: text('status').notNull(),
    error: text('error'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * Partial, and the `where` is the point: this is an event *log*, so the
     * only thing that must not duplicate is the enqueue itself. Declared here
     * so drizzle's picture of the table matches the database's; the API's
     * `enqueueProcessingJobs` is what actually relies on it, and
     * `markJobSucceeded` / `markJobAbandoned` are what release it.
     */
    uniqueIndex('processing_events_capture_job_queued')
      .on(t.captureId, t.job)
      .where(sql`${t.status} = 'queued'`),
    /**
     * The read half of the same table, and the one the *sweeper* leans on:
     * `sweepQueuedRows` asks "is there a later row for this (capture, job)" for
     * every stale `queued` row, and `latestJobStatuses` in the API is a
     * `DISTINCT ON (job)` over one capture's rows ordered `job, at desc`. The
     * column order is that ORDER BY, `at` descending included.
     */
    index('processing_events_capture_job_at').on(t.captureId, t.job, desc(t.at)),
  ],
);

/**
 * A capture, as a handler reads it. **Read-only from here**: a worker never
 * inserts or updates a capture row — `captures.status` is recomputed by the API
 * from the asset rows and the processing log (05 §8), and a worker that wrote it
 * directly would be a second, disagreeing author of the same cache.
 */
export const captures = pgTable(
  'captures',
  {
    id: text('id').primaryKey(),
    captureUuid: text('capture_uuid').notNull(),
    rollId: text('roll_id')
      .notNull()
      .references(() => rolls.id),
    /** No `.references()`: `devices` is not mirrored — see the note at the top. */
    deviceId: text('device_id').notNull(),
    mode: text('mode').notNull(),
    look: text('look'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    frameCount: integer('frame_count').notNull(),
    resolution: text('resolution').notNull(),
    timing: jsonb('timing'),
    /** Capture-time provenance (audit #59) — mirrors the API schema. Renders
     * read `meta.calibration` out of it; a worker never writes it. */
    provenance: jsonb('provenance'),
    /** The host's playback choice (fps/loop/direction) — mirrors the API
     * schema. Read by the wiggle renders; never written here. */
    playback: jsonb('playback'),
    status: text('status').notNull().default('created'),
    visible: boolean('visible').notNull().default(true),
    deletedAt: timestamp('deleted_at', { withTimezone: true }), // trash grace (03 §11)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** The 05 §9 idempotency anchor: one capture per device-generated uuid. */
    uniqueIndex('captures_roll_uuid').on(t.rollId, t.captureUuid),
    /** Counts and recap windows. */
    index('captures_roll_created').on(t.rollId, t.createdAt),
    /**
     * Feed pagination, and the one this workspace reads through:
     * `loadRollCaptures` orders every roll-scoped job by
     * `(captured_at, id)` over one roll.
     */
    index('captures_roll_captured').on(t.rollId, t.capturedAt),
  ],
);

/**
 * The asset rows. A handler reads every role and writes only the one it
 * produced — see the `ctx.db` note on `JobCtx`: nothing enforces that, so it is
 * kept true by every write going through `publishDerived`.
 */
export const assets = pgTable(
  'assets',
  {
    id: text('id').primaryKey(),
    captureId: text('capture_id')
      .notNull()
      .references(() => captures.id),
    role: text('role').notNull(),
    frameIndex: integer('frame_index'),
    mime: text('mime').notNull(),
    width: integer('width'),
    height: integer('height'),
    bytes: bigint('bytes', { mode: 'number' }),
    sha256: text('sha256'),
    objectKey: text('object_key').notNull().unique(),
    /** pending|ready. The default is the *upload* path's; `publishDerived`
     * always writes `ready`, because a derivative's bytes are stored before its
     * row exists. */
    status: text('status').notNull().default('pending'),
    /** Producer identity for derived assets (audit #59) — mirrors the API schema. */
    producer: jsonb('producer').$type<Record<string, unknown>>(),
    producedAt: timestamp('produced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * `NULLS NOT DISTINCT` is what makes a rerun an upsert rather than a second
     * row: `frame_index` is NULL for every derived role, and PostgreSQL treats
     * NULLs as distinct by default. Declared here so drizzle's `onConflict`
     * inference targets the index the database actually has — mirrored from the
     * API's schema, which owns it.
     */
    unique('assets_capture_role_frame').on(t.captureId, t.role, t.frameIndex).nullsNotDistinct(),
  ],
);

/**
 * The multipart upload sessions (05 §9). **Read and retired, never opened**: a
 * worker does not upload, and the only column it writes is `status`, when it
 * reaps a session the camera abandoned.
 *
 * What the reaper needs is `status` and `created_at` to find a stale row, and
 * `s3_upload_id` plus `asset_id` to abort what it left behind in storage.
 *
 * The other four columns are here because they are `NOT NULL` with no default
 * (audit #12), which makes them the mirror's business whether it reads them or
 * not: without them drizzle believes an insert of `{id, assetId, status}` is
 * valid, and the only place that belief is corrected is a
 * `null value in column "bytes_expected"` at run time. Leaving out a *nullable*
 * column is fine and this file does it elsewhere; leaving out a required one is
 * a compile-time check thrown away.
 */
export const uploadSessions = pgTable('upload_sessions', {
  id: text('id').primaryKey(),
  assetId: text('asset_id')
    .notNull()
    .references(() => assets.id),
  s3UploadId: text('s3_upload_id'), // S3 multipart upload id
  /** Declared, never read here — see the note above. */
  bytesExpected: bigint('bytes_expected', { mode: 'number' }).notNull(),
  /** Declared, never read here. */
  sha256Expected: text('sha256_expected').notNull(),
  /** Declared, never read here. */
  partsReceived: integer('parts_received').notNull().default(0),
  status: text('status').notNull().default('open'), // open|complete|aborted|failed
  /** `<captureUuid>:<role>:<frameIndex>` (05 §9). Declared, never read here. */
  idempotencyKey: text('idempotency_key').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------- the roll-scoped tables -- */

/**
 * The roll, as the recap reads it. **Read-only from here**: a worker never
 * changes a roll's title, status or privacy — those are the host's, set through
 * the API.
 *
 * Only the two columns the recap's title card needs (03 §21) plus the id, so this
 * mirror stays as small as the thing it is for.
 */
export const rolls = pgTable('rolls', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The audit trail (05 §5). A worker appends and never reads: `purge-trash` is the
 * one job in the platform that destroys media, and 03 §11's "delete is
 * destructive" is only accountable if each destruction leaves a record.
 *
 * `roll_id` is nullable in the API's schema and stays that way here; a purge
 * always has one, because it purges a capture that belonged to a roll.
 */
export const auditEvents = pgTable('audit_events', {
  id: text('id').primaryKey(),
  rollId: text('roll_id').references(() => rolls.id),
  actor: text('actor').notNull(), // 'system' for anything a worker did
  action: text('action').notNull(),
  target: text('target'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Guest hearts (03 §18). Present for exactly one reason: `reactions.capture_id`
 * references `captures.id`, so a purge that did not clear them could not delete
 * the capture row. Never written here.
 */
export const reactions = pgTable(
  'reactions',
  {
    id: text('id').primaryKey(),
    /** The FK that is the whole reason this table is mirrored at all. */
    captureId: text('capture_id')
      .notNull()
      .references(() => captures.id),
    guestId: text('guest_id').notNull(), // ephemeral cookie id (03 §18)
    kind: text('kind').notNull().default('heart'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('reactions_unique').on(t.captureId, t.guestId, t.kind)],
);

/**
 * The export job rows (03 §25). Task 21's API claims them `queued`; this
 * workspace is what moves them off it — `running`, then `done` once the ZIP is
 * durable, or `failed`.
 *
 * Mirrored rather than imported, for the reason at the top of this file, and
 * checked the same way: `tests/rollJobs.test.ts` drives these rows against the
 * real migrated database.
 */
export const exportJobs = pgTable(
  'export_jobs',
  {
    id: text('id').primaryKey(),
    rollId: text('roll_id')
      .notNull()
      .references(() => rolls.id),
    status: text('status').notNull().default('queued'), // queued|running|done|failed
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * One live export per roll. Declared so drizzle's picture matches the
     * database's; the API's `claimExportJob` is what relies on it, and this
     * workspace is what *frees* it by moving a row to `done` or `failed` —
     * including when the job died outside its processor (`failRollJobRow`).
     */
    uniqueIndex('export_jobs_roll_live')
      .on(t.rollId)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

/** The recap job rows (03 §21) — the same contract as `exportJobs`, own table. */
export const recapJobs = pgTable(
  'recap_jobs',
  {
    id: text('id').primaryKey(),
    rollId: text('roll_id')
      .notNull()
      .references(() => rolls.id),
    status: text('status').notNull().default('queued'), // queued|running|done|failed
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('recap_jobs_roll_live')
      .on(t.rollId)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);
