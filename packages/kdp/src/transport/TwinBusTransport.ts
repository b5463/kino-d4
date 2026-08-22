import type { Transport } from './Transport';
import type { TwinWireBus, TwinWireMsg } from './twinWire';

/**
 * Silence past this long after posting `connect` means nobody answered —
 * either there is no Twin on this bus, or it never got back to us. Fixed
 * rather than a constructor option: the brief's contract is exactly "2 s
 * silence", the same kind of hard number HELLO's own retry timing uses.
 */
const OPEN_TIMEOUT_MS = 2000;
/** Default window {@link probeTwinBus} waits for a `present` reply. */
export const TWIN_PROBE_TIMEOUT_MS = 300;

function randomClientId(): string {
  // A per-attempt id, not a per-tab one: two transport instances (a
  // reconnect, or two Studio tabs) must never be mistaken for each other by
  // the Twin, which is what the `client` field on every message prevents.
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** True if a TwinDeviceServer answered `probe` with `present` in time. */
export async function probeTwinBus(
  busFactory: () => Promise<TwinWireBus>,
  timeoutMs = TWIN_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  let bus: TwinWireBus;
  try {
    bus = await busFactory();
  } catch {
    // No carrier (relay not running) is the same answer as no Twin.
    return false;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (present: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      unDown();
      bus.close();
      resolve(present);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const unsubscribe = bus.subscribe((msg) => {
      if (msg && msg.t === 'present') finish(true);
    });
    const unDown = bus.onDown(() => finish(false));
    bus.post({ t: 'probe' });
  });
}

/**
 * The Twin connection state machine over any {@link TwinWireBus} carrier
 * (04 §10). One instance is one connection attempt: `open()` posts a fresh
 * random client id, so a busy Twin, a stale reconnect, and a second Studio
 * tab can never be confused for one another. BroadcastChannel and WebSocket
 * carriers share this class, so their handshake/busy/close semantics cannot
 * drift (issue #29).
 */
export class TwinBusTransport implements Transport {
  readonly kind = 'twin' as const;

  private readonly busFactory: () => Promise<TwinWireBus>;
  private bus: TwinWireBus | null = null;
  private client: string | null = null;
  private opened = false;
  private unsubscribeLive: (() => void) | null = null;
  private unsubscribeDown: (() => void) | null = null;
  private dataCb: ((data: Uint8Array) => void) | null = null;
  private closeCb: ((reason?: string) => void) | null = null;

  constructor(busFactory: () => Promise<TwinWireBus>) {
    this.busFactory = busFactory;
  }

  async open(): Promise<void> {
    if (this.bus) throw new Error('Twin transport is already open');
    const client = randomClientId();
    const bus = await this.busFactory();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        unDown();
        bus.close();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('No KINO Twin answered on this channel')), OPEN_TIMEOUT_MS);
      const unDown = bus.onDown((reason) => fail(new Error(reason)));

      const unsubscribe = bus.subscribe((msg) => {
        // `.t` is checked first so TS narrows away the client-less
        // 'probe'/'present' members before `.client` is ever read.
        if (!msg || (msg.t !== 'accept' && msg.t !== 'busy') || msg.client !== client) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        if (msg.t === 'busy') {
          unDown();
          bus.close();
          reject(
            new Error(
              msg.reason === 'booting'
                ? 'KINO Twin is still booting'
                : 'KINO Twin is already connected to another Studio tab',
            ),
          );
          return;
        }
        this.bus = bus;
        this.client = client;
        this.opened = true;
        // Registered only now — synchronously, inside this same handshake
        // handler — so it is in place before the event loop can dispatch any
        // `data`/`close` message the Twin queued right behind its `accept`.
        this.unsubscribeLive = bus.subscribe(this.handleLive);
        unDown();
        this.unsubscribeDown = bus.onDown((reason) => {
          if (!this.opened) return;
          this.opened = false;
          this.closeCb?.(reason);
        });
        resolve();
      });
      bus.post({ t: 'connect', client });
    });
  }

  private readonly handleLive = (msg: TwinWireMsg): void => {
    if (msg?.t === 'ping' && msg.client === this.client) {
      this.bus?.post({ t: 'pong', client: msg.client });
      return;
    }
    // Same narrow-`.t`-before-reading-`.client` order as the handshake above.
    if (!msg || (msg.t !== 'data' && msg.t !== 'close') || msg.client !== this.client) return;
    if (msg.t === 'data') {
      if (msg.from === 'device') this.dataCb?.(Uint8Array.from(msg.bytes));
      return;
    }
    if (msg.t === 'close') {
      if (!this.opened) return;
      this.opened = false;
      this.closeCb?.(msg.reason);
    }
  };

  async write(data: Uint8Array): Promise<void> {
    if (!this.opened || !this.bus || !this.client) throw new Error('KINO Twin is not connected');
    this.bus.post({ t: 'data', from: 'host', client: this.client, bytes: Array.from(data) });
  }

  async close(): Promise<void> {
    if (!this.opened || !this.bus || !this.client) return;
    this.opened = false;
    this.bus.post({ t: 'close', client: this.client });
    this.unsubscribeLive?.();
    this.unsubscribeDown?.();
    this.bus.close();
    this.bus = null;
    this.client = null;
    // Same "we asked, so tell the caller it's done" close-with-no-reason
    // MockTransport fires from its own close() — reboot parity (a reason) is
    // reserved for the Twin-initiated close handleLive handles.
    this.closeCb?.();
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCb = cb;
  }
}
