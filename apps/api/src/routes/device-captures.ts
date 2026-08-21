import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ASSET_ROLES, capture as captureSchema, parseVersioned } from '@kino/schemas';
import { deviceOf, publicRollColumns, rollOf, type PublicRollRow } from '../auth/plugins';
import { assertRollAcceptsUploads } from '../rolls/rolls';
import { assertNotOriginalOverwrite } from '../uploads/objectKeys';
import {
  MAX_PART_NUMBER,
  PART_SIZE,
  assetObjectKey,
  enqueueProcessingJobs,
  nextCaptureStatus,
  plannedJobs,
  convergeCaptureStatus,
  recomputeCaptureStatus,
  sessionKeyFor,
  type QueuedJob,
} from '../uploads/uploads';
import {
  createProcessingQueue,
  submitJob,
  type ProcessingQueue,
} from '../queue/producer';
import { finishUpload, openSession, recordPart, upsertAsset } from '../uploads/sessions';
import { publishRollEvent, type RollEvent } from '../events/publish';
import { newId } from '../ids';
import { assets, captures, rollDevices, rolls, uploadSessions } from '../db/schema';
import { convergeWarning, fail, invalidBody } from './errors';
import { deviceUploadRateLimit } from '../plugins/rateLimits';

/**
 * The upload API (03 §16) — everything a camera does after the shutter.
 *
 * Six routes, one job: get a capture and its bytes onto the server exactly once,
 * over a network that will drop halfway through. Three mechanisms carry that:
 *
 * - **Idempotency by construction.** The camera names the capture
 *   (`captureUuid`) and each asset (`<captureUuid>:<role>:<frameIndex>`), and
 *   both names are unique *indexes*, not pre-check `SELECT`s. A retry that races
 *   its own original loses at the index and reads back the winner's row; a
 *   pre-check would let both through (05 §9).
 * - **Verification by re-reading.** `complete` streams the finished object back
 *   out of storage through sha256 and compares it to what the device promised.
 *   Trusting the bytes that went in would miss a truncated part, a part that
 *   landed twice, and storage that quietly accepted something else.
 * - **Originals are immutable** (01 §7). `assertNotOriginalOverwrite` is
 *   consulted at init *and* on the write path itself.
 *
 * ## Why every session is an S3 multipart upload
 *
 * D4 assets are ≤ ~2 MB, comfortably under the 5 MiB part size, so in practice
 * every upload is a single part and a plain `PutObject` would do. It is still
 * multipart, always, and the reason is the case that actually matters: resuming.
 * A `PutObject` fast path would need somewhere to hold part 1 until it learned
 * whether a part 2 was coming, which means a second code path that fails
 * differently from the one used on a bad connection — the exact path that must
 * not be the less-tested one. S3 permits a single-part multipart upload (the
 * 5 MiB floor exempts the last part), Task 15's schema already carries
 * `upload_sessions.s3_upload_id` and `upload_parts.etag` for it, and the wire
 * contract is identical either way: the device never learns which it got.
 *
 * The storage choreography itself lives in `src/uploads/sessions.ts`; this file
 * parses, authorises and answers.
 */

const SHA256 = /^[0-9a-f]{64}$/;

const initBody = z
  .object({
    role: z.enum(ASSET_ROLES),
    /** Present only for `original-frame`; `assetObjectKey` enforces that. */
    frameIndex: z.number().int().positive().optional(),
    mime: z.string().min(1).max(120),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(SHA256),
  })
  .strict();

type CaptureRow = typeof captures.$inferSelect;

interface CaptureContext {
  capture: CaptureRow;
  roll: PublicRollRow;
}

interface UploadContext extends CaptureContext {
  session: typeof uploadSessions.$inferSelect;
  asset: typeof assets.$inferSelect;
}

function pathParam(request: FastifyRequest, name: string): string | null {
  const params: unknown = request.params;
  if (typeof params !== 'object' || params === null) return null;
  const value = (params as Record<string, unknown>)[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * "Created or joined", the same `OR` `requireDeviceRoll` enforces (03 §17,
 * 07 §25) — repeated here rather than reused because these routes are addressed
 * by *capture* and *upload* id, so the roll is something they discover rather
 * than something the path names.
 */
function deviceMayOperate(roll: PublicRollRow, joinedBy: string | null, deviceId: string): boolean {
  return roll.createdByDeviceId === deviceId || joinedBy !== null;
}

/**
 * Resolves `:captureId` for the authenticated device, or answers the request
 * and returns null. Handlers read as `const ctx = await requireCapture(...); if
 * (ctx === null) return reply;`.
 */
async function requireCapture(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<CaptureContext | null> {
  const captureId = pathParam(request, 'captureId');
  if (captureId === null) {
    void fail(reply, 400, 'CAPTURE_ID_REQUIRED', 'missing :captureId path parameter');
    return null;
  }

  const deviceId = deviceOf(request).id;
  const [row] = await app.db
    .select({ capture: captures, roll: publicRollColumns, joinedBy: rollDevices.deviceId })
    .from(captures)
    .innerJoin(rolls, eq(rolls.id, captures.rollId))
    .leftJoin(
      rollDevices,
      and(eq(rollDevices.rollId, captures.rollId), eq(rollDevices.deviceId, deviceId)),
    )
    .where(eq(captures.id, captureId))
    .limit(1);

  if (row === undefined) {
    void fail(reply, 404, 'CAPTURE_NOT_FOUND', 'no such capture');
    return null;
  }
  if (!deviceMayOperate(row.roll, row.joinedBy, deviceId)) {
    void fail(reply, 403, 'DEVICE_NOT_IN_ROLL', 'this device is not part of that roll');
    return null;
  }
  return { capture: row.capture, roll: row.roll };
}

/** The same, one link further down: `:uploadId` → session → asset → capture → roll. */
async function requireUpload(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<UploadContext | null> {
  const uploadId = pathParam(request, 'uploadId');
  if (uploadId === null) {
    void fail(reply, 400, 'UPLOAD_ID_REQUIRED', 'missing :uploadId path parameter');
    return null;
  }

  const deviceId = deviceOf(request).id;
  const [row] = await app.db
    .select({
      session: uploadSessions,
      asset: assets,
      capture: captures,
      roll: publicRollColumns,
      joinedBy: rollDevices.deviceId,
    })
    .from(uploadSessions)
    .innerJoin(assets, eq(assets.id, uploadSessions.assetId))
    .innerJoin(captures, eq(captures.id, assets.captureId))
    .innerJoin(rolls, eq(rolls.id, captures.rollId))
    .leftJoin(
      rollDevices,
      and(eq(rollDevices.rollId, captures.rollId), eq(rollDevices.deviceId, deviceId)),
    )
    .where(eq(uploadSessions.id, uploadId))
    .limit(1);

  if (row === undefined) {
    void fail(reply, 404, 'UPLOAD_NOT_FOUND', 'no such upload session');
    return null;
  }
  if (!deviceMayOperate(row.roll, row.joinedBy, deviceId)) {
    void fail(reply, 403, 'DEVICE_NOT_IN_ROLL', 'this device is not part of that roll');
    return null;
  }
  return { session: row.session, asset: row.asset, capture: row.capture, roll: row.roll };
}

/**
 * Publishes a roll event without letting the event bus decide whether the
 * request succeeded.
 *
 * The row is already committed by the time this runs, so a failed publish costs
 * a guest one push — and the 05 §10 flow has the PWA re-fetching the capture
 * anyway, so a missed notification is a delay, not data loss. Failing the whole
 * upload because Redis blinked would be the worse trade by a wide margin.
 */
async function announce(app: FastifyInstance, rollId: string, event: RollEvent): Promise<void> {
  try {
    await publishRollEvent(app.redis, rollId, event);
  } catch (err) {
    app.log.warn({ err, rollId, event: event.type }, 'roll event was not published');
  }
}

/** A capture's asset rows, for the state machine and for the status route. */
async function assetStates(
  app: FastifyInstance,
  captureId: string,
): Promise<{ role: string; frameIndex: number | null; status: string }[]> {
  return app.db
    .select({ role: assets.role, frameIndex: assets.frameIndex, status: assets.status })
    .from(assets)
    .where(eq(assets.captureId, captureId))
    .orderBy(asc(assets.role), asc(assets.frameIndex));
}

export const deviceCaptureRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The producer connection, opened on the first capture-complete and closed
   * with the server.
   *
   * Lazy on purpose: most of this API never queues anything, and a `new Queue`
   * opens a Redis connection the moment it is constructed. Building the server
   * — which every test suite does — should not cost a connection to a service
   * that suite may not even need.
   */
  let queue: ProcessingQueue | null = null;
  const processingQueue = (): ProcessingQueue => {
    queue ??= createProcessingQueue(app.config);
    return queue;
  };
  app.addHook('onClose', async () => {
    if (queue !== null) await queue.close();
  });

  /**
   * Hands newly queued work to the worker pool.
   *
   * Failures are logged, not returned, for the same reason `announce` swallows
   * a dead event bus: the `queued` rows are already committed, and a 500 here
   * would tell a camera its capture did not complete when it did. What it costs
   * is real and worth naming — a job whose row exists but whose BullMQ entry was
   * never added will not be retried by a later complete, because the row is what
   * makes the second call a no-op. Reconciling that (re-submitting `queued` rows
   * with no live job) needs a sweeper, and a sweeper is not this task.
   */
  async function submit(jobs: readonly QueuedJob[]): Promise<void> {
    if (jobs.length === 0) return;
    const target = processingQueue();
    for (const job of jobs) {
      try {
        await submitJob(target, job.name, job.payload);
      } catch (err) {
        app.log.error({ err, jobKey: job.payload.jobKey }, 'processing job was not queued');
      }
    }
  }

  /**
   * Part bodies are raw bytes, not JSON.
   *
   * Buffered rather than piped straight into S3: `UploadPart` needs a known
   * `ContentLength`, and the size cap has to be decided *before* the bytes reach
   * storage. `PART_SIZE` bounds the allocation, and Fastify rejects anything
   * larger with a 413 before the parser ever runs.
   *
   * Registered inside this plugin, so it applies to these routes and not to the
   * JSON ones elsewhere in the server.
   */
  app.addContentTypeParser<Buffer>(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: PART_SIZE },
    (_request, body, done) => {
      done(null, body);
    },
  );

  /* --------------------------------------------------------------- capture -- */

  /**
   * The capture document is *device-authored* (05 §19), so it is parsed through
   * the versioned registry rather than an ad-hoc zod object — a camera on older
   * firmware gets migrated, one from the future gets a clear refusal.
   *
   * The path and the token win over the document: `rollId`, `deviceId` and
   * `status` are taken from the URL, the credential and the server's own state
   * machine respectively. A document field is a claim, not a capability, and one
   * rule with no exceptions is easier to keep than three that almost agree.
   */
  app.post(
    '/api/device/rolls/:rollId/captures',
    {
      config: deviceUploadRateLimit,
      preHandler: [app.requireDevice, app.requireDeviceRoll('rollId')],
    },
    async (request, reply) => {
      const roll = rollOf(request);
      assertRollAcceptsUploads(roll);

      let doc;
      try {
        doc = parseVersioned(captureSchema, request.body);
      } catch (err) {
        return fail(
          reply,
          400,
          'INVALID_CAPTURE',
          `not a usable kino.capture document: ${err instanceof Error ? err.message : 'unparseable'}`,
        );
      }

      const capturedAt = new Date(doc.capturedAt);
      if (Number.isNaN(capturedAt.getTime())) {
        return fail(reply, 400, 'INVALID_CAPTURE', 'capturedAt is not a date');
      }

      // `onConflictDoNothing` + read-back, never a pre-check SELECT: two
      // concurrent retries of the same capture both reach the index, the loser's
      // INSERT blocks until the winner commits and then returns no row, and the
      // read-back sees the committed one. That is the whole race (05 §9).
      const [inserted] = await app.db
        .insert(captures)
        .values({
          id: newId('cap'),
          captureUuid: doc.captureUuid,
          rollId: roll.id,
          deviceId: deviceOf(request).id,
          mode: doc.mode,
          look: doc.look ?? null,
          capturedAt,
          frameCount: doc.frameCount,
          resolution: doc.resolution,
          timing: doc.timing ?? null,
          status: nextCaptureStatus([], false),
          visible: doc.visible,
        })
        .onConflictDoNothing()
        .returning({ id: captures.id });

      if (inserted !== undefined) {
        await announce(app, roll.id, { type: 'capture.created', captureId: inserted.id });
        return reply.code(201).send({ captureId: inserted.id });
      }

      const [existing] = await app.db
        .select({ id: captures.id })
        .from(captures)
        .where(and(eq(captures.rollId, roll.id), eq(captures.captureUuid, doc.captureUuid)))
        .limit(1);
      if (existing === undefined) {
        // The insert conflicted with something that is not the idempotency
        // anchor. Guessing which would be worse than saying so.
        throw new Error(`capture ${doc.captureUuid} conflicted but cannot be read back`);
      }

      // 200, not 201: nothing was created. Same id, so a retry converges.
      return reply.code(200).send({ captureId: existing.id });
    },
  );

  app.post(
    '/api/device/captures/:captureId/complete',
    { config: deviceUploadRateLimit, preHandler: app.requireDevice },
    async (request, reply) => {
      const ctx = await requireCapture(app, request, reply);
      if (ctx === null) return reply;

      const states = await assetStates(app, ctx.capture.id);
      const uploaded = new Set(
        states.filter((asset) => asset.status === 'ready').map((asset) => asset.role),
      );

      // Rows first, queue second. The row is what makes a retried complete a
      // no-op, so it has to be committed before anything can act on the job —
      // and only the rows this call actually inserted are submitted, because
      // the others are already somewhere in the queue.
      const queued = await enqueueProcessingJobs(
        app.db,
        ctx.capture.id,
        plannedJobs(ctx.capture.mode, uploaded),
      );
      await submit(queued);

      const status = await recomputeCaptureStatus(app.db, ctx.capture.id);

      await announce(app, ctx.roll.id, { type: 'capture.updated', captureId: ctx.capture.id });
      return reply.send({ captureId: ctx.capture.id, status });
    },
  );

  app.get(
    '/api/device/captures/:captureId/status',
    { preHandler: app.requireDevice },
    async (request, reply) => {
      const ctx = await requireCapture(app, request, reply);
      if (ctx === null) return reply;

      // The stored column is a cache that nothing refreshes once the derivative
      // jobs start running, so this read refreshes it. Settled captures are
      // reported straight from the row and cost nothing extra.
      const [status, states] = await Promise.all([
        convergeCaptureStatus(app.db, ctx.capture.id, ctx.capture.status, convergeWarning(app)),
        assetStates(app, ctx.capture.id),
      ]);
      return reply.send({ status, assets: states });
    },
  );

  /* ---------------------------------------------------------------- upload -- */

  app.post(
    '/api/device/captures/:captureId/assets/init',
    { config: deviceUploadRateLimit, preHandler: app.requireDevice },
    async (request, reply) => {
      const ctx = await requireCapture(app, request, reply);
      if (ctx === null) return reply;
      // The gate lives on the two *entry* points (capture create and asset
      // init). A session opened while the roll was live is allowed to finish:
      // 03 §22 stops new uploads, and stranding bytes that are already half
      // transferred is not what closing a roll is for.
      assertRollAcceptsUploads(ctx.roll);

      const parsed = initBody.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      const { role, mime, bytes, sha256 } = parsed.data;
      const frameIndex = parsed.data.frameIndex ?? null;

      const key = assetObjectKey(ctx.roll.id, ctx.capture.id, role, frameIndex, mime);
      const asset = await upsertAsset(app, ctx.capture.id, { role, frameIndex, mime, bytes, key });

      // Guard first, before anything decides this is a replay: an original whose
      // content would change must be refused, not quietly reported complete.
      assertNotOriginalOverwrite(key, asset.status === 'ready' ? asset.sha256 : null, sha256);

      // Scoped by capture id, because `captureUuid` is only unique *per roll*
      // (`captures_roll_uuid`) while `upload_sessions.idempotency_key` is unique
      // across the table. Both halves matter: the stored key carries the capture
      // id so two rolls sharing a uuid get two rows, and the lookup is pinned to
      // this asset so it can never adopt somebody else's session.
      const sessionKey = sessionKeyFor(ctx.capture.id, ctx.capture.captureUuid, role, frameIndex);
      const [existing] = await app.db
        .select()
        .from(uploadSessions)
        .where(
          and(eq(uploadSessions.idempotencyKey, sessionKey), eq(uploadSessions.assetId, asset.id)),
        )
        .limit(1);

      if (existing !== undefined && asset.status === 'ready' && asset.sha256 === sha256) {
        // Already on the server. The device may have missed the last 200.
        return reply.send({ uploadId: existing.id, partSize: PART_SIZE, alreadyComplete: true });
      }

      if (
        existing !== undefined &&
        existing.status === 'open' &&
        existing.s3UploadId !== null &&
        existing.sha256Expected === sha256 &&
        asset.objectKey === key
      ) {
        // Resume: same bytes, same destination, parts already sent still count.
        return reply.send({ uploadId: existing.id, partSize: PART_SIZE, alreadyComplete: false });
      }

      const opened = await openSession(app, {
        existing,
        asset,
        key,
        mime,
        bytes,
        sha256,
        sessionKey,
      });
      if (opened.status === 'conflict') {
        // Another `init` for this same asset won the race. Retrying finds its
        // session and resumes it — adopting whatever row exists instead would be
        // how one upload silently resets another.
        return fail(
          reply,
          409,
          'UPLOAD_IN_PROGRESS',
          'another init for this asset is in flight; retry',
        );
      }

      // The asset row is reset to `pending` and re-pointed: a restart may carry
      // a different mime, and therefore a different key.
      await app.db
        .update(assets)
        .set({ status: 'pending', mime, bytes, sha256: null, objectKey: key })
        .where(eq(assets.id, asset.id));

      await recomputeCaptureStatus(app.db, ctx.capture.id);

      return reply.send({ uploadId: opened.uploadId, partSize: PART_SIZE, alreadyComplete: false });
    },
  );

  app.put(
    '/api/device/uploads/:uploadId/parts/:partNo',
    { config: deviceUploadRateLimit, preHandler: app.requireDevice, bodyLimit: PART_SIZE },
    async (request, reply) => {
      const ctx = await requireUpload(app, request, reply);
      if (ctx === null) return reply;

      const { session, asset } = ctx;
      if (session.status !== 'open' || session.s3UploadId === null) {
        return fail(reply, 409, 'UPLOAD_NOT_OPEN', `this upload is ${session.status}; init again`);
      }

      const raw = pathParam(request, 'partNo');
      const partNo = raw === null ? Number.NaN : Number(raw);
      if (!Number.isInteger(partNo) || partNo < 1 || partNo > MAX_PART_NUMBER) {
        return fail(reply, 400, 'INVALID_PART_NUMBER', `part number must be 1..${MAX_PART_NUMBER}`);
      }

      const body: unknown = request.body;
      if (!Buffer.isBuffer(body)) {
        return fail(reply, 415, 'EXPECTED_OCTET_STREAM', 'send the part as application/octet-stream');
      }
      if (body.length === 0) return fail(reply, 400, 'EMPTY_PART', 'a part must carry bytes');
      // Belt to Fastify's braces: `bodyLimit` already rejects this, and the check
      // stays honest if the two numbers ever drift apart.
      if (body.length > PART_SIZE) {
        return fail(reply, 413, 'PART_TOO_LARGE', `a part may not exceed ${PART_SIZE} bytes`);
      }

      await recordPart(app, session, asset.objectKey, partNo, body);
      return reply.send({ received: true, partNo });
    },
  );

  app.post(
    '/api/device/uploads/:uploadId/complete',
    { config: deviceUploadRateLimit, preHandler: app.requireDevice },
    async (request, reply) => {
      const ctx = await requireUpload(app, request, reply);
      if (ctx === null) return reply;
      const { session, asset, capture, roll } = ctx;

      /**
       * Everything that decides — the session's state, the immutability guard
       * and the write — happens inside `finishUpload`, under a `FOR UPDATE` lock
       * on the asset row. The rows resolved above are a *snapshot*: a concurrent
       * complete can flip the asset to `ready` with different content between
       * this handler reading them and the bytes landing, so a guard evaluated
       * out here would be answering about a state that no longer exists (01 §7).
       */
      const outcome = await finishUpload(app, session.id, asset.id);

      if (outcome.status === 'already-complete') {
        // The device missed the answer, or lost the race to a concurrent
        // complete. Either way the asset is on the server.
        return reply.send({ assetId: asset.id, status: 'ready' });
      }
      if (outcome.status === 'not-open') {
        return fail(reply, 409, 'UPLOAD_NOT_OPEN', `this upload is ${outcome.was}; init again`);
      }
      if (outcome.status === 'no-parts') {
        return fail(reply, 400, 'NO_PARTS', 'send at least one part before completing');
      }
      if (outcome.status === 'checksum-mismatch') {
        return fail(
          reply,
          422,
          'CHECKSUM_MISMATCH',
          'the stored object does not match the declared sha256; start again from init',
        );
      }

      await recomputeCaptureStatus(app.db, capture.id);
      await announce(app, roll.id, { type: 'capture.updated', captureId: capture.id });

      return reply.send({ assetId: asset.id, status: 'ready' });
    },
  );
};
