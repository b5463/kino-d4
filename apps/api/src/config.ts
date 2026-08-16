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
 * reach production — `configSchema` refuses to load if it does.
 */
export const DEV_COOKIE_SECRET = 'kino-dev-cookie-secret-do-not-use-in-production';

export const configSchema = z.object({
  // Host port 5435 -> container 5432; see infra/docker-compose.dev.yml.
  DATABASE_URL: absoluteUrl.default('postgres://kino:kino@localhost:5435/kino'),
  // Host port 6380, not 6379: another project owns a 6379 mapping.
  REDIS_URL: absoluteUrl.default('redis://localhost:6380'),
  S3_ENDPOINT: absoluteUrl.default('http://localhost:9000'),
  S3_BUCKET: z.string().min(1).default('kino-media'),
  S3_ACCESS_KEY: z.string().min(1).default('kino'),
  S3_SECRET_KEY: z.string().min(1).default('kino-secret'),
  // MinIO ignores the region but the AWS SDK requires one to sign requests.
  S3_REGION: z.string().min(1).default('us-east-1'),
  PUBLIC_BASE_URL: absoluteUrl.default('https://kino.acronym.sk'),
  // Signs the guest PIN session cookie (05 §13). Not an encryption key: the
  // cookie carries no secret, only a value a guest must not be able to forge.
  COOKIE_SECRET: z.string().min(16).default(DEV_COOKIE_SECRET),
  /**
   * Deliberately a permissive string, not an enum: NODE_ENV is set by tooling
   * outside this project (vitest sets `test`), and an unrecognised value must
   * not stop the server from starting. Only the exact value `test` unlocks the
   * diagnostic auth routes, and only `production` tightens the checks below —
   * so the unset default, `development`, is the safe middle.
   */
  NODE_ENV: z.string().min(1).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

/**
 * Production must not run on the committed dev cookie secret. Anyone with a
 * checkout could otherwise forge a PIN session cookie for any roll.
 */
const validatedConfigSchema = configSchema.superRefine((config, ctx) => {
  if (config.NODE_ENV === 'production' && config.COOKIE_SECRET === DEV_COOKIE_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['COOKIE_SECRET'],
      message: 'is the published dev default and must be set to a real secret when NODE_ENV=production',
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
  const parsed = validatedConfigSchema.safeParse(withoutBlanks(env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Deliberately prints only the offending variable NAMES, never their values.
    throw new Error(`Invalid API configuration:\n${issues}`);
  }
  return parsed.data;
}
