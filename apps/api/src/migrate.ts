import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadConfig } from './config';

const config = loadConfig();
const client = postgres(config.DATABASE_URL, { max: 1 });

try {
  await migrate(drizzle(client), { migrationsFolder: 'apps/api/drizzle' });
  console.log('[migrate] database is current');
} finally {
  await client.end();
}
