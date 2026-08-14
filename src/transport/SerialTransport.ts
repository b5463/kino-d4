import type { Transport } from './Transport';

export const KINO_SERIAL_OPTIONS: SerialOptions = {
  baudRate: 921600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  bufferSize: 65536,
};

export function webSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/**
 * Web Serial byte transport. The port itself is chosen by the user through
 * navigator.serial.requestPort() — this class never picks a port on its own.
 */
export class SerialTransport implements Transport {
  readonly kind = 'serial' as const;

  private readonly port: SerialPort;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private dataCb: ((data: Uint8Array) => void) | null = null;
  private closeCb: ((reason?: string) => void) | null = null;
  private closing = false;

  constructor(port: SerialPort) {
    this.port = port;
  }

  async open(): Promise<void> {
    await this.port.open(KINO_SERIAL_OPTIONS);
    if (!this.port.readable || !this.port.writable) {
      throw new Error('Serial port opened but streams are unavailable');
    }
    this.writer = this.port.writable.getWriter();
    void this.readLoop();
  }

  private async readLoop() {
    while (this.port.readable && !this.closing) {
      this.reader = this.port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length > 0) this.dataCb?.(value);
        }
      } catch {
        // Fatal stream error (USB unplugged) — fall through to close.
        break;
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
    }
    if (!this.closing) {
      this.closing = true;
      try {
        this.writer?.releaseLock();
        await this.port.close();
      } catch {
        // Port may already be gone.
      }
      this.closeCb?.('Serial connection lost');
    }
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error('Serial port is not open');
    await this.writer.write(data);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      // Reader may already be released.
    }
    try {
      this.writer?.releaseLock();
    } catch {
      // Already released.
    }
    this.writer = null;
    try {
      await this.port.close();
    } catch {
      // Already closed.
    }
    this.closeCb?.();
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCb = cb;
  }
}
