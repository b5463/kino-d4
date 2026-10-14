// Issue #242: ENTER_MAINTENANCE / EXIT_MAINTENANCE (0x50/0x51), as the D4-V1
// answers them from firmware 0.4.62. The reference device holds the same
// rules: capture is BUSY while in, entering during a capture that will not end
// inside 2 s is INVALID_STATE, both commands answer ok twice in a row, and the
// body lets go by itself 600 s after the last ENTER or FW_* command.
import { afterEach, describe, expect, it } from 'vitest';
import { Cmd, KinoCommandError, KinoProtocolClient, MockTransport } from '@kino/kdp';
import { MockKinoDevice } from '../src/index';

let transport: MockTransport | null = null;

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

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (err) {
    if (err instanceof KinoCommandError) return err.code;
    throw err;
  }
};

describe('maintenance mode', () => {
  it('answers ok to ENTER and EXIT, twice each', async () => {
    const { client } = await connectWithClock();
    expect(await client.request(Cmd.ENTER_MAINTENANCE)).toEqual({ ok: true });
    expect(await client.request(Cmd.ENTER_MAINTENANCE)).toEqual({ ok: true });
    expect(await client.request(Cmd.EXIT_MAINTENANCE)).toEqual({ ok: true });
    expect(await client.request(Cmd.EXIT_MAINTENANCE)).toEqual({ ok: true });
  });

  it('refuses a capture while in, and takes one again after EXIT', async () => {
    const { client } = await connectWithClock();
    await client.request(Cmd.ENTER_MAINTENANCE);
    expect(await codeOf(client.request(Cmd.CAMERA_CAPTURE, {}))).toBe('BUSY');
    await client.request(Cmd.EXIT_MAINTENANCE);
    expect(await codeOf(client.request(Cmd.CAMERA_CAPTURE, {}))).toBe('ok');
  });

  it('ends by itself 600 s after the last command, and FW_* holds it open', async () => {
    const { client, advance } = await connectWithClock();
    await client.request(Cmd.ENTER_MAINTENANCE);
    advance(599_000);
    // An FW_STATUS poll, as Studio's updater sends while a node comes back.
    await client.request(Cmd.FW_STATUS, { target: 'cam1' });
    advance(599_000);
    expect(await codeOf(client.request(Cmd.CAMERA_CAPTURE, {}))).toBe('BUSY');
    advance(1_001);
    expect(await codeOf(client.request(Cmd.CAMERA_CAPTURE, {}))).toBe('ok');
  });

  it('is INVALID_STATE while a capture holds the lock past 2 s', async () => {
    const { client } = await connectWithClock();
    // On a frozen clock the capture's busy window never closes, so the
    // 2 s wait cannot be satisfied.
    expect(await codeOf(client.request(Cmd.CAMERA_CAPTURE, {}))).toBe('ok');
    expect(await codeOf(client.request(Cmd.ENTER_MAINTENANCE))).toBe('INVALID_STATE');
  });

  it('keeps FW_BEGIN behind maintenance on the reference device', async () => {
    const { client } = await connectWithClock();
    const begin = { target: 'cam1', size: 1024, sha256: 'a'.repeat(64), version: '0.0.0' };
    expect(await codeOf(client.request(Cmd.FW_BEGIN, begin))).toBe('MAINT_REQUIRED');
  });
});
