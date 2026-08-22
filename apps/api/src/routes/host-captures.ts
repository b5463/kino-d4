import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { WIGGLE_FPS_MAX, WIGGLE_FPS_MIN } from '@kino/media';
// The moderation verbs use `captureOf`, not `rollOf`: the capture carries the id
// of the roll the token was actually compared against. The listing is the other
// way round — it is addressed by rollId and uses `requireHost`.
import { captureOf, rollOf } from '../auth/plugins';
import { decodeCursor, parseLimit, readHostCaptureFeedPage } from '../captures/feed';
import { convergeWarning, fail, invalidBody } from './errors';
import {
  moderationView,
  setCaptureVisible,
  trashCapture,
  type ModerationResult,
  type ModerationView,
} from '../captures/moderation';
import { assets, captures } from '../db/schema';
import { enqueueProcessingJobs, type JobName, type QueuedJob } from '../uploads/uploads';
import {
  createProcessingQueue,
  resubmitJob,
  type ProcessingQueue,
} from '../queue/producer';
import { publishRollEvent, type RollEvent } from '../events/publish';

/**
 * Host moderation (03 §11): the host's own capture list, hide, unhide, delete.
 *
 * Three of the four routes are addressed by **captureId** — which is
 * why they sit here and not in `host-rolls.ts`. `requireHost` keys its token
 * comparison on a roll id path parameter and these have none, so they use
 * `requireHostCapture`, which derives the roll from the capture and compares
 * against *that* roll's token hash. A host token for roll A cannot moderate a
 * capture in roll B.
 *
 * The moderation writes themselves live in `captures/moderation.ts`: what "hidden"
 * and "deleted" mean has to have one definition, because `captures/feed.ts` reads
 * the same two columns to decide what a guest sees, and Task 25's purge job reads
 * the grace period from the same module.
 *
 * A **closed or archived** roll still moderates. Closing stops uploads (03 §22);
 * it emphatically does not stop a host taking down a photo somebody complained
 * about afterwards, which is when most complaints arrive.
 *
 * The fourth route is the listing, and it is not optional decoration: 03 §11
 * says a hidden capture is "retained for host", and every capture-listing route
 * before this one was guest-gated behind `visible = true AND deleted_at IS NULL`.
 * So a hidden capture's id existed nowhere on the API surface and `POST /unhide`
 * was unreachable in practice — the host could see `counts.hidden` go up and had
 * no way to name the capture it counted.
 *
 * It is a **dedicated route** rather than a `captures` array on the dashboard
 * response, for two reasons. A roll holds hundreds of captures, so an embedded
 * array would make every dashboard render read the whole roll and would have no
 * pagination story to grow into; and the dashboard is polled for its counts,
 * which is exactly the request that must stay cheap. The listing reuses the guest
 * feed's reader through an audience flag, so both share one keyset, one cursor
 * encoding and one asset join.
 *
 * 03 §29 — "do not overbuild moderation for V1" — is why there is no bulk
 * endpoint, no reason field, no reviewer queue and no restore route (Task 25 owns
 * restore). Three verbs, a list, and an audit row.
 */

function queryOf(request: FastifyRequest): Record<string, unknown> {
  const query: unknown = request.query;
  return typeof query === 'object' && query !== null ? (query as Record<string, unknown>) : {};
}

/**
 * The host's playback choice, in the KDP vocabulary (`WiggleLoop` /
 * `WiggleDirection`) — the same words the camera's own wiggle config uses, so
 * a Studio UI can pass the device value through unchanged. The worker maps
 * loop into `@kino/media`'s vocabulary at render time. `strict()`: a
 * misspelled field is a client bug, not a preference.
 */
const playbackBody = z
  .object({
    fps: z.number().int().min(WIGGLE_FPS_MIN).max(WIGGLE_FPS_MAX).optional(),
    loop: z.enum(['bounce', 'continuous', 'sweep']).optional(),
    direction: z.enum(['ltr', 'rtl']).optional(),
  })
  .strict();

export const hostCaptureRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Producer connection for the playback re-renders — lazy for the same
   * reason `device-captures.ts` is: most requests through this plugin never
   * queue anything, and building the server must not cost a Redis connection.
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
   * Re-submits newly queued render jobs, clearing each one's retained BullMQ
   * entry first (`resubmitJob`) — these jobs have run before by definition.
   * Failures are logged, not returned: the `queued` rows and the playback
   * write are already committed, and the same trade `device-captures.ts`
   * makes applies here.
   */
  async function resubmit(jobs: readonly QueuedJob[]): Promise<void> {
    if (jobs.length === 0) return;
    const target = processingQueue();
    for (const job of jobs) {
      try {
        await resubmitJob(target, job.name, job.payload);
      } catch (err) {
        app.log.error({ err, jobKey: job.payload.jobKey }, 'render job was not re-queued');
      }
    }
  }
  /**
   * The host's list: every capture of the roll, hidden and trashed included, each
   * carrying `visible`, `deletedAt` and `purgeAfter` so the two are
   * distinguishable from a visible one and from each other.
   *
   * Same `limit` and `cursor` contract as `GET /api/rolls/:slug/captures`, down to
   * the same 400 codes, because it is the same reader.
   */
  app.get(
    '/api/host/rolls/:rollId/captures',
    { preHandler: app.requireHost('rollId') },
    async (request, reply) => {
      const query = queryOf(request);

      const limit = parseLimit(query['limit']);
      if (!limit.ok) return fail(reply, 400, limit.error.code, limit.error.message);

      const cursor = decodeCursor(query['cursor']);
      // 400, not 500: a mangled cursor is a client mistake, and letting the driver
      // reject the timestamp cast would make it look like a server fault.
      if (!cursor.ok) return fail(reply, 400, cursor.error.code, cursor.error.message);

      return readHostCaptureFeedPage(
        app.db,
        rollOf(request).id,
        limit.value,
        cursor.value,
        convergeWarning(app),
      );
    },
  );

  app.post(
    '/api/host/captures/:captureId/hide',
    { preHandler: app.requireHostCapture('captureId') },
    async (request) =>
      announceModeration(
        app,
        await setCaptureVisible(app.db, captureOf(request), false),
        (captureId) => ({ type: 'capture.hidden', captureId }),
      ),
  );

  app.post(
    '/api/host/captures/:captureId/unhide',
    { preHandler: app.requireHostCapture('captureId') },
    async (request) =>
      announceModeration(
        app,
        await setCaptureVisible(app.db, captureOf(request), true),
        // `capture.updated`, not a `capture.unhidden` of its own: to a guest this
        // is a capture appearing, which is the same instruction as any other
        // change — re-fetch it. The event union carries ids only (05 §10), so a
        // fourth capture verb would buy the PWA nothing it does not already do.
        (captureId) => ({ type: 'capture.updated', captureId }),
      ),
  );

  app.delete(
    '/api/host/captures/:captureId',
    { preHandler: app.requireHostCapture('captureId') },
    async (request) =>
      announceModeration(app, await trashCapture(app.db, captureOf(request)), (captureId) => ({
        type: 'capture.deleted',
        captureId,
      })),
  );

  /**
   * The host's per-capture playback settings (audit #59): fps 5–15, loop and
   * direction in the KDP vocabulary. Stored on the capture — deliberately
   * outside `provenance`, which records what the device reported and never
   * changes — and REPLACED whole, so a PATCH that names only `fps` also
   * clears an earlier loop choice back to the default. Two consumers act on
   * it: the live player reads it off the capture view, and the wiggle renders
   * bake it into the WebP/MP4, which is why the write re-queues them.
   *
   * `render-wiggle-mp4` is re-queued only when that asset already exists: the
   * MP4 is produced on first request (see `wiggleMp4.ts`), and a playback
   * change must not conjure the platform's heaviest render for a capture
   * nobody downloaded.
   */
  app.patch(
    '/api/host/captures/:captureId/playback',
    { preHandler: app.requireHostCapture('captureId') },
    async (request, reply) => {
      const parsed = playbackBody.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      const capture = captureOf(request);

      const [updated] = await app.db
        .update(captures)
        .set({ playback: parsed.data })
        .where(eq(captures.id, capture.id))
        .returning({ mode: captures.mode, playback: captures.playback });
      if (updated === undefined) {
        // Purged between the preHandler and the write — the trash race.
        return fail(reply, 404, 'CAPTURE_NOT_FOUND', 'capture does not exist');
      }

      if (updated.mode === 'wiggle') {
        const jobs: JobName[] = ['render-wiggle-webp'];
        const [mp4] = await app.db
          .select({ id: assets.id })
          .from(assets)
          .where(
            and(
              eq(assets.captureId, capture.id),
              eq(assets.role, 'wiggle-mp4'),
              eq(assets.status, 'ready'),
            ),
          )
          .limit(1);
        if (mp4 !== undefined) jobs.push('render-wiggle-mp4');

        // Rows first, queue second, same as capture-complete. A job that is
        // already `queued` is skipped here and picks the new settings up when
        // it runs — the row is read at render time.
        await resubmit(await enqueueProcessingJobs(app.db, capture.id, jobs));
      }

      // Guests re-fetch the capture and its playback with it. Failure is
      // logged, not returned — the row is committed (same call as `announce`
      // in device-captures.ts).
      try {
        await publishRollEvent(app.redis, capture.rollId, {
          type: 'capture.updated',
          captureId: capture.id,
        });
      } catch (err) {
        app.log.warn(
          { err, rollId: capture.rollId, captureId: capture.id },
          'playback event was not published',
        );
      }

      return reply.send({ captureId: capture.id, playback: updated.playback ?? null });
    },
  );
};

/**
 * Publishes the event a moderation write earned, and answers with the new state.
 *
 * Nothing is announced when nothing changed. Hiding an already-hidden capture is
 * an ordinary retry, and an event for it would tell every connected guest to
 * re-fetch a capture that did not move.
 *
 * A failed publish does **not** fail the request. The row is already committed by
 * the time this runs, so the capture is already out of the feed for anyone who
 * loads it — the cost of a dropped event is that guests already on the page keep
 * a stale tile until their next fetch. Refusing the host's moderation because
 * Redis blinked would be the worse trade, and it would leave the host unable to
 * take a photo down at all. Same call as `announce` in `device-captures.ts`.
 */
async function announceModeration(
  app: FastifyInstance,
  result: ModerationResult,
  event: (captureId: string) => RollEvent,
): Promise<ModerationView> {
  if (result.changed) {
    try {
      await publishRollEvent(app.redis, result.capture.rollId, event(result.capture.id));
    } catch (err) {
      app.log.warn(
        { err, rollId: result.capture.rollId, captureId: result.capture.id },
        'moderation event was not published',
      );
    }
  }
  return moderationView(result.capture);
}
