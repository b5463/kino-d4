import type { FastifyPluginAsync } from 'fastify';
import { guestReadRateLimit } from '../plugins/rateLimits';
import { rollOf } from '../auth/plugins';
import { guestRollView } from '../rolls/rolls';
import { visibleCaptureCount } from '../uploads/uploads';

/**
 * The guest's view of a roll (03 §6, 03 §9).
 *
 * No authentication: the secret URL *is* the access control for an unlisted
 * roll, and `guestRollAccess` adds the PIN gate on top for a roll that has one.
 * A guest is anonymous (03 §18) and this route establishes no identity.
 *
 * A **closed** roll still answers 200 here. That is 03 §22 read literally —
 * closing stops uploads, it does not take the gallery away from the people who
 * were at the party. The upload side of that same rule is
 * `assertRollAcceptsUploads`, which Task 18 puts in front of the capture
 * routes.
 *
 * `X-Robots-Tag: noindex, nofollow` is not set here: it is set for the whole
 * `/api/rolls/` space by `robotsPlugin`, so a route added later cannot forget
 * it. See `rolls/robots.ts`.
 */
export const guestRollRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/rolls/:slug',
    { config: guestReadRateLimit, preHandler: app.guestRollAccess },
    async (request) => {
      const roll = rollOf(request);
      return guestRollView(roll, await visibleCaptureCount(app.db, roll.id));
    },
  );
};
