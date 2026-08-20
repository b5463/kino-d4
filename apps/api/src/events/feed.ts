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
 * The detector is `watermark`: stream ids only ever increase *in the stream*, so
 * an event whose id is not greater than the last one delivered was already in
 * the snapshot, or is older than the `Last-Event-ID` the client arrived with.
 *
 * ## Why the watermark is disarmed once the client is caught up
 *
 * It would be tempting to leave it armed for the life of the connection, as a
 * general-purpose duplicate filter. That inverts the principle above into the
 * failure it was chosen to avoid.
 *
 * `publishRollEvent` does XADD and then PUBLISH — two round trips, not one
 * atomic step. Two API instances publishing to the same roll can therefore hit
 * the channel in the opposite order to the one the stream assigned: instance A
 * gets the newer id but is slow to PUBLISH, and B's older id arrives second. A
 * permanently armed watermark would discard that older id **forever**, and
 * nothing recovers it — the guest's socket is healthy, so no reconnect and no
 * replay is coming. A tile simply never appears.
 *
 * So the gate is armed only while catching up (`gated`), which is the only
 * window where a genuine duplicate is possible — the snapshot and the live
 * channel overlapping. Afterwards live events pass through unconditionally:
 * pub/sub delivers once per listener, so the worst case of a reordered publish
 * is one event arriving out of order, and the PWA re-fetches on any event
 * (05 §10) rather than trusting arrival order to be the truth.
 *
 * Buffering while the snapshot is read is about *order*, not loss: without it a
 * live event would be written to the client ahead of the older history it
 * belongs after, and a client that renders in arrival order would show the roll
 * briefly out of sequence. The buffer is drained in the same synchronous turn
 * that clears `replaying` and disarms the gate, so no event can slip past
 * between the three.
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

  /** True while live events are collected instead of written out. */
  let replaying = true;
  /**
   * True while the watermark decides. It outlives `replaying` by exactly the
   * drain, and is then dropped for good — see the header: a permanent gate
   * turns a reordered cross-instance publish into silent loss.
   */
  let gated = true;
  const buffered: RollEventDelivery[] = [];
  /**
   * The highest id delivered so far while catching up. It starts at the
   * client's `Last-Event-ID`, which is what makes the replay exclusive of the
   * event the client already has.
   */
  let watermark = lastEventId ?? STREAM_START;

  const emit = (delivery: RollEventDelivery): void => {
    if (gated) {
      if (compareStreamIds(delivery.id, watermark) <= 0) return;
      watermark = delivery.id;
    }
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

  // No `await` anywhere in these three lines, deliberately: the listener above
  // runs synchronously from ioredis's message event, so nothing can arrive
  // between clearing the flag, draining what the flag collected, and disarming
  // the gate. The client is caught up at the end of this turn, and from here on
  // every live event is written out as it comes.
  replaying = false;
  for (const entry of buffered.splice(0)) emit(entry);
  gated = false;

  return release;
}
