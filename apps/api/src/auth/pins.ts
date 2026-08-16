import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Roll PINs (03 §9 `privacy: 'pin'`).
 *
 * A PIN is human-chosen and short, which is the opposite of a device/host token
 * — so unlike `tokens.ts` this uses a deliberately slow, salted KDF (scrypt,
 * from node:crypto; no argon2 dependency) rather than a bare digest.
 *
 * Be honest about what that buys: a 4-digit PIN is 10 000 candidates, so even
 * at ~50 ms per guess an offline attacker with the hash is through in minutes.
 * scrypt raises the cost of a stolen-database attack; the defence against
 * *online* guessing is rate limiting, which Task 36 adds. Neither is a
 * substitute for the other.
 */

/**
 * Stored as `scrypt$<N>$<r>$<p>$<salt>$<key>` (salt and key base64url).
 *
 * Self-describing on purpose: the parameters live in the row, so raising the
 * cost later re-hashes on next use instead of invalidating every existing PIN.
 */
const FORMAT = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** ~16 MiB and ~30 ms per hash. `maxmem` must clear 128 * N * r or scrypt throws. */
const PARAMS: Required<Pick<ScryptOptions, 'N' | 'r' | 'p'>> = { N: 16_384, r: 8, p: 1 };
const MAX_MEM = 64 * 1024 * 1024;

function derive(pin: string, salt: Buffer, keyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pin, salt, keyBytes, { ...PARAMS, maxmem: MAX_MEM }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(pin, salt, KEY_BYTES);
  return [
    FORMAT,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/**
 * Verifies a candidate PIN against a stored hash.
 *
 * `null`/unparseable stored value returns false rather than throwing: a roll
 * marked `privacy: 'pin'` with no `pin_hash` is a misconfiguration, and the
 * safe reading of a missing lock is "locked", not "open".
 */
export async function verifyPin(pin: string, stored: string | null): Promise<boolean> {
  if (stored === null) return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== FORMAT) return false;

  const [, rawN, rawR, rawP, rawSalt, rawKey] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
    return false;
  }

  const salt = Buffer.from(rawSalt, 'base64url');
  const expected = Buffer.from(rawKey, 'base64url');
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = await new Promise<Buffer | null>((resolve) => {
    scrypt(pin, salt, expected.length, { N, r, p, maxmem: MAX_MEM }, (err, derived) => {
      resolve(err ? null : derived);
    });
  });
  if (actual === null || actual.length !== expected.length) return false;

  return timingSafeEqual(actual, expected);
}
