import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * The tables a worker touches.
 *
 * **`apps/api/src/db/schema.ts` is the source of truth** — it owns the full
 * schema and the migrations that create it. This file is a deliberately narrow
 * mirror of the single table this workspace touches, for two reasons:
 *
 * 1. The two workspaces cannot share a module without one depending on the
 *    other, and a worker that imports the API's schema would be importing its
 *    Fastify plugins' type surface with it. 05 §11 wants these independent.
 * 2. Mirroring one 6-column table is a smaller risk than the alternative, and
 *    the risk is *checked*: `tests/queue.test.ts` writes and reads these rows
 *    against the real migrated database, so a column that drifts fails the
 *    suite rather than a deployment.
 *
 * Nothing here is authoritative. If this file and the API's schema disagree,
 * the API's is right and this one is a bug.
 *
 * Task 23 widened this from one table to three. `captures` and `assets` are
 * *read* by every image handler — the source-frame rule is a question about the
 * capture's `frame_count` and its `original-frame` rows — and `assets` is
 * written, because a derivative nobody has a row for is a file the platform
 * cannot find. The same reasoning and the same check apply: `tests/imageJobs.
 * test.ts` reads and writes these columns against the real migrated database,
 * so drift fails the suite.
 */
export const processingEvents = pgTable(
  'processing_events',
  {
    id: text('id').primaryKey(),
    captureId: text('capture_id').notNull(),
    job: text('job').notNull(), // 'render-wiggle-webp', ...
    status: text('status').notNull(), // queued|running|done|failed
    error: text('error'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * Partial, and the `where` is the point: this is an event *log*, so the
     * only thing that must not duplicate is the enqueue itself. Declared here
     * so drizzle's picture of the table matches the database's; the API's
     * `enqueueProcessingJobs` is what actually relies on it.
     */
    uniqueIndex('processing_events_capture_job_queued')
      .on(t.captureId, t.job)
      .where(sql`${t.status} = 'queued'`),
  ],
);

/**
 * A capture, as a handler reads it. **Read-only from here**: a worker never
 * inserts or updates a capture row — `captures.status` is recomputed by the API
 * from the asset rows and the processing log (05 §8), and a worker that wrote it
 * directly would be a second, disagreeing author of the same cache.
 */
export const captures = pgTable('captures', {
  id: text('id').primaryKey(),
  captureUuid: text('capture_uuid').notNull(),
  rollId: text('roll_id').notNull(),
  deviceId: text('device_id').notNull(),
  mode: text('mode').notNull(),
  look: text('look'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  frameCount: integer('frame_count').notNull(),
  resolution: text('resolution').notNull(),
  timing: jsonb('timing'),
  status: text('status').notNull(),
  visible: boolean('visible').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

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
    status: text('status').notNull(),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
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
  rollId: text('roll_id'),
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
export const reactions = pgTable('reactions', {
  id: text('id').primaryKey(),
  captureId: text('capture_id').notNull(),
  guestId: text('guest_id').notNull(),
  kind: text('kind').notNull(),
});

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
    rollId: text('roll_id').notNull(),
    status: text('status').notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * One live export per roll. Declared so drizzle's picture matches the
     * database's; the API's `claimExportJob` is what relies on it, and this
     * workspace is what *frees* it by moving a row to `done` or `failed`.
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
    rollId: text('roll_id').notNull(),
    status: text('status').notNull(),
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
