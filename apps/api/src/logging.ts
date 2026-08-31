import type { ApiConfig } from './config';

/** The subset of the request pino actually hands to a `req` serializer. */
export interface LoggedRequest {
  id: string;
  method: string;
  /**
   * Optional, because pino applies this serializer to anything logged under the
   * `req` key — including a plain object from application code that names only
   * the fields it cared about, which is a shape the redaction tests use.
   */
  url: string | undefined;
  ip: string;
}

/** The subset of the reply pino actually hands to a `res` serializer. */
export interface LoggedReply {
  statusCode: number;
}

/**
 * Key names whose value is always a secret, wherever they appear (05 §13:
 * never log Wi-Fi passwords or token secrets).
 *
 * `S3_SECRET_KEY` and friends are listed by their exact names on purpose:
 * fast-redact matches whole key names, so the generic `secret` rule does NOT
 * cover `S3_SECRET_KEY` — nor `COOKIE_SECRET`. `DATABASE_URL`/`REDIS_URL` are
 * censored wholesale because they carry an inline password that no key-name
 * rule can reach.
 *
 * Every new secret-bearing config key has to be added here by its exact name.
 */
const SECRET_KEYS = [
  'password',
  'passphrase',
  'secret',
  'token',
  'S3_SECRET_KEY',
  'S3_ACCESS_KEY',
  'COOKIE_SECRET',
  // Not covered by the generic `token` rule: fast-redact matches whole key
  // names, so `PROVISIONING_TOKEN` needs its own entry exactly as
  // `S3_SECRET_KEY` does. It mints device credentials, so a log line carrying it
  // is a log line carrying the keys to the upload API.
  'PROVISIONING_TOKEN',
  'DATABASE_URL',
  'REDIS_URL',
  'METRICS_TOKEN',
];

/**
 * fast-redact has no "any depth" wildcard, so each key is registered at every
 * depth we can realistically log. Three wildcard tiers covers the shapes that
 * occur in practice — `{S3_SECRET_KEY}`, `{config:{S3_SECRET_KEY}}`,
 * `{body:{wifi:{password}}}` (the 05 §13 shape) and
 * `{req:{body:{wifi:{password}}}}`.
 */
export const REDACTED_PATHS: string[] = [
  ...SECRET_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`]),
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
];

export const REDACTION_CENSOR = '[REDACTED]';

/**
 * The roll slug, out of the access log.
 *
 * A slug is 887M-space unguessable *and* it is the whole of a guest credential
 * for an unlisted roll (03 §9): anyone holding one can read the gallery. Every
 * request to `/api/rolls/<slug>/...` was writing it to the log at info level, so
 * the log — shipped, aggregated, read by whoever has access to logs — became a
 * list of live guest links. That is the same class of value as
 * `Authorization`, which this serializer already refuses to print.
 *
 * Only the one segment is replaced. The path is what makes a log line worth
 * having, so `/api/rolls/[REDACTED]/captures/cap_x?limit=50` keeps the route, the
 * capture id and the query while dropping the credential. A capture id is not a
 * credential — it opens nothing without the roll — so it stays.
 *
 * `/r/<slug>` is the *web app's* path and never reaches this API, so there is
 * nothing to match for it here.
 */
export function redactSlug(url: string | undefined): string | undefined {
  // Undefined in, undefined out. Pino invokes a serializer on whatever was
  // logged under the key, so `log.info({ req: { headers } })` from application
  // code reaches this with no `url` at all — and a logger that throws would take
  // out the request it was describing.
  if (url === undefined) return undefined;
  return url.replace(/^\/api\/rolls\/[^/?#]+/, `/api/rolls/${REDACTION_CENSOR}`);
}

/**
 * Shared by the server and by the redaction test, so the test asserts against
 * the configuration the server actually runs rather than a copy of it.
 */
export function buildLoggerOptions(level: ApiConfig['LOG_LEVEL']) {
  return {
    level,
    redact: { paths: REDACTED_PATHS, censor: REDACTION_CENSOR },
    serializers: {
      // Allow-list. Request bodies are never logged on any route.
      // Typed structurally: pino hands these its own request/reply views,
      // which are narrower than FastifyRequest/FastifyReply.
      req(request: LoggedRequest) {
        return {
          id: request.id,
          method: request.method,
          url: redactSlug(request.url),
          remoteAddress: request.ip,
        };
      },
      res(reply: LoggedReply) {
        return { statusCode: reply.statusCode };
      },
    },
  };
}
