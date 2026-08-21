#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface AssetStatus {
  role: string;
  frameIndex: number | null;
  status: string;
}

export interface TestUploaderCaptureResult {
  captureId: string;
  status: string;
  assets: AssetStatus[];
}

export interface TestUploaderResult {
  deviceId: string;
  rollId: string;
  slug: string;
  guestUrl: string;
  captures: TestUploaderCaptureResult[];
  guestCaptureIds: string[];
  viewerRequests: number;
  rollStatus: string;
  droppedPartRetried: boolean;
  duplicateRetriesVerified: boolean;
  elapsedMs: number;
}

export interface TestUploaderOptions {
  baseUrl: string;
  serial?: string;
  deviceId?: string;
  deviceToken?: string;
  rollSlug?: string;
  title?: string;
  fixtureDirectory?: string;
  captureCount?: number;
  concurrency?: number;
  viewerCount?: number;
  viewerPolls?: number;
  dropPart?: number;
  duplicateRetry?: boolean;
  slowMs?: number;
  closeRoll?: boolean;
  waitTimeoutMs?: number;
}

interface DeviceCredential {
  deviceId: string;
  deviceToken: string;
}

interface CreatedRoll {
  rollId: string;
  slug: string;
  guestUrl: string;
  hostToken: string;
}

interface UploadInit {
  uploadId: string;
  partSize: number;
  alreadyComplete: boolean;
}

interface CaptureStatus {
  status: string;
  assets: AssetStatus[];
}

interface Fixture {
  frameIndex: number;
  body: Buffer;
  sha256: string;
}

const DEFAULT_FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../packages/test-fixtures/media',
);
const TERMINAL_CAPTURE_STATUSES = new Set(['ready', 'partial', 'failed']);

const sleep = async (ms: number): Promise<void> => {
  if (ms > 0) await new Promise<void>((done) => setTimeout(done, ms));
};

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1) throw new Error(`${name} must be a positive integer`);
  return chosen;
}

function normaliseBaseUrl(value: string): string {
  if (!URL.canParse(value)) throw new Error('--base-url must be an absolute URL');
  return value.replace(/\/$/, '');
}

function errorDetail(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const record = body as Record<string, unknown>;
  const code = typeof record['code'] === 'string' ? record['code'] : '';
  const message = typeof record['message'] === 'string' ? record['message'] : '';
  return [code, message].filter(Boolean).join(': ');
}

async function fixturesAt(directory: string): Promise<Fixture[]> {
  const names = (await readdir(directory))
    .filter((name) => /^frame-\d+\.jpe?g$/i.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  if (names.length === 0) throw new Error(`no frame-*.jpg fixtures found in ${directory}`);

  return Promise.all(
    names.map(async (name, index) => {
      const body = await readFile(resolve(directory, name));
      return {
        frameIndex: index + 1,
        body,
        sha256: createHash('sha256').update(body).digest('hex'),
      };
    }),
  );
}

/**
 * Drives the public camera wire contract. Credentials are kept in this call's
 * closure and deliberately omitted from the returned result and CLI output.
 */
export async function runTestUploader(options: TestUploaderOptions): Promise<TestUploaderResult> {
  const startedAt = Date.now();
  const baseUrl = normaliseBaseUrl(options.baseUrl);
  const captureCount = positiveInteger(options.captureCount, 1, 'captureCount');
  const concurrency = Math.min(
    positiveInteger(options.concurrency, 1, 'concurrency'),
    captureCount,
  );
  const viewerCount = positiveInteger(options.viewerCount, 1, 'viewerCount');
  const viewerPolls = positiveInteger(options.viewerPolls, 1, 'viewerPolls');
  const waitTimeoutMs = positiveInteger(options.waitTimeoutMs, 60_000, 'waitTimeoutMs');
  const slowMs = options.slowMs ?? 0;
  if (!Number.isSafeInteger(slowMs) || slowMs < 0) throw new Error('slowMs must be a non-negative integer');
  if (options.dropPart !== undefined) positiveInteger(options.dropPart, 1, 'dropPart');

  const fixtures = await fixturesAt(options.fixtureDirectory ?? DEFAULT_FIXTURES);
  let requestCount = 0;
  let partAttempt = 0;
  let droppedPartRetried = false;
  let duplicateRetriesVerified = false;

  async function request<T>(
    path: string,
    init: RequestInit = {},
    allowedStatuses: readonly number[] = [200],
  ): Promise<T> {
    if (requestCount > 0) await sleep(slowMs);
    requestCount += 1;
    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    let body: unknown = undefined;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!allowedStatuses.includes(response.status)) {
      const detail = errorDetail(body);
      throw new Error(
        `${init.method ?? 'GET'} ${path} returned ${response.status}${detail ? ` (${detail})` : ''}`,
      );
    }
    return body as T;
  }

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

  let credential: DeviceCredential;
  if (options.deviceId !== undefined || options.deviceToken !== undefined) {
    if (!options.deviceId || !options.deviceToken) {
      throw new Error('deviceId and deviceToken must be supplied together');
    }
    credential = { deviceId: options.deviceId, deviceToken: options.deviceToken };
  } else {
    credential = await request<DeviceCredential>(
      '/api/studio/devices/register',
      json('POST', {
        serial: options.serial ?? `KD4-UPLOADER-${randomUUID().slice(0, 12)}`,
        product: 'KINO D4',
        hardwareRevision: 'v1',
        name: 'Test uploader',
      }),
    );
  }

  let roll: CreatedRoll;
  if (options.rollSlug !== undefined) {
    const joined = await request<{ rollId: string; title: string; status: string }>(
      '/api/device/rolls/join',
      json('POST', { slug: options.rollSlug }, credential.deviceToken),
    );
    roll = {
      rollId: joined.rollId,
      slug: options.rollSlug.toUpperCase(),
      guestUrl: `${baseUrl}/r/${options.rollSlug.toUpperCase()}`,
      hostToken: '',
    };
  } else {
    roll = await request<CreatedRoll>(
      '/api/device/rolls',
      json('POST', { title: options.title ?? 'KINO uploader acceptance' }, credential.deviceToken),
      [201],
    );
  }

  async function createAndUpload(sequence: number): Promise<TestUploaderCaptureResult> {
    const captureUuid = randomUUID();
    const captureDocument = {
      schema: 'kino.capture',
      version: 1,
      id: `cap_local_${captureUuid}`,
      captureUuid,
      deviceId: credential.deviceId,
      mode: 'wiggle',
      capturedAt: new Date(Date.now() + sequence).toISOString(),
      frameCount: fixtures.length,
      resolution: '1600x1200',
      status: 'created',
      visible: true,
    };
    const capturePath = `/api/device/rolls/${roll.rollId}/captures`;
    const created = await request<{ captureId: string }>(
      capturePath,
      json('POST', captureDocument, credential.deviceToken),
      [201],
    );

    if (options.duplicateRetry) {
      const replay = await request<{ captureId: string }>(
        capturePath,
        json('POST', captureDocument, credential.deviceToken),
        [200],
      );
      if (replay.captureId !== created.captureId) {
        throw new Error('duplicate capture retry returned a different captureId');
      }
      duplicateRetriesVerified = true;
    }

    for (const fixture of fixtures) {
      const initBody = {
        role: 'original-frame',
        frameIndex: fixture.frameIndex,
        mime: 'image/jpeg',
        bytes: fixture.body.length,
        sha256: fixture.sha256,
      };
      const initPath = `/api/device/captures/${created.captureId}/assets/init`;
      const upload = await request<UploadInit>(
        initPath,
        json('POST', initBody, credential.deviceToken),
      );
      if (upload.alreadyComplete) continue;

      let partNo = 1;
      for (let offset = 0; offset < fixture.body.length; offset += upload.partSize) {
        const body = fixture.body.subarray(offset, Math.min(offset + upload.partSize, fixture.body.length));
        const partPath = `/api/device/uploads/${upload.uploadId}/parts/${partNo}`;
        const partRequest: RequestInit = {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${credential.deviceToken}`,
            'content-type': 'application/octet-stream',
          },
          body,
        };
        partAttempt += 1;
        await request(partPath, partRequest);
        if (options.dropPart === partAttempt) {
          // The first response is treated as lost. Re-sending the same numbered
          // part proves that a camera can retry without corrupting the object.
          await request(partPath, partRequest);
          droppedPartRetried = true;
        }
        partNo += 1;
      }

      const completePath = `/api/device/uploads/${upload.uploadId}/complete`;
      await request(completePath, json('POST', undefined, credential.deviceToken));

      if (options.duplicateRetry) {
        await request(completePath, json('POST', undefined, credential.deviceToken));
        const replay = await request<UploadInit>(
          initPath,
          json('POST', initBody, credential.deviceToken),
        );
        if (!replay.alreadyComplete || replay.uploadId !== upload.uploadId) {
          throw new Error('duplicate asset retry did not converge on the completed upload');
        }
      }
    }

    const completeCapturePath = `/api/device/captures/${created.captureId}/complete`;
    await request(completeCapturePath, json('POST', undefined, credential.deviceToken));
    if (options.duplicateRetry) {
      await request(completeCapturePath, json('POST', undefined, credential.deviceToken));
    }

    const deadline = Date.now() + waitTimeoutMs;
    let status: CaptureStatus = { status: 'processing', assets: [] };
    while (Date.now() < deadline) {
      status = await request<CaptureStatus>(
        `/api/device/captures/${created.captureId}/status`,
        json('GET', undefined, credential.deviceToken),
      );
      if (TERMINAL_CAPTURE_STATUSES.has(status.status)) break;
      await sleep(Math.max(100, slowMs));
    }
    if (!TERMINAL_CAPTURE_STATUSES.has(status.status)) {
      throw new Error(`capture ${created.captureId} did not finish within ${waitTimeoutMs}ms`);
    }
    if (status.status !== 'ready') {
      throw new Error(`capture ${created.captureId} finished as ${status.status}`);
    }
    return { captureId: created.captureId, ...status };
  }

  const captures: TestUploaderCaptureResult[] = new Array(captureCount);
  let nextCapture = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextCapture < captureCount) {
        const sequence = nextCapture;
        nextCapture += 1;
        captures[sequence] = await createAndUpload(sequence);
      }
    }),
  );

  if (options.dropPart !== undefined && !droppedPartRetried) {
    throw new Error(`--drop-part ${options.dropPart} exceeded the ${partAttempt} uploaded parts`);
  }

  async function readGuestFeed(): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: '100' });
      if (cursor !== null) query.set('cursor', cursor);
      const page = await request<{
        items: { captureId: string }[];
        nextCursor: string | null;
        hasMore: boolean;
      }>(`/api/rolls/${roll.slug}/captures?${query}`);
      ids.push(...page.items.map((capture) => capture.captureId));
      cursor = page.hasMore ? page.nextCursor : null;
      if (page.hasMore && cursor === null) throw new Error('guest feed claims another page without a cursor');
    } while (cursor !== null);
    return ids;
  }

  let viewerRequests = 0;
  let guestCaptureIds: string[] = [];
  await Promise.all(
    Array.from({ length: viewerCount }, async (_unused, viewerIndex) => {
      for (let poll = 0; poll < viewerPolls; poll += 1) {
        const ids = await readGuestFeed();
        viewerRequests += 1;
        if (viewerIndex === 0 && poll === 0) guestCaptureIds = ids;
      }
    }),
  );
  for (const capture of captures) {
    if (!guestCaptureIds.includes(capture.captureId)) {
      throw new Error(`ready capture ${capture.captureId} is absent from the guest feed`);
    }
  }

  let rollStatus = 'live';
  if (options.closeRoll) {
    if (roll.hostToken === '') throw new Error('--close cannot be used when joining an existing Roll');
    const closed = await request<{ status: string }>(
      `/api/host/rolls/${roll.rollId}`,
      json('PATCH', { status: 'closed' }, roll.hostToken),
    );
    rollStatus = closed.status;
    if (rollStatus !== 'closed') throw new Error(`Roll close returned status ${rollStatus}`);
  }

  return {
    deviceId: credential.deviceId,
    rollId: roll.rollId,
    slug: roll.slug,
    guestUrl: roll.guestUrl,
    captures,
    guestCaptureIds,
    viewerRequests,
    rollStatus,
    droppedPartRetried,
    duplicateRetriesVerified,
    elapsedMs: Date.now() - startedAt,
  };
}

function duration(value: string): number {
  const match = /^(\d+)(ms|s)?$/.exec(value);
  if (match === null) throw new Error(`invalid duration: ${value}`);
  const amount = Number(match[1]);
  return match[2] === 's' ? amount * 1_000 : amount;
}

export function parseTestUploaderArgs(argv: readonly string[]): TestUploaderOptions {
  const options: TestUploaderOptions = {
    baseUrl: process.env['KINO_BASE_URL'] ?? 'http://localhost:3000',
    deviceId: process.env['KINO_DEVICE_ID'],
    deviceToken: process.env['KINO_DEVICE_TOKEN'],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };
    if (flag === '--base-url') options.baseUrl = next();
    else if (flag === '--serial') options.serial = next();
    else if (flag === '--join') options.rollSlug = next();
    else if (flag === '--title') options.title = next();
    else if (flag === '--fixtures') options.fixtureDirectory = resolve(next());
    else if (flag === '--captures') options.captureCount = Number(next());
    else if (flag === '--concurrency') options.concurrency = Number(next());
    else if (flag === '--viewers') options.viewerCount = Number(next());
    else if (flag === '--viewer-polls') options.viewerPolls = Number(next());
    else if (flag === '--drop-part') options.dropPart = Number(next());
    else if (flag === '--slow') options.slowMs = duration(next());
    else if (flag === '--wait') options.waitTimeoutMs = duration(next());
    else if (flag === '--dup-retry') options.duplicateRetry = true;
    else if (flag === '--close') options.closeRoll = true;
    else throw new Error(`unknown option: ${flag}`);
  }
  return options;
}

function printUsage(): void {
  console.log(`Usage: npm run test:uploader -- [options]

Options:
  --base-url URL       API/proxy origin (default: KINO_BASE_URL or localhost:3000)
  --serial SERIAL      serial for a fresh test registration
  --join SLUG          join an existing Roll instead of creating one
  --title TEXT         title for a newly created Roll
  --fixtures DIR       directory containing frame-*.jpg fixtures
  --captures N         upload N captures (load mode)
  --concurrency N      concurrent capture uploaders (default 1)
  --viewers N          concurrent guest feed readers (default 1)
  --viewer-polls N     complete paginated feed reads per viewer (default 1)
  --drop-part N        retry the Nth part as if its first ACK was lost
  --dup-retry          replay capture, upload-complete and asset-init calls
  --slow 200ms         delay every network request (also accepts seconds)
  --wait 90s           processing timeout per capture
  --close              close a newly created Roll after guest-feed verification

For an already registered device, set KINO_DEVICE_ID and KINO_DEVICE_TOKEN.
The token is accepted only through the environment and is never printed.`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }
  const result = await runTestUploader(parseTestUploaderArgs(process.argv.slice(2)));
  console.log(
    JSON.stringify(
      {
        ok: true,
        deviceId: result.deviceId,
        rollId: result.rollId,
        slug: result.slug,
        guestUrl: result.guestUrl,
        captures: result.captures.map(({ captureId, status }) => ({ captureId, status })),
        viewerRequests: result.viewerRequests,
        rollStatus: result.rollStatus,
        droppedPartRetried: result.droppedPartRetried,
        duplicateRetriesVerified: result.duplicateRetriesVerified,
        elapsedMs: result.elapsedMs,
      },
      null,
      2,
    ),
  );
}

const invoked = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`test uploader failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
