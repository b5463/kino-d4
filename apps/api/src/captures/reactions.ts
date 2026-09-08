import { and, eq, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import { captures, reactions } from '../db/schema';
import type { KinoDatabase } from '../plugins/db';
import { newId } from '../ids';

const GUEST_COOKIE = 'kino_guest';
const GUEST_ID = /^guest_[A-Za-z0-9_-]{22}$/;

export interface ReactionState {
  reactionCount: number;
  reacted: boolean;
}

/** Reads the anonymous, signed browser identity without creating one on a GET. */
export function guestIdOf(request: FastifyRequest): string | null {
  const raw = request.cookies[GUEST_COOKIE];
  if (raw === undefined) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value !== null && GUEST_ID.test(unsigned.value)
    ? unsigned.value
    : null;
}

/** Creates a session-only anonymous id the first time this browser reacts. */
export function ensureGuestId(request: FastifyRequest, reply: FastifyReply): string {
  const existing = guestIdOf(request);
  if (existing !== null) return existing;

  const guestId = newId('guest');
  reply.setCookie(GUEST_COOKIE, guestId, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    path: '/api/rolls/',
  });
  return guestId;
}

export async function readReactionState(
  db: KinoDatabase,
  captureId: string,
  guestId: string | null,
): Promise<ReactionState> {
  const [row] = await db
    .select({
      reactionCount: sql<number>`count(*)::int`,
      reacted: sql<boolean>`coalesce(bool_or(${reactions.guestId} = ${guestId ?? ''}), false)`,
    })
    .from(reactions)
    .where(and(eq(reactions.captureId, captureId), eq(reactions.kind, 'heart')));

  return row ?? { reactionCount: 0, reacted: false };
}

/**
 * Toggles one heart.
 *
 * ## Why there is no lock any more
 *
 * This used to take `SELECT ... FOR UPDATE` on the **capture** row and run four
 * statements inside a transaction. The lock was on the wrong row and bought
 * nothing: `reactions_unique` on `(capture_id, guest_id, kind)` already makes
 * the only outcome that matters — one heart per guest per capture — impossible
 * to violate, whatever order two taps arrive in. What the lock did buy was
 * contention on the one row every guest looking at the same photograph needs:
 * a popular capture at a party serialised every tap on it, each one holding a
 * pooled connection (`max: 10`) for the length of four round trips, behind the
 * same row a device's own writes touch.
 *
 * So the write is two statements and no transaction, and the index decides:
 *
 * - `DELETE ... RETURNING` asks "was there a heart?" and removes it in one
 *   statement, so no read can go stale between the question and the write. Rows
 *   back means this tap was an un-react.
 * - Nothing back means there was none, so insert one — `onConflictDoNothing`,
 *   because a double-tap that raced itself has one of the two lose at the index,
 *   and "there is a heart" is what both taps were asking for. A conflict is
 *   convergence here, not an error.
 *
 * Two genuinely concurrent taps from the *same* guest can still interleave into
 * either order, which is what a double-tap means, and both leave the row in a
 * state the guest asked for. The count is read afterwards and is a snapshot: it
 * can differ by one from what a simultaneous stranger's tap will make it, which
 * is true of any count anyone reads.
 */
export async function toggleReaction(
  db: KinoDatabase,
  rollId: string,
  captureId: string,
  guestId: () => string,
): Promise<ReactionState | null> {
  // The same ownership/visibility test as the guest detail route, and a plain
  // read: nothing downstream depends on this row not changing, because the
  // reaction row's own constraint is what keeps the write correct.
  const [capture] = await db
    .select({ id: captures.id })
    .from(captures)
    .where(
      and(
        eq(captures.id, captureId),
        eq(captures.rollId, rollId),
        eq(captures.visible, true),
        sql`${captures.deletedAt} is null`,
      ),
    )
    .limit(1);
  if (capture === undefined) return null;

  // Mint the anonymous session only after the target passed that test. A probe
  // for a hidden or unknown id must not create browser state.
  const reactingGuestId = guestId();
  const mine = and(
    eq(reactions.captureId, captureId),
    eq(reactions.guestId, reactingGuestId),
    eq(reactions.kind, 'heart'),
  );

  const removed = await db.delete(reactions).where(mine).returning({ id: reactions.id });
  if (removed.length === 0) {
    await db
      .insert(reactions)
      .values({ id: newId('reaction'), captureId, guestId: reactingGuestId, kind: 'heart' })
      // Bare: `reactions_unique` is the only constraint an insert here can hit,
      // and naming it would be a second copy of the schema's own rule.
      .onConflictDoNothing();
  }

  const [count] = await db
    .select({ reactionCount: sql<number>`count(*)::int` })
    .from(reactions)
    .where(and(eq(reactions.captureId, captureId), eq(reactions.kind, 'heart')));
  return { reactionCount: count?.reactionCount ?? 0, reacted: removed.length === 0 };
}
