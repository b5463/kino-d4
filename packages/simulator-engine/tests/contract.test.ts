// Audit #58 / spec §43: ONE canonical Studio command sequence, run verbatim
// against every transport a Studio session can ride. The mock serial path and
// the Twin BroadcastChannel path must be indistinguishable at the protocol
// level — same commands, same shapes, same acknowledgements. A transport that
// needs its own bespoke sequence is a transport Studio cannot trust.
import { afterEach, describe, expect, it } from 'vitest';
import { BroadcastTransport, Cmd, KinoProtocolClient, MockTransport, PROTOCOL_VERSION } from '@kino/kdp';
import type { Transport } from '@kino/kdp';
import { MockKinoDevice } from '@kino/test-fixtures';
import { TwinSimulator } from '../src/TwinSimulator';
import { TwinDeviceServer } from '../src/TwinDeviceServer';

interface Rig {
  transport: Transport;
  dispose(): Promise<void> | void;
}

function uniqueChannel(): string {
  return `kino-contract-${Math.random().toString(36).slice(2)}`;
}

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

const RIGS: { name: string; make(): Promise<Rig> }[] = [
  {
    name: 'mock serial transport',
    async make() {
      const device = new MockKinoDevice({ seed: 11, ambientCaptures: false });
      const transport = new MockTransport(device);
      await transport.open();
      return { transport, dispose: () => transport.close() };
    },
  },
  {
    name: 'Twin BroadcastChannel transport',
    async make() {
      const sim = await bootedSim(11);
      const channel = uniqueChannel();
      const server = new TwinDeviceServer(sim, { channelName: channel });
      server.start();
      const transport = new BroadcastTransport(channel);
      await transport.open();
      return {
        transport,
        async dispose() {
          await transport.close().catch(() => {});
          server.stop();
          sim.dispose();
        },
      };
    },
  },
];

describe.each(RIGS)('contract sequence over $name', ({ make }) => {
  let rig: Rig | null = null;

  afterEach(async () => {
    await rig?.dispose();
    rig = null;
  });

  it('connect → discover → configure → capture → storage → network answers identically', async () => {
    rig = await make();
    const client = new KinoProtocolClient(rig.transport);
    try {
      // Connect + discovery
      const hello = await client.hello({});
      expect(hello.product).toBe('KINO');
      expect(hello.protocol).toBe(PROTOCOL_VERSION);

      const info = await client.request<{ serial: string; cameraFirmware: string[] }>(Cmd.GET_DEVICE_INFO);
      expect(info.serial).toMatch(/^K/);
      expect(info.cameraFirmware).toHaveLength(4);

      const caps = await client.request<{ capabilities: Record<string, unknown> }>(Cmd.GET_CAPABILITIES);
      expect(typeof caps.capabilities).toBe('object');

      const cams = await client.request<{ cameras: { id: string; online: boolean }[] }>(Cmd.GET_CAMERA_INFO);
      expect(cams.cameras.map((c) => c.id)).toEqual(['cam1', 'cam2', 'cam3', 'cam4']);

      // Configuration round trip
      const envelope = await client.request<{ schemaVersion: number; config: { mode: string } }>(Cmd.GET_CONFIG);
      expect(envelope.schemaVersion).toBe(1);
      const flipped = envelope.config.mode === 'wiggle' ? 'quad' : 'wiggle';
      await client.request(Cmd.SET_MODE, { mode: flipped });
      const reread = await client.request<{ config: { mode: string } }>(Cmd.GET_CONFIG);
      expect(reread.config.mode).toBe(flipped);
      await client.request(Cmd.SET_MODE, { mode: envelope.config.mode });

      // Capture
      const capture = await client.request<{ ok?: boolean; id?: number }>(Cmd.CAMERA_CAPTURE, {});
      expect(capture).toBeTruthy();

      // Storage + network/roll status
      const storage = await client.request<{ present: boolean; freeMB: number }>(Cmd.GET_STORAGE_STATUS);
      expect(storage.present).toBe(true);
      const network = await client.request<{ state: string }>(Cmd.NETWORK_STATUS);
      expect(typeof network.state).toBe('string');
      const queue = await client.request<{ pending: number }>(Cmd.UPLOAD_QUEUE_STATUS);
      expect(queue.pending).toBeGreaterThanOrEqual(0);
    } finally {
      client.dispose();
    }
  }, 20_000);
});
