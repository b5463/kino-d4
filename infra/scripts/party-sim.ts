#!/usr/bin/env node

// KINO Roll party simulator (issue #75). Drives the same device wire
// contract as a camera, at party shape: bursty shutter behavior, many guest
// sessions on the live SSE feed, and tolerance for a Roll server outage in
// the middle of the run (stop and restart the API while this runs — queued
// captures must resume and no capture may duplicate).
//
// This compresses a night into minutes; it is a load and liveness test, not
// a benchmark. See docs/roll/ROLL_PARTY_LOAD_TEST.md.

import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Options {
  baseUrl: string;
  captures: number;
  guests: number;
  durationMs: number;
  burstSize: number;
  waitTimeoutMs: number;
  fixtureDirectory: string;
}

const DEFAULT_FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/test-fixtures/media');

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    baseUrl: process.env['KINO_BASE_URL'] ?? 'http://localhost:3000',
    captures: 60,
    guests: 20,
    durationMs: 120_000,
    burstSize: 4,
    waitTimeoutMs: 120_000,
    fixtureDirectory: DEFAULT_FIXTURES,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${argv[i]} requires a value`);
      i += 1;
      return value;
    };
    const flag = argv[i];
    if (flag === '--base-url') options.baseUrl = next();
    else if (flag === '--captures') options.captures = Number(next());
    else if (flag === '--guests') options.guests = Number(next());
    else if (flag === '--duration') options.durationMs = Number(next()) * 1_000;
    else if (flag === '--burst') options.burstSize = Number(next());
    else if (flag === '--wait') options.waitTimeoutMs = Number(next()) * 1_000;
    else if (flag === '--fixtures') options.fixtureDirectory = resolve(next());
    else if (flag === '--help' || flag === '-h') {
      console.log(`Usage: npm run party:sim -- [options]

Simulates a party against a running Roll API. Stop/restart the API mid-run
to prove outage recovery: uploads retry with backoff and never duplicate.

  --base-url URL   API origin (default localhost:3000)
  --captures N     total captures for the event (default 60)
  --guests N       concurrent SSE guest sessions (default 20)
  --duration S     event length in seconds; captures arrive in bursts (default 120)
  --burst N        max captures per burst (default 4)
  --wait S         per-capture retry budget in seconds (default 120)
  --fixtures DIR   frame-*.jpg source directory`);
      process.exit(0);
    } else throw new Error(`unknown option: ${flag}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const base = options.baseUrl.replace(/\/$/, '');

  const fixtureNames = (await readdir(options.fixtureDirectory))
    .filter((name) => /^frame-\d+\.jpe?g$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (fixtureNames.length === 0) throw new Error(`no frame-*.jpg fixtures in ${options.fixtureDirectory}`);
  const fixtures = await Promise.all(
    fixtureNames.map(async (name, index) => {
      const body = await readFile(resolve(options.fixtureDirectory, name));
      return { frameIndex: index + 1, body, sha256: createHash('sha256').update(body).digest('hex') };
    }),
  );

  async function request<T>(path: string, init: RequestInit = {}, allowed: readonly number[] = [200]): Promise<T> {
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    if (!allowed.includes(response.status)) {
      throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${text.slice(0, 200)}`);
    }
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }
  const json = (method: string, body?: unknown, token?: string): RequestInit => ({
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  // Registration is gated (issue #146): the bearer is the provisioning
  // secret, not a device token. The fallback is the published dev default
  // from apps/api/src/config.ts, refused outside development/test.
  const provisioningToken =
    process.env.PROVISIONING_TOKEN ?? 'kino-dev-provisioning-token-do-not-use-in-production';
  const credential = await request<{ deviceId: string; deviceToken: string }>(
    '/api/studio/devices/register',
    json(
      'POST',
      {
        serial: `KD4-PARTY-${randomUUID().slice(0, 12)}`,
        product: 'KINO D4',
        hardwareRevision: 'v1',
        name: 'Party simulator',
      },
      provisioningToken,
    ),
  );
  const roll = await request<{ rollId: string; slug: string; guestUrl: string }>(
    '/api/device/rolls',
    json('POST', { title: `Party sim ${new Date().toISOString().slice(0, 16)}` }, credential.deviceToken),
    [201],
  );
  console.log(`roll ${roll.slug} — ${roll.guestUrl}`);

  // ---- guests: SSE sessions that count live capture events -------------
  let sseEvents = 0;
  let sseReconnects = 0;
  const arrivalMs: number[] = [];
  const captureCreatedAt = new Map<string, number>();
  const seenByGuest0 = new Set<string>();
  const guestControllers: AbortController[] = [];

  function startGuest(index: number): void {
    const controller = new AbortController();
    guestControllers.push(controller);
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(`${base}/api/rolls/${roll.slug}/events`, {
            headers: { accept: 'text/event-stream' },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
              const chunk = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const event = /^event: (.+)$/m.exec(chunk)?.[1];
              const data = /^data: (.+)$/m.exec(chunk)?.[1];
              if (!event) continue;
              sseEvents += 1;
              if (event === 'capture.created' && data && index === 0) {
                const { captureId } = JSON.parse(data) as { captureId: string };
                if (!seenByGuest0.has(captureId)) {
                  seenByGuest0.add(captureId);
                  const created = captureCreatedAt.get(captureId);
                  if (created !== undefined) arrivalMs.push(Date.now() - created);
                }
              }
            }
          }
        } catch {
          if (controller.signal.aborted) return;
          sseReconnects += 1;
          await sleep(1_000);
        }
      }
    })();
  }
  for (let i = 0; i < options.guests; i += 1) startGuest(i);

  // ---- camera: bursty captures with outage-tolerant retry ---------------
  let uploaded = 0;
  let retries = 0;

  async function withRetry<T>(run: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + options.waitTimeoutMs;
    let backoff = 1_000;
    for (;;) {
      try {
        return await run();
      } catch (error) {
        if (Date.now() > deadline) throw error;
        retries += 1;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 15_000);
      }
    }
  }

  async function uploadCapture(sequence: number): Promise<void> {
    const captureUuid = randomUUID();
    const doc = {
      schema: 'kino.capture',
      version: 1,
      id: `cap_party_${captureUuid}`,
      captureUuid,
      deviceId: credential.deviceId,
      mode: 'wiggle',
      capturedAt: new Date(Date.now() + sequence).toISOString(),
      frameCount: fixtures.length,
      resolution: '1600x1200',
      status: 'created',
      visible: true,
    };
    const created = await withRetry(() =>
      request<{ captureId: string }>(`/api/device/rolls/${roll.rollId}/captures`, json('POST', doc, credential.deviceToken), [200, 201]),
    );
    captureCreatedAt.set(created.captureId, Date.now());
    for (const fixture of fixtures) {
      await withRetry(async () => {
        const upload = await request<{ uploadId: string; partSize: number; alreadyComplete: boolean }>(
          `/api/device/captures/${created.captureId}/assets/init`,
          json('POST', { role: 'original-frame', frameIndex: fixture.frameIndex, mime: 'image/jpeg', bytes: fixture.body.length, sha256: fixture.sha256 }, credential.deviceToken),
        );
        if (upload.alreadyComplete) return;
        let partNo = 1;
        for (let offset = 0; offset < fixture.body.length; offset += upload.partSize) {
          await request(`/api/device/uploads/${upload.uploadId}/parts/${partNo}`, {
            method: 'PUT',
            headers: { authorization: `Bearer ${credential.deviceToken}`, 'content-type': 'application/octet-stream' },
            body: fixture.body.subarray(offset, Math.min(offset + upload.partSize, fixture.body.length)),
          });
          partNo += 1;
        }
        await request(`/api/device/uploads/${upload.uploadId}/complete`, json('POST', undefined, credential.deviceToken));
      });
    }
    await withRetry(() => request(`/api/device/captures/${created.captureId}/complete`, json('POST', undefined, credential.deviceToken)));
    uploaded += 1;
  }

  const started = Date.now();
  let launched = 0;
  const inFlight: Promise<void>[] = [];
  while (launched < options.captures) {
    const burst = Math.min(1 + Math.floor(Math.random() * options.burstSize), options.captures - launched);
    for (let i = 0; i < burst; i += 1) {
      launched += 1;
      inFlight.push(uploadCapture(launched).catch((error: unknown) => {
        console.error(`capture ${launched} failed permanently: ${error instanceof Error ? error.message : String(error)}`);
      }));
    }
    const remainingBursts = Math.max(1, Math.ceil((options.captures - launched) / ((options.burstSize + 1) / 2)));
    const remainingTime = Math.max(0, options.durationMs - (Date.now() - started));
    await sleep(Math.min(remainingTime / remainingBursts, 15_000) * (0.5 + Math.random()));
  }
  await Promise.all(inFlight);

  // Let stragglers reach the guests, then verify the feed.
  await sleep(3_000);
  for (const controller of guestControllers) controller.abort();

  const feedIds: string[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor !== null) query.set('cursor', cursor);
    const page = await request<{ items: { captureId: string }[]; nextCursor: string | null; hasMore: boolean }>(
      `/api/rolls/${roll.slug}/captures?${query}`,
    );
    feedIds.push(...page.items.map((c) => c.captureId));
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor !== null);

  const duplicates = feedIds.length - new Set(feedIds).size;
  arrivalMs.sort((a, b) => a - b);
  const p = (q: number): number => arrivalMs[Math.min(arrivalMs.length - 1, Math.floor(q * arrivalMs.length))] ?? 0;
  console.log(JSON.stringify({
    ok: uploaded === options.captures && duplicates === 0,
    slug: roll.slug,
    guestUrl: roll.guestUrl,
    captures: { requested: options.captures, uploaded, inFeed: feedIds.length, duplicates },
    guests: { sessions: options.guests, sseEvents, sseReconnects },
    liveArrival: arrivalMs.length > 0 ? { samples: arrivalMs.length, p50ms: p(0.5), p95ms: p(0.95), maxMs: arrivalMs[arrivalMs.length - 1] } : null,
    uploadRetries: retries,
    elapsedMs: Date.now() - started,
  }, null, 2));
  if (uploaded !== options.captures) process.exitCode = 1;
  if (duplicates > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`party sim failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
