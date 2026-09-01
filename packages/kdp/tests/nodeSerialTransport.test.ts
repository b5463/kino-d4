// NodeSerialTransport against a fake Node serial port (issue #155). The fake
// models the three things the conformance runner depends on: bytes arrive as
// Uint8Array, a port that dies says so exactly once, and a closed transport
// refuses writes instead of resolving into a void.
import { describe, expect, it, vi } from 'vitest';
import { NodeSerialTransport } from '../src/transport/NodeSerialTransport';
import type { NodeSerialPortLike } from '../src/transport/NodeSerialTransport';

type Listener = (...args: unknown[]) => void;

class FakeNodePort implements NodeSerialPortLike {
  isOpen = false;
  openCalls = 0;
  closeCalls = 0;
  written: Uint8Array[] = [];
  /** Set to fail the next open(), the way a busy COM port does. */
  openError: Error | null = null;
  /** Set to fail writes, the way a yanked cable does. */
  writeError: Error | null = null;
  private listeners = new Map<string, Set<Listener>>();

  open(cb: (err?: Error | null) => void): void {
    this.openCalls++;
    if (this.openError) {
      cb(this.openError);
      return;
    }
    this.isOpen = true;
    cb(null);
  }

  close(cb: (err?: Error | null) => void): void {
    this.closeCalls++;
    this.isOpen = false;
    cb(null);
    // A real port emits 'close' after close() completes. The transport must
    // have stopped listening by then, or a deliberate close would be reported
    // as a lost connection.
    this.emit('close');
  }

  write(data: Uint8Array, cb?: (err?: Error | null) => void): boolean {
    if (this.writeError) {
      cb?.(this.writeError);
      return false;
    }
    this.written.push(data.slice());
    cb?.(null);
    return true;
  }

  on(event: string, listener: (...args: never[]) => void): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener);
    return this;
  }

  removeListener(event: string, listener: (...args: never[]) => void): this {
    this.listeners.get(event)?.delete(listener as Listener);
    return this;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(...args);
  }

  /** Bytes from the device, as a Node stream would deliver them: a Buffer. */
  push(bytes: number[]): void {
    this.emit('data', Buffer.from(bytes));
  }
}

describe('NodeSerialTransport', () => {
  it('opens the port and forwards data as Uint8Array', async () => {
    const fake = new FakeNodePort();
    const t = new NodeSerialTransport(fake);
    const seen: Uint8Array[] = [];
    t.onData((d) => seen.push(d));

    await t.open();
    expect(fake.openCalls).toBe(1);
    expect(t.kind).toBe('serial');

    fake.push([1, 2, 3]);
    fake.push([4]);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeInstanceOf(Uint8Array);
    expect([...seen[0]]).toEqual([1, 2, 3]);
    expect([...seen[1]]).toEqual([4]);
  });

  it('carries the pooled Buffer offset, not the whole slab', async () => {
    const fake = new FakeNodePort();
    const t = new NodeSerialTransport(fake);
    let got: Uint8Array | null = null;
    t.onData((d) => {
      got = d;
    });
    await t.open();

    // What a Node stream hands over: a view into a larger pooled allocation.
    const slab = Buffer.from([0xff, 0xff, 7, 8, 0xff]);
    fake.emit('data', slab.subarray(2, 4));

    expect(got).not.toBeNull();
    expect([...got!]).toEqual([7, 8]);
  });

  it('does not open a port that is already open', async () => {
    const fake = new FakeNodePort();
    fake.isOpen = true;
    const t = new NodeSerialTransport(fake);
    await t.open();
    expect(fake.openCalls).toBe(0);
  });

  it('rejects and detaches when the port will not open', async () => {
    const fake = new FakeNodePort();
    fake.openError = new Error('Access denied');
    const t = new NodeSerialTransport(fake);
    await expect(t.open()).rejects.toThrow('Access denied');
    // No listener may survive a failed open, or a later event from this port
    // would be reported against a transport nobody is holding.
    expect(fake.listenerCount('data')).toBe(0);
    expect(fake.listenerCount('close')).toBe(0);
    expect(fake.listenerCount('error')).toBe(0);
  });

  it('reports a lost port once, with the reason', async () => {
    const fake = new FakeNodePort();
    const t = new NodeSerialTransport(fake);
    const onClose = vi.fn();
    t.onClose(onClose);
    await t.open();

    fake.emit('error', new Error('device disconnected'));
    // A dying port usually emits both; that is still one closed transport.
    fake.emit('close');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.calls[0][0]).toContain('device disconnected');
  });

  it('reports a plain port close with a reason and no error text', async () => {
    const fake = new FakeNodePort();
    const t = new NodeSerialTransport(fake);
    const onClose = vi.fn();
    t.onClose(onClose);
    await t.open();

    fake.emit('close');

    expect(onClose).toHaveBeenCalledExactlyOnceWith('Serial connection lost');
  });

  it('closes deliberately with no reason, once, and releases the listeners', async () => {
    const fake = new FakeNodePort();
    const t = new NodeSerialTransport(fake);
    const onClose = vi.fn();
    t.onClose(onClose);
    await t.open();

    await t.close();
    await t.close();

    expect(fake.closeCalls).toBe(1);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(fake.listenerCount('data')).toBe(0);
    expect(fake.listenerCount('close')).toBe(0);
    expect(fake.listenerCount('error')).toBe(0);
  });

  it('refuses a write after close instead of resolving', async () => {
    const fake = new FakeNodePort();
    const t = new NodeSerialTransport(fake);
    await t.open();
    await t.write(new Uint8Array([9]));
    expect(fake.written).toHaveLength(1);

    await t.close();

    await expect(t.write(new Uint8Array([10]))).rejects.toThrow('closed');
    expect(fake.written).toHaveLength(1);
  });

  it('refuses a write after the port died on its own', async () => {
    const fake = new FakeNodePort();
    const t = new NodeSerialTransport(fake);
    await t.open();
    fake.emit('close');
    await expect(t.write(new Uint8Array([1]))).rejects.toThrow('closed');
    expect(fake.written).toHaveLength(0);
  });

  it('refuses a write before open', async () => {
    const fake = new FakeNodePort();
    const t = new NodeSerialTransport(fake);
    await expect(t.write(new Uint8Array([1]))).rejects.toThrow('not open');
  });

  it('drops data delivered after close', async () => {
    const fake = new FakeNodePort();
    const t = new NodeSerialTransport(fake);
    const seen: Uint8Array[] = [];
    t.onData((d) => seen.push(d));
    await t.open();
    // Reach past detach the way a queued event would.
    const captured = fake;
    await t.close();
    captured.push([1, 2]);
    expect(seen).toHaveLength(0);
  });

  it('surfaces a write error from the port', async () => {
    const fake = new FakeNodePort();
    fake.writeError = new Error('Write timeout');
    const t = new NodeSerialTransport(fake);
    await t.open();
    await expect(t.write(new Uint8Array([1]))).rejects.toThrow('Write timeout');
  });
});
