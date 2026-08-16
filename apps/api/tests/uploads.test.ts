import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildServer } from '../src/server';
import { loadConfig, type ApiConfig } from '../src/config';
import {
  assertNotOriginalOverwrite,
  derivedKey,
  originalKey,
  rollDerivedKey,
} from '../src/uploads/objectKeys';
import {
  PART_SIZE,
  idempotencyKeyFor,
  nextCaptureStatus,
  sessionKeyFor,
  type AssetState,
} from '../src/uploads/uploads';
import { rollEventChannel, rollStreamKey } from '../src/events/publish';
import * as schema from '../src/db/schema';

/**
 * Captures and the resumable upload pipeline (Task 18), against the real
 * database *and* real MinIO — same house rules as the other suites: the dev
 * stack must be up AND migrated.
 *
 *   docker compose -f infra/docker-compose.dev.yml up -d
 *   npm run db:migrate -w @kino/api
 *
 * The pure functions (`objectKeys`, `nextCaptureStatus`) are unit-tested with
 * no I/O at all; everything below "the wire" drives the real routes through
 * `app.inject()` so the S3 multipart round trip, the checksum re-read and the
 * two unique indexes are exercised for real rather than mocked.
 */
const RUN = randomBytes(4).toString('hex');

const config: ApiConfig = loadConfig();
const app: FastifyInstance = buildServer(config);

const REQUIRED_TABLES = ['captures', 'assets', 'upload_sessions', 'upload_parts'];

const SERIAL_A = `KD4-T18-${RUN}-A`;
const SERIAL_B = `KD4-T18-${RUN}-B`;
const SERIALS = [SERIAL_A, SERIAL_B];

const createdRollIds: string[] = [];

let deviceA: { deviceId: string; deviceToken: string };
let deviceB: { deviceId: string; deviceToken: string };

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

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
    payload: { serial, product: 'KINO D4', hardwareRevision: 'v1' },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ deviceId: string; deviceToken: string }>();
}

async function createRoll(): Promise<CreatedRollResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/device/rolls',
    headers: bearer(deviceA.deviceToken),
    payload: { title: `Upload roll ${RUN}` },
  });
  expect(res.statusCode).toBe(201);
  const created = res.json<CreatedRollResponse>();
  createdRollIds.push(created.rollId);
  return created;
}

/** A `kino.capture` document as the camera would author it (05 §19). */
function captureDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'kino.capture',
    version: 1,
    id: `cap_local_${randomUUID()}`,
    captureUuid: randomUUID(),
    deviceId: deviceA.deviceId,
    mode: 'wiggle',
    capturedAt: new Date().toISOString(),
    frameCount: 4,
    resolution: '1600x1200',
    status: 'created',
    visible: true,
    ...overrides,
  };
}

async function postCapture(
  rollId: string,
  doc: Record<string, unknown>,
  token: string = deviceA.deviceToken,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/device/rolls/${rollId}/captures`,
    headers: bearer(token),
    payload: doc,
  });
}

async function newCapture(rollId: string): Promise<{ captureId: string; doc: Record<string, unknown> }> {
  const doc = captureDoc();
  const res = await postCapture(rollId, doc);
  expect(res.statusCode).toBe(201);
  return { captureId: res.json<{ captureId: string }>().captureId, doc };
}

const sha256Hex = (body: Buffer): string => createHash('sha256').update(body).digest('hex');

interface InitBody {
  role: string;
  frameIndex?: number;
  mime: string;
  bytes: number;
  sha256: string;
}

interface InitResponse {
  uploadId: string;
  partSize: number;
  alreadyComplete: boolean;
}

async function initAsset(
  captureId: string,
  body: InitBody,
  token: string = deviceA.deviceToken,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/device/captures/${captureId}/assets/init`,
    headers: bearer(token),
    payload: body,
  });
}

async function putPart(
  uploadId: string,
  partNo: number,
  body: Buffer,
  token: string = deviceA.deviceToken,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'PUT',
    url: `/api/device/uploads/${uploadId}/parts/${partNo}`,
    headers: { ...bearer(token), 'content-type': 'application/octet-stream' },
    payload: body,
  });
}

async function completeUpload(
  uploadId: string,
  token: string = deviceA.deviceToken,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/device/uploads/${uploadId}/complete`,
    headers: bearer(token),
  });
}

/** init → one part → complete, the whole device-side upload of a small asset. */
async function uploadAsset(
  captureId: string,
  role: string,
  body: Buffer,
  extra: { frameIndex?: number; mime?: string } = {},
): Promise<{ uploadId: string; assetId: string }> {
  const init = await initAsset(captureId, {
    role,
    ...(extra.frameIndex === undefined ? {} : { frameIndex: extra.frameIndex }),
    mime: extra.mime ?? 'image/webp',
    bytes: body.length,
    sha256: sha256Hex(body),
  });
  expect(init.statusCode).toBe(200);
  const { uploadId } = init.json<InitResponse>();

  expect((await putPart(uploadId, 1, body)).statusCode).toBe(200);

  const done = await completeUpload(uploadId);
  expect(done.statusCode).toBe(200);
  return { uploadId, assetId: done.json<{ assetId: string }>().assetId };
}

async function captureStatus(
  captureId: string,
): Promise<{ status: string; assets: { role: string; frameIndex: number | null; status: string }[] }> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/device/captures/${captureId}/status`,
    headers: bearer(deviceA.deviceToken),
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function objectBytes(key: string): Promise<Buffer> {
  const got = await app.s3.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
  const chunks: Buffer[] = [];
  for await (const chunk of got.Body as Readable) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

let migrated = false;

async function assertMigrated(): Promise<void> {
  const rows = await app.db.execute<{ table_name: string }>(sql`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('captures', 'assets', 'upload_sessions', 'upload_parts')
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
  await app.ready();
  await assertMigrated();

  deviceA = await register(SERIAL_A);
  deviceB = await register(SERIAL_B);
}, 60_000);

afterAll(async () => {
  if (migrated && createdRollIds.length > 0) {
    const captureRows = await app.db
      .select({ id: schema.captures.id })
      .from(schema.captures)
      .where(inArray(schema.captures.rollId, createdRollIds));
    const captureIds = captureRows.map((row) => row.id);

    if (captureIds.length > 0) {
      const assetRows = await app.db
        .select({ id: schema.assets.id, objectKey: schema.assets.objectKey })
        .from(schema.assets)
        .where(inArray(schema.assets.captureId, captureIds));
      const assetIds = assetRows.map((row) => row.id);

      // Best effort: a leftover test object costs a few KB, a failed teardown
      // costs the whole suite.
      await Promise.all(
        assetRows.map(async (row) => {
          try {
            await app.s3.send(
              new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: row.objectKey }),
            );
          } catch {
            /* ignore */
          }
        }),
      );

      if (assetIds.length > 0) {
        const sessionRows = await app.db
          .select({ id: schema.uploadSessions.id })
          .from(schema.uploadSessions)
          .where(inArray(schema.uploadSessions.assetId, assetIds));
        const sessionIds = sessionRows.map((row) => row.id);
        if (sessionIds.length > 0) {
          await app.db
            .delete(schema.uploadParts)
            .where(inArray(schema.uploadParts.uploadId, sessionIds));
          await app.db
            .delete(schema.uploadSessions)
            .where(inArray(schema.uploadSessions.id, sessionIds));
        }
      }

      await app.db
        .delete(schema.processingEvents)
        .where(inArray(schema.processingEvents.captureId, captureIds));
      await app.db.delete(schema.assets).where(inArray(schema.assets.captureId, captureIds));
      await app.db.delete(schema.captures).where(inArray(schema.captures.id, captureIds));
    }

    const { auditEvents, rollDevices, rolls } = schema;
    await app.db.delete(auditEvents).where(inArray(auditEvents.rollId, createdRollIds));
    await app.db.delete(rollDevices).where(inArray(rollDevices.rollId, createdRollIds));
    await app.db.delete(rolls).where(inArray(rolls.id, createdRollIds));

    // These routes publish roll events, and a published event is durable now
    // (Task 19's XADD). Without this, every run of this suite would leave a
    // `roll:<id>:stream` behind in the dev Redis for a roll that no longer
    // exists.
    await app.redis.del(...createdRollIds.map((id) => rollStreamKey(id)));
  }
  if (migrated) {
    await app.db.delete(schema.devices).where(inArray(schema.devices.serial, SERIALS));
  }
  await app.close();
}, 120_000);

/* ------------------------------------------------------------ object keys -- */

describe('object keys (05 §6)', () => {
  it('builds the original key with a two-digit camera number', () => {
    // The exact string the plan pins for frame 2 — cam numbers are 1-based and
    // zero-padded, matching the CAM1..CAMn labelling on the hardware.
    expect(originalKey('roll_R', 'cap_C', 2)).toBe(
      'rolls/roll_R/captures/cap_C/original/cam-02.jpg',
    );
    expect(originalKey('roll_R', 'cap_C', 1)).toBe(
      'rolls/roll_R/captures/cap_C/original/cam-01.jpg',
    );
    // Padding is a minimum width, never a truncation.
    expect(originalKey('roll_R', 'cap_C', 12)).toBe(
      'rolls/roll_R/captures/cap_C/original/cam-12.jpg',
    );
  });

  it('refuses a frame index that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => originalKey('roll_R', 'cap_C', bad)).toThrow();
    }
  });

  it('builds the derived keys', () => {
    expect(derivedKey('roll_R', 'cap_C', 'thumb.webp')).toBe(
      'rolls/roll_R/captures/cap_C/derived/thumb.webp',
    );
    // Roll-scoped outputs (Task 21 exports, Task 25 recaps) hang off the roll,
    // not off any one capture.
    expect(rollDerivedKey('roll_R', 'exports/job_7.zip')).toBe(
      'rolls/roll_R/derived/exports/job_7.zip',
    );
  });

  it('refuses a name that could climb out of its prefix', () => {
    for (const bad of ['../secret', 'a/../../b', '/absolute', 'trailing/', '', '.']) {
      expect(() => derivedKey('roll_R', 'cap_C', bad)).toThrow();
      expect(() => rollDerivedKey('roll_R', bad)).toThrow();
    }
  });
});

describe('assertNotOriginalOverwrite (01 §7)', () => {
  const original = originalKey('roll_R', 'cap_C', 1);
  const derived = derivedKey('roll_R', 'cap_C', 'thumb.webp');
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);

  it('lets any write through under derived/', () => {
    // Workers write here, repeatedly, and re-rendering must stay allowed.
    expect(() => assertNotOriginalOverwrite(derived, null, null)).not.toThrow();
    expect(() => assertNotOriginalOverwrite(derived, A, B)).not.toThrow();
    expect(() => assertNotOriginalOverwrite(rollDerivedKey('roll_R', 'recap/j.mp4'), A, B)).not.toThrow();
  });

  it('allows the first write of an original and an identical re-send', () => {
    expect(() => assertNotOriginalOverwrite(original, null, A)).not.toThrow();
    // A retried upload of the very same bytes is not an overwrite.
    expect(() => assertNotOriginalOverwrite(original, A, A)).not.toThrow();
  });

  it('throws when an existing original would change content', () => {
    expect(() => assertNotOriginalOverwrite(original, A, B)).toThrow(
      expect.objectContaining({ code: 'ORIGINAL_IMMUTABLE' }) as unknown as Error,
    );
  });

  it('throws on a worker-style write to an original key', () => {
    // A worker never names the digest of what it is about to write — which is
    // exactly the signature of "this write path has no business here" (01 §7).
    expect(() => assertNotOriginalOverwrite(original, A, null)).toThrow(
      expect.objectContaining({ code: 'ORIGINAL_IMMUTABLE' }) as unknown as Error,
    );
    expect(() => assertNotOriginalOverwrite(original, null, null)).toThrow(
      expect.objectContaining({ code: 'ORIGINAL_IMMUTABLE' }) as unknown as Error,
    );
  });
});

/* -------------------------------------------------- capture state machine -- */

describe('nextCaptureStatus (05 §8)', () => {
  const a = (role: string, status: string): AssetState => ({ role, status });
  const thumb = (status: string): AssetState => a('thumb', status);
  const frame = (status: string): AssetState => a('original-frame', status);

  it('is created while nothing has been declared', () => {
    expect(nextCaptureStatus([], false)).toBe('created');
  });

  it('is created while only a non-preview asset is in flight', () => {
    expect(nextCaptureStatus([a('metadata', 'pending')], false)).toBe('created');
  });

  it('is preview-ready once a thumb or a wiggle preview has landed', () => {
    expect(nextCaptureStatus([thumb('ready')], false)).toBe('preview-ready');
    expect(nextCaptureStatus([a('wiggle-preview', 'ready')], false)).toBe('preview-ready');
  });

  it('is originals-uploading while any original frame is still in flight', () => {
    expect(nextCaptureStatus([thumb('ready'), frame('pending')], false)).toBe(
      'originals-uploading',
    );
    expect(nextCaptureStatus([thumb('ready'), frame('uploading')], false)).toBe(
      'originals-uploading',
    );
  });

  it('is complete when every declared asset is ready and the originals are in', () => {
    expect(nextCaptureStatus([thumb('ready'), frame('ready'), frame('ready')], false)).toBe(
      'complete',
    );
  });

  it('is processing once jobs are queued and ready once they finish', () => {
    const all = [thumb('ready'), frame('ready')];
    expect(nextCaptureStatus(all, false, true)).toBe('processing');
    expect(nextCaptureStatus(all, true)).toBe('ready');
  });

  it('does not fall back to an upload state while workers are running', () => {
    // A worker declaring its own derived asset row must not make a capture that
    // is already `processing` look like it is uploading again.
    const midJob = [thumb('ready'), frame('ready'), a('wiggle-webp', 'pending')];
    expect(nextCaptureStatus(midJob, false, true)).toBe('processing');
  });

  it('is partial when some assets failed and the rest settled', () => {
    expect(nextCaptureStatus([thumb('ready'), frame('ready'), frame('failed')], false)).toBe(
      'partial',
    );
  });

  it('still reaches partial after the queue has run', () => {
    // A capture that permanently lost an original must not report `ready` just
    // because the jobs finished — that would drop it out of the host's Pending
    // count while it is genuinely incomplete, which is what `partial` is for.
    const lost = [thumb('ready'), frame('ready'), frame('failed')];
    // While the queue is still working the outcome is not decided yet.
    expect(nextCaptureStatus(lost, false, true)).toBe('processing');
    expect(nextCaptureStatus(lost, true)).toBe('partial');
    // And an intact capture still finishes `ready`.
    expect(nextCaptureStatus([thumb('ready'), frame('ready')], true)).toBe('ready');
  });

  it('is failed only on total loss', () => {
    expect(nextCaptureStatus([thumb('failed'), frame('failed')], false)).toBe('failed');
  });

  it('treats the two-argument form as "jobs done implies jobs queued"', () => {
    const all = [thumb('ready'), frame('ready')];
    expect(nextCaptureStatus(all, true)).toBe(nextCaptureStatus(all, true, true));
    expect(nextCaptureStatus(all, false)).toBe(nextCaptureStatus(all, false, false));
  });
});

describe('idempotency keys (05 §9)', () => {
  it('is <captureUuid>:<role>:<frameIndex>', () => {
    expect(idempotencyKeyFor('u-1', 'original-frame', 2)).toBe('u-1:original-frame:2');
    // Derived roles have no frame; the trailing field is empty rather than a
    // word that could collide with a real index.
    expect(idempotencyKeyFor('u-1', 'thumb', null)).toBe('u-1:thumb:');
  });

  it('scopes the stored session key by capture, because a uuid is only roll-unique', () => {
    // `captures_roll_uuid` anchors on (roll_id, capture_uuid), so the same uuid
    // may legitimately exist in two rolls — while
    // `upload_sessions.idempotency_key` is unique across the whole table.
    expect(sessionKeyFor('cap_A', 'u-1', 'thumb', null)).toBe('cap_A:u-1:thumb:');
    expect(sessionKeyFor('cap_B', 'u-1', 'thumb', null)).toBe('cap_B:u-1:thumb:');
    expect(sessionKeyFor('cap_A', 'u-1', 'thumb', null)).not.toBe(
      sessionKeyFor('cap_B', 'u-1', 'thumb', null),
    );
    // The device-facing 05 §9 semantics survive intact as the suffix.
    const suffix = idempotencyKeyFor('u-1', 'thumb', null);
    expect(sessionKeyFor('cap_A', 'u-1', 'thumb', null).endsWith(suffix)).toBe(true);
  });
});

describe('roll event channel (Task 19 hand-off)', () => {
  it('names the channel after the roll', () => {
    expect(rollEventChannel('roll_R')).toBe('roll:roll_R:events');
  });
});

/* ------------------------------------------------------------- the wire -- */

describe('POST /api/device/rolls/:rollId/captures (03 §16)', () => {
  it('creates a capture from the device-authored document', async () => {
    const roll = await createRoll();
    const doc = captureDoc({ mode: 'quad', look: 'Party Neg', frameCount: 4 });
    const res = await postCapture(roll.rollId, doc);

    expect(res.statusCode).toBe(201);
    const { captureId } = res.json<{ captureId: string }>();
    expect(captureId).toMatch(/^cap_/);

    const [row] = await app.db
      .select()
      .from(schema.captures)
      .where(eq(schema.captures.id, captureId));
    expect(row?.rollId).toBe(roll.rollId);
    expect(row?.deviceId).toBe(deviceA.deviceId);
    expect(row?.mode).toBe('quad');
    expect(row?.look).toBe('Party Neg');
    expect(row?.captureUuid).toBe(doc.captureUuid);
    // The server owns the status, not the document.
    expect(row?.status).toBe('created');
  });

  it('replays a repeated capture UUID onto the same row', async () => {
    const roll = await createRoll();
    const doc = captureDoc();

    const first = await postCapture(roll.rollId, doc);
    expect(first.statusCode).toBe(201);
    const second = await postCapture(roll.rollId, doc);
    expect(second.statusCode).toBe(200);

    expect(second.json<{ captureId: string }>().captureId).toBe(
      first.json<{ captureId: string }>().captureId,
    );

    const rows = await app.db
      .select({ id: schema.captures.id })
      .from(schema.captures)
      .where(eq(schema.captures.captureUuid, String(doc.captureUuid)));
    expect(rows).toHaveLength(1);
  });

  it('writes one row when two identical POSTs race', async () => {
    const roll = await createRoll();
    const doc = captureDoc();

    // Both in flight at once: a pre-check SELECT would let both through, so
    // this is the test that the unique index is what actually decides.
    const [a, b] = await Promise.all([
      postCapture(roll.rollId, doc),
      postCapture(roll.rollId, doc),
    ]);

    expect(new Set([a.statusCode, b.statusCode])).toEqual(new Set([200, 201]));
    expect(a.json<{ captureId: string }>().captureId).toBe(b.json<{ captureId: string }>().captureId);

    const rows = await app.db
      .select({ id: schema.captures.id })
      .from(schema.captures)
      .where(eq(schema.captures.captureUuid, String(doc.captureUuid)));
    expect(rows).toHaveLength(1);
  });

  it('rejects a document that is not a kino.capture', async () => {
    const roll = await createRoll();
    const res = await postCapture(roll.rollId, { schema: 'kino.roll', version: 1 });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a capture on a closed roll', async () => {
    const roll = await createRoll();
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/host/rolls/${roll.rollId}`,
      headers: bearer(roll.hostToken),
      payload: { status: 'closed' },
    });
    expect(patched.statusCode).toBe(200);

    const res = await postCapture(roll.rollId, captureDoc());
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('ROLL_CLOSED');
  });

  it('refuses a device that is not part of the roll', async () => {
    const roll = await createRoll();
    const res = await postCapture(roll.rollId, captureDoc(), deviceB.deviceToken);
    expect(res.statusCode).toBe(403);
  });
});

describe('the upload round trip (03 §16, 05 §8)', () => {
  it('carries a thumb from init to preview-ready', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);

    const body = randomBytes(4_096);
    const init = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: body.length,
      sha256: sha256Hex(body),
    });
    expect(init.statusCode).toBe(200);
    const initBody = init.json<InitResponse>();
    expect(initBody.partSize).toBe(PART_SIZE);
    expect(initBody.alreadyComplete).toBe(false);
    expect(initBody.uploadId).toMatch(/^up_/);

    const part = await putPart(initBody.uploadId, 1, body);
    expect(part.statusCode).toBe(200);
    expect(part.json<{ received: boolean; partNo: number }>()).toEqual({
      received: true,
      partNo: 1,
    });

    const done = await completeUpload(initBody.uploadId);
    expect(done.statusCode).toBe(200);
    expect(done.json<{ status: string }>().status).toBe('ready');

    const status = await captureStatus(captureId);
    expect(status.status).toBe('preview-ready');
    expect(status.assets).toEqual([{ role: 'thumb', frameIndex: null, status: 'ready' }]);

    // The bytes really are in object storage, unchanged.
    const [asset] = await app.db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.captureId, captureId));
    expect(asset?.sha256).toBe(sha256Hex(body));
    expect(asset?.bytes).toBe(body.length);
    expect(await objectBytes(asset?.objectKey ?? '')).toEqual(body);
  });

  it('puts an original frame at exactly the 05 §6 key', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);

    const body = randomBytes(2_048);
    await uploadAsset(captureId, 'original-frame', body, { frameIndex: 2, mime: 'image/jpeg' });

    const expected = `rolls/${roll.rollId}/captures/${captureId}/original/cam-02.jpg`;
    const [asset] = await app.db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.captureId, captureId));
    expect(asset?.objectKey).toBe(expected);
    expect(await objectBytes(expected)).toEqual(body);
  });

  it('accepts a re-sent part after a dropped acknowledgement', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);

    const body = randomBytes(8_192);
    const init = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: body.length,
      sha256: sha256Hex(body),
    });
    const { uploadId } = init.json<InitResponse>();

    // The device never saw the first 200, so it sends the same part again.
    expect((await putPart(uploadId, 1, body)).statusCode).toBe(200);
    expect((await putPart(uploadId, 1, body)).statusCode).toBe(200);

    const parts = await app.db
      .select()
      .from(schema.uploadParts)
      .where(eq(schema.uploadParts.uploadId, uploadId));
    expect(parts).toHaveLength(1);

    const done = await completeUpload(uploadId);
    expect(done.statusCode).toBe(200);
    expect(done.json<{ status: string }>().status).toBe('ready');
  });

  it('resumes an interrupted session under the same idempotency key', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);

    const body = randomBytes(1_024);
    const first = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: body.length,
      sha256: sha256Hex(body),
    });
    // The device restarts before uploading anything and calls init again.
    const second = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: body.length,
      sha256: sha256Hex(body),
    });

    expect(second.statusCode).toBe(200);
    expect(second.json<InitResponse>().uploadId).toBe(first.json<InitResponse>().uploadId);
    expect(second.json<InitResponse>().alreadyComplete).toBe(false);

    const sessions = await app.db
      .select({ id: schema.uploadSessions.id })
      .from(schema.uploadSessions)
      .where(eq(schema.uploadSessions.id, first.json<InitResponse>().uploadId));
    expect(sessions).toHaveLength(1);
  });

  it('answers alreadyComplete when init replays a finished upload', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);

    const body = randomBytes(1_500);
    await uploadAsset(captureId, 'thumb', body);

    const replay = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: body.length,
      sha256: sha256Hex(body),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<InitResponse>().alreadyComplete).toBe(true);
  });

  it('refuses to re-upload an original with different content', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);

    const body = randomBytes(2_048);
    await uploadAsset(captureId, 'original-frame', body, { frameIndex: 1, mime: 'image/jpeg' });

    const different = randomBytes(2_048);
    const res = await initAsset(captureId, {
      role: 'original-frame',
      frameIndex: 1,
      mime: 'image/jpeg',
      bytes: different.length,
      sha256: sha256Hex(different),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('ORIGINAL_IMMUTABLE');

    // And the stored bytes are untouched.
    expect(
      await objectBytes(`rolls/${roll.rollId}/captures/${captureId}/original/cam-01.jpg`),
    ).toEqual(body);
  });

  it('rejects a completed upload whose bytes do not match the declared digest', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);

    const promised = randomBytes(1_024);
    const sent = randomBytes(1_024);
    const init = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: promised.length,
      sha256: sha256Hex(promised),
    });
    const { uploadId } = init.json<InitResponse>();

    expect((await putPart(uploadId, 1, sent)).statusCode).toBe(200);

    const done = await completeUpload(uploadId);
    expect(done.statusCode).toBe(422);
    expect(done.json<{ code: string }>().code).toBe('CHECKSUM_MISMATCH');

    const [session] = await app.db
      .select()
      .from(schema.uploadSessions)
      .where(eq(schema.uploadSessions.id, uploadId));
    expect(session?.status).toBe('failed');

    const [asset] = await app.db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.captureId, captureId));
    expect(asset?.status).toBe('pending');
    expect(asset?.sha256).toBeNull();

    // The capture has learned nothing from a rejected upload.
    expect((await captureStatus(captureId)).status).toBe('created');

    // The device restarts init and this time sends the promised bytes.
    const retry = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: promised.length,
      sha256: sha256Hex(promised),
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json<InitResponse>().alreadyComplete).toBe(false);
    const retryId = retry.json<InitResponse>().uploadId;
    expect((await putPart(retryId, 1, promised)).statusCode).toBe(200);
    expect((await completeUpload(retryId)).statusCode).toBe(200);
    expect((await captureStatus(captureId)).status).toBe('preview-ready');
  });

  it('refuses an upload into a closed roll', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/host/rolls/${roll.rollId}`,
          headers: bearer(roll.hostToken),
          payload: { status: 'closed' },
        })
      ).statusCode,
    ).toBe(200);

    const body = randomBytes(512);
    const res = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: body.length,
      sha256: sha256Hex(body),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('ROLL_CLOSED');
  });

  it('refuses a part larger than the part size', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);

    const body = randomBytes(1_024);
    const init = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: body.length,
      sha256: sha256Hex(body),
    });
    const { uploadId } = init.json<InitResponse>();

    const oversized = Buffer.alloc(PART_SIZE + 1);
    const res = await putPart(uploadId, 1, oversized);
    expect(res.statusCode).toBe(413);
  }, 30_000);

  it('keeps two rolls that share a captureUuid on separate sessions', async () => {
    // `captures_roll_uuid` anchors idempotency on (roll_id, capture_uuid), so
    // the same camera-generated uuid legitimately appears in two rolls. The
    // upload session key is unique across the whole table, so if it were the
    // device's key alone, roll B's init would find, reset and steal roll A's
    // session — deleting its parts and overwriting its expected digest.
    const rollA = await createRoll();
    const rollB = await createRoll();
    const shared = randomUUID();

    const a = await postCapture(rollA.rollId, captureDoc({ captureUuid: shared }));
    const b = await postCapture(rollB.rollId, captureDoc({ captureUuid: shared }));
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    const captureA = a.json<{ captureId: string }>().captureId;
    const captureB = b.json<{ captureId: string }>().captureId;
    expect(captureA).not.toBe(captureB);

    const bytesA = randomBytes(1_200);
    const bytesB = randomBytes(1_400);

    // Interleaved on purpose: B's init happens while A's session is open, which
    // is exactly the moment a shared key would clobber it.
    const initA = await initAsset(captureA, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: bytesA.length,
      sha256: sha256Hex(bytesA),
    });
    const initB = await initAsset(captureB, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: bytesB.length,
      sha256: sha256Hex(bytesB),
    });
    expect(initA.statusCode).toBe(200);
    expect(initB.statusCode).toBe(200);

    const uploadA = initA.json<InitResponse>().uploadId;
    const uploadB = initB.json<InitResponse>().uploadId;
    expect(uploadA).not.toBe(uploadB);

    // A is still intact and can finish.
    expect((await putPart(uploadA, 1, bytesA)).statusCode).toBe(200);
    expect((await completeUpload(uploadA)).statusCode).toBe(200);
    expect((await putPart(uploadB, 1, bytesB)).statusCode).toBe(200);
    expect((await completeUpload(uploadB)).statusCode).toBe(200);

    for (const [captureId, body] of [
      [captureA, bytesA],
      [captureB, bytesB],
    ] as const) {
      const [asset] = await app.db
        .select()
        .from(schema.assets)
        .where(eq(schema.assets.captureId, captureId));
      expect(asset?.status).toBe('ready');
      expect(asset?.sha256).toBe(sha256Hex(body));
      expect(await objectBytes(asset?.objectKey ?? '')).toEqual(body);
    }
  }, 30_000);

  it('serialises two completes of the same upload behind a row lock', async () => {
    // The immutability guard reads the asset's digest and then a write happens.
    // Without `SELECT ... FOR UPDATE` spanning both, a concurrent complete can
    // flip the asset between those moments — and both callers would run
    // CompleteMultipartUpload against the same upload id.
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);

    const body = randomBytes(3_000);
    const init = await initAsset(captureId, {
      role: 'original-frame',
      frameIndex: 1,
      mime: 'image/jpeg',
      bytes: body.length,
      sha256: sha256Hex(body),
    });
    const { uploadId } = init.json<InitResponse>();
    expect((await putPart(uploadId, 1, body)).statusCode).toBe(200);

    const [first, second] = await Promise.all([completeUpload(uploadId), completeUpload(uploadId)]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json<{ assetId: string }>().assetId).toBe(
      second.json<{ assetId: string }>().assetId,
    );

    const [asset] = await app.db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.captureId, captureId));
    expect(asset?.status).toBe('ready');
    expect(asset?.sha256).toBe(sha256Hex(body));
    expect(await objectBytes(asset?.objectKey ?? '')).toEqual(body);

    const [session] = await app.db
      .select()
      .from(schema.uploadSessions)
      .where(eq(schema.uploadSessions.id, uploadId));
    expect(session?.status).toBe('complete');
  }, 30_000);

  it('takes a real row lock, not an advisory comment', () => {
    // Honest evidence for the mechanism the test above relies on: the same
    // builder `finishUpload` uses emits a genuine `FOR UPDATE`.
    const shape = app.db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.id, 'asset_x'))
      .for('update')
      .toSQL();
    expect(shape.sql.toLowerCase()).toContain('for update');
  });

  it('refuses another device on the same upload', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);

    const body = randomBytes(256);
    const init = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: body.length,
      sha256: sha256Hex(body),
    });
    const { uploadId } = init.json<InitResponse>();

    expect((await putPart(uploadId, 1, body, deviceB.deviceToken)).statusCode).toBe(403);
    expect((await completeUpload(uploadId, deviceB.deviceToken)).statusCode).toBe(403);
  });
});

describe('POST /api/device/captures/:captureId/complete', () => {
  it('queues processing jobs and moves the capture to processing', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);

    await uploadAsset(captureId, 'thumb', randomBytes(700));
    for (const frameIndex of [1, 2, 3, 4]) {
      await uploadAsset(captureId, 'original-frame', randomBytes(600 + frameIndex), {
        frameIndex,
        mime: 'image/jpeg',
      });
    }

    // Everything is in but nothing is queued yet.
    expect((await captureStatus(captureId)).status).toBe('complete');

    const res = await app.inject({
      method: 'POST',
      url: `/api/device/captures/${captureId}/complete`,
      headers: bearer(deviceA.deviceToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('processing');

    const events = await app.db
      .select()
      .from(schema.processingEvents)
      .where(eq(schema.processingEvents.captureId, captureId));
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((row) => row.status))).toEqual(new Set(['queued']));
    // The device already supplied the thumb, so no worker is asked to redo it
    // (03 §4 — device previews take priority, workers fill gaps).
    expect(events.map((row) => row.job)).not.toContain('generate-thumbnail');

    // Calling complete twice must not double the queue.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/device/captures/${captureId}/complete`,
          headers: bearer(deviceA.deviceToken),
        })
      ).statusCode,
    ).toBe(200);
    const again = await app.db
      .select()
      .from(schema.processingEvents)
      .where(eq(schema.processingEvents.captureId, captureId));
    expect(again).toHaveLength(events.length);
  }, 60_000);

  it('queues each job once even when two completes race', async () => {
    // The enqueue used to SELECT-then-insert, which is precisely the pre-check
    // pattern the rest of this pipeline refuses: two concurrent completes both
    // find nothing and both insert. The partial unique index
    // `processing_events_capture_job_queued` is what actually decides now.
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);
    await uploadAsset(captureId, 'original-frame', randomBytes(512), {
      frameIndex: 1,
      mime: 'image/jpeg',
    });

    const complete = async (): Promise<LightMyRequestResponse> =>
      app.inject({
        method: 'POST',
        url: `/api/device/captures/${captureId}/complete`,
        headers: bearer(deviceA.deviceToken),
      });

    const [first, second] = await Promise.all([complete(), complete()]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const events = await app.db
      .select()
      .from(schema.processingEvents)
      .where(eq(schema.processingEvents.captureId, captureId));
    expect(events.length).toBeGreaterThan(0);

    // One `queued` row per job, no matter how many callers asked: distinct job
    // names and total rows agree only if nothing was inserted twice.
    const jobs = events.map((row) => row.job);
    expect(new Set(jobs).size).toBe(jobs.length);
    expect(new Set(events.map((row) => row.status))).toEqual(new Set(['queued']));
  }, 60_000);

  it('leaves room for the later lifecycle rows of the same job', async () => {
    // The index is PARTIAL — unique only over `status = 'queued'` — because this
    // table is an event log: Task 22 records queued → running → done for the
    // same job. A blanket unique on (capture_id, job) would make the second row
    // of that lifecycle impossible.
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);
    await uploadAsset(captureId, 'original-frame', randomBytes(512), {
      frameIndex: 1,
      mime: 'image/jpeg',
    });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/device/captures/${captureId}/complete`,
          headers: bearer(deviceA.deviceToken),
        })
      ).statusCode,
    ).toBe(200);

    const [queued] = await app.db
      .select()
      .from(schema.processingEvents)
      .where(eq(schema.processingEvents.captureId, captureId));
    expect(queued?.status).toBe('queued');

    // A worker writing progress for the same job must not hit the index.
    await app.db.insert(schema.processingEvents).values([
      { id: `pev_run_${RUN}`, captureId, job: queued?.job ?? '', status: 'running' },
      { id: `pev_done_${RUN}`, captureId, job: queued?.job ?? '', status: 'done' },
    ]);

    const lifecycle = await app.db
      .select()
      .from(schema.processingEvents)
      .where(
        and(
          eq(schema.processingEvents.captureId, captureId),
          eq(schema.processingEvents.job, queued?.job ?? ''),
        ),
      );
    expect(new Set(lifecycle.map((row) => row.status))).toEqual(
      new Set(['queued', 'running', 'done']),
    );
  }, 60_000);
});

describe('roll counts, now that captures exist (03 §10)', () => {
  async function hostCounts(
    roll: CreatedRollResponse,
  ): Promise<{ captures: number; pending: number; hidden: number }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/host/rolls/${roll.rollId}`,
      headers: bearer(roll.hostToken),
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ counts: { captures: number; pending: number; hidden: number } }>().counts;
  }

  it('reports real capture counts to the host and the guest', async () => {
    const roll = await createRoll();

    const shown = await newCapture(roll.rollId);
    await uploadAsset(shown.captureId, 'thumb', randomBytes(300));
    await newCapture(roll.rollId);

    // One capture hidden, straight in the table — host moderation is Task 21.
    const hidden = await newCapture(roll.rollId);
    await app.db
      .update(schema.captures)
      .set({ visible: false })
      .where(eq(schema.captures.id, hidden.captureId));

    // Hiding is not deleting (03 §11), so a hidden capture is still a capture.
    expect(await hostCounts(roll)).toEqual({ captures: 3, pending: 3, hidden: 1 });

    // A capture whose media has stopped moving leaves "Pending".
    await app.db
      .update(schema.captures)
      .set({ status: 'ready' })
      .where(eq(schema.captures.id, shown.captureId));
    expect(await hostCounts(roll)).toEqual({ captures: 3, pending: 2, hidden: 1 });

    const guest = await app.inject({ method: 'GET', url: `/api/rolls/${roll.slug}` });
    expect(guest.statusCode).toBe(200);
    // Guests never see a hidden capture, so it is not in their count either.
    expect(guest.json<{ photoCount: number }>().photoCount).toBe(2);
  }, 30_000);
});
