/**
 * What the worker needs from the environment, and nothing else.
 *
 * Deliberately a *subset* of `apps/api/src/config.ts` rather than a copy of it:
 * a worker has no cookies to sign, no public base URL to hand out and no
 * request logger, so carrying those variables here would mean a worker refuses
 * to boot over a secret it never uses. The defaults below mirror
 * `infra/docker-compose.dev.yml` exactly as the API's do, so a plain
 * `docker compose -f infra/docker-compose.dev.yml up -d` is the whole setup.
 */
import { isLogLevel, LOG_LEVELS, type LogLevel } from './log';

export interface WorkerConfig {
  DATABASE_URL: string;
  REDIS_URL: string;
  JOB_QUEUE_PREFIX: string;
  S3_ENDPOINT: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_REGION: string;
  /** Same names and same meaning as the API's, so one value turns both down. */
  LOG_LEVEL: LogLevel;
}

/** Host ports 5435/6380/9000 — see the port comments in the compose file. */
const DEFAULTS: WorkerConfig = {
  DATABASE_URL: 'postgres://kino:kino@localhost:5435/kino',
  REDIS_URL: 'redis://localhost:6380',
  JOB_QUEUE_PREFIX: 'kino-jobs',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'kino-media',
  S3_ACCESS_KEY: 'kino',
  S3_SECRET_KEY: 'kino-secret',
  // MinIO ignores the region but the AWS SDK requires one to sign requests.
  S3_REGION: 'us-east-1',
  LOG_LEVEL: 'info',
};

/**
 * The variables whose default is a *credential* — a password, an access key, or
 * an endpoint that can only be the developer's own machine.
 *
 * `S3_BUCKET`, `S3_REGION`, `JOB_QUEUE_PREFIX` and `LOG_LEVEL` are absent on
 * purpose: their defaults are names, not secrets, and a production deployment
 * that keeps the bucket called `kino-media` has not left a door open.
 */
/** Every variable whose value is a plain string, i.e. all but `LOG_LEVEL`. */
const STRING_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JOB_QUEUE_PREFIX',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_REGION',
] as const;

const CREDENTIAL_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'S3_ENDPOINT',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
] as const;

/**
 * The timeouts and attempt cap every S3 client in this worker is built with.
 *
 * ## Why they have to exist at all
 *
 * The SDK ships **no** request timeout and **no** connection timeout. A socket
 * that opens and then goes quiet — a load balancer that dropped the connection
 * without a FIN, a MinIO that is paging, a NAT that expired the mapping — leaves
 * the `await` outstanding forever. The two ffmpeg jobs already reason about
 * exactly this (`wiggleMp4.ts`'s two minutes, `recap.ts`'s ninety) and the
 * arithmetic is the same: a job that never returns holds one of
 * `JOB_CONCURRENCY` slots while BullMQ's lock manager renews its lock every
 * `JOB_LOCK_DURATION_MS / 2` = 2.5 minutes, so nothing ever notices.
 * `JOB_CONCURRENCY` of those and the worker is alive, idle and processing
 * nothing — with no `failed` row, no `abandoned` row, and captures pinned in
 * `processing`.
 *
 * Every non-ffmpeg job is exposed: `generate-thumbnail` GETs one object,
 * `render-contact-sheet` GETs four, `export-roll` GETs thousands.
 *
 * ## The numbers
 *
 * - **`connectionTimeout` 5 s.** The same as the database pool's
 *   `connect_timeout` and Redis's `connectTimeout`. Storage is on the same
 *   network as this process; a TCP handshake that has not completed in five
 *   seconds is not slow, it is pointed at something that is not answering.
 * - **`requestTimeout` 60 s.** The node handler applies this as a *socket
 *   inactivity* timeout, not as a budget for the whole transfer, which is what
 *   makes it safe for the streaming calls: a 17 GB export upload or a gigabyte
 *   ZIP read resets it on every chunk. Sixty seconds of a socket delivering
 *   nothing is a stall. A D4 frame is ~188 kB, so for every ordinary job this
 *   is two orders of magnitude of slack.
 * - **`maxAttempts` 3.** The SDK's own default, written down because it is now
 *   load-bearing: these retries are inside one BullMQ attempt and they
 *   multiply, so the worst case for a single command is 3 × 60 s = 3 minutes
 *   before the handler sees an error. It still fails, which is the point, and
 *   BullMQ's five job attempts are the outer loop. A larger cap would push one
 *   command past `WIGGLE_MP4_TIMEOUT_MS`.
 */
export const S3_CONNECTION_TIMEOUT_MS = 5_000;
export const S3_REQUEST_TIMEOUT_MS = 60_000;
export const S3_MAX_ATTEMPTS = 3;

/**
 * The options both S3 clients in this worker are built from — `ctx.s3`
 * (`context.ts`) and the purge eraser's (`storage/eraser.ts`).
 *
 * One function rather than two literals, so a deployment cannot end up with a
 * guarded client that times out and an eraser that hangs. The guards are still
 * applied per client by their own callers: what is shared here is the transport,
 * not the permissions.
 */
export function s3ClientOptions(config: WorkerConfig): {
  endpoint: string;
  region: string;
  forcePathStyle: true;
  credentials: { accessKeyId: string; secretAccessKey: string };
  maxAttempts: number;
  requestHandler: { connectionTimeout: number; requestTimeout: number };
} {
  return {
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    // MinIO serves buckets as path segments, not as virtual host subdomains.
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
    maxAttempts: S3_MAX_ATTEMPTS,
    // A plain options object rather than a `NodeHttpHandler` instance: the SDK
    // constructs its default handler from these, so the worker does not take a
    // direct dependency on `@smithy/node-http-handler` to set two numbers.
    requestHandler: {
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
      requestTimeout: S3_REQUEST_TIMEOUT_MS,
    },
  };
}

/**
 * A variable set to an empty string counts as "not set", so that a blank line
 * in a .env file falls back to the default instead of producing an empty
 * connection string. Same rule as the API's `withoutBlanks`.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const config = { ...DEFAULTS };
  for (const key of STRING_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') config[key] = value;
  }

  const level = env['LOG_LEVEL']?.trim();
  if (level !== undefined && level !== '') {
    if (!isLogLevel(level)) {
      throw new Error(
        `Invalid worker configuration: LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`,
      );
    }
    config.LOG_LEVEL = level;
  }

  /*
   * The dev defaults are published — they are in this file, in
   * `infra/.env.example` and in the compose file — so `kino:kino@localhost` is
   * not a password, it is a placeholder. A production process that boots on one
   * is either talking to nothing or talking to something it should not be, and
   * both are worse than a refusal at startup. Same rule as the API's
   * `COOKIE_SECRET` check, narrowed to the literal instruction: only
   * `NODE_ENV=production` refuses, so a bench worker with no NODE_ENV set keeps
   * booting on the compose stack the way it always has.
   */
  if (env['NODE_ENV'] === 'production') {
    const defaulted = CREDENTIAL_KEYS.filter((key) => config[key] === DEFAULTS[key]);
    if (defaulted.length > 0) {
      // Names, never values — the same rule as the URL check below.
      throw new Error(
        `Invalid worker configuration: ${defaulted.join(', ')} still ${
          defaulted.length === 1 ? 'has its' : 'have their'
        } published development default, which must not run in production`,
      );
    }
  }

  for (const key of ['DATABASE_URL', 'REDIS_URL', 'S3_ENDPOINT'] as const) {
    if (!URL.canParse(config[key])) {
      // Prints the offending variable NAME, never its value — a connection
      // string carries a password.
      throw new Error(`Invalid worker configuration: ${key} is not an absolute URL`);
    }
  }
  return config;
}
