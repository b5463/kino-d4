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

/**
 * Roll states (03§22).
 *
 * Kept whole even though the API writes only three of them: a roll is created
 * `live` and the host may set `live`, `closed` or `archived`
 * (`HOST_ROLL_STATUSES` in `apps/api/src/rolls/rolls.ts`). `draft` and `trash`
 * have no writer today. They stay because 03§22 defines them and because this
 * list is also what a restore has to parse — narrowing it would turn "a state
 * nothing produces yet" into "a document that cannot be read back".
 */
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
  'social-9x16',
  'social-4x5',
  'social-1x1',
  'metadata',
] as const;

/**
 * Asset lifecycle states, as the platform actually writes them.
 *
 * Two values, not four. `pending` is the insert default and what a re-`init`
 * resets an asset to (`apps/api/src/routes/device-captures.ts`); `ready` is
 * written in exactly two places — when `complete` has verified the stored
 * object (`apps/api/src/uploads/sessions.ts`) and when the worker upserts a
 * derived row (`apps/worker/src/jobs/derive.ts`). Nothing writes anything else.
 *
 * The `assets.status` column comment in `apps/api/src/db/schema.ts` still reads
 * `pending|uploading|ready|failed`. Those two extra names have no writer: an
 * upload's own progress and its failures live on `upload_sessions.status`
 * (`open|complete|aborted|failed`), and a refused upload leaves the asset
 * `pending` on purpose, so the device starts again from init. If that column
 * comment ever becomes true, this list is what has to grow with it.
 */
export const ASSET_STATUSES = ['pending', 'ready'] as const;

/**
 * Roll privacy modes (03§9), as written.
 *
 * `privacy` is never accepted from a client: the API derives it from whether a
 * PIN was supplied (`apps/api/src/rolls/rolls.ts`, `routes/host-rolls.ts`), so
 * these two strings are the whole set. `public` is a later addition and is
 * deliberately absent — a name nothing can produce would be a promise, not a
 * schema.
 */
export const ROLL_PRIVACY = ['unlisted', 'pin'] as const;

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

/**
 * `kino.asset` — one derived or original file belonging to a capture (05§19).
 *
 * ## What this document is NOT
 *
 * Nothing parses or serialises it. Every HTTP response the API sends is an
 * ad-hoc shape built in `apps/api/src` (`captures/feed.ts`'s
 * `CaptureAssetSummary` for the wire, `db/schema.ts`'s `assets` table for the
 * row), and the two shapes differ on purpose: the wire carries `assetId`
 * instead of `id`, and never `objectKey`, because an object key is not
 * authorization (05§6). This document is the *portable* record — what an export
 * or a backup writes and what a restore has to be able to read — so the fields
 * are the ones that survive leaving the database, and the enums below are
 * whatever the API can actually put in them.
 *
 * Still not described, and left that way here: `producer` / `producedAt`, the
 * per-row provenance of a derived asset (audit #59). The row always carries
 * them for a worker-made file and never for a device-uploaded original, so
 * typing them would mean either a lie about originals or a second document
 * shape. They travel through `passthrough()` untyped until 05§19 grows a
 * provenance block to type them against.
 */
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
      /**
       * The 1-based CAMERA NUMBER this file depicts, or null/absent for one
       * that is the whole capture's.
       *
       * Not decoration on a derived role any more. `thumb` now holds a
       * capture-level row at NULL **plus one row per camera**
       * (`apps/worker/src/jobs/thumbnail.ts`), and `frameIndex` is the only
       * thing that says which cell a given thumb belongs in. The uniqueness
       * rule that keeps re-rendering idempotent is
       * `(captureId, role, frameIndex)` with NULLS NOT DISTINCT, so the field
       * is part of the identity of an asset, not a hint about it.
       *
       * A camera number, never an array position: a capture that lost camera 2
       * carries 1, 3, 4 with a hole where 2 would be (D23), and a position
       * would renumber every frame the day the missing upload landed late.
       */
      frameIndex: z.number().int().positive().nullable().optional(),
      mime: z.string().min(1),
      /** Absent for non-pixel roles such as `metadata`. */
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      /** Unknown until the upload finalizes (05§8). */
      bytes: z.number().int().nonnegative().optional(),
      sha256: z.string().regex(SHA256).optional(),
      /**
       * `pending` or `ready` — see `ASSET_STATUSES` for why those are the only
       * two, and which stale column comment says otherwise.
       *
       * This was `z.string()`, on the grounds that 05§8 enumerates *capture*
       * states only and describes asset progress in prose, so pinning wire
       * strings would be invention. It was the opposite: the implementation had
       * long since pinned them, and a schema that accepted any non-empty string
       * described nothing.
       */
      status: z.enum(ASSET_STATUSES),
    })
    .passthrough(),
  migrations: {},
});
export type Asset = z.infer<typeof asset.shape>;

/**
 * `kino.roll` — a shared collection of captures (05§19, 03§22).
 *
 * Nothing parses or serialises this one either: the host and guest roll
 * responses are hand-built in `apps/api/src/rolls/rolls.ts`, and they
 * deliberately differ from this shape — a guest is told neither the roll's id
 * nor its privacy, and a host is told `hasPin` rather than `privacy`.
 *
 * Three columns the `rolls` row always carries are absent below, and stay
 * absent: `pinHash` and `hostTokenHash`, because a portable document that
 * carried credential material would be the wrong file to hand anybody, and
 * `accessEpoch`, the guest-link revocation generation — server state that means
 * nothing outside the database that issues the cookies. `reactionsEnabled` is
 * missing for a weaker reason: 05§19 does not list it, so adding it here would
 * change the document rather than describe it. That one is a real gap, not a
 * decision — an export written from this schema loses the host's reactions
 * setting.
 */
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
      /** `unlisted` or `pin` — see `ROLL_PRIVACY`. */
      privacy: z.enum(ROLL_PRIVACY),
      /** No default — download policy is a privacy decision, never inferred. */
      downloadsEnabled: z.boolean(),
    })
    .passthrough(),
  migrations: {},
});
export type Roll = z.infer<typeof roll.shape>;
