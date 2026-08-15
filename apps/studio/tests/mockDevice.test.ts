// Integration: the full protocol stack (client -> frames -> mock transport
// -> mock device and back) with the same code paths real hardware will use.
import { afterEach, describe, expect, it } from 'vitest';
import { KinoProtocolClient } from '@kino/kdp';
import { KinoDevice } from '../src/device/KinoDevice';
import { MockTransport } from '@kino/kdp';
import { MockKinoDevice } from '../src/mock/MockKinoDevice';

let transport: MockTransport | null = null;

async function connect() {
  const mock = new MockKinoDevice();
  transport = new MockTransport(mock);
  await transport.open();
  const client = new KinoProtocolClient(transport);
  const device = new KinoDevice(client);
  return { mock, device, client };
}

afterEach(async () => {
  await transport?.close();
  transport = null;
});

describe('mock device over the real protocol stack', () => {
  it('answers HELLO with product and protocol', async () => {
    const { device } = await connect();
    const hello = await device.hello(1234);
    expect(hello.product).toBe('KINO');
    expect(hello.protocol).toBe(1);
    expect(hello.nonce).toBe(1234); // echoed, proving a live reply
  });

  it('reports four OV3660 cameras', async () => {
    const { device } = await connect();
    const info = await device.getDeviceInfo();
    expect(info.sensors).toEqual(['OV3660', 'OV3660', 'OV3660', 'OV3660']);
    const cams = await device.getCameraInfo();
    expect(cams.cameras).toHaveLength(4);
    expect(cams.cameras.every((c) => c.online)).toBe(true);
  });

  it('applies and persists a config patch', async () => {
    const { device } = await connect();
    const before = await device.getConfig();
    await device.applyConfig({ wiggle: { fps: 12 } as never });
    const after = await device.getConfig();
    expect(after.schemaVersion).toBe(1);
    expect(after.configRevision).toBe(before.configRevision + 1);
    expect(after.config.wiggle.fps).toBe(12);
    expect(after.config.wiggle.recipeId).toBe('party-neg'); // merge keeps untouched fields
  });

  it('refuses to delete a factory recipe', async () => {
    const { device } = await connect();
    await expect(device.deleteRecipe('party-neg')).rejects.toThrow(/factory/i);
  });

  it('marks CAM1 offline when the fault is injected', async () => {
    const { mock, device } = await connect();
    mock.setScenario('cam1Offline', true);
    const cams = await device.getCameraInfo();
    const cam1 = cams.cameras.find((c) => c.id === 'cam1');
    expect(cam1?.online).toBe(false);
    expect(cam1?.state).toBe('offline');
  });

  it('recovers after an injected CRC error (command times out, next succeeds)', async () => {
    const { mock, device, client } = await connect();
    mock.setScenario('crcErrorNext', true);
    await expect(device.getPowerStatus()).rejects.toThrow(/timed out/i);
    expect(client.stats.crcFailures).toBeGreaterThanOrEqual(1);
    const power = await device.getPowerStatus();
    expect(power.batteryV).toBeGreaterThan(3);
  }, 10000);

  it('requires maintenance mode before a firmware transfer', async () => {
    const { device } = await connect();
    await expect(
      device.fwBegin({ target: 'cam1', size: 1024, sha256: 'a'.repeat(64), version: '0.5.0' }),
    ).rejects.toThrow(/maintenance/i);
  });
});
