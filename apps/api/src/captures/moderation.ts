import { and, eq } from 'drizzle-orm';
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
 * and the grace period has exactly one owner. Task 25's purge job imports
 * `TRASH_GRACE_DAYS` from here rather than re-declaring 7.
 */

/**
 * Seven days (03 §11).
 *
 * The unit is days, not hours, because the mistake this protects against is
 * noticed the *next day* — a host moderating at 1 a.m. finds out at breakfast
 * that the photo was fine. Anything short enough to expire overnight would make
 * the trash decorative.
 */
export const TRASH_GRACE_DAYS = 7;

export const TRASH_GRACE_MS = TRASH_GRACE_DAYS * 24 * 60 * 60 * 1000;

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
 */
export interface ModerationResult {
  capture: HostCapture;
  changed: boolean;
}

/**
 * Sets `visible`, with the audit row in the same transaction.
 *
 * The `rollId` is in the WHERE alongside the capture id even though the
 * preHandler has already established the pair. It costs nothing and it means no
 * future refactor of the auth layer can turn this into an update of a capture in
 * a roll the caller does not hold.
 */
export async function setCaptureVisible(
  db: KinoDatabase,
  capture: HostCapture,
  visible: boolean,
): Promise<ModerationResult> {
  if (capture.visible === visible) return { capture, changed: false };

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(captures)
      .set({ visible })
      .where(and(eq(captures.id, capture.id), eq(captures.rollId, capture.rollId)))
      .returning(moderationColumns);
    if (row === undefined) {
      // The preHandler read this row moments ago, so it cannot have vanished
      // without something being very wrong. Rolling back is the honest answer.
      throw new Error(`capture ${capture.id} disappeared during moderation`);
    }

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
 * Already-trashed is a no-op that keeps the **original** `deleted_at`: re-deleting
 * must not quietly extend the grace period, or a client that retries on a timeout
 * would postpone the purge every time.
 */
export async function trashCapture(
  db: KinoDatabase,
  capture: HostCapture,
): Promise<ModerationResult> {
  if (capture.deletedAt !== null) return { capture, changed: false };

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(captures)
      .set({ deletedAt: new Date() })
      .where(and(eq(captures.id, capture.id), eq(captures.rollId, capture.rollId)))
      .returning(moderationColumns);
    if (row === undefined) {
      throw new Error(`capture ${capture.id} disappeared during moderation`);
    }

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

  return { capture: updated, changed: true };
}
