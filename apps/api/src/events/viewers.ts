import type { Redis } from 'ioredis';

/**
 * How many guests are watching a roll right now — the host dashboard's "Guests"
 * number (03 §10).
 *
 * ## Why a sorted set and not a set with a TTL
 *
 * The obvious shape is a SET of connection ids plus `EXPIRE` on the key,
 * refreshed on every heartbeat, and `SCARD` to read it. It has one flaw, and it
 * is the flaw that matters: a TTL belongs to the *key*, not to its members. A
 * connection that dies without a FIN — a phone that walked out of range, which
 * at a party is most of them — leaves a member behind, and as long as any other
 * guest keeps refreshing the key's TTL, that ghost is counted forever. The
 * number would only ever drift upward, and a host watching "Guests: 40" at an
 * empty venue learns nothing.
 *
 * A sorted set scored by heartbeat timestamp gives each member its own expiry.
 * Reads prune anything older than `VIEWER_STALE_MS` first, so the count is
 * "connections that said something recently" — which is the only definition
 * that survives a network that drops connections without telling anyone. The
 * key still carries a TTL so an abandoned roll's key disappears on its own.
 *
 * Accuracy is bounded by the heartbeat: a guest who leaves cleanly is removed
 * at once, and one who vanishes is counted for up to `VIEWER_STALE_MS` longer.
 * That is the honest resolution of the underlying signal, and the dashboard
 * says "Guests", not "Guests, exactly, this instant".
 */

/** A viewer not heard from for this long is gone. Two missed 25 s heartbeats. */
export const VIEWER_STALE_MS = 60_000;

export function rollViewersKey(rollId: string): string {
  return `roll:${rollId}:viewers`;
}

/**
 * Records a viewer as present, or refreshes one that already is. Called on
 * connect and on every heartbeat.
 */
export async function touchRollViewer(
  redis: Redis,
  rollId: string,
  connectionId: string,
): Promise<void> {
  const key = rollViewersKey(rollId);
  await redis.zadd(key, Date.now(), connectionId);
  // Belt to the per-member scores' braces: this is what makes the *key* go
  // away once the last guest has gone, so a roll nobody watches costs nothing.
  await redis.pexpire(key, VIEWER_STALE_MS);
}

/** Removes a viewer that disconnected cleanly. */
export async function dropRollViewer(
  redis: Redis,
  rollId: string,
  connectionId: string,
): Promise<void> {
  await redis.zrem(rollViewersKey(rollId), connectionId);
}

/**
 * Live viewers on a roll, pruning the ones that stopped answering.
 *
 * The prune happens on read rather than on a timer: there is no sweeper process
 * in V1, and a count that cleans up exactly when somebody looks at it needs no
 * scheduling to stay honest.
 */
export async function countRollViewers(redis: Redis, rollId: string): Promise<number> {
  const key = rollViewersKey(rollId);
  await redis.zremrangebyscore(key, '-inf', Date.now() - VIEWER_STALE_MS);
  return redis.zcard(key);
}
