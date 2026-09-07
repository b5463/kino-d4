import { AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { assets, uploadSessions } from '../db/schema';
import { errorFields, log } from '../log';
import type { JobCtx, WorkerDatabase } from './types';

/**
 * Reaping the upload sessions a camera never finished (05 §9).
 *
 * ## What actually strands
 *
 * MinIO already cleans up its own half: `MINIO_API_STALE_UPLOADS_EXPIRY=24h`
 * drops the parts of a multipart nobody completed, server-side, whether or not
 * this platform ever asks. What survives that is the **row**. An
 * `upload_sessions` row still saying `open` is a promise that a camera is
 * mid-transfer, and it holds `idempotency_key` — `<captureUuid>:<role>:<frameIndex>`,
 * unique — so the frame it describes can never be re-offered under the same key.
 * A camera that lost power at 3 a.m. therefore cannot re-upload that frame, ever,
 * and the capture behind it never completes.
 *
 * ## 24 hours, matched to MinIO on purpose
 *
 * The same window as `MINIO_API_STALE_UPLOADS_EXPIRY`, so there is one answer to
 * "how long may an upload be in flight" rather than two that can disagree. It is
 * far past any real transfer: 05 §9's parts are megabytes over a device's own
 * Wi-Fi, and a camera that has been trying for a day is a camera that stopped.
 *
 * ## Abort, then mark
 *
 * Storage first, database second — the same ordering as every other retention
 * path here, and for the same reason: the row is what names the multipart, so a
 * run that marked the row `aborted` first and then died would leave an upload id
 * nothing can address. An abort of a multipart MinIO has already expired is a
 * `NoSuchUpload`, which is not a failure — it is the expected answer, and it is
 * swallowed. Any *other* abort failure keeps the row `open` for the next run.
 *
 * A session with no `s3_upload_id` never reached storage at all; there is
 * nothing to abort and the row is marked directly.
 *
 * `AbortMultipartUpload` is not on `guardOriginalWrites`'s write list, which is
 * correct rather than convenient: it destroys parts that were never assembled
 * into an object, so it cannot overwrite an original — and an abandoned upload
 * under `original/` is precisely the case this exists for (01 §7 is about the
 * frames a camera *stored*).
 */

/** How long a session may say `open` before it is treated as abandoned. */
export const UPLOAD_SESSION_TIMEOUT_HOURS = 24;

/** Rows per pass. Bounded so a backlog drains over several runs, not one. */
export const UPLOAD_REAP_BATCH = 500;

export interface UploadReapResult {
  /** Rows moved from `open` to `aborted`. */
  aborted: number;
  /** Multiparts storage confirmed gone (including ones it had already expired). */
  multiparts: number;
  /** Rows left `open` because the abort failed; retried next run. */
  failures: number;
}

/** S3's answer when the multipart is already gone. Not a failure. */
const ALREADY_GONE: ReadonlySet<string> = new Set(['NoSuchUpload', 'NoSuchKey', 'NotFound']);

interface StaleSession {
  id: string;
  s3UploadId: string | null;
  objectKey: string | null;
}

/**
 * The `open` sessions older than the cutoff, oldest first.
 *
 * PostgreSQL computes the cutoff, not Node — one clock decides, and it is the
 * clock that stamped `created_at`. The join is a left join on purpose: a session
 * whose asset row is gone still has a row to retire, it just has no key to abort
 * against.
 */
async function staleSessions(
  db: WorkerDatabase,
  hours: number,
  limit: number,
): Promise<StaleSession[]> {
  return db
    .select({
      id: uploadSessions.id,
      s3UploadId: uploadSessions.s3UploadId,
      objectKey: assets.objectKey,
    })
    .from(uploadSessions)
    .leftJoin(assets, eq(assets.id, uploadSessions.assetId))
    .where(
      and(
        eq(uploadSessions.status, 'open'),
        lt(uploadSessions.createdAt, sql`now() - (${hours} * interval '1 hour')`),
      ),
    )
    .orderBy(asc(uploadSessions.createdAt))
    .limit(limit);
}

function isAlreadyGone(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  const code = (err as { Code?: unknown }).Code;
  return (
    (typeof name === 'string' && ALREADY_GONE.has(name)) ||
    (typeof code === 'string' && ALREADY_GONE.has(code))
  );
}

/**
 * One pass.
 *
 * Isolated per session: one row whose abort keeps failing must not stop the rest
 * being reaped, which is the same rule the capture purge now follows. The count
 * of failures comes back in the result so a run that half worked says so.
 */
export async function reapStaleUploads(
  ctx: JobCtx,
  hours: number = UPLOAD_SESSION_TIMEOUT_HOURS,
  limit: number = UPLOAD_REAP_BATCH,
): Promise<UploadReapResult> {
  const result: UploadReapResult = { aborted: 0, multiparts: 0, failures: 0 };
  const rows = await staleSessions(ctx.db, hours, limit);

  for (const row of rows) {
    if (row.s3UploadId !== null && row.objectKey !== null) {
      try {
        await ctx.s3.send(
          new AbortMultipartUploadCommand({
            Bucket: ctx.bucket,
            Key: row.objectKey,
            UploadId: row.s3UploadId,
          }),
        );
        result.multiparts += 1;
      } catch (err) {
        if (isAlreadyGone(err)) {
          // MinIO's own stale-upload expiry got there first. That is the normal
          // outcome, not an error, and the row still needs retiring.
          result.multiparts += 1;
        } else {
          result.failures += 1;
          log.warn('could not abort stale multipart; session left open', {
            uploadId: row.id,
            key: row.objectKey,
            ...errorFields(err, log.level === 'debug'),
          });
          continue;
        }
      }
    }

    try {
      // `where status = 'open'` so a camera that finished between the select and
      // this update keeps its `complete`; the reaper never overwrites an outcome.
      await ctx.db
        .update(uploadSessions)
        .set({ status: 'aborted' })
        .where(and(eq(uploadSessions.id, row.id), eq(uploadSessions.status, 'open')));
      result.aborted += 1;
    } catch (err) {
      result.failures += 1;
      log.warn('could not mark stale upload session aborted', {
        uploadId: row.id,
        ...errorFields(err, log.level === 'debug'),
      });
    }
  }

  return result;
}
