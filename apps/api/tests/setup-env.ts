import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Loads `infra/.env` into `process.env` for the test run, using Node's built-in
 * env-file parser — no dotenv dependency.
 *
 * Precedence matches `node --env-file`: a variable already present in the
 * environment wins over the file, so a one-off inline override
 * (`DATABASE_URL=... npm run test -w @kino/api`) still takes effect, and CI —
 * which sets everything explicitly and ships no .env — is unaffected.
 */
const envFile = fileURLToPath(new URL('../../../infra/.env', import.meta.url));

if (existsSync(envFile)) {
  const explicit = { ...process.env };
  process.loadEnvFile(envFile);
  Object.assign(process.env, explicit);
}
