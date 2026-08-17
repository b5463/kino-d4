import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Loads `infra/.env` into `process.env` for the test run — the same file, the
 * same rules and the same reasoning as `apps/api/tests/setup-env.ts`, because
 * the worker talks to exactly the same dev stack.
 *
 * Precedence matches `node --env-file`: a variable already present in the
 * environment wins over the file, so a one-off inline override still takes
 * effect and CI — which sets everything explicitly and ships no .env — is
 * unaffected. A variable set to a blank value counts as not set.
 */
const envFile = fileURLToPath(new URL('../../../infra/.env', import.meta.url));

if (existsSync(envFile)) {
  // Snapshot and restore the inline environment explicitly rather than relying
  // on `loadEnvFile`'s own precedence. Blanks are deleted first: `loadEnvFile`
  // only fills variables that are ABSENT, so a blank left in place would shadow
  // the file's entry and then be discarded as blank by config loading — falling
  // through to the built-in default and ignoring the .env value entirely.
  const explicit: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && value.trim() !== '') explicit[key] = value;
    else delete process.env[key];
  }

  process.loadEnvFile(envFile);
  Object.assign(process.env, explicit);
}
