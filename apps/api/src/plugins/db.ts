import fp from 'fastify-plugin';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { ApiConfig } from '../config';
import * as schema from '../db/schema';

export type KinoDatabase = PostgresJsDatabase<typeof schema>;

/**
 * The handle a `db.transaction(async (tx) => ...)` callback receives.
 *
 * Derived from `KinoDatabase` rather than named directly, so it cannot drift
 * from the database type it belongs to. Needed wherever work has to run
 * *inside* a caller's transaction — `SELECT ... FOR UPDATE` is only a lock for
 * as long as the transaction that took it is open, so a helper that quietly
 * used `app.db` instead would take the lock and drop it in the same breath.
 */
export type KinoTransaction = Parameters<Parameters<KinoDatabase['transaction']>[0]>[0];

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
      // The pool holds 10 connections for every route. A statement that hangs
      // (lock, dead storage behind a trigger, runaway query) must release its
      // connection instead of wedging the pool.
      //
      // `idle_in_transaction_session_timeout` closes the other half of that.
      // `statement_timeout` only bounds a statement that is *running*; a
      // transaction that has finished a statement and is waiting on something
      // outside PostgreSQL — an S3 round trip, a queue add, a stalled event
      // loop — is idle, so no statement timer applies to it, and it keeps both
      // its connection and every row lock it took. Ten of those is the whole
      // pool, held by requests that are not asking the database for anything.
      // 20 s is above the slowest legitimate transaction in the API (a few
      // indexed statements, single-digit milliseconds) by three orders of
      // magnitude, so anything it kills is genuinely wedged.
      connection: { statement_timeout: 15_000, idle_in_transaction_session_timeout: 20_000 },
      onnotice: () => {},
    });

    app.decorate('db', drizzle(client, { schema }));
    app.addHook('onClose', async () => {
      await client.end({ timeout: 5 });
    });
  },
  { name: 'kino-db' },
);
