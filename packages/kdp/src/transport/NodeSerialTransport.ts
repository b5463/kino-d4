// KDP byte transport over a Node serial port, so the protocol stack can run
// from a terminal instead of a browser.
//
// This file deliberately does NOT import `serialport`. That package is a
// native Node addon; a single import here would put it on the import graph of
// `packages/kdp/src/index.ts`, which Studio and roll-web bundle with Vite, and
// the browser build would break. Instead the transport takes an already-
// constructed port object that satisfies `NodeSerialPortLike` — the same
// arrangement as `SerialTransport`, which takes a `SerialPort` the browser
// handed out rather than reaching for `navigator.serial` itself. The caller
// (scripts/kino-conformance.mjs) owns the one `import { SerialPort }`.
//
// The type surface below is structural and intentionally loose on `on()`: a
// real `SerialPort` (a Duplex stream) satisfies it without any cast at the
// call site, and a test fake satisfies it with a dozen lines.

import type { Transport } from './Transport';

type ErrCb = (err?: Error | null) => void;

/** The part of a Node `SerialPort` this transport uses. */
export interface NodeSerialPortLike {
  readonly isOpen: boolean;
  open(cb: ErrCb): void;
  close(cb: ErrCb): void;
  write(data: Uint8Array, cb?: ErrCb): boolean;
  /* `any[]` on purpose, and checked: a real SerialPort is a Duplex stream
   * whose `on` overloads are typed `(...args: any[])`, and anything narrower
   * here (`never[]`, `unknown[]`) makes the port unassignable, forcing a cast
   * at every call site — which is where a genuine mismatch would then hide. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * Node serial byte transport. Reports `kind: 'serial'` because it is the same
 * wire as Web Serial — code above this line must not be able to tell a bench
 * run from a Studio session, or a bench run proves nothing about Studio.
 */
export class NodeSerialTransport implements Transport {
  readonly kind = 'serial' as const;

  private readonly port: NodeSerialPortLike;
  private dataCb: ((data: Uint8Array) => void) | null = null;
  private closeCb: ((reason?: string) => void) | null = null;
  /** Set the moment close is decided, by us or by the port dying. */
  private closing = false;
  /** `closeCb` fires exactly once, whatever order the events arrive in. */
  private closeReported = false;
  private opened = false;

  private readonly onChunk = (chunk: Uint8Array) => {
    if (this.closing || !chunk || chunk.length === 0) return;
    // A Node stream chunk is a Buffer, which is already a Uint8Array. A view
    // rather than a copy is safe because the decoder above copies into its own
    // accumulator synchronously; `.buffer` alone would hand over the whole
    // pooled slab, which is why the offset and length are spelled out.
    const bytes =
      chunk instanceof Uint8Array
        ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : new Uint8Array(chunk);
    this.dataCb?.(bytes);
  };

  private readonly onPortClose = (err?: Error | null) => {
    this.report(err ? `Serial connection lost: ${err.message}` : 'Serial connection lost');
  };

  private readonly onPortError = (err: Error) => {
    this.report(`Serial error: ${err.message}`);
  };

  constructor(port: NodeSerialPortLike) {
    this.port = port;
  }

  async open(): Promise<void> {
    if (this.closing) throw new Error('Transport already closed');
    // Listeners go on before the port opens so the first bytes after open —
    // an ESP32's ROM boot chatter, or a reply to a HELLO already in the
    // firmware's queue — cannot land in the gap.
    this.port.on('data', this.onChunk);
    this.port.on('close', this.onPortClose);
    this.port.on('error', this.onPortError);
    try {
      if (!this.port.isOpen) {
        await new Promise<void>((resolve, reject) => {
          this.port.open((err) => (err ? reject(err) : resolve()));
        });
      }
    } catch (err) {
      this.detach();
      throw err;
    }
    this.opened = true;
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.closing) throw new Error('Serial port is closed');
    if (!this.opened) throw new Error('Serial port is not open');
    // Resolving on the write callback rather than on the return value means a
    // slow port slows the caller instead of growing a queue the request
    // timeouts know nothing about — the same backpressure discipline
    // SerialTransport gets from `writer.ready`.
    await new Promise<void>((resolve, reject) => {
      this.port.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    // Detached first: the port's own 'close' event must not race this one and
    // report a lost connection for a close we asked for.
    this.detach();
    if (this.opened) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.port.close((err) => (err ? reject(err) : resolve()));
        });
      } catch {
        // Port already gone (unplugged mid-run) — nothing left to release.
      }
    }
    this.opened = false;
    this.fire(undefined);
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCb = cb;
  }

  private detach() {
    this.port.removeListener('data', this.onChunk);
    this.port.removeListener('close', this.onPortClose);
    this.port.removeListener('error', this.onPortError);
  }

  /** An unasked-for close: tear down, then say why once. */
  private report(reason: string) {
    if (this.closing) return;
    this.closing = true;
    this.detach();
    this.opened = false;
    this.fire(reason);
  }

  private fire(reason?: string) {
    if (this.closeReported) return;
    this.closeReported = true;
    this.closeCb?.(reason);
  }
}
