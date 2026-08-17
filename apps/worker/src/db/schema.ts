import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * The one table a worker writes.
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
