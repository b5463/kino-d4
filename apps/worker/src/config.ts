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
