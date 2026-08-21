import { randomUUID } from 'node:crypto';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { sql } from 'drizzle-orm';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import cookie from '@fastify/cookie';
import { loadConfig, type ApiConfig } from './config';
import { buildLoggerOptions } from './logging';
import { dbPlugin } from './plugins/db';
import { redisPlugin } from './plugins/redis';
import { rateLimitsPlugin } from './plugins/rateLimits';
import { metricsPlugin } from './plugins/metrics';
import { eventsPlugin } from './plugins/events';
import { s3Plugin } from './plugins/s3';
import { authPlugin } from './auth/plugins';
import { robotsPlugin } from './rolls/robots';
import { studioDeviceRoutes } from './routes/studio-devices';
import { deviceRollRoutes } from './routes/device-rolls';
import { deviceCaptureRoutes } from './routes/device-captures';
import { hostRollRoutes } from './routes/host-rolls';
import { hostCaptureRoutes } from './routes/host-captures';
import { hostExportRoutes } from './routes/host-export';
import { hostEventRoutes } from './routes/host-events';
import { guestRollRoutes } from './routes/guest-rolls';
import { guestCaptureRoutes } from './routes/guest-captures';
import { guestEventRoutes } from './routes/guest-events';
import { assetRoutes } from './routes/assets';
import { diagnosticRoutes } from './routes/diagnostics';
import { firmwareRoutes } from './routes/firmware';

declare module 'fastify' {
  interface FastifyInstance {
    config: ApiConfig;
  }
}

/** A dependency that is unreachable must not stall the health endpoint. */
const HEALTH_PROBE_TIMEOUT_MS = 5_000;

async function probe(
  log: FastifyBaseLogger,
  dependency: string,
  check: () => Promise<unknown>,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const running = check();
    // A late rejection after the race is lost would otherwise go unhandled.
    running.catch(() => {});
    await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${dependency} probe timed out after ${HEALTH_PROBE_TIMEOUT_MS}ms`)),
          HEALTH_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch (err) {
    log.error({ err, dependency }, 'health probe failed');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds the API without binding a port, so tests can drive it in-process
 * through `app.inject()`. Fastify boots registered plugins lazily on the
 * first `ready()`/`inject()`, which is why this can stay synchronous.
 */
export function buildServer(config: ApiConfig = loadConfig()): FastifyInstance {
  const options: FastifyServerOptions = {
    logger: buildLoggerOptions(config.LOG_LEVEL),
    // Correlates every log line of a request (05 §17). Fastify prefers an
    // inbound x-request-id and falls back to this generator, logging it as
    // `reqId` (its default label).
    genReqId: () => randomUUID(),
    requestIdHeader: 'x-request-id',
    trustProxy: config.TRUST_PROXY,
  };

  const app = Fastify(options);

  app.decorate('config', config);
  app.register(dbPlugin, { config });
  app.register(redisPlugin, { config });
  app.register(rateLimitsPlugin);
  // The roll event subscriber; duplicates the client above, so it comes after.
  app.register(eventsPlugin);
  app.register(s3Plugin, { config });
  app.register(metricsPlugin);
  // Signed cookies for the guest PIN session (05 §12/§13).
  app.register(cookie, { secret: config.COOKIE_SECRET });

  /**
   * Order matters below this line. `authPlugin` installs an `onRoute` hook that
   * enforces the 07 §25 URL-space split, and `onRoute` only observes routes
   * added after it — so every route plugin belongs *after* this line.
   *
   * Note the asymmetry: `app.register(...)` is deferred until boot, but a bare
   * `app.get(...)` on this instance (like `/api/healthz` below) is added
   * immediately, before any plugin runs, and is therefore invisible to the
   * hook. Authenticated routes go in a plugin, never inline here.
   *
   * `robotsPlugin` is the exception to that ordering rule and is listed first
   * only for readability. Its `onSend` is a plain hook on this root context, and
   * Fastify resolves a context's hooks once the context has finished loading —
   * so it covers every route here regardless of registration order, including
   * `POST /api/rolls/:slug/pin` inside `authPlugin` (03 §9). Verified, not
   * assumed: `rolls.test.ts` asserts the header on that route specifically.
   */
  app.register(robotsPlugin);
  app.register(authPlugin);
  app.register(studioDeviceRoutes);
  app.register(deviceRollRoutes);
  app.register(deviceCaptureRoutes);
  app.register(hostRollRoutes);
  app.register(hostCaptureRoutes);
  app.register(hostExportRoutes);
  app.register(hostEventRoutes);
  app.register(guestRollRoutes);
  app.register(guestCaptureRoutes);
  app.register(guestEventRoutes);
  app.register(assetRoutes);
  app.register(firmwareRoutes);

  /**
   * Auth probe routes, test builds only. `NODE_ENV` has no default and an unset
   * value is not `'test'`, so this is fail-closed: a deployment that never sets
   * it does not get them.
   */
  if (config.NODE_ENV === 'test') app.register(diagnosticRoutes);

  app.get('/api/healthz', async (request, reply) => {
    const [db, redis, storage] = await Promise.all([
      probe(request.log, 'db', () => app.db.execute(sql`select 1`)),
      probe(request.log, 'redis', async () => {
        const pong = await app.redis.ping();
        if (pong !== 'PONG') throw new Error(`unexpected PING reply: ${pong}`);
      }),
      probe(request.log, 'storage', () =>
        app.s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET })),
      ),
    ]);

    const ok = db && redis && storage;
    reply.code(ok ? 200 : 503);
    return { ok, db, redis, storage };
  });

  return app;
}
