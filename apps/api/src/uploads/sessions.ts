import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { FastifyInstance } from 'fastify';
import { newId } from '../ids';
import { assets, uploadParts, uploadSessions } from '../db/schema';
import { digestStoredObject } from './uploads';

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
  /** The session already filed under this idempotency key, if there is one. */
  existing: SessionRow | undefined;
  /** The asset row as it stands — its `objectKey` is where a restart aborts. */
  asset: AssetRow;
  key: string;
  mime: string;
  bytes: number;
  sha256: string;
  idempotencyKey: string;
}

/**
 * Opens — or *re*-opens — the single session that `<captureUuid>:<role>:<frame>`
 * names, and returns its id.
 *
 * The idempotency key is unique, so a restart after a checksum failure has to
 * reuse the row rather than insert beside it. That is not a workaround: one row
 * per asset is what makes "which upload is this asset's?" answerable at all.
 */
export async function openSession(app: FastifyInstance, opening: SessionOpening): Promise<string> {
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
    await app.db.insert(uploadSessions).values({
      id,
      assetId: opening.asset.id,
      s3UploadId: created.UploadId,
      bytesExpected: opening.bytes,
      sha256Expected: opening.sha256,
      partsReceived: 0,
      status: 'open',
      idempotencyKey: opening.idempotencyKey,
    });
    return id;
  }

  if (existing.s3UploadId !== null) {
    // Best effort: an abandoned multipart upload costs storage, a failed abort
    // must not cost the device its retry.
    try {
      await app.s3.send(
        new AbortMultipartUploadCommand({
          Bucket: app.config.S3_BUCKET,
          Key: opening.asset.objectKey,
          UploadId: existing.s3UploadId,
        }),
      );
    } catch (err) {
      app.log.warn({ err, uploadId: existing.id }, 'could not abort the previous multipart upload');
    }
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
  return existing.id;
}

/* ------------------------------------------------------------------ parts -- */

/**
 * Sends one part to storage and records its etag.
 *
 * Re-sending a part is normal, not an error: S3 replaces the part and the
 * unique index on `(upload_id, part_no)` makes the bookkeeping row replace
 * itself in step, so a device that never saw an acknowledgement can simply send
 * it again.
 */
export async function recordPart(
  app: FastifyInstance,
  session: SessionRow,
  key: string,
  partNo: number,
  body: Buffer,
): Promise<void> {
  if (session.s3UploadId === null) throw new Error(`session ${session.id} has no multipart upload`);

  const uploaded = await app.s3.send(
    new UploadPartCommand({
      Bucket: app.config.S3_BUCKET,
      Key: key,
      UploadId: session.s3UploadId,
      PartNumber: partNo,
      Body: body,
      ContentLength: body.length,
    }),
  );
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
}

/* --------------------------------------------------------------- finishing -- */

export type UploadOutcome =
  | { status: 'no-parts' }
  | { status: 'checksum-mismatch' }
  | { status: 'ready'; sha256: string; bytes: number };

/**
 * Completes the multipart upload, then **streams the stored object back through
 * sha256** and compares it to what the device declared at init.
 *
 * Trusting the bytes on the way in would miss a truncated part, a part that
 * landed twice, and storage that accepted something other than what was sent.
 * D4 assets are ≤ ~2 MB, so being exact costs milliseconds.
 *
 * On a mismatch the object is removed — it was never accepted, so this is
 * cleanup rather than an overwrite, and leaving unverified bytes under a key the
 * platform will later treat as authoritative is the failure mode worth avoiding
 * — the session is marked `failed`, and the asset is left `pending`: nothing
 * about it is known to be true, so the device starts again from init.
 */
export async function finishUpload(
  app: FastifyInstance,
  session: SessionRow,
  asset: AssetRow,
): Promise<UploadOutcome> {
  if (session.s3UploadId === null) throw new Error(`session ${session.id} has no multipart upload`);

  const parts = await app.db
    .select()
    .from(uploadParts)
    .where(eq(uploadParts.uploadId, session.id))
    .orderBy(asc(uploadParts.partNo));
  if (parts.length === 0) return { status: 'no-parts' };

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

  const stored = await digestStoredObject(app.s3, app.config.S3_BUCKET, asset.objectKey);
  if (stored.sha256 !== session.sha256Expected) {
    await forgetObject(app, asset.objectKey);
    await app.db
      .update(uploadSessions)
      .set({ status: 'failed' })
      .where(eq(uploadSessions.id, session.id));
    return { status: 'checksum-mismatch' };
  }

  await app.db.transaction(async (tx) => {
    await tx
      .update(assets)
      .set({ status: 'ready', sha256: stored.sha256, bytes: stored.bytes })
      .where(eq(assets.id, asset.id));
    await tx
      .update(uploadSessions)
      .set({ status: 'complete' })
      .where(eq(uploadSessions.id, session.id));
  });

  return { status: 'ready', sha256: stored.sha256, bytes: stored.bytes };
}

/** Removes an object that was never accepted. Best effort, and loudly logged. */
async function forgetObject(app: FastifyInstance, key: string): Promise<void> {
  try {
    await app.s3.send(new DeleteObjectCommand({ Bucket: app.config.S3_BUCKET, Key: key }));
  } catch (err) {
    app.log.warn({ err, key }, 'could not remove a rejected object');
  }
}
