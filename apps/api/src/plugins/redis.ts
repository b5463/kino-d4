import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import type { ApiConfig } from '../config';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

export interface RedisPluginOptions {
  config: ApiConfig;
}

export const redisPlugin = fp<RedisPluginOptions>(
  async (app, opts) => {
    const client = new Redis(opts.config.REDIS_URL, {
      // Connect on first command rather than at boot, so building the server
      // never blocks and tests can construct it without a live Redis.
      lazyConnect: true,
      // Bound the retry loop; a health probe must fail fast, not hang.
      maxRetriesPerRequest: 2,
      connectTimeout: 5_000,
    });

    // ioredis emits 'error' on an unhandled socket failure; without a listener
    // that becomes an uncaught exception and kills the process.
    client.on('error', (err: Error) => {
      app.log.error({ err }, 'redis client error');
    });

    app.decorate('redis', client);
    app.addHook('onClose', async () => {
      // `disconnect()` is safe whether or not the lazy connection was opened;
      // `quit()` rejects when the client never connected.
      client.disconnect();
    });
  },
  { name: 'kino-redis' },
);
