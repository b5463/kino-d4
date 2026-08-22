import { probeTwinBus, TwinBusTransport, TWIN_PROBE_TIMEOUT_MS } from './TwinBusTransport';
import { channelBus } from './BroadcastTransport';
import type { TwinWireBus, TwinWireMsg } from './twinWire';

// KINO Twin over a WebSocket relay (issue #29): BroadcastChannel is
// same-origin only, so a Twin in another browser, container or machine is
// reached through `scripts/twin-ws-relay.mjs` — a dumb bus that forwards
// every message to every other socket, reproducing BroadcastChannel
// semantics. The wire vocabulary and the connection state machine are the
// same ones the BroadcastChannel carrier uses; only the carrier differs.

/** Default relay endpoint (`scripts/twin-ws-relay.mjs`, KINO_TWIN_WS_PORT). */
export const TWIN_WS_URL = 'ws://localhost:5179';

/** {@link TwinWireBus} over a WebSocket; resolves once the socket is open. */
export function socketBus(url: string = TWIN_WS_URL): Promise<TwinWireBus> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const subscribers = new Set<(msg: TwinWireMsg) => void>();
    const downs = new Set<(reason: string) => void>();
    let closedByUs = false;

    socket.addEventListener('open', () => resolve(bus));
    socket.addEventListener('error', () => {
      // Before open this rejects the factory; after open the paired 'close'
      // event carries the down notification.
      reject(new Error(`Could not reach the Twin bridge at ${url}`));
    });
    socket.addEventListener('close', () => {
      if (closedByUs) return;
      for (const cb of downs) cb('Twin bridge connection lost');
    });
    socket.addEventListener('message', (ev) => {
      let msg: TwinWireMsg;
      try {
        msg = JSON.parse(String(ev.data)) as TwinWireMsg;
      } catch {
        return; // not ours — the relay is a dumb pipe, tolerate strangers
      }
      for (const cb of subscribers) cb(msg);
    });

    const bus: TwinWireBus = {
      post: (msg) => socket.send(JSON.stringify(msg)),
      subscribe: (cb) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      close: () => {
        closedByUs = true;
        socket.close();
      },
      onDown: (cb) => {
        downs.add(cb);
        return () => downs.delete(cb);
      },
    };
  });
}

/**
 * Studio-side byte transport to a KINO Twin over a WebSocket relay. Same
 * HELLO/busy/close semantics as {@link BroadcastTransport} — both are the
 * shared {@link TwinBusTransport} over different carriers.
 */
export class WebSocketTransport extends TwinBusTransport {
  constructor(url?: string) {
    super(() => socketBus(url));
  }

  /** True if a TwinDeviceServer answered `probe` over the relay in time. */
  static probe(url?: string, timeoutMs = TWIN_PROBE_TIMEOUT_MS): Promise<boolean> {
    return probeTwinBus(() => socketBus(url), timeoutMs);
  }
}

/**
 * Twin-side carrier bridge: forwards every wire message between the local
 * BroadcastChannel (where TwinDeviceServer listens, unchanged) and the
 * WebSocket relay, both directions, verbatim. Transport-only by design —
 * the simulator never learns which carrier a Studio arrived on.
 */
export async function bridgeTwinChannel(options?: {
  url?: string;
  channelName?: string;
  onDown?: (reason: string) => void;
}): Promise<{ close: () => void }> {
  const channel = channelBus(options?.channelName);
  const socket = await socketBus(options?.url);
  const unChannel = channel.subscribe((msg) => socket.post(msg));
  const unSocket = socket.subscribe((msg) => channel.post(msg));
  const unDown = socket.onDown((reason) => {
    stop();
    options?.onDown?.(reason);
  });
  const stop = () => {
    unChannel();
    unSocket();
    unDown();
    channel.close();
    socket.close();
  };
  return { close: stop };
}
