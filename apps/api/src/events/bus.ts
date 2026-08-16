import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { parseRollEventMessage, rollEventChannel, type RollEventDelivery } from './publish';

/**
 * One Redis connection for every live guest in the process.
 *
 * ## Why a shared subscriber and not a connection per stream
 *
 * ioredis puts a connection into *subscribe mode* when it subscribes: that
 * connection can then issue nothing but (un)subscribe commands. So `app.redis`
 * cannot be used — the first SSE connection would break every other query in
 * the server — and something has to own the subscription.
 *
 * The obvious answer, `app.redis.duplicate()` per SSE request, is the one that
 * fails the acceptance test it is written for. 07 §24 asks for 50 viewers on a
 * roll; a party has several rolls; the API runs more than one instance. That is
 * 50 × rolls × instances Redis connections, all idle, all counted against
 * `maxclients`, all re-established on every reconnect — and SSE reconnects
 * constantly, because that is what mobile screen-lock does to it.
 *
 * So: exactly one subscriber connection per process, with per-channel
 * SUBSCRIBE and a reference count. N guests on one roll cost one subscription;
 * the connection count does not move with the guest list at all.
 *
 * ## Why per-channel and not PSUBSCRIBE roll:*:events
 *
 * A pattern subscription would deliver every roll's events to every instance,
 * including the rolls nobody in this process is watching, and leave the
 * filtering to JavaScript. Per-channel keeps that work in Redis, where the
 * channel name already is the index.
 *
 * ## The cost of sharing, and what actually recovers from it
 *
 * One connection's failure affects every live guest — and the failure is
 * *silent* from the guest's side, which is the part that matters. ioredis
 * reconnects and re-subscribes on its own, but events published during the blip
 * were only ever on the channel, and nothing on the guest's end noticed:
 * their SSE socket is perfectly healthy, so their EventSource never reconnects,
 * never sends `Last-Event-ID`, and never replays. Those events are gone for the
 * rest of the party.
 *
 * So the loss is announced rather than assumed away. `onConnectionLost` fires
 * when the subscriber's socket closes, and `guest-events.ts` responds by
 * **ending every open SSE response**. That converts a silent server-side fault
 * into the one failure the client already knows how to recover from: the
 * browser reconnects after `retry` (3 s) with `Last-Event-ID`, and the gap is
 * replayed out of the stream — the path the reconnect tests already cover.
 */
export type RollEventListener = (delivery: RollEventDelivery) => void;

export class RollEventBus {
  /** Channel -> the feeds that want it. An empty set is deleted, not kept. */
  private readonly listeners = new Map<string, Set<RollEventListener>>();
  /** Channels Redis is actually subscribed to right now. */
  private readonly subscribed = new Set<string>();
  /**
   * Subscribe/unsubscribe are serialised through this chain. Without it, a
   * guest leaving and another arriving on the same roll in the same tick could
   * interleave their commands and settle on the wrong state — the arriving
   * guest subscribed, then the leaving one's UNSUBSCRIBE landing after it.
   */
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** Notified when the subscriber's socket drops; see the header. */
  private readonly connectionLostListeners = new Set<() => void>();

  constructor(
    private readonly subscriber: Redis,
    private readonly log: FastifyBaseLogger,
  ) {
    this.subscriber.on('message', (channel: string, message: string) => {
      this.dispatch(channel, message);
    });

    // 'close' covers the drop that ioredis will reconnect from; 'end' the one
    // it has given up on. Both mean the same thing to a live guest — events may
    // have been published that this process never saw — so both are announced.
    // Duplicate announcements are harmless: ending a stream is idempotent.
    const lost = (): void => this.announceConnectionLost();
    this.subscriber.on('close', lost);
    this.subscriber.on('end', lost);
  }

  /** How many roll channels currently have at least one listener. */
  get activeChannels(): number {
    return this.listeners.size;
  }

  /**
   * Adds a listener for one roll and returns its release function. Awaiting
   * this resolves only once Redis has confirmed the SUBSCRIBE, so a caller that
   * publishes afterwards is guaranteed to see its own event — which is what
   * lets the SSE feed subscribe *before* it reads history.
   */
  async subscribe(rollId: string, listener: RollEventListener): Promise<() => Promise<void>> {
    if (this.closed) throw new Error('the roll event bus is closed');

    const channel = rollEventChannel(rollId);
    const listeners = this.listeners.get(channel) ?? new Set<RollEventListener>();
    listeners.add(listener);
    this.listeners.set(channel, listeners);

    try {
      await this.reconcile(channel);
    } catch (err) {
      this.forget(channel, listener);
      throw err;
    }

    let released = false;
    return async (): Promise<void> => {
      if (released) return;
      released = true;
      this.forget(channel, listener);
      await this.reconcile(channel);
    };
  }

  /**
   * Registers a listener for "the subscriber connection dropped, so events may
   * have been missed"; returns its removal function.
   *
   * The bus deliberately does not decide what that means — it cannot know that
   * the answer is "end the SSE responses so the browsers replay". The route
   * owns the connections and owns that decision.
   */
  onConnectionLost(listener: () => void): () => void {
    this.connectionLostListeners.add(listener);
    return () => {
      this.connectionLostListeners.delete(listener);
    };
  }

  /** Drops every subscription and closes the connection. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    // Waits for any in-flight (un)subscribe so the disconnect below cannot cut
    // one in half and leave ioredis retrying it against a dead socket.
    await this.pending.catch(() => {});
    this.subscribed.clear();
    // `disconnect()` rather than `quit()`: the connection may never have been
    // opened (lazyConnect), and `quit()` rejects in that case.
    this.subscriber.disconnect();
  }

  private announceConnectionLost(): void {
    // Not on the way out: `close()` disconnects deliberately, and the streams
    // are already being ended by the server's own shutdown.
    if (this.closed) return;

    for (const listener of [...this.connectionLostListeners]) {
      try {
        listener();
      } catch (err) {
        this.log.error({ err }, 'a roll event connection-loss listener threw');
      }
    }
  }

  private forget(channel: string, listener: RollEventListener): void {
    const listeners = this.listeners.get(channel);
    if (listeners === undefined) return;
    listeners.delete(listener);
    if (listeners.size === 0) this.listeners.delete(channel);
  }

  /**
   * Brings Redis's subscription for one channel in line with whether anything
   * still wants it. Serialised, and re-reads the listener set when it runs, so
   * a subscribe and an unsubscribe queued in the same tick settle on the state
   * that is true at the end rather than the one that was true when they were
   * queued.
   */
  private reconcile(channel: string): Promise<void> {
    const next = this.pending.then(
      () => this.apply(channel),
      () => this.apply(channel),
    );
    // The chain must not reject, or every later operation would inherit it.
    this.pending = next.catch(() => {});
    return next;
  }

  private async apply(channel: string): Promise<void> {
    const wanted = !this.closed && (this.listeners.get(channel)?.size ?? 0) > 0;
    const have = this.subscribed.has(channel);
    if (wanted === have) return;

    if (wanted) {
      await this.subscriber.subscribe(channel);
      this.subscribed.add(channel);
      return;
    }
    await this.subscriber.unsubscribe(channel);
    this.subscribed.delete(channel);
  }

  private dispatch(channel: string, message: string): void {
    const listeners = this.listeners.get(channel);
    if (listeners === undefined || listeners.size === 0) return;

    const delivery = parseRollEventMessage(message);
    if (delivery === null) {
      // Not an event this build understands, or not an event at all. Dropping
      // it is better than forwarding something unparsed to a guest, and saying
      // so is better than dropping it silently.
      this.log.warn({ channel }, 'ignored an unrecognised roll event message');
      return;
    }

    // A copy: a listener may release itself while being called.
    for (const listener of [...listeners]) {
      try {
        listener(delivery);
      } catch (err) {
        // One guest's broken socket must not cost every other guest the event.
        this.log.error({ err, channel }, 'a roll event listener threw');
      }
    }
  }
}
