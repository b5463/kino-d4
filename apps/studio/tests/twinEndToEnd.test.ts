// Issue #72: the complete Studio↔Twin loop over the real BroadcastChannel
// transport — connect, read the whole populateAll surface, shoot, watch the
// photo land in the gallery with real JPEG bytes, and push it into the Roll
// upload queue. This is the automated version of "the connection to Studio
// works, photos flow, and the buttons do things".
import { describe, it, expect, afterEach } from 'vitest';
import { KinoProtocolClient, BroadcastTransport, Cmd } from '@kino/kdp';
import type { CapabilitiesResponse, MediaListResponse } from '@kino/kdp';
import { TwinSimulator, TwinDeviceServer } from '@kino/simulator-engine';
import { KinoDevice } from '../src/device/KinoDevice';

describe('Studio ↔ Twin end to end', () => {
  let server: TwinDeviceServer;
  let sim: TwinSimulator;
  let transport: BroadcastTransport;

  afterEach(async () => {
    await transport?.close();
    server?.stop();
    sim?.dispose();
  });

  it('connects, shoots, sees the photo, and queues it for upload', async () => {
    const chan = `twin-e2e-${Math.random()}`;
    sim = new TwinSimulator({ seed: 11 });
    sim.device.setUartBaud(3000000); // keep the simulated transfer short
    sim.powerOn();
    server = new TwinDeviceServer(sim, { channelName: chan });
    server.start();
    await new Promise((r) => setTimeout(r, 2500)); // boot stages → READY

    transport = new BroadcastTransport(chan);
    await transport.open();
    const client = new KinoProtocolClient(transport);
    const dev = new KinoDevice(client);

    // Connect + the full populateAll read surface Studio performs.
    const hello = await client.hello();
    expect(hello.product).toBe('KINO');
    const info = await dev.getDeviceInfo();
    expect(info.serial).toBe('KD4-SIM-0001');
    const caps = await client.request<CapabilitiesResponse>(Cmd.GET_CAPABILITIES);
    expect(caps.capabilities.gallery).toBe(true);
    expect(caps.capabilities.benchDiagnostics).toBe(true);
    const cams = await dev.getCameraInfo();
    expect(cams.cameras).toHaveLength(4);
    await dev.getPowerStatus();
    await dev.getStorageStatus();
    await dev.getConfig();
    await dev.getRecipes();
    await dev.getCalibration();
    await dev.getRuntimeStats();

    // Bench diagnostics buttons: test capture + link stats + hw validation.
    const test = await dev.cameraTest('cam1');
    expect(test.ok).toBe(true);
    const stats = await dev.cameraLinkStats('cam1');
    expect(stats.cam).toBe('cam1');
    const hw = await dev.getHwValidation();
    expect(hw.items.length).toBeGreaterThan(0);

    // Shoot: the same CAMERA_CAPTURE the Twin shutter and Shoot page fire.
    const before = await dev.mediaList({ cursor: 0, limit: 1 });
    await client.request(Cmd.CAMERA_CAPTURE, {});
    let after: MediaListResponse = before;
    for (let i = 0; i < 100 && after.total <= before.total; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after = await dev.mediaList({ cursor: 0, limit: 1 });
    }
    expect(after.total).toBe(before.total + 1);
    const captureId = after.items[0].id;

    // The photo is really there: thumbnail and full frame are JPEG bytes.
    const thumb = await dev.mediaThumb(captureId);
    expect([thumb[0], thumb[1]]).toEqual([0xff, 0xd8]);
    const frame = await dev.mediaRead(captureId, 'C1.JPG', 0, 4096);
    expect([frame[0], frame[1]]).toEqual([0xff, 0xd8]);
    const detail = await dev.mediaInfo(captureId);
    expect(detail.files.length).toBeGreaterThan(0);

    // Photo uploading: create a Roll, push the capture into the queue.
    const roll = await dev.rollCreate('E2E party');
    expect(roll.rollId).toBeTruthy();
    const enqueue = await dev.uploadEnqueue(captureId);
    expect(enqueue.ok).toBe(true);
    expect(enqueue.queue.pending + enqueue.queue.uploading + enqueue.queue.uploaded).toBeGreaterThan(0);

    client.dispose();
  }, 30000);
});
