import { probeTwinBus, TwinBusTransport, TWIN_PROBE_TIMEOUT_MS } from './TwinBusTransport';
import type { TwinWireBus, TwinWireMsg } from './twinWire';

// KINO Twin §10 option 2: a Twin running in one same-origin tab can serve its
// device over a BroadcastChannel to Studio running in another tab, with no
// server in between. The channel still only ever carries raw KDP frames —
// never a JSON side-channel that reinterprets protocol behavior (§10/§20) —
// so everything above this transport (KinoProtocolClient, KinoDevice) works
// unmodified against it, exactly as it does against SerialTransport/MockTransport.
export const TWIN_CHANNEL = 'kino-twin-kdp-v1';

/** {@link TwinWireBus} over a same-origin BroadcastChannel. */
export function channelBus(channelName: string = TWIN_CHANNEL): TwinWireBus {
  const channel = new BroadcastChannel(channelName);
  const listeners = new Map<(msg: TwinWireMsg) => void, (ev: MessageEvent) => void>();
  return {
    post: (msg) => channel.postMessage(msg),
    subscribe: (cb) => {
      const handler = (ev: MessageEvent) => cb(ev.data as TwinWireMsg);
      listeners.set(cb, handler);
      channel.addEventListener('message', handler);
      return () => {
        const registered = listeners.get(cb);
        if (registered) channel.removeEventListener('message', registered);
        listeners.delete(cb);
      };
    },
    close: () => channel.close(),
    // A BroadcastChannel cannot drop; carrier death is a WebSocket concept.
    onDown: () => () => {},
  };
}

/**
 * Studio-side byte transport to a KINO Twin over a same-origin BroadcastChannel
 * (04 §10 option 2). The connection state machine lives in
 * {@link TwinBusTransport}, shared with the WebSocket carrier (issue #29), so
 * the two cannot drift in handshake, busy, or close semantics.
 */
export class BroadcastTransport extends TwinBusTransport {
  constructor(channelName?: string) {
    super(async () => channelBus(channelName));
  }

  /** True if a TwinDeviceServer answered `probe` with `present` within `timeoutMs`. */
  static probe(channelName?: string, timeoutMs = TWIN_PROBE_TIMEOUT_MS): Promise<boolean> {
    return probeTwinBus(async () => channelBus(channelName), timeoutMs);
  }
}
