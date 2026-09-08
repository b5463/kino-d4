import type { Readable } from 'node:stream';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { assetCacheControl, deliverAsset, wantsDownload } from '../captures/delivery';
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
 * The route itself reads the parameters, turns a refusal into a status code, and
 * then either redirects to a signed URL or streams the object. It makes no
 * access decision of its own; the conditional-request and byte-range handling
 * below is HTTP mechanics, applied only after `deliverAsset` has said yes.
 */

function paramOf(request: FastifyRequest, name: string): string {
  const params: unknown = request.params;
  if (typeof params !== 'object' || params === null) return '';
  const value = (params as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}

/**
 * One request header, or undefined.
 *
 * Undefined rather than an empty string because both values read here are
 * forwarded to the S3 SDK, which omits an undefined field and sends an empty
 * one — and an empty `Range:` header is a request storage refuses.
 */
function headerOf(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  // A repeated header arrives as an array. Neither of these may legally repeat,
  // so the first value is the request and the rest is noise.
  return Array.isArray(value) && value[0] !== undefined && value[0].length > 0
    ? value[0]
    : undefined;
}

/**
 * The HTTP status behind an S3 SDK error.
 *
 * `304` and `416` are not failures of this route — they are storage answering
 * the conditional and the range it was handed — but the SDK reports every
 * non-2xx as a thrown error, so the status has to be read back out of it.
 * `$metadata` is where the SDK puts it; the `name` fallbacks are what MinIO
 * reports on paths that do not carry one.
 */
function statusOfS3Error(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { $metadata: metadata, name } = err as { $metadata?: unknown; name?: unknown };
  if (typeof metadata === 'object' && metadata !== null) {
    const status = (metadata as { httpStatusCode?: unknown }).httpStatusCode;
    if (typeof status === 'number') return status;
  }
  if (name === 'NotModified' || name === 'PreconditionFailed') return 304;
  if (name === 'InvalidRange') return 416;
  return undefined;
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

    // `private` keeps both responses out of shared caches. The lifetime differs
    // by delivery mode and `assetCacheControl` owns that choice: a redirect must
    // expire before the signature it carries, proxied bytes need not expire at
    // all and get a day. See the note on `ASSET_CONTENT_MAX_AGE_SECONDS` for
    // what that day costs after a slug is regenerated.
    reply.header('cache-control', assetCacheControl(delivered.delivery));
    if (delivered.delivery === 'proxy') {
      /**
       * `If-None-Match` and `Range` are handed to storage, not re-implemented.
       *
       * The alternative is a `HeadObject` to learn the etag and a comparison
       * here, which is a second round trip to answer a request that is usually
       * "nothing changed" — and a byte-range served by slicing a full object
       * read is a full object read. Storage already evaluates both against the
       * object it is holding, so it answers `304` without sending a body and
       * `206` with the range asked for, and this route pays one round trip
       * either way.
       *
       * What that buys is concrete. A PWA re-opening a gallery revalidates every
       * tile it has cached (`apps/roll-web/vite.config.ts` caches
       * `/api/assets/*`), and each of those used to be a full re-read of the
       * object out of MinIO and back down the operator's uplink. And a
       * `wiggle-mp4` was **unseekable**: `<video>` asks for a range, got the
       * whole file with no `Accept-Ranges`, and scrubbing did not work.
       */
      const ifNoneMatch = headerOf(request, 'if-none-match');
      const range = headerOf(request, 'range');

      let object;
      try {
        object = await app.s3.send(
          new GetObjectCommand({
            Bucket: app.config.S3_BUCKET,
            Key: delivered.objectKey,
            IfNoneMatch: ifNoneMatch,
            Range: range,
          }),
        );
      } catch (err) {
        // Storage says the client's copy is current. No body, and — per RFC 9110
        // — the same validators and cache directives a 200 would carry, which
        // `cache-control` above and the etag the client sent back already are.
        if (statusOfS3Error(err) === 304) return reply.code(304).send();
        // A range this object cannot satisfy is the client's mistake, not a
        // server fault: 416 is the answer a media element knows how to recover
        // from, where a 500 would look like the file is broken.
        if (statusOfS3Error(err) === 416) {
          return fail(reply, 416, 'RANGE_NOT_SATISFIABLE', 'that byte range is outside this asset');
        }
        throw err;
      }

      reply.header('content-type', delivered.mime);
      reply.header('content-disposition', delivered.disposition);
      // Advertised on every response, including the unranged one: a client only
      // asks for a range if it has been told ranges are available.
      reply.header('accept-ranges', 'bytes');
      if (object.ContentLength !== undefined) reply.header('content-length', object.ContentLength);
      if (object.ETag !== undefined) reply.header('etag', object.ETag);
      if (object.ContentRange !== undefined) {
        reply.header('content-range', object.ContentRange);
        reply.code(206);
      }

      /**
       * A body that fails after the headers are out.
       *
       * Storage dropping the connection mid-object used to surface as an
       * unhandled `error` on the stream — a rejected promise inside Fastify's
       * own piping with nothing in the log to say which asset it was. There is no
       * status code left to send by then, so the honest answer is to destroy the
       * response, which is what a client reads as a truncated transfer and
       * retries, and to leave a line naming the asset.
       */
      const body = object.Body as Readable;
      body.on('error', (err: unknown) => {
        request.log.warn({ err, assetId: paramOf(request, 'assetId') }, 'asset stream failed');
        reply.raw.destroy();
      });
      return reply.send(body);
    }

    // 302, not 307: this is a plain GET redirect and every client follows it.
    return reply.redirect(delivered.url, 302);
  });
};
