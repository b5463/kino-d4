import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';
import { configSchema } from './src/config';

/**
 * drizzle-kit runs OUTSIDE the server process, so nothing has loaded
 * `infra/.env` yet — that file is otherwise pulled in by `tests/setup-env.ts`.
 * Load it here too, so `npm run db:migrate` targets the same database the test
 * suite and the server do. Precedence matches `node --env-file`: a variable
 * already exported in the shell wins over the file.
 */
const envFile = fileURLToPath(new URL('../../infra/.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

/**
 * Only `DATABASE_URL` is parsed, not the whole config — a schema migration has
 * no business needing a cookie secret, and `loadConfig()` would (correctly)
 * refuse to run outside a known dev environment while still on the published
 * default one. Reusing the field's own schema keeps the dev default
 * (`postgres://kino:kino@localhost:5435/kino`) defined in exactly one place.
 *
 * A blank value counts as unset, matching `withoutBlanks` in config.ts.
 */
const databaseUrl = configSchema.shape.DATABASE_URL.parse(
  process.env.DATABASE_URL?.trim() === '' ? undefined : process.env.DATABASE_URL,
);

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
