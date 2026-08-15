import { z } from 'zod';
import { defineSchema } from './registry';

/** Initial capture types (03§12). `video`/`burst`/`panorama` land in a later version. */
export const CAPTURE_MODES = ['wiggle', 'quad', 'single'] as const;

/** Capture lifecycle states (05§8). */
export const CAPTURE_STATUSES = [
  'created',
  'preview-ready',
  'originals-uploading',
  'complete',
  'processing',
  'ready',
  'partial',
  'failed',
] as const;

/** Roll states (03§22). */
export const ROLL_STATUSES = ['draft', 'live', 'closed', 'archived', 'trash'] as const;

/** Asset roles (05§19). */
export const ASSET_ROLES = [
  'thumb',
  'kino-still',
  'original-frame',
  'wiggle-preview',
  'wiggle-webp',
  'wiggle-mp4',
  'gif',
  'contact-sheet',
  'enhanced-still',
  'enhanced-wiggle',
  'metadata',
] as const;

/** "WIDTHxHEIGHT" in pixels, e.g. "1600x1200" (01§2). */
const RESOLUTION = /^\d+x\d+$/;

/** Lowercase hex SHA-256 digest. */
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Timing telemetry (04§13). The three skews are distinct measurements and must
 * never be conflated: a tight GPIO trigger does not prove tight exposure on a
 * free-running rolling shutter (04§14).
 *
 * All three keys are REQUIRED whenever a `timing` block is present. The locked
 * platform rule is "missing timing data is `null` with a reason" — omitting a
 * key is not an allowed substitute for `null`, because an absent field reads as
 * "this build has no such concept" while `null` reads as "measured, unavailable
 * here". Only the whole block is optional (a device that reported no telemetry
 * at all). `unavailableReason` stays optional and explains the nulls.
 */
const timing = z
  .object({
    gpioTriggerSkewUs: z.number().nullable(),
    vsyncPhaseSkewUs: z.number().nullable(),
    effectiveExposureSkewUs: z.number().nullable(),
    unavailableReason: z.string().optional(),
  })
  .passthrough();

/** `kino.capture` — one shutter press and its frames (05§19). */
export const capture = defineSchema({
  schema: 'kino.capture',
  version: 1,
  shape: z
    .object({
      schema: z.literal('kino.capture'),
      version: z.literal(1),
      id: z.string().min(1),
      captureUuid: z.string().uuid(),
      /** Null/absent until the capture is filed into a roll. */
      rollId: z.string().nullable().optional(),
      deviceId: z.string().min(1),
      mode: z.enum(CAPTURE_MODES),
      look: z.string().optional(),
      /** ISO 8601 with offset, e.g. "2026-08-14T23:42:18+02:00". */
      capturedAt: z.string().min(1),
      /** Whatever the device produced — 03§12 forbids a hard-coded 4-frame model. */
      frameCount: z.number().int().positive(),
      resolution: z.string().regex(RESOLUTION),
      /** Absent when the device reported no telemetry at all (04§13). */
      timing: timing.optional(),
      status: z.enum(CAPTURE_STATUSES),
      visible: z.boolean().default(true),
    })
    .passthrough(),
  migrations: {},
});
export type Capture = z.infer<typeof capture.shape>;

/** `kino.asset` — one derived or original file belonging to a capture (05§19). */
export const asset = defineSchema({
  schema: 'kino.asset',
  version: 1,
  shape: z
    .object({
      schema: z.literal('kino.asset'),
      version: z.literal(1),
      id: z.string().min(1),
      captureId: z.string().min(1),
      role: z.enum(ASSET_ROLES),
      mime: z.string().min(1),
      /** Absent for non-pixel roles such as `metadata`. */
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      /** Unknown until the upload finalizes (05§8). */
      bytes: z.number().int().nonnegative().optional(),
      sha256: z.string().regex(SHA256).optional(),
      /**
       * Not an enum: 05§8 enumerates *capture* states only and describes asset
       * progress in prose ("mark asset complete"), so pinning wire strings here
       * would be invention.
       */
      status: z.string().min(1),
    })
    .passthrough(),
  migrations: {},
});
export type Asset = z.infer<typeof asset.shape>;

/** `kino.roll` — a shared collection of captures (05§19, 03§22). */
export const roll = defineSchema({
  schema: 'kino.roll',
  version: 1,
  shape: z
    .object({
      schema: z.literal('kino.roll'),
      version: z.literal(1),
      id: z.string().min(1),
      /** Random unguessable public slug (05§14). */
      slug: z.string().min(1),
      title: z.string(),
      status: z.enum(ROLL_STATUSES),
      /**
       * Not an enum: 03§9 names the modes in prose (unlisted / PIN protected /
       * public) without fixing wire strings, and public rolls are explicitly a
       * later addition.
       */
      privacy: z.string().min(1),
      /** No default — download policy is a privacy decision, never inferred. */
      downloadsEnabled: z.boolean(),
    })
    .passthrough(),
  migrations: {},
});
export type Roll = z.infer<typeof roll.shape>;
