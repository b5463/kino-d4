import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { ASSET_CACHE_CONTROL, deliverAsset, wantsDownload } from '../captures/delivery';
import { fail } from './errors';

/**
 * `GET /api/assets/:assetId/content` — the only way bytes leave the platform.
 *
 * It lives outside `/api/rolls/:slug` because an asset id is the only handle a
 * guest response ever hands out (05 §6): the feed names `assetId`, never an
 * object key and never a slug-scoped media path. The roll is therefore derived
 * from the asset and the guest gate applied to *that* — see `captures/delivery`,
 * which owns every check and reuses `guestMayReadRoll` rather than restating it.
 *
 * The route itself does three things and nothing else: read the parameters,
 * turn a refusal into a status code, and redirect.
 */

function paramOf(request: FastifyRequest, name: string): string {
  const params: unknown = request.params;
  if (typeof params !== 'object' || params === null) return '';
  const value = (params as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}

export const assetRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/assets/:assetId/content', async (request, reply) => {
    const delivered = await deliverAsset(
      { db: app.db, s3: app.s3, bucket: app.config.S3_BUCKET },
      request,
      paramOf(request, 'assetId'),
      wantsDownload(request.query),
    );

    if (!delivered.ok) return fail(reply, delivered.status, delivered.code, delivered.message);

    // `private` keeps it out of shared caches — the URL is signed for one
    // requester and one minute. See ASSET_CACHE_CONTROL for the max-age note.
    reply.header('cache-control', ASSET_CACHE_CONTROL);
    // 302, not 307: this is a plain GET redirect and every client follows it.
    return reply.redirect(delivered.url, 302);
  });
};
