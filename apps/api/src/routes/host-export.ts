import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { rollOf } from '../auth/plugins';
import {
  EXPORT_JOB_NAME,
  claimExportJob,
  exportJobKey,
  exportObjectExists,
  exportObjectKey,
  readExportJob,
  signExportUrl,
} from '../exports/exports';
import { createProcessingQueue, submitJob, type ProcessingQueue } from '../queue/producer';
import { fail } from './errors';

/**
 * Host downloads of a whole roll (03 §25).
 *
 * "Large exports as background jobs with expiring links" is the whole design, and
 * the reason is arithmetic: a roll is every original frame of every capture, so a
 * 300-capture party is four gigabytes. There is no version of that which is a
 * request/response, so the POST records a job and returns its id and the GET
 * answers `{status, url?}` until the ZIP exists.
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

      return { status: job.status, url: await signExportUrl(app.s3, app.config.S3_BUCKET, key) };
    },
  );
};
