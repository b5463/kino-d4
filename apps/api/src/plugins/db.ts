import fp from 'fastify-plugin';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { ApiConfig } from '../config';

/** No tables yet — Task 15 introduces the schema. */
export type KinoDatabase = PostgresJsDatabase<Record<string, never>>;

declare module 'fastify' {
  interface FastifyInstance {
    db: KinoDatabase;
  }
}

export interface DbPluginOptions {
  config: ApiConfig;
}

export const dbPlugin = fp<DbPluginOptions>(
  async (app, opts) => {
    const client = postgres(opts.config.DATABASE_URL, {
      max: 10,
      connect_timeout: 5,
      onnotice: () => {},
    });

    app.decorate('db', drizzle(client));
    app.addHook('onClose', async () => {
      await client.end({ timeout: 5 });
    });
  },
  { name: 'kino-db' },
);
