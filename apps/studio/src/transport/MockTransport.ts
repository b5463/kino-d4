import type { Transport } from './Transport';
import type { MockKinoDevice } from '../mock/MockKinoDevice';

/**
 * Byte transport wired to the in-browser demo device. Deliberately hostile
 * to lazy parsing: outbound device bytes are re-chunked at random split
 * points with tiny delays, so the frame decoder sees the same fragmented
 * stream a real USB CDC connection produces.
 */
export class MockTransport implements Transport {
  readonly kind = 'mock' as const;

  private readonly device: MockKinoDevice;
  private dataCb: ((data: Uint8Array) => void) | null = null;
  private closeCb: ((reason?: string) => void) | null = null;
  private opened = false;
  private queue: Uint8Array[] = [];
  private draining = false;

  constructor(device: MockKinoDevice) {
    this.device = device;
  }

  async open(): Promise<void> {
    const bootDelay = this.device.bootDelayMs();
    if (bootDelay > 0) {
      await new Promise((r) => setTimeout(r, bootDelay + 200));
    }
    await new Promise((r) => setTimeout(r, 120)); // port-open feel
    this.device.attach(
      (bytes) => this.enqueue(bytes),
      () => {
        if (!this.opened) return;
        this.opened = false;
        this.closeCb?.('KINO is rebooting');
      },
    );
    this.opened = true;
  }

  private enqueue(bytes: Uint8Array) {
    // Split into random fragments to exercise stream reassembly.
    let offset = 0;
    while (offset < bytes.length) {
      const n = Math.min(bytes.length - offset, 7 + Math.floor(Math.random() * 153));
      this.queue.push(bytes.subarray(offset, offset + n));
      offset += n;
    }
    if (!this.draining) void this.drain();
  }

  private async drain() {
    this.draining = true;
    while (this.queue.length > 0) {
      const chunk = this.queue.shift()!;
      if (Math.random() < 0.25) {
        await new Promise((r) => setTimeout(r, 1));
      }
      if (!this.opened) break;
      this.dataCb?.(chunk);
    }
    this.draining = false;
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.opened) throw new Error('Demo device is not connected');
    const copy = data.slice();
    setTimeout(() => this.device.receive(copy), 1);
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    this.device.detach();
    this.closeCb?.();
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCb = cb;
  }
}
