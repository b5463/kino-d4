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
  const id = await redis.xadd(
    rollStreamKey(rollId),
    'MAXLEN',
    '~',
    ROLL_STREAM_MAXLEN,
    '*',
    EVENT_FIELD,
    payload,
  );
  // XADD only answers null for NOMKSTREAM against a missing stream, which this
  // call does not use. Impossible-but-checked beats returning a fake id.
  if (id === null) throw new Error(`XADD to ${rollStreamKey(rollId)} returned no entry id`);

  await redis.publish(rollEventChannel(rollId), JSON.stringify({ id, event }));
  return id;
}
