import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { sql } from 'drizzle-orm';
import { createProcessingQueue, type ProcessingQueue } from '../queue/producer';

const LATENCY_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;
const ACTIVE_DEVICE_WINDOW_MS = 15 * 60_000;
const ACTIVE_DEVICES_KEY = 'kino:metrics:active-devices';

interface RequestSeries {
  method: string;
  route: string;
  count: number;
  errors: number;
  durationSum: number;
  buckets: number[];
}

export interface KinoMetrics {
  sseConnected(): () => void;
}

declare module 'fastify' {
  interface FastifyInstance {
    metrics: KinoMetrics;
  }
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function labels(values: Record<string, string>): string {
  return `{${Object.entries(values)
    .map(([name, value]) => `${name}="${escapeLabel(value)}"`)
    .join(',')}}`;
}

function constantTimeToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined || !actual.startsWith('Bearer ')) return false;
  const supplied = createHash('sha256').update(actual.slice(7)).digest();
  const wanted = createHash('sha256').update(expected).digest();
  return timingSafeEqual(supplied, wanted);
}

async function bucketUsage(app: Parameters<typeof metricsPlugin>[0], bucket: string) {
  let objects = 0;
  let bytes = 0;
  let continuationToken: string | undefined;
  do {
    const page = await app.s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
        MaxKeys: 1_000,
      }),
    );
    for (const object of page.Contents ?? []) {
      objects += 1;
      bytes += object.Size ?? 0;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken !== undefined);
  return { bucket, objects, bytes };
}

export const metricsPlugin = fp(
  async (app) => {
    const started = new WeakMap<FastifyRequest, bigint>();
    const series = new Map<string, RequestSeries>();
    let uploadFailures = 0;
    let sseConnections = 0;
    let queue: ProcessingQueue | null = null;
    const activeDevicesKey =
      app.config.NODE_ENV === 'test'
        ? `${ACTIVE_DEVICES_KEY}:test:${process.pid}:${randomUUID()}`
        : ACTIVE_DEVICES_KEY;

    app.decorate('metrics', {
      sseConnected(): () => void {
        sseConnections += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          sseConnections = Math.max(0, sseConnections - 1);
        };
      },
    });

    app.addHook('onRequest', async (request) => {
      started.set(request, process.hrtime.bigint());
    });

    app.addHook('onResponse', async (request, reply) => {
      const began = started.get(request);
      const duration = began === undefined ? 0 : Number(process.hrtime.bigint() - began) / 1e9;
      const method = request.method;
      const route = request.routeOptions.url ?? 'unmatched';
      const key = `${method}\u0000${route}`;
      const current =
        series.get(key) ??
        ({
          method,
          route,
          count: 0,
          errors: 0,
          durationSum: 0,
          buckets: LATENCY_BUCKETS.map(() => 0),
        } satisfies RequestSeries);
      current.count += 1;
      current.durationSum += duration;
      if (reply.statusCode >= 500) current.errors += 1;
      LATENCY_BUCKETS.forEach((upper, index) => {
        if (duration <= upper) current.buckets[index] = (current.buckets[index] ?? 0) + 1;
      });
      series.set(key, current);

      if (
        reply.statusCode >= 400 &&
        (route.startsWith('/api/device/uploads/') ||
          route.startsWith('/api/device/captures/') ||
          route === '/api/device/rolls/:rollId/captures')
      ) {
        uploadFailures += 1;
      }

      if (request.device !== null && reply.statusCode < 500) {
        await app.redis
          .zadd(activeDevicesKey, Date.now(), request.device.id)
          .catch((err: unknown) => app.log.warn({ err }, 'active-device metric was not updated'));
      }
    });

    app.get('/api/metrics', async (request, reply) => {
      const metricsToken = app.config.METRICS_TOKEN;
      if (metricsToken === undefined) return reply.code(404).send({ code: 'NOT_FOUND' });
      if (!constantTimeToken(request.headers.authorization, metricsToken)) {
        reply.header('www-authenticate', 'Bearer');
        return reply.code(401).send({ code: 'METRICS_TOKEN_REQUIRED' });
      }

      queue ??= createProcessingQueue(app.config);
      const now = Date.now();
      const [queueResult, workerResult, activeResult, objectResult] = await Promise.allSettled([
        queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
        app.db.execute<{ failures: string }>(sql`
          select count(*)::text as failures
            from processing_events
           where status in ('failed', 'abandoned')
        `),
        app.redis
          .zremrangebyscore(activeDevicesKey, '-inf', now - ACTIVE_DEVICE_WINDOW_MS)
          .then(() => app.redis.zcard(activeDevicesKey)),
        Promise.all([
          bucketUsage(app, app.config.S3_BUCKET),
          bucketUsage(app, app.config.S3_FIRMWARE_BUCKET),
        ]),
      ]);

      const lines: string[] = [
        '# HELP kino_http_requests_total HTTP requests completed by method and route.',
        '# TYPE kino_http_requests_total counter',
        '# HELP kino_http_errors_total HTTP 5xx responses by method and route.',
        '# TYPE kino_http_errors_total counter',
        '# HELP kino_http_request_duration_seconds Request latency histogram.',
        '# TYPE kino_http_request_duration_seconds histogram',
      ];
      for (const current of series.values()) {
        const base = { method: current.method, route: current.route };
        lines.push(`kino_http_requests_total${labels(base)} ${current.count}`);
        lines.push(`kino_http_errors_total${labels(base)} ${current.errors}`);
        LATENCY_BUCKETS.forEach((upper, index) => {
          lines.push(
            `kino_http_request_duration_seconds_bucket${labels({ ...base, le: String(upper) })} ${current.buckets[index] ?? 0}`,
          );
        });
        lines.push(
          `kino_http_request_duration_seconds_bucket${labels({ ...base, le: '+Inf' })} ${current.count}`,
        );
        lines.push(`kino_http_request_duration_seconds_sum${labels(base)} ${current.durationSum}`);
        lines.push(`kino_http_request_duration_seconds_count${labels(base)} ${current.count}`);
      }

      lines.push('# HELP kino_upload_failures_total Device upload requests that returned 4xx or 5xx.');
      lines.push('# TYPE kino_upload_failures_total counter');
      lines.push(`kino_upload_failures_total ${uploadFailures}`);
      lines.push('# HELP kino_sse_connections Current guest SSE connections in this API process.');
      lines.push('# TYPE kino_sse_connections gauge');
      lines.push(`kino_sse_connections ${sseConnections}`);

      if (queueResult.status === 'fulfilled') {
        lines.push('# HELP kino_queue_jobs BullMQ jobs by state.');
        lines.push('# TYPE kino_queue_jobs gauge');
        for (const [state, count] of Object.entries(queueResult.value)) {
          lines.push(`kino_queue_jobs${labels({ state })} ${count}`);
        }
      } else lines.push('kino_metrics_collection_error{collector="queue"} 1');

      if (workerResult.status === 'fulfilled') {
        lines.push('# HELP kino_worker_failures Recorded failed or abandoned worker attempts.');
        lines.push('# TYPE kino_worker_failures gauge');
        lines.push(`kino_worker_failures ${workerResult.value[0]?.failures ?? '0'}`);
      } else lines.push('kino_metrics_collection_error{collector="worker"} 1');

      if (activeResult.status === 'fulfilled') {
        lines.push(`# HELP kino_active_devices Devices authenticated within ${ACTIVE_DEVICE_WINDOW_MS / 60_000} minutes.`);
        lines.push('# TYPE kino_active_devices gauge');
        lines.push(`kino_active_devices ${activeResult.value}`);
      } else lines.push('kino_metrics_collection_error{collector="active_devices"} 1');

      if (objectResult.status === 'fulfilled') {
        lines.push('# HELP kino_object_storage_objects Objects currently stored by bucket.');
        lines.push('# TYPE kino_object_storage_objects gauge');
        lines.push('# HELP kino_object_storage_bytes Bytes currently stored by bucket.');
        lines.push('# TYPE kino_object_storage_bytes gauge');
        for (const usage of objectResult.value) {
          lines.push(`kino_object_storage_objects${labels({ bucket: usage.bucket })} ${usage.objects}`);
          lines.push(`kino_object_storage_bytes${labels({ bucket: usage.bucket })} ${usage.bytes}`);
        }
      } else lines.push('kino_metrics_collection_error{collector="object_storage"} 1');

      reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      reply.header('cache-control', 'no-store');
      return reply.send(`${lines.join('\n')}\n`);
    });

    app.addHook('onClose', async () => {
      if (queue !== null) await queue.close();
      if (app.config.NODE_ENV === 'test') await app.redis.del(activeDevicesKey).catch(() => 0);
    });
  },
  { name: 'kino-metrics', dependencies: ['kino-db', 'kino-redis', 'kino-s3'] },
);
