import { randomUUID } from 'node:crypto';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { sql } from 'drizzle-orm';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { loadConfig, type ApiConfig } from './config';
import { dbPlugin } from './plugins/db';
import { redisPlugin } from './plugins/redis';
import { s3Plugin } from './plugins/s3';

declare module 'fastify' {
  interface FastifyInstance {
    config: ApiConfig;
  }
}

/** A dependency that is unreachable must not stall the health endpoint. */
const HEALTH_PROBE_TIMEOUT_MS = 5_000;

/**
 * Secret-bearing keys are censored wherever they appear in a log record
 * (05 §13: never log Wi-Fi passwords or token secrets). This is the "belt";
 * the request serializer below is the "braces".
 */
const REDACTED_PATHS = [
  'password',
  '*.password',
  'passphrase',
  '*.passphrase',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
];

/** The subset of the request pino actually hands to a `req` serializer. */
interface LoggedRequest {
  id: string;
  method: string;
  url: string;
  ip: string;
}

/** The subset of the reply pino actually hands to a `res` serializer. */
interface LoggedReply {
  statusCode: number;
}

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
    logger: {
      level: config.LOG_LEVEL,
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
      serializers: {
        // Allow-list. Request bodies are never logged on any route.
        // Typed structurally: pino hands these its own reply/request views,
        // which are narrower than FastifyRequest/FastifyReply.
        req(request: LoggedRequest) {
          return {
            id: request.id,
            method: request.method,
            url: request.url,
            remoteAddress: request.ip,
          };
        },
        res(reply: LoggedReply) {
          return { statusCode: reply.statusCode };
        },
      },
    },
    // Correlates every log line of a request (05 §17). Fastify prefers an
    // inbound x-request-id and falls back to this generator, logging it as
    // `reqId` (its default label).
    genReqId: () => randomUUID(),
    requestIdHeader: 'x-request-id',
  };

  const app = Fastify(options);

  app.decorate('config', config);
  app.register(dbPlugin, { config });
  app.register(redisPlugin, { config });
  app.register(s3Plugin, { config });

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
