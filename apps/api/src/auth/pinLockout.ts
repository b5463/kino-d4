import type { Redis } from 'ioredis';

/**
 * Per-**roll** PIN attempt counting, which is the control the PIN gate was
 * missing.
 *
 * The only defence used to be five attempts a minute per source address, and
 * that number is wrong in both directions once the deployment sits behind a
 * relay:
 *
 *   - every guest at a venue shares one public address, so a party where
 *     thirty phones type the PIN at the doors locks itself out of its own roll;
 *   - an attacker spread over a botnet keeps five guesses per address per
 *     minute against a 4-digit PIN, and the roll never notices, because nothing
 *     counted attempts *against the roll*.
 *
 * A counter on the roll fixes the second and is indifferent to the first: it
 * counts failures, and a venue whose guests type the right PIN produces none.
 * The two limits coexist by measuring different things — this one counts wrong
 * answers per roll, the rate limit counts requests per address and roll — so
 * neither has to be loosened to make room for the other.
 *
 * ## The numbers, and what they buy
 *
 * Ten wrong PINs put a roll's PIN gate out of service for fifteen minutes. That
 * is 960 guesses a day against a space of 10 000 four-digit PINs, so walking
 * the whole space takes about ten days and the expected hit is around five —
 * against a roll that exists for one evening. It is not cryptographic and is
 * not claimed to be; it is the difference between "a laptop opens this in
 * twenty minutes" and "nobody bothers".
 *
 * A correct PIN clears the count, which is what keeps a fat-fingering crowd
 * from locking a real party out: any guest who gets in resets the roll for
 * everybody. That also means an attacker sharing a roll with legitimate guests
 * gets his ten back whenever one of them succeeds — accepted, because the
 * alternative punishes the party, and ten guesses per reset is still ten.
 */

/** Wrong PINs a roll tolerates before its gate closes. */
export const PIN_ATTEMPT_LIMIT = 10;

/** How long the count — and therefore the lockout — lives. */
export const PIN_LOCKOUT_SECONDS = 15 * 60;

/** Keyed by roll id, never by slug: regenerating a slug must not reset a count. */
export function pinAttemptKey(rollId: string): string {
  return `pin-attempts:${rollId}`;
}

export interface PinLockout {
  locked: boolean;
  /** Seconds until the count expires; `PIN_LOCKOUT_SECONDS` if Redis has no TTL yet. */
  retryAfter: number;
}

/**
 * Whether this roll's PIN gate is currently closed.
 *
 * Read **before** `verifyPin`, so a locked roll costs no scrypt: the CPU burn
 * and the guessing are the same attack seen from two sides, and refusing early
 * answers both.
 */
export async function pinLockoutOf(redis: Redis, rollId: string): Promise<PinLockout> {
  const key = pinAttemptKey(rollId);
  const attempts = Number(await redis.get(key));
  if (!Number.isFinite(attempts) || attempts < PIN_ATTEMPT_LIMIT) {
    return { locked: false, retryAfter: 0 };
  }
  const ttl = await redis.ttl(key);
  return { locked: true, retryAfter: ttl > 0 ? ttl : PIN_LOCKOUT_SECONDS };
}

/**
 * Records one wrong PIN and reports whether that was the one that closed the
 * gate.
 *
 * The TTL is set on the first failure only, so the window is fifteen minutes
 * from the first wrong answer rather than a sliding window a steady attacker
 * could hold open indefinitely.
 */
export async function recordPinFailure(redis: Redis, rollId: string): Promise<PinLockout> {
  const key = pinAttemptKey(rollId);
  const attempts = await redis.incr(key);
  if (attempts === 1) await redis.expire(key, PIN_LOCKOUT_SECONDS);
  return attempts >= PIN_ATTEMPT_LIMIT
    ? { locked: true, retryAfter: PIN_LOCKOUT_SECONDS }
    : { locked: false, retryAfter: 0 };
}

/** A correct PIN clears the roll's count. See the note above on why. */
export async function clearPinAttempts(redis: Redis, rollId: string): Promise<void> {
  await redis.del(pinAttemptKey(rollId));
}
