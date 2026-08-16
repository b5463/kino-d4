import { STREAM_START, compareStreamIds, type RollEventDelivery } from './publish';
import type { RollEventBus } from './bus';

/**
 * One guest's view of a roll's events: the replay and the live stream, joined
 * without a seam.
 *
 * ## The gap, and which way it is closed
 *
 * There are two orderings available, and both have a window:
 *
 *   snapshot then subscribe — an event published in between is **lost**. No
 *     later mechanism recovers it; the client never learns it existed, because
 *     its `Last-Event-ID` has already moved past it.
 *
 *   subscribe then snapshot — an event published in between arrives **twice**,
 *     once live and once in the snapshot.
 *
 * This takes the second, because a duplicate is detectable and a loss is not.
 * The detector is `watermark`: stream ids only ever increase, so an event whose
 * id is not greater than the last one delivered has already been delivered.
 * That single rule covers the snapshot/live overlap, the `Last-Event-ID` the
 * client arrived with, and any ordering the two sources arrive in.
 *
 * Buffering while the snapshot is read is about *order*, not loss: without it a
 * live event would be written to the client ahead of the older history it
 * belongs after, and a client that renders in arrival order would show the roll
 * briefly out of sequence. The buffer is drained in the same synchronous turn
 * that clears `replaying`, so no event can slip past between the two.
 *
 * `readHistory` is a parameter rather than something this reaches for itself:
 * the feed's whole job is joining two collaborators, and taking both of them as
 * inputs is what makes the window between them addressable — `sse.test.ts`
 * publishes an event from inside `readHistory` and asserts it is delivered
 * exactly once, which is a test of the actual race rather than of a sleep.
 */
export interface RollEventFeedOptions {
  bus: RollEventBus;
  rollId: string;
  /** The last event the client already has, or null for a fresh connection. */
  lastEventId: string | null;
  readHistory: (afterId: string) => Promise<RollEventDelivery[]>;
  deliver: (delivery: RollEventDelivery) => void;
}

/**
 * Starts the feed and returns its close function. Resolves once the client is
 * caught up and live; every event after that arrives through `deliver`.
 */
export async function openRollEventFeed(
  options: RollEventFeedOptions,
): Promise<() => Promise<void>> {
  const { bus, rollId, lastEventId, readHistory, deliver } = options;

  let replaying = true;
  const buffered: RollEventDelivery[] = [];
  /**
   * The highest id delivered so far. It starts at the client's `Last-Event-ID`
   * so a live event older than the client's own position — possible on a
   * reconnect that overlaps a slow publish — is dropped rather than shown
   * twice.
   */
  let watermark = lastEventId ?? STREAM_START;

  const emit = (delivery: RollEventDelivery): void => {
    if (compareStreamIds(delivery.id, watermark) <= 0) return;
    watermark = delivery.id;
    deliver(delivery);
  };

  const release = await bus.subscribe(rollId, (delivery) => {
    if (replaying) buffered.push(delivery);
    else emit(delivery);
  });

  try {
    // A fresh connection gets no history at all. The PWA has just loaded the
    // roll over HTTP, so replaying up to 500 old events would tell it only
    // things it already knows — and 03 §7's contract is "new captures appear",
    // not "the roll is delivered twice".
    if (lastEventId !== null) {
      for (const entry of await readHistory(lastEventId)) emit(entry);
    }
  } catch (err) {
    await release();
    throw err;
  }

  // No `await` between these two lines, deliberately: the listener above runs
  // synchronously from ioredis's message event, so nothing can arrive between
  // clearing the flag and draining what the flag collected.
  replaying = false;
  for (const entry of buffered.splice(0)) emit(entry);

  return release;
}
