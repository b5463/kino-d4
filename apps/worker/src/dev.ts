// Development entry (`npm run dev -w @kino/worker`): loads infra/.env if
// present so dev overrides (queue names, storage endpoints) actually reach
// the process — main.ts reads only real environment variables (issue #86).
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

try {
  loadEnvFile(fileURLToPath(new URL('../../../infra/.env', import.meta.url)));
} catch {
  // No infra/.env — the defaults cover a clean checkout.
}
process.env.NODE_ENV ??= 'development';

await import('./main');
