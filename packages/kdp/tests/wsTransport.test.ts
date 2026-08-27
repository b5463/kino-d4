// WebSocketTransport over the real relay (issue #29): probe, handshake,
// busy, data, and close semantics must match the BroadcastChannel carrier —
// both are TwinBusTransport, so this suite exercises the shared state
// machine through the network carrier plus the carrier-only failure mode
// (relay death).
import { afterEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line import/no-relative-packages -- dev relay script, not a package
import { createTwinRelay } from '../../../scripts/twin-ws-relay.mjs';
import { WebSocketTransport } from '../src/transport/WebSocketTransport';
import type { TwinWireMsg } from '../src/transport/twinWire';

let cleanups: Array<() => Promise<unknown> | unknown> = [];
const later = (fn: () => Promise<unknown> | unknown) => cleanups.push(fn);

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

/*
 * Port 0: the OS picks a free one and the relay reports what it bound.
 *
 * This used to pick from a fixed 5920-5959 window with no bind retry, so a
 * lingering socket from a previous run in the same window produced
 * `EADDRINUSE` on 127.0.0.1:5939 — which surfaced as an unrelated 5 s test
 * timeout rather than as a port collision. Asking for 0 cannot collide.
 */
async function relay() {
  const r = createTwinRelay({ port: 0 });
  later(() => r.close());
  await r.ready;
  return `ws://127.0.0.1:${r.port}`;
}

/** The device end of the wire, minimal: answers probe/connect, echoes data. */
function fakeTwin(url: string, opts?: { busy?: 'booting' | 'connected' }) {
  const socket = new WebSocket(url);
  later(() => socket.close());
  const post = (msg: TwinWireMsg) => socket.send(JSON.stringify(msg));
  const opened = new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
  socket.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data)) as TwinWireMsg;
    if (msg.t === 'probe') post({ t: 'present' });
    if (msg.t === 'connect') {
      if (opts?.busy) post({ t: 'busy', client: msg.client, reason: opts.busy });
      else post({ t: 'accept', client: msg.client });
    }
    if (msg.t === 'data' && msg.from === 'host') {
      post({ t: 'data', from: 'device', client: msg.client, bytes: msg.bytes.slice().reverse() });
    }
  });
  return { opened, post, socket };
}

describe('WebSocketTransport', () => {
  it('probe: false with no relay, false with an empty relay, true with a twin end', async () => {
    expect(await WebSocketTransport.probe('ws://127.0.0.1:59999', 200)).toBe(false);
    const url = await relay();
    expect(await WebSocketTransport.probe(url, 200)).toBe(false);
    await fakeTwin(url).opened;
    expect(await WebSocketTransport.probe(url, 500)).toBe(true);
  });

  it('opens, moves bytes both ways, and closes cleanly', async () => {
    const url = await relay();
    await fakeTwin(url).opened;

    const transport = new WebSocketTransport(url);
    const received: number[][] = [];
    const closes: Array<string | undefined> = [];
    transport.onData((d) => received.push(Array.from(d)));
    transport.onClose((reason) => closes.push(reason));
    await transport.open();

    await transport.write(Uint8Array.from([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toEqual([[3, 2, 1]]);

    await transport.close();
    expect(closes).toEqual([undefined]);
    await expect(transport.write(Uint8Array.from([9]))).rejects.toThrow(/not connected/);
  });

  it('a busy twin rejects open with the same messages as the channel carrier', async () => {
    const url = await relay();
    await fakeTwin(url, { busy: 'connected' }).opened;
    await expect(new WebSocketTransport(url).open()).rejects.toThrow(/already connected to another Studio tab/);
  });

  it('open times out when nothing answers', async () => {
    const url = await relay();
    await expect(new WebSocketTransport(url).open()).rejects.toThrow(/No KINO Twin answered/);
  }, 5000);

  it('a twin-initiated close carries its reason', async () => {
    const url = await relay();
    const twin = fakeTwin(url);
    await twin.opened;
    let client = '';
    twin.socket.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as TwinWireMsg;
      if (msg.t === 'connect') client = msg.client;
    });

    const transport = new WebSocketTransport(url);
    later(() => transport.close());
    const closes: Array<string | undefined> = [];
    transport.onClose((reason) => closes.push(reason));
    await transport.open();
    twin.post({ t: 'close', client, reason: 'rebooting' });
    await new Promise((r) => setTimeout(r, 150));
    expect(closes).toEqual(['rebooting']);
  });

  it('relay death surfaces as a transport close — the carrier-only failure', async () => {
    // Its own relay rather than relay(), because this test kills the relay
    // itself and must not have the afterEach hook close it a second time.
    const r = createTwinRelay({ port: 0 });
    await r.ready;
    const url = `ws://127.0.0.1:${r.port}`;
    await fakeTwin(url).opened;

    const transport = new WebSocketTransport(url);
    const closes: Array<string | undefined> = [];
    transport.onClose((reason) => closes.push(reason));
    await transport.open();

    await r.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closes).toEqual(['Twin bridge connection lost']);
  });
});
