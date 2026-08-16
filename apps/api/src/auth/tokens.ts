import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Bearer credentials for the two non-guest scopes (05 §12).
 *
 * - `kdt` — KINO device token, provisioned in Studio (03 §17).
 * - `hrt` — host roll token, one per roll; V1 has no accounts, so the token
 *   *is* the host identity ("secure account/session **or equivalent host
 *   token**", 05 §12).
 *
 * The prefix is part of the credential, not decoration: it is what lets a
 * request be rejected for using the *wrong scope* (403) rather than being
 * silently probed against the wrong table.
 *
 * Only the sha256 hash is ever stored. A database dump therefore contains no
 * usable credential, and there is exactly one moment when the plaintext exists
 * server-side: the response that issues it.
 *
 * node:crypto only — no argon2/bcrypt dependency. That is sound *here* because
 * the secret is 256 bits of CSPRNG output, not a human-chosen string: there is
 * nothing to brute-force, so a slow KDF would buy nothing. PINs are the
 * opposite case and get scrypt instead — see `pins.ts`.
 */
export type TokenScope = 'kdt' | 'hrt';

export interface IssuedToken {
  /** Plaintext. Return it to the caller once, then let it go out of scope. */
  token: string;
  /** sha256 hex of the FULL token string, prefix included. */
  hash: string;
}

/** 32 bytes -> 43 base64url characters, so a token is `kdt_` + 43 = 47 chars. */
const TOKEN_BYTES = 32;

export function newToken(prefix: TokenScope): IssuedToken {
  const token = `${prefix}_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  return { token, hash: hashToken(token) };
}

/**
 * Hashes the whole token string, prefix included. Hashing only the random half
 * would let a `kdt_` and an `hrt_` token with the same random half collide into
 * one stored hash; including the prefix makes the scope part of the identity.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex digests — token hashes here, and the PIN
 * cookie fingerprint in `plugins.ts`.
 *
 * `timingSafeEqual` throws on length mismatch, so the lengths are checked first
 * — that check is not itself constant-time, but a digest's length is fixed and
 * public, so it leaks nothing about the secret.
 */
export function timingSafeHexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Extracts the credential from `Authorization: Bearer <token>`, or null. */
export function bearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer (\S+)$/.exec(authorization);
  return match?.[1] ?? null;
}

/** The scope prefix of a token (`kdt_abc` -> `kdt`), or null if malformed. */
export function tokenScope(token: string): string | null {
  const separator = token.indexOf('_');
  return separator > 0 ? token.slice(0, separator) : null;
}
