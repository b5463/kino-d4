import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { guestReadRateLimit } from '../plugins/rateLimits';
import { rollOf } from '../auth/plugins';
import { isStreamId, readRollHistory, type RollEventDelivery } from '../events/publish';
import { openRollEventFeed } from '../events/feed';
import { dropRollViewer, touchRollViewer } from '../events/viewers';
import { fail } from './errors';

/**
 * The guest's live feed (03 §7, 05 §10): `GET /api/rolls/:slug/events`.
 *
 * Same access rules as the rest of the guest URL space — `guestRollAccess`
 * resolves the slug and enforces the PIN gate, and `robotsPlugin` puts
 * `X-Robots-Tag` on the response, including on the 401 that gate produces.
 *
 * The response is an SSE stream that never ends on its own. Three things make
 * that survivable on a phone at a party:
 *
 * - **`retry: 3000`** — the reconnect interval the browser uses after the
 *   connection drops, which on mobile is every screen lock.
 * - **`id:` on every event**, carrying the Redis stream entry id. The browser
 *   sends the last one back as `Last-Event-ID`, and `openRollEventFeed` replays
 *   the gap from the stream. This is what makes a reconnect lossless rather
 *   than merely quick.
 * - **a heartbeat comment every 25 s** — an SSE stream that says nothing for
 *   minutes is indistinguishable from a hung one to every proxy between here
 *   and the guest, and they close it. A comment line is ignored by EventSource
 *   and costs 12 bytes.
 *
 * Events are named (`event: capture.created`), matching 03 §7's list, so a
 * client can `addEventListener` per type; the payload repeats the type so a
 * single handler works too. The payload is ids only — the PWA re-fetches
 * (05 §10) rather than trusting a copy of the capture that was made before the
 * derivative it is about finished rendering.
 *
 * ## Why a stream and not `reply.hijack()` + `reply.raw.write()`
 *
 * Hijacking takes the reply out of Fastify's pipeline, and `onSend` hooks stop
 * running with it — including `robotsPlugin`, whose whole design (`rolls/
 * robots.ts`) is that no route can forget the header. Sending a `PassThrough`
 * keeps the response an ordinary Fastify reply that happens not to end, so the
 * guest URL space stays uniformly noindex. `sse.test.ts` asserts the header on
 * this route rather than trusting the reasoning.
 */

/** What a disconnected client waits before reconnecting. */
export const SSE_RETRY_MS = 3_000;

/** How often an idle stream proves it is alive. */
export const SSE_HEARTBEAT_MS = 25_000;

/**
 * How much unread data one guest may accumulate before the connection is
 * dropped. Events are a couple of hundred bytes, so this is thousands of them:
 * reaching it means the socket has stopped draining entirely. Dropping such a
 * client is safe *because* of `Last-Event-ID` — it reconnects and replays what
 * it missed, which is a better outcome than the server holding an unbounded
 * buffer for a connection that is already gone.
 */
const MAX_BUFFERED_BYTES = 64 * 1024;

export interface GuestEventRoutesOptions {
  /**
   * Heartbeat interval, defaulting to `SSE_HEARTBEAT_MS`. An option rather than
   * a constant so a test can mount a second, faster copy of this route instead
   * of waiting 25 s or reaching inside the handler for a hook.
   */
  heartbeatMs?: number;
}

/** One SSE frame: id, event name, and the event JSON as its data. */
function frameOf(delivery: RollEventDelivery): string {
  return [
    `id: ${delivery.id}`,
    `event: ${delivery.event.type}`,
    `data: ${JSON.stringify(delivery.event)}`,
    '',
    '',
  ].join('\n');
}

/** `Last-Event-ID`, from the header EventSource sends or the query fallback. */
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

export const guestEventRoutes: FastifyPluginAsync<GuestEventRoutesOptions> = async (app, opts) => {
  const heartbeatMs = opts.heartbeatMs ?? SSE_HEARTBEAT_MS;

  /**
   * Every open connection's teardown. Without this, `app.close()` would wait on
   * responses that by definition never finish, and a shutdown would hang until
   * something forced the sockets shut.
   */
  const openConnections = new Set<() => void>();

  const endAll = (): void => {
    for (const close of [...openConnections]) close();
  };

  /**
   * If the shared subscriber's connection drops, this process stops seeing
   * events while every guest's own socket stays perfectly healthy — so nothing
   * on their side would ever notice, and their `Last-Event-ID` recovery would
   * never fire. Ending their responses is what makes it fire: the browser
   * reconnects after `retry` (3 s) and replays the gap from the stream, which
   * is the path the reconnect tests already cover.
   *
   * Ending a stream is a cheap, self-correcting response to an ambiguous
   * signal. Guessing that the blip was short enough not to matter is not.
   */
  const stopWatchingConnection = app.rollEvents.onConnectionLost(() => {
    if (openConnections.size === 0) return;
    app.log.warn(
      { streams: openConnections.size },
      'roll event subscriber connection lost; ending SSE streams so clients reconnect and replay',
    );
    endAll();
  });

  app.addHook('onClose', async () => {
    stopWatchingConnection();
    endAll();
  });

  app.get('/api/rolls/:slug/events', { config: guestReadRateLimit, preHandler: app.guestRollAccess }, async (request, reply) => {
    const roll = rollOf(request);

    const lastEventId = requestedLastEventId(request);
    if (lastEventId === 'invalid') {
      // A browser can only ever send back an id this route issued, so this is a
      // hand-rolled client with a malformed one. Answering plainly beats
      // silently starting it from live and leaving it to wonder what it missed.
      return fail(
        reply,
        400,
        'INVALID_LAST_EVENT_ID',
        'Last-Event-ID must be a Redis stream entry id (<ms>-<seq>)',
      );
    }

    const stream = new PassThrough();
    const connectionId = randomUUID();
    let release: (() => Promise<void>) | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let closed = false;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      openConnections.delete(cleanup);

      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }

      const stop = release;
      release = null;
      if (stop !== null) {
        void stop().catch((err: unknown) => {
          app.log.warn({ err, rollId: roll.id }, 'roll event unsubscribe failed');
        });
      }

      void dropRollViewer(app.redis, roll.id, connectionId).catch((err: unknown) => {
        // The viewer's score stops being refreshed either way, so the count
        // still corrects itself within VIEWER_STALE_MS.
        app.log.warn({ err, rollId: roll.id }, 'roll viewer was not removed');
      });

      stream.end();
    };

    const write = (chunk: string): void => {
      if (closed) return;
      if (stream.writableLength > MAX_BUFFERED_BYTES) {
        app.log.warn({ rollId: roll.id }, 'dropping an SSE client that stopped reading');
        cleanup();
        return;
      }
      stream.write(chunk);
    };

    openConnections.add(cleanup);
    // Registered before the first await: a client that disconnects while the
    // subscription is still being set up must still be torn down.
    reply.raw.on('close', cleanup);
    stream.on('error', cleanup);

    try {
      release = await openRollEventFeed({
        bus: app.rollEvents,
        rollId: roll.id,
        lastEventId,
        readHistory: (afterId) => readRollHistory(app.redis, roll.id, afterId),
        deliver: (delivery) => write(frameOf(delivery)),
      });
      // The client can disconnect during that await, in which case `cleanup`
      // has already run and never saw this feed. Release it here — and stop,
      // rather than registering a viewer nobody will ever remove.
      if (closed) await release();
      else await touchRollViewer(app.redis, roll.id, connectionId);
    } catch (err) {
      cleanup();
      throw err;
    }

    if (!closed) {
      heartbeat = setInterval(() => {
        write(': heartbeat\n\n');
        void touchRollViewer(app.redis, roll.id, connectionId).catch((err: unknown) => {
          app.log.warn({ err, rollId: roll.id }, 'roll viewer heartbeat was not recorded');
        });
      }, heartbeatMs);
    }

    write(`retry: ${SSE_RETRY_MS}\n\n`);

    reply.header('content-type', 'text/event-stream; charset=utf-8');
    // `no-transform` matters as much as `no-cache`: a proxy that buffers to
    // compress an event stream turns it into a stream that arrives all at once.
    reply.header('cache-control', 'no-cache, no-store, no-transform');
    reply.header('connection', 'keep-alive');
    // nginx's own opt-out of response buffering, ignored by everything else.
    reply.header('x-accel-buffering', 'no');
    return reply.send(stream);
  });
};
