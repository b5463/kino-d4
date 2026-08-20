import { and, asc, eq, isNull } from 'drizzle-orm';
import { UnrecoverableError } from 'bullmq';
import { captures, rolls } from '../db/schema';
import type { JobPayload, WorkerDatabase } from './types';

/**
 * What the roll-scoped jobs need before they can do anything: the roll id off the
 * payload, the row id out of the job key, the roll row, and the captures.
 *
 * The capture-scoped jobs have `capture.ts` for the same purpose. Roll-scoped
 * work is a different shape — it reads *many* captures and belongs to none of
 * them — so the reads are here rather than bolted onto that module.
 */

/** A job pointed at a roll that is not there. */
export class MissingRollError extends UnrecoverableError {
  readonly code = 'ROLL_NOT_FOUND';

  constructor(rollId: string) {
    super(`roll ${rollId} does not exist`);
    this.name = 'MissingRollError';
  }
}

/** A roll-scoped job whose payload has no roll id. */
export function requireRollId(payload: JobPayload): string {
  const { rollId } = payload;
  if (typeof rollId !== 'string' || rollId === '') {
    throw new Error(`job ${payload.jobKey} is roll-scoped but carries no rollId`);
  }
  return rollId;
}

/**
 * The row id a roll-scoped job is working for, out of its job key.
 *
 * `<rowId>:<jobName>` — the shape `exportJobKey` in the API builds and the same
 * one `jobKeyFor` uses for captures, with the *job's own row id* in the id
 * position rather than the roll's. That is deliberate on the API side: keying a
 * roll export on the roll would make two consecutive exports of one roll collide
 * in BullMQ, which is not what "one live export per roll" means.
 *
 * It is read from the key rather than carried as a second payload field so there
 * is one answer to "which row is this job's". Two fields could disagree, and the
 * one BullMQ deduplicates on is the key.
 */
export function jobRowIdOf(payload: JobPayload): string {
  const [rowId] = payload.jobKey.split(':');
  if (rowId === undefined || rowId === '') {
    throw new Error(`job key ${payload.jobKey} does not begin with a row id`);
  }
  return rowId;
}

/** The roll, narrowed to what a recap's title card needs. */
export interface RollRow {
  id: string;
  title: string;
  createdAt: Date;
}

export async function loadRoll(db: WorkerDatabase, rollId: string): Promise<RollRow> {
  const [row] = await db
    .select({ id: rolls.id, title: rolls.title, createdAt: rolls.createdAt })
    .from(rolls)
    .where(eq(rolls.id, rollId))
    .limit(1);

  if (row === undefined) throw new MissingRollError(rollId);
  return row;
}

/** A capture, narrowed to what the roll-scoped jobs read. */
export interface RollCaptureRow {
  id: string;
  rollId: string;
  mode: string;
  frameCount: number;
  capturedAt: Date;
}

export interface RollCaptureFilter {
  /**
   * Whether a capture the host hid is included.
   *
   * The two callers want opposite answers, and 03 §11 is why. Hide means
   * "immediate guest removal; retained for host/archive", so the host's **export**
   * includes hidden captures — it is their archive, and a photo they hid from the
   * party is still theirs. The **recap** is a thing that gets shown to people, so
   * it does not: a capture hidden from guests reappearing in the reel would undo
   * the hide in the most public way available.
   */
  includeHidden: boolean;
}

/**
 * Every capture of a roll, oldest first.
 *
 * `deleted_at is null` in both cases and never negotiable: a capture in the trash
 * is on its way out (03 §11) and belongs in neither a recap nor an export.
 *
 * Ordered by `captured_at`, then by id. The tiebreak is not decoration — a rig
 * fires four cameras from one trigger and two captures can share a timestamp to
 * the second, and an unordered result would make a re-run of the same recap
 * produce a different film.
 */
export async function loadRollCaptures(
  db: WorkerDatabase,
  rollId: string,
  filter: RollCaptureFilter,
): Promise<RollCaptureRow[]> {
  const columns = {
    id: captures.id,
    rollId: captures.rollId,
    mode: captures.mode,
    frameCount: captures.frameCount,
    capturedAt: captures.capturedAt,
  };

  const where = filter.includeHidden
    ? and(eq(captures.rollId, rollId), isNull(captures.deletedAt))
    : and(eq(captures.rollId, rollId), isNull(captures.deletedAt), eq(captures.visible, true));

  return db
    .select(columns)
    .from(captures)
    .where(where)
    .orderBy(asc(captures.capturedAt), asc(captures.id));
}
