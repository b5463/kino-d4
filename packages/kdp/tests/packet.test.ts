import { describe, expect, it } from 'vitest';
import {
  FrameDecoder,
  MAX_PAYLOAD,
  MAX_SEQ,
  encodeFrame,
  encodeJson,
  decodeJson,
  nextSeq,
} from '../src/protocol/packet';
import { Cmd, FrameFlags } from '../src/protocol/commands';
import type { Frame } from '../src/protocol/packet';

/** `4b 49 …` as written in firmware-contract/kdp-framing.md, "Worked example". */
function bytes(hex: string): Uint8Array {
  return new Uint8Array(hex.trim().split(/\s+/).map((b) => parseInt(b, 16)));
}

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

describe('sequence wraparound', () => {
  it('wraps to 1, never to 0', () => {
    // 0 is the events' sentinel. A uint32 counter left to overflow on its own
    // would start minting requests indistinguishable from events to anything
    // reading the field literally, which is the whole reason for the rule.
    expect(nextSeq(1)).toBe(2);
    expect(nextSeq(MAX_SEQ - 1)).toBe(MAX_SEQ);
    expect(nextSeq(MAX_SEQ)).toBe(1);
  });

  it('keeps a wrapped sequence intact through the wire format', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(encodeFrame(frame(MAX_SEQ)));
    expect(frames[0].seq).toBe(MAX_SEQ);
  });
});

describe('MAX_PAYLOAD boundary', () => {
  it('round-trips a payload of exactly MAX_PAYLOAD bytes', () => {
    // The cap is inclusive, and the off-by-one matters in both directions: a
    // decoder that rejected it would drop the largest legal frame, and an
    // encoder that allowed one more would emit a frame the peer resyncs past.
    const decoder = new FrameDecoder();
    const payload = new Uint8Array(MAX_PAYLOAD).map((_, i) => i & 0xff);
    const frames = decoder.push(encodeFrame(frame(11, payload)));
    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toEqual(payload);
    expect(decoder.stats.crcFailures).toBe(0);
  });

  it('refuses MAX_PAYLOAD + 1', () => {
    expect(() => encodeFrame(frame(11, new Uint8Array(MAX_PAYLOAD + 1)))).toThrow(/MAX_PAYLOAD/);
  });
});

/**
 * The two frames firmware-contract/kdp-framing.md publishes as decoder
 * fixtures. They are byte literals on purpose: generating them with
 * `encodeFrame` would only prove the encoder agrees with itself, and the point
 * of the fixtures is that a second implementation's CRC must land on the same
 * two words before anything else is worth testing.
 */
describe('golden frames (kdp-framing.md "Worked example")', () => {
  const HELLO = bytes(`
    4b 49 01 01 00 00 01 00 00 00 39 00 00 00
    7b 22 70 72 6f 74 6f 63 6f 6c 4d 69 6e 22 3a 31
    2c 22 70 72 6f 74 6f 63 6f 6c 4d 61 78 22 3a 31
    2c 22 6e 6f 6e 63 65 22 3a 31 2c 22 63 6c 69 65
    6e 74 22 3a 6e 75 6c 6c 7d
    86 dd 9b 14`);
  const SAVE_CONFIG = bytes('4b 49 01 12 00 00 07 00 00 00 00 00 00 00 e4 16 d8 82');

  it('decodes the 75-byte HELLO fixture, CRC 0x149bdd86', () => {
    const decoder = new FrameDecoder();
    expect(HELLO).toHaveLength(75);
    const frames = decoder.push(HELLO);
    expect(frames).toHaveLength(1);
    expect(decoder.stats.crcFailures).toBe(0);
    expect(frames[0].type).toBe(Cmd.HELLO);
    expect(frames[0].flags).toBe(FrameFlags.NONE);
    expect(frames[0].seq).toBe(1);
    expect(decodeJson(frames[0].payload)).toEqual({
      protocolMin: 1,
      protocolMax: 1,
      nonce: 1,
      client: null,
    });
  });

  it('decodes the 18-byte minimum frame, CRC 0x82d816e4', () => {
    const decoder = new FrameDecoder();
    expect(SAVE_CONFIG).toHaveLength(18);
    const frames = decoder.push(SAVE_CONFIG);
    expect(frames).toHaveLength(1);
    expect(decoder.stats.crcFailures).toBe(0);
    expect(frames[0].type).toBe(Cmd.SAVE_CONFIG);
    expect(frames[0].seq).toBe(7);
    expect(frames[0].payload).toHaveLength(0);
    expect(decodeJson(frames[0].payload)).toEqual({});
  });

  it('re-encodes both fixtures byte for byte', () => {
    const decoder = new FrameDecoder();
    for (const fixture of [HELLO, SAVE_CONFIG]) {
      const [decoded] = decoder.push(fixture);
      expect(encodeFrame(decoded)).toEqual(fixture);
    }
  });
});

describe('encodeFrame header guards', () => {
  it("refuses sequence 0 on anything but an event, and accepts it on one", () => {
    expect(() => encodeFrame({ ...frame(1), flags: FrameFlags.RESPONSE, seq: 0 })).toThrow(/sentinel/);
    expect(() => encodeFrame({ ...frame(1), flags: FrameFlags.NONE, seq: 0 })).toThrow(/sentinel/);
    // The reference device writes 0 on every event and the client ignores the
    // field, so this one has to keep working.
    expect(() => encodeFrame({ ...frame(1), flags: FrameFlags.EVENT, seq: 0 })).not.toThrow();
  });

  it('refuses a sequence past MAX_SEQ instead of truncating it', () => {
    expect(() => encodeFrame(frame(MAX_SEQ + 1))).toThrow(/outside 0/);
    expect(() => encodeFrame(frame(1.5))).toThrow(/outside 0/);
    expect(() => encodeFrame(frame(-1))).toThrow(/outside 0/);
  });

  it('refuses version, type or flags that do not fit their byte', () => {
    expect(() => encodeFrame({ ...frame(1), version: 256 })).toThrow(/version 256/);
    expect(() => encodeFrame({ ...frame(1), type: 0x101 })).toThrow(/type 257/);
    expect(() => encodeFrame({ ...frame(1), flags: -1 })).toThrow(/flags -1/);
  });
});

describe('decoder accounting (kdp-framing.md "Error recovery")', () => {
  it('counts one crcFailure, one resync and the two skipped magic bytes', () => {
    const decoder = new FrameDecoder();
    const bad = encodeFrame(frame(1, encodeJson({ x: 'corrupt me' }))).slice();
    bad[20] ^= 0xff;
    decoder.push(new Uint8Array([...bad, ...encodeFrame(frame(2))]));
    expect(decoder.stats.crcFailures).toBe(1);
    // One discarded frame is one resync, not two: the skip and the rescan that
    // finds the next magic are the same event seen from both ends.
    expect(decoder.stats.resyncs).toBe(1);
    // A session reporting corruption with discardedBytes at 0 reads as
    // "corruption that lost nothing", which is never true.
    expect(decoder.stats.discardedBytes).toBeGreaterThanOrEqual(2);
  });
});
