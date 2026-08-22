import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { and, desc, eq, isNull, notInArray, sql } from 'drizzle-orm';
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

/**
 * The end of the 05 §8 ladder: a capture whose media has stopped moving, one way
 * or the other. Nothing recomputes out of one of these, which is what makes them
 * safe to trust from the stored column and to count as not-pending.
 *
 * One definition, read by three things that must agree: the dashboard's Pending
 * filter, `isSettledCaptureStatus`, and the read-time convergence that skips
 * these rows. A second list would let a capture be pending in the count and
 * settled to the recompute at the same time.
 */
export const SETTLED_CAPTURE_STATUSES = ['ready', 'partial', 'failed'] as const;

const SETTLED: ReadonlySet<string> = new Set<string>(SETTLED_CAPTURE_STATUSES);

/** True once the stored status can no longer change on its own. */
export function isSettledCaptureStatus(status: string): boolean {
  return SETTLED.has(status);
}

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
 *
 * `jobsLost` is the fourth argument because a *job* can be permanently lost
 * without any *asset* being lost. A derivative that never rendered has no failed
 * asset row — it has no row at all — so the asset ladder alone would call that
 * capture `ready`, which is the one thing it is not: the platform owes it a
 * thumbnail it is never going to produce. It defaults to false so every caller
 * that has queued nothing keeps reading as it did.
 */
export function nextCaptureStatus(
  assets: readonly AssetState[],
  jobsDone: boolean,
  jobsQueued: boolean = jobsDone,
  jobsLost: boolean = false,
): CaptureStatus {
  if (assets.length === 0) return 'created';

  const failed = assets.filter((asset) => asset.status === 'failed');
  // Total loss outranks everything, including a queue that will now find
  // nothing to work on.
  if (failed.length === assets.length) return 'failed';

  if (jobsQueued) {
    // While the queue is still working, the outcome is not decided yet — a
    // failed asset may still be retried, so `processing` is the honest answer.
    if (!jobsDone) return 'processing';
    // Once it has finished, a capture that permanently lost an asset — or a
    // derivative a job was supposed to produce and never did — is `partial`, not
    // `ready` (05 §8). Reporting `ready` here would drop it out of the host's
    // Pending count while it is genuinely incomplete, which is the one thing
    // "partial" exists to prevent.
    return failed.length > 0 || jobsLost ? 'partial' : 'ready';
  }

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
 * Where each of a capture's jobs has got to — one row per job, the newest.
 *
 * `processing_events` is an **append-only log** (Task 22): a worker adds
 * `running`, then `done` or `failed`, and it never touches the `queued` row the
 * enqueue wrote. It cannot: the partial unique index over `status = 'queued'` is
 * what makes a second capture-complete a no-op, and clearing that row would
 * re-arm the enqueue.
 *
 * So the log has to be read as a log. "Have the jobs finished?" asked of *all*
 * the rows is `every(status === 'done')` over a set that still contains the
 * queued row — an answer that is `false` for every capture forever, which would
 * strand every capture in `processing`. Asked of each job's latest row, it is
 * the question that was meant.
 *
 * `DISTINCT ON` with the job first in the `ORDER BY` is PostgreSQL's one-pass
 * form of that: pick the first row per job, having ordered the rows so the
 * newest comes first. The tiebreaks after `at` matter because a worker can write
 * two rows inside one transaction, where `now()` is identical for both:
 * lifecycle order decides first (a `done` beats the `running` it followed), and
 * the id is a last resort so the read is total rather than arbitrary.
 *
 * The rank knows Task 23's two statuses as well. `abandoned` outranks
 * everything, because a job with no attempts left is over whatever else was
 * written in the same instant; `superseded` — the retired `queued` row, see
 * `markJobAbandoned` in the worker — ranks below `queued` so that it can never
 * be mistaken for a live enqueue.
 */
async function latestJobStatuses(
  db: KinoDatabase,
  captureId: string,
): Promise<{ job: string; status: string }[]> {
  const lifecycleRank = sql`case ${processingEvents.status}
      when 'superseded' then 0
      when 'queued' then 1
      when 'running' then 2
      when 'failed' then 3
      when 'done' then 4
      when 'abandoned' then 5
      else -1
    end`;

  return db
    .selectDistinctOn([processingEvents.job], {
      job: processingEvents.job,
      status: processingEvents.status,
    })
    .from(processingEvents)
    .where(eq(processingEvents.captureId, captureId))
    .orderBy(
      processingEvents.job,
      desc(processingEvents.at),
      desc(lifecycleRank),
      desc(processingEvents.id),
    );
}

/**
 * Re-derives a capture's status from what is actually in the tables and stores
 * it. A recompute, not a transition: the status column is a cache of the asset
 * rows, so rebuilding it can never disagree with them.
 *
 * Job state comes from `processing_events`, which is what makes `processing`
 * survive a later recompute triggered by a worker's own asset row.
 *
 * A job whose latest row is `failed` counts as neither queued-and-finished nor
 * done, so the capture stays `processing` — honest, because BullMQ still has
 * retries left and a `failed` row is one attempt, not a verdict.
 *
 * An `abandoned` row *is* the verdict: the worker writes it when the attempts run
 * out (see `markJobAbandoned`). Those jobs count as finished — otherwise the
 * capture sits in `processing` for the rest of time, which is board issue #8 —
 * and they count as lost, which is what turns the answer into `partial` rather
 * than `ready`. `partial` is right even when every asset row is intact: the
 * platform owes this capture a derivative it is never going to produce.
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
    latestJobStatuses(db, captureId),
  ]);

  const jobsQueued = jobRows.length > 0;
  // Settled either way: `done` succeeded, `abandoned` will not be tried again.
  const jobsDone =
    jobsQueued && jobRows.every((job) => job.status === 'done' || job.status === 'abandoned');
  const jobsLost = jobRows.some((job) => job.status === 'abandoned');
  const status = nextCaptureStatus(assetRows, jobsDone, jobsQueued, jobsLost);

  await db.update(captures).set({ status }).where(eq(captures.id, captureId));
  return status;
}

/* --------------------------------------------------- convergence on read -- */

/**
 * How a converge failure is reported. The route passes `app.log.warn`; the
 * default swallows, because the *reader* has already decided the request
 * survives either way and a module with no logger of its own should not invent
 * one.
 */
export type ConvergeFailureLog = (err: unknown, captureId: string) => void;

const NO_LOG: ConvergeFailureLog = () => {};

/**
 * How many recomputes may be in flight at once.
 *
 * Three, because of the pool. `dbPlugin` opens `postgres(..., { max: 10 })`, and
 * one `recomputeCaptureStatus` peaks at **two** pooled connections - its asset
 * read and its job read run under one `Promise.all` - before taking one more for
 * the `UPDATE`. Three in flight is therefore at most six of the ten, leaving four
 * for the device uploads and guest requests sharing that pool.
 *
 * Unbounded was the alternative, and it is a latency cliff exactly when it hurts:
 * a live 500-capture roll would have one dashboard render queue ~1500 statements
 * ahead of a camera trying to finish an upload. Capping trades a slower dashboard
 * for a pool that still answers everything else, which is the right way round.
 */
export const CONVERGE_CONCURRENCY = 3;

/**
 * `items.map` with at most `limit` promises alive, and no dependency to get it.
 *
 * A shared cursor rather than fixed chunks: a chunk runs at the speed of its
 * slowest member and leaves workers idle at every boundary, whereas a worker that
 * takes the next index the moment it is free keeps all `limit` of them busy.
 */
async function mapBounded<In, Out>(
  items: readonly In[],
  limit: number,
  run: (item: In) => Promise<Out>,
): Promise<Out[]> {
  const out: Out[] = new Array<Out>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      out[index] = await run(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * One capture's recompute, with the stored status as the answer if it fails.
 *
 * This is what lets a read write at all without becoming able to fail. Before
 * convergence existed the feed was a pure read that could not 500 on a lock
 * timeout, a transient pool error or a read-only connection; keeping that
 * property means a rejected recompute degrades to the value already stored, which
 * is stale rather than wrong. A stale tile beats a broken gallery, and the next
 * read tries again.
 */
async function convergeRow(
  db: KinoDatabase,
  row: CaptureStatusRow,
  log: ConvergeFailureLog,
): Promise<string> {
  try {
    return await recomputeCaptureStatus(db, row.id);
  } catch (err) {
    log(err, row.id);
    return row.status;
  }
}

/**
 * The status a reader should report for a capture, recomputing it first if it
 * has not settled yet.
 *
 * ### Why a read has to do this
 *
 * `recomputeCaptureStatus` is the API's only writer of `captures.status`, and it
 * is called from the three device endpoints: capture-complete, asset-init and
 * asset-complete. Capture-complete runs *before* the derivative jobs execute, so
 * the status it stores is `processing` — and nothing at all runs after a job
 * finishes. The worker cannot call this module (05 §11 keeps the API out of the
 * worker, and a second copy of the ladder in the worker would drift from this
 * one), so without convergence here a fully processed capture keeps a stored
 * `processing` forever, and 03 §10's Pending number never reaches zero.
 *
 * So the *read* closes the loop. The stored column stays a cache of the rows,
 * this stays the only place that derives it, and a reader that would otherwise
 * hand out a stale cache refreshes it instead.
 *
 * ### Why no event is published when a read changes the status
 *
 * There is nothing new to tell anyone. The worker already publishes
 * `processing.completed` per role as each job lands, and 05 §10 has the PWA
 * refetching the capture on that event — that refetch *is* the read that
 * converges the status, so the client learns the new value in the response it
 * asked for. An extra `capture.updated` here would be a second notification for
 * one change, and the read that answered it would arrive after the client
 * already had the answer. Do not add one.
 *
 * ### Why only non-terminal captures
 *
 * A settled status (`ready`, `partial`, `failed`) is the end of the ladder: no
 * later row can move it, so recomputing it can only cost two queries and a write
 * to reach the value already stored. Skipping them is what keeps a page of a
 * finished roll exactly as cheap as it was before this existed, and bounds the
 * extra work by the number of *unsettled* captures on the page.
 *
 * The corollary is a trap for a future caller: a job enqueued *lazily* against an
 * already-terminal capture (`render-wiggle-mp4` and `render-contact-sheet`, which
 * `plannedJobs` leaves out for Task 22 to queue on first request) will never be
 * picked up by a read, because reads skip terminal rows. Whoever adds such a site
 * must call `recomputeCaptureStatus` itself when that job settles.
 */
export async function convergeCaptureStatus(
  db: KinoDatabase,
  captureId: string,
  storedStatus: string,
  log: ConvergeFailureLog = NO_LOG,
): Promise<string> {
  if (isSettledCaptureStatus(storedStatus)) return storedStatus;
  return convergeRow(db, { id: captureId, status: storedStatus }, log);
}

/** A row a page reader has already selected: enough to decide and to report. */
export interface CaptureStatusRow {
  id: string;
  status: string;
}

/**
 * `convergeCaptureStatus` for a page, as a lookup of the ids that changed hands.
 *
 * Only the unsettled rows are visited, and `CONVERGE_CONCURRENCY` of them at a
 * time: they are independent single-capture recomputes, so serialising them would
 * make a page cost the sum of its captures' round trips, while an unbounded
 * fan-out would hand the whole connection pool to one page.
 *
 * Returns only the ids it visited. A caller keeps its own row's status for
 * everything absent from the map, which is how the settled rows stay untouched
 * rather than being re-derived into the same value. A row whose recompute failed
 * is present, mapped to the status it already had.
 */
export async function convergeCaptureStatuses(
  db: KinoDatabase,
  rows: readonly CaptureStatusRow[],
  log: ConvergeFailureLog = NO_LOG,
): Promise<Map<string, string>> {
  const unsettled = rows.filter((row) => !isSettledCaptureStatus(row.status));
  const converged = await mapBounded(
    unsettled,
    CONVERGE_CONCURRENCY,
    async (row) => [row.id, await convergeRow(db, row, log)] as const,
  );
  return new Map(converged);
}

/**
 * Converges every unsettled capture of a roll, so a count taken straight
 * afterwards is counting current values.
 *
 * The roll's unsettled captures *are* its Pending set (03 §10), so this is not
 * extra work bolted onto the dashboard — it is the work the number requires. A
 * roll whose captures have all settled reads one cheap index scan and writes
 * nothing.
 *
 * Deleted captures are skipped because no count includes them.
 *
 * Bounded by `CONVERGE_CONCURRENCY` like the page form, and for a sharper reason:
 * a roll is not a page, so this set has no `limit` above it. A 500-capture roll
 * mid-party would otherwise queue every one of them at once.
 *
 * Failures are absorbed per capture. The dashboard's job is to render three
 * numbers, and numbers computed from rows one of which could not be refreshed are
 * worth more than a 500 - the Pending count is one capture behind until the next
 * render.
 */
async function convergeRoll(
  db: KinoDatabase,
  rollId: string,
  log: ConvergeFailureLog,
): Promise<void> {
  const unsettled = await db
    .select({ id: captures.id, status: captures.status })
    .from(captures)
    .where(
      and(
        eq(captures.rollId, rollId),
        isNull(captures.deletedAt),
        notInArray(captures.status, [...SETTLED_CAPTURE_STATUSES]),
      ),
    );
  await convergeCaptureStatuses(db, unsettled, log);
}

/* ---------------------------------------------------------- idempotency -- */

/**
 * `<captureUuid>:<role>:<frameIndex>` (05 §9) — the key **as the device knows
 * it**, and the one the spec names.
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

/**
 * The value actually stored in `upload_sessions.idempotency_key`, which is
 * **globally** unique — and so cannot be the device's key alone.
 *
 * `captureUuid` is generated by the camera and anchored per roll: the schema's
 * idempotency index is `(roll_id, capture_uuid)`, so the *same* uuid may
 * legitimately exist in two rolls — a camera that reboots into a fresh roll, or
 * two rigs whose uuid spaces happen to overlap. `upload_sessions.idempotency_key`
 * is unique across the whole table, so keying on the device's string alone lets
 * capture B's `init` find, reset and steal capture A's session: A loses its
 * parts and its expected digest, and B is left pointing at A's asset and can
 * never upload that role at all.
 *
 * Prefixing the capture id fixes it at the root rather than at the lookup. The
 * device-facing semantics of 05 §9 are unchanged — the substring after the
 * first colon is exactly `idempotencyKeyFor(...)` — and the row-level key is now
 * as unique as the column claims.
 */
export function sessionKeyFor(
  captureId: string,
  captureUuid: string,
  role: string,
  frameIndex: number | null,
): string {
  return `${captureId}:${idempotencyKeyFor(captureUuid, role, frameIndex)}`;
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
 * The job names, verbatim from `apps/worker/src/jobs/types.ts`.
 *
 * An array rather than a bare union so the set can be *iterated* — a producer
 * that wants to address every job of a capture (removing them, counting them)
 * needs the names at runtime, not only at compile time.
 */
export const JOB_NAMES = [
  'generate-thumbnail',
  'generate-gallery-still',
  'render-wiggle-webp',
  'render-wiggle-mp4',
  'render-contact-sheet',
  'render-social-formats',
  'extract-metadata',
  'generate-recap',
  'ai-enhance',
  'export-roll',
  'purge-trash',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

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

/** A job this call newly queued, ready to be handed to BullMQ. */
export interface QueuedJob {
  name: JobName;
  payload: JobPayload;
}

/**
 * Writes the `queued` rows and says which of them are *this* call's to submit.
 *
 * Two layers, deliberately, and in this order:
 *
 * 1. **The row is the dedupe.** The partial unique index
 *    `processing_events_capture_job_queued` allows one `queued` row per
 *    `(capture, job)`, so calling capture-complete twice — or twice at once —
 *    cannot double the work. Insert-and-let-the-index-decide, **not**
 *    SELECT-then-insert: a pre-check is exactly what the rest of this pipeline
 *    refuses to do, because two concurrent completes would both find nothing and
 *    both insert. `RETURNING` is then the honest answer to "what did this call
 *    actually queue?" — the rows the index let through, and no others.
 * 2. **The jobKey is the second dedupe.** BullMQ keeps one job per `jobId`, so
 *    even a caller that submitted the same key twice would add one job. The two
 *    layers agree rather than overlap: the row is durable and survives Redis,
 *    the jobId is what stops a duplicate reaching a handler.
 *
 * Submitting is the caller's job (`src/routes/device-captures.ts`), not this
 * function's: what happens when the queue is unreachable — fail the device's
 * request, or log and carry on — is a decision for the route that knows the row
 * is already committed.
 */
export async function enqueueProcessingJobs(
  db: KinoDatabase,
  captureId: string,
  jobs: readonly JobName[],
): Promise<QueuedJob[]> {
  if (jobs.length === 0) return [];

  const inserted = await db
    .insert(processingEvents)
    .values(
      jobs.map((job) => ({
        id: newId('pev'),
        captureId,
        job,
        status: 'queued',
      })),
    )
    // Bare, with no inference target: the index is partial, so inferring it
    // would mean repeating its predicate here — a second copy of the rule that
    // could drift from the schema's.
    .onConflictDoNothing()
    .returning({ job: processingEvents.job });

  const queued = new Set(inserted.map((row) => row.job));
  return jobs
    .filter((job) => queued.has(job))
    .map((job) => ({
      name: job,
      payload: { captureId, jobKey: jobKeyFor(captureId, job) },
    }));
}

/* ----------------------------------------------------------------- counts -- */

/** The three numbers the host dashboard shows above the feed (03 §10). */
export interface RollCaptureCounts {
  captures: number;
  pending: number;
  hidden: number;
}

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
  log: ConvergeFailureLog = NO_LOG,
): Promise<RollCaptureCounts> {
  // The Pending number is a claim about the present, so the rows it counts have
  // to be brought up to date before they are counted. Without this the dashboard
  // reports every processed capture as still pending, forever.
  await convergeRoll(db, rollId, log);

  const [row] = await db
    .select({
      captures: sql<string>`count(*)`,
      pending: sql<string>`count(*) filter (where ${notInArray(captures.status, [...SETTLED_CAPTURE_STATUSES])})`,
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
