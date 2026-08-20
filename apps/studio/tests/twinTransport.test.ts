// KINO Twin §10 option 2, closing Phase B: Studio's own connect path reaching
// a Twin purely over BroadcastTransport + raw KDP bytes — no fake-device
// special case, no reading of Twin's internal state store (§10/§20). This
// drives KinoProtocolClient exactly as apps/studio/src/app/session.ts does,
// against a real TwinDeviceServer/TwinSimulator pair.
import { describe, it, expect, afterEach } from 'vitest';
import { KinoProtocolClient, BroadcastTransport, Cmd } from '@kino/kdp';
import type { CameraInfo } from '@kino/kdp';
import { TwinSimulator, TwinDeviceServer } from '@kino/simulator-engine';

describe('Studio ↔ Twin over raw KDP', () => {
  let server: TwinDeviceServer;
  let sim: TwinSimulator;
  let transport: BroadcastTransport;

  afterEach(async () => {
    await transport?.close();
    server?.stop();
    sim?.dispose();
  });

  it('handshakes and diagnoses CAM3 purely through the protocol', async () => {
    const chan = `twin-test-${Math.random()}`;
    sim = new TwinSimulator({ seed: 7 });
    sim.powerOn();
    server = new TwinDeviceServer(sim, { channelName: chan });
    server.start();
    await new Promise((r) => setTimeout(r, 2500)); // boot stages → READY

    transport = new BroadcastTransport(chan);
    await transport.open();
    const client = new KinoProtocolClient(transport);
    const hello = await client.hello(); // §26 #5 handshake sequence
    expect(hello).toMatchObject({ product: 'KINO', protocol: 1 });
    const info = await client.request<{ serial: string; product: string }>(Cmd.GET_DEVICE_INFO);
    expect(info.serial).toBe('KD4-SIM-0001'); // §11 simulated identity
    await client.request(Cmd.GET_CAPABILITIES);
    const cfg = await client.request<{ config: unknown }>(Cmd.GET_CONFIG);
    expect(cfg).toHaveProperty('config');

    sim.device.setCamFault('cam3', 'offline'); // twin-side knob
    // MockKinoDevice.dispatch answers CAMERA_STATUS with one CameraInfo for
    // the requested `cam`, not a `cameras` array (that shape is GET_CAMERA_INFO).
    const status = await client.request<CameraInfo>(Cmd.CAMERA_STATUS, { cam: 'cam3' });
    expect(status.state).toBe('offline');
    client.dispose();
  });
});
