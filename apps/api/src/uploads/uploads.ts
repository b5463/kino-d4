import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { CAPTURE_STATUSES } from '@kino/schemas';
import type { KinoDatabase } from '../plugins/db';
import { newId } from '../ids';
import { captures, processingEvents } from '../db/schema';
import { derivedKey, originalKey } from './objectKeys';

/**
 * The upload pipeline's rules, kept out of the route file so that each one has
 * a single definition and the pure ones can be tested without a socket.
 */

/* -------------------------------------------------------------- part size -- */

/**
 * 5 MiB — S3's minimum part size for every part except the last, and therefore
 * the only value that keeps a *multi*-part upload legal. It is handed to the
 * device in the init response so the number lives in one place.
 *
 * D4 assets are ≤ ~2 MB, so in practice every session is a single part that is
 * far under this. See the multipart note on `POST .../complete`.
 */
export const PART_SIZE = 5 * 1024 * 1024;

/** S3's ceiling. A device that gets here is not uploading a D4 asset. */
export const MAX_PART_NUMBER = 10_000;

/* --------------------------------------------------------- capture status -- */

export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

/** The two columns of an asset row this state machine reads, and no others. */
export interface AssetState {
  role: string;
  status: string;
}

/** The role that holds an untouched camera frame. */
export const ORIGINAL_ROLE = 'original-frame';

/**
 * The roles whose arrival makes a capture worth showing (03 §4's upload
 * priority: thumbnail, then a lightweight wiggle preview). A capture with one of
 * these is renderable in the guest feed long before its originals land, which is
 * the entire point of `preview-ready` as a distinct state.
 */
const PREVIEW_ROLES: ReadonlySet<string> = new Set(['thumb', 'wiggle-preview']);

/** Neither `ready` nor `failed` — the upload has not finished one way or another. */
function inFlight(asset: AssetState): boolean {
  return asset.status !== 'ready' && asset.status !== 'failed';
}

/**
 * The 05 §8 capture lifecycle, as a pure function of the asset rows.
 *
 * ```text
 * created → preview-ready → originals-uploading → complete → processing → ready
 *                                                     ↘ partial   ↘ failed
 * ```
 *
 * `jobsQueued` defaults to `jobsDone` because finished work was necessarily
 * started, which makes the two-argument form — the one the plan names, and the
 * one every caller that has queued nothing yet wants — mean exactly what it
 * reads as. Only a caller that has *just* queued jobs and is waiting for them
 * passes the third argument.
 *
 * Job state is checked before the upload ladder on purpose. Once workers are
 * running they create their own asset rows in `pending`, and a ladder consulted
 * first would read those as "uploading again" and walk a `processing` capture
 * backwards.
 */
export function nextCaptureStatus(
  assets: readonly AssetState[],
  jobsDone: boolean,
  jobsQueued: boolean = jobsDone,
): CaptureStatus {
  if (assets.length === 0) return 'created';

  const failed = assets.filter((asset) => asset.status === 'failed');
  // Total loss outranks everything, including a queue that will now find
  // nothing to work on.
  if (failed.length === assets.length) return 'failed';

  if (jobsQueued) return jobsDone ? 'ready' : 'processing';

  const pending = assets.filter(inFlight);
  if (pending.length === 0) {
    // Everything has settled. Some originals failed and were not retried is
    // exactly what `partial` means (05 §8).
    if (failed.length > 0) return 'partial';
    // Settled with no originals at all is not a finished capture — it is a
    // preview that arrived first (03 §4), with the frames still to come.
    if (assets.some((asset) => asset.role === ORIGINAL_ROLE)) return 'complete';
    return previewOrCreated(assets);
  }

  if (assets.some((asset) => asset.role === ORIGINAL_ROLE && inFlight(asset))) {
    return 'originals-uploading';
  }
  return previewOrCreated(assets);
}

function previewOrCreated(assets: readonly AssetState[]): CaptureStatus {
  const shown = assets.some(
    (asset) => asset.status === 'ready' && PREVIEW_ROLES.has(asset.role),
  );
  return shown ? 'preview-ready' : 'created';
}

/**
 * Re-derives a capture's status from what is actually in the tables and stores
 * it. A recompute, not a transition: the status column is a cache of the asset
 * rows, so rebuilding it can never disagree with them.
 *
 * Job state comes from `processing_events`, which is what makes `processing`
 * survive a later recompute triggered by a worker's own asset row.
 */
export async function recomputeCaptureStatus(
  db: KinoDatabase,
  captureId: string,
): Promise<CaptureStatus> {
  const [assetRows, jobRows] = await Promise.all([
    db.query.assets.findMany({
      columns: { role: true, status: true },
      where: (asset, { eq: is }) => is(asset.captureId, captureId),
    }),
    db
      .select({ status: processingEvents.status })
      .from(processingEvents)
      .where(eq(processingEvents.captureId, captureId)),
  ]);

  const jobsQueued = jobRows.length > 0;
  const jobsDone = jobsQueued && jobRows.every((job) => job.status === 'done');
  const status = nextCaptureStatus(assetRows, jobsDone, jobsQueued);

  await db.update(captures).set({ status }).where(eq(captures.id, captureId));
  return status;
}

/* ---------------------------------------------------------- idempotency -- */

/**
 * `<captureUuid>:<role>:<frameIndex>` (05 §9).
 *
 * A derived role has no frame, and the field is left *empty* rather than filled
 * with a word: an empty field cannot collide with any integer index, whereas
 * `none` or `-1` would eventually be one.
 */
export function idempotencyKeyFor(
  captureUuid: string,
  role: string,
  frameIndex: number | null,
): string {
  return `${captureUuid}:${role}:${frameIndex === null ? '' : String(frameIndex)}`;
}

/* -------------------------------------------------------- role and mime -- */

/** A caller error in the shape of an asset declaration. */
export class AssetShapeError extends Error {
  readonly statusCode = 400;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AssetShapeError';
    this.code = code;
  }
}

/**
 * The content types the platform stores, and the file extension each gets.
 *
 * An allow-list rather than a parser: the extension ends up in an object key,
 * and a key built from an arbitrary client string is how a storage bucket grows
 * things nobody can account for.
 */
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/png': 'png',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'application/json': 'json',
};

/** 05 §6 fixes originals at `cam-<NN>.jpg`, so the bytes have to be JPEG. */
const ORIGINAL_MIME = 'image/jpeg';

/**
 * Where an asset's bytes go, and the validation of the declaration that decides
 * it — the two are one function because the key *is* the consequence of the
 * declaration and splitting them would let an invalid pair produce a key.
 */
export function assetObjectKey(
  rollId: string,
  captureId: string,
  role: string,
  frameIndex: number | null,
  mime: string,
): string {
  const extension = MIME_EXTENSIONS[mime];
  if (extension === undefined) {
    throw new AssetShapeError('UNSUPPORTED_MIME', `this platform does not store ${mime}`);
  }

  if (role === ORIGINAL_ROLE) {
    if (frameIndex === null) {
      throw new AssetShapeError('FRAME_INDEX_REQUIRED', 'an original frame must say which camera');
    }
    if (mime !== ORIGINAL_MIME) {
      // The key says `.jpg`; letting the bytes be something else would make the
      // key lie to every consumer downstream.
      throw new AssetShapeError('UNSUPPORTED_MIME', `original frames must be ${ORIGINAL_MIME}`);
    }
    return originalKey(rollId, captureId, frameIndex);
  }

  if (frameIndex !== null) {
    throw new AssetShapeError('FRAME_INDEX_UNEXPECTED', `role ${role} does not belong to a frame`);
  }
  return derivedKey(rollId, captureId, `${role}.${extension}`);
}

/* ------------------------------------------------------------- checksums -- */

/**
 * Streams an object back out of storage and returns its digest and length.
 *
 * Re-reading rather than trusting the bytes that went in is the point: it
 * catches a truncated part, a part that landed twice, and storage that accepted
 * something other than what was sent. D4 assets are ≤ ~2 MB, so the cost of
 * being exact here is a few milliseconds.
 *
 * Streamed, not buffered — the verification must not become the thing that
 * decides how large an asset may be.
 */
export async function digestStoredObject(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<{ sha256: string; bytes: number }> {
  const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (got.Body === undefined) throw new Error(`stored object ${key} has no body`);

  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of got.Body as Readable) {
    const buffer = chunk as Uint8Array;
    hash.update(buffer);
    bytes += buffer.byteLength;
  }
  return { sha256: hash.digest('hex'), bytes };
}

/* ------------------------------------------------------- processing jobs -- */

/**
 * Task 22's job names, verbatim, so the enqueue call site does not have to
 * change when the real queue arrives.
 */
export type JobName =
  | 'generate-thumbnail'
  | 'generate-gallery-still'
  | 'render-wiggle-webp'
  | 'render-wiggle-mp4'
  | 'render-contact-sheet'
  | 'extract-metadata'
  | 'generate-recap'
  | 'ai-enhance'
  | 'export-roll'
  | 'purge-trash';

export interface JobPayload {
  captureId?: string;
  rollId?: string;
  /** BullMQ's `jobId` in Task 22, which is what makes re-enqueueing a no-op. */
  jobKey: string;
}

export function jobKeyFor(captureId: string, job: JobName): string {
  return `${captureId}:${job}`;
}

/**
 * Which jobs a finished capture needs (03 §4, Task 22's fan-out).
 *
 * A role the device already uploaded is skipped: device previews take priority
 * and workers exist to fill gaps and upgrade quality, not to redo work that has
 * already arrived. `render-wiggle-mp4` and `render-contact-sheet` are absent on
 * purpose — Task 22 enqueues those lazily, on first request, to keep the
 * party-time queue short.
 */
export function plannedJobs(mode: string, uploadedRoles: ReadonlySet<string>): JobName[] {
  const jobs: JobName[] = ['extract-metadata'];
  if (!uploadedRoles.has('thumb')) jobs.push('generate-thumbnail');
  if (!uploadedRoles.has('kino-still')) jobs.push('generate-gallery-still');
  if (mode === 'wiggle' && !uploadedRoles.has('wiggle-webp')) jobs.push('render-wiggle-webp');
  return jobs;
}

/**
 * **Stub — Task 22 replaces the body, not the signature.**
 *
 * Writes the `queued` row that `recomputeCaptureStatus` reads to decide
 * `processing`, and returns the payloads a real queue would have been handed.
 * Task 22 adds `await enqueue(name, payload)` inside the loop and nothing else
 * about this call site changes.
 *
 * Re-queueing is a no-op here, as it will be under BullMQ: a job that already
 * has an event row for this capture is skipped, so calling capture-complete
 * twice does not double the work.
 */
export async function enqueueProcessingJobs(
  db: KinoDatabase,
  captureId: string,
  jobs: readonly JobName[],
): Promise<JobPayload[]> {
  const existing = await db
    .select({ job: processingEvents.job })
    .from(processingEvents)
    .where(eq(processingEvents.captureId, captureId));
  const already = new Set(existing.map((row) => row.job));

  const fresh = jobs.filter((job) => !already.has(job));
  if (fresh.length === 0) return [];

  await db.insert(processingEvents).values(
    fresh.map((job) => ({
      id: newId('pev'),
      captureId,
      job,
      status: 'queued',
    })),
  );

  return fresh.map((job) => ({ captureId, jobKey: jobKeyFor(captureId, job) }));
}

/* ----------------------------------------------------------------- counts -- */

/** The three numbers the host dashboard shows above the feed (03 §10). */
export interface RollCaptureCounts {
  captures: number;
  pending: number;
  hidden: number;
}

/**
 * A capture whose media has stopped moving, one way or the other. Everything
 * else is what the dashboard calls "Pending" — still uploading, or queued
 * behind a worker.
 */
const SETTLED_STATUSES = ['ready', 'partial', 'failed'];

/**
 * One query, three counts. `deleted_at` is respected everywhere: a deleted
 * capture is in its trash grace period (03 §11) and is not part of any count.
 *
 * Hidden captures still count as captures — hide is not delete, and a host who
 * hid a photo has not lost it.
 */
export async function rollCaptureCounts(
  db: KinoDatabase,
  rollId: string,
): Promise<RollCaptureCounts> {
  const [row] = await db
    .select({
      captures: sql<string>`count(*)`,
      pending: sql<string>`count(*) filter (where ${notInArray(captures.status, SETTLED_STATUSES)})`,
      hidden: sql<string>`count(*) filter (where not ${captures.visible})`,
    })
    .from(captures)
    .where(and(eq(captures.rollId, rollId), isNull(captures.deletedAt)));

  return {
    captures: Number(row?.captures ?? 0),
    pending: Number(row?.pending ?? 0),
    hidden: Number(row?.hidden ?? 0),
  };
}

/** What a guest is told the roll holds: visible, undeleted captures. */
export async function visibleCaptureCount(db: KinoDatabase, rollId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`count(*)` })
    .from(captures)
    .where(
      and(eq(captures.rollId, rollId), isNull(captures.deletedAt), eq(captures.visible, true)),
    );
  return Number(row?.total ?? 0);
}
