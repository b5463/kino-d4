// A transport moves raw bytes. It knows nothing about frames or commands —
// that separation is what lets the mock device and real hardware share the
// entire protocol stack above this line.

export type TransportKind = 'serial' | 'mock' | 'twin';

export interface Transport {
  readonly kind: TransportKind;
  open(): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  onData(cb: (data: Uint8Array) => void): void;
  onClose(cb: (reason?: string) => void): void;
}
