import type { Redis } from 'ioredis';

/**
 * Roll events — the publish half of the 05 §10 real-time flow.
 *
 * ## This file is a deliberate stub
 *
 * Task 19 owns the SSE endpoint and replaces the body of `publishRollEvent`
 * with `XADD roll:<id>:stream MAXLEN ~ 500` plus the `PUBLISH` below, so that a
 * reconnecting guest can replay from `Last-Event-ID`. What is here now is the
 * *contract* — the event union and the channel name — plus the one-line publish,
 * so Task 18's routes call the real function at the real moments and Task 19
 * changes an implementation rather than hunting for call sites.
 *
 * The event union is Task 19's shape verbatim, and it carries **ids only**: the
 * PWA re-fetches the capture (05 §10). That keeps an event from becoming a
 * second, staler copy of the capture document.
 */
export type RollEvent =
  | { type: 'roll.opened' | 'roll.closed' }
  | {
      type: 'capture.created' | 'capture.updated' | 'capture.hidden' | 'capture.deleted';
      captureId: string;
    }
  | { type: 'processing.completed'; captureId: string; role: string };

/** The pub/sub channel a roll's live subscribers listen on. */
export function rollEventChannel(rollId: string): string {
  return `roll:${rollId}:events`;
}

/**
 * Announces one event to a roll's subscribers.
 *
 * Errors propagate. That is on purpose even though no caller in Task 18 lets a
 * publish failure fail a request: swallowing here would make the failure
 * invisible to Task 19 too, and *where* to tolerate a dead event bus is a
 * decision for the caller, which knows whether the write it just made is
 * already durable. The upload routes catch and log; a future caller that must
 * not lose an event can choose differently.
 */
export async function publishRollEvent(
  redis: Redis,
  rollId: string,
  event: RollEvent,
): Promise<void> {
  await redis.publish(rollEventChannel(rollId), JSON.stringify(event));
}
