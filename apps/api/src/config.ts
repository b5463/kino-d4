import { isIP } from 'node:net';
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
 * The committed dev value for `PROVISIONING_TOKEN`, on exactly the same footing
 * as `DEV_COOKIE_SECRET`: published here and in `infra/.env.example`, therefore
 * not a secret, therefore refused outside `DEV_ENVIRONMENTS`.
 */
export const DEV_PROVISIONING_TOKEN = 'kino-dev-provisioning-token-do-not-use-in-production';

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

/**
 * "Is this provably a development environment?" — the one question the cookie
 * secret, the provisioning token, the registration mode **and** the CORS policy
 * all key on.
 *
 * Exported because `server.ts` needs the same answer. It used to ask the
 * opposite question (`NODE_ENV !== 'production'`) and therefore reflected
 * localhost origins on a `credentials: true` policy whenever a deployment
 * forgot to set NODE_ENV at all — the exact mistake every check in this file
 * exists to survive.
 */
export function isDevEnvironment(nodeEnv: string | undefined): boolean {
  return nodeEnv !== undefined && DEV_ENVIRONMENTS.has(nodeEnv);
}

/**
 * What Fastify's `trustProxy` is allowed to be, and why it is no longer a
 * boolean.
 *
 * `true` trusts **every** hop, which means whatever a client puts in
 * `X-Forwarded-For` becomes `request.ip`: every per-address rate limit, the
 * guest slug-miss lock and the audit log then key on a value the attacker
 * chose. The variable therefore has to say *which* hop it trusts.
 *
 * Accepted spellings:
 *
 *   false                  no proxy; the socket address is the client (default)
 *   <n>                    trust n hops from the server (proxy-addr semantics)
 *   loopback,uniquelocal   a comma-separated list of presets, addresses or CIDRs
 *
 * Production behind Caddy wants the **list** form, not a count. The relay path
 * is client → VPS Caddy → frp → PC Caddy → api, so the number of internal hops
 * that append to `X-Forwarded-For` depends on whether the relay overlay is in
 * play; a count that is right for one file is wrong for the other. A list of
 * private ranges is right for both: proxy-addr walks the header right to left,
 * discards every entry that is inside the Compose/loopback space, and stops at
 * the first public address — which is the guest. A forged prefix sits to the
 * *left* of the real one and is never reached.
 *
 * `true` is refused rather than silently accepted: a deployment that means "one
 * proxy" must say `1`, and one behind Caddy must name the private ranges.
 *
 * The one honest limit of the list form: it assumes the real client arrives
 * from a public address. A request from inside the operator's own LAN is itself
 * "trusted", so the walk continues past it and a forged entry to its left would
 * be believed. That costs a bench operator a wrong `request.ip` in a rate-limit
 * key and nothing else — no gate keys on the address — and the hop-count form
 * is there for a deployment where LAN clients matter.
 */
const TRUST_PROXY_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

export type TrustProxySetting = boolean | number | string[];

function parseTrustProxy(raw: string): TrustProxySetting | null {
  const value = raw.trim();
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return hops >= 1 ? hops : null;
  }

  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => entry === '')) return null;
  for (const entry of entries) {
    if (TRUST_PROXY_PRESETS.has(entry)) continue;
    // `10.0.0.0/8` and a bare address are both legal proxy-addr entries; only
    // the address half is checked, because the prefix length is proxy-addr's
    // to validate and it says so loudly.
    const address = entry.split('/')[0] ?? '';
    if (isIP(address) !== 0) continue;
    return null;
  }
  return entries;
}

export const configSchema = z.object({
  // Host port 5435 -> container 5432; see infra/docker-compose.dev.yml.
  DATABASE_URL: absoluteUrl.default('postgres://kino:kino@localhost:5435/kino'),
  // Host port 6380, not 6379: another project owns a 6379 mapping.
  REDIS_URL: absoluteUrl.default('redis://localhost:6380'),
  // Shared with the worker. Tests may isolate a real producer/consumer pair
  // without letting that worker consume another suite's jobs.
  JOB_QUEUE_PREFIX: z.string().min(1).default('kino-jobs'),
  // Optional in development; production Compose requires it. The route is a
  // 404 when absent so metrics cannot be exposed accidentally.
  METRICS_TOKEN: z.string().min(24).optional(),
  S3_ENDPOINT: absoluteUrl.default('http://localhost:9000'),
  S3_BUCKET: z.string().min(1).default('kino-media'),
  S3_FIRMWARE_BUCKET: z.string().min(1).default('kino-firmware'),
  S3_ACCESS_KEY: z.string().min(1).default('kino'),
  S3_SECRET_KEY: z.string().min(1).default('kino-secret'),
  // MinIO ignores the region but the AWS SDK requires one to sign requests.
  S3_REGION: z.string().min(1).default('us-east-1'),
  PUBLIC_BASE_URL: absoluteUrl.default('https://kino.acronym.sk'),
  /**
   * The API is normally private behind Caddy. Only then may forwarded client
   * addresses drive per-IP rate limits; direct development defaults closed.
   *
   * See `parseTrustProxy` for the accepted spellings and for why the old
   * boolean `true` is now refused.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .superRefine((value, ctx) => {
      if (parseTrustProxy(value) !== null) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'must be false, a hop count (1, 2, ...), or a comma-separated list of ' +
          'addresses, CIDRs or presets (loopback, linklocal, uniquelocal). ' +
          '`true` trusts every hop and is refused',
      });
    })
    .transform((value) => parseTrustProxy(value) ?? false),
  // Presigned MinIO URLs are convenient in local development. Production
  // keeps MinIO private and streams authorized objects through the API.
  OBJECT_DELIVERY: z.enum(['presigned', 'proxy']).default('presigned'),
  DEVICE_REGISTRATION_MODE: z.enum(['rotate', 'first-write-wins']).default('rotate'),
  // Signs the guest PIN session cookie (05 §13). Not an encryption key: the
  // cookie carries no secret, only a value a guest must not be able to forge.
  COOKIE_SECRET: z.string().min(16).default(DEV_COOKIE_SECRET),
  /**
   * The shared secret a factory bench presents to
   * `POST /api/studio/devices/register` (05 §4). Same treatment as
   * `COOKIE_SECRET`: a published dev default, refused outside a known dev
   * environment by the check below, so production must supply a real one.
   *
   * A *shared* secret is the deliberate limit of this control. It proves the
   * caller is a provisioning station, not which station — so it stops the open
   * internet minting device tokens, and it does not stop a leaked bench secret
   * from doing so. Per-serial HMAC (the station signs `serial`, the API verifies
   * against a per-station key) is the follow-up; it needs a station registry,
   * which V1 has nowhere to put.
   */
  PROVISIONING_TOKEN: z.string().min(16).default(DEV_PROVISIONING_TOKEN),
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
  const isDev = isDevEnvironment(config.NODE_ENV);
  if (!isDev && config.COOKIE_SECRET === DEV_COOKIE_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['COOKIE_SECRET'],
      message:
        'is the published dev default; set a real secret, or set NODE_ENV to development or test',
    });
  }
  // Same direction of test, same reason: a deployment that forgot NODE_ENV must
  // not be the one that quietly accepts a secret printed in the repository.
  if (!isDev && config.PROVISIONING_TOKEN === DEV_PROVISIONING_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PROVISIONING_TOKEN'],
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
    !isDevEnvironment(parsed.data.NODE_ENV)
  ) {
    return { ...parsed.data, DEVICE_REGISTRATION_MODE: 'first-write-wins' };
  }
  return parsed.data;
}
