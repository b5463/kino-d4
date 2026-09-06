import { asc, eq } from 'drizzle-orm';
import { UnrecoverableError } from 'bullmq';
import { assets, captures } from '../db/schema';
import { derivedCaptureKey } from '../storage/derived';
import type { JobCtx, JobPayload, WorkerDatabase } from './types';

/**
 * What every image handler needs before it can do anything: the capture row, its
 * asset rows, and the one rule they all share about which frame to work from.
 *
 * The reads live here rather than in each handler because the *source-frame
 * rule* is one decision with four readers. `generate-thumbnail` and
 * `generate-gallery-still` must agree about it — a tile and the still it opens
 * into showing different cameras is a bug a guest would notice immediately — and
 * a rule copied twice is a rule that will eventually be copied wrong.
 */

/** A capture, narrowed to the columns a handler reads. */
export interface CaptureRow {
  id: string;
  captureUuid: string;
  rollId: string;
  deviceId: string;
  mode: string;
  look: string | null;
  capturedAt: Date;
  frameCount: number;
  resolution: string;
  timing: unknown;
  /** The device's capture-time record (audit #59): untyped passthrough, read
   * back through `captureCalibration` before a render acts on any of it. */
  provenance: unknown;
  /** The host's playback choice, or null for the renderer's defaults. */
  playback: unknown;
  status: string;
}

/** An asset row, narrowed the same way. */
export interface AssetRow {
  id: string;
  role: string;
  frameIndex: number | null;
  mime: string;
  width: number | null;
  height: number | null;
  objectKey: string;
  status: string;
}

/** The role that holds an untouched camera frame. */
export const ORIGINAL_ROLE = 'original-frame';

/** The role of the full-size still, whether the device sent it or a worker made it. */
export const STILL_ROLE = 'kino-still';

/**
 * The file `generate-gallery-still` writes, and therefore the one `kino-still`
 * in the system that a worker produced rather than received.
 *
 * It lives here rather than in `galleryStill.ts` because *every* consumer of the
 * source rule has to be able to recognise it — see `stillSource`.
 */
export const WORKER_STILL_NAME = 'still.webp';

/**
 * The columns the source-frame rule actually reads.
 *
 * Narrower than `CaptureRow` because Task 25's roll-scoped jobs select a
 * different, smaller set of columns — a recap reads dozens of captures and has no
 * use for each one's timing document — and they need the same rule. A structural
 * type is what lets both callers pass what they have without either widening its
 * query or the rule inventing a second version of itself.
 */
export type CaptureIdentity = Pick<CaptureRow, 'id' | 'rollId' | 'frameCount'>;

/** The key `generate-gallery-still` writes its own output to, for this capture. */
export function workerStillKey(capture: CaptureIdentity): string {
  return derivedCaptureKey(capture.rollId, capture.id, WORKER_STILL_NAME);
}

/**
 * A job pointed at a capture that is not there.
 *
 * Extends BullMQ's `UnrecoverableError`, which is what actually makes the
 * "do not retry this" claim true rather than merely stated: BullMQ skips the
 * remaining attempts when a processor throws one, and the queue's own terminal
 * check treats it as final and releases the job's enqueue lock. A capture
 * deleted between capture-complete and the job running is a normal race, not a
 * broken renderer, and re-reading a row that will never come back four more
 * times — over ten seconds, then twenty, then forty — buys nothing.
 *
 * The dependency is the right way round: `UnrecoverableError` is BullMQ's
 * contract for exactly this, and declaring it at the throw site is clearer than
 * a string code the queue has to know to look for.
 */
export class MissingCaptureError extends UnrecoverableError {
  readonly code = 'CAPTURE_NOT_FOUND';

  constructor(captureId: string) {
    super(`capture ${captureId} does not exist`);
    this.name = 'MissingCaptureError';
  }
}

/** A capture-scoped job whose payload has no capture id. */
export function requireCaptureId(payload: JobPayload): string {
  const { captureId } = payload;
  if (typeof captureId !== 'string' || captureId === '') {
    throw new Error(`job ${payload.jobKey} is capture-scoped but carries no captureId`);
  }
  return captureId;
}

export async function loadCapture(db: WorkerDatabase, captureId: string): Promise<CaptureRow> {
  const [row] = await db
    .select({
      id: captures.id,
      captureUuid: captures.captureUuid,
      rollId: captures.rollId,
      deviceId: captures.deviceId,
      mode: captures.mode,
      look: captures.look,
      capturedAt: captures.capturedAt,
      frameCount: captures.frameCount,
      resolution: captures.resolution,
      timing: captures.timing,
      provenance: captures.provenance,
      playback: captures.playback,
      status: captures.status,
    })
    .from(captures)
    .where(eq(captures.id, captureId))
    .limit(1);

  if (row === undefined) throw new MissingCaptureError(captureId);
  return row;
}

export async function loadAssets(db: WorkerDatabase, captureId: string): Promise<AssetRow[]> {
  return db
    .select({
      id: assets.id,
      role: assets.role,
      frameIndex: assets.frameIndex,
      mime: assets.mime,
      width: assets.width,
      height: assets.height,
      objectKey: assets.objectKey,
      status: assets.status,
    })
    .from(assets)
    .where(eq(assets.captureId, captureId))
    .orderBy(asc(assets.frameIndex), asc(assets.id));
}

/** The stored asset for a role, if it has arrived. */
export function readyAsset(rows: readonly AssetRow[], role: string): AssetRow | null {
  return rows.find((row) => row.role === role && row.status === 'ready') ?? null;
}

/**
 * The capture's original frames that are actually stored, in camera order.
 *
 * `status = 'ready'` is the filter that matters: a `pending` row is a frame the
 * device declared and has not finished uploading, and reading its object would
 * fail or — worse, on a multipart upload — succeed on a partial file.
 */
export function originalFrames(rows: readonly AssetRow[]): AssetRow[] {
  return rows
    .filter((row) => row.role === ORIGINAL_ROLE && row.status === 'ready' && row.frameIndex !== null)
    .sort((a, b) => (a.frameIndex ?? 0) - (b.frameIndex ?? 0));
}

/** Where a still or a thumbnail gets its pixels, and why. */
export interface StillSource {
  /** The stored object to read. */
  key: string;
  /** The frame it came from, or `null` when it came from an uploaded still. */
  frameIndex: number | null;
}

/**
 * The source-frame rule, shared by `generate-thumbnail` and
 * `generate-gallery-still`.
 *
 * 1. **A `kino-still` the device uploaded wins.** 03 §4: device-produced media
 *    takes priority and workers exist to fill gaps, not to redo work that has
 *    already arrived. The device also had the whole scene in front of it and may
 *    have picked or blended a better frame than any single camera's.
 *
 *    **The worker's own still is not one of those.** `generate-gallery-still`
 *    writes role `kino-still` at `derived/still.webp`, and both it and
 *    `generate-thumbnail` are queued by the same capture-complete. If that row
 *    counted as "uploaded", then whichever job BullMQ happened to run second
 *    would derive from the other's output: a thumbnail re-encoding a 1280 px
 *    WebP q82 down to 720 px q82 is WebP→WebP generation loss, and — worse — its
 *    bytes and therefore its sha256 would depend on which job won the race.
 *    Idempotent jobs (03 §19) cannot have order-dependent output. So the
 *    exclusion lives *here*, in the rule, rather than at each call site: it is
 *    one hazard, and a fourth caller (Task 24's renders) inherits the fix instead
 *    of having to remember it.
 * 2. **Otherwise the lower median of the frames actually stored**, ordered by
 *    `frameIndex`. Four stored cameras `[1,2,3,4]` give camera 2 — the
 *    centre-ish viewpoint, which on the V1 rig is also the metering camera. A
 *    sparse `[1,3,4]` gives camera 3, the middle of what there is.
 *
 *    It used to be "the frame nearest `floor(frameCount / 2)`", which compared a
 *    *count* against a camera *number* and only agreed with this by coincidence
 *    at four frames: a capture that lost camera 2 fell back to camera 1, an
 *    edge viewpoint, when camera 3 was right there. Reading the rows keeps the
 *    rule about the pictures that exist. A re-run over the same rows is still
 *    byte-identical, because the rows are the only input.
 */
export function stillSource(capture: CaptureIdentity, rows: readonly AssetRow[]): StillSource {
  const ownKey = workerStillKey(capture);
  const uploaded = rows.find(
    (row) => row.role === STILL_ROLE && row.status === 'ready' && row.objectKey !== ownKey,
  );
  if (uploaded !== undefined) return { key: uploaded.objectKey, frameIndex: null };

  // `originalFrames` already sorts by frameIndex ascending.
  const frames = originalFrames(rows);
  // Lower median: index 1 of four, index 1 of three, index 0 of one or two.
  const best = frames[Math.floor((frames.length - 1) / 2)];
  if (best === undefined) {
    throw new Error(`capture ${capture.id} has no stored original frame to derive from`);
  }
  return { key: best.objectKey, frameIndex: best.frameIndex };
}

/** Reads a stored object fully into memory. */
export async function readObject(ctx: JobCtx, key: string): Promise<Buffer> {
  const stream = await ctx.getObject(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}
