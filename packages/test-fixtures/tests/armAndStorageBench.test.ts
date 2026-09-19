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
  it('answers the documented result shape, plus the firmware\'s additive block', async () => {
    const { client } = await connect();
    const result = await client.request<StorageBenchResult>(
      Cmd.STORAGE_BENCH,
      { sizeMB: 4, blockKB: 64, passes: 1 },
      30000,
    );
    expect(result.bytes).toBe(4 * 1024 * 1024);
    expect(result.writeMBs).toBeGreaterThan(0);
    expect(result.readMBs).toBeGreaterThan(result.writeMBs);
    // The whole point of the command: the worst block is far above p95, so a
    // panel that only printed an average would hide the stall that drops a
    // frame out of a four-frame burst.
    expect(result.worstBlockMs).toBeGreaterThan(result.p95BlockMs);
    // handle_storage_bench's additive fields.
    expect(result).toMatchObject({ ok: true, failedPhase: null, passes: 1, cleanupOk: true });
    expect(result.totalMs).toBeGreaterThan(0);
    expect(result.sustained).toMatchObject({ bytes: 4 * 1024 * 1024, chunkBytes: 64 * 1024, crcMatch: true });
    expect(result.small).toMatchObject({ bytes: 64 * 1024, crcMatch: true });
    expect(result.sustained!.crc32Written).toMatch(/^[0-9a-f]{8}$/);
    expect(result.worstBlockMs).toBeCloseTo(result.sustained!.worstWriteChunkUs / 1000, 6);
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
    // `bytes` is the sustained pass, as the firmware reports it; the pass
    // count travels beside it.
    expect(a.bytes).toBe(8 * 1024 * 1024);
    expect(a.passes).toBe(2);
  });

  it('clamps arguments to the firmware\'s bounds instead of refusing them', async () => {
    const { client } = await connect();
    // sizeKB 64–8192, blockKB 4–128, passes 1–8: a host asking for 512 MB at
    // 4 MB blocks gets 8 MiB at 128 KB and must read the answer, not assume
    // the request was honoured (contract commands.md, STORAGE_BENCH).
    const big = await client.request<StorageBenchResult>(
      Cmd.STORAGE_BENCH,
      { sizeMB: 512, blockKB: 4096, passes: 16 },
      30000,
    );
    expect(big.bytes).toBe(8192 * 1024);
    expect(big.sustained!.chunkBytes).toBe(128 * 1024);
    expect(big.passes).toBe(8);
    const small = await client.request<StorageBenchResult>(Cmd.STORAGE_BENCH, { sizeMB: 0, blockKB: 1, passes: 0 }, 30000);
    expect(small.bytes).toBe(1024 * 1024); // the default, not a refusal
    expect(small.sustained!.chunkBytes).toBe(4 * 1024);
    expect(small.passes).toBe(1);
  });

  it('accepts sizeKB beside sizeMB, so the 64 KiB STORAGE_SELF_TEST size can be asked for', async () => {
    const { client } = await connect();
    const r = await client.request<StorageBenchResult>(Cmd.STORAGE_BENCH, { sizeKB: 64, blockKB: 32, passes: 1 }, 30000);
    expect(r.bytes).toBe(64 * 1024);
  });

  it('holds the capture lock: BUSY while a soak run is active', async () => {
    const { client } = await connect();
    await client.startJob(Cmd.CAMERA_SOAK_TEST, { cam: 'cam1', captures: 40, delayMs: 100 });
    await expect(client.request(Cmd.STORAGE_BENCH, { sizeMB: 1, blockKB: 32, passes: 1 })).rejects.toMatchObject({
      code: 'BUSY',
    });
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
