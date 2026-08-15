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
 *
 * One exception: a variable set to a blank value counts as not set, so the file
 * supplies it. See the comment below for why that needs an explicit delete.
 */
const envFile = fileURLToPath(new URL('../../../infra/.env', import.meta.url));

if (existsSync(envFile)) {
  // Snapshot and restore the inline environment explicitly rather than relying
  // on `loadEnvFile`'s own precedence (verified on Node 24: it skips variables
  // already present, but that is not worth depending on).
  //
  // Blanks are the exception, and deleting them is load-bearing: `loadEnvFile`
  // only fills variables that are ABSENT, so a blank left in place would shadow
  // the file's entry. `withoutBlanks` in config.ts then discards that blank —
  // silently falling through to the built-in default and ignoring the .env
  // value entirely. Same blank test as `withoutBlanks`, so the two agree.
  const explicit: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && value.trim() !== '') explicit[key] = value;
    else delete process.env[key];
  }

  process.loadEnvFile(envFile);
  Object.assign(process.env, explicit);
}
