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
});

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

export const processingEvents = pgTable('processing_events', {
  id: text('id').primaryKey(),
  captureId: text('capture_id')
    .notNull()
    .references(() => captures.id),
  job: text('job').notNull(), // 'render-wiggle-webp', ...
  status: text('status').notNull(), // queued|running|done|failed
  error: text('error'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});
