import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { firmwareManifest } from '@kino/schemas';
import { firmwareReleases } from '../db/schema';
import { guestReadRateLimit } from '../plugins/rateLimits';
import { fail } from './errors';

const FIRMWARE_URL_TTL_SECONDS = 15 * 60;

function queryOf(request: FastifyRequest): Record<string, unknown> {
  return typeof request.query === 'object' && request.query !== null
    ? (request.query as Record<string, unknown>)
    : {};
}

function safeFile(file: string): boolean {
  return file.split('/').every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part));
}

export const firmwareRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/firmware/releases', { config: guestReadRateLimit }, async (request, reply) => {
    const query = queryOf(request);
    const hardware = typeof query['hardware'] === 'string' ? query['hardware'] : '';
    const channel = typeof query['channel'] === 'string' ? query['channel'] : 'stable';
    const protocolRaw = typeof query['protocol'] === 'string' ? Number(query['protocol']) : null;
    if (hardware === '') return fail(reply, 400, 'HARDWARE_REQUIRED', 'hardware query is required');
    if (protocolRaw !== null && (!Number.isInteger(protocolRaw) || protocolRaw < 0)) {
      return fail(reply, 400, 'INVALID_PROTOCOL', 'protocol must be a non-negative integer');
    }

    const rows = await app.db
      .select()
      .from(firmwareReleases)
      .where(eq(firmwareReleases.channel, channel))
      .orderBy(desc(firmwareReleases.publishedAt));

    const items = [];
    for (const row of rows) {
      const parsed = firmwareManifest.shape.safeParse(row.manifest);
      if (!parsed.success || parsed.data.channel !== row.channel) {
        request.log.error(
          { release: row.release, channel: row.channel },
          'stored firmware manifest is invalid',
        );
        return fail(
          reply,
          500,
          'INVALID_FIRMWARE_MANIFEST',
          'stored firmware manifest is invalid',
        );
      }
      const hardwareOk = parsed.data.compatibleHardware.some(
        (candidate) => candidate.toLowerCase() === hardware.toLowerCase(),
      );
      const protocolOk =
        protocolRaw === null ||
        (protocolRaw >= parsed.data.protocolMin && protocolRaw <= parsed.data.protocolMax);
      const reasons: string[] = [];
      if (!hardwareOk) {
        reasons.push(`Requires hardware ${parsed.data.compatibleHardware.join(', ')}`);
      }
      if (!protocolOk) {
        reasons.push(`Requires protocol ${parsed.data.protocolMin}–${parsed.data.protocolMax}`);
      }
      items.push({
        manifest: parsed.data,
        release: row.release,
        channel: row.channel,
        publishedAt: row.publishedAt,
        compatible: hardwareOk && protocolOk,
        reasons,
        notes: row.notes,
      });
    }
    return { items };
  });

  app.get(
    '/api/firmware/releases/:release/manifest',
    { config: guestReadRateLimit },
    async (request, reply) => {
    const params = request.params as { release?: string };
    const query = queryOf(request);
    const channel = typeof query['channel'] === 'string' ? query['channel'] : 'stable';
    const [row] = await app.db
      .select({ manifest: firmwareReleases.manifest, channel: firmwareReleases.channel })
      .from(firmwareReleases)
      .where(
        and(
          eq(firmwareReleases.release, params.release ?? ''),
          eq(firmwareReleases.channel, channel),
        ),
      )
      .limit(1);
    if (row === undefined) {
      return fail(reply, 404, 'FIRMWARE_RELEASE_NOT_FOUND', 'no such firmware release');
    }
    const parsed = firmwareManifest.shape.safeParse(row.manifest);
    if (!parsed.success || parsed.data.channel !== row.channel) {
      request.log.error({ release: params.release }, 'stored firmware manifest is invalid');
      return fail(reply, 500, 'INVALID_FIRMWARE_MANIFEST', 'stored firmware manifest is invalid');
    }
    if (!safeFile(parsed.data.release)) {
      return fail(reply, 500, 'INVALID_FIRMWARE_RELEASE', 'stored firmware release is invalid');
    }

    const downloads: Record<string, string> = {};
    for (const [target, image] of Object.entries(parsed.data.targets)) {
      if (!safeFile(image.file)) {
        return fail(reply, 500, 'INVALID_FIRMWARE_FILE', 'stored firmware file path is invalid');
      }
      if (app.config.OBJECT_DELIVERY === 'proxy') {
        const base = app.config.PUBLIC_BASE_URL.replace(/\/$/, '');
        downloads[target] =
          `${base}/api/firmware/releases/${encodeURIComponent(parsed.data.release)}` +
          `/files/${encodeURIComponent(target)}?channel=${encodeURIComponent(row.channel)}`;
      } else {
        downloads[target] = await getSignedUrl(
          app.s3,
          new GetObjectCommand({
            Bucket: app.config.S3_FIRMWARE_BUCKET,
            Key: `firmware/${row.channel}/${parsed.data.release}/${image.file}`,
          }),
          { expiresIn: FIRMWARE_URL_TTL_SECONDS },
        );
      }
    }
    return { manifest: parsed.data, downloads };
    },
  );

  app.get(
    '/api/firmware/releases/:release/files/:target',
    { config: guestReadRateLimit },
    async (request, reply) => {
      const params = request.params as { release?: string; target?: string };
      const query = queryOf(request);
      const channel = typeof query['channel'] === 'string' ? query['channel'] : 'stable';
      const [row] = await app.db
        .select({ manifest: firmwareReleases.manifest, channel: firmwareReleases.channel })
        .from(firmwareReleases)
        .where(
          and(
            eq(firmwareReleases.release, params.release ?? ''),
            eq(firmwareReleases.channel, channel),
          ),
        )
        .limit(1);
      if (row === undefined) {
        return fail(reply, 404, 'FIRMWARE_RELEASE_NOT_FOUND', 'no such firmware release');
      }

      const parsed = firmwareManifest.shape.safeParse(row.manifest);
      if (!parsed.success || parsed.data.channel !== row.channel || !safeFile(parsed.data.release)) {
        request.log.error({ release: params.release }, 'stored firmware manifest is invalid');
        return fail(reply, 500, 'INVALID_FIRMWARE_MANIFEST', 'stored firmware manifest is invalid');
      }
      const image = parsed.data.targets[params.target ?? ''];
      if (image === undefined || !safeFile(image.file)) {
        return fail(reply, 404, 'FIRMWARE_TARGET_NOT_FOUND', 'no such firmware target');
      }

      const object = await app.s3.send(
        new GetObjectCommand({
          Bucket: app.config.S3_FIRMWARE_BUCKET,
          Key: `firmware/${row.channel}/${parsed.data.release}/${image.file}`,
        }),
      );
      reply.header('cache-control', 'private, max-age=300');
      reply.header('content-type', object.ContentType ?? 'application/octet-stream');
      reply.header('content-disposition', `attachment; filename="${image.file}"`);
      if (object.ContentLength !== undefined) reply.header('content-length', object.ContentLength);
      if (object.ETag !== undefined) reply.header('etag', object.ETag);
      return reply.send(object.Body);
    },
  );
};
