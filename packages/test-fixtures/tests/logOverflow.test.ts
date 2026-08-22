// GET_LOGS at a full ring (issue #80): 200 max-length entries serialize past
// the 16 KB KDP payload cap. The firmware used to build that reply anyway and
// silently send nothing — every log fetch then timed out, permanently. The
// rule now on both sides: the newest entries that fit win, oldest-first order
// preserved. This suite locks the shared budget helper, the encoder's loud
// refusal of oversized frames, and the wire behavior of the reference device.
import { afterEach, describe, expect, it } from 'vitest';
import { Cmd, KinoProtocolClient, MockTransport, MAX_PAYLOAD, encodeFrame, PROTOCOL_VERSION } from '@kino/kdp';
import type { LogEntry } from '@kino/kdp';
import { MockKinoDevice, fitLogEntries } from '../src/index';

let transports: MockTransport[] = [];

async function connect(mock: MockKinoDevice) {
  const transport = new MockTransport(mock);
  transports.push(transport);
  await transport.open();
  return new KinoProtocolClient(transport);
}

afterEach(async () => {
  for (const t of transports) await t.close().catch(() => undefined);
  transports = [];
});

/** A worst-case ring: every message at the firmware's 95-char maximum. */
function fullRing(count: number): LogEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    t: 1755887000000 + i,
    src: 'PROTO' as const,
    msg: `soak tick ${i} `.padEnd(95, 'x'),
  }));
}

describe('log reply byte budget', () => {
  it('keeps the newest entries that fit, oldest-first', () => {
    const entries = fullRing(400);
    const kept = fitLogEntries(entries, MAX_PAYLOAD - 64);

    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(400);
    // Newest survives, order stays chronological.
    expect(kept[kept.length - 1].t).toBe(entries[entries.length - 1].t);
    for (let i = 1; i < kept.length; i++) expect(kept[i].t).toBeGreaterThan(kept[i - 1].t);
    // The whole reply fits in one frame.
    expect(JSON.stringify({ entries: kept }).length).toBeLessThanOrEqual(MAX_PAYLOAD);
  });

  it('encodeFrame refuses an oversized payload instead of producing an undecodable frame', () => {
    expect(() =>
      encodeFrame({
        version: PROTOCOL_VERSION,
        type: Cmd.GET_LOGS,
        flags: 0,
        seq: 1,
        payload: new Uint8Array(MAX_PAYLOAD + 1),
      }),
    ).toThrow(/MAX_PAYLOAD/);
  });

  it('GET_LOGS answers even when the device log is full of long entries', async () => {
    const mock = new MockKinoDevice({ seed: 7, ambientCaptures: false });
    // Reach into the ring the way 400 chatty boot cycles would fill it.
    (mock as unknown as { logBuffer: LogEntry[] }).logBuffer.push(...fullRing(400));
    const client = await connect(mock);

    await client.hello({ protocolMin: 1, protocolMax: 1, clientVersion: 'log-overflow-test' });
    const reply = await client.request<{ entries: LogEntry[] }>(Cmd.GET_LOGS);

    expect(reply.entries.length).toBeGreaterThan(0);
    const newest = reply.entries[reply.entries.length - 1];
    expect(newest.t).toBe(1755887000000 + 399);
    client.dispose();
  });
});
