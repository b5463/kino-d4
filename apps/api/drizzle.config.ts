import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';
import { loadConfig } from './src/config';

/**
 * drizzle-kit runs OUTSIDE the server process, so nothing has loaded
 * `infra/.env` yet — that file is otherwise pulled in by `tests/setup-env.ts`.
 * Load it here too, so `npx drizzle-kit migrate` targets the same database the
 * test suite and the server do. Precedence matches `node --env-file`: a
 * variable already exported in the shell wins over the file.
 *
 * The URL itself still comes from `loadConfig()`, so the dev default
 * (`postgres://kino:kino@localhost:5435/kino`) has exactly one definition.
 */
const envFile = fileURLToPath(new URL('../../infra/.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: loadConfig().DATABASE_URL },
  strict: true,
  verbose: true,
});
