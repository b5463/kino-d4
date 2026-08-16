// KINO Twin §10 option 2: BroadcastTransport (kdp) and TwinDeviceServer (this
// package) are the two ends of one wire — a Studio tab reaching a Twin tab
// through a same-origin BroadcastChannel instead of a serial cable. This
// drives them together over a real Node BroadcastChannel (global since Node
// 18), the same way SerialTransport/MockTransport are proven against a real
// byte stream rather than a mocked one — no JSON side-channel, only KDP
// frames crossing the channel as `number[]` (§10/§20).
import { afterEach, describe, expect, it } from 'vitest';
import { BroadcastTransport, KinoProtocolClient, PROTOCOL_VERSION } from '@kino/kdp';
import { TwinSimulator } from '../src/TwinSimulator';
import { TwinDeviceServer } from '../src/TwinDeviceServer';

/** A fresh name per test — BroadcastChannel is process-global by name, so
 * reusing one would leak messages between tests running in the same worker. */
function uniqueChannel(): string {
  return `kino-twin-test-${Math.random().toString(36).slice(2)}`;
}

/** Powers a fresh sim on and waits for its own boot-stage machine to reach
 * READY (real timers — a real BroadcastChannel needs a real event loop, so
 * this suite runs on the wall clock rather than vi.useFakeTimers()). */
function bootedSim(seed: number): Promise<TwinSimulator> {
  return new Promise((resolve) => {
    const sim = new TwinSimulator({ seed });
    const unsubscribe = sim.onEvent((e) => {
      if (e.t === 'boot' && e.stage === 'READY') {
        unsubscribe();
        resolve(sim);
      }
    });
    sim.powerOn();
  });
}

describe('BroadcastTransport + TwinDeviceServer (§10 option 2)', () => {
  let sim: TwinSimulator | null = null;
  let server: TwinDeviceServer | null = null;
  const openTransports: BroadcastTransport[] = [];

  afterEach(async () => {
    for (const t of openTransports.splice(0)) {
      await t.close().catch(() => {});
    }
    server?.stop();
    server = null;
    sim?.dispose();
    sim = null;
  });

  it('probes true on a channel with a running server, false on an empty one', async () => {
    const channel = uniqueChannel();
    sim = await bootedSim(1);
    server = new TwinDeviceServer(sim, { channelName: channel });
    server.start();

    await expect(BroadcastTransport.probe(channel, 200)).resolves.toBe(true);
    await expect(BroadcastTransport.probe(uniqueChannel(), 200)).resolves.toBe(false);
  }, 10_000);

  it('completes a KDP HELLO handshake over the channel, matching nonce and product', async () => {
    const channel = uniqueChannel();
    sim = await bootedSim(2);
    server = new TwinDeviceServer(sim, { channelName: channel });
    server.start();

    const transport = new BroadcastTransport(channel);
    openTransports.push(transport);
    await transport.open();

    const client = new KinoProtocolClient(transport);
    const nonce = 424242;
    const hello = await client.hello({ nonce: () => nonce });

    expect(hello.product).toBe('KINO');
    expect(hello.nonce).toBe(nonce);
    expect(hello.protocol).toBe(PROTOCOL_VERSION);
    client.dispose();
  }, 10_000);

  it('rejects a second connect with busy while the first Studio tab is attached', async () => {
    const channel = uniqueChannel();
    sim = await bootedSim(3);
    server = new TwinDeviceServer(sim, { channelName: channel });
    server.start();

    const first = new BroadcastTransport(channel);
    openTransports.push(first);
    await first.open();

    const second = new BroadcastTransport(channel);
    await expect(second.open()).rejects.toThrow(/busy|already connected/i);
  }, 10_000);

  it('a device reboot force-closes the transport with a reboot reason (MockTransport parity)', async () => {
    const channel = uniqueChannel();
    sim = await bootedSim(4);
    server = new TwinDeviceServer(sim, { channelName: channel });
    server.start();

    const transport = new BroadcastTransport(channel);
    openTransports.push(transport);
    await transport.open();

    const closed = new Promise<string | undefined>((resolve) => {
      transport.onClose((reason) => resolve(reason));
    });

    sim.device.setScenario('sessionRestart', true);

    await expect(closed).resolves.toMatch(/rebooting/i);
  }, 10_000);
});
