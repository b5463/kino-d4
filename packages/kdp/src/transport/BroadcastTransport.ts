import type { Transport } from './Transport';

// KINO Twin §10 option 2: a Twin running in one same-origin tab can serve its
// device over a BroadcastChannel to Studio running in another tab, with no
// server in between. The channel still only ever carries raw KDP frames —
// never a JSON side-channel that reinterprets protocol behavior (§10/§20) —
// so everything above this transport (KinoProtocolClient, KinoDevice) works
// unmodified against it, exactly as it does against SerialTransport/MockTransport.
export const TWIN_CHANNEL = 'kino-twin-kdp-v1';

type WireMsg =
  | { t: 'probe' }
  | { t: 'present' }
  | { t: 'connect'; client: string }
  | { t: 'accept'; client: string }
  | { t: 'busy'; client: string; reason: 'booting' | 'connected' }
  | { t: 'ping'; client: string }
  | { t: 'pong'; client: string }
  | { t: 'data'; from: 'host' | 'device'; client: string; bytes: number[] }
  | { t: 'close'; client: string; reason?: string };

/**
 * Silence past this long after posting `connect` means nobody answered —
 * either there is no Twin on this channel, or it never got back to us. Fixed
 * rather than a constructor option: the brief's contract is exactly "2 s
 * silence", the same kind of hard number HELLO's own retry timing uses.
 */
const OPEN_TIMEOUT_MS = 2000;
/** Default window {@link BroadcastTransport.probe} waits for a `present` reply. */
const PROBE_TIMEOUT_MS = 300;

function randomClientId(): string {
  // A per-attempt id, not a per-tab one: two BroadcastTransport instances
  // (a reconnect, or two Studio tabs) must never be mistaken for each other
  // by the Twin, which is what the `client` field on every message exists to
  // prevent. crypto.randomUUID is available in every runtime this ships to;
  // the fallback only matters for a hypothetical host that lacks it.
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function toBytes(nums: number[]): Uint8Array {
  return Uint8Array.from(nums);
}

function toNums(bytes: Uint8Array): number[] {
  // structuredClone (what postMessage uses under the hood) keeps a plain
  // number[] intact across the channel; a Uint8Array is the thing this
  // convert-at-the-edges rule exists to avoid sending directly (§10 note).
  return Array.from(bytes);
}

/**
 * Studio-side byte transport to a KINO Twin over a same-origin BroadcastChannel
 * (04 §10 option 2). One instance is one connection attempt: `open()` posts a
 * fresh random client id, so a busy Twin, a stale reconnect, and a second
 * Studio tab can never be confused for one another.
 */
export class BroadcastTransport implements Transport {
  readonly kind = 'twin' as const;

  private readonly channelName: string;
  private channel: BroadcastChannel | null = null;
  private client: string | null = null;
  private opened = false;
  private dataCb: ((data: Uint8Array) => void) | null = null;
  private closeCb: ((reason?: string) => void) | null = null;

  constructor(channelName?: string) {
    this.channelName = channelName ?? TWIN_CHANNEL;
  }

  /** True if a TwinDeviceServer answered `probe` with `present` within `timeoutMs`. */
  static probe(channelName?: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
    return new Promise((resolve) => {
      const channel = new BroadcastChannel(channelName ?? TWIN_CHANNEL);
      let settled = false;
      const timer = setTimeout(() => finish(false), timeoutMs);
      function finish(present: boolean) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.removeEventListener('message', onMessage);
        channel.close();
        resolve(present);
      }
      function onMessage(ev: MessageEvent) {
        const msg = ev.data as WireMsg;
        if (msg && msg.t === 'present') finish(true);
      }
      channel.addEventListener('message', onMessage);
      channel.postMessage({ t: 'probe' } satisfies WireMsg);
    });
  }

  async open(): Promise<void> {
    if (this.channel) throw new Error('BroadcastTransport is already open');
    const client = randomClientId();
    const channel = new BroadcastChannel(this.channelName);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        channel.removeEventListener('message', onHandshake);
        channel.close();
        reject(new Error('No KINO Twin answered on this channel'));
      }, OPEN_TIMEOUT_MS);

      const onHandshake = (ev: MessageEvent) => {
        const msg = ev.data as WireMsg;
        // `.t` is checked first so TS narrows away the client-less
        // 'probe'/'present' members before `.client` is ever read.
        if (!msg || (msg.t !== 'accept' && msg.t !== 'busy') || msg.client !== client) return;
        settled = true;
        clearTimeout(timer);
        channel.removeEventListener('message', onHandshake);
        if (msg.t === 'busy') {
          channel.close();
          reject(
            new Error(
              msg.reason === 'booting'
                ? 'KINO Twin is still booting'
                : 'KINO Twin is already connected to another Studio tab',
            ),
          );
          return;
        }
        this.channel = channel;
        this.client = client;
        this.opened = true;
        // Registered only now — synchronously, inside this same handshake
        // handler — so it is in place before the event loop can dispatch any
        // `data`/`close` message the Twin queued right behind its `accept`.
        channel.addEventListener('message', this.handleLive);
        resolve();
      };
      channel.addEventListener('message', onHandshake);
      channel.postMessage({ t: 'connect', client } satisfies WireMsg);
    });
  }

  private readonly handleLive = (ev: MessageEvent): void => {
    const msg = ev.data as WireMsg;
    if (msg?.t === 'ping' && msg.client === this.client) {
      this.channel?.postMessage({ t: 'pong', client: msg.client } satisfies WireMsg);
      return;
    }
    // Same narrow-`.t`-before-reading-`.client` order as onHandshake above.
    if (!msg || (msg.t !== 'data' && msg.t !== 'close') || msg.client !== this.client) return;
    if (msg.t === 'data') {
      if (msg.from === 'device') this.dataCb?.(toBytes(msg.bytes));
      return;
    }
    if (msg.t === 'close') {
      if (!this.opened) return;
      this.opened = false;
      this.closeCb?.(msg.reason);
    }
  };

  async write(data: Uint8Array): Promise<void> {
    if (!this.opened || !this.channel || !this.client) throw new Error('KINO Twin is not connected');
    this.channel.postMessage({
      t: 'data',
      from: 'host',
      client: this.client,
      bytes: toNums(data),
    } satisfies WireMsg);
  }

  async close(): Promise<void> {
    if (!this.opened || !this.channel || !this.client) return;
    this.opened = false;
    this.channel.postMessage({ t: 'close', client: this.client } satisfies WireMsg);
    this.channel.removeEventListener('message', this.handleLive);
    this.channel.close();
    this.channel = null;
    this.client = null;
    // Same "we asked, so tell the caller it's done" close-with-no-reason
    // MockTransport fires from its own close() — reboot parity (a reason) is
    // reserved for the Twin-initiated close the `handleLive` branch above handles.
    this.closeCb?.();
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCb = cb;
  }
}
