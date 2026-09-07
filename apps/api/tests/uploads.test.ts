import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildServer } from '../src/server';
import { hashToken } from '../src/auth/tokens';
import { RATE_LIMITS, UNTRUSTED_DEVICE_UPLOAD_MAX } from '../src/plugins/rateLimits';
import { loadConfig, type ApiConfig } from '../src/config';
import {
  assertNotOriginalOverwrite,
  derivedKey,
  originalKey,
  rollDerivedKey,
} from '../src/uploads/objectKeys';
import {
  JOB_NAMES,
  MAX_ASSET_BYTES,
  PART_SIZE,
  idempotencyKeyFor,
  jobKeyFor,
  nextCaptureStatus,
  recomputeCaptureStatus,
  sessionKeyFor,
  type AssetState,
} from '../src/uploads/uploads';
import { createProcessingQueue, jobKeyToJobId } from '../src/queue/producer';
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
/**
 * Two more cameras, each with a rate-limit budget nothing else in this file
 * spends. The upload counters are keyed by token hash, so a device of its own is
 * what makes "no 429 at three-second pacing" a measurement of the limit rather
 * than of whatever the tests above happened to use up first.
 */
const SERIAL_PACE = `KD4-T18-${RUN}-PACE`;
const SERIAL_RETRY = `KD4-T18-${RUN}-RETRY`;
const SERIALS = [SERIAL_A, SERIAL_B, SERIAL_PACE, SERIAL_RETRY];

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
    // The provisioning secret this endpoint is gated on. Read off the server's
    // own config rather than hard-coded, so a bench with a real one in
    // `infra/.env` runs the suite unchanged.
    headers: { authorization: `Bearer ${app.config.PROVISIONING_TOKEN}` },
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

      // Capture-complete queues real BullMQ jobs and no worker runs here, so
      // they would sit in the dev Redis for captures that no longer exist.
      // Removed by id rather than by obliterating the queue: `kino-jobs` is the
      // real prefix, and a test suite must not be able to delete work it did
      // not create.
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

  it('is partial when a job was permanently lost, even with every asset intact', () => {
    // A derivative that never rendered leaves no failed asset row — it leaves no
    // row at all — so without `jobsLost` this reads as a finished capture. It is
    // not one: the platform owes it a thumbnail nobody is going to produce.
    const intact = [thumb('ready'), frame('ready')];
    expect(nextCaptureStatus(intact, true, true, true)).toBe('partial');
    // And a capture that lost nothing still finishes `ready`.
    expect(nextCaptureStatus(intact, true, true, false)).toBe('ready');
  });

  it('is still processing while a lost job has siblings that have not finished', () => {
    // One job abandoned does not settle the capture: the others may yet produce
    // what they were queued for.
    const intact = [thumb('ready'), frame('ready')];
    expect(nextCaptureStatus(intact, false, true, true)).toBe('processing');
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

  it('lands the passthrough remainder in provenance instead of dropping it (audit #59)', async () => {
    const roll = await createRoll();
    const doc = captureDoc({
      meta: {
        flash: true,
        batteryV: 3.91,
        p4Firmware: '0.9.9',
        exposure: [{ cam: 'cam1', shutterUs: 16667, gain: 4 }],
        calibrationVersion: 3,
      },
    });
    const res = await postCapture(roll.rollId, doc);
    expect(res.statusCode).toBe(201);
    const captureId = res.json<{ captureId: string }>().captureId;

    const [row] = await app.db.select().from(schema.captures).where(eq(schema.captures.id, captureId));
    const provenance = row?.provenance as Record<string, unknown>;
    // Device identity as it was at the shutter press…
    expect(provenance.device).toMatchObject({ serial: SERIAL_A, hardware: 'v1' });
    // …and everything the firmware sent beyond the typed surface.
    expect(provenance.meta).toMatchObject({ flash: true, p4Firmware: '0.9.9', calibrationVersion: 3 });
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

  /**
   * The size limits (audit API-6). `bytes_expected` was recorded at init and
   * then compared to nothing: a session could accept parts up to
   * `MAX_PART_NUMBER` — tens of gigabytes — for an asset that declared two
   * kilobytes, and `complete` accepted whatever length had landed as long as the
   * digest matched what was declared.
   *
   * Three checks, and the three are tested here because each covers a different
   * lie: the declaration itself, the bytes as they arrive, and the object as it
   * ends up stored.
   */
  it('refuses a declaration larger than the platform accepts', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);

    const res = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: MAX_ASSET_BYTES + 1,
      sha256: sha256Hex(Buffer.from('never sent')),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string; message: string }>()).toMatchObject({ code: 'INVALID_BODY' });
    // Names the field, not the value.
    expect(res.json<{ message: string }>().message).toContain('bytes');
  });

  it('refuses a part that would carry the upload past what init declared', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);

    const promised = randomBytes(1_024);
    const init = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: promised.length,
      sha256: sha256Hex(promised),
    });
    const { uploadId } = init.json<InitResponse>();

    // The declared bytes fit exactly, so the first part is fine.
    expect((await putPart(uploadId, 1, promised)).statusCode).toBe(200);

    // A second part has nowhere to go: the declaration is already spent.
    const overflow = await putPart(uploadId, 2, randomBytes(1_024));
    expect(overflow.statusCode).toBe(413);
    expect(overflow.json<{ code: string }>().code).toBe('UPLOAD_TOO_LARGE');

    // And nothing was written for it: a refused part leaves no bookkeeping row,
    // so the upload is still exactly the one part it was.
    const parts = await app.db
      .select({ partNo: schema.uploadParts.partNo })
      .from(schema.uploadParts)
      .where(eq(schema.uploadParts.uploadId, uploadId));
    expect(parts.map((part) => part.partNo)).toEqual([1]);

    // The honest upload still completes, so this refuses bytes rather than
    // breaking the session.
    expect((await completeUpload(uploadId)).statusCode).toBe(200);
  });

  /**
   * Re-sending a part **replaces** it, so the running total must not count the
   * row it is about to overwrite — otherwise the ordinary retry of a part whose
   * acknowledgement was lost would be refused as too large, which is the one
   * case this whole pipeline exists to survive.
   */
  it('lets a resent part replace its own bytes rather than adding to them', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);

    const body = randomBytes(2_000);
    const init = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: body.length,
      sha256: sha256Hex(body),
    });
    const { uploadId } = init.json<InitResponse>();

    expect((await putPart(uploadId, 1, body)).statusCode).toBe(200);
    expect((await putPart(uploadId, 1, body)).statusCode).toBe(200);
    expect((await putPart(uploadId, 1, body)).statusCode).toBe(200);
    expect((await completeUpload(uploadId)).statusCode).toBe(200);
  });

  it('fails complete when the stored object is not the length that was declared', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);

    // A device that under-declares and then sends more. The digest it declares
    // is the digest of what it actually sends, so the checksum check passes and
    // only the length is wrong — which is the case the size check exists for.
    const sent = randomBytes(4_096);
    const init = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: sent.length,
      sha256: sha256Hex(sent),
    });
    const { uploadId } = init.json<InitResponse>();

    // The part gate refuses the oversized body outright, so the mismatch has to
    // be produced the only other way it can happen: parts that fit, and a
    // session whose declaration is then lowered under it. Writing the row
    // directly is the honest way to reach a state a well-behaved device cannot.
    expect((await putPart(uploadId, 1, sent)).statusCode).toBe(200);
    await app.db
      .update(schema.uploadSessions)
      .set({ bytesExpected: 1_024 })
      .where(eq(schema.uploadSessions.id, uploadId));

    const done = await completeUpload(uploadId);
    expect(done.statusCode).toBe(422);
    expect(done.json<{ code: string }>().code).toBe('SIZE_MISMATCH');

    // Same disposal as a checksum failure: the session failed, the asset is
    // still pending, and the bytes are gone from storage.
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
    // The device supplied its 288 px THUMB.JPG, and the worker is STILL asked
    // for a thumb: the device's is the instant placeholder, the worker's 720 px
    // WebP replaces it on the same row (see `plannedJobs`). The device's
    // kino-still, when it sends one, is not redone.
    expect(events.map((row) => row.job)).toContain('generate-thumbnail');

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

/**
 * Board issue #8: a job that runs out of attempts used to strand its capture.
 *
 * The worker's terminal-failure write is replayed here rather than driven through
 * a real worker — that end of the contract is tested in
 * `apps/worker/tests/imageJobs.test.ts`, and what this suite owns is the
 * *reader*: given the rows a worker leaves behind, does the capture reach an
 * answer it can stay on?
 */
describe('a permanently failed job settles the capture (#8)', () => {
  async function complete(captureId: string): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/device/captures/${captureId}/complete`,
      headers: bearer(deviceA.deviceToken),
    });
    expect(res.statusCode).toBe(200);
  }

  /** Exactly what `markJobAbandoned` writes: append the verdict, retire the lock. */
  async function abandon(captureId: string, job: string, tag: string): Promise<void> {
    await app.db.insert(schema.processingEvents).values([
      { id: `pev_run_${tag}`, captureId, job, status: 'running' },
      { id: `pev_fail_${tag}`, captureId, job, status: 'failed', error: 'attempt 5/5: boom' },
      { id: `pev_gone_${tag}`, captureId, job, status: 'abandoned', error: 'abandoned after 5/5' },
    ]);
    await app.db
      .update(schema.processingEvents)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(schema.processingEvents.captureId, captureId),
          eq(schema.processingEvents.job, job),
          eq(schema.processingEvents.status, 'queued'),
        ),
      );
  }

  async function queuedJobs(captureId: string): Promise<string[]> {
    const rows = await app.db
      .select({ job: schema.processingEvents.job })
      .from(schema.processingEvents)
      .where(
        and(
          eq(schema.processingEvents.captureId, captureId),
          eq(schema.processingEvents.status, 'queued'),
        ),
      );
    return rows.map((row) => row.job).sort();
  }

  it('lands on partial instead of sitting in processing forever', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);
    await uploadAsset(captureId, 'thumb', randomBytes(700));
    await uploadAsset(captureId, 'original-frame', randomBytes(600), {
      frameIndex: 1,
      mime: 'image/jpeg',
    });

    await complete(captureId);
    expect((await captureStatus(captureId)).status).toBe('processing');

    const jobs = await queuedJobs(captureId);
    expect(jobs.length).toBeGreaterThan(1);

    // The first job dies for good; the rest succeed. While any of them is still
    // outstanding the honest answer is `processing`.
    const [dead, ...rest] = jobs;
    await abandon(captureId, dead ?? '', `${RUN}_dead`);
    expect(await recomputeCaptureStatus(app.db, captureId)).toBe('processing');

    for (const [index, job] of rest.entries()) {
      await app.db.insert(schema.processingEvents).values([
        { id: `pev_ok_run_${RUN}_${index}`, captureId, job, status: 'running' },
        { id: `pev_ok_done_${RUN}_${index}`, captureId, job, status: 'done' },
      ]);
    }

    // Every job has now finished one way or the other. The capture is not
    // `ready` — it is missing a derivative nobody will ever produce — and it is
    // not `processing` either, because nothing is going to change.
    expect(await recomputeCaptureStatus(app.db, captureId)).toBe('partial');
    expect((await captureStatus(captureId)).status).toBe('partial');

    // And `partial` is settled, so the host's Pending count has let it go.
    expect(await recomputeCaptureStatus(app.db, captureId)).toBe('partial');
  }, 60_000);

  it('frees the enqueue block so a later complete can re-queue the work', async () => {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);
    await uploadAsset(captureId, 'original-frame', randomBytes(512), {
      frameIndex: 1,
      mime: 'image/jpeg',
    });

    await complete(captureId);
    const [dead] = await queuedJobs(captureId);
    await abandon(captureId, dead ?? '', `${RUN}_requeue`);

    // The partial unique index covers `status = 'queued'` only, so retiring that
    // row to `superseded` is what lets the insert through the second time.
    expect(await queuedJobs(captureId)).not.toContain(dead);
    await complete(captureId);
    expect(await queuedJobs(captureId)).toContain(dead);

    // The log is intact: every row a worker wrote is still there, the retired
    // enqueue included.
    const statuses = await app.db
      .select({ status: schema.processingEvents.status })
      .from(schema.processingEvents)
      .where(
        and(
          eq(schema.processingEvents.captureId, captureId),
          eq(schema.processingEvents.job, dead ?? ''),
        ),
      );
    expect(statuses.map((row) => row.status).sort()).toEqual([
      'abandoned',
      'failed',
      'queued',
      'running',
      'superseded',
    ]);
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

/**
 * `processing_events` is an append-only log (Task 22): a worker adds a
 * `running`/`done`/`failed` row, it never updates the `queued` one — that row
 * has to survive, because the partial unique index over it is what makes a
 * re-queue a no-op.
 *
 * So "are the jobs finished?" cannot be `every(row.status === 'done')`: the
 * queued row is still sitting there and would make that answer `false` forever.
 * The question is only ever about each job's LATEST row.
 */
describe('capture status reads the latest processing event per job (Task 22)', () => {
  const eventId = (): string => `pev_t22_${randomBytes(8).toString('hex')}`;

  async function completeCapture(captureId: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/device/captures/${captureId}/complete`,
      headers: bearer(deviceA.deviceToken),
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ status: string }>().status;
  }

  /** A capture with one original on the server and its jobs queued. */
  async function queuedCapture(): Promise<{ captureId: string; jobs: string[] }> {
    const roll = await createRoll();
    const { captureId } = await newCapture(roll.rollId);
    await uploadAsset(captureId, 'original-frame', randomBytes(512), {
      frameIndex: 1,
      mime: 'image/jpeg',
    });
    expect(await completeCapture(captureId)).toBe('processing');

    const queued = await app.db
      .select({ job: schema.processingEvents.job })
      .from(schema.processingEvents)
      .where(eq(schema.processingEvents.captureId, captureId));
    expect(queued.length).toBeGreaterThan(1);
    return { captureId, jobs: queued.map((row) => row.job) };
  }

  it('hands every newly queued job to BullMQ under its jobKey', async () => {
    const { captureId, jobs } = await queuedCapture();

    // The rows say what was queued; this says the queue was actually told. The
    // two are separate steps and only one of them was here before Task 22.
    const queue = createProcessingQueue(config);
    try {
      for (const job of jobs) {
        const jobKey = jobKeyFor(captureId, job as (typeof JOB_NAMES)[number]);
        const submitted = await queue.getJob(jobKeyToJobId(jobKey));
        expect(submitted?.name).toBe(job);
        expect(submitted?.data.captureId).toBe(captureId);
        expect(submitted?.data.jobKey).toBe(jobKey);
        expect(submitted?.opts.attempts).toBe(5);
      }
    } finally {
      await queue.close();
    }
  }, 60_000);

  it('is ready once every job’s latest row is done, queued and failed rows included', async () => {
    const { captureId, jobs } = await queuedCapture();

    // Explicit, ascending timestamps: the read is "latest per job", so the
    // fixture has to say which row is latest rather than hope two inserts land
    // in different microseconds.
    const base = Date.now();
    const rows: (typeof schema.processingEvents.$inferInsert)[] = [];
    jobs.forEach((job, index) => {
      const at = (step: number): Date => new Date(base + index * 10 + step);
      // The first job needed a retry. Its failed row stays in the log, and the
      // capture is still finished — what decides is the LAST row, not any row.
      if (index === 0) {
        rows.push({ id: eventId(), captureId, job, status: 'running', at: at(1) });
        rows.push({ id: eventId(), captureId, job, status: 'failed', at: at(2), error: 'once' });
      }
      rows.push({ id: eventId(), captureId, job, status: 'running', at: at(3) });
      rows.push({ id: eventId(), captureId, job, status: 'done', at: at(4) });
    });
    await app.db.insert(schema.processingEvents).values(rows);

    // Complete is idempotent and re-queues nothing (the queued rows are still
    // there), so it is just a recompute here.
    expect(await completeCapture(captureId)).toBe('ready');
  }, 60_000);

  it('stays processing while one job has only reached running', async () => {
    const { captureId, jobs } = await queuedCapture();

    const base = Date.now();
    const rows: (typeof schema.processingEvents.$inferInsert)[] = [];
    jobs.forEach((job, index) => {
      const at = (step: number): Date => new Date(base + index * 10 + step);
      rows.push({ id: eventId(), captureId, job, status: 'running', at: at(1) });
      // Every job but the last one finished; the queue is still working.
      if (index < jobs.length - 1) {
        rows.push({ id: eventId(), captureId, job, status: 'done', at: at(2) });
      }
    });
    await app.db.insert(schema.processingEvents).values(rows);

    expect(await completeCapture(captureId)).toBe('processing');
  }, 60_000);

  it('stays processing while a job’s latest row is a failure', async () => {
    const { captureId, jobs } = await queuedCapture();

    const base = Date.now();
    const rows: (typeof schema.processingEvents.$inferInsert)[] = [];
    jobs.forEach((job, index) => {
      const at = (step: number): Date => new Date(base + index * 10 + step);
      rows.push({ id: eventId(), captureId, job, status: 'running', at: at(1) });
      rows.push(
        index === 0
          ? { id: eventId(), captureId, job, status: 'failed', at: at(2), error: 'boom' }
          : { id: eventId(), captureId, job, status: 'done', at: at(2) },
      );
    });
    await app.db.insert(schema.processingEvents).values(rows);

    // A job that ended in failure has not produced its asset, so the capture is
    // not `ready`. It is not `partial` either — that is decided by the asset
    // rows, and this one's original is on the server.
    expect(await completeCapture(captureId)).toBe('processing');
  }, 60_000);
});

/* ---------------------------------------------------- the upload budget -- */

/**
 * The rate limit as the camera meets it.
 *
 * `deviceUpload` was 60 a minute per route, and the counter is per method and
 * route pattern, so the binding routes are the three the camera calls once per
 * asset. One grouped four-camera capture is five assets — a thumb and four
 * frames (`firmware/p4/main/roll_api.c`) — one part each, so those routes see
 * five requests per capture and the sustained ceiling was 60/5 = 12 captures a
 * minute, one every 5.0 s. The camera shoots about 20 a minute.
 *
 * These two tests are the two halves of that: that a real pace no longer 429s,
 * and that a 429 costs nothing permanent when one does happen.
 */
describe('the device upload budget at camera pace', () => {
  /** Bench-measured D4 sizes: a 7.6 kB thumb and 92-159 kB frames. */
  const THUMB_BYTES = 7_600;
  const FRAME_BYTES = [123_590, 91_731, 106_136, 158_701] as const;

  /** Every response this suite drove, so a single 429 anywhere fails the test. */
  interface Attempt {
    what: string;
    status: number;
  }

  async function registerAndOpen(
    serial: string,
  ): Promise<{ token: string; deviceId: string; rollId: string }> {
    const credential = await register(serial);
    const created = await app.inject({
      method: 'POST',
      url: '/api/device/rolls',
      headers: bearer(credential.deviceToken),
      payload: { title: `Upload budget ${serial}` },
    });
    expect(created.statusCode).toBe(201);
    const roll = created.json<CreatedRollResponse>();
    createdRollIds.push(roll.rollId);
    return { token: credential.deviceToken, deviceId: credential.deviceId, rollId: roll.rollId };
  }

  /**
   * One whole grouped capture over the wire, as the camera sends it: create,
   * thumb, four frames, capture complete. Seventeen requests, and every status
   * is recorded rather than asserted, so the caller can say what the *pace*
   * produced instead of failing on the first surprise.
   */
  async function shootOneCapture(
    rollId: string,
    token: string,
    deviceId: string,
    sequence: number,
    log: Attempt[],
  ): Promise<string> {
    const doc = captureDoc({
      deviceId,
      capturedAt: new Date(Date.now() + sequence).toISOString(),
    });
    const created = await postCapture(rollId, doc, token);
    log.push({ what: 'capture create', status: created.statusCode });
    const { captureId } = created.json<{ captureId: string }>();

    const assets: { role: string; frameIndex?: number; mime: string; body: Buffer }[] = [
      { role: 'thumb', mime: 'image/jpeg', body: randomBytes(THUMB_BYTES) },
      ...FRAME_BYTES.map((bytes, index) => ({
        role: 'original-frame',
        frameIndex: index + 1,
        mime: 'image/jpeg',
        body: randomBytes(bytes),
      })),
    ];

    for (const asset of assets) {
      const init = await initAsset(
        captureId,
        {
          role: asset.role,
          ...(asset.frameIndex === undefined ? {} : { frameIndex: asset.frameIndex }),
          mime: asset.mime,
          bytes: asset.body.length,
          sha256: sha256Hex(asset.body),
        },
        token,
      );
      log.push({ what: `${asset.role} init`, status: init.statusCode });
      const { uploadId } = init.json<InitResponse>();

      // One part each, and that is the point: `PART_SIZE` is 5 MiB against a
      // 159 kB frame, so a real capture is five part PUTs and never more.
      expect(asset.body.length).toBeLessThanOrEqual(PART_SIZE);
      const part = await putPart(uploadId, 1, asset.body, token);
      log.push({ what: `${asset.role} part 1`, status: part.statusCode });

      const done = await completeUpload(uploadId, token);
      log.push({ what: `${asset.role} complete`, status: done.statusCode });
    }

    const finished = await app.inject({
      method: 'POST',
      url: `/api/device/captures/${captureId}/complete`,
      headers: bearer(token),
    });
    log.push({ what: 'capture complete', status: finished.statusCode });
    return captureId;
  }

  /**
   * Sixteen captures at three-second pacing, which is the run that used to fail.
   *
   * Sixteen is chosen against the old ceiling and not for roundness: it puts 80
   * requests on each of the three per-asset routes inside one 60 s window, so at
   * 60 the sixteenth capture could not have finished — the reported failure
   * started at capture 16 of 22 — while at 120 there is room for 24. Pacing is
   * against a fixed start time rather than a sleep between captures, so upload
   * work cannot quietly stretch the interval out of the window.
   */
  it('takes a capture every three seconds with no 429 at all', async () => {
    const camera = await registerAndOpen(SERIAL_PACE);
    const log: Attempt[] = [];
    const captureIds: string[] = [];
    const captures = 16;
    const intervalMs = 3_000;
    const startedAt = Date.now();

    for (let sequence = 0; sequence < captures; sequence += 1) {
      const due = startedAt + sequence * intervalMs;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      captureIds.push(
        await shootOneCapture(camera.rollId, camera.token, camera.deviceId, sequence, log),
      );
    }

    expect(log.length / captures).toBe(17);

    const refused = log.filter((attempt) => attempt.status === 429);
    expect(refused, `429 on ${refused.map((entry) => entry.what).join(', ')}`).toHaveLength(0);
    // Nothing else went wrong either: 201 for a created capture, 200 for the
    // rest. A 500 that never 429s would pass a 429 count on its own.
    expect(log.filter((attempt) => attempt.status >= 300)).toHaveLength(0);

    // Eighty requests on each per-asset route inside the window: over the old
    // 60, under the new 120.
    expect(captures * 5).toBeGreaterThan(UNTRUSTED_DEVICE_UPLOAD_MAX);
    expect(captures * 5).toBeLessThanOrEqual(RATE_LIMITS.deviceUpload.max);

    expect(new Set(captureIds).size).toBe(captures);
    const rows = await app.db
      .select({ id: schema.captures.id })
      .from(schema.captures)
      .where(eq(schema.captures.rollId, camera.rollId));
    expect(rows).toHaveLength(captures);
  }, 300_000);

  /**
   * What a 429 costs. The firmware treats it as transient and retries the same
   * capture and the same asset after a backoff, so the property that matters is
   * that the retry converges on the row that already exists instead of making a
   * second one.
   *
   * The budget is spent here on requests refused for another reason entirely — a
   * roll id and a capture id that belong to nothing — because the limiter runs on
   * `onRequest`, before authorisation and before the body is parsed. That is what
   * lets the test drive a real 429 on the real routes without first creating 120
   * captures.
   */
  it('does not duplicate a capture or an upload when a 429 is retried', async () => {
    const camera = await registerAndOpen(SERIAL_RETRY);
    const tokenHash = hashToken(camera.token);

    /** The counter key for one route, addressed exactly and never by wildcard. */
    const windowKey = (method: string, route: string): string =>
      `${app.rateLimitNameSpace}${method}${route}-token:${tokenHash}${RATE_LIMITS.deviceUpload.groupId}`;

    const spend = async (options: InjectOptions, refusedWith: number): Promise<void> => {
      for (let attempt = 0; attempt < RATE_LIMITS.deviceUpload.max; attempt += 1) {
        const response = await app.inject(options);
        expect(response.statusCode).toBe(refusedWith);
      }
    };

    /* ---- the capture row -------------------------------------------------- */

    const createRoute = '/api/device/rolls/:rollId/captures';
    await spend(
      {
        method: 'POST',
        url: '/api/device/rolls/roll_does_not_exist/captures',
        headers: bearer(camera.token),
        payload: {},
      },
      404,
    );

    // The budget is keyed on the credential, not the address: the counter this
    // spending landed in is named by the token hash and carries no address.
    expect(await app.redis.get(windowKey('POST', createRoute))).toBe(
      String(RATE_LIMITS.deviceUpload.max),
    );

    const doc = captureDoc({ deviceId: camera.deviceId });
    const throttled = await postCapture(camera.rollId, doc, camera.token);
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers['retry-after']).toBeDefined();

    // The backoff, without waiting a minute for it: the window is deleted, which
    // is what its own expiry would have done.
    await app.redis.del(windowKey('POST', createRoute));

    const retried = await postCapture(camera.rollId, doc, camera.token);
    expect(retried.statusCode).toBe(201);
    const { captureId } = retried.json<{ captureId: string }>();

    // And the retry of the retry, because a camera that lost the 201 sends it
    // again: 200 and the same id, never a second row.
    const again = await postCapture(camera.rollId, doc, camera.token);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ captureId: string }>().captureId).toBe(captureId);

    const captureRows = await app.db
      .select({ id: schema.captures.id })
      .from(schema.captures)
      .where(
        and(
          eq(schema.captures.rollId, camera.rollId),
          eq(schema.captures.captureUuid, doc['captureUuid'] as string),
        ),
      );
    expect(captureRows).toHaveLength(1);

    /* ---- the asset and its upload session --------------------------------- */

    const initRoute = '/api/device/captures/:captureId/assets/init';
    await spend(
      {
        method: 'POST',
        url: '/api/device/captures/cap_does_not_exist/assets/init',
        headers: bearer(camera.token),
        payload: {},
      },
      404,
    );

    const body = randomBytes(FRAME_BYTES[0]);
    const initPayload = {
      role: 'original-frame',
      frameIndex: 1,
      mime: 'image/jpeg',
      bytes: body.length,
      sha256: sha256Hex(body),
    };

    const initThrottled = await initAsset(captureId, initPayload, camera.token);
    expect(initThrottled.statusCode).toBe(429);

    await app.redis.del(windowKey('POST', initRoute));

    const init = await initAsset(captureId, initPayload, camera.token);
    expect(init.statusCode).toBe(200);
    const opened = init.json<InitResponse>();
    expect(opened.alreadyComplete).toBe(false);

    // A second init after the 429 — the camera does not know which of its calls
    // arrived — resumes the same session rather than opening a second one.
    const resumed = await initAsset(captureId, initPayload, camera.token);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json<InitResponse>().uploadId).toBe(opened.uploadId);

    expect((await putPart(opened.uploadId, 1, body, camera.token)).statusCode).toBe(200);
    const finished = await completeUpload(opened.uploadId, camera.token);
    expect(finished.statusCode).toBe(200);
    const { assetId } = finished.json<{ assetId: string }>();

    // Once complete, the init the firmware re-sends after a 429 is answered
    // `alreadyComplete` against the same upload id, and a repeated complete is
    // still a 200.
    const replay = await initAsset(captureId, initPayload, camera.token);
    expect(replay.statusCode).toBe(200);
    expect(replay.json<InitResponse>()).toMatchObject({
      uploadId: opened.uploadId,
      alreadyComplete: true,
    });
    expect((await completeUpload(opened.uploadId, camera.token)).statusCode).toBe(200);

    const assetRows = await app.db
      .select({ id: schema.assets.id, objectKey: schema.assets.objectKey })
      .from(schema.assets)
      .where(eq(schema.assets.captureId, captureId));
    expect(assetRows).toHaveLength(1);
    expect(assetRows[0]?.id).toBe(assetId);

    const sessionRows = await app.db
      .select({ id: schema.uploadSessions.id })
      .from(schema.uploadSessions)
      .where(eq(schema.uploadSessions.assetId, assetId));
    expect(sessionRows).toHaveLength(1);

    // One object, and it is the bytes that were sent — not a part that landed
    // twice.
    const stored = await objectBytes(assetRows[0]?.objectKey ?? '');
    expect(stored.length).toBe(body.length);
    expect(sha256Hex(stored)).toBe(initPayload.sha256);
  }, 300_000);
});
