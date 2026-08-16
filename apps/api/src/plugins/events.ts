import fp from 'fastify-plugin';
import { RollEventBus } from '../events/bus';

declare module 'fastify' {
  interface FastifyInstance {
    /** The process-wide subscriber for roll events; see `events/bus.ts`. */
    rollEvents: RollEventBus;
  }
}

/**
 * Owns the one Redis connection that listens for roll events.
 *
 * It is a `duplicate()` of `app.redis` rather than a second client built from
 * config, so both share one place where connection options are decided —
 * including `lazyConnect`, which means building a server still opens no socket
 * and a deployment with no live guests never connects this one at all.
 *
 * `app.redis` itself cannot do this job: ioredis puts a connection into
 * subscribe mode when it subscribes, after which it refuses ordinary commands,
 * and the first SSE guest would take every query in the server down with it.
 */
export const eventsPlugin = fp(
  async (app) => {
    const subscriber = app.redis.duplicate();

    // Same reasoning as the main client: an unhandled 'error' on an ioredis
    // socket is an uncaught exception, and that kills the process.
    subscriber.on('error', (err: Error) => {
      app.log.error({ err }, 'redis subscriber error');
    });

    const bus = new RollEventBus(subscriber, app.log);
    app.decorate('rollEvents', bus);
    app.addHook('onClose', async () => {
      await bus.close();
    });
  },
  { name: 'kino-roll-events', dependencies: ['kino-redis'] },
);
