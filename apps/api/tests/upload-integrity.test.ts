import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { AbortMultipartUploadCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildServer } from '../src/server';
import { loadConfig } from '../src/config';
import { contradictsDeclaredMime, sniffContentType } from '../src/uploads/uploads';
import { rollStreamKey } from '../src/events/publish';
import * as schema from '../src/db/schema';

/**
 * Two things the upload pipeline did not check, against the real database and
 * real MinIO — same house rules as `uploads.test.ts`:
 *
 *   docker compose -f infra/docker-compose.dev.yml up -d
 *   npm run db:migrate -w @kino/api
 *
 * 1. The declared `mime` was never compared to the bytes that arrived, so a
 *    device token could store a JPEG — or an HTML document — as `image/webp`
 *    and the API would serve it inline from the cookie origin.
 * 2. A multipart upload swept by MinIO's 24-hour stale-upload policy left the
 *    session row saying `open`, and every later call answered `NoSuchUpload`.
 *    That surfaced as a 500, which the device contract classifies as transient,
 *    so a camera repeated the same dead upload id forever.
 */
const RUN = randomBytes(4).toString('hex');
const app: FastifyInstance = buildServer(loadConfig());

const SERIAL = `KD4-INTEG-${RUN}`;
const createdRollIds: string[] = [];
let device: { deviceId: string; deviceToken: string };

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const sha256Hex = (body: Buffer): string => createHash('sha256').update(body).digest('hex');

/**
 * Bytes that announce themselves as a given type. Only the signature is real —
 * the rest is noise, because nothing in this suite decodes an image; the sniff
 * is a prefix test and the digest does not care what follows.
 */
function bytesOf(kind: 'jpeg' | 'webp' | 'html', size = 512): Buffer {
  const noise = randomBytes(size);
  if (kind === 'jpeg') return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), noise]);
  if (kind === 'html') return Buffer.concat([Buffer.from('<!DOCTYPE html><script>'), noise]);
  const body = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WEBPVP8 '),
    noise,
  ]);
  body.writeUInt32LE(body.length - 8, 4);
  return body;
}

interface InitResponse {
  uploadId: string;
  partSize: number;
  alreadyComplete: boolean;
}

async function initAsset(
  captureId: string,
  body: { role: string; frameIndex?: number; mime: string; bytes: number; sha256: string },
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/device/captures/${captureId}/assets/init`,
    headers: bearer(device.deviceToken),
    payload: body,
  });
}

async function putPart(uploadId: string, body: Buffer): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'PUT',
    url: `/api/device/uploads/${uploadId}/parts/1`,
    headers: { ...bearer(device.deviceToken), 'content-type': 'application/octet-stream' },
    payload: body,
  });
}

async function completeUpload(uploadId: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/device/uploads/${uploadId}/complete`,
    headers: bearer(device.deviceToken),
  });
}

async function newCapture(rollId: string): Promise<string> {
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
      mode: 'single',
      capturedAt: new Date().toISOString(),
      frameCount: 1,
      resolution: '1600x1200',
      status: 'created',
      visible: true,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ captureId: string }>().captureId;
}

let rollId = '';

beforeAll(async () => {
  await app.ready();
  const registered = await app.inject({
    method: 'POST',
    url: '/api/studio/devices/register',
    headers: bearer(app.config.PROVISIONING_TOKEN),
    payload: { serial: SERIAL, product: 'KINO D4', hardwareRevision: 'v1' },
  });
  expect(registered.statusCode).toBe(200);
  device = registered.json<{ deviceId: string; deviceToken: string }>();

  const created = await app.inject({
    method: 'POST',
    url: '/api/device/rolls',
    headers: bearer(device.deviceToken),
    payload: { title: `Integrity ${RUN}` },
  });
  expect(created.statusCode).toBe(201);
  rollId = created.json<{ rollId: string }>().rollId;
  createdRollIds.push(rollId);
}, 60_000);

/**
 * Torn down in dependency order, the same order `uploads.test.ts` uses:
 * parts -> sessions -> assets -> captures -> roll_devices -> rolls -> device.
 * Deleting a roll while its captures still reference it is a foreign-key
 * violation (`captures_roll_id_rolls_id_fk`), and a teardown that throws takes
 * the whole suite with it whatever the tests did.
 */
afterAll(async () => {
  if (createdRollIds.length > 0) {
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
              new DeleteObjectCommand({ Bucket: app.config.S3_BUCKET, Key: row.objectKey }),
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

    await app.db
      .delete(schema.auditEvents)
      .where(inArray(schema.auditEvents.rollId, createdRollIds));
    await app.db
      .delete(schema.rollDevices)
      .where(inArray(schema.rollDevices.rollId, createdRollIds));
    await app.db.delete(schema.rolls).where(inArray(schema.rolls.id, createdRollIds));

    // A published roll event is durable (Task 19's XADD), so the stream would
    // outlive the roll it belongs to.
    await app.redis.del(...createdRollIds.map((id) => rollStreamKey(id)));
  }

  if (device !== undefined) {
    await app.db.delete(schema.devices).where(eq(schema.devices.id, device.deviceId));
  }
  await app.close();
}, 60_000);

describe('what the bytes actually are', () => {
  it('recognises each stored format from its first bytes', () => {
    expect(sniffContentType(bytesOf('jpeg').subarray(0, 16))).toBe('image/jpeg');
    expect(sniffContentType(bytesOf('webp').subarray(0, 16))).toBe('image/webp');
    expect(sniffContentType(bytesOf('html').subarray(0, 16))).toBe('text/html');
    // Random bytes announce nothing, and are therefore not a contradiction.
    expect(sniffContentType(randomBytes(16))).toBeNull();
    expect(contradictsDeclaredMime('image/webp', randomBytes(16))).toBeNull();
  });

  it('refuses a JPEG that was declared as a WebP', async () => {
    const captureId = await newCapture(rollId);
    const body = bytesOf('jpeg');

    // Everything the device declares is internally consistent: the digest is
    // right, the length is right. Only the TYPE is a lie, which is exactly the
    // case sha256 verification cannot see.
    const init = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: body.length,
      sha256: sha256Hex(body),
    });
    expect(init.statusCode).toBe(200);
    const { uploadId } = init.json<InitResponse>();
    expect((await putPart(uploadId, body)).statusCode).toBe(200);

    const done = await completeUpload(uploadId);
    expect(done.statusCode).toBe(422);
    expect(done.json()).toMatchObject({ code: 'CONTENT_TYPE_MISMATCH' });
    // The message names both sides, because a camera correcting its own
    // bookkeeping needs to know which half was wrong.
    expect(done.json<{ message: string }>().message).toContain('image/jpeg');
    expect(done.json<{ message: string }>().message).toContain('image/webp');

    // Refused means not stored: the asset stays `pending`, so nothing
    // downstream ever treats those bytes as authoritative.
    const [asset] = await app.db
      .select({ status: schema.assets.status })
      .from(schema.assets)
      .where(eq(schema.assets.captureId, captureId));
    expect(asset?.status).toBe('pending');
  });

  it('refuses an HTML document declared as an image', async () => {
    // The case with a consequence: this platform serves asset bytes INLINE from
    // the same origin as the guest's PIN and access cookies.
    const captureId = await newCapture(rollId);
    const body = bytesOf('html');
    const init = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: body.length,
      sha256: sha256Hex(body),
    });
    expect(init.statusCode).toBe(200);
    const { uploadId } = init.json<InitResponse>();
    expect((await putPart(uploadId, body)).statusCode).toBe(200);

    const done = await completeUpload(uploadId);
    expect(done.statusCode).toBe(422);
    expect(done.json()).toMatchObject({ code: 'CONTENT_TYPE_MISMATCH' });
  });

  it('accepts bytes that match what was declared', async () => {
    const captureId = await newCapture(rollId);
    const body = bytesOf('webp');
    const init = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: body.length,
      sha256: sha256Hex(body),
    });
    expect(init.statusCode).toBe(200);
    const { uploadId } = init.json<InitResponse>();
    expect((await putPart(uploadId, body)).statusCode).toBe(200);
    const done = await completeUpload(uploadId);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: 'ready' });
  });
});

/**
 * MinIO's own 24-hour sweep, simulated exactly the way it happens: the
 * multipart upload is abandoned out of band while the `upload_sessions` row
 * still says `open`. Aborting it directly is what MinIO's sweeper does; there
 * is no faster clock to wait on.
 */
describe('an upload storage has swept', () => {
  async function sweep(uploadId: string, captureId: string): Promise<void> {
    const [session] = await app.db
      .select({ s3UploadId: schema.uploadSessions.s3UploadId, assetId: schema.uploadSessions.assetId })
      .from(schema.uploadSessions)
      .where(eq(schema.uploadSessions.id, uploadId));
    expect(session?.s3UploadId).toBeTruthy();
    const [asset] = await app.db
      .select({ objectKey: schema.assets.objectKey })
      .from(schema.assets)
      .where(eq(schema.assets.id, session?.assetId ?? ''));
    expect(asset?.objectKey).toBeTruthy();
    expect(captureId).toBeTruthy();

    await app.s3.send(
      new AbortMultipartUploadCommand({
        Bucket: app.config.S3_BUCKET,
        Key: asset?.objectKey ?? '',
        UploadId: session?.s3UploadId ?? '',
      }),
    );
  }

  it('re-inits onto a fresh multipart instead of 500ing forever', async () => {
    const captureId = await newCapture(rollId);
    const body = bytesOf('webp');
    const declaration = {
      role: 'thumb',
      mime: 'image/webp',
      bytes: body.length,
      sha256: sha256Hex(body),
    };

    const first = await initAsset(captureId, declaration);
    expect(first.statusCode).toBe(200);
    const original = first.json<InitResponse>().uploadId;
    expect((await putPart(original, body)).statusCode).toBe(200);

    // The camera loses power here. Twenty-four hours pass.
    await sweep(original, captureId);

    /**
     * The camera comes back and resumes from the first incomplete step, which
     * the device contract says is `init`. This is the response that used to
     * hand it an upload id storage had never heard of.
     *
     * The recovery is invisible: same session id, same `partSize`, same
     * `alreadyComplete: false`. Nothing in the contract changed — the camera
     * simply re-sends its parts from SD, which is what it does after any
     * interrupted transfer.
     */
    const resumed = await initAsset(captureId, declaration);
    expect(resumed.statusCode).toBe(200);
    const again = resumed.json<InitResponse>();
    expect(again.uploadId).toBe(original);
    expect(again.alreadyComplete).toBe(false);

    expect((await putPart(again.uploadId, body)).statusCode).toBe(200);
    const done = await completeUpload(again.uploadId);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: 'ready' });
  });

  it('answers 409 rather than 500 when the sweep lands before complete', async () => {
    const captureId = await newCapture(rollId);
    const body = bytesOf('webp');
    const declaration = {
      role: 'thumb',
      mime: 'image/webp',
      bytes: body.length,
      sha256: sha256Hex(body),
    };

    const init = await initAsset(captureId, declaration);
    expect(init.statusCode).toBe(200);
    const { uploadId } = init.json<InitResponse>();
    expect((await putPart(uploadId, body)).statusCode).toBe(200);

    // Every part sent, the answer to `complete` lost, and the sweep in between.
    await sweep(uploadId, captureId);

    const done = await completeUpload(uploadId);
    // 409, not 500. The contract treats 5xx as transient and retries the SAME
    // upload id, which is precisely the loop this closes; "init again" is an
    // instruction the firmware already acts on.
    expect(done.statusCode).toBe(409);
    expect(done.json()).toMatchObject({ code: 'UPLOAD_NOT_OPEN' });

    // And that instruction terminates: init opens a fresh multipart, the parts
    // go again, the asset lands.
    const resumed = await initAsset(captureId, declaration);
    expect(resumed.statusCode).toBe(200);
    const again = resumed.json<InitResponse>();
    expect((await putPart(again.uploadId, body)).statusCode).toBe(200);
    expect((await completeUpload(again.uploadId)).statusCode).toBe(200);
  });

  it('answers 409 rather than 500 when the sweep lands between two parts', async () => {
    const captureId = await newCapture(rollId);
    const body = bytesOf('webp');
    const init = await initAsset(captureId, {
      role: 'thumb',
      mime: 'image/webp',
      bytes: body.length,
      sha256: sha256Hex(body),
    });
    expect(init.statusCode).toBe(200);
    const { uploadId } = init.json<InitResponse>();

    await sweep(uploadId, captureId);

    const part = await putPart(uploadId, body);
    expect(part.statusCode).toBe(409);
    expect(part.json()).toMatchObject({ code: 'UPLOAD_NOT_OPEN' });
  });
});
