import { PassThrough } from 'node:stream';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { rollOf } from '../auth/plugins';
import { openRollEventFeed } from '../events/feed';
import { isStreamId, readRollHistory, type RollEventDelivery } from '../events/publish';
import { fail } from './errors';
import { SSE_HEARTBEAT_MS, SSE_RETRY_MS } from './guest-events';

/**
 * A bearer-authenticated copy of the Roll event stream for the host dashboard.
 *
 * The guest stream cannot be used here: once a host enables a PIN, it requires
 * a guest cookie the host dashboard neither owns nor should synthesize. This
 * route resolves the same durable Redis stream through the host token, without
 * registering the dashboard as a guest viewer.
 */
export const hostEventRoutes: FastifyPluginAsync = async (app) => {
  const openConnections = new Set<() => void>();
  const endAll = (): void => {
    for (const close of [...openConnections]) close();
  };

  const stopWatchingConnection = app.rollEvents.onConnectionLost(endAll);
  app.addHook('onClose', async () => {
    stopWatchingConnection();
    endAll();
  });

  app.get(
    '/api/host/rolls/:rollId/events',
    { preHandler: app.requireHost('rollId') },
    async (request, reply) => {
      const roll = rollOf(request);
      const lastEventId = requestedLastEventId(request);
      if (lastEventId === 'invalid') {
        return fail(
          reply,
          400,
          'INVALID_LAST_EVENT_ID',
          'Last-Event-ID must be a Redis stream entry id (<ms>-<seq>)',
        );
      }

      const stream = new PassThrough();
      let release: (() => Promise<void>) | null = null;
      let heartbeat: NodeJS.Timeout | null = null;
      let closed = false;

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        openConnections.delete(cleanup);
        if (heartbeat !== null) clearInterval(heartbeat);
        const stop = release;
        release = null;
        if (stop !== null) void stop().catch(() => {});
        stream.end();
      };

      openConnections.add(cleanup);
      reply.raw.on('close', cleanup);
      stream.on('error', cleanup);

      try {
        release = await openRollEventFeed({
          bus: app.rollEvents,
          rollId: roll.id,
          lastEventId,
          readHistory: (afterId) => readRollHistory(app.redis, roll.id, afterId),
          deliver: (delivery) => stream.write(frameOf(delivery)),
        });
        if (closed) await release();
      } catch (err) {
        cleanup();
        throw err;
      }

      if (!closed) heartbeat = setInterval(() => stream.write(': heartbeat\n\n'), SSE_HEARTBEAT_MS);
      stream.write(`retry: ${SSE_RETRY_MS}\n\n`);

      reply.header('content-type', 'text/event-stream; charset=utf-8');
      reply.header('cache-control', 'no-cache, no-store, no-transform');
      reply.header('connection', 'keep-alive');
      reply.header('x-accel-buffering', 'no');
      return reply.send(stream);
    },
  );
};

function frameOf(delivery: RollEventDelivery): string {
  return [
    `id: ${delivery.id}`,
    `event: ${delivery.event.type}`,
    `data: ${JSON.stringify(delivery.event)}`,
    '',
    '',
  ].join('\n');
}

function requestedLastEventId(request: FastifyRequest): string | null | 'invalid' {
  const header = request.headers['last-event-id'];
  const query: unknown = request.query;
  const fromQuery =
    typeof query === 'object' && query !== null
      ? (query as Record<string, unknown>)['lastEventId']
      : undefined;
  const raw =
    typeof header === 'string'
      ? header
      : Array.isArray(header)
        ? header[0]
        : typeof fromQuery === 'string'
          ? fromQuery
          : undefined;
  if (raw === undefined || raw.trim() === '') return null;
  return isStreamId(raw) ? raw : 'invalid';
}
