// Frame layout (little-endian):
//   MAGIC       2   "KI"
//   VERSION     1
//   TYPE        1
//   FLAGS       1
//   RESERVED    1
//   SEQUENCE    4
//   PAYLOAD_LEN 4
//   PAYLOAD     n
//   CRC32       4   over header + payload
//
// The decoder is a byte-stream state machine: it never assumes one serial
// read equals one frame, resynchronizes on the magic after corruption, and
// caps payload length so a garbled length field cannot stall the stream.

import { FrameFlags } from './commands';
import { crc32 } from './crc32';

export const MAGIC0 = 0x4b; // 'K'
export const MAGIC1 = 0x49; // 'I'
export const HEADER_LEN = 14;
export const CRC_LEN = 4;
export const MAX_PAYLOAD = 16384; // fw chunks up to 8192 + header slack
/** Highest sequence a request may carry. */
export const MAX_SEQ = 0xffffffff;

/**
 * The sequence after `seq`. Wraps to 1, never to 0: sequence 0 is the events'
 * sentinel, and a counter that overflowed naturally would start minting
 * requests that look like events to anything reading the field literally. No
 * real session runs long enough to wrap — the rule exists so host and
 * firmware wrap the same way instead of each meeting overflow on its own.
 */
export function nextSeq(seq: number): number {
  return seq >= MAX_SEQ ? 1 : seq + 1;
}

export interface Frame {
  version: number;
  type: number;
  flags: number;
  seq: number;
  payload: Uint8Array;
}

/** True for an integer that fits one header byte. */
function isByte(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}

export function encodeFrame(frame: Frame): Uint8Array {
  const len = frame.payload.length;
  // A frame past MAX_PAYLOAD is undecodable on the other end — the decoder
  // resyncs past it — so the failure would surface as a silent timeout.
  // Failing loud turns a protocol-invariant bug into a stack trace.
  if (len > MAX_PAYLOAD) {
    throw new Error(`KDP payload ${len} B exceeds MAX_PAYLOAD ${MAX_PAYLOAD}`);
  }
  // Same reasoning as the length guard, applied to the rest of the header.
  //
  // `seq` 0 is the events' sentinel, and legal on an EVENT frame only — the
  // reference device writes 0 there and the client ignores the field. On
  // anything else it is a bug with no symptom: the peer dispatches the frame
  // to its event path, no response is ever routed back, and the caller sees a
  // bare timeout. Anything past MAX_SEQ is silently truncated by `setUint32`,
  // so a caller that overflowed its own counter would ship a frame carrying a
  // sequence it is not waiting on.
  const isEvent = (frame.flags & FrameFlags.EVENT) !== 0;
  if (!Number.isInteger(frame.seq) || frame.seq < 0 || frame.seq > MAX_SEQ) {
    throw new Error(`KDP sequence ${frame.seq} outside 0..${MAX_SEQ}`);
  }
  if (frame.seq === 0 && !isEvent) {
    throw new Error("KDP sequence 0 is the events' sentinel; a request or response must use 1..MAX_SEQ");
  }
  // version/type/flags each occupy one byte. `Uint8Array` assignment wraps
  // mod 256 without complaint, so 0x101 would encode as type 0x01 — a frame
  // the peer dispatches to the wrong handler rather than rejecting.
  for (const [name, value] of [
    ['version', frame.version],
    ['type', frame.type],
    ['flags', frame.flags],
  ] as const) {
    if (!isByte(value)) throw new Error(`KDP ${name} ${value} outside 0..255`);
  }
  const buf = new Uint8Array(HEADER_LEN + len + CRC_LEN);
  const view = new DataView(buf.buffer);
  buf[0] = MAGIC0;
  buf[1] = MAGIC1;
  buf[2] = frame.version;
  buf[3] = frame.type;
  buf[4] = frame.flags;
  buf[5] = 0;
  view.setUint32(6, frame.seq >>> 0, true);
  view.setUint32(10, len, true);
  buf.set(frame.payload, HEADER_LEN);
  const crc = crc32(buf.subarray(0, HEADER_LEN + len));
  view.setUint32(HEADER_LEN + len, crc, true);
  return buf;
}

export interface DecoderStats {
  frames: number;
  crcFailures: number;
  resyncs: number;
  discardedBytes: number;
}

export class FrameDecoder {
  private buf = new Uint8Array(0);
  readonly stats: DecoderStats = {
    frames: 0,
    crcFailures: 0,
    resyncs: 0,
    discardedBytes: 0,
  };

  reset(): void {
    this.buf = new Uint8Array(0);
  }

  /** Feed raw bytes; returns every complete, CRC-valid frame found. */
  push(data: Uint8Array): Frame[] {
    if (data.length > 0) {
      const merged = new Uint8Array(this.buf.length + data.length);
      merged.set(this.buf);
      merged.set(data, this.buf.length);
      this.buf = merged;
    }

    const frames: Frame[] = [];
    let offset = 0;
    /**
     * Set when this pass has already counted a resync for a frame it threw
     * away — a garbled length, a failed CRC. The magic scan below counts a
     * resync when a later magic proves bytes were skipped, which for a
     * discarded frame is the same event seen twice: one bad frame would report
     * two resyncs, and kdp-framing.md says one.
     */
    let resyncCounted = false;

    while (true) {
      // Scan for magic.
      let start = -1;
      for (let i = offset; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === MAGIC0 && this.buf[i + 1] === MAGIC1) {
          start = i;
          break;
        }
      }
      if (start === -1) {
        // Keep at most the final byte (could be the first half of a magic).
        const keep = this.buf.length > 0 && this.buf[this.buf.length - 1] === MAGIC0 ? 1 : 0;
        this.stats.discardedBytes += this.buf.length - keep - offset > 0 ? this.buf.length - keep - offset : 0;
        this.buf = this.buf.slice(this.buf.length - keep);
        return frames;
      }
      if (start > offset) {
        this.stats.discardedBytes += start - offset;
        if (!resyncCounted) this.stats.resyncs++;
      }
      resyncCounted = false;

      if (this.buf.length - start < HEADER_LEN) {
        this.buf = this.buf.slice(start);
        return frames;
      }

      const view = new DataView(this.buf.buffer, this.buf.byteOffset + start);
      const payloadLen = view.getUint32(10, true);

      if (payloadLen > MAX_PAYLOAD) {
        // Corrupt length — skip past this magic and rescan.
        this.stats.resyncs++;
        this.stats.discardedBytes += 2;
        resyncCounted = true;
        offset = start + 2;
        continue;
      }

      const total = HEADER_LEN + payloadLen + CRC_LEN;
      if (this.buf.length - start < total) {
        this.buf = this.buf.slice(start);
        return frames;
      }

      const frameBytes = this.buf.subarray(start, start + total);
      const expected = new DataView(
        frameBytes.buffer,
        frameBytes.byteOffset + HEADER_LEN + payloadLen,
      ).getUint32(0, true);
      const actual = crc32(frameBytes.subarray(0, HEADER_LEN + payloadLen));

      if (expected !== actual) {
        this.stats.crcFailures++;
        this.stats.resyncs++;
        // The two magic bytes are gone from the stream as surely as they are
        // in the over-length branch, and were not counted — a session could
        // report crcFailures with discardedBytes still at 0, which reads as
        // "corruption with nothing lost".
        this.stats.discardedBytes += 2;
        resyncCounted = true;
        offset = start + 2; // resync just past the magic
        continue;
      }

      frames.push({
        version: frameBytes[2],
        type: frameBytes[3],
        flags: frameBytes[4],
        seq: view.getUint32(6, true),
        payload: frameBytes.slice(HEADER_LEN, HEADER_LEN + payloadLen),
      });
      this.stats.frames++;
      offset = start + total;

      if (offset >= this.buf.length) {
        this.buf = new Uint8Array(0);
        return frames;
      }
    }
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeJson(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value ?? {}));
}

export function decodeJson<T>(payload: Uint8Array): T {
  if (payload.length === 0) return {} as T;
  return JSON.parse(textDecoder.decode(payload)) as T;
}
