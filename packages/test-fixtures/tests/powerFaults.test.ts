import { describe, expect, it } from 'vitest';
import { CAM_IDS, Cmd, KinoProtocolClient, MockTransport } from '@kino/kdp';
import { MockKinoDevice } from '../src/MockKinoDevice';

async function connect(mock = new MockKinoDevice({ seed: 9, ambientCaptures: false })) {
  const transport = new MockTransport(mock);
  await transport.open();
  const client = new KinoProtocolClient(transport);
  await client.hello({ attempts: 1 });
  return { mock, client, transport };
}

interface PowerStatus {
  batteryV: number | null;
  batteryPct: number | null;
  batteryMeasured: boolean;
  state: string;
  charging: boolean;
  chargingA?: number;
  busV?: number;
  fuse?: string;
  displayStage: string;
  idleSeconds: number;
  displayOn: boolean;
  cameraBankPowered: boolean;
}

describe('power faults (audit #57)', () => {
  it('as shipped: GET_POWER_STATUS carries no pack telemetry on D4-V1 (D10), whatever the scenario says', async () => {
    const { mock, client, transport } = await connect();
    try {
      const shipped = await client.request<PowerStatus>(Cmd.GET_POWER_STATUS);
      expect(shipped).toMatchObject({
        batteryV: null,
        batteryPct: null,
        batteryMeasured: false,
        state: 'usb',
        charging: false,
        displayStage: 'awake',
        displayOn: true,
        cameraBankPowered: true,
      });
      expect(shipped.idleSeconds).toBeGreaterThanOrEqual(0);
      expect(shipped).not.toHaveProperty('chargingA');
      expect(shipped).not.toHaveProperty('busV');
      expect(shipped).not.toHaveProperty('fuse');

      // A charger or a low pack changes nothing the body can sense.
      mock.setScenario('chargerConnected', true);
      mock.setScenario('lowBattery', true);
      const still = await client.request<PowerStatus>(Cmd.GET_POWER_STATUS);
      expect(still).toMatchObject({ batteryV: null, batteryMeasured: false, charging: false });

      // The pack model stays available to the Twin's own POWER tab.
      expect(mock.twinSnapshot().batteryV).toBeCloseTo(3.42, 2);
    } finally {
      client.dispose();
      await transport.close();
    }
  });

  it('chargerConnected: with powerTelemetry overridden on, GET_POWER_STATUS reports a USB charger at 0.6 A', async () => {
    const { mock, client, transport } = await connect();
    try {
      mock.overrideCapabilities({ powerTelemetry: true });
      const before = await client.request<PowerStatus>(Cmd.GET_POWER_STATUS);
      expect(before.charging).toBe(false);
      expect(before.state).toBe('battery');
      expect(before.batteryMeasured).toBe(true);
      expect(before.batteryV).toBeGreaterThan(3);

      mock.setScenario('chargerConnected', true);
      const on = await client.request<PowerStatus>(Cmd.GET_POWER_STATUS);
      expect(on).toMatchObject({ charging: true, state: 'usb', chargingA: 0.6 });
    } finally {
      client.dispose();
      await transport.close();
    }
  });

  it('sw6106Shutdown: the 5 V rail dies once, the link drops, and the flag disarms', async () => {
    const { mock, client, transport } = await connect();
    let closed = false;
    transport.onClose(() => {
      closed = true;
    });
    try {
      mock.setScenario('sw6106Shutdown', true);
      expect(closed).toBe(true);
      expect(mock.scenarios.sw6106Shutdown).toBe(false); // one-shot outcome, not persisted damage
    } finally {
      client.dispose();
      await transport.close();
    }
  });

  it('cameraPowerTransient: one camera browns out during the next capture and the group is incomplete', async () => {
    const { mock, client, transport } = await connect();
    try {
      mock.setScenario('cameraPowerTransient', true);
      await client.request(Cmd.CAMERA_CAPTURE, {});
      expect(mock.scenarios.cameraPowerTransient).toBe(false); // one-shot

      // Exactly one channel power-cycled (reads offline while it reboots);
      // the other three stayed up. CAM_IDS pins the group size to four.
      const status = await client.request<{ cameras: { id: string; online: boolean }[] }>(Cmd.GET_CAMERA_INFO);
      expect(status.cameras).toHaveLength(CAM_IDS.length);
      expect(status.cameras.filter((c) => !c.online)).toHaveLength(1);
    } finally {
      client.dispose();
      await transport.close();
    }
  });
});
