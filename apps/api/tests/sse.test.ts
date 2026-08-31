import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { loadConfig, type ApiConfig } from '../src/config';
import {
  ROLL_STREAM_MAXLEN,
  publishRollEvent,
  readRollHistory,
  rollEventChannel,
  rollStreamKey,
  type RollEvent,
  type RollEventDelivery,
} from '../src/events/publish';
import { openRollEventFeed } from '../src/events/feed';
import { VIEWER_STALE_MS, countRollViewers, rollViewersKey } from '../src/events/viewers';
import { SSE_RETRY_MS, guestEventRoutes } from '../src/routes/guest-events';
import { JOB_NAMES, jobKeyFor } from '../src/uploads/uploads';
import { createProcessingQueue, jobKeyToJobId } from '../src/queue/producer';
import * as schema from '../src/db/schema';

/**
 * Live events (Task 19), against the real database *and* the real Redis — same
 * house rules as the other suites: the dev stack must be up AND migrated.
 *
 *   docker compose -f infra/docker-compose.dev.yml up -d
 *   npm run db:migrate -w @kino/api
 *
 * ## Why this suite listens on a real port
 *
 * `app.inject()` buffers a response and resolves when it ends. An SSE response
 * never ends, so injection can only ever time out on it — the mechanism under
 * test here is precisely the one injection cannot express. So the server binds
 * port 0 and the tests read the stream with `fetch`, incrementally, exactly as
 * a browser's EventSource would. Aborting the fetch is a real client
 * disconnect, which is also how teardown gets proven rather than asserted.
 */
const RUN = randomBytes(4).toString('hex');

const config: ApiConfig = loadConfig();
const app: FastifyInstance = buildServer(config);

/**
 * A second mount of the SSE route with a 250 ms heartbeat.
 *
 * The production heartbeat is 25 s (the brief), and a test that waited for it
 * would be a 25-second test. `guestEventRoutes` therefore takes the interval as
 * a plugin option, defaulting to `SSE_HEARTBEAT_MS`, and this registers a
 * second, faster copy under a prefix — no test hook inside the route, no
 * production behaviour changed, and `/api/rolls/:slug/events` still runs on the
 * real 25 s. The viewer-count refresh rides the same timer, so this mount
 * exercises that too.
 */
const FAST_PREFIX = '/__fast-heartbeat';
const FAST_HEARTBEAT_MS = 250;
app.register(guestEventRoutes, { heartbeatMs: FAST_HEARTBEAT_MS, prefix: FAST_PREFIX });

const REQUIRED_TABLES = ['rolls', 'captures'];
const SERIAL = `KD4-T19-${RUN}`;

/** Every roll id whose DB rows need deleting. */
const createdRollIds: string[] = [];
/** Every roll id whose Redis keys need deleting — includes ids with no DB row. */
const touchedRollIds = new Set<string>();

let device: { deviceId: string; deviceToken: string };
let base = '';

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A roll id that exists only in Redis, for the pure event-plumbing tests. */
function syntheticRollId(name: string): string {
  const id = `roll_t19_${RUN}_${name}`;
  touchedRollIds.add(id);
  return id;
}

async function eventually(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/* ------------------------------------------------------------ SSE client -- */

interface SseFrame {
  id: string | null;
  name: string | null;
  data: string;
}

/** A minimal EventSource: enough of the wire format to assert on it. */
class SseClient {
  readonly frames: SseFrame[] = [];
  readonly comments: string[] = [];
  retry: number | null = null;
  /** True once the *server* ended the response; an abort does not set it. */
  ended = false;

  private buffer = '';
  private readonly wakers: (() => void)[] = [];

  private constructor(
    private readonly controller: AbortController,
    readonly headers: Headers,
    body: ReadableStream<Uint8Array>,
  ) {
    void this.pump(body);
  }

  static async open(path: string, headers: Record<string, string> = {}): Promise<SseClient> {
    const controller = new AbortController();
    const res = await fetch(`${base}${path}`, {
      headers: { accept: 'text/event-stream', ...headers },
      signal: controller.signal,
    });
    if (res.status !== 200 || res.body === null) {
      controller.abort();
      throw new Error(`SSE open failed with ${res.status}`);
    }
    return new SseClient(controller, res.headers, res.body);
  }

  close(): void {
    this.controller.abort();
  }

  /** Resolves once `frames` holds at least `count` events. */
  async awaitFrames(count: number, timeoutMs = 5_000): Promise<SseFrame[]> {
    await this.until(() => this.frames.length >= count, `${count} SSE event(s)`, timeoutMs);
    return this.frames;
  }

  async awaitComments(count: number, timeoutMs = 5_000): Promise<string[]> {
    await this.until(() => this.comments.length >= count, `${count} SSE comment(s)`, timeoutMs);
    return this.comments;
  }

  /** Resolves once the server ends the response, as it does on subscriber loss. */
  async awaitEnd(timeoutMs = 5_000): Promise<void> {
    await this.until(() => this.ended, 'the server to end the stream', timeoutMs);
  }

  private async until(ready: () => boolean, what: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!ready()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        this.wakers.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          this.ended = true;
          this.wake();
          return;
        }
        this.buffer += decoder.decode(value, { stream: true });
        this.drain();
      }
    } catch {
      // An aborted fetch lands here; that is a deliberate client disconnect.
    }
  }

  private wake(): void {
    for (const wake of this.wakers.splice(0)) wake();
  }

  private drain(): void {
    for (let split = this.buffer.indexOf('\n\n'); split !== -1; split = this.buffer.indexOf('\n\n')) {
      const chunk = this.buffer.slice(0, split);
      this.buffer = this.buffer.slice(split + 2);
      this.accept(chunk);
    }
  }

  private accept(chunk: string): void {
    let id: string | null = null;
    let name: string | null = null;
    const data: string[] = [];

    for (const line of chunk.split('\n')) {
      if (line === '') continue;
      if (line.startsWith(':')) {
        this.comments.push(line.slice(1).trim());
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const raw = colon === -1 ? '' : line.slice(colon + 1);
      const value = raw.startsWith(' ') ? raw.slice(1) : raw;

      if (field === 'id') id = value;
      else if (field === 'event') name = value;
      else if (field === 'data') data.push(value);
      else if (field === 'retry') this.retry = Number(value);
    }

    if (data.length > 0) this.frames.push({ id, name, data: data.join('\n') });

    this.wake();
  }
}

const openClients: SseClient[] = [];

/** Opens a stream and registers it for teardown even if the test throws. */
async function openStream(path: string, headers: Record<string, string> = {}): Promise<SseClient> {
  const client = await SseClient.open(path, headers);
  openClients.push(client);
  return client;
}

const payloadOf = (frame: SseFrame): Record<string, unknown> =>
  JSON.parse(frame.data) as Record<string, unknown>;

/* ------------------------------------------------------------- fixtures -- */

interface CreatedRollResponse {
  rollId: string;
  slug: string;
  guestUrl: string;
  hostUrl: string;
  hostToken: string;
}

async function register(serial: string): Promise<{ deviceId: string; deviceToken: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/studio/devices/register',
    // The provisioning secret this endpoint is gated on. Read off the server's
    // own config rather than hard-coded, so a bench with a real one in
    // `infra/.env` runs the suite unchanged.
    headers: { authorization: `Bearer ${app.config.PROVISIONING_TOKEN}` },
    payload: { serial, product: 'KINO D4', hardwareRevision: 'v1' },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ deviceId: string; deviceToken: string }>();
}

async function createRoll(body: Record<string, unknown> = {}): Promise<CreatedRollResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/device/rolls',
    headers: bearer(device.deviceToken),
    payload: { title: `Live roll ${RUN}`, ...body },
  });
  expect(res.statusCode).toBe(201);
  const created = res.json<CreatedRollResponse>();
  createdRollIds.push(created.rollId);
  touchedRollIds.add(created.rollId);
  return created;
}

/** A host-created roll, so a PIN can be set at creation. */
async function createPinRoll(pin: string): Promise<CreatedRollResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/host/rolls',
    payload: { title: `PIN roll ${RUN}`, pin },
  });
  expect(res.statusCode).toBe(201);
  const created = res.json<CreatedRollResponse>();
  createdRollIds.push(created.rollId);
  touchedRollIds.add(created.rollId);
  return created;
}

async function postCapture(rollId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/device/rolls/${rollId}/captures`,
    headers: bearer(device.deviceToken),
    payload: {
      schema: 'kino.capture',
      version: 1,
      id: `cap_local_${randomUUID()}`,
      captureUuid: randomUUID(),
      deviceId: device.deviceId,
      mode: 'wiggle',
      capturedAt: new Date().toISOString(),
      frameCount: 4,
      resolution: '1600x1200',
      status: 'created',
      visible: true,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ captureId: string }>().captureId;
}

/** Announces an event on the channel only, under an id of the test's choosing. */
async function announceRaw(rollId: string, id: string, event: RollEvent): Promise<void> {
  await app.redis.publish(rollEventChannel(rollId), JSON.stringify({ id, event }));
}

/** Live subscribers Redis itself reports on a roll's channel. */
async function channelSubscribers(rollId: string): Promise<number> {
  const reply = await app.redis.pubsub('NUMSUB', rollEventChannel(rollId));
  const counts = reply as (string | number)[];
  return Number(counts[1] ?? 0);
}

let migrated = false;

async function assertMigrated(): Promise<void> {
  const rows = await app.db.execute<{ table_name: string }>(sql`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('rolls', 'captures')
  `);
  const present = new Set(Array.from(rows).map((row) => row.table_name));
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new Error(
      `Database is not migrated: missing table(s) ${missing.join(', ')}. ` +
        'Run `npm run db:migrate -w @kino/api` against DATABASE_URL and re-run the tests.',
    );
  }
  migrated = true;
}

beforeAll(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port');
  base = `http://127.0.0.1:${address.port}`;

  await assertMigrated();
  device = await register(SERIAL);
}, 60_000);

afterAll(async () => {
  for (const client of openClients) client.close();

  if (migrated && createdRollIds.length > 0) {
    // `complete` enqueues processing jobs, and those rows reference the
    // capture — children first, or the delete below hits the foreign key.
    const captureRows = await app.db
      .select({ id: schema.captures.id })
      .from(schema.captures)
      .where(inArray(schema.captures.rollId, createdRollIds));
    const captureIds = captureRows.map((row) => row.id);
    if (captureIds.length > 0) {
      await app.db
        .delete(schema.processingEvents)
        .where(inArray(schema.processingEvents.captureId, captureIds));

      // `complete` also hands those jobs to BullMQ (Task 22), and no worker runs
      // in this suite — so without this they would wait in the dev Redis forever
      // for a capture that has just been deleted. Removed by id, not by
      // obliterating the queue: `kino-jobs` is the real prefix and a test must
      // not be able to delete work it did not create.
      const queue = createProcessingQueue(config);
      try {
        for (const captureId of captureIds) {
          for (const job of JOB_NAMES) {
            await queue.remove(jobKeyToJobId(jobKeyFor(captureId, job)));
          }
        }
      } finally {
        await queue.close();
      }
    }

    await app.db
      .delete(schema.captures)
      .where(inArray(schema.captures.rollId, createdRollIds));
    await app.db
      .delete(schema.auditEvents)
      .where(inArray(schema.auditEvents.rollId, createdRollIds));
    await app.db
      .delete(schema.rollDevices)
      .where(inArray(schema.rollDevices.rollId, createdRollIds));
    await app.db.delete(schema.rolls).where(inArray(schema.rolls.id, createdRollIds));
  }
  if (migrated) {
    await app.db.delete(schema.devices).where(inArray(schema.devices.serial, [SERIAL]));
  }

  const keys = [...touchedRollIds].flatMap((id) => [rollStreamKey(id), rollViewersKey(id)]);
  if (keys.length > 0) await app.redis.del(...keys);

  await app.close();
}, 60_000);

/* ------------------------------------------------------------- publisher -- */

describe('publishRollEvent (05 §10)', () => {
  it('appends to the roll stream and announces the entry id on the channel', async () => {
    const rollId = syntheticRollId('publish');
    const listener = app.redis.duplicate();
    const seen: string[] = [];
    listener.on('message', (_channel: string, message: string) => seen.push(message));
    await listener.subscribe(rollEventChannel(rollId));

    try {
      const event = { type: 'capture.created', captureId: 'cap_publish' } as const;
      const id = await publishRollEvent(app.redis, rollId, event);

      // The stream is the durable half: it is what a reconnect replays from.
      expect(await readRollHistory(app.redis, rollId, '0-0')).toEqual([{ id, event }]);

      // The channel is the live half, and it carries the stream id — without it
      // a subscriber could not label the event for `Last-Event-ID`.
      await eventually(() => seen.length === 1, 'the published message');
      expect(JSON.parse(seen[0] ?? '')).toEqual({ id, event });
    } finally {
      await listener.quit();
    }
  });

  it('reads history exclusively after the given id', async () => {
    const rollId = syntheticRollId('history');
    const first = await publishRollEvent(app.redis, rollId, {
      type: 'capture.created',
      captureId: 'cap_1',
    });
    const second = await publishRollEvent(app.redis, rollId, {
      type: 'capture.updated',
      captureId: 'cap_1',
    });
    const third = await publishRollEvent(app.redis, rollId, {
      type: 'processing.completed',
      captureId: 'cap_1',
      role: 'thumb',
    });

    const missed = await readRollHistory(app.redis, rollId, first);
    expect(missed.map((entry) => entry.id)).toEqual([second, third]);
    expect(missed[1]?.event).toEqual({
      type: 'processing.completed',
      captureId: 'cap_1',
      role: 'thumb',
    });

    // Nothing is missed after the last id the client saw.
    expect(await readRollHistory(app.redis, rollId, third)).toEqual([]);
  });

  it('bounds the stream at roughly MAXLEN so a roll cannot grow without limit', async () => {
    const rollId = syntheticRollId('maxlen');
    const overflow = ROLL_STREAM_MAXLEN * 2 + 200;
    for (let i = 0; i < overflow; i += 1) {
      await publishRollEvent(app.redis, rollId, { type: 'capture.created', captureId: `cap_${i}` });
    }

    const length = await app.redis.xlen(rollStreamKey(rollId));
    // `MAXLEN ~` trims whole radix nodes, so the exact length is Redis's
    // business; what matters is that it trimmed at all and kept the window.
    expect(length).toBeLessThan(overflow);
    expect(length).toBeGreaterThanOrEqual(ROLL_STREAM_MAXLEN);
  }, 60_000);
});

/* ------------------------------------------------------------------ feed -- */

describe('roll event feed', () => {
  it('loses nothing and repeats nothing in the replay-to-live handoff', async () => {
    const rollId = syntheticRollId('gap');
    const seen = await publishRollEvent(app.redis, rollId, {
      type: 'capture.created',
      captureId: 'cap_seen',
    });

    const delivered: RollEventDelivery[] = [];
    let inSnapshot = '';
    let afterSnapshot = '';

    // `readHistory` is the feed's collaborator, so a test can wrap it — and
    // wrapping it is what makes the handoff window addressable. Two events are
    // published from inside it, one on each side of the snapshot, and each one
    // fails a different wrong implementation:
    //
    //   `inSnapshot`    reaches the client twice — once from XRANGE, once from
    //                   pub/sub — unless deliveries are deduplicated by id.
    //   `afterSnapshot` reaches it not at all if the feed reads history before
    //                   subscribing, because by then nobody is listening and
    //                   the client's Last-Event-ID has already moved past it.
    const close = await openRollEventFeed({
      bus: app.rollEvents,
      rollId,
      lastEventId: seen,
      readHistory: async (afterId) => {
        inSnapshot = await publishRollEvent(app.redis, rollId, {
          type: 'capture.updated',
          captureId: 'cap_gap',
        });
        const history = await readRollHistory(app.redis, rollId, afterId);
        afterSnapshot = await publishRollEvent(app.redis, rollId, {
          type: 'capture.hidden',
          captureId: 'cap_gap',
        });
        return history;
      },
      deliver: (entry) => delivered.push(entry),
    });

    try {
      await eventually(() => delivered.length >= 2, 'both mid-flight events');
      // Long enough for a duplicate of either to have shown up.
      await sleep(250);
      expect(delivered.map((entry) => entry.id)).toEqual([inSnapshot, afterSnapshot]);

      // And the handoff keeps working: live events still arrive after replay.
      const later = await publishRollEvent(app.redis, rollId, {
        type: 'capture.deleted',
        captureId: 'cap_later',
      });
      await eventually(() => delivered.length >= 3, 'the live event after replay');
      expect(delivered.map((entry) => entry.id)).toEqual([inSnapshot, afterSnapshot, later]);
    } finally {
      await close();
    }
  });

  it('keeps delivering after the drain when publishes arrive out of stream order', async () => {
    const rollId = syntheticRollId('reorder');
    const delivered: RollEventDelivery[] = [];

    const close = await openRollEventFeed({
      bus: app.rollEvents,
      rollId,
      lastEventId: null,
      readHistory: async () => [],
      deliver: (entry) => delivered.push(entry),
    });

    try {
      // `publishRollEvent` does XADD then PUBLISH — two round trips, not one
      // atomic step — so two API instances publishing to the same roll can
      // reach the channel in the opposite order to the one the stream assigned.
      // That is announced here directly: newer id first, older id second.
      await announceRaw(rollId, '2000-0', { type: 'capture.created', captureId: 'cap_new' });
      await eventually(() => delivered.length >= 1, 'the newer event');

      await announceRaw(rollId, '1000-0', { type: 'capture.created', captureId: 'cap_old' });
      await eventually(() => delivered.length >= 2, 'the older, reordered event');

      // Both arrive. A watermark left armed for the life of the connection
      // would discard the second one forever — and nothing would recover it,
      // because the guest's socket is healthy and no replay is coming. After
      // the client is caught up, a late old id costs at most a duplicate.
      expect(delivered.map((entry) => entry.id)).toEqual(['2000-0', '1000-0']);
      await sleep(150);
      expect(delivered).toHaveLength(2);
    } finally {
      await close();
    }
  });

  it('shares one subscriber connection between feeds and releases it on the last close', async () => {
    const rollId = syntheticRollId('refcount');
    const before = app.rollEvents.activeChannels;

    const first = await openRollEventFeed({
      bus: app.rollEvents,
      rollId,
      lastEventId: null,
      readHistory: async () => [],
      deliver: () => {},
    });
    const second = await openRollEventFeed({
      bus: app.rollEvents,
      rollId,
      lastEventId: null,
      readHistory: async () => [],
      deliver: () => {},
    });

    // Two feeds, one channel, one connection.
    expect(app.rollEvents.activeChannels).toBe(before + 1);
    expect(await channelSubscribers(rollId)).toBe(1);

    await first();
    // The second feed still wants it, so the subscription stays.
    expect(await channelSubscribers(rollId)).toBe(1);

    await second();
    expect(app.rollEvents.activeChannels).toBe(before);
    expect(await channelSubscribers(rollId)).toBe(0);
  });
});

/* ------------------------------------------------------------------- SSE -- */

describe('GET /api/rolls/:slug/events (03 §7)', () => {
  it('opens a text/event-stream with a retry hint and the guest robots header', async () => {
    const roll = await createRoll();
    const client = await openStream(`/api/rolls/${roll.slug}/events`);

    expect(client.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(client.headers.get('cache-control')).toMatch(/no-cache/);
    // The guest URL space is noindex even when it streams (03 §9).
    expect(client.headers.get('x-robots-tag')).toBe('noindex, nofollow');

    await eventually(() => client.retry !== null, 'the retry hint');
    expect(client.retry).toBe(SSE_RETRY_MS);
    expect(SSE_RETRY_MS).toBe(3_000);

    client.close();
  });

  it('pushes capture.created when a device posts a capture', async () => {
    const roll = await createRoll();
    const client = await openStream(`/api/rolls/${roll.slug}/events`);
    await eventually(() => client.retry !== null, 'the stream to open');

    const captureId = await postCapture(roll.rollId);

    const [frame] = await client.awaitFrames(1);
    expect(frame?.name).toBe('capture.created');
    expect(frame?.id).toMatch(/^\d+-\d+$/);
    // Ids only: the PWA re-fetches the capture (05 §10). An event that carried
    // the capture document would be a second, staler copy of it.
    expect(payloadOf(frame!)).toEqual({ type: 'capture.created', captureId });

    // The other capture-side call site: finishing a capture is an update.
    const completed = await app.inject({
      method: 'POST',
      url: `/api/device/captures/${captureId}/complete`,
      headers: bearer(device.deviceToken),
    });
    expect(completed.statusCode).toBe(200);

    const frames = await client.awaitFrames(2);
    expect(frames[1]?.name).toBe('capture.updated');
    expect(payloadOf(frames[1]!)).toEqual({ type: 'capture.updated', captureId });

    client.close();
  });

  it('emits capture.hidden for a hidden capture', async () => {
    const roll = await createRoll();
    const captureId = await postCapture(roll.rollId);
    const client = await openStream(`/api/rolls/${roll.slug}/events`);
    await eventually(() => client.retry !== null, 'the stream to open');

    // Host moderation is Task 21; the event contract is publisher-level here.
    await publishRollEvent(app.redis, roll.rollId, { type: 'capture.hidden', captureId });

    const [frame] = await client.awaitFrames(1);
    expect(frame?.name).toBe('capture.hidden');
    expect(payloadOf(frame!)).toEqual({ type: 'capture.hidden', captureId });

    client.close();
  });

  it('replays exactly the events missed while disconnected, once each', async () => {
    const roll = await createRoll();
    const first = await openStream(`/api/rolls/${roll.slug}/events`);
    await eventually(() => first.retry !== null, 'the stream to open');

    const captureId = await postCapture(roll.rollId);
    const [seen] = await first.awaitFrames(1);
    const lastEventId = seen?.id ?? '';
    expect(lastEventId).not.toBe('');

    first.close();
    await eventually(async () => (await channelSubscribers(roll.rollId)) === 0, 'the first client to go');

    // Two events the guest was not there for — a mobile screen lock, say.
    await publishRollEvent(app.redis, roll.rollId, { type: 'capture.updated', captureId });
    await publishRollEvent(app.redis, roll.rollId, {
      type: 'processing.completed',
      captureId,
      role: 'thumb',
    });

    const second = await openStream(`/api/rolls/${roll.slug}/events`, {
      'last-event-id': lastEventId,
    });
    const frames = await second.awaitFrames(2);
    await sleep(250); // a duplicate would have arrived by now

    expect(frames.map((frame) => frame.name)).toEqual(['capture.updated', 'processing.completed']);
    // The event the client already had is not sent again.
    expect(frames.some((frame) => frame.id === lastEventId)).toBe(false);
    expect(second.frames).toHaveLength(2);

    // Live delivery continues on the reconnected stream.
    await publishRollEvent(app.redis, roll.rollId, { type: 'capture.deleted', captureId });
    const after = await second.awaitFrames(3);
    expect(after[2]?.name).toBe('capture.deleted');

    second.close();
  });

  it('refuses a Last-Event-ID that is not a stream id', async () => {
    const roll = await createRoll();
    const res = await fetch(`${base}/api/rolls/${roll.slug}/events`, {
      headers: { accept: 'text/event-stream', 'last-event-id': 'not-a-stream-id' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('INVALID_LAST_EVENT_ID');
  });

  it('fans one event out to every connected guest', async () => {
    const roll = await createRoll();
    const a = await openStream(`/api/rolls/${roll.slug}/events`);
    const b = await openStream(`/api/rolls/${roll.slug}/events`);
    await eventually(() => a.retry !== null && b.retry !== null, 'both streams to open');

    const captureId = await postCapture(roll.rollId);

    const [frameA] = await a.awaitFrames(1);
    const [frameB] = await b.awaitFrames(1);
    expect(payloadOf(frameA!)).toEqual({ type: 'capture.created', captureId });
    expect(payloadOf(frameB!)).toEqual({ type: 'capture.created', captureId });
    // Two guests, still one Redis subscription (one shared subscriber).
    expect(await channelSubscribers(roll.rollId)).toBe(1);

    a.close();
    b.close();
  });

  it('sends a heartbeat comment so an idle stream is not reaped', async () => {
    const roll = await createRoll();
    const client = await openStream(`${FAST_PREFIX}/api/rolls/${roll.slug}/events`);

    const comments = await client.awaitComments(2);
    expect(comments.slice(0, 2)).toEqual(['heartbeat', 'heartbeat']);

    client.close();
  });

  it('requires the PIN cookie on a PIN-protected roll', async () => {
    const pin = '4821';
    const roll = await createPinRoll(pin);

    const denied = await fetch(`${base}/api/rolls/${roll.slug}/events`, {
      headers: { accept: 'text/event-stream' },
    });
    expect(denied.status).toBe(401);
    expect(((await denied.json()) as { code?: string }).code).toBe('PIN_REQUIRED');
    // Even the refusal stays out of a crawler's index.
    expect(denied.headers.get('x-robots-tag')).toBe('noindex, nofollow');

    const unlocked = await fetch(`${base}/api/rolls/${roll.slug}/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    expect(unlocked.status).toBe(200);
    const cookie = (unlocked.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '';
    expect(cookie).not.toBe('');

    const client = await openStream(`/api/rolls/${roll.slug}/events`, { cookie });
    await eventually(() => client.retry !== null, 'the unlocked stream to open');
    client.close();
  });

  it('ends open streams when the shared subscriber connection drops', async () => {
    const roll = await createRoll();
    const client = await openStream(`/api/rolls/${roll.slug}/events`);
    await eventually(() => client.retry !== null, 'the stream to open');

    const captureId = await postCapture(roll.rollId);
    const [first] = await client.awaitFrames(1);
    const lastEventId = first?.id ?? '';
    expect(lastEventId).not.toBe('');

    // Kill the subscriber's connection from the server side — what a Redis
    // restart or a failover looks like from in here. The guest's own socket is
    // untouched, so nothing on their side would ever notice that this process
    // had gone deaf.
    const killed = Number(await app.redis.call('CLIENT', 'KILL', 'TYPE', 'pubsub'));
    expect(killed).toBeGreaterThanOrEqual(1);

    // Ending the response is what makes the browser's own recovery fire.
    await client.awaitEnd();

    // Published while this process could not hear the channel: only the stream
    // has it now.
    await publishRollEvent(app.redis, roll.rollId, { type: 'capture.updated', captureId });

    // Which is exactly what a reconnect with Last-Event-ID replays.
    const resumed = await openStream(`/api/rolls/${roll.slug}/events`, {
      'last-event-id': lastEventId,
    });
    const [gap] = await resumed.awaitFrames(1, 10_000);
    expect(gap?.name).toBe('capture.updated');
    expect(payloadOf(gap!)).toEqual({ type: 'capture.updated', captureId });

    resumed.close();
  }, 30_000);

  it('does not leave a subscription behind for a HEAD request', async () => {
    const roll = await createRoll();

    // Fastify exposes a HEAD route for every GET. A crawler or an uptime probe
    // sending one must not open a feed nobody will ever close.
    const res = await fetch(`${base}/api/rolls/${roll.slug}/events`, { method: 'HEAD' });
    expect(res.status).toBe(200);

    await eventually(async () => (await channelSubscribers(roll.rollId)) === 0, 'no subscription');
    await eventually(async () => (await countRollViewers(app.redis, roll.rollId)) === 0, 'no viewer');
  });

  it('counts connected guests and lets a vanished one decay', async () => {
    const roll = await createRoll();
    expect(await countRollViewers(app.redis, roll.rollId)).toBe(0);

    const a = await openStream(`/api/rolls/${roll.slug}/events`);
    const b = await openStream(`/api/rolls/${roll.slug}/events`);
    await eventually(async () => (await countRollViewers(app.redis, roll.rollId)) === 2, 'two guests');

    a.close();
    await eventually(async () => (await countRollViewers(app.redis, roll.rollId)) === 1, 'one guest');

    // A guest whose connection died without a FIN — a phone that lost signal —
    // leaves an entry no disconnect handler will ever remove. It decays.
    await app.redis.zadd(rollViewersKey(roll.rollId), Date.now() - VIEWER_STALE_MS - 1_000, 'ghost');
    expect(await app.redis.zcard(rollViewersKey(roll.rollId))).toBe(2);
    expect(await countRollViewers(app.redis, roll.rollId)).toBe(1);
    expect(await app.redis.zcard(rollViewersKey(roll.rollId))).toBe(1);

    b.close();
    await eventually(async () => (await countRollViewers(app.redis, roll.rollId)) === 0, 'no guests');
  });

  it('leaves nothing behind when a client disconnects', async () => {
    const roll = await createRoll();
    const baseline = app.rollEvents.activeChannels;

    const client = await openStream(`${FAST_PREFIX}/api/rolls/${roll.slug}/events`);
    await client.awaitComments(1);
    expect(await channelSubscribers(roll.rollId)).toBe(1);
    expect(app.rollEvents.activeChannels).toBe(baseline + 1);

    client.close();

    // Subscription released, viewer forgotten, and — because the heartbeat here
    // is 250 ms — a timer that survived would still be firing. `app.close()` in
    // afterAll is the other half of this proof: an interval left running would
    // keep the process alive past the end of the suite.
    await eventually(async () => (await channelSubscribers(roll.rollId)) === 0, 'the subscription to be released');
    expect(app.rollEvents.activeChannels).toBe(baseline);
    await eventually(async () => (await countRollViewers(app.redis, roll.rollId)) === 0, 'the viewer to be forgotten');
  });
});

describe('GET /api/host/rolls/:rollId/events (host dashboard)', () => {
  it('streams a PIN Roll through host auth without counting the dashboard as a guest', async () => {
    const roll = await createPinRoll('4821');
    const client = await openStream(`/api/host/rolls/${roll.rollId}/events`, bearer(roll.hostToken));
    await eventually(() => client.retry !== null, 'the host stream to open');

    await publishRollEvent(app.redis, roll.rollId, { type: 'roll.closed' });
    const [frame] = await client.awaitFrames(1);
    expect(frame?.name).toBe('roll.closed');
    expect(payloadOf(frame!)).toEqual({ type: 'roll.closed' });
    expect(await countRollViewers(app.redis, roll.rollId)).toBe(0);

    client.close();
  });

  it('rejects a token belonging to another Roll', async () => {
    const mine = await createRoll();
    const other = await createRoll();
    const response = await fetch(`${base}/api/host/rolls/${mine.rollId}/events`, {
      headers: bearer(other.hostToken),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code?: string }).code).toBe('INVALID_HOST_TOKEN');
  });
});
