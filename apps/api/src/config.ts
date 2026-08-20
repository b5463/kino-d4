import { z } from 'zod';

/**
 * Every default here mirrors `infra/docker-compose.dev.yml` so that a plain
 * `docker compose -f infra/docker-compose.dev.yml up -d` is the only setup a
 * developer needs. Production supplies real values through the environment.
 */
const absoluteUrl = z
  .string()
  .refine((value) => URL.canParse(value), { message: 'must be an absolute URL' });

/**
 * The committed dev value for `COOKIE_SECRET`. It is published in
 * `infra/.env.example` and in this file, so it is not a secret and must never
 * reach anything but a developer's own machine — see `DEV_ENVIRONMENTS`.
 */
export const DEV_COOKIE_SECRET = 'kino-dev-cookie-secret-do-not-use-in-production';

/**
 * The only `NODE_ENV` values that may run on the published dev cookie secret.
 *
 * Membership is opt-IN, which is the whole point: an unset or unrecognised
 * `NODE_ENV` is refused rather than waved through. Keying the check on
 * `NODE_ENV === 'production'` instead would fail *open* — the single most
 * likely deployment mistake is forgetting to set NODE_ENV at all, and that
 * mistake must not be the one that silently enables a forgeable cookie.
 */
const DEV_ENVIRONMENTS = new Set(['development', 'test']);

export const configSchema = z.object({
  // Host port 5435 -> container 5432; see infra/docker-compose.dev.yml.
  DATABASE_URL: absoluteUrl.default('postgres://kino:kino@localhost:5435/kino'),
  // Host port 6380, not 6379: another project owns a 6379 mapping.
  REDIS_URL: absoluteUrl.default('redis://localhost:6380'),
  S3_ENDPOINT: absoluteUrl.default('http://localhost:9000'),
  S3_BUCKET: z.string().min(1).default('kino-media'),
  S3_FIRMWARE_BUCKET: z.string().min(1).default('kino-firmware'),
  S3_ACCESS_KEY: z.string().min(1).default('kino'),
  S3_SECRET_KEY: z.string().min(1).default('kino-secret'),
  // MinIO ignores the region but the AWS SDK requires one to sign requests.
  S3_REGION: z.string().min(1).default('us-east-1'),
  PUBLIC_BASE_URL: absoluteUrl.default('https://kino.acronym.sk'),
  // The API is normally private behind Caddy. Only then may forwarded client
  // addresses drive per-IP rate limits; direct development defaults closed.
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // Presigned MinIO URLs are convenient in local development. Production
  // keeps MinIO private and streams authorized objects through the API.
  OBJECT_DELIVERY: z.enum(['presigned', 'proxy']).default('presigned'),
  DEVICE_REGISTRATION_MODE: z.enum(['rotate', 'first-write-wins']).default('rotate'),
  // Signs the guest PIN session cookie (05 §13). Not an encryption key: the
  // cookie carries no secret, only a value a guest must not be able to forge.
  COOKIE_SECRET: z.string().min(16).default(DEV_COOKIE_SECRET),
  /**
   * A permissive string, not an enum: NODE_ENV is set by tooling outside this
   * project (vitest sets `test`), and an unrecognised value must not stop the
   * server booting. Deliberately has **no default** — "unset" has to stay
   * distinguishable from "explicitly development", because the cookie-secret
   * check below treats the two differently.
   *
   * Only the exact value `test` unlocks the diagnostic auth routes.
   */
  NODE_ENV: z.string().min(1).optional(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

/**
 * The published dev cookie secret is allowed **only** in a known development
 * environment. Anyone with a checkout could otherwise forge a PIN session
 * cookie for any roll.
 *
 * Note the direction of the test: it does not ask "is this production?", it
 * asks "is this provably development?". An unset, misspelled or unfamiliar
 * NODE_ENV therefore refuses to boot on the default secret instead of quietly
 * accepting it.
 */
const validatedConfigSchema = configSchema.superRefine((config, ctx) => {
  const isDevEnvironment = config.NODE_ENV !== undefined && DEV_ENVIRONMENTS.has(config.NODE_ENV);
  if (!isDevEnvironment && config.COOKIE_SECRET === DEV_COOKIE_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['COOKIE_SECRET'],
      message:
        'is the published dev default; set a real secret, or set NODE_ENV to development or test',
    });
  }
});

export type ApiConfig = z.infer<typeof configSchema>;

/**
 * A variable set to an empty string is treated as "not set", so that a blank
 * line in a .env file falls back to the default instead of failing `min(1)`.
 */
function withoutBlanks(env: NodeJS.ProcessEnv): Record<string, string> {
  const present: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') present[key] = value;
  }
  return present;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const present = withoutBlanks(env);
  const parsed = validatedConfigSchema.safeParse(present);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Deliberately prints only the offending variable NAMES, never their values.
    throw new Error(`Invalid API configuration:\n${issues}`);
  }
  // Rotation is convenient on a developer bench, but unsafe on any reachable
  // deployment: knowing a printed serial would rotate the real device's token.
  // Like the cookie-secret policy, an unset or unfamiliar environment fails
  // closed. An explicit variable can still select a recovery mode deliberately.
  if (
    present['DEVICE_REGISTRATION_MODE'] === undefined &&
    (parsed.data.NODE_ENV === undefined || !DEV_ENVIRONMENTS.has(parsed.data.NODE_ENV))
  ) {
    return { ...parsed.data, DEVICE_REGISTRATION_MODE: 'first-write-wins' };
  }
  return parsed.data;
}
