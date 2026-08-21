import { createHash } from 'node:crypto';
import type { ASSET_ROLES } from '@kino/schemas';
import { assets } from '../db/schema';
import { newId } from '../ids';
import { publishRollEvent } from '../events/publish';
import type { CaptureRow } from './capture';
import type { DerivedBody, JobCtx } from './types';

/**
 * The last three steps of every image job, as one function.
 *
 * Store the bytes, record the row, announce it. Each handler decides *what* to
 * produce; none of them decides how a derivative is recorded, because the three
 * steps have to happen in this order and a handler that got the order wrong
 * would fail in a way nothing tests:
 *
 * 1. **`putDerived` first.** The row is a promise that the object exists. A row
 *    written before the object is a 404 for every guest who reads the feed in
 *    between, and 05 §19's asset roles are what the PWA fetches by.
 * 2. **Then the row, as an upsert.** Jobs are retryable (03 §19), so a handler
 *    that already ran must land on the *same* row rather than a second one. The
 *    conflict target is the API's `assets_capture_role_frame` — `NULLS NOT
 *    DISTINCT`, which is what makes it cover derived roles at all, since their
 *    `frame_index` is NULL.
 * 3. **Then the event.** Announcing a derivative before it is queryable would
 *    send every subscriber to fetch a capture whose asset row is not there yet.
 *
 * A failure at any step leaves the earlier ones in place and the later ones
 * undone, which is exactly what a retry can repair: the object write and the
 * upsert are both idempotent, and a duplicate `processing.completed` costs a
 * guest one redundant fetch.
 *
 * This is also the only place a worker writes an `assets` row. `ctx.db` cannot
 * enforce that (see the note on `JobCtx`), so it is kept true by there being one
 * function to call: nothing here can address a row belonging to an
 * `original-frame`, because the role is supplied by the handler and the object
 * key is built by `putDerived`, which cannot name an original (01 §7).
 */
/**
 * The 05 §19 asset roles, from the package that defines them.
 *
 * Not `string`: the role is what the PWA fetches by, and a typo in one would
 * produce a stored object nothing ever asks for — an asset row that looks
 * perfectly healthy and is invisible. `@kino/schemas` already owns the list, so
 * a role this platform does not have now fails to compile.
 */
export type AssetRole = (typeof ASSET_ROLES)[number];

export interface DerivedArtifact {
  /** The file name inside the capture's `derived/` folder. */
  name: string;
  /** The 05 §19 asset role this artifact fills. */
  role: AssetRole;
  mime: string;
  body: DerivedBody;
  /** Pixel dimensions, or null for something that has none — a JSON document. */
  width?: number | null;
  height?: number | null;
  /**
   * The settings that decided these bytes (audit #59): render constants,
   * fps/loop/quality, encoder — whatever a retune would change. Recorded on
   * the asset row so re-rendering history stays visible in the data.
   */
  producer?: Record<string, unknown>;
}

export interface DerivedResult {
  key: string;
  sha256: string;
  bytes: number;
}

export async function publishDerived(
  ctx: JobCtx,
  capture: CaptureRow,
  artifact: DerivedArtifact,
): Promise<DerivedResult> {
  const body = Buffer.isBuffer(artifact.body) ? artifact.body : Buffer.from(artifact.body);
  const sha256 = createHash('sha256').update(body).digest('hex');

  const key = await ctx.putDerived(
    capture.rollId,
    capture.id,
    artifact.name,
    body,
    artifact.mime,
  );

  // Producer identity travels with the row (audit #59): the job's settings
  // snapshot, stamped with when these bytes were made. A retry or re-render
  // overwrites it — the row describes the bytes it currently promises.
  const producer = { renderer: 'kino-worker', role: artifact.role, ...(artifact.producer ?? {}) };
  const producedAt = new Date();

  await ctx.db
    .insert(assets)
    .values({
      id: newId('asset'),
      captureId: capture.id,
      role: artifact.role,
      // Derived roles have no frame index, and the unique index is NULLS NOT
      // DISTINCT precisely so that NULL still collides with NULL.
      frameIndex: null,
      mime: artifact.mime,
      width: artifact.width ?? null,
      height: artifact.height ?? null,
      bytes: body.length,
      sha256,
      objectKey: key,
      status: 'ready',
      producer,
      producedAt,
    })
    .onConflictDoUpdate({
      target: [assets.captureId, assets.role, assets.frameIndex],
      set: {
        mime: artifact.mime,
        width: artifact.width ?? null,
        height: artifact.height ?? null,
        bytes: body.length,
        sha256,
        objectKey: key,
        status: 'ready',
        producer,
        producedAt,
      },
    });

  await publishRollEvent(ctx.redis, capture.rollId, {
    type: 'processing.completed',
    captureId: capture.id,
    role: artifact.role,
  });

  return { key, sha256, bytes: body.length };
}
