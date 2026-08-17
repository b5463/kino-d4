import type { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '../db/schema';

/**
 * The job vocabulary (03 §19), and the context a handler is allowed to touch.
 *
 * Every name here is one the *platform* understands; Task 22 ships no handler
 * for any of them. Tasks 23–25 register the real ones against these names, and
 * the queue is what guarantees a name with no handler fails loudly rather than
 * disappearing.
 */
export const JOB_NAMES = [
  'generate-thumbnail',
  'generate-gallery-still',
  'render-wiggle-webp',
  'render-wiggle-mp4',
  'render-contact-sheet',
  'extract-metadata',
  'generate-recap',
  'ai-enhance',
  'export-roll',
  'purge-trash',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

const NAMES: ReadonlySet<string> = new Set(JOB_NAMES);

/**
 * Whether a string off the wire is a job this build knows.
 *
 * A queue outlives a deploy: a job added by a newer API can be read by an older
 * worker, so the name has to be *checked* rather than cast.
 */
export function isJobName(value: string): value is JobName {
  return NAMES.has(value);
}

/**
 * What a job carries. Ids only — never a copy of the capture document, which
 * would be a second, staler version of a row the handler can read itself.
 *
 * `jobKey` is the BullMQ `jobId`, which is what makes re-enqueueing a no-op
 * (03 §19). It is on the payload as well as on the job so a handler can log the
 * identity it is running under without reaching for BullMQ's own types.
 */
export interface JobPayload {
  captureId?: string;
  rollId?: string;
  jobKey: string;
}

/** `<captureId>:<jobName>` — one unit of work per capture per job. */
export function jobKeyFor(captureId: string, job: JobName): string {
  return `${captureId}:${job}`;
}

/**
 * `<rollId>:<jobName>:<exportId>` — roll-scoped work is not unique per roll,
 * because a host may export the same roll twice and legitimately want two
 * artifacts. The export id is what separates them.
 */
export function rollJobKeyFor(rollId: string, job: JobName, exportId: string): string {
  return `${rollId}:${job}:${exportId}`;
}

/**
 * Bytes a handler may hand to `putDerived`.
 *
 * A stream is deliberately not accepted: S3 needs a known `ContentLength` for
 * one, and every derivative Tasks 23–25 produce (a thumbnail, a still, a webp,
 * an MP4 read back off disk) is already a buffer or a file. Accepting a stream
 * would mean either buffering it here — the thing the caller was trying to
 * avoid — or a second, differently-failing code path.
 */
export type DerivedBody = Buffer | Uint8Array;

export type WorkerDatabase = PostgresJsDatabase<typeof schema>;

/**
 * Everything a handler is given, and the boundary of what it can do.
 *
 * There is no `s3.putObject` convenience and no writable key builder: the only
 * way bytes leave a handler is `putDerived`, and that function cannot address
 * anything under `original/` (01 §7). `s3` itself is here because reading is
 * unrestricted — a handler must be able to fetch the frames it works on.
 */
export interface JobCtx {
  db: WorkerDatabase;
  s3: S3Client;
  redis: Redis;
  /**
   * The stored object's body as a stream.
   *
   * `Promise<Readable>` rather than the plan's bare `Readable`: fetching an
   * object is a round trip, and a synchronous signature could only be honoured
   * by buffering it first.
   */
  getObject(key: string): Promise<Readable>;
  /** Writes a derivative and returns the key it landed on. */
  putDerived(
    rollId: string,
    captureId: string,
    name: string,
    body: DerivedBody,
    mime: string,
  ): Promise<string>;
}

export type JobHandler = (payload: JobPayload, ctx: JobCtx) => Promise<void>;
