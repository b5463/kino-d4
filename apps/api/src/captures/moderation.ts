import { and, eq, isNull, ne } from 'drizzle-orm';
import { TRASH_GRACE_DAYS, TRASH_GRACE_MS } from '@kino/schemas';
import type { KinoDatabase } from '../plugins/db';
import type { HostCapture } from '../auth/plugins';
import { auditRows } from '../rolls/rolls';
import { auditEvents, captures } from '../db/schema';

/**
 * The two moderation verbs of 03 §11, and the difference between them.
 *
 *   hide   — `visible = false`. The capture leaves the guest feed immediately
 *            and the bytes are **retained**. Reversible, and the reverse costs
 *            nothing.
 *   delete — `deleted_at = now()`. Destructive, but not yet: the row and its
 *            objects survive `TRASH_GRACE_DAYS` so a host who deleted the wrong
 *            photo at a party can get it back the next morning. Task 25's purge
 *            job is what finally removes the bytes.
 *
 * Both live here rather than in the route file because "what a guest may see" has
 * exactly one definition (`guestVisible` in `feed.ts` reads the same two columns)
 * and the grace period has exactly one owner in `@kino/schemas`, shared with the
 * purge worker rather than re-declared on either side.
 */

/**
 * Seven days (03 §11).
 *
 * The unit is days, not hours, because the mistake this protects against is
 * noticed the *next day* — a host moderating at 1 a.m. finds out at breakfast
 * that the photo was fine. Anything short enough to expire overnight would make
 * the trash decorative.
 */
export { TRASH_GRACE_DAYS, TRASH_GRACE_MS };

/** When a trashed capture becomes the purge job's to destroy. */
export function purgeAfter(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + TRASH_GRACE_MS);
}

/** The host's view of a moderated capture — the moderation state and nothing else. */
export interface ModerationView {
  captureId: string;
  visible: boolean;
  deletedAt: Date | null;
  /** Null while the capture is not in the trash. */
  purgeAfter: Date | null;
}

export function moderationView(capture: HostCapture): ModerationView {
  return {
    captureId: capture.id,
    visible: capture.visible,
    deletedAt: capture.deletedAt,
    purgeAfter: capture.deletedAt === null ? null : purgeAfter(capture.deletedAt),
  };
}

/** The columns an UPDATE returns, matching `HostCapture` so the two cannot drift. */
const moderationColumns = {
  id: captures.id,
  rollId: captures.rollId,
  visible: captures.visible,
  deletedAt: captures.deletedAt,
};

/**
 * What a moderation write produced: the new state, and whether anything moved.
 *
 * `changed` is what the route keys the audit row and the SSE event on. Hiding an
 * already-hidden capture is a normal thing for a client to do — a retry, a second
 * tap, two host tabs open — and answering 200 while writing a second audit row
 * would make the trail record something that did not happen. The same reasoning
 * as `applyPatch` in `host-rolls.ts`.
 *
 * **The test that decides is the WHERE clause, not a comparison in JavaScript.**
 * The preHandler's read is a snapshot taken one round trip earlier, so two
 * concurrent requests both see the old state and both pass any guard based on it
 * — duplicate audit row, duplicate event, and for delete a `deleted_at`
 * overwritten with the later timestamp. That is not a rare interleaving: a client
 * timeout does not cancel the in-flight request, so the retry races the original
 * by construction. Making the predicate part of the UPDATE lets PostgreSQL's row
 * lock decide, and "no row came back" is then the honest definition of "somebody
 * else already did this".
 */
export interface ModerationResult {
  capture: HostCapture;
  changed: boolean;
}

/**
 * The capture's state as the database currently has it.
 *
 * Read only on the no-op path, where the snapshot the preHandler carries may be a
 * round trip out of date — the whole point of losing that race is that somebody
 * else's write is the one to report. Falls back to the snapshot if the row is
 * gone, which nothing in V1 can do (purge is Task 25's and hard-deletes captures
 * only after the grace period).
 */
async function currentState(db: KinoDatabase, capture: HostCapture): Promise<HostCapture> {
  const [row] = await db
    .select(moderationColumns)
    .from(captures)
    .where(eq(captures.id, capture.id))
    .limit(1);
  return row ?? capture;
}

/**
 * Sets `visible`, with the audit row in the same transaction.
 *
 * `ne(visible)` in the WHERE is the concurrency guard described above. `rollId` is
 * there too, even though the preHandler established the pair: it costs nothing and
 * means no future refactor of the auth layer can turn this into an update of a
 * capture in a roll the caller does not hold.
 */
export async function setCaptureVisible(
  db: KinoDatabase,
  capture: HostCapture,
  visible: boolean,
): Promise<ModerationResult> {
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(captures)
      .set({ visible })
      .where(
        and(
          eq(captures.id, capture.id),
          eq(captures.rollId, capture.rollId),
          ne(captures.visible, visible),
        ),
      )
      .returning(moderationColumns);
    // Already in the requested state, by this request or by one that beat it.
    // No audit row and no event, and the transaction commits having done nothing.
    if (row === undefined) return null;

    await tx.insert(auditEvents).values(
      auditRows([
        {
          rollId: capture.rollId,
          actor: 'host',
          action: visible ? 'capture.unhidden' : 'capture.hidden',
          // The capture id, not a destroyed value: a moderation entry that did
          // not name its capture would record that *something* was hidden.
          target: capture.id,
        },
      ]),
    );
    return row;
  });

  if (updated === null) return { capture: await currentState(db, capture), changed: false };
  return { capture: updated, changed: true };
}

/**
 * Moves a capture to the trash.
 *
 * `visible` is deliberately left alone. The two flags mean different things and
 * a restore (Task 25) has to be able to put the capture back exactly as the host
 * had it — collapsing delete into "hide and mark" would silently unhide anything
 * that was hidden before it was deleted.
 *
 * `isNull(deleted_at)` in the WHERE keeps the **original** timestamp: re-deleting
 * must not quietly extend the grace period, and the guard has to be in the
 * statement rather than in a pre-check because the client that retries on a
 * timeout is racing its own first attempt.
 */
export async function trashCapture(
  db: KinoDatabase,
  capture: HostCapture,
): Promise<ModerationResult> {
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(captures)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(captures.id, capture.id),
          eq(captures.rollId, capture.rollId),
          isNull(captures.deletedAt),
        ),
      )
      .returning(moderationColumns);
    if (row === undefined) return null;

    await tx.insert(auditEvents).values(
      auditRows([
        {
          rollId: capture.rollId,
          actor: 'host',
          action: 'capture.deleted',
          target: capture.id,
        },
      ]),
    );
    return row;
  });

  if (updated === null) return { capture: await currentState(db, capture), changed: false };
  return { capture: updated, changed: true };
}
