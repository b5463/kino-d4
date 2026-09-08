import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { rollOf } from '../auth/plugins';
import {
  EXPORT_JOB_NAME,
  claimExportJob,
  estimateRollExport,
  exportContentUrl,
  exportDownloadName,
  exportJobKey,
  exportObjectExists,
  exportObjectKey,
  readExportJob,
  signExportUrl,
} from '../exports/exports';
import { createProcessingQueue, submitJob, type ProcessingQueue } from '../queue/producer';
import { fail } from './errors';
import {
  hostExportDownloadRateLimit,
  hostExportEstimateRateLimit,
} from '../plugins/rateLimits';

/**
 * Host downloads of a whole roll (03 §25).
 *
 * "Large exports as background jobs with expiring links" is the whole design, and
 * the reason is arithmetic: a roll is every original frame of every capture, so a
 * 300-capture party is four gigabytes. There is no version of that which is a
 * request/response, so the POST records a job and returns its id and the GET
 * answers `{status, url?}` until the ZIP exists. Where that url points is the
 * deployment's business: a presigned storage link where storage is reachable,
 * and `/content` on this API where it is not.
 *
 * Neither route touches `downloadsEnabled`. That flag governs what **guests** may
 * download (03 §25); the host is the person who set it, and a host who turned
 * guest downloads off has not thereby locked themselves out of their own photos.
 */

function paramOf(request: FastifyRequest, name: string): string {
  const params: unknown = request.params;
  if (typeof params !== 'object' || params === null) return '';
  const value = (params as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}

export const hostExportRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The producer connection, created on first use and shared thereafter.
   *
   * Same pattern and same reason as `device-captures.ts`: BullMQ needs
   * `maxRetriesPerRequest: null` while the API's shared client is capped at 2 so
   * a health probe fails fast, and a connection opened at boot would make every
   * test that never exports hold a Redis client open.
   */
  let queue: ProcessingQueue | null = null;
  const processingQueue = (): ProcessingQueue => {
    queue ??= createProcessingQueue(app.config);
    return queue;
  };
  app.addHook('onClose', async () => {
    await queue?.close();
  });

  app.post(
    '/api/host/rolls/:rollId/export',
    { preHandler: app.requireHost('rollId') },
    async (request, reply) => {
      const roll = rollOf(request);
      const jobId = await claimExportJob(app.db, roll.id);

      // Submitted on **every** call, including one that joined an export already
      // in flight. BullMQ keeps one job per id and `exportJobKey` is derived from
      // the row's own id, so re-submitting a job that still exists is a no-op —
      // and re-submitting one that does *not* is the recovery path for the case
      // below, where the row was committed and the add failed.
      //
      // The failure propagates: the host gets a 500 to retry rather than a jobId
      // for a job nobody will pick up. That is the opposite call from the upload
      // pipeline's fire-and-forget, and deliberately so — a missing thumbnail
      // regenerates on the next capture, a missing export never happens. The
      // retry then rejoins the same `queued` row and submits it properly.
      await submitJob(processingQueue(), EXPORT_JOB_NAME, {
        rollId: roll.id,
        jobKey: exportJobKey(jobId),
      });

      // 202, not 201: nothing was created that the host can fetch yet. The Location
      // header is the polling route, so a client needs no URL template of its own.
      reply.header('location', `/api/host/rolls/${roll.id}/export/${jobId}`);
      return reply.code(202).send({ jobId });
    },
  );

  app.get(
    '/api/host/rolls/:rollId/export/:jobId',
    { preHandler: app.requireHost('rollId') },
    async (request, reply) => {
      const roll = rollOf(request);
      const job = await readExportJob(app.db, roll.id, paramOf(request, 'jobId'));
      // A job of another roll and a job that never existed get one answer. The
      // roll id is part of the query, so this route cannot be an oracle for
      // exports the caller has no business knowing about.
      if (job === undefined) {
        return fail(reply, 404, 'EXPORT_JOB_NOT_FOUND', 'no such export job for this roll');
      }

      if (job.status !== 'done') return { status: job.status };

      const key = exportObjectKey(roll.id, job.id);
      if (!(await exportObjectExists(app.s3, app.config.S3_BUCKET, key))) {
        // `done` with no object means the handler finished the row and lost the
        // upload, or something removed the ZIP. Signing anyway would hand the host
        // a link that 404s from storage with nothing to explain it, so the reply
        // keeps the status and withholds the link.
        app.log.error(
          { rollId: roll.id, jobId: job.id, key },
          'export job is done but its object is missing',
        );
        return { status: job.status };
      }

      // Which link the host gets is the deployment's answer, not the route's.
      // In production storage is private with no published port, so a presigned
      // URL to `object-storage:9000` is a DNS error in the host's browser — see
      // `exportContentUrl`. The response shape is `{status, url?}` either way.
      if (app.config.OBJECT_DELIVERY === 'proxy') {
        return { status: job.status, url: exportContentUrl(app.config.PUBLIC_BASE_URL, roll.id, job.id) };
      }

      return { status: job.status, url: await signExportUrl(app.s3, app.config.S3_BUCKET, key) };
    },
  );

  /**
   * The ZIP itself, streamed through the API.
   *
   * The bytes come from `app.s3` — the API's own credentials against the
   * internal endpoint — so the host's browser never has to reach storage. Same
   * shape as `GET /api/assets/:assetId/content` in proxy mode: read the object,
   * copy its length and type onto the reply, hand Fastify the body stream. The
   * stream is not buffered, so a 4 GB export costs this process a socket rather
   * than 4 GB of heap.
   *
   * Registered whatever `OBJECT_DELIVERY` says. A route that exists only in one
   * mode is a route nobody exercises in development, and it costs nothing to
   * leave reachable — the poll route decides which URL a host is *given*.
   *
   * No range support, matching every other object route here. A ZIP is fetched
   * whole by a browser's download manager, and half of a central directory is
   * not a smaller archive.
   */
  app.get(
    '/api/host/rolls/:rollId/export/:jobId/content',
    // The only route here that streams gigabytes; six a minute per host token.
    // See `RATE_LIMITS.hostExportDownload`.
    { preHandler: app.requireHost('rollId'), config: hostExportDownloadRateLimit },
    async (request, reply) => {
      const roll = rollOf(request);
      const job = await readExportJob(app.db, roll.id, paramOf(request, 'jobId'));
      // A job of another roll and one that never existed get one answer, the
      // same way the poll route above answers.
      if (job === undefined) {
        return fail(reply, 404, 'EXPORT_JOB_NOT_FOUND', 'no such export job for this roll');
      }
      if (job.status !== 'done') {
        // 409, not 404: the job is real and the caller may poll. Same reasoning
        // as `ASSET_NOT_READY` — the request is fine, the state refuses.
        return fail(reply, 409, 'EXPORT_NOT_READY', `this export is ${job.status}`);
      }

      const key = exportObjectKey(roll.id, job.id);
      let object;
      try {
        object = await app.s3.send(
          new GetObjectCommand({ Bucket: app.config.S3_BUCKET, Key: key }),
        );
      } catch (err) {
        // `done` with no object: the handler finished the row and lost the
        // upload, or something removed the ZIP. The poll route logs the same
        // condition and withholds the link; a host who kept an old link lands
        // here instead, and 404 is the truth about the file.
        app.log.error({ err, rollId: roll.id, jobId: job.id, key }, 'export object is missing');
        return fail(reply, 404, 'EXPORT_OBJECT_MISSING', 'this export’s ZIP is no longer stored');
      }

      // The export is the host's own roll and nothing shared caches it.
      reply.header('cache-control', 'private, no-store');
      reply.header('content-type', object.ContentType ?? 'application/zip');
      reply.header(
        'content-disposition',
        `attachment; filename="${exportDownloadName(roll.slug, job.finishedAt ?? job.createdAt)}"`,
      );
      // Without a length the reply is chunked and the browser's download shows
      // no progress bar on a file that takes minutes.
      if (object.ContentLength !== undefined) reply.header('content-length', object.ContentLength);
      if (object.ETag !== undefined) reply.header('etag', object.ETag);
      return reply.send(object.Body);
    },
  );

  /**
   * What the ZIP would weigh (`{files, bytes}`), so the dashboard can say
   * "≈17 GB, 9,400 files" before the host presses the button.
   *
   * A static path segment under `/export/`, which find-my-way matches ahead of
   * the `:jobId` route above — `estimate` is not a job id and cannot become one
   * (`newId('exp')` prefixes every one of them).
   *
   * Deliberately not part of the dashboard payload: the dashboard is polled and
   * this is an aggregate over every asset of the roll, so folding it in would
   * put a growing scan on the request that must stay cheap. Metered for the same
   * reason — keeping the scan off the polled route and then leaving it unmetered
   * gives the cost straight back. See `RATE_LIMITS.hostExportEstimate`.
   */
  app.get(
    '/api/host/rolls/:rollId/export/estimate',
    { preHandler: app.requireHost('rollId'), config: hostExportEstimateRateLimit },
    async (request) => estimateRollExport(app.db, rollOf(request).id),
  );
};
