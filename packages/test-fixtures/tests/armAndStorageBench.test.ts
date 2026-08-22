// Issue #61: the `armed` camera state and STORAGE_BENCH (0x4c). Both exist so
// the Twin exercises a surface the P4 does not implement yet — armed is a
// payload string the reference device now actually enters and leaves, and
// STORAGE_BENCH is reserved in firmware but answered here.
import { afterEach, describe, expect, it } from 'vitest';
import { Cmd, KinoProtocolClient, MockTransport } from '@kino/kdp';
import type { CameraInfo, CapabilitiesResponse, StorageBenchResult } from '@kino/kdp';
import { MockKinoDevice } from '../src/index';

let transport: MockTransport | null = null;

async function connect(seed = 7) {
  const mock = new MockKinoDevice({ seed, ambientCaptures: false });
  transport = new MockTransport(mock);
  await transport.open();
  const client = new KinoProtocolClient(transport);
  return { mock, client };
}

/**
 * A device on an injected clock the test moves by hand. The arm window is a
 * deadline, and the only way to assert a deadline without waiting three real
 * seconds is to own the clock — the mock takes one for exactly this.
 */
async function connectWithClock(seed = 7) {
  let clock = Date.now();
  const mock = new MockKinoDevice({ seed, ambientCaptures: false, now: () => clock });
  transport = new MockTransport(mock);
  await transport.open();
  const client = new KinoProtocolClient(transport);
  return { mock, client, advance: (ms: number) => (clock += ms) };
}

afterEach(async () => {
  await transport?.close();
  transport = null;
});

const cams = (client: KinoProtocolClient) =>
  client.request<{ cameras: CameraInfo[] }>(Cmd.GET_CAMERA_INFO).then((r) => r.cameras);

describe('armed camera state', () => {
  it('reports ready before anyone arms', async () => {
    const { client } = await connect();
    expect((await cams(client)).map((c) => c.state)).toEqual(['ready', 'ready', 'ready', 'ready']);
  });

  it('CAMERA_ARM puts every camera in armed', async () => {
    const { client } = await connect();
    const ack = await client.request<{ ok: boolean; armWindowMs: number }>(Cmd.CAMERA_ARM);
    expect(ack.ok).toBe(true);
    expect(ack.armWindowMs).toBeGreaterThan(0);
    expect((await cams(client)).map((c) => c.state)).toEqual(['armed', 'armed', 'armed', 'armed']);
  });

  it('the capture is an exit — armed clears on the trigger', async () => {
    const { client } = await connect();
    await client.request(Cmd.CAMERA_ARM);
    expect((await cams(client))[0].state).toBe('armed');
    await client.request(Cmd.CAMERA_CAPTURE, {});
    expect((await cams(client)).map((c) => c.state)).toEqual(['ready', 'ready', 'ready', 'ready']);
  });

  it('the arm window is the other exit — nothing stays armed forever', async () => {
    const { client, advance } = await connectWithClock();
    await client.request(Cmd.CAMERA_ARM);
    expect((await cams(client))[0].state).toBe('armed');
    // There is no CAMERA_DISARM by design (firmware-contract/commands.md);
    // the deadline passing is what has to release the sensors.
    advance(4000);
    expect((await cams(client)).map((c) => c.state)).toEqual(['ready', 'ready', 'ready', 'ready']);
  });

  it('offline beats armed — a camera that cannot answer is not primed', async () => {
    const { mock, client } = await connect();
    mock.setCamFault('cam3', 'offline');
    await client.request(Cmd.CAMERA_ARM);
    const list = await cams(client);
    expect(list.find((c) => c.id === 'cam3')!.state).toBe('offline');
    expect(list.find((c) => c.id === 'cam1')!.state).toBe('armed');
  });
});

describe('STORAGE_BENCH', () => {
  it('answers the documented result shape', async () => {
    const { client } = await connect();
    const result = await client.request<StorageBenchResult>(
      Cmd.STORAGE_BENCH,
      { sizeMB: 16, blockKB: 64, passes: 1 },
      30000,
    );
    expect(result.bytes).toBe(16 * 1024 * 1024);
    expect(result.writeMBs).toBeGreaterThan(0);
    expect(result.readMBs).toBeGreaterThan(result.writeMBs);
    // The whole point of the command: the worst block is far above p95, so a
    // panel that only printed an average would hide the stall that drops a
    // frame out of a four-frame burst.
    expect(result.worstBlockMs).toBeGreaterThan(result.p95BlockMs);
  });

  it('is deterministic under a seed', async () => {
    const req = { sizeMB: 8, blockKB: 32, passes: 2 };
    const a = await connect(11).then(({ client }) =>
      client.request<StorageBenchResult>(Cmd.STORAGE_BENCH, req, 30000),
    );
    await transport?.close();
    const b = await connect(11).then(({ client }) =>
      client.request<StorageBenchResult>(Cmd.STORAGE_BENCH, req, 30000),
    );
    expect(b).toEqual(a);
    expect(a.bytes).toBe(8 * 1024 * 1024 * 2);
  });

  it('NACKs arguments outside the documented ranges', async () => {
    const { client } = await connect();
    await expect(client.request(Cmd.STORAGE_BENCH, { sizeMB: 0, blockKB: 64, passes: 1 })).rejects.toThrow(
      /sizeMB/i,
    );
    await expect(
      client.request(Cmd.STORAGE_BENCH, { sizeMB: 16, blockKB: 1, passes: 1 }),
    ).rejects.toThrow(/blockKB/i);
  });

  it('reports SD_ERROR rather than a zeroed result with no card', async () => {
    const { mock, client } = await connect();
    mock.setScenario('sdMissing', true);
    await expect(client.request(Cmd.STORAGE_BENCH, { sizeMB: 4, blockKB: 64, passes: 1 })).rejects.toThrow(
      /card/i,
    );
  });

  it('legacy firmware neither advertises the gate nor answers', async () => {
    const { mock, client } = await connect();
    mock.setScenario('legacyFirmware', true);
    const caps = await client.request<CapabilitiesResponse>(Cmd.GET_CAPABILITIES);
    expect(caps.capabilities.benchDiagnostics).toBe(false);
    await expect(client.request(Cmd.STORAGE_BENCH, { sizeMB: 4, blockKB: 64, passes: 1 })).rejects.toThrow(
      /not implemented/i,
    );
  });
});
