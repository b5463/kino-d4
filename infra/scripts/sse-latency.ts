#!/usr/bin/env node

// Does the guest's live feed actually stream through this path?
//
// Production must be reached through an outbound tunnel, because the origin PC
// is behind carrier NAT. Every candidate tunnel has documented or suspected
// buffering of `text/event-stream` on GET — cloudflared has open issues where
// SSE is not streamed and flushes only when the connection closes, and there
// are community reports of edge buffering until roughly 100 kB has piled up.
// The guest feed is an `EventSource`, which is a GET. So this question has to
// be answered with numbers before anyone moves DNS or pays for anything.
//
// What this measures, and what it deliberately does not: it opens a real
// Chromium on `<base>/r/<slug>`, so the measurement rides the app's own
// `EventSource` (apps/roll-web/src/hooks/useRollEvents.ts) and the app's own
// render path, not a synthetic client that would prove nothing about the
// product. It then drives real captures through the device wire contract using
// `runTestUploader` from ./test-uploader.ts, so there is exactly one upload
// implementation in this repository.
//
// Run it against the local origin first. A tunnel run is only readable next to
// a local control baseline; see docs/runbooks/event-day.md §5.
//
// This is a test and ops tool. It changes no product behaviour.

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { runTestUploader } from './test-uploader';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Options {
  /** Origin under test. Serves both the PWA and `/api` — one hostname, as production does. */
  baseUrl: string;
  /** Where the driver posts captures. Defaults to `baseUrl`; split only to isolate a hop. */
  apiBaseUrl: string;
  /** Existing roll to use. Empty means "create a fresh one", which is the clean case. */
  rollSlug: string;
  events: number;
  intervalMs: number;
  /** How long to keep listening after the last capture before giving up on stragglers. */
  drainMs: number;
  outPath: string;
  headed: boolean;
}

/** What the in-page probe hands back. All page timestamps are `Date.now()` in the tab. */
interface ProbeSource {
  index: number;
  url: string;
  createdAt: number;
  openedAt: number | null;
  errors: number;
}
interface ProbeEvent {
  source: number;
  type: string;
  at: number;
  lastEventId: string | null;
  data: string | null;
}
interface ProbeDom {
  captureId: string;
  at: number;
}
interface Probe {
  sources: ProbeSource[];
  events: ProbeEvent[];
  dom: ProbeDom[];
}

const sleep = async (ms: number): Promise<void> => {
  if (ms > 0) await new Promise<void>((done) => setTimeout(done, ms));
};

function normaliseBaseUrl(value: string, flag: string): string {
  if (!URL.canParse(value)) throw new Error(`${flag} must be an absolute URL`);
  return value.replace(/\/$/, '');
}

// No `package.json` script: this is an ops probe, run on demand and not part of
// any suite. `npx tsx` is the whole invocation.
const USAGE = `Usage: npx tsx infra/scripts/sse-latency.ts --base-url URL [options]

Measures whether a Roll's live feed streams or is buffered on the path to the
base URL, using a real browser on the guest feed and real captures through the
device API. Exits 0 on SSE_STREAMING_PASS, 1 on SSE_BUFFERED, 2 on
SSE_INCONCLUSIVE.

  --base-url URL   origin serving the PWA and /api (default http://localhost:5173)
  --api-base URL   where captures are posted (default: --base-url)
  --roll SLUG      use an existing roll instead of creating one
  --events N       captures to generate, minimum 20 for a verdict (default 20)
  --interval MS    target spacing between captures (default 3000)
  --drain MS       listen this long after the last capture (default 20000)
  --out PATH       raw per-event JSON (default test-results/sse-latency/<ts>.json)
  --headed         show the browser, for watching a suspicious run`;

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    baseUrl: process.env['KINO_BASE_URL'] ?? 'http://localhost:5173',
    apiBaseUrl: '',
    rollSlug: '',
    events: 20,
    intervalMs: 3_000,
    drainMs: 20_000,
    outPath: '',
    headed: false,
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
    else if (flag === '--api-base') options.apiBaseUrl = next();
    else if (flag === '--roll') options.rollSlug = next().toUpperCase();
    else if (flag === '--events') options.events = Number(next());
    else if (flag === '--interval') options.intervalMs = Number(next());
    else if (flag === '--drain') options.drainMs = Number(next());
    else if (flag === '--out') options.outPath = resolve(next());
    else if (flag === '--headed') options.headed = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown option: ${flag}`);
  }
  options.baseUrl = normaliseBaseUrl(options.baseUrl, '--base-url');
  options.apiBaseUrl = normaliseBaseUrl(options.apiBaseUrl || options.baseUrl, '--api-base');
  if (!Number.isSafeInteger(options.events) || options.events < 1) throw new Error('--events must be a positive integer');
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 0) throw new Error('--interval must be a non-negative integer');
  if (!Number.isSafeInteger(options.drainMs) || options.drainMs < 0) throw new Error('--drain must be a non-negative integer');
  if (options.outPath === '') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    options.outPath = resolve(REPO_ROOT, 'test-results/sse-latency', `${stamp}.json`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// The in-page probe
// ---------------------------------------------------------------------------

/**
 * Installed with `addInitScript`, so it runs before the app's bundle and can
 * therefore see the app's own `EventSource` from the constructor onward. It
 * wraps the constructor rather than the app's handlers: the app keeps using
 * `EventSource` exactly as written, and no product file changes.
 *
 * Two timestamps come out of here per event:
 *
 * - **received** — the moment the wrapper's own listener runs. It is registered
 *   in the constructor, before the app registers its own, so this is the
 *   earliest observable moment in the tab.
 * - **visible** — the moment a DOM node carrying that capture id is attached.
 *   That is the whole app path: the event arrives, `useRollEvents` re-fetches
 *   the capture, the feed files it and React commits a tile. DOM-attached, not
 *   composited; there is no honest cross-process paint timestamp to take here,
 *   so the number is not called one.
 *
 * It is a **string**, not a function handed to `addInitScript`. A function is
 * injected via `Function.prototype.toString`, which returns whatever the
 * bundler emitted — and esbuild's `keepNames` rewrites a class or a named
 * arrow into a body that calls its own `__name` helper, which does not exist in
 * the page. The first version of this file did exactly that and the probe threw
 * `__name is not defined` before the app loaded, so the run reported "the page
 * never opened an EventSource" for a reason that had nothing to do with the
 * page. A string cannot be rewritten.
 */
const PROBE_SOURCE = String.raw`
(function () {
  var probe = { sources: [], events: [], dom: [] };
  window.__sseProbe = probe;

  // The named events guest-events.ts can emit, plus 'message' for anything
  // unnamed. A named SSE event never fires 'message', so listing them is the
  // only way to see all of them.
  var TYPES = [
    'message',
    'roll.opened', 'roll.closed', 'roll.cleared',
    'capture.created', 'capture.updated', 'capture.hidden', 'capture.deleted',
    'processing.completed'
  ];

  var Native = window.EventSource;
  function Probed(url, init) {
    var source = new Native(url, init);
    var index = probe.sources.length;
    probe.sources.push({ index: index, url: String(url), createdAt: Date.now(), openedAt: null, errors: 0 });
    source.addEventListener('open', function () {
      if (probe.sources[index].openedAt === null) probe.sources[index].openedAt = Date.now();
    });
    source.addEventListener('error', function () { probe.sources[index].errors += 1; });
    for (var i = 0; i < TYPES.length; i += 1) {
      (function (type) {
        source.addEventListener(type, function (event) {
          probe.events.push({
            source: index,
            type: type,
            at: Date.now(),
            lastEventId: typeof event.lastEventId === 'string' && event.lastEventId !== '' ? event.lastEventId : null,
            data: typeof event.data === 'string' ? event.data.slice(0, 400) : null
          });
        });
      })(TYPES[i]);
    }
    return source;
  }
  // The returned object is a real native EventSource, so close(), readyState
  // and everything else the app touches is untouched. Only construction is
  // observed. The statics the app reads (EventSource.CLOSED in useRollEvents)
  // are copied across.
  Probed.CONNECTING = Native.CONNECTING;
  Probed.OPEN = Native.OPEN;
  Probed.CLOSED = Native.CLOSED;
  Probed.prototype = Native.prototype;
  window.EventSource = Probed;

  var seen = {};
  var SELECTOR = '[data-capture-id], a[href*="/c/"]';
  function note(element) {
    var id = element.getAttribute('data-capture-id');
    if (id === null) {
      var matched = /\/c\/([^/?#]+)/.exec(element.getAttribute('href') || '');
      id = matched ? decodeURIComponent(matched[1]) : null;
    }
    if (!id || seen[id] || !element.isConnected) return;
    seen[id] = true;
    probe.dom.push({ captureId: id, at: Date.now() });
  }
  function scan(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.matches(SELECTOR)) note(node);
    var found = node.querySelectorAll(SELECTOR);
    for (var i = 0; i < found.length; i += 1) note(found[i]);
  }
  new MutationObserver(function (records) {
    for (var r = 0; r < records.length; r += 1) {
      if (records[r].type === 'attributes') scan(records[r].target);
      var added = records[r].addedNodes;
      for (var a = 0; a < added.length; a += 1) scan(added[a]);
    }
  }).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-capture-id', 'href']
  });
})();
`;

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? null;
}

interface Spread {
  count: number;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  minMs: number | null;
}

function spreadOf(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? null,
    medianMs: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1] ?? null,
  };
}

interface Row {
  index: number;
  captureId: string;
  /** Driver clock: the `POST …/captures` response arrived. Measured. */
  createdAt: number;
  /** Redis stream clock, from the SSE `id:`. Measured, but a third clock. */
  serverPublishedAt: number | null;
  /** Browser clock: the wrapper's listener ran. Measured. */
  receivedAt: number | null;
  /** Browser clock: a DOM node for this capture was attached. Measured. */
  visibleAt: number | null;
  /**
   * Derived: receivedAt − createdAt. This can be zero or slightly negative, and
   * that is correct, not a clock problem: `device-captures.ts` publishes the
   * event *before* it answers the POST, so on loopback the guest's tab can hold
   * the event before the camera has been told its capture exists. It is not
   * clamped — a negative number is information about the ordering.
   */
  receiveMs: number | null;
  /** Derived: visibleAt − createdAt. */
  visibleMs: number | null;
  /** Derived: gap to the previous event's arrival, in arrival order. */
  arrivalGapMs: number | null;
  /** Derived: gap to the previous event's creation. What the driver actually paced. */
  createGapMs: number | null;
}

type Verdict = 'SSE_STREAMING_PASS' | 'SSE_BUFFERED' | 'SSE_INCONCLUSIVE';

interface Classification {
  verdict: Verdict;
  /** Every reason, in the order the rule evaluates them. */
  reasons: string[];
  signals: Record<string, number | boolean | null>;
}

/**
 * THE RULE. Disagree with it by reading it.
 *
 * Everything is scaled by `effectiveIntervalMs` — the *measured* median gap
 * between capture creations, not the configured `--interval`. The driver
 * uploads four frames per capture and waits for the row to converge, so the
 * real pacing is whatever it managed; comparing arrival gaps against a
 * configured number the driver did not hit is how a harness invents buffering.
 *
 * Inconclusive, checked first, because none of the rest means anything without
 * these:
 *   I1  fewer than 20 correlated events
 *   I2  any created capture never arrived on the stream
 *   I3  the EventSource reconnected or errored during the run — a reconnect
 *       replays from the stream, and replayed events have arrival times that
 *       say nothing about streaming
 *   I4  measured driver↔browser clock offset above 250 ms, which is the same
 *       order as the latencies being measured
 *   I5  the driver could not pace evenly: max create gap > 3 × median create
 *       gap. The arrival pattern is then the driver's, not the path's.
 *
 * Buffered if ANY of:
 *   B1  clustering — at least 30 % of arrivals land within 0.3 × interval of
 *       the previous arrival (events bunched together) AND some arrival gap is
 *       at least 3 × interval (a long silence between bunches). Both halves are
 *       required: bunching alone is jitter, a silence alone is one hiccup. This
 *       is the buffered signature — the path holds events, then releases them
 *       as a block.
 *   B2  sawtooth — receive latency climbs and then resets: some event's receive
 *       latency is at least 1.5 × interval lower than the previous event's, AND
 *       the worst receive latency is at least 2 × interval + 1000 ms. A path
 *       that streams has a flat latency series; a path that fills a buffer makes
 *       the oldest event in each block wait longest, so latency ramps within a
 *       block and drops at the next flush.
 *   B3  p95 receive latency at or above 5000 ms. Not a signature, a floor: at
 *       that point the feed is not live whatever the shape.
 *
 * Pass if not buffered AND p95 receive latency ≤ 1500 ms AND every arrival gap
 * ≤ 2.5 × interval. Otherwise inconclusive — the stream is arriving in order
 * but slowly or unevenly, which is a real third answer and must not be rounded
 * up to a pass.
 */
function classify(rows: readonly Row[], sources: readonly ProbeSource[], skewMs: number, requested: number): Classification {
  const reasons: string[] = [];
  const arrived = rows.filter((row) => row.receivedAt !== null);
  const receive = arrived.map((row) => row.receiveMs as number);
  const gaps = rows.map((row) => row.arrivalGapMs).filter((value): value is number => value !== null);
  const createGaps = rows.map((row) => row.createGapMs).filter((value): value is number => value !== null);

  const medianCreateGap = quantile([...createGaps].sort((a, b) => a - b), 0.5);
  const interval = medianCreateGap ?? 0;
  const maxCreateGap = createGaps.length > 0 ? Math.max(...createGaps) : 0;
  const receiveSorted = [...receive].sort((a, b) => a - b);
  const p95Receive = quantile(receiveSorted, 0.95);
  const maxReceive = receiveSorted[receiveSorted.length - 1] ?? null;
  const maxGap = gaps.length > 0 ? Math.max(...gaps) : null;
  const bunched = interval > 0 ? gaps.filter((gap) => gap < 0.3 * interval).length : 0;
  const bunchedFraction = gaps.length > 0 ? bunched / gaps.length : 0;

  // Largest downward step in the receive-latency series, in arrival order.
  let biggestReset = 0;
  for (let i = 1; i < receive.length; i += 1) {
    const drop = (receive[i - 1] as number) - (receive[i] as number);
    if (drop > biggestReset) biggestReset = drop;
  }

  const reconnects = sources.length - 1 + sources.reduce((total, source) => total + source.errors, 0);

  const signals: Record<string, number | boolean | null> = {
    correlated: arrived.length,
    requested,
    missing: rows.length - arrived.length,
    effectiveIntervalMs: interval,
    maxCreateGapMs: maxCreateGap,
    p95ReceiveMs: p95Receive,
    maxReceiveMs: maxReceive,
    maxArrivalGapMs: maxGap,
    bunchedFraction: Number(bunchedFraction.toFixed(3)),
    biggestLatencyResetMs: biggestReset,
    sseSources: sources.length,
    sseErrors: reconnects,
    clockOffsetMs: skewMs,
  };

  // --- inconclusive gates -------------------------------------------------
  if (arrived.length < 20) reasons.push(`I1 only ${arrived.length} correlated events; 20 is the minimum for a verdict`);
  if (rows.length - arrived.length > 0) reasons.push(`I2 ${rows.length - arrived.length} created captures never arrived on the stream`);
  if (reconnects > 0) reasons.push(`I3 the EventSource reconnected or errored ${reconnects}× during the run, so some arrivals are replays`);
  if (Math.abs(skewMs) > 250) reasons.push(`I4 driver↔browser clock offset ${skewMs} ms is the same order as the latencies measured`);
  if (interval > 0 && maxCreateGap > 3 * interval) {
    reasons.push(`I5 the driver could not pace evenly: max create gap ${maxCreateGap} ms against a ${interval} ms median`);
  }
  if (reasons.length > 0) return { verdict: 'SSE_INCONCLUSIVE', reasons, signals };

  // --- buffered ------------------------------------------------------------
  const clustered = bunchedFraction >= 0.3 && maxGap !== null && maxGap >= 3 * interval;
  if (clustered) {
    reasons.push(
      `B1 clustering: ${(bunchedFraction * 100).toFixed(0)}% of arrivals within 0.3×${interval} ms of the previous one, ` +
        `and a ${maxGap} ms silence (≥ 3× interval)`,
    );
  }
  const sawtooth = biggestReset >= 1.5 * interval && maxReceive !== null && maxReceive >= 2 * interval + 1_000;
  if (sawtooth) {
    reasons.push(`B2 sawtooth: receive latency peaks at ${maxReceive} ms and drops ${biggestReset} ms in one step (≥ 1.5× interval)`);
  }
  if (p95Receive !== null && p95Receive >= 5_000) reasons.push(`B3 p95 receive latency ${p95Receive} ms is at or above the 5000 ms floor`);
  if (reasons.length > 0) return { verdict: 'SSE_BUFFERED', reasons, signals };

  // --- pass, or the grey zone ---------------------------------------------
  if (p95Receive !== null && p95Receive > 1_500) reasons.push(`p95 receive latency ${p95Receive} ms is over the 1500 ms pass ceiling`);
  if (maxGap !== null && interval > 0 && maxGap > 2.5 * interval) {
    reasons.push(`largest arrival gap ${maxGap} ms is over 2.5× the ${interval} ms interval`);
  }
  if (reasons.length > 0) {
    reasons.push('no buffering signature, but not clean either — a slow or uneven stream, not a pass');
    return { verdict: 'SSE_INCONCLUSIVE', reasons, signals };
  }
  return {
    verdict: 'SSE_STREAMING_PASS',
    reasons: [
      `no clustering (${(bunchedFraction * 100).toFixed(0)}% bunched, largest gap ${maxGap} ms against a ${interval} ms interval)`,
      `no latency sawtooth (largest reset ${biggestReset} ms, worst receive ${maxReceive} ms)`,
      `p95 receive latency ${p95Receive} ms within the 1500 ms ceiling`,
    ],
    signals,
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function json(method: string, body?: unknown, token?: string): RequestInit {
  return {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function post<T>(url: string, init: RequestInit, allowed: readonly number[]): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!allowed.includes(response.status)) throw new Error(`POST ${url} → ${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

/**
 * Wraps `globalThis.fetch` so the exact moment a capture row came into
 * existence is recorded on the driver's clock, without reaching inside
 * `runTestUploader` or duplicating any of it. `runTestUploader` returns only
 * after four frames are uploaded and the row has converged, which is seconds
 * after the `capture.created` event was published — using its return value as
 * the creation time would inflate every latency in the run.
 */
function stampCaptureCreation(createdAt: Map<string, number>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await original(input, init);
    const at = Date.now();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && /\/api\/device\/rolls\/[^/]+\/captures$/.test(url) && response.ok) {
      try {
        const body = (await response.clone().json()) as { captureId?: unknown };
        if (typeof body.captureId === 'string') createdAt.set(body.captureId, at);
      } catch {
        // Not a capture-creation body after all; the run will notice the
        // missing timestamp rather than guessing one.
      }
    }
    return response;
  };
  return () => {
    globalThis.fetch = original;
  };
}

/** Measured, not assumed: the browser tab's clock offset from this process's. */
async function measureClockOffset(page: Page): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const before = Date.now();
    const inPage = await page.evaluate(() => Date.now());
    const after = Date.now();
    samples.push(inPage - Math.round((before + after) / 2));
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

async function waitForStream(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const opened = await page.evaluate(() => {
      const probe = (window as unknown as { __sseProbe?: Probe }).__sseProbe;
      return probe?.sources.some((source) => source.openedAt !== null) ?? false;
    });
    if (opened) return;
    if (Date.now() > deadline) throw new Error(`the page did not open an EventSource within ${timeoutMs}ms`);
    await sleep(200);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date();

  // --- provisioning (not the uploader): a device, and a roll to shoot into --
  // Registration is gated (issue #146): the bearer is the provisioning secret.
  // Falls back to the published dev default from apps/api/src/config.ts, which
  // is refused outside development/test.
  const provisioningToken = process.env['PROVISIONING_TOKEN'] ?? 'kino-dev-provisioning-token-do-not-use-in-production';
  const credential = await post<{ deviceId: string; deviceToken: string }>(
    `${options.apiBaseUrl}/api/studio/devices/register`,
    json(
      'POST',
      { serial: `KD4-SSELAT-${randomUUID().slice(0, 12)}`, product: 'KINO D4', hardwareRevision: 'v1', name: 'SSE latency harness' },
      provisioningToken,
    ),
    [200],
  );
  let slug = options.rollSlug;
  if (slug === '') {
    const roll = await post<{ slug: string }>(
      `${options.apiBaseUrl}/api/device/rolls`,
      json('POST', { title: `SSE latency ${startedAt.toISOString().slice(0, 16)}` }, credential.deviceToken),
      [201],
    );
    slug = roll.slug;
  }
  const feedUrl = `${options.baseUrl}/r/${encodeURIComponent(slug)}`;
  console.log(`roll ${slug} — feed ${feedUrl}`);
  console.log(`driving ${options.events} captures at ~${options.intervalMs} ms into ${options.apiBaseUrl}`);

  // --- the browser on the real feed ---------------------------------------
  let browser: Browser | null = null;
  let probe: Probe = { sources: [], events: [], dom: [] };
  let clockOffsetMs = 0;
  const createdAt = new Map<string, number>();
  const order: string[] = [];
  const failures: string[] = [];
  const restoreFetch = stampCaptureCreation(createdAt);

  try {
    browser = await chromium.launch({
      headless: !options.headed,
      // A throttled tab would produce late DOM timestamps and a latency shape
      // that looks like buffering. The confound is removed rather than argued
      // about; these are the same flags playwright.config.ts uses.
      args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    });
    const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
    // A page that throws is a page that measures nothing, and the failure has
    // to be visible in the transcript rather than looking like a silent stream.
    page.on('pageerror', (error) => console.error(`  [page error] ${error.message.split('\n')[0]}`));
    page.on('requestfailed', (request) => console.error(`  [request failed] ${request.url()} ${request.failure()?.errorText ?? ''}`));
    await page.addInitScript({ content: PROBE_SOURCE });
    await page.goto(feedUrl, { waitUntil: 'domcontentloaded' });
    await waitForStream(page, 30_000);
    clockOffsetMs = await measureClockOffset(page);
    console.log(`EventSource open; driver↔browser clock offset ${clockOffsetMs} ms`);

    // --- generate the events ----------------------------------------------
    for (let i = 0; i < options.events; i += 1) {
      const tick = Date.now();
      const before = new Set(createdAt.keys());
      try {
        await runTestUploader({
          baseUrl: options.apiBaseUrl,
          deviceId: credential.deviceId,
          deviceToken: credential.deviceToken,
          rollSlug: slug,
          captureCount: 1,
        });
      } catch (error) {
        failures.push(`capture ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const id of createdAt.keys()) if (!before.has(id)) order.push(id);
      process.stdout.write(`\r  created ${order.length}/${options.events}`);
      if (i < options.events - 1) await sleep(options.intervalMs - (Date.now() - tick));
    }
    process.stdout.write('\n');

    // --- let stragglers land ----------------------------------------------
    const deadline = Date.now() + options.drainMs;
    for (;;) {
      probe = await page.evaluate(() => (window as unknown as { __sseProbe: Probe }).__sseProbe);
      const seenOnStream = new Set(
        probe.events
          .map((event) => {
            try {
              return (JSON.parse(event.data ?? '{}') as { captureId?: string }).captureId;
            } catch {
              return undefined;
            }
          })
          .filter((id): id is string => id !== undefined),
      );
      const seenInDom = new Set(probe.dom.map((entry) => entry.captureId));
      const complete = order.every((id) => seenOnStream.has(id) && seenInDom.has(id));
      if (complete || Date.now() > deadline) break;
      await sleep(500);
    }
  } finally {
    restoreFetch();
    await browser?.close();
  }

  // --- correlate -----------------------------------------------------------
  const receivedByCapture = new Map<string, ProbeEvent>();
  for (const event of probe.events) {
    if (event.type !== 'capture.created' || event.data === null) continue;
    let captureId: string | undefined;
    try {
      captureId = (JSON.parse(event.data) as { captureId?: string }).captureId;
    } catch {
      continue;
    }
    if (captureId === undefined || receivedByCapture.has(captureId)) continue;
    receivedByCapture.set(captureId, event);
  }
  const domByCapture = new Map(probe.dom.map((entry) => [entry.captureId, entry.at] as const));

  const rows: Row[] = order.map((captureId, index) => {
    const created = createdAt.get(captureId) as number;
    const event = receivedByCapture.get(captureId);
    // The SSE `id:` is a Redis stream entry id, `<milliseconds>-<sequence>`
    // (apps/api/src/events/publish.ts). Its millisecond half is a real
    // server-side publish time — from the Redis container's clock, which is a
    // third clock and not the driver's.
    const streamMs = event?.lastEventId?.match(/^(\d+)-\d+$/)?.[1];
    const visibleAt = domByCapture.get(captureId) ?? null;
    return {
      index: index + 1,
      captureId,
      createdAt: created,
      serverPublishedAt: streamMs === undefined ? null : Number(streamMs),
      receivedAt: event?.at ?? null,
      visibleAt,
      receiveMs: event === undefined ? null : event.at - created,
      visibleMs: visibleAt === null ? null : visibleAt - created,
      arrivalGapMs: null,
      createGapMs: null,
    };
  });

  // Gaps in arrival order, which is not necessarily creation order — under
  // buffering it very much is not.
  const byArrival = rows.filter((row) => row.receivedAt !== null).sort((a, b) => (a.receivedAt as number) - (b.receivedAt as number));
  for (let i = 1; i < byArrival.length; i += 1) {
    const current = byArrival[i];
    const previous = byArrival[i - 1];
    if (current === undefined || previous === undefined) continue;
    current.arrivalGapMs = (current.receivedAt as number) - (previous.receivedAt as number);
  }
  for (let i = 1; i < rows.length; i += 1) {
    const current = rows[i];
    const previous = rows[i - 1];
    if (current === undefined || previous === undefined) continue;
    current.createGapMs = current.createdAt - previous.createdAt;
  }

  const classification = classify(rows, probe.sources, clockOffsetMs, options.events);

  // --- report --------------------------------------------------------------
  const receive = rows.map((row) => row.receiveMs).filter((value): value is number => value !== null);
  const visible = rows.map((row) => row.visibleMs).filter((value): value is number => value !== null);
  const gaps = rows.map((row) => row.arrivalGapMs).filter((value): value is number => value !== null);
  const serverToBrowser = rows
    .filter((row) => row.serverPublishedAt !== null && row.receivedAt !== null)
    .map((row) => (row.receivedAt as number) - (row.serverPublishedAt as number));

  console.log('');
  console.log('  #  capture                        create→receive  create→visible  arrival gap  server publish');
  for (const row of rows) {
    const cell = (value: number | null, width: number): string => (value === null ? '—' : `${value} ms`).padStart(width);
    console.log(
      `${String(row.index).padStart(3)}  ${row.captureId.padEnd(30)}${cell(row.receiveMs, 14)}  ${cell(row.visibleMs, 14)}  ` +
        `${cell(row.arrivalGapMs, 11)}  ${row.serverPublishedAt === null ? '—'.padStart(14) : cell((row.serverPublishedAt as number) - row.createdAt, 14)}`,
    );
  }
  console.log('');
  const line = (label: string, s: Spread): void => {
    console.log(
      `  ${label.padEnd(22)} n=${String(s.count).padEnd(4)} median ${String(s.medianMs ?? '—').padStart(6)} ms   ` +
        `p95 ${String(s.p95Ms ?? '—').padStart(6)} ms   max ${String(s.maxMs ?? '—').padStart(6)} ms`,
    );
  };
  line('receive latency', spreadOf(receive));
  line('visible latency', spreadOf(visible));
  line('arrival gap', spreadOf(gaps));
  if (serverToBrowser.length > 0) line('server→browser*', spreadOf(serverToBrowser));
  console.log('');
  console.log('  Clocks:');
  console.log(`    driver and browser: ${Math.abs(clockOffsetMs) <= 250 ? 'shared' : 'NOT shared'} — measured offset ${clockOffsetMs} ms.`);
  console.log('      Both are processes on the machine running this script, so receive and');
  console.log('      visible latency are single-clock differences. If the browser is ever moved');
  console.log('      to a phone, they stop being comparable and this line will say so.');
  if (serverToBrowser.length > 0) {
    console.log('    * server publish time is real, not derived: the SSE `id:` is a Redis stream');
    console.log('      entry id and its first half is the append time in milliseconds. It is the');
    console.log('      REDIS clock, a third clock, so server→browser is only meaningful when the');
    console.log('      origin and this machine are the same host. Compare its spread, not its');
    console.log('      absolute value, across runs on different paths.');
  } else {
    console.log('    * no server-side send time was obtainable on this run: no SSE `id:` reached');
    console.log('      the browser. Not estimated, not filled in.');
  }
  if (failures.length > 0) {
    console.log('');
    console.log('  Driver failures:');
    for (const failure of failures) console.log(`    ${failure}`);
  }
  console.log('');
  console.log(`  VERDICT: ${classification.verdict}`);
  for (const reason of classification.reasons) console.log(`    · ${reason}`);
  if (failures.length > 0) {
    // Deliberately not part of the verdict: a frame upload that 429s does not
    // change whether the `capture.created` event streamed, and folding it in
    // would make an ingress verdict depend on an unrelated rate limit. It is
    // repeated here so a green verdict cannot hide it.
    console.log(`    · ${failures.length} of ${options.events} captures had a driver-side upload failure — see above. It does`);
    console.log('      not affect the verdict (the row and its event exist either way) but it is not nothing.');
  }

  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(
    options.outPath,
    `${JSON.stringify(
      {
        tool: 'infra/scripts/sse-latency.ts',
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        options,
        rollSlug: slug,
        feedUrl,
        clocks: {
          driverBrowserOffsetMs: clockOffsetMs,
          driverBrowserShared: Math.abs(clockOffsetMs) <= 250,
          serverPublishClock: 'redis-stream-entry-id',
        },
        summary: {
          receiveMs: spreadOf(receive),
          visibleMs: spreadOf(visible),
          arrivalGapMs: spreadOf(gaps),
          serverToBrowserMs: serverToBrowser.length > 0 ? spreadOf(serverToBrowser) : null,
        },
        classification,
        driverFailures: failures,
        sseSources: probe.sources,
        rows,
        rawEvents: probe.events,
        rawDom: probe.dom,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`  raw: ${options.outPath}`);

  if (classification.verdict === 'SSE_BUFFERED') process.exitCode = 1;
  else if (classification.verdict === 'SSE_INCONCLUSIVE') process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(`sse latency run failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
