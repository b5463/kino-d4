// The whole WebSocket path end to end (issue #29): TwinDeviceServer on its
// BroadcastChannel — completely unchanged — bridged to the relay, with
// Studio's client arriving over WebSocketTransport. If HELLO answers and
// device info flows, the carrier swap is proven transport-only.
import { afterEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line import/no-relative-packages -- dev relay script, not a package
import { createTwinRelay } from '../../../scripts/twin-ws-relay.mjs';
import { bridgeTwinChannel, Cmd, KinoProtocolClient, WebSocketTransport } from '@kino/kdp';
import type { DeviceInfo, HelloResponse } from '@kino/kdp';
import { TwinDeviceServer, TwinSimulator } from '@kino/simulator-engine';

describe('Twin over the WebSocket relay', () => {
  let cleanups: Array<() => Promise<unknown> | unknown> = [];
  afterEach(async () => {
    for (const fn of cleanups.reverse()) await fn();
    cleanups = [];
  });

  it('Studio connects across the bridge and the simulator never notices', async () => {
    const port = 5960 + Math.floor(Math.random() * 30);
    const relay = createTwinRelay({ port });
    cleanups.push(() => relay.close());
    const url = `ws://127.0.0.1:${port}`;
    const channelName = `twin-ws-e2e-${port}`;

    const sim = new TwinSimulator({ seed: 5 });
    cleanups.push(() => sim.dispose());
    sim.powerOn();
    const server = new TwinDeviceServer(sim, { channelName });
    server.start();
    cleanups.push(() => server.stop());

    const bridge = await bridgeTwinChannel({ url, channelName });
    cleanups.push(() => bridge.close());

    await new Promise((r) => setTimeout(r, 2500)); // boot stages → READY

    expect(await WebSocketTransport.probe(url, 500)).toBe(true);

    const transport = new WebSocketTransport(url);
    cleanups.push(() => transport.close());
    await transport.open();
    const client = new KinoProtocolClient(transport);
    cleanups.push(() => client.dispose());

    const hello = await client.hello({ protocolMin: 1, protocolMax: 1, clientVersion: 'ws-bridge-test' });
    expect((hello as HelloResponse).product).toBe('KINO');
    const info = await client.request<DeviceInfo>(Cmd.GET_DEVICE_INFO);
    expect(info.serial).toBe('KD4-SIM-0001');
  }, 20000);
});
