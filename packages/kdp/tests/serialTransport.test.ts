// SerialTransport against a fake Web Serial port built on real Web Streams
// (issue #80): until now nothing tested the class Studio uses for physical
// hardware. The fake models the parts of the contract that matter — chunked
// reads, a stream that dies mid-session, and write backpressure.
import { describe, expect, it } from 'vitest';
import { KINO_SERIAL_OPTIONS, SerialTransport } from '../src/transport/SerialTransport';

class FakeSerialPort {
  openedWith: SerialOptions | null = null;
  closeCalls = 0;
  written: Uint8Array[] = [];
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  /** Resolvers for in-flight sink writes, so a test can hold one open. */
  private pendingWrites: Array<() => void> = [];
  private holdWrites = false;
  private control!: ReadableStreamDefaultController<Uint8Array>;

  async open(options: SerialOptions): Promise<void> {
    this.openedWith = options;
    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.control = c;
      },
    });
    this.writable = new WritableStream<Uint8Array>(
      {
        write: (chunk) => {
          this.written.push(chunk.slice());
          if (!this.holdWrites) return;
          return new Promise<void>((resolve) => this.pendingWrites.push(resolve));
        },
      },
      // highWaterMark 1: a held write makes `writer.ready` pend, which is
      // exactly the backpressure signal the transport must observe.
      new CountQueuingStrategy({ highWaterMark: 1 }),
    );
  }

  blockWrites() {
    this.holdWrites = true;
  }

  releaseWrite() {
    this.pendingWrites.shift()?.();
  }

  push(bytes: Uint8Array) {
    this.control.enqueue(bytes);
  }

  die(message: string) {
    this.control.error(new Error(message));
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.readable = null;
    this.writable = null;
  }
}

function asPort(fake: FakeSerialPort): SerialPort {
  return fake as unknown as SerialPort;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SerialTransport', () => {
  it('opens with the KINO parameters and delivers chunked reads', async () => {
    const fake = new FakeSerialPort();
    const t = new SerialTransport(asPort(fake));
    const seen: number[] = [];
    t.onData((d) => seen.push(...d));
    await t.open();

    expect(fake.openedWith?.baudRate).toBe(921600);
    expect(KINO_SERIAL_OPTIONS.dataBits).toBe(8);

    fake.push(new Uint8Array([1, 2]));
    fake.push(new Uint8Array([3]));
    await tick();
    expect(seen).toEqual([1, 2, 3]);
    await t.close();
  });

  it('refuses to write before open', async () => {
    const t = new SerialTransport(asPort(new FakeSerialPort()));
    await expect(t.write(new Uint8Array([1]))).rejects.toThrow(/not open/);
  });

  it('writes frames in order and waits for backpressure', async () => {
    const fake = new FakeSerialPort();
    const t = new SerialTransport(asPort(fake));
    await t.open();

    fake.blockWrites();
    let firstDone = false;
    let secondDone = false;
    const first = t.write(new Uint8Array([0xaa])).then(() => {
      firstDone = true;
    });
    const second = t.write(new Uint8Array([0xbb])).then(() => {
      secondDone = true;
    });
    await tick();
    // The sink is holding write #1: with `writer.ready` observed, write #2
    // must not report success while the port is still busy.
    expect(secondDone).toBe(false);

    fake.releaseWrite();
    await first;
    fake.releaseWrite();
    await second;
    expect(firstDone && secondDone).toBe(true);
    expect(fake.written.map((w) => w[0])).toEqual([0xaa, 0xbb]);
    await t.close();
  });

  it('a dying stream surfaces as a close with a reason', async () => {
    const fake = new FakeSerialPort();
    const t = new SerialTransport(asPort(fake));
    const reasons: Array<string | undefined> = [];
    t.onClose((reason) => reasons.push(reason));
    await t.open();

    fake.die('device unplugged');
    await tick();
    expect(reasons).toEqual(['Serial connection lost']);
    expect(fake.closeCalls).toBe(1);
  });

  it('close is idempotent and fires onClose once', async () => {
    const fake = new FakeSerialPort();
    const t = new SerialTransport(asPort(fake));
    let closes = 0;
    t.onClose(() => closes++);
    await t.open();
    await t.close();
    await t.close();
    await tick();
    expect(closes).toBe(1);
  });
});
