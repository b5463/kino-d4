import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { guestReadRateLimit } from '../plugins/rateLimits';
import { rollOf } from '../auth/plugins';
import {
  decodeCursor,
  parseLimit,
  readCaptureDetail,
  readCaptureFeedPage,
} from '../captures/feed';
import { createProcessingQueue, submitJob, type ProcessingQueue } from '../queue/producer';
import { enqueueProcessingJobs, type JobName } from '../uploads/uploads';
import { convergeWarning, fail } from './errors';
import {
  ensureGuestId,
  guestIdOf,
  readReactionState,
  toggleReaction,
} from '../captures/reactions';

/**
 * The guest's gallery (03 §6, 06 §11).
 *
 * Both routes sit behind `guestRollAccess`, so the secret slug plus the PIN
 * cookie decide access exactly as they do for the roll itself, and
 * `robotsPlugin` puts `X-Robots-Tag` on everything under `/api/rolls/`
 * including the 401 and the 404.
 *
 * A **closed** roll still answers here. Closing stops uploads (03 §22); it does
 * not take the gallery away from the people who were at the party.
 */

function queryOf(request: FastifyRequest): Record<string, unknown> {
  const query: unknown = request.query;
  return typeof query === 'object' && query !== null ? (query as Record<string, unknown>) : {};
}

function paramOf(request: FastifyRequest, name: string): string {
  const params: unknown = request.params;
  if (typeof params !== 'object' || params === null) return '';
  const value = (params as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}

/**
 * Which lazily rendered role maps to which job. One job produces all three
 * social crops, so any of those roles queues the same unit of work — and the
 * jobKey dedupe collapses repeat requests into one render.
 */
const RENDERABLE_ROLES: Readonly<Record<string, JobName>> = {
  'wiggle-mp4': 'render-wiggle-mp4',
  'social-9x16': 'render-social-formats',
  'social-4x5': 'render-social-formats',
  'social-1x1': 'render-social-formats',
};

function requestedRole(request: FastifyRequest): string {
  const body: unknown = request.body;
  if (typeof body !== 'object' || body === null) return '';
  const role = (body as Record<string, unknown>)['role'];
  return typeof role === 'string' ? role : '';
}

export const guestCaptureRoutes: FastifyPluginAsync = async (app) => {
  // The producer connection, lazy for the same reason `device-captures.ts`
  // keeps its own lazy: most guest traffic never queues anything, and building
  // the server must not cost a Redis connection.
  let queue: ProcessingQueue | null = null;
  const processingQueue = (): ProcessingQueue => {
    queue ??= createProcessingQueue(app.config);
    return queue;
  };
  app.addHook('onClose', async () => {
    if (queue !== null) await queue.close();
  });

  app.get('/api/rolls/:slug/captures', { config: guestReadRateLimit, preHandler: app.guestRollAccess }, async (request, reply) => {
    const query = queryOf(request);

    const limit = parseLimit(query['limit']);
    if (!limit.ok) return fail(reply, 400, limit.error.code, limit.error.message);

    const cursor = decodeCursor(query['cursor']);
    // 400, not 500: a mangled cursor is a client mistake, and letting the
    // driver reject the timestamp cast would make it look like a server fault.
    if (!cursor.ok) return fail(reply, 400, cursor.error.code, cursor.error.message);

    return readCaptureFeedPage(
      app.db,
      rollOf(request).id,
      limit.value,
      cursor.value,
      convergeWarning(app),
    );
  });

  app.get(
    '/api/rolls/:slug/captures/:captureId',
    // Metered like the rest of the guest surface. It was the one read on it
    // without a bucket, and it is the most expensive of them per call: a detail
    // read converges the capture's status and counts its reactions.
    { config: guestReadRateLimit, preHandler: app.guestRollAccess },
    async (request, reply) => {
      const detail = await readCaptureDetail(
        app.db,
        rollOf(request).id,
        paramOf(request, 'captureId'),
        convergeWarning(app),
      );

      // Hidden, deleted, belonging to another roll, or never real — one answer
      // for all four. Anything else would make this route an oracle for
      // captures the caller has no business knowing about.
      if (detail === null) return fail(reply, 404, 'CAPTURE_NOT_FOUND', 'no such capture');
      return {
        ...detail,
        ...(await readReactionState(app.db, detail.captureId, guestIdOf(request))),
      };
    },
  );

  app.post(
    '/api/rolls/:slug/captures/:captureId/react',
    { config: guestReadRateLimit, preHandler: app.guestRollAccess },
    async (request, reply) => {
      const roll = rollOf(request);
      if (!roll.reactionsEnabled) {
        return fail(reply, 409, 'REACTIONS_DISABLED', 'reactions are disabled for this Roll');
      }

      const state = await toggleReaction(
        app.db,
        roll.id,
        paramOf(request, 'captureId'),
        () => ensureGuestId(request, reply),
      );
      if (state === null) return fail(reply, 404, 'CAPTURE_NOT_FOUND', 'no such capture');
      return state;
    },
  );

  /**
   * Asks the platform to produce a lazily rendered derivative (03 §19's
   * on-first-request jobs). 202: the render is queued, and its completion
   * reaches the guest over the roll's SSE stream as `processing.completed`,
   * the same path every other derivative announces on.
   *
   * Behind the downloads switch: these artifacts exist only to be saved, so a
   * roll whose host turned downloads off refuses to render them at all —
   * the same rule `captures/delivery.ts` applies at delivery time.
   */
  app.post(
    '/api/rolls/:slug/captures/:captureId/renders',
    { config: guestReadRateLimit, preHandler: app.guestRollAccess },
    async (request, reply) => {
      const roll = rollOf(request);
      if (!roll.downloadsEnabled) {
        return fail(reply, 403, 'DOWNLOADS_DISABLED', 'the host has turned downloads off for this roll');
      }

      const role = requestedRole(request);
      const job = RENDERABLE_ROLES[role];
      if (job === undefined) {
        return fail(reply, 400, 'ROLE_NOT_RENDERABLE', 'role must be one of wiggle-mp4, social-9x16, social-4x5, social-1x1');
      }

      const detail = await readCaptureDetail(
        app.db,
        roll.id,
        paramOf(request, 'captureId'),
        convergeWarning(app),
      );
      if (detail === null) return fail(reply, 404, 'CAPTURE_NOT_FOUND', 'no such capture');
      // A wiggle MP4 of a single or quad capture cannot exist; refusing here
      // beats queueing a job that can only fail.
      if (job === 'render-wiggle-mp4' && detail.mode !== 'wiggle') {
        return fail(reply, 409, 'NOT_A_WIGGLE', 'this capture has no wiggle to render');
      }

      const queued = await enqueueProcessingJobs(app.db, detail.captureId, [job]);
      // Failures are logged, not returned — the `queued` row is committed, and
      // the same trade `device-captures.ts` makes at capture-complete holds.
      for (const item of queued) {
        try {
          await submitJob(processingQueue(), item.name, item.payload);
        } catch (err) {
          app.log.error({ err, jobKey: item.payload.jobKey }, 'render job was not queued');
        }
      }

      return reply.code(202).send({ role, job });
    },
  );
};
