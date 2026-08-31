import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray, eq } from 'drizzle-orm';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { buildServer } from '../src/server';
import { loadConfig } from '../src/config';
import * as schema from '../src/db/schema';
import { loadWorkerConfig } from '../../worker/src/config';
import { createJobRuntime } from '../../worker/src/context';
import { registerImageHandlers } from '../../worker/src/jobs';
import { createJobQueue } from '../../worker/src/queue';
import { runTestUploader, type TestUploaderResult } from '../../../infra/scripts/test-uploader';

const RUN = randomBytes(5).toString('hex');
const SERIAL = `KD4-T37-${RUN}`;
const JOB_QUEUE_PREFIX = `kino-jobs-test-uploader-${RUN}`;
const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  JOB_QUEUE_PREFIX,
});
const workerConfig = loadWorkerConfig({ ...process.env, JOB_QUEUE_PREFIX });
const app = buildServer(config);
const runtime = createJobRuntime(workerConfig);
const queue = createJobQueue({
  connection: { url: workerConfig.REDIS_URL },
  prefix: workerConfig.JOB_QUEUE_PREFIX,
  onError: () => {},
});

let baseUrl = '';
let result: TestUploaderResult | undefined;

beforeAll(async () => {
  registerImageHandlers(queue);
  queue.start(runtime.ctx);
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
}, 60_000);

afterAll(async () => {
  const [createdDevice] = await app.db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(eq(schema.devices.serial, SERIAL))
    .limit(1);
  const deviceId = result?.deviceId ?? createdDevice?.id;
  const createdRolls =
    deviceId === undefined
      ? []
      : await app.db
          .select({ id: schema.rolls.id })
          .from(schema.rolls)
          .where(eq(schema.rolls.createdByDeviceId, deviceId));
  const rollIds = result === undefined ? createdRolls.map((roll) => roll.id) : [result.rollId];

  if (rollIds.length > 0) {
    const captureRows = await app.db
      .select({ id: schema.captures.id })
      .from(schema.captures)
      .where(inArray(schema.captures.rollId, rollIds));
    const captureIds = captureRows.map((capture) => capture.id);
    const assetRows =
      captureIds.length === 0
        ? []
        : await app.db
            .select({ id: schema.assets.id, objectKey: schema.assets.objectKey })
            .from(schema.assets)
            .where(inArray(schema.assets.captureId, captureIds));
    const assetIds = assetRows.map((row) => row.id);

    await Promise.all(
      assetRows.map((row) =>
        app.s3
          .send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: row.objectKey }))
          .catch(() => undefined),
      ),
    );

    if (assetIds.length > 0) {
      const sessions = await app.db
        .select({ id: schema.uploadSessions.id })
        .from(schema.uploadSessions)
        .where(inArray(schema.uploadSessions.assetId, assetIds));
      const sessionIds = sessions.map((row) => row.id);
      if (sessionIds.length > 0) {
        await app.db
          .delete(schema.uploadParts)
          .where(inArray(schema.uploadParts.uploadId, sessionIds));
        await app.db
          .delete(schema.uploadSessions)
          .where(inArray(schema.uploadSessions.id, sessionIds));
      }
    }

    if (captureIds.length > 0) {
      await app.db
        .delete(schema.processingEvents)
        .where(inArray(schema.processingEvents.captureId, captureIds));
      await app.db.delete(schema.assets).where(inArray(schema.assets.captureId, captureIds));
      await app.db.delete(schema.captures).where(inArray(schema.captures.id, captureIds));

    }

    await app.db.delete(schema.auditEvents).where(inArray(schema.auditEvents.rollId, rollIds));
    await app.db.delete(schema.rollDevices).where(inArray(schema.rollDevices.rollId, rollIds));
    await app.db.delete(schema.rolls).where(inArray(schema.rolls.id, rollIds));
  }

  if (deviceId !== undefined) await app.db.delete(schema.devices).where(eq(schema.devices.id, deviceId));
  // This test owns the unique prefix, so unlike the shared production queue it
  // can remove the namespace itself and leave no Redis bookkeeping behind.
  await queue.obliterate();
  await queue.close();
  await app.close();
  await runtime.close();
}, 60_000);

describe('camera-simulating test uploader', () => {
  it('survives a lost part acknowledgement and duplicate retries, reaches the guest feed, and closes', async () => {
    /**
     * The device is registered *here*, not by the uploader.
     *
     * `POST /api/studio/devices/register` is gated on `PROVISIONING_TOKEN`, and
     * `infra/scripts/test-uploader.ts` sends no such header — it takes a
     * pre-registered credential instead, which is the path a real bench uses
     * anyway: Studio provisions the camera, the camera uploads. Registering
     * through `app.inject` keeps this suite testing the uploader rather than the
     * provisioning gate, which `auth.test.ts` owns.
     */
    const registered = await app.inject({
      method: 'POST',
      url: '/api/studio/devices/register',
      headers: { authorization: `Bearer ${config.PROVISIONING_TOKEN}` },
      payload: { serial: SERIAL, product: 'KINO D4', hardwareRevision: 'v1' },
    });
    expect(registered.statusCode).toBe(200);
    const credential = registered.json<{ deviceId: string; deviceToken: string }>();

    result = await runTestUploader({
      baseUrl,
      serial: SERIAL,
      deviceId: credential.deviceId,
      deviceToken: credential.deviceToken,
      title: `Uploader acceptance ${RUN}`,
      fixtureDirectory: fileURLToPath(
        new URL('../../../packages/test-fixtures/media/frame-01.jpg', import.meta.url),
      ).replace(/[\\/]frame-01\.jpg$/, ''),
      dropPart: 3,
      duplicateRetry: true,
      viewerCount: 3,
      viewerPolls: 2,
      closeRoll: true,
      waitTimeoutMs: 90_000,
    });

    expect(result.droppedPartRetried).toBe(true);
    expect(result.duplicateRetriesVerified).toBe(true);
    expect(result.captures).toHaveLength(1);
    expect(result.captures[0]?.status).toBe('ready');
    expect(
      result.captures[0]?.assets.filter(
        (asset) => asset.role === 'original-frame' && asset.status === 'ready',
      ),
    ).toHaveLength(4);
    expect(result.captures[0]?.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'thumb', status: 'ready' }),
        expect.objectContaining({ role: 'kino-still', status: 'ready' }),
        expect.objectContaining({ role: 'wiggle-webp', status: 'ready' }),
      ]),
    );
    expect(result.guestCaptureIds).toContain(result.captures[0]?.captureId);
    expect(result.viewerRequests).toBe(6);
    expect(result.rollStatus).toBe('closed');
  }, 120_000);
});
