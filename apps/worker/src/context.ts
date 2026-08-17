import type { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Redis } from 'ioredis';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { WorkerConfig } from './config';
import * as schema from './db/schema';
import { assertDerivedOnly, derivedCaptureKey } from './storage/derived';
import type { DerivedBody, JobCtx } from './jobs/types';

/**
 * The clients a handler is handed, and their lifetime.
 *
 * One database pool, one S3 client and one Redis client per process, shared by
 * every job — they are connection pools, not state, and handing each job its
 * own would spend the process's file descriptors on nothing. Everything that
 * *is* state lives in the job payload.
 */
export interface JobRuntime {
  ctx: JobCtx;
  close(): Promise<void>;
}

export function createJobRuntime(config: WorkerConfig): JobRuntime {
  const client = postgres(config.DATABASE_URL, {
    max: 10,
    connect_timeout: 5,
    onnotice: () => {},
  });
  const db = drizzle(client, { schema });

  const s3 = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    // MinIO serves buckets as path segments, not as virtual host subdomains.
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
  });

  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    connectTimeout: 5_000,
  });
  // ioredis emits 'error' on an unhandled socket failure; without a listener
  // that becomes an uncaught exception and kills the process.
  redis.on('error', (err: Error) => {
    console.error('[worker] redis client error', err);
  });

  const ctx: JobCtx = {
    db,
    s3,
    redis,

    async getObject(key: string): Promise<Readable> {
      const got = await s3.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
      if (got.Body === undefined) throw new Error(`stored object ${key} has no body`);
      return got.Body as Readable;
    },

    /**
     * The only way bytes leave a handler (01 §7).
     *
     * The key is *built*, never accepted: a handler names a file inside its own
     * capture's `derived/` folder and cannot address anything else. Two checks
     * back that up — the segment rule in `derivedCaptureKey`, which refuses
     * anything that could climb out of the folder, and `assertDerivedOnly`,
     * which refuses a name that would put the word `original` back into the
     * path from below.
     */
    async putDerived(
      rollId: string,
      captureId: string,
      name: string,
      body: DerivedBody,
      mime: string,
    ): Promise<string> {
      const key = derivedCaptureKey(rollId, captureId, name);
      assertDerivedOnly(key);

      await s3.send(
        new PutObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: key,
          Body: body,
          ContentType: mime,
        }),
      );
      return key;
    },
  };

  return {
    ctx,
    async close(): Promise<void> {
      s3.destroy();
      // `disconnect()` is safe whether or not the lazy connection was opened;
      // `quit()` rejects when the client never connected.
      redis.disconnect();
      await client.end({ timeout: 5 });
    },
  };
}
