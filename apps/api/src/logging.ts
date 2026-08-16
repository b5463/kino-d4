import type { ApiConfig } from './config';

/** The subset of the request pino actually hands to a `req` serializer. */
export interface LoggedRequest {
  id: string;
  method: string;
  url: string;
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
  'DATABASE_URL',
  'REDIS_URL',
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
          url: request.url,
          remoteAddress: request.ip,
        };
      },
      res(reply: LoggedReply) {
        return { statusCode: reply.statusCode };
      },
    },
  };
}
