import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { ASSET_CACHE_CONTROL, deliverAsset, wantsDownload } from '../captures/delivery';
import { fail } from './errors';
import { assetContentRateLimit } from '../plugins/rateLimits';

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
  // Media has its own bucket, an order of magnitude above the JSON reads: one
  // gallery screen is a handful of API calls and a tile per capture, so a shared
  // limit let image traffic ration the reads that decide what to draw. See
  // `RATE_LIMITS.assetContent`.
  app.get('/api/assets/:assetId/content', { config: assetContentRateLimit }, async (request, reply) => {
    const delivered = await deliverAsset(
      {
        db: app.db,
        s3: app.s3,
        bucket: app.config.S3_BUCKET,
        mode: app.config.OBJECT_DELIVERY,
      },
      request,
      paramOf(request, 'assetId'),
      wantsDownload(request.query),
    );

    if (!delivered.ok) return fail(reply, delivered.status, delivered.code, delivered.message);

    // `private` keeps both responses out of shared caches. For redirects its
    // lifetime also remains below the one-minute signature lifetime.
    reply.header('cache-control', ASSET_CACHE_CONTROL);
    if (delivered.delivery === 'proxy') {
      const object = await app.s3.send(
        new GetObjectCommand({ Bucket: app.config.S3_BUCKET, Key: delivered.objectKey }),
      );
      reply.header('content-type', delivered.mime);
      reply.header('content-disposition', delivered.disposition);
      if (object.ContentLength !== undefined) reply.header('content-length', object.ContentLength);
      if (object.ETag !== undefined) reply.header('etag', object.ETag);
      return reply.send(object.Body);
    }

    // 302, not 307: this is a plain GET redirect and every client follows it.
    return reply.redirect(delivered.url, 302);
  });
};
