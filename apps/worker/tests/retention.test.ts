import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config';
import { reconcileQueuedRow, type SweepQueue } from '../src/sweeper';
import { runPurge } from '../src/jobs/purgeTrash';
import {
  DERIVED_RETENTION_HOURS,
  isExpired,
  purgeExpiredDerivatives,
} from '../src/jobs/purgeDerivatives';
import { removeSupersededObject } from '../src/jobs/derive';
import type { MediaEraser } from '../src/storage/eraser';
import type { JobCtx, WorkerDatabase } from '../src/jobs/types';
import type { CaptureRow } from '../src/jobs/capture';

/**
 * The reliability and retention fixes, tested where they can be tested without
 * a database, a Redis or a bucket.
 *
 * Every suite in this workspace but this one drives the real dev stack, which is
 * right for "does drizzle's picture of the table match PostgreSQL's" and wrong
 * for "what does this function do when storage says no". The behaviours below
 * are decisions in TypeScript — which state counts as absent, which capture is
 * skipped, which key is deleted — so they are tested as decisions, with fakes
 * that answer the one question the code asks them.
 *
 * The fakes are cast to their real types. A fake that satisfied the whole
 * `WorkerDatabase` or `S3Client` surface would be a fixture nobody maintains,
 * and what is under test is the caller, not the client.
 */

/* ------------------------------------------------------------ the sweeper -- */

interface FakeSweep {
  queue: SweepQueue;
  removed: string[];
  enqueued: string[];
}

function fakeSweepQueue(state: string | null): FakeSweep {
  const removed: string[] = [];
  const enqueued: string[] = [];
  const queue: SweepQueue = {
    getJob: async (): Promise<{ getState(): Promise<string> } | undefined> =>
      state === null ? undefined : { getState: async (): Promise<string> => state },
    remove: async (jobId: string): Promise<number> => {
      removed.push(jobId);
      return 1;
    },
    enqueue: async (name, payload): Promise<void> => {
      enqueued.push(`${name}:${payload.jobKey}`);
    },
  };
  return { queue, removed, enqueued };
}

describe('the queued-row sweeper', () => {
  it('re-enqueues over a job Redis retained after it failed', async () => {
    // `removeOnFail: {age: 7d}` keeps the failed job, and `add()` is a no-op
    // against an existing id in ANY state — so the retained failure had to be
    // removed first or the re-add would silently do nothing.
    const fake = fakeSweepQueue('failed');

    const outcome = await reconcileQueuedRow(fake.queue, 'cap_1', 'generate-thumbnail');

    expect(outcome).toBe('retained');
    expect(fake.removed).toEqual(['cap_1~generate-thumbnail']);
    expect(fake.enqueued).toEqual(['generate-thumbnail:cap_1:generate-thumbnail']);
  });

  it('re-enqueues over a job retained after it completed', async () => {
    const fake = fakeSweepQueue('completed');

    expect(await reconcileQueuedRow(fake.queue, 'cap_1', 'render-wiggle-webp')).toBe('retained');
    expect(fake.removed).toHaveLength(1);
    expect(fake.enqueued).toHaveLength(1);
  });

  it.each(['waiting', 'active', 'delayed', 'prioritized'])(
    'leaves a job that is still %s alone',
    async (state) => {
      const fake = fakeSweepQueue(state);

      expect(await reconcileQueuedRow(fake.queue, 'cap_1', 'extract-metadata')).toBe('present');
      expect(fake.removed).toEqual([]);
      expect(fake.enqueued).toEqual([]);
    },
  );

  it('treats an unknown state as present rather than guessing', async () => {
    // Something is there; re-adding over a state this build cannot name would be
    // a guess, and the next sweep gets another chance.
    const fake = fakeSweepQueue('unknown');

    expect(await reconcileQueuedRow(fake.queue, 'cap_1', 'extract-metadata')).toBe('present');
    expect(fake.enqueued).toEqual([]);
  });

  it('adds the job when there is nothing in Redis at all', async () => {
    const fake = fakeSweepQueue(null);

    expect(await reconcileQueuedRow(fake.queue, 'cap_1', 'generate-thumbnail')).toBe('resubmitted');
    expect(fake.removed).toEqual([]);
    expect(fake.enqueued).toEqual(['generate-thumbnail:cap_1:generate-thumbnail']);
  });
});

/* -------------------------------------------------------------- the purge -- */

/**
 * A database that answers the purge's two questions and refuses everything else.
 *
 * `execute` is the expired-capture query; `transaction` is `dropCaptureRows`.
 * `select` throws on purpose — the two roll-level sweeps that run after the
 * capture pass use it, and their failures are supposed to be contained. A fake
 * that let them through would be testing them here by accident.
 */
function fakePurgeDb(remaining: { id: string; roll_id: string }[]): WorkerDatabase {
  const tx = {
    execute: async (): Promise<unknown[]> => [],
    insert: () => ({ values: async (): Promise<void> => {} }),
  };
  return {
    execute: async (): Promise<{ id: string; roll_id: string }[]> => [...remaining],
    transaction: async (fn: (t: typeof tx) => Promise<void>): Promise<void> => {
      await fn(tx);
    },
    select: (): never => {
      throw new Error('the fake database has no select');
    },
  } as unknown as WorkerDatabase;
}

function fakeCtx(db: WorkerDatabase, s3: Pick<S3Client, 'send'>): JobCtx {
  return {
    db,
    s3: s3 as S3Client,
    bucket: 'kino-media',
  } as unknown as JobCtx;
}

describe('purge-trash', () => {
  it('carries on past a capture it cannot erase, and counts it', async () => {
    /*
     * The failure this proves is fixed: the selection is oldest-first, so a
     * capture with one undeletable object was first in every batch of every run
     * — and `eraseCapture` throwing out of the handler meant nothing after it
     * was ever purged. One stuck key used to suspend 03 §11 for the whole
     * deployment.
     */
    const rows = [
      { id: 'cap_stuck', roll_id: 'roll_1' },
      { id: 'cap_ok_1', roll_id: 'roll_1' },
      { id: 'cap_ok_2', roll_id: 'roll_1' },
    ];
    const dropped: string[] = [];
    const eraser: MediaEraser = {
      eraseCapture: async (_rollId: string, captureId: string): Promise<number> => {
        if (captureId === 'cap_stuck') throw new Error('AccessDenied on one object');
        dropped.push(captureId);
        return 4;
      },
      close: (): void => {},
    };

    const db = fakePurgeDb(rows);
    // Purged captures disappear from the selection; the stuck one does not, which
    // is exactly the shape that used to make this loop non-terminating.
    let pass = 0;
    Object.assign(db, {
      execute: async (): Promise<{ id: string; roll_id: string }[]> => {
        pass += 1;
        if (pass === 1) return [...rows];
        return [{ id: 'cap_stuck', roll_id: 'roll_1' }];
      },
    });

    const result = await runPurge(eraser, fakeCtx(db, { send: async () => ({}) }), null);

    expect(result.captures).toBe(2);
    expect(result.objects).toBe(8);
    expect(result.failures).toBe(1);
    expect(dropped).toEqual(['cap_ok_1', 'cap_ok_2']);
  });
});

/* -------------------------------------------- the roll-level derivatives -- */

/** A drizzle select, as much of one as these fakes need to be awaited. */
interface SelectChain<T> {
  from(): SelectChain<T>;
  where(): SelectChain<T>;
  orderBy(): SelectChain<T>;
  limit(): Promise<T>;
}

interface FakeDelete {
  s3: Pick<S3Client, 'send'>;
  keys: string[];
}

/** An S3 that reports every key it was handed as deleted, and remembers them. */
function fakeDeleteClient(): FakeDelete {
  const keys: string[] = [];
  const send = async (command: unknown): Promise<unknown> => {
    const input = (command as { input?: { Delete?: { Objects?: { Key?: string }[] } } }).input;
    const objects = input?.Delete?.Objects ?? [];
    const asked = objects.map((o) => o.Key).filter((k): k is string => typeof k === 'string');
    keys.push(...asked);
    return { Deleted: asked.map((Key) => ({ Key })), Errors: [] };
  };
  return { s3: { send } as unknown as Pick<S3Client, 'send'>, keys };
}

/**
 * A database that hands the first `select` a fixed set of rows and everything
 * after it nothing, so one call to `purgeExpiredDerivatives` exercises the
 * export table and leaves the recap table empty.
 */
function fakeDerivedDb(rows: { id: string; rollId: string; finishedAt: Date | null }[]): {
  db: WorkerDatabase;
  deletedRows: number;
} {
  let served = false;
  const state = { deletedRows: 0 };
  const chain: SelectChain<typeof rows> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => {
      if (served) return [];
      served = true;
      return rows;
    },
  };
  const db = {
    select: (): SelectChain<typeof rows> => chain,
    delete: () => ({
      where: async (): Promise<void> => {
        state.deletedRows += 1;
      },
    }),
  } as unknown as WorkerDatabase;
  return {
    db,
    get deletedRows(): number {
      return state.deletedRows;
    },
  };
}

describe('roll-level derivative retention', () => {
  it('deletes an export past 48 hours and leaves a fresh one alone', async () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const old = new Date(now.getTime() - 49 * 60 * 60 * 1000);
    const fresh = new Date(now.getTime() - 3 * 60 * 60 * 1000);

    const { db } = fakeDerivedDb([
      { id: 'exp_old', rollId: 'roll_1', finishedAt: old },
      { id: 'exp_fresh', rollId: 'roll_1', finishedAt: fresh },
    ]);
    const storage = fakeDeleteClient();

    const result = await purgeExpiredDerivatives(
      fakeCtx(db, storage.s3),
      DERIVED_RETENTION_HOURS,
      500,
      now,
    );

    expect(storage.keys).toEqual(['rolls/roll_1/derived/exports/exp_old.zip']);
    expect(result.exports).toBe(1);
    expect(result.recaps).toBe(0);
    expect(result.objects).toBe(1);
    expect(result.failures).toBe(0);
  });

  it('keeps the row when storage refuses the delete', async () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const old = new Date(now.getTime() - 72 * 60 * 60 * 1000);
    const { db } = fakeDerivedDb([{ id: 'exp_locked', rollId: 'roll_1', finishedAt: old }]);

    const refusing: Pick<S3Client, 'send'> = {
      send: (async () => ({
        Deleted: [],
        Errors: [
          { Key: 'rolls/roll_1/derived/exports/exp_locked.zip', Code: 'AccessDenied' },
        ],
      })) as unknown as S3Client['send'],
    };

    const result = await purgeExpiredDerivatives(
      fakeCtx(db, refusing),
      DERIVED_RETENTION_HOURS,
      500,
      now,
    );

    // Objects before rows: a row whose object is still there keeps its row, so
    // the next run finds it again rather than orphaning the bytes.
    expect(result.exports).toBe(0);
    expect(result.objects).toBe(0);
    expect(result.failures).toBe(1);
  });

  it('never treats a row with no finish time as expired', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    expect(isExpired(null, now, DERIVED_RETENTION_HOURS)).toBe(false);
    expect(isExpired(new Date(now.getTime() - 47 * 3_600_000), now, 48)).toBe(false);
    expect(isExpired(new Date(now.getTime() - 48 * 3_600_000), now, 48)).toBe(true);
  });
});

/* --------------------------------------------- the superseded device thumb -- */

const CAPTURE: CaptureRow = {
  id: 'cap_1',
  rollId: 'roll_1',
} as unknown as CaptureRow;

interface FakeSupersede {
  ctx: JobCtx;
  deleted: string[];
}

/** `referencing` is what the "does another row still name this key" query finds. */
function fakeSupersedeCtx(referencing: { id: string }[]): FakeSupersede {
  const deleted: string[] = [];
  const chain: SelectChain<{ id: string }[]> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => referencing,
  };
  const db = { select: (): SelectChain<{ id: string }[]> => chain } as unknown as WorkerDatabase;
  const s3: Pick<S3Client, 'send'> = {
    send: (async (command: unknown) => {
      const key = (command as { input?: { Key?: string } }).input?.Key;
      if (typeof key === 'string') deleted.push(key);
      return {};
    }) as unknown as S3Client['send'],
  };
  return { ctx: fakeCtx(db, s3), deleted };
}

describe('publishDerived, when a derivative supersedes another object', () => {
  const deviceThumb = 'rolls/roll_1/captures/cap_1/derived/thumb.jpg';
  const workerThumb = 'rolls/roll_1/captures/cap_1/derived/thumb.webp';

  it('deletes the object the row no longer points at', async () => {
    const fake = fakeSupersedeCtx([]);

    await removeSupersededObject(fake.ctx, CAPTURE, 'thumb', deviceThumb, workerThumb);

    expect(fake.deleted).toEqual([deviceThumb]);
  });

  it('does not delete an object another row still names', async () => {
    const fake = fakeSupersedeCtx([{ id: 'asset_other' }]);

    await removeSupersededObject(fake.ctx, CAPTURE, 'thumb', deviceThumb, workerThumb);

    expect(fake.deleted).toEqual([]);
  });

  it('does nothing when the key did not change', async () => {
    const fake = fakeSupersedeCtx([]);

    await removeSupersededObject(fake.ctx, CAPTURE, 'thumb', workerThumb, workerThumb);

    expect(fake.deleted).toEqual([]);
  });

  it('refuses a previous key outside this capture\'s derived folder', async () => {
    const fake = fakeSupersedeCtx([]);

    // An original, and a derivative of a different capture. Neither is this
    // function's to delete however the row got that way.
    await removeSupersededObject(
      fake.ctx,
      CAPTURE,
      'thumb',
      'rolls/roll_1/captures/cap_1/original/cam-01.jpg',
      workerThumb,
    );
    await removeSupersededObject(
      fake.ctx,
      CAPTURE,
      'thumb',
      'rolls/roll_1/captures/cap_2/derived/thumb.jpg',
      workerThumb,
    );

    expect(fake.deleted).toEqual([]);
  });

  it('never fails the job when storage refuses', async () => {
    const deleted: string[] = [];
    const chain: SelectChain<{ id: string }[]> = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => [],
    };
    const db = { select: (): SelectChain<{ id: string }[]> => chain } as unknown as WorkerDatabase;
    const s3: Pick<S3Client, 'send'> = {
      send: (async () => {
        throw new Error('storage said no');
      }) as unknown as S3Client['send'],
    };

    await expect(
      removeSupersededObject(fakeCtx(db, s3), CAPTURE, 'thumb', deviceThumb, workerThumb),
    ).resolves.toBeUndefined();
    expect(deleted).toEqual([]);
  });
});

/* ------------------------------------------------------------- the config -- */

describe('worker configuration in production', () => {
  const real = {
    DATABASE_URL: 'postgres://kino:s3cr3t@db.internal:5432/kino',
    REDIS_URL: 'redis://cache.internal:6379',
    S3_ENDPOINT: 'https://storage.internal',
    S3_ACCESS_KEY: 'AKIAREAL',
    S3_SECRET_KEY: 'a-real-secret',
  };

  it('refuses to boot on the published dev credentials', () => {
    expect(() => loadWorkerConfig({ NODE_ENV: 'production' })).toThrow(
      /still have their published development default/,
    );
  });

  it('names only the variables that are still defaulted, and never their values', () => {
    let message = '';
    try {
      loadWorkerConfig({ ...real, NODE_ENV: 'production', S3_SECRET_KEY: 'kino-secret' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('S3_SECRET_KEY');
    expect(message).not.toContain('DATABASE_URL');
    expect(message).not.toContain('kino-secret');
    expect(message).not.toContain('s3cr3t');
  });

  it('boots in production once every credential is supplied', () => {
    const config = loadWorkerConfig({ ...real, NODE_ENV: 'production' });
    expect(config.S3_ACCESS_KEY).toBe('AKIAREAL');
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('still boots on the dev defaults outside production', () => {
    // A bench worker with no NODE_ENV set must keep working against the compose
    // stack; the refusal is aimed at the deployment that says it is production.
    expect(() => loadWorkerConfig({})).not.toThrow();
    expect(() => loadWorkerConfig({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('refuses a LOG_LEVEL it does not know', () => {
    expect(() => loadWorkerConfig({ LOG_LEVEL: 'chatty' })).toThrow(/LOG_LEVEL must be one of/);
  });
});
