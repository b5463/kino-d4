import { z } from 'zod';
import type { Redis } from 'ioredis';

/**
 * Roll events — the publish half of the 05 §10 real-time flow.
 *
 * Every event goes to two places, in this order:
 *
 *   XADD    roll:<id>:stream   MAXLEN ~ 500   — the durable, replayable log
 *   PUBLISH roll:<id>:events                  — the live fan-out
 *
 * The stream is what makes `Last-Event-ID` mean anything: a guest whose phone
 * slept for two minutes reconnects with the id of the last event it saw and
 * reads the gap out of the stream. The channel is what makes delivery immediate
 * — polling a stream at any interval short enough to feel live would cost more
 * than the events do. Neither alone is enough, which is why it is both.
 *
 * Order matters. XADD first means a publish that dies half-way has still
 * recorded the event, and every live subscriber will find it on their next
 * reconnect. PUBLISH first would produce the opposite failure: delivered to
 * whoever happened to be connected, invisible to everyone else, forever.
 *
 * `MAXLEN ~ 500` is a per-roll cap, not a retention policy. It bounds what a
 * reconnect can replay — roughly the last 500 events of that roll — and a guest
 * who was away for longer than that gets a truncated replay, which the 05 §10
 * flow already tolerates: events carry **ids only** and the PWA re-fetches, so
 * the worst case is a stale tile until the next event or the next page load.
 * The `~` is Redis's approximate trim, which drops whole radix nodes instead of
 * rewriting one on every append.
 *
 * The event union carries ids and nothing else. That keeps an event from
 * becoming a second, staler copy of the capture document.
 */
export type RollEvent =
  | { type: 'roll.opened' | 'roll.closed' }
  /**
   * Every capture of the roll went to the trash at once (`POST
   * /api/host/rolls/:rollId/clear`). ONE event, not one `capture.deleted` per
   * capture: a 2,000-capture clear would push 2,000 entries through a stream
   * capped at ~500, so a reconnecting guest could never replay it, and every
   * open guest would run 2,000 removals. The guest empties its list; the host
   * re-reads its own.
   */
  | { type: 'roll.cleared' }
  | {
      type: 'capture.created' | 'capture.updated' | 'capture.hidden' | 'capture.deleted';
      captureId: string;
    }
  | { type: 'processing.completed'; captureId: string; role: string };

/**
 * The same union as a parser, for everything read back off the wire.
 *
 * Both the stream and the channel are ordinary Redis keys: anything with the
 * connection string can write to them, and a rolling deploy can put an older
 * instance in front of a newer one's events. So nothing is trusted into an SSE
 * frame without being parsed first — `.strict()` also means an event that
 * somehow acquired a `caption` field never reaches a guest with it attached.
 */
const rollEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('roll.opened') }).strict(),
  z.object({ type: z.literal('roll.closed') }).strict(),
  z.object({ type: z.literal('roll.cleared') }).strict(),
  z.object({ type: z.literal('capture.created'), captureId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('capture.updated'), captureId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('capture.hidden'), captureId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('capture.deleted'), captureId: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal('processing.completed'),
      captureId: z.string().min(1),
      role: z.string().min(1),
    })
    .strict(),
]);

/**
 * Compile-time proof that the parser and the exported union stay the same
 * shape. Add a member to one without the other and this line stops typing.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _schemaMatchesUnion: Exact<z.infer<typeof rollEventSchema>, RollEvent> = true;
void _schemaMatchesUnion;

/** An event as it exists once published: the entry id is its SSE `id:`. */
export interface RollEventDelivery {
  id: string;
  event: RollEvent;
}

/** How many events a roll's stream keeps, and therefore how far back a replay reaches. */
export const ROLL_STREAM_MAXLEN = 500;

/**
 * How long a roll's stream survives its last event: 48 hours.
 *
 * `MAXLEN ~ 500` bounds how *many* entries a stream holds and says nothing about
 * how long the key lives, so every roll ever created left a permanent key behind
 * — one per roll, forever, in the same Redis that holds the rate-limit counters
 * and the viewer sets.
 *
 * The window is chosen against what the stream is *for*, which is replay after a
 * reconnect: a phone that slept in a pocket, a guest who walked out of range,
 * a tab restored on the way home. That is minutes, occasionally an hour. 48
 * hours covers a party that runs past midnight plus the whole of the next day,
 * so nobody who was actually at the event loses a replay, and it is refreshed on
 * every event — a live roll's stream never expires while photographs are still
 * arriving. Beyond it the gallery is a page load, not a replay: events carry ids
 * only and the client re-fetches (05 §10), so the cost of an expired stream is
 * one full fetch instead of a delta.
 *
 * Not hours: a roll that goes quiet for an afternoon and picks up again in the
 * evening is one event, not two. Not months: nothing reads a two-week-old event,
 * and a key nobody reads is a key nobody notices growing.
 */
export const ROLL_STREAM_TTL_MS = 48 * 60 * 60 * 1_000;

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

/** Redis stream entry ids are `<milliseconds>-<sequence>`. */
const STREAM_ID = /^\d+-\d+$/;

export function isStreamId(value: string): boolean {
  return STREAM_ID.test(value);
}

/** The id before every entry, for a replay that wants the whole stream. */
export const STREAM_START = '0-0';

/**
 * Orders two stream ids. Ids are assigned by Redis and only ever increase, so
 * "is this id greater than the last one I delivered" is the whole of the
 * duplicate check the SSE feed needs.
 */
export function compareStreamIds(a: string, b: string): number {
  const [aMs = 0, aSeq = 0] = a.split('-').map(Number);
  const [bMs = 0, bSeq = 0] = b.split('-').map(Number);
  if (aMs !== bMs) return aMs < bMs ? -1 : 1;
  if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
  return 0;
}

/** Parses an event JSON payload, or null if it is not one. */
export function parseRollEvent(json: string): RollEvent | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = rollEventSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/**
 * Parses a message off the pub/sub channel.
 *
 * The wire payload is `{"id":"<stream entry id>","event":{...}}` rather than
 * the bare event: the subscriber has to label every SSE frame with the id a
 * reconnect will send back, and the stream entry id is the only id in the
 * system that both halves agree on. Deriving it subscriber-side is impossible,
 * and inventing a second id would mean `Last-Event-ID` could not address the
 * stream.
 */
export function parseRollEventMessage(message: string): RollEventDelivery | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null) return null;

  const { id, event } = decoded as { id?: unknown; event?: unknown };
  if (typeof id !== 'string' || !isStreamId(id)) return null;

  const parsed = rollEventSchema.safeParse(event);
  return parsed.success ? { id, event: parsed.data } : null;
}

/**
 * Announces one event to a roll's subscribers, and returns the stream entry id
 * it was recorded under.
 *
 * Errors propagate. That is on purpose even though no caller in Task 18 lets a
 * publish failure fail a request: swallowing here would make the failure
 * invisible, and *where* to tolerate a dead event bus is a decision for the
 * caller, which knows whether the write it just made is already durable. The
 * upload routes catch and log; a future caller that must not lose an event can
 * choose differently.
 */
export async function publishRollEvent(
  redis: Redis,
  rollId: string,
  event: RollEvent,
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
  // call does not use. Treating it as impossible-but-checked beats returning a
  // fake id that a client would later replay from.
  if (id === null) throw new Error(`XADD to ${rollStreamKey(rollId)} returned no entry id`);

  // Beside the XADD rather than at roll creation, so the window is measured
  // from the last event and a live roll's stream is never dropped from under a
  // reconnecting guest. See `ROLL_STREAM_TTL_MS`. It runs before the PUBLISH for
  // the same reason the XADD does: a failure here must not cost a subscriber the
  // event, and a stream with no expiry is the state this whole platform ran in
  // until now — recoverable, unlike an event nobody recorded.
  await redis.pexpire(rollStreamKey(rollId), ROLL_STREAM_TTL_MS);

  await redis.publish(rollEventChannel(rollId), JSON.stringify({ id, event }));
  return id;
}

/**
 * The events a roll recorded *after* `afterId` — what a reconnecting guest
 * missed.
 *
 * The range start is exclusive (`(` — Redis 6.2+), because `Last-Event-ID` is
 * the last event the client already has. An inclusive start would re-deliver
 * it on every reconnect, and a client that treats an event as a signal to
 * re-fetch would re-fetch forever on a flaky connection.
 *
 * Entries that do not parse are skipped rather than failing the replay: one
 * unrecognised event must not cost the guest every event after it.
 */
export async function readRollHistory(
  redis: Redis,
  rollId: string,
  afterId: string,
  limit: number = ROLL_STREAM_MAXLEN,
): Promise<RollEventDelivery[]> {
  const entries = await redis.xrange(rollStreamKey(rollId), `(${afterId}`, '+', 'COUNT', limit);

  const history: RollEventDelivery[] = [];
  for (const [id, fields] of entries) {
    const json = fieldValue(fields, EVENT_FIELD);
    if (json === null) continue;
    const event = parseRollEvent(json);
    if (event !== null) history.push({ id, event });
  }
  return history;
}

/** Reads one field out of a stream entry's flat `[name, value, ...]` array. */
function fieldValue(fields: readonly string[], name: string): string | null {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === name) return fields[i + 1] ?? null;
  }
  return null;
}
