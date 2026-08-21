import { describe, expect, it } from 'vitest';
import { Cmd, KinoProtocolClient, MockTransport } from '@kino/kdp';
import { MockKinoDevice } from '../src/MockKinoDevice';

async function connect(mock = new MockKinoDevice({ seed: 5, ambientCaptures: false })) {
  const transport = new MockTransport(mock);
  await transport.open();
  const client = new KinoProtocolClient(transport);
  await client.hello({ attempts: 1 });
  return { mock, client, transport };
}

describe('transport hostility (audit #58)', () => {
  it('duplicateFrame: a retransmitted response settles the request once and the copy is dropped', async () => {
    const { mock, client, transport } = await connect();
    try {
      mock.setScenario('duplicateFrame', true);
      const power = await client.request<{ batteryV: number }>(Cmd.GET_POWER_STATUS);
      expect(power.batteryV).toBeGreaterThan(3);
      expect(mock.scenarios.duplicateFrame).toBe(false); // one-shot
      // The duplicate arrived, was unmatched by seq, and changed nothing.
      const again = await client.request<{ batteryV: number }>(Cmd.GET_POWER_STATUS);
      expect(again.batteryV).toBeGreaterThan(3);
    } finally {
      client.dispose();
      await transport.close();
    }
  });

  it('droppedByte: the mangled response fails CRC and the idempotent read retries transparently', async () => {
    const { mock, client, transport } = await connect();
    try {
      mock.setScenario('droppedByte', true);
      const power = await client.request<{ batteryV: number }>(Cmd.GET_POWER_STATUS);
      expect(power.batteryV).toBeGreaterThan(3);
      expect(client.stats.readRetries).toBe(1);
      expect(client.stats.crcFailures + client.stats.resyncs).toBeGreaterThanOrEqual(1);
    } finally {
      client.dispose();
      await transport.close();
    }
  }, 10000);

  it('midFrameDisconnect: the link dies half-frame and the host learns it through onClose', async () => {
    const { mock, client, transport } = await connect();
    let closed = false;
    transport.onClose(() => {
      closed = true;
    });
    try {
      mock.setScenario('midFrameDisconnect', true);
      await expect(client.request(Cmd.GET_POWER_STATUS)).rejects.toThrow();
      expect(closed).toBe(true);
    } finally {
      client.dispose();
      await transport.close();
    }
  }, 10000);

  it('baudMismatch: nothing frames until the rate is corrected, then HELLO completes', async () => {
    const mock = new MockKinoDevice({ seed: 6, ambientCaptures: false });
    mock.setScenario('baudMismatch', true);
    const transport = new MockTransport(mock);
    await transport.open();
    const client = new KinoProtocolClient(transport);
    try {
      await expect(client.hello({ attempts: 1 })).rejects.toThrow();
      expect(client.stats.rxFrames).toBe(0); // garble never frames

      mock.setScenario('baudMismatch', false);
      const hello = await client.hello({ attempts: 2 });
      expect(hello.product).toBe('KINO');
    } finally {
      client.dispose();
      await transport.close();
    }
  }, 15000);
});
