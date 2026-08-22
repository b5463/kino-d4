import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadConfig } from './config';

const config = loadConfig();
const client = postgres(config.DATABASE_URL, { max: 1 });

try {
  // Resolved from this file, not the cwd — the old relative path only worked
  // when launched from the repo root (issue #86).
  await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  console.log('[migrate] database is current');
} finally {
  await client.end();
}
