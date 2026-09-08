import { randomUUID } from 'node:crypto';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { sql } from 'drizzle-orm';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { isDevEnvironment, loadConfig, type ApiConfig } from './config';
import { buildLoggerOptions } from './logging';
import { dbPlugin } from './plugins/db';
import { redisPlugin } from './plugins/redis';
import { rateLimitsPlugin } from './plugins/rateLimits';
import { metricsPlugin } from './plugins/metrics';
import { eventsPlugin } from './plugins/events';
import { s3Plugin } from './plugins/s3';
import { authPlugin } from './auth/plugins';
import { InternalError, fail } from './routes/errors';
import { robotsPlugin } from './rolls/robots';
import { securityHeadersPlugin } from './plugins/securityHeaders';
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

/**
 * The code an answer gets when the error carries none of its own.
 *
 * Every route in this API answers `{code, message}` (`routes/errors.ts`), and
 * until now anything *thrown* answered Fastify's own
 * `{statusCode, error, message}` instead — so a client had two envelopes to
 * parse and no way to know which it was about to get. These fill the code in for
 * the throws that come from outside our own modules: `@fastify/rate-limit`'s
 * 429, a body over the limit, a parser refusing a content type.
 */
const STATUS_CODES: Readonly<Record<number, string>> = {
  400: 'INVALID_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  406: 'NOT_ACCEPTABLE',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
};

/**
 * The status an error asks for, or 500.
 *
 * `RollClosedError`, `AssetShapeError` and `OriginalOverwriteError` declare a
 * `statusCode`, and so does every error `@fastify/rate-limit` and Fastify's own
 * machinery raise. Anything below 400 is not a refusal — an error object
 * carrying `statusCode: 200` is a bug, not an answer — so it becomes a 500.
 */
function statusOf(err: unknown): number {
  const status = (err as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : 500;
}

/**
 * The error's own code where it has one of ours, the status's word otherwise.
 *
 * `FST_ERR_*` is Fastify's internal naming and is deliberately not passed
 * through: it names the internal that raised the error rather than what the
 * caller did wrong, and it would put a second vocabulary on a surface that has
 * one. Postgres's own numeric codes never reach this — they arrive as 500s,
 * which never look at the code at all.
 */
function codeOf(err: unknown, status: number): string {
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code.length > 0 && !code.startsWith('FST_')) return code;
  return STATUS_CODES[status] ?? 'REQUEST_FAILED';
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

  /**
   * Every error answers the one `{code, message}` envelope (`routes/errors.ts`).
   *
   * Set here, before any route plugin is registered, because a child context
   * inherits the handler its parent had when the context was created — a handler
   * installed after the registrations would cover the root context only, which
   * is `/api/healthz` and nothing else.
   *
   * ## Expected refusals versus unexpected failures
   *
   * A refusal that a module *chose* — `ROLL_CLOSED`, `ORIGINAL_IMMUTABLE`,
   * `UNSUPPORTED_MIME`, a 429 from the limiter — carries its own status and its
   * own message, and both are safe to hand back: they were written to be read by
   * a camera or a browser.
   *
   * Anything reaching 500 was not chosen, so its message is an implementation
   * detail: a driver's constraint name, a bucket name, an S3 endpoint, an id
   * interpolated by whoever threw. None of that goes in the body. It goes in the
   * log, with `err` and with `InternalError.detail`, where the reqId already ties
   * it to the request that caused it (05 §17); the caller gets a fixed sentence
   * and the reqId it sent.
   */
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const status = statusOf(err);
    if (status >= 500) {
      const detail = err instanceof InternalError ? err.detail : {};
      request.log.error({ err, ...detail }, 'request failed');
      return fail(
        reply,
        status,
        'INTERNAL_ERROR',
        'the server could not complete this request; retry, and quote the x-request-id',
      );
    }
    return fail(reply, status, codeOf(err, status), err.message);
  });

  /**
   * A URL nothing is mounted at is a 404 in the same envelope. Fastify's own
   * default answers `{message: "Route GET:/api/nope not found", error, statusCode}`,
   * which is the second shape this API is trying not to have — and it echoes the
   * path back, which turns a typo in a client into a reflected string.
   */
  app.setNotFoundHandler((request, reply) =>
    fail(reply, 404, 'NOT_FOUND', 'no route is mounted at this path'),
  );

  /**
   * Studio talks to the Roll server cross-origin (it is a device tool, not a
   * page this API serves), and dev tooling runs Studio/Twin/roll-web on assorted
   * localhost ports. The configured public base is always reflected; localhost
   * is reflected **only outside production** (issue #86).
   *
   * The environment gate matters because this is a `credentials: true` policy:
   * reflecting an origin here tells the browser it may send the guest's PIN and
   * access cookies to it and read the response. A page on the operator's own
   * machine — anything they were induced to open, a compromised dev tool, a
   * `localhost` service bound by other software — would otherwise be able to
   * read any roll that operator can, from a deployed API. Nothing in production
   * legitimately calls this API from localhost, so nothing legitimate is lost.
   *
   * Opt-IN, exactly like every check in `config.ts`, and it did not used to be.
   * The old test was `NODE_ENV !== 'production'`, which fails **open** on the
   * single most likely deployment mistake — forgetting to set NODE_ENV at all —
   * and this is a `credentials: true` policy: reflecting an origin tells the
   * browser it may send the guest's PIN and access cookies there and read the
   * answer. `isDevEnvironment` is the same predicate the cookie secret and the
   * provisioning token key on, so an unset, misspelled or unfamiliar NODE_ENV
   * now refuses localhost here too. A developer whose bench stops reflecting is
   * a developer who has not set NODE_ENV; `npm run dev -w @kino/api` sets it.
   */
  const reflectLocalhost = isDevEnvironment(config.NODE_ENV);
  app.register(cors, {
    origin: (origin, done) => {
      if (!origin) return done(null, true);
      let allowed = false;
      try {
        const { hostname } = new URL(origin);
        allowed =
          (reflectLocalhost && (hostname === 'localhost' || hostname === '127.0.0.1')) ||
          origin === new URL(config.PUBLIC_BASE_URL).origin;
      } catch {
        allowed = false;
      }
      done(null, allowed);
    },
    credentials: true,
  });
  app.register(dbPlugin, { config });
  app.register(redisPlugin, { config });
  // Signed cookies for the guest PIN session and the roll access stamp
  // (05 §12/§13). Registered **before** the rate limiter, and that order is
  // load-bearing: both parse in an `onRequest` hook, hooks run in registration
  // order, and the guest read limits key on the signed guest cookie — which is
  // still null if the limiter's hook runs first.
  app.register(cookie, { secret: config.COOKIE_SECRET });
  app.register(rateLimitsPlugin);
  // The roll event subscriber; duplicates the client above, so it comes after.
  app.register(eventsPlugin);
  app.register(s3Plugin, { config });
  app.register(metricsPlugin);

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
  /**
   * Same shape and the same reason as `robotsPlugin`: a plain root-context
   * `onSend` hook, so it covers every route in this file plus `/api/healthz`
   * and anything a later task mounts, without each of them remembering.
   */
  app.register(securityHeadersPlugin);
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
