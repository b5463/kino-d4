import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  ListPartsCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { FastifyInstance } from 'fastify';
import type { KinoDatabase } from '../plugins/db';
import { newId } from '../ids';
import { assets, uploadParts, uploadSessions } from '../db/schema';
import { isUniqueViolation } from '../db/errors';
import { assertNotOriginalOverwrite } from './objectKeys';
import { contradictsDeclaredMime, digestStoredObject } from './uploads';

/** Backs `upload_sessions.idempotency_key`; see `drizzle/0001_init.sql`. */
const SESSION_KEY_CONSTRAINT = 'upload_sessions_idempotency_key_unique';

/**
 * The mechanics of one asset upload: the row that records it, the S3 multipart
 * upload behind it, and the verification that finishes it.
 *
 * Split out of `routes/device-captures.ts` so that file stays HTTP — parse,
 * authorise, answer — and the storage choreography, which is where all the
 * partial-failure handling lives, sits in one readable place.
 */

export type AssetRow = typeof assets.$inferSelect;
export type SessionRow = typeof uploadSessions.$inferSelect;

/** The handle drizzle hands a `db.transaction` callback. */
type KinoTransaction = Parameters<Parameters<KinoDatabase['transaction']>[0]>[0];

/* ------------------------------------------------------------------ asset -- */

export interface AssetDeclaration {
  role: string;
  frameIndex: number | null;
  mime: string;
  bytes: number;
  key: string;
}

/**
 * The one asset row for a `(capture, role, frameIndex)`, created if it is not
 * there yet.
 *
 * `onConflictDoNothing` + read-back for the same reason the capture insert uses
 * it: `assets_capture_role_frame` is NULLS NOT DISTINCT, so it covers derived
 * roles too, and it — not a prior SELECT — is what settles a race.
 */
export async function upsertAsset(
  app: FastifyInstance,
  captureId: string,
  declaration: AssetDeclaration,
): Promise<AssetRow> {
  const [created] = await app.db
    .insert(assets)
    .values({
      id: newId('asset'),
      captureId,
      role: declaration.role,
      frameIndex: declaration.frameIndex,
      mime: declaration.mime,
      bytes: declaration.bytes,
      objectKey: declaration.key,
      status: 'pending',
    })
    .onConflictDoNothing()
    .returning();
  if (created !== undefined) return created;

  const [existing] = await app.db
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.captureId, captureId),
        eq(assets.role, declaration.role),
        declaration.frameIndex === null
          ? isNull(assets.frameIndex)
          : eq(assets.frameIndex, declaration.frameIndex),
      ),
    )
    .limit(1);
  if (existing === undefined) {
    throw new Error(`asset ${declaration.role} for capture ${captureId} conflicted but is not there`);
  }
  return existing;
}

/* ---------------------------------------------------------------- session -- */

export interface SessionOpening {
  /** The session already filed for this asset, if there is one. */
  existing: SessionRow | undefined;
  /** The asset row as it stands — its `objectKey` is where a restart aborts. */
  asset: AssetRow;
  key: string;
  mime: string;
  bytes: number;
  sha256: string;
  /** `sessionKeyFor(...)` — capture-scoped, so it is unique in the table. */
  sessionKey: string;
}

export type SessionOpened = { status: 'open'; uploadId: string } | { status: 'conflict' };

/**
 * Opens — or *re*-opens — the single session belonging to one asset, and
 * returns its id.
 *
 * The stored key is unique across the whole table, so a restart after a
 * checksum failure has to reuse the row rather than insert beside it. That is
 * not a workaround: one row per asset is what makes "which upload is this
 * asset's?" answerable at all.
 *
 * A unique violation on the insert therefore means a *concurrent* `init` for
 * this same asset won the race — the key is capture-scoped, so it cannot mean
 * anything else. `conflict` is the honest answer: the caller retries, finds the
 * winner's session, and resumes it. Reusing whatever row happened to be there
 * would be how one capture ends up resetting another's upload.
 */
export async function openSession(
  app: FastifyInstance,
  opening: SessionOpening,
): Promise<SessionOpened> {
  const created = await app.s3.send(
    new CreateMultipartUploadCommand({
      Bucket: app.config.S3_BUCKET,
      Key: opening.key,
      ContentType: opening.mime,
    }),
  );
  if (created.UploadId === undefined) {
    throw new Error(`storage did not return an upload id for ${opening.key}`);
  }

  const { existing } = opening;
  if (existing === undefined) {
    const id = newId('up');
    try {
      await app.db.insert(uploadSessions).values({
        id,
        assetId: opening.asset.id,
        s3UploadId: created.UploadId,
        bytesExpected: opening.bytes,
        sha256Expected: opening.sha256,
        partsReceived: 0,
        status: 'open',
        idempotencyKey: opening.sessionKey,
      });
    } catch (err) {
      if (!isUniqueViolation(err, SESSION_KEY_CONSTRAINT)) throw err;
      // Nothing recorded the upload we just created, so nothing will ever
      // finish it.
      await abortQuietly(app, opening.key, created.UploadId, id);
      return { status: 'conflict' };
    }
    return { status: 'open', uploadId: id };
  }

  if (existing.s3UploadId !== null) {
    await abortQuietly(app, opening.asset.objectKey, existing.s3UploadId, existing.id);
  }

  await app.db.delete(uploadParts).where(eq(uploadParts.uploadId, existing.id));
  await app.db
    .update(uploadSessions)
    .set({
      s3UploadId: created.UploadId,
      bytesExpected: opening.bytes,
      sha256Expected: opening.sha256,
      partsReceived: 0,
      status: 'open',
    })
    .where(eq(uploadSessions.id, existing.id));
  return { status: 'open', uploadId: existing.id };
}

/**
 * Abandons a multipart upload. Best effort: an orphaned upload costs storage, a
 * failed abort must not cost the device its retry.
 *
 * Best effort is exactly as far as this goes. The other half — reclaiming the
 * parts of an upload nobody ever completed and nobody ever aborted, a camera
 * that lost power mid-transfer — is storage policy, not application code, and
 * lives in `infra/docker-compose.*.yml` (audit API-13): MinIO's own stale-upload
 * sweep, `MINIO_API_STALE_UPLOADS_EXPIRY=24h`, pinned on the server. Not an S3
 * lifecycle rule, because this MinIO release refuses an
 * `AbortIncompleteMultipartUpload`-only rule; the compose note has the detail.
 */
async function abortQuietly(
  app: FastifyInstance,
  key: string,
  s3UploadId: string,
  uploadId: string,
): Promise<void> {
  try {
    await app.s3.send(
      new AbortMultipartUploadCommand({
        Bucket: app.config.S3_BUCKET,
        Key: key,
        UploadId: s3UploadId,
      }),
    );
  } catch (err) {
    app.log.warn({ err, uploadId }, 'could not abort a multipart upload');
  }
}

/* ------------------------------------------------- the 24-hour sweep -- */

/**
 * MinIO abandons a multipart upload nobody finished after 24 hours
 * (`MINIO_API_STALE_UPLOADS_EXPIRY`, pinned in `infra/docker-compose.prod.yml`).
 * The row in `upload_sessions` knows nothing about that, so a camera that lost
 * power on Friday and came back on Sunday resumes a session the API still calls
 * `open` against an upload id storage has never heard of.
 *
 * Every S3 call that names the upload id then answers `NoSuchUpload`, which the
 * route turned into a 500 — and the device contract classifies 5xx as
 * "transient, back off and resume", so the camera repeated the same dead upload
 * id forever. That loop is the bug; this predicate is how it is recognised.
 *
 * `NoSuchKey` is matched alongside it because the SDK reports the same
 * condition under that code on some paths (a completed-and-deleted object, a
 * bucket that lost the part manifest), and both mean the same thing to us:
 * whatever storage was holding for this session is gone.
 */
export function isMissingUpload(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < 4 && typeof cursor === 'object' && cursor !== null; depth += 1) {
    const candidate = cursor as { name?: unknown; Code?: unknown; cause?: unknown };
    const code = typeof candidate.Code === 'string' ? candidate.Code : candidate.name;
    if (code === 'NoSuchUpload' || code === 'NoSuchKey') return true;
    cursor = candidate.cause;
  }
  return false;
}

/**
 * Whether the multipart upload this session points at still exists in storage.
 *
 * One `ListParts`, and only on the *resume* branch of init — the branch that is
 * already a retry, so the round trip is paid by a client that is by definition
 * not in a hurry. A first init never reaches it.
 *
 * Any error that is not `NoSuchUpload` is rethrown: "storage is unreachable"
 * must not be mistaken for "the upload was swept", or a blip would silently
 * discard the parts a camera has already sent.
 */
export async function multipartExists(
  app: FastifyInstance,
  key: string,
  s3UploadId: string,
): Promise<boolean> {
  try {
    await app.s3.send(
      new ListPartsCommand({
        Bucket: app.config.S3_BUCKET,
        Key: key,
        UploadId: s3UploadId,
        MaxParts: 1,
      }),
    );
    return true;
  } catch (err) {
    if (isMissingUpload(err)) return false;
    throw err;
  }
}

/**
 * Forgets everything this session recorded about a multipart upload storage no
 * longer has, so the next `init` opens a fresh one instead of resuming a ghost.
 *
 * The part rows go too, not just the status: they carry etags of parts that no
 * longer exist, and a `CompleteMultipartUpload` built from them would fail for
 * a second, more confusing reason.
 */
export async function forgetSweptUpload(app: FastifyInstance, sessionId: string): Promise<void> {
  await app.db.delete(uploadParts).where(eq(uploadParts.uploadId, sessionId));
  await app.db
    .update(uploadSessions)
    .set({ status: 'failed', partsReceived: 0 })
    .where(eq(uploadSessions.id, sessionId));
}

/* ------------------------------------------------------------------ parts -- */

/** Whether a part was stored, or the reason the bytes were refused. */
export type PartOutcome =
  | { status: 'recorded' }
  | { status: 'too-large'; total: number; expected: number }
  /** Storage swept the multipart while the camera was away. Re-init. */
  | { status: 'swept' };

/**
 * Sends one part to storage and records its etag.
 *
 * Re-sending a part is normal, not an error: S3 replaces the part and the
 * unique index on `(upload_id, part_no)` makes the bookkeeping row replace
 * itself in step, so a device that never saw an acknowledgement can simply send
 * it again.
 *
 * ## The running total is checked BEFORE the bytes reach storage
 *
 * `bytesExpected` was recorded at init and then never compared to anything, so a
 * session could keep accepting parts up to `MAX_PART_NUMBER` — tens of
 * gigabytes — for an asset that declared two megabytes. The sum of the parts
 * already filed (this part's own row excluded, because a resend *replaces* it
 * rather than adding to it) plus this body has to fit what was declared.
 *
 * Refused before the `UploadPart`, not after: a check that ran afterwards would
 * be a check that has already paid for the bytes it is rejecting, which is
 * exactly the cost the limit exists to avoid.
 */
export async function recordPart(
  app: FastifyInstance,
  session: SessionRow,
  key: string,
  partNo: number,
  body: Buffer,
): Promise<PartOutcome> {
  if (session.s3UploadId === null) throw new Error(`session ${session.id} has no multipart upload`);

  const [filed] = await app.db
    .select({ bytes: sql<string>`coalesce(sum(${uploadParts.bytes}), 0)` })
    .from(uploadParts)
    .where(and(eq(uploadParts.uploadId, session.id), ne(uploadParts.partNo, partNo)));
  const total = Number(filed?.bytes ?? 0) + body.length;
  if (total > session.bytesExpected) {
    return { status: 'too-large', total, expected: session.bytesExpected };
  }

  let uploaded;
  try {
    uploaded = await app.s3.send(
      new UploadPartCommand({
        Bucket: app.config.S3_BUCKET,
        Key: key,
        UploadId: session.s3UploadId,
        PartNumber: partNo,
        Body: body,
        ContentLength: body.length,
      }),
    );
  } catch (err) {
    // The 24-hour sweep can land between two parts of the same transfer, not
    // only between two sessions. Recognised here so the answer is a 409 the
    // camera re-inits on, rather than the 500 it would retry forever.
    if (!isMissingUpload(err)) throw err;
    await forgetSweptUpload(app, session.id);
    return { status: 'swept' };
  }
  if (uploaded.ETag === undefined) {
    throw new Error(`storage did not return an etag for part ${partNo} of ${key}`);
  }

  await app.db
    .insert(uploadParts)
    .values({ uploadId: session.id, partNo, bytes: body.length, etag: uploaded.ETag })
    .onConflictDoUpdate({
      target: [uploadParts.uploadId, uploadParts.partNo],
      set: { bytes: body.length, etag: uploaded.ETag },
    });

  const [counted] = await app.db
    .select({ total: sql<string>`count(*)` })
    .from(uploadParts)
    .where(eq(uploadParts.uploadId, session.id));
  await app.db
    .update(uploadSessions)
    .set({ partsReceived: Number(counted?.total ?? 0) })
    .where(eq(uploadSessions.id, session.id));

  return { status: 'recorded' };
}

/* --------------------------------------------------------------- finishing -- */

export type UploadOutcome =
  | { status: 'already-complete' }
  | { status: 'not-open'; was: string }
  | { status: 'no-parts' }
  | { status: 'checksum-mismatch' }
  | { status: 'size-mismatch'; stored: number; expected: number }
  | { status: 'content-type-mismatch'; declared: string; sniffed: string }
  | { status: 'swept' }
  | { status: 'ready'; sha256: string; bytes: number };

/**
 * The whole of `complete`, under a row lock (01 §7).
 *
 * ## Why a lock and not just a check
 *
 * The immutability guard reads the asset's stored digest and then a write
 * happens. Between those two moments a *concurrent* complete for the same asset
 * can flip it to `ready` with different content — so the guard would be
 * answering about a state that no longer exists by the time it matters. Reading
 * the asset `FOR UPDATE` and holding that lock across the guard **and** the
 * write closes the window: the second completer blocks until the first commits,
 * then re-reads and sees the digest it now has to match.
 *
 * The session is re-read inside the same transaction for the same reason — the
 * row the route resolved may already have been completed or failed by whoever
 * held the lock first, and the snapshot it is holding cannot know that.
 *
 * The lock is held across the S3 round trip (complete + re-read), which is the
 * deliberate cost: it is one asset row, contended only by another attempt to
 * write the same object, which is exactly what must not run in parallel.
 *
 * ## What it does
 *
 * Completes the multipart upload, then **streams the stored object back through
 * sha256** and compares it to what the device declared at init. Trusting the
 * bytes on the way in would miss a truncated part, a part that landed twice, and
 * storage that accepted something other than what was sent. D4 assets are
 * ≤ ~2 MB, so being exact costs milliseconds.
 *
 * On a mismatch the object is removed — it was never accepted, so this is
 * cleanup rather than an overwrite, and leaving unverified bytes under a key the
 * platform will later treat as authoritative is the failure mode worth avoiding
 * — the session is marked `failed`, and the asset is left `pending`: nothing
 * about it is known to be true, so the device starts again from init.
 */
export async function finishUpload(
  app: FastifyInstance,
  sessionId: string,
  assetId: string,
): Promise<UploadOutcome> {
  return app.db.transaction(async (tx) => {
    // `.for('update')` is load-bearing, not a hint. See the note above.
    const [asset] = await tx.select().from(assets).where(eq(assets.id, assetId)).for('update');
    if (asset === undefined) throw new Error(`asset ${assetId} vanished mid-upload`);

    const [session] = await tx
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, sessionId))
      .limit(1);
    if (session === undefined) throw new Error(`upload session ${sessionId} vanished`);

    if (session.status === 'complete') return { status: 'already-complete' };
    if (session.status !== 'open' || session.s3UploadId === null) {
      return { status: 'not-open', was: session.status };
    }

    // Guarded here, inside the lock, against the digest as it is *now*.
    assertNotOriginalOverwrite(
      asset.objectKey,
      asset.status === 'ready' ? asset.sha256 : null,
      session.sha256Expected,
    );

    const parts = await tx
      .select()
      .from(uploadParts)
      .where(eq(uploadParts.uploadId, session.id))
      .orderBy(asc(uploadParts.partNo));
    if (parts.length === 0) return { status: 'no-parts' };

    try {
      await app.s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: app.config.S3_BUCKET,
          Key: asset.objectKey,
          UploadId: session.s3UploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({ PartNumber: part.partNo, ETag: part.etag })),
          },
        }),
      );
    } catch (err) {
      // The last place the sweep can bite: every part was sent, the camera lost
      // the answer to `complete`, and by the time it asked again storage had
      // dropped the upload. Fail the session inside this transaction so the
      // next init opens a fresh multipart instead of resuming a ghost.
      if (!isMissingUpload(err)) throw err;
      await tx.delete(uploadParts).where(eq(uploadParts.uploadId, session.id));
      await tx
        .update(uploadSessions)
        .set({ status: 'failed', partsReceived: 0 })
        .where(eq(uploadSessions.id, session.id));
      return { status: 'swept' };
    }

    const stored = await digestStoredObject(app.s3, app.config.S3_BUCKET, asset.objectKey);
    if (stored.sha256 !== session.sha256Expected) {
      await refuseStoredObject(app, tx, session.id, asset.objectKey);
      return { status: 'checksum-mismatch' };
    }
    /**
     * The digest matched, so the *content* is what was promised — and the length
     * still has to be what was declared, because `bytes_expected` is what every
     * size limit upstream was enforced against. A device that declares two
     * megabytes and stores thirty has walked around the per-part ceiling by
     * lying at init, and this is where that becomes visible: after the object
     * exists, which is the only moment its true length is known.
     *
     * Same disposal as a checksum failure, deliberately: the object was never
     * accepted, so it is removed rather than left under a key the platform would
     * later treat as authoritative, and the asset stays `pending` so the device
     * starts again from init.
     */
    if (stored.bytes !== session.bytesExpected) {
      await refuseStoredObject(app, tx, session.id, asset.objectKey);
      return { status: 'size-mismatch', stored: stored.bytes, expected: session.bytesExpected };
    }

    /**
     * The digest proves the bytes are the ones the device meant to send. It
     * proves nothing about what they *are* — `mime` is a client string, and a
     * device token that declared `image/webp` over an HTML document would have
     * had it stored, then served inline from the origin that holds the guest's
     * cookies.
     *
     * Checked on `stored.head`, the first bytes of the object the digest loop
     * already read, so this adds no round trip to storage. Checked here rather
     * than at init because init has no bytes yet: the declaration and the
     * content only meet once the object exists.
     *
     * Disposed exactly like a checksum failure — the object was never accepted,
     * so it is removed and the asset stays `pending`. The device sees a 422,
     * which its contract classifies as "do not retry the same bytes", and that
     * is the right answer: re-sending the same file cannot make it a WebP.
     */
    const sniffed = contradictsDeclaredMime(asset.mime, stored.head);
    if (sniffed !== null) {
      await refuseStoredObject(app, tx, session.id, asset.objectKey);
      return { status: 'content-type-mismatch', declared: asset.mime, sniffed };
    }

    await tx
      .update(assets)
      .set({ status: 'ready', sha256: stored.sha256, bytes: stored.bytes })
      .where(eq(assets.id, asset.id));
    await tx
      .update(uploadSessions)
      .set({ status: 'complete' })
      .where(eq(uploadSessions.id, session.id));

    return { status: 'ready', sha256: stored.sha256, bytes: stored.bytes };
  });
}

/**
 * The disposal both `complete` failures share: forget the bytes, fail the
 * session, leave the asset `pending`.
 *
 * One function because the two verdicts differ only in what they discovered —
 * wrong content, wrong length — and not at all in what has to happen next. Two
 * copies would be two places for "and also mark the session failed" to be
 * forgotten, which is the difference between a device that retries and a session
 * that looks open forever.
 */
async function refuseStoredObject(
  app: FastifyInstance,
  tx: KinoTransaction,
  sessionId: string,
  key: string,
): Promise<void> {
  await forgetObject(app, key);
  await tx.update(uploadSessions).set({ status: 'failed' }).where(eq(uploadSessions.id, sessionId));
}

/** Removes an object that was never accepted. Best effort, and loudly logged. */
async function forgetObject(app: FastifyInstance, key: string): Promise<void> {
  try {
    await app.s3.send(new DeleteObjectCommand({ Bucket: app.config.S3_BUCKET, Key: key }));
  } catch (err) {
    app.log.warn({ err, key }, 'could not remove a rejected object');
  }
}
