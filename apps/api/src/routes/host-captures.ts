import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
// The moderation verbs use `captureOf`, not `rollOf`: the capture carries the id
// of the roll the token was actually compared against. The listing is the other
// way round — it is addressed by rollId and uses `requireHost`.
import { captureOf, rollOf } from '../auth/plugins';
import { decodeCursor, parseLimit, readHostCaptureFeedPage } from '../captures/feed';
import { fail } from './errors';
import {
  moderationView,
  setCaptureVisible,
  trashCapture,
  type ModerationResult,
  type ModerationView,
} from '../captures/moderation';
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

export const hostCaptureRoutes: FastifyPluginAsync = async (app) => {
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

      return readHostCaptureFeedPage(app.db, rollOf(request).id, limit.value, cursor.value);
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
