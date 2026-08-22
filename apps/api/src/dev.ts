// Development entry (`npm run dev -w @kino/api`). Same server as main.ts,
// plus the two things a bare dev start needs on a clean checkout: infra/.env
// if present, and NODE_ENV defaulting to development — without it the config
// guard refuses the published dev COOKIE_SECRET and the process exits before
// listening (issue #86). Production never runs this file.
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

try {
  loadEnvFile(fileURLToPath(new URL('../../../infra/.env', import.meta.url)));
} catch {
  // No infra/.env — the defaults cover a clean checkout.
}
process.env.NODE_ENV ??= 'development';

await import('./main');
