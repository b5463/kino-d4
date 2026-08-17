import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { rollOf } from '../auth/plugins';
import {
  decodeCursor,
  parseLimit,
  readCaptureDetail,
  readCaptureFeedPage,
} from '../captures/feed';
import { fail } from './errors';

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

export const guestCaptureRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/rolls/:slug/captures', { preHandler: app.guestRollAccess }, async (request, reply) => {
    const query = queryOf(request);

    const limit = parseLimit(query['limit']);
    if (!limit.ok) return fail(reply, 400, limit.error.code, limit.error.message);

    const cursor = decodeCursor(query['cursor']);
    // 400, not 500: a mangled cursor is a client mistake, and letting the
    // driver reject the timestamp cast would make it look like a server fault.
    if (!cursor.ok) return fail(reply, 400, cursor.error.code, cursor.error.message);

    return readCaptureFeedPage(app.db, rollOf(request).id, limit.value, cursor.value);
  });

  app.get(
    '/api/rolls/:slug/captures/:captureId',
    { preHandler: app.guestRollAccess },
    async (request, reply) => {
      const detail = await readCaptureDetail(
        app.db,
        rollOf(request).id,
        paramOf(request, 'captureId'),
      );

      // Hidden, deleted, belonging to another roll, or never real — one answer
      // for all four. Anything else would make this route an oracle for
      // captures the caller has no business knowing about.
      if (detail === null) return fail(reply, 404, 'CAPTURE_NOT_FOUND', 'no such capture');
      return detail;
    },
  );
};
