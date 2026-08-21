import { describe, expect, it } from 'vitest';
import { Cmd, KinoProtocolClient, MockTransport } from '@kino/kdp';
import { MockKinoDevice } from '../src/MockKinoDevice';
import { sha256Hex } from '../src/sha256';

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

async function connect() {
  const mock = new MockKinoDevice({ seed: 3, ambientCaptures: false });
  const transport = new MockTransport(mock);
  await transport.open();
  const client = new KinoProtocolClient(transport);
  await client.hello({ attempts: 1 });
  return { mock, client, transport };
}

function chunkFrame(sessionId: number, offset: number, data: Uint8Array): Uint8Array {
  const buf = new Uint8Array(8 + data.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, sessionId, true);
  view.setUint32(4, offset, true);
  buf.set(data, 8);
  return buf;
}

describe('firmware image verification (FW_END)', () => {
  const image = new Uint8Array(4096).map((_, i) => (i * 31 + 7) & 0xff);

  it('verifies a correct image against the declared sha256', async () => {
    const { client, transport } = await connect();
    try {
      await client.request(Cmd.ENTER_MAINTENANCE, {});
      const begin = await client.request<{ sessionId: number }>(Cmd.FW_BEGIN, {
        target: 'cam1',
        size: image.length,
        sha256: sha256Hex(image),
        version: '0.2.0',
      });
      await client.requestBinary(Cmd.FW_CHUNK, chunkFrame(begin.sessionId, 0, image));
      const end = await client.request<{ ok: boolean; verified: boolean }>(Cmd.FW_END, {});
      expect(end).toMatchObject({ ok: true, verified: true });
    } finally {
      client.dispose();
      await transport.close();
    }
  });

  it('rejects an image whose bytes do not match the declared sha256 and flashes nothing', async () => {
    const { mock, client, transport } = await connect();
    try {
      await client.request(Cmd.ENTER_MAINTENANCE, {});
      const begin = await client.request<{ sessionId: number }>(Cmd.FW_BEGIN, {
        target: 'cam1',
        size: image.length,
        sha256: sha256Hex(image), // declares the good image…
        version: '9.9.9',
      });
      const corrupted = image.slice();
      corrupted[100] ^= 0xff; // …but one byte flips in transit
      await client.requestBinary(Cmd.FW_CHUNK, chunkFrame(begin.sessionId, 0, corrupted));
      await expect(client.request(Cmd.FW_END, {})).rejects.toThrow(/sha256|hash/i);
      expect(mock.twinSnapshot().cams.cam1.fw).not.toBe('9.9.9');
    } finally {
      client.dispose();
      await transport.close();
    }
  });
});
