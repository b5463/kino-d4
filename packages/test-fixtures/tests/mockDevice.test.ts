// Integration: the full protocol stack (client -> frames -> mock transport
// -> mock device and back) with the same code paths real hardware will use.
//
// This ran against Studio's KinoDevice facade before the mock moved out of the
// app. The facade is a thin JSON wrapper over these commands, so the coverage
// is the same one layer down, and the fixture no longer needs the app to test
// itself. Studio still exercises its own facade over this mock in its suite.
import { afterEach, describe, expect, it } from 'vitest';
import { Cmd, KinoProtocolClient, MockTransport } from '@kino/kdp';
import type { CameraInfo, DeviceInfo, KinoConfig } from '@kino/kdp';
import { MockKinoDevice } from '../src/index';

let transport: MockTransport | null = null;

async function connect() {
  const mock = new MockKinoDevice();
  transport = new MockTransport(mock);
  await transport.open();
  const client = new KinoProtocolClient(transport);
  return { mock, client };
}

afterEach(async () => {
  await transport?.close();
  transport = null;
});

interface ConfigEnvelope {
  schemaVersion: number;
  configRevision: number;
  config: KinoConfig;
}

describe('mock device over the real protocol stack', () => {
  it('answers HELLO with product and protocol', async () => {
    const { client } = await connect();
    const hello = await client.hello({ nonce: () => 1234 });
    expect(hello.product).toBe('KINO');
    expect(hello.protocol).toBe(1);
    expect(hello.nonce).toBe(1234); // echoed, proving a live reply
  });

  it('reports four OV3660 cameras', async () => {
    const { client } = await connect();
    const info = await client.request<DeviceInfo>(Cmd.GET_DEVICE_INFO);
    expect(info.sensors).toEqual(['OV3660', 'OV3660', 'OV3660', 'OV3660']);
    const cams = await client.request<{ cameras: CameraInfo[] }>(Cmd.GET_CAMERA_INFO);
    expect(cams.cameras).toHaveLength(4);
    expect(cams.cameras.every((c) => c.online)).toBe(true);
  });

  it('applies and persists a config patch', async () => {
    const { client } = await connect();
    const before = await client.request<ConfigEnvelope>(Cmd.GET_CONFIG);
    await client.request(Cmd.SET_CONFIG, { schemaVersion: 1, config: { wiggle: { fps: 12 } } });
    const after = await client.request<ConfigEnvelope>(Cmd.GET_CONFIG);
    expect(after.schemaVersion).toBe(1);
    expect(after.configRevision).toBe(before.configRevision + 1);
    expect(after.config.wiggle.fps).toBe(12);
    expect(after.config.wiggle.recipeId).toBe('party-neg'); // merge keeps untouched fields
  });

  it('refuses to delete a factory recipe', async () => {
    const { client } = await connect();
    await expect(client.request(Cmd.DELETE_RECIPE, { id: 'party-neg' })).rejects.toThrow(/factory/i);
  });

  it('marks CAM1 offline when the fault is injected', async () => {
    const { mock, client } = await connect();
    mock.setScenario('offlineCameraNode', true);
    const cams = await client.request<{ cameras: CameraInfo[] }>(Cmd.GET_CAMERA_INFO);
    const cam1 = cams.cameras.find((c) => c.id === 'cam1');
    expect(cam1?.online).toBe(false);
    expect(cam1?.state).toBe('offline');
  });

  it('recovers after an injected CRC error (idempotent read retries transparently)', async () => {
    const { mock, client } = await connect();
    mock.setScenario('badCrc', true);
    // The corrupted response fails CRC and the first attempt times out; the
    // read is idempotent, so the client retries once and the caller never
    // sees the fault — only the stats do.
    const power = await client.request<{ batteryV: number }>(Cmd.GET_POWER_STATUS);
    expect(power.batteryV).toBeGreaterThan(3);
    expect(client.stats.crcFailures).toBeGreaterThanOrEqual(1);
    expect(client.stats.readRetries).toBe(1);
  }, 10000);

  it('requires maintenance mode before a firmware transfer', async () => {
    const { client } = await connect();
    await expect(
      client.request(Cmd.FW_BEGIN, {
        target: 'cam1',
        size: 1024,
        sha256: 'a'.repeat(64),
        version: '0.5.0',
      }),
    ).rejects.toThrow(/maintenance/i);
  });

  it('fails the armed CAM3 update and lets a retry through', async () => {
    const { mock, client } = await connect();
    mock.setScenario('failedUpdate', true);
    await client.request(Cmd.ENTER_MAINTENANCE);
    const size = 4096;
    const begin = await client.request<{ sessionId: number; chunkSize: number }>(Cmd.FW_BEGIN, {
      target: 'cam3',
      size,
      sha256: 'b'.repeat(64),
      version: '0.6.0',
    });

    const chunk = (offset: number, length: number) => {
      const buf = new Uint8Array(8 + length);
      const view = new DataView(buf.buffer);
      view.setUint32(0, begin.sessionId, true);
      view.setUint32(4, offset, true);
      return client.requestBinary(Cmd.FW_CHUNK, buf);
    };

    // The armed failure lands at ~60% of the image.
    await expect(chunk(0, size)).rejects.toThrow(/flash write failed/i);
    expect(mock.scenarios.failedUpdate).toBe(false); // one-shot, disarmed

    const retry = await client.request<{ sessionId: number }>(Cmd.FW_BEGIN, {
      target: 'cam3',
      size,
      sha256: 'b'.repeat(64),
      version: '0.6.0',
    });
    expect(retry.sessionId).toBeGreaterThan(begin.sessionId);
  }, 10000);
  it('reboots even when the client hangs up as soon as it has the ack', async () => {
    // KINO Twin's own REBOOT button opens a private link, sends REBOOT and
    // closes the moment it is answered. `detach()` clears every `after()`
    // timer, so the reboot the host had just asked for was un-scheduled by
    // the host hanging up, and the button did nothing at all. Studio never
    // saw it: it keeps the link open and waits for the device to drop it.
    const mock = new MockKinoDevice({ seed: 21, ambientCaptures: false });
    const reboots: string[] = [];
    mock.onTelemetry((event) => {
      if (event.t === 'reboot') reboots.push(event.reason);
    });

    const transport = new MockTransport(mock);
    const client = new KinoProtocolClient(transport);
    await transport.open();
    await client.hello({ attempts: 1 });
    await client.request(Cmd.REBOOT);
    // Exactly what the Twin does next.
    client.dispose();
    await transport.close();

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reboots).toEqual(['host-reboot']);
  }, 10000);
  it('answers stateless reads with no HELLO first', () => {
    // Firmware issue #5 decided HELLO is not a precondition within KDP v1:
    // the client does not enforce ordering, the P4 dispatcher does not check,
    // and the reference device answers anything. A device that got stricter
    // would break a host that is entitled to skip the handshake, so this
    // pins the laxer behavior all three already implement. HELLO stays the
    // only way to get a sessionId; commands that need one still say
    // NO_SESSION.
    const mock = new MockKinoDevice({ seed: 5, ambientCaptures: false });
    const transport = new MockTransport(mock);
    const client = new KinoProtocolClient(transport);
    return transport.open()
      .then(() => client.request<DeviceInfo>(Cmd.GET_DEVICE_INFO))
      .then((info) => {
        expect(info.product).toBeTruthy();
        expect(info.protocol).toBe(1);
        client.dispose();
        return transport.close();
      });
  });
});
