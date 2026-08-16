import { randomFillSync } from 'node:crypto';

/**
 * The public handle of a roll (05 §14). It is separate from `rolls.id` on
 * purpose: the id is an internal foreign key that appears in URLs no guest ever
 * sees, and the slug is the part a host hands out — so the slug can be rotated
 * (`regenerate-slug`) without rewriting a single row that references the roll.
 *
 * Six characters from a 31-character alphabet is ~887 million values, ~29.7
 * bits. That is *not* a cryptographic secret and must never be treated as one:
 * it is a link that is impractical to stumble on, backed by the PIN gate
 * (03 §9) when a roll actually needs a lock. The size is the spec's own example
 * format (`7F3K9Q`) and is deliberately short because it gets read off one
 * phone screen and typed into another.
 *
 * The alphabet omits `0`/`O` and `1`/`I`/`L` for exactly that reason. Every
 * excluded character is one a guest would otherwise mistype, and a mistyped
 * slug is a 404 with nothing to diagnose.
 */
export const SLUG_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export const SLUG_LENGTH = 6;

/** The same alphabet as a pattern, for validating a slug that arrives in a request. */
export const SLUG_PATTERN = /^[23456789A-HJKMNP-Z]{6}$/;

/**
 * The largest multiple of the alphabet size that fits in a byte (8 × 31 = 248).
 *
 * Bytes at or above it are discarded rather than folded in with `%`. Plain
 * modulo over 31 would make the first eight characters of the alphabet ~3% more
 * likely than the rest — a small bias, but a free one to avoid, and biased slug
 * generation is the kind of thing nobody ever goes back and fixes.
 */
const UNBIASED_CEILING = Math.floor(256 / SLUG_ALPHABET.length) * SLUG_ALPHABET.length;

/**
 * A fresh slug. Uniqueness is *not* promised here — it is enforced by the
 * `rolls_slug_unique` constraint, and the caller retries on collision (see
 * `withFreshSlug` in `rolls.ts`). A generator that queried the table to
 * pre-check would still race, so the constraint is the only real answer.
 */
export function newSlug(): string {
  // One buffer, refilled on exhaustion: rejection sampling needs an unknown
  // number of bytes, and 16 covers 6 characters on the overwhelming majority of
  // draws (the rejection rate is 8/256 = 3.1%).
  const bytes = Buffer.allocUnsafe(16);
  let next = bytes.length;

  let slug = '';
  while (slug.length < SLUG_LENGTH) {
    if (next >= bytes.length) {
      randomFillSync(bytes);
      next = 0;
    }
    const byte = bytes[next] as number;
    next += 1;
    if (byte < UNBIASED_CEILING) slug += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
  }
  return slug;
}
