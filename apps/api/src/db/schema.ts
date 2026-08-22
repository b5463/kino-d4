import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  unique,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import type { Capture, FirmwareManifest } from '@kino/schemas';

/**
 * PostgreSQL holds metadata only — devices, rolls, captures, asset *records*,
 * upload bookkeeping, reactions, firmware releases and audit trail (05§5).
 * Every byte of media lives in object storage; `assets.objectKey` is the only
 * link, and an object key is never authorization (05§6).
 *
 * The jsonb columns carry `kino.*` document shapes from `@kino/schemas`, so the
 * rows mirror the documents the API serves (05§19) instead of re-deriving them.
 *
 * Guest identity is a cookie id (03§18) and host auth is a per-roll token hash
 * (05§12, "secure account/session **or equivalent host token**"). There is
 * deliberately no accounts table: nothing in V1 spans more than one roll.
 */

/**
 * `captures.playback` — the host's per-capture playback settings. Loop and
 * direction use the KDP vocabulary (`WiggleLoop`/`WiggleDirection`), the same
 * words the camera's own wiggle config speaks; the worker maps loop into
 * `@kino/media`'s vocabulary at render time.
 */
export interface CapturePlayback {
  fps?: number;
  loop?: 'bounce' | 'continuous' | 'sweep';
  direction?: 'ltr' | 'rtl';
}

export const devices = pgTable('devices', {
  id: text('id').primaryKey(), // 'dev_' + nanoid
  serial: text('serial').notNull().unique(), // 'KD4-00001'
  product: text('product').notNull(), // 'KINO D4'
  hardwareRevision: text('hardware_revision').notNull(),
  name: text('name'),
  tokenHash: text('token_hash').notNull(), // sha256 hex of device token
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rolls = pgTable('rolls', {
  id: text('id').primaryKey(), // 'roll_' + nanoid
  slug: text('slug').notNull().unique(), // '7F3K9Q' — public, unguessable
  title: text('title').notNull(),
  status: text('status').notNull().default('live'), // draft|live|closed|archived|trash (03§22)
  privacy: text('privacy').notNull().default('unlisted'), // unlisted|pin (public deferred, 03§9)
  pinHash: text('pin_hash'),
  downloadsEnabled: boolean('downloads_enabled').notNull().default(true),
  reactionsEnabled: boolean('reactions_enabled').notNull().default(true),
  hostTokenHash: text('host_token_hash').notNull(),
  createdByDeviceId: text('created_by_device_id').references(() => devices.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (table) => [uniqueIndex('rolls_host_token_hash_unique').on(table.hostTokenHash)]);

/**
 * Which devices may operate which rolls (03 §17, 07 §25).
 *
 * A device reaches a roll it *created* through `rolls.created_by_device_id`;
 * this table is the other half — rolls it *joined*. Without it a device token
 * would be a key to every roll in the database, which is exactly what 07 §25
 * rules out ("Device token must not ... enumerate unrelated Rolls").
 *
 * The composite primary key makes joining twice a no-op rather than a duplicate.
 */
export const rollDevices = pgTable(
  'roll_devices',
  {
    rollId: text('roll_id')
      .notNull()
      .references(() => rolls.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.rollId, t.deviceId] })],
);

export const captures = pgTable(
  'captures',
  {
    id: text('id').primaryKey(), // 'cap_' + nanoid
    captureUuid: text('capture_uuid').notNull(), // device-generated (05§9)
    rollId: text('roll_id')
      .notNull()
      .references(() => rolls.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id),
    mode: text('mode').notNull(), // wiggle|quad|single — extensible (03§12)
    look: text('look'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    frameCount: integer('frame_count').notNull(),
    resolution: text('resolution').notNull(),
    // The three skews are distinct measurements and are never conflated (04§14);
    // an unmeasured one is `null` plus `unavailableReason`, never a missing key.
    timing: jsonb('timing').$type<NonNullable<Capture['timing']>>(),
    /**
     * Capture-time provenance (audit #59): the device's serial/hardware as
     * they were at the shutter press, plus every field the firmware sent
     * beyond the typed kino.capture surface (exposure, flash, firmware
     * versions, calibration version — the contract's `meta`). The schema is
     * passthrough by design; this is where the passthrough remainder lands
     * instead of being silently dropped.
     */
    provenance: jsonb('provenance').$type<Record<string, unknown>>(),
    /**
     * The host's playback choice for this capture (audit #59): fps 5–15,
     * loop/direction in the KDP vocabulary. Deliberately NOT inside
     * provenance — provenance records what the device reported at the
     * shutter press and never changes; this is a host preference that can
     * be edited afterwards. Null means "the renderer's defaults".
     */
    playback: jsonb('playback').$type<CapturePlayback>(),
    status: text('status').notNull().default('created'),
    visible: boolean('visible').notNull().default(true),
    deletedAt: timestamp('deleted_at', { withTimezone: true }), // trash grace (03§11)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('captures_roll_uuid').on(t.rollId, t.captureUuid), // idempotency anchor
    index('captures_roll_created').on(t.rollId, t.createdAt), // feed pagination
  ],
);

export const assets = pgTable(
  'assets',
  {
    id: text('id').primaryKey(), // 'asset_' + nanoid
    captureId: text('capture_id')
      .notNull()
      .references(() => captures.id),
    role: text('role').notNull(), // ASSET_ROLES from @kino/schemas
    frameIndex: integer('frame_index'), // for original-frame
    mime: text('mime').notNull(),
    width: integer('width'),
    height: integer('height'),
    bytes: bigint('bytes', { mode: 'number' }),
    sha256: text('sha256'),
    objectKey: text('object_key').notNull().unique(), // rolls/<rollId>/captures/<capId>/... (05§6)
    status: text('status').notNull().default('pending'), // pending|uploading|ready|failed
    /**
     * Producer identity for derived assets (audit #59): which job, which
     * renderer, which settings. Retuning a render constant is invisible in
     * the bytes; this is where it becomes visible in the data. Null on
     * device-uploaded originals — the capture row's provenance covers those.
     */
    producer: jsonb('producer').$type<Record<string, unknown>>(),
    producedAt: timestamp('produced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * NULLS NOT DISTINCT is the whole point, not a detail. PostgreSQL treats
     * NULLs as distinct in a unique index by default, and `frame_index` is NULL
     * for every derived role (thumb, wiggle-webp, metadata, ...) — i.e. for most
     * assets. Without this, re-running a render would happily insert a second
     * `thumb` row for the same capture and the 05§9 idempotency contract would
     * cover only `original-frame`.
     *
     * It has to be a table CONSTRAINT rather than `uniqueIndex(...)`: drizzle
     * exposes `nullsNotDistinct()` only on `unique()`. PostgreSQL still backs
     * the constraint with an index of this name, so `ON CONFLICT` inference and
     * the error's `constraint_name` are unchanged.
     */
    unique('assets_capture_role_frame')
      .on(t.captureId, t.role, t.frameIndex)
      .nullsNotDistinct(),
  ],
);

export const uploadSessions = pgTable('upload_sessions', {
  id: text('id').primaryKey(), // 'up_' + nanoid
  assetId: text('asset_id')
    .notNull()
    .references(() => assets.id),
  s3UploadId: text('s3_upload_id'), // S3 multipart upload id
  bytesExpected: bigint('bytes_expected', { mode: 'number' }).notNull(),
  sha256Expected: text('sha256_expected').notNull(),
  partsReceived: integer('parts_received').notNull().default(0),
  status: text('status').notNull().default('open'), // open|complete|aborted|failed
  idempotencyKey: text('idempotency_key').notNull().unique(), // <captureUuid>:<role>:<frameIndex> (05§9)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const uploadParts = pgTable(
  'upload_parts',
  {
    uploadId: text('upload_id')
      .notNull()
      .references(() => uploadSessions.id),
    partNo: integer('part_no').notNull(),
    bytes: integer('bytes').notNull(),
    etag: text('etag').notNull(),
  },
  (t) => [uniqueIndex('upload_parts_pk').on(t.uploadId, t.partNo)],
);

export const reactions = pgTable(
  'reactions',
  {
    id: text('id').primaryKey(),
    captureId: text('capture_id')
      .notNull()
      .references(() => captures.id),
    guestId: text('guest_id').notNull(), // ephemeral cookie id (03§18)
    kind: text('kind').notNull().default('heart'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('reactions_unique').on(t.captureId, t.guestId, t.kind)],
);

export const firmwareReleases = pgTable(
  'firmware_releases',
  {
    id: text('id').primaryKey(),
    release: text('release').notNull(),
    channel: text('channel').notNull().default('stable'), // stable|beta|dev (05§15)
    compatibleHardware: jsonb('compatible_hardware')
      .$type<FirmwareManifest['compatibleHardware']>()
      .notNull(), // string[]
    protocolMin: integer('protocol_min').notNull(),
    protocolMax: integer('protocol_max').notNull(),
    manifest: jsonb('manifest').$type<FirmwareManifest>().notNull(), // kino.firmware-manifest document
    notes: text('notes'),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('firmware_release_channel').on(t.release, t.channel)],
);

export const auditEvents = pgTable('audit_events', {
  id: text('id').primaryKey(),
  rollId: text('roll_id').references(() => rolls.id),
  actor: text('actor').notNull(), // 'host' | 'device:<id>' | 'system'
  action: text('action').notNull(), // 'capture.hidden', 'roll.closed', ...
  target: text('target'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

export const processingEvents = pgTable(
  'processing_events',
  {
    id: text('id').primaryKey(),
    captureId: text('capture_id')
      .notNull()
      .references(() => captures.id),
    job: text('job').notNull(), // 'render-wiggle-webp', ...
    status: text('status').notNull(), // queued|running|done|failed
    error: text('error'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * A **partial** unique index, and the `where` is the whole point.
     *
     * This table is an event *log*: Task 22 records a job's progress as
     * `queued` → `running` → `done`/`failed`, so a plain unique on
     * `(capture_id, job)` would make the second row of any job's own lifecycle
     * impossible. Restricting it to `status = 'queued'` keeps the log open while
     * making the one thing that must not duplicate — the enqueue itself —
     * impossible to duplicate.
     *
     * It is what lets `enqueueProcessingJobs` insert and let the index decide
     * rather than SELECT-then-insert, which two concurrent capture-completes
     * would both walk straight through.
     */
    uniqueIndex('processing_events_capture_job_queued')
      .on(t.captureId, t.job)
      .where(sql`${t.status} = 'queued'`),
  ],
);

/**
 * Roll-scoped export jobs (03 §25) — the state behind `{status, url?}`.
 *
 * ## Why this is not `processing_events`
 *
 * `processing_events.capture_id` is NOT NULL and its dedupe index is keyed on
 * `(capture_id, job)`. A roll export belongs to no capture, so it cannot have a
 * row there without either loosening that column — which would make every
 * capture-scoped consumer of the table handle a null it can never encounter —
 * or inventing a placeholder capture, which is worse. The two tables answer
 * different questions and the keys say so: one is "how is this capture's
 * pipeline doing", this one is "where is the host's ZIP".
 *
 * The row **is** the jobId the host polls. There is no separate handle: the
 * primary key names the row, names the BullMQ job (through
 * `exportJobKey`), and names the object (`exports/<id>.zip`), so a host holding
 * one id can be answered without a lookup table between the three.
 */
export const exportJobs = pgTable(
  'export_jobs',
  {
    id: text('id').primaryKey(), // 'exp_' + nanoid — the jobId the host polls
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
     * One live export per roll, enforced by the database rather than by the
     * route.
     *
     * A roll export is the heaviest job in the platform — every original frame
     * of every capture, zipped — and the host UI's natural failure mode is a
     * button pressed three times because nothing visibly happened. Without this
     * index that is three full exports. With it, the second press is refused by
     * the index and the route hands back the id of the export already running.
     *
     * Partial, on `queued` **and** `running`: a job that has started is still in
     * flight, and finishing one must leave the roll free to export again — a
     * host who adds photos after closing the roll needs a second ZIP.
     */
    uniqueIndex('export_jobs_roll_live')
      .on(t.rollId)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

/**
 * Roll-scoped recap renders (03 §21) — the state behind a host's "make me a
 * recap", and the row whose id names the MP4.
 *
 * ## Why this is not `export_jobs`
 *
 * The two look alike — a roll id, a status, one live job per roll — and reusing
 * `export_jobs` with a `kind` column was the first thing tried. It cannot be made
 * honest:
 *
 * 1. **`export_jobs_roll_live` is keyed on `roll_id` alone.** A recap sharing that
 *    table would mean a host who is exporting cannot also be rendering a recap,
 *    and the second request would be refused by an index whose stated rule is
 *    "one live *export* per roll". They are unrelated units of work over the same
 *    roll; nothing about either says the other must wait.
 * 2. **`readExportJob(rollId, jobId)` would find a recap row.** `GET
 *    /api/host/rolls/:rollId/export/:jobId` then presigns `exports/<jobId>.zip` —
 *    a key a recap never writes — so a recap id polled against the export route
 *    would answer `{status:'done'}` with no url, forever, with nothing to explain
 *    why. Filtering by kind inside that reader would fix the symptom by adding a
 *    discriminator every existing caller has to remember.
 *
 * A separate table needs neither: a recap id is not an export id, so the export
 * route cannot see one, and the live-job rule is per kind because the tables are.
 *
 * The row **is** the jobId, exactly as `export_jobs`' is: the primary key names
 * the row, the BullMQ job, and the object (`recap/<id>.mp4`).
 */
export const recapJobs = pgTable(
  'recap_jobs',
  {
    id: text('id').primaryKey(), // 'rcp_' + nanoid — names the row, the job and the MP4
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
     * One live recap per roll, for the same reason `export_jobs` has one: the
     * render is minutes of ffmpeg over every capture in the roll, and a host
     * pressing the button three times must not spend three of them.
     */
    uniqueIndex('recap_jobs_roll_live')
      .on(t.rollId)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);
