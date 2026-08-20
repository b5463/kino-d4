import { and, eq, inArray } from 'drizzle-orm';
import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { KinoDatabase } from '../plugins/db';
import { newId } from '../ids';
import { auditRows } from '../rolls/rolls';
import { rollDerivedKey } from '../uploads/objectKeys';
import { auditEvents, exportJobs } from '../db/schema';

/**
 * The host's "download everything" (03 §25), as state rather than as a request.
 *
 * A full roll export is minutes of work on gigabytes of originals, so the route
 * cannot answer it inline: it records a row, hands BullMQ a job, and returns the
 * row's id. Everything the polling route later needs — is it done, where would
 * the ZIP be — is derived from that one id, which is why this module exists
 * instead of the three facts living in three files.
 *
 * The handler that actually builds the ZIP is Task 25's. This side of the
 * contract is: `export_jobs.status` moves `queued` → `running` → `done`/`failed`,
 * and a `done` job has written `exportObjectKey(rollId, jobId)`.
 */

/** The BullMQ job name. Verbatim from `JOB_NAMES` in `uploads/uploads.ts`. */
export const EXPORT_JOB_NAME = 'export-roll';

/** The statuses that mean "this export has not finished one way or the other". */
export const EXPORT_LIVE_STATUSES = ['queued', 'running'] as const;

/**
 * 24 hours (03 §25, "expiring links").
 *
 * Long enough that a host who starts a 4 GB download on hotel wifi, gives up,
 * and retries after breakfast is still holding a valid link — the whole point of
 * doing this asynchronously is that the host is not sitting and waiting. Short
 * enough that a link pasted into a group chat stops working the next day.
 *
 * This is deliberately far longer than `ASSET_URL_TTL_SECONDS` (60 s), and the
 * reason the two differ is what each link *is*: an asset URL is fetched
 * immediately by an `<img>` the server just authorized, while an export URL is
 * handed to a human to click when convenient.
 */
export const EXPORT_URL_TTL_SECONDS = 24 * 60 * 60;

/**
 * `rolls/<rollId>/derived/exports/<jobId>.zip`.
 *
 * Derived from the ids rather than stored in the row on purpose: a stored key
 * and a computed key are two answers to one question, and the day they disagree
 * the ZIP is unreachable with nothing to say why.
 */
export function exportObjectKey(rollId: string, jobId: string): string {
  return rollDerivedKey(rollId, `exports/${jobId}.zip`);
}

/**
 * The queue's name for this unit of work.
 *
 * Same `<id>:<jobName>` shape as `jobKeyFor(captureId, job)`, with the export
 * job's own id in the id position — a roll export has no capture to key on, and
 * keying on the *roll* would make two consecutive exports of one roll collide in
 * BullMQ, which is not what the one-live-export rule means. The row is what
 * bounds concurrency; the jobKey only has to be unique.
 *
 * Task 25's handler recovers the row id from `jobKey.split(':')[0]`; `rollId`
 * travels in the payload beside it.
 */
export function exportJobKey(jobId: string): string {
  return `${jobId}:${EXPORT_JOB_NAME}`;
}

export interface ExportJobRow {
  id: string;
  rollId: string;
  status: string;
}

/**
 * Two attempts, because the retry covers exactly one race: the insert loses to
 * `export_jobs_roll_live`, and the job that won it finishes before this call can
 * read it, leaving nothing to join. That window is one round trip wide and
 * cannot repeat indefinitely — a third attempt would only be superstition.
 */
const CLAIM_ATTEMPTS = 2;

/**
 * Records a queued export for a roll, or reports the one already in flight.
 *
 * Insert-and-let-the-index-decide, the same shape as `enqueueProcessingJobs`:
 * a SELECT-then-insert would let two hosts (or two taps of one button) both find
 * nothing and both insert, and the index is the only thing that can actually
 * refuse the second one.
 *
 * The audit row is written in the same transaction as the job row. A trail that
 * can lose entries when a later statement fails reads as authoritative while
 * being incomplete, which is worse than having none.
 *
 * The caller cannot tell a fresh claim from a joined one, and does not need to:
 * submitting is idempotent under the job's own id, so "did I create this row" is
 * not a question the queue side has to answer. Deliberately so — a caller that
 * only submitted its *own* claims would leave a `queued` row unqueued forever
 * once one submit had failed.
 */
export async function claimExportJob(db: KinoDatabase, rollId: string): Promise<string> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const jobId = newId('exp');

    const claimed = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(exportJobs)
        .values({ id: jobId, rollId, status: 'queued' })
        // Bare, with no inference target: the index is partial, so naming it
        // would mean repeating its predicate here — a second copy of the rule
        // that could drift from the schema's.
        .onConflictDoNothing()
        .returning({ id: exportJobs.id });
      if (row === undefined) return null;

      await tx
        .insert(auditEvents)
        .values(
          auditRows([
            { rollId, actor: 'host', action: 'roll.exported', target: row.id },
          ]),
        );
      return row.id;
    });

    if (claimed !== null) return claimed;

    const [live] = await db
      .select({ id: exportJobs.id })
      .from(exportJobs)
      .where(
        and(eq(exportJobs.rollId, rollId), inArray(exportJobs.status, [...EXPORT_LIVE_STATUSES])),
      )
      .limit(1);
    if (live !== undefined) return live.id;
  }

  throw new Error(`could not claim an export job for roll ${rollId} in ${CLAIM_ATTEMPTS} attempts`);
}

/**
 * One export job of one roll.
 *
 * `rollId` is part of the WHERE, not checked afterwards: a job id from another
 * roll must be indistinguishable from one that never existed, and the only way
 * to guarantee that is for the query to be unable to return it.
 */
export async function readExportJob(
  db: KinoDatabase,
  rollId: string,
  jobId: string,
): Promise<ExportJobRow | undefined> {
  const [row] = await db
    .select({ id: exportJobs.id, rollId: exportJobs.rollId, status: exportJobs.status })
    .from(exportJobs)
    .where(and(eq(exportJobs.id, jobId), eq(exportJobs.rollId, rollId)))
    .limit(1);
  return row;
}

/**
 * Whether the ZIP is actually at the key.
 *
 * A HEAD before every signature, because a signed URL to a missing object is a
 * link that 404s from storage — the host cannot tell that from a broken service,
 * and the status field would be claiming the file exists. Signing is cheap and
 * local; one HEAD to make the claim true is the right trade.
 */
export async function exportObjectExists(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    // 404 and 403-on-missing both mean "nothing to sign". Distinguishing them
    // would change nothing about the answer this function gives.
    return false;
  }
}

/** A 24 h GET link to a ZIP that has already been confirmed present. */
export async function signExportUrl(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: EXPORT_URL_TTL_SECONDS,
  });
}
