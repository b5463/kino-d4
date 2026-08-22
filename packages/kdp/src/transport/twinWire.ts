// The Twin wire vocabulary (04 §10): every carrier — BroadcastChannel across
// tabs, WebSocket across machines — moves exactly these JSON messages, so the
// handshake, busy and close semantics are carrier-independent by construction.
// `data` payloads are raw KDP frames as plain number arrays; nothing here ever
// reinterprets protocol behavior.
export type TwinWireMsg =
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
 * A message bus carrying {@link TwinWireMsg}: post reaches every OTHER
 * participant, never the sender — BroadcastChannel semantics, which the
 * WebSocket relay reproduces.
 */
export interface TwinWireBus {
  post(msg: TwinWireMsg): void;
  /** Subscribe to incoming messages; returns the unsubscribe. */
  subscribe(cb: (msg: TwinWireMsg) => void): () => void;
  close(): void;
  /**
   * Carrier death (a WebSocket dropping). Returns the unsubscribe. A
   * BroadcastChannel has no such failure mode and never fires it.
   */
  onDown(cb: (reason: string) => void): () => void;
}
