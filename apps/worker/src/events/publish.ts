import type { Redis } from 'ioredis';

/**
 * The publish half of the 05 §10 real-time flow, as much of it as a worker needs.
 *
 * **`apps/api/src/events/publish.ts` is the source of truth.** This is a narrow
 * mirror, for the same reason `db/schema.ts` is: the API's module is a Fastify-
 * adjacent file that also carries the subscriber side — the parser, the replay
 * reader, the stream-id comparison — and a worker that imported it would be
 * importing the whole event bus to announce one thing.
 *
 * What a worker announces is exactly one event type. A derivative it just wrote
 * is now fetchable, and a guest's tile should stop showing a placeholder. It
 * never publishes `roll.opened`, `capture.created` or anything else: those are
 * statements about a roll or a device's upload, and a worker is neither.
 *
 * The mirror is *checked*, not trusted: `tests/imageJobs.test.ts` asserts that
 * the key and channel names here equal the API's and that the API's own
 * `parseRollEvent` accepts what this publishes. A name that drifted would
 * otherwise mean a worker writing events into a stream nothing reads.
 *
 * Order matters and is the API's, verbatim: XADD first, then PUBLISH. A publish
 * that dies halfway has still recorded the event, so every live subscriber finds
 * it on the next reconnect. The other order loses it for everyone who was not
 * connected at that instant.
 */

/** How many events a roll's stream keeps, and therefore how far back a replay reaches. */
export const ROLL_STREAM_MAXLEN = 500;

/**
 * How long a roll's stream key survives its last event.
 *
 * `MAXLEN ~ 500` bounds how *tall* one stream gets and says nothing about how
 * many streams exist: every roll ever opened kept a key forever, so a venue
 * running a KINO every weekend grows Redis by one stream a party and never gives
 * one back. Redis is the ephemeral half of this platform — PostgreSQL and the
 * bucket are the durable record — so a stream that outlives every possible
 * reader is pure cost.
 *
 * Seven days, refreshed on every publish. The reader this protects is a guest
 * who closed the tab at the party and opens it again on the way home, or the
 * next morning; nobody replays a week-old feed, and by then the PWA fetches the
 * capture list rather than the event log. It is also the same window as the
 * trash grace period, so "how long does a roll's history stay warm" has one
 * answer.
 *
 * The refresh is what makes this safe for a live roll: any publish — the API's
 * or a worker's — pushes the expiry out again, so a stream only ever dies after
 * a full week of silence.
 */
export const ROLL_STREAM_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The pub/sub channel a roll's live subscribers listen on. */
export function rollEventChannel(rollId: string): string {
  return `roll:${rollId}:events`;
}

/** The stream a reconnecting subscriber replays from. */
export function rollStreamKey(rollId: string): string {
  return `roll:${rollId}:stream`;
}

/** The single field each stream entry carries; the event JSON is its value. */
const EVENT_FIELD = 'event';

/**
 * The one event a worker emits: a derivative of `captureId` in `role` is now
 * stored and fetchable. Ids only — an event that carried the capture document
 * would be a second, staler copy of a row the client can read.
 */
export interface ProcessingCompletedEvent {
  type: 'processing.completed';
  captureId: string;
  role: string;
}

/**
 * Announces one event, and returns the stream entry id it was recorded under.
 *
 * Errors propagate. A handler that wrote its derivative but could not announce
 * it has not finished its job: the retry is cheap (the object write and the
 * asset upsert are both idempotent) and a silently unannounced derivative is a
 * tile that stays a placeholder until the guest reloads the page.
 */
export async function publishRollEvent(
  redis: Redis,
  rollId: string,
  event: ProcessingCompletedEvent,
): Promise<string> {
  const payload = JSON.stringify(event);
  const key = rollStreamKey(rollId);
  const id = await redis.xadd(
    key,
    'MAXLEN',
    '~',
    ROLL_STREAM_MAXLEN,
    '*',
    EVENT_FIELD,
    payload,
  );
  // XADD only answers null for NOMKSTREAM against a missing stream, which this
  // call does not use. Impossible-but-checked beats returning a fake id.
  if (id === null) throw new Error(`XADD to ${key} returned no entry id`);

  // Between the record and the announcement, so a retry of this publish — which
  // is idempotent for the subscriber — is also what repairs a missed refresh.
  await redis.expire(key, ROLL_STREAM_TTL_SECONDS);

  await redis.publish(rollEventChannel(rollId), JSON.stringify({ id, event }));
  return id;
}
