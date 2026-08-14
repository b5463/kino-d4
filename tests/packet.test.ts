import { describe, expect, it } from 'vitest';
import { FrameDecoder, encodeFrame, encodeJson, decodeJson } from '../src/protocol/packet';
import type { Frame } from '../src/protocol/packet';

function frame(seq: number, payload: Uint8Array = new Uint8Array(0)): Frame {
  return { version: 1, type: 0x02, flags: 0x01, seq, payload };
}

describe('frame encode/decode roundtrip', () => {
  it('decodes a single complete frame', () => {
    const decoder = new FrameDecoder();
    const payload = encodeJson({ hello: 'kino' });
    const frames = decoder.push(encodeFrame(frame(7, payload)));
    expect(frames).toHaveLength(1);
    expect(frames[0].seq).toBe(7);
    expect(decodeJson(frames[0].payload)).toEqual({ hello: 'kino' });
  });

  it('reassembles a frame delivered one byte at a time', () => {
    const decoder = new FrameDecoder();
    const bytes = encodeFrame(frame(42, encodeJson({ a: 1 })));
    const collected: Frame[] = [];
    for (const b of bytes) collected.push(...decoder.push(new Uint8Array([b])));
    expect(collected).toHaveLength(1);
    expect(collected[0].seq).toBe(42);
  });

  it('splits multiple frames received in one read', () => {
    const decoder = new FrameDecoder();
    const combined = new Uint8Array([
      ...encodeFrame(frame(1)),
      ...encodeFrame(frame(2)),
      ...encodeFrame(frame(3)),
    ]);
    const frames = decoder.push(combined);
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it('skips garbage before a valid frame', () => {
    const decoder = new FrameDecoder();
    const noise = new Uint8Array([0x00, 0xff, 0x4b, 0x00, 0x13]); // includes a lone 'K'
    const frames = decoder.push(new Uint8Array([...noise, ...encodeFrame(frame(9))]));
    expect(frames).toHaveLength(1);
    expect(frames[0].seq).toBe(9);
  });

  it('drops a corrupted frame and recovers the next one', () => {
    const decoder = new FrameDecoder();
    const bad = encodeFrame(frame(1, encodeJson({ x: 'corrupt me' }))).slice();
    bad[20] ^= 0xff; // flip a payload byte -> CRC mismatch
    const good = encodeFrame(frame(2));
    const frames = decoder.push(new Uint8Array([...bad, ...good]));
    expect(frames.map((f) => f.seq)).toEqual([2]);
    expect(decoder.stats.crcFailures).toBeGreaterThanOrEqual(1);
  });

  it('rejects an insane length field without stalling the stream', () => {
    const decoder = new FrameDecoder();
    const evil = encodeFrame(frame(1)).slice();
    evil[10] = 0xff; // payload length -> huge
    evil[11] = 0xff;
    evil[12] = 0xff;
    const frames = decoder.push(new Uint8Array([...evil, ...encodeFrame(frame(5))]));
    expect(frames.map((f) => f.seq)).toContain(5);
  });

  it('handles an 8 KB binary payload (firmware chunk size)', () => {
    const decoder = new FrameDecoder();
    const payload = new Uint8Array(8192).map((_, i) => i & 0xff);
    const frames = decoder.push(encodeFrame({ version: 1, type: 0x62, flags: 0x08, seq: 3, payload }));
    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toEqual(payload);
  });
});
