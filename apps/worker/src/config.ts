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
export interface WorkerConfig {
  DATABASE_URL: string;
  REDIS_URL: string;
  JOB_QUEUE_PREFIX: string;
  S3_ENDPOINT: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_REGION: string;
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
};

/**
 * A variable set to an empty string counts as "not set", so that a blank line
 * in a .env file falls back to the default instead of producing an empty
 * connection string. Same rule as the API's `withoutBlanks`.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof WorkerConfig)[]) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') config[key] = value;
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
