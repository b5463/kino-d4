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
 * Toggles one heart while locking the capture, making repeated/concurrent taps
 * converge on a valid unique row instead of surfacing a database conflict.
 */
export async function toggleReaction(
  db: KinoDatabase,
  rollId: string,
  captureId: string,
  guestId: () => string,
): Promise<ReactionState | null> {
  return db.transaction(async (tx) => {
    const [capture] = await tx
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
      .for('update')
      .limit(1);
    if (capture === undefined) return null;

    // Mint the anonymous session only after the target passed the same
    // ownership/visibility test as the guest detail route. A probe for a
    // hidden or unknown id must not create browser state.
    const reactingGuestId = guestId();

    const [existing] = await tx
      .select({ id: reactions.id })
      .from(reactions)
      .where(
        and(
          eq(reactions.captureId, captureId),
          eq(reactions.guestId, reactingGuestId),
          eq(reactions.kind, 'heart'),
        ),
      )
      .limit(1);

    if (existing === undefined) {
      await tx.insert(reactions).values({
        id: newId('reaction'),
        captureId,
        guestId: reactingGuestId,
        kind: 'heart',
      });
    } else {
      await tx.delete(reactions).where(eq(reactions.id, existing.id));
    }

    const [count] = await tx
      .select({ reactionCount: sql<number>`count(*)::int` })
      .from(reactions)
      .where(and(eq(reactions.captureId, captureId), eq(reactions.kind, 'heart')));
    return { reactionCount: count?.reactionCount ?? 0, reacted: existing === undefined };
  });
}
