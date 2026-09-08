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

/** Initial pending-byte capacity. One full frame fits without a grow. */
const INITIAL_CAPACITY = 1 << 15;

export class FrameDecoder {
  /**
   * Pending bytes live in a reused buffer between `head` and `tail`.
   *
   * The previous implementation allocated `pending + arrival` and copied the
   * whole pending buffer on every read, then `slice`d it again for each
   * partial frame. An 8,210-byte frame arriving in 64-byte USB reads cost
   * ~128 copies averaging ~4 kB — about half a megabyte of copying per frame.
   * Appending into spare capacity and advancing `head` instead makes the cost
   * linear in the bytes received. The wire format, the resync rules and every
   * counter below are unchanged.
   */
  private buf = new Uint8Array(INITIAL_CAPACITY);
  private view = new DataView(this.buf.buffer);
  /** First byte not yet consumed. */
  private head = 0;
  /** One past the last valid byte. */
  private tail = 0;

  readonly stats: DecoderStats = {
    frames: 0,
    crcFailures: 0,
    resyncs: 0,
    discardedBytes: 0,
  };

  reset(): void {
    this.head = 0;
    this.tail = 0;
  }

  /**
   * Make room for `need` more bytes: slide the pending bytes down to offset 0,
   * and only allocate when they genuinely do not fit.
   */
  private append(data: Uint8Array): void {
    if (data.length === 0) return;
    if (this.buf.length - this.tail < data.length) {
      const pending = this.tail - this.head;
      if (pending + data.length > this.buf.length) {
        let cap = this.buf.length;
        while (cap < pending + data.length) cap *= 2;
        const next = new Uint8Array(cap);
        next.set(this.buf.subarray(this.head, this.tail));
        this.buf = next;
        this.view = new DataView(next.buffer);
      } else if (this.head > 0) {
        this.buf.set(this.buf.subarray(this.head, this.tail), 0);
      }
      this.head = 0;
      this.tail = pending;
    }
    this.buf.set(data, this.tail);
    this.tail += data.length;
  }

  /** Feed raw bytes; returns every complete, CRC-valid frame found. */
  push(data: Uint8Array): Frame[] {
    this.append(data);

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

    // `offset` and `start` are both relative to `head`, so the arithmetic
    // below reads exactly as it did when the pending bytes were their own
    // array. `head` is only advanced on the paths that used to reslice.
    while (true) {
      const pending = this.tail - this.head;
      // Scan for magic.
      let start = -1;
      for (let i = offset; i + 1 < pending; i++) {
        if (this.buf[this.head + i] === MAGIC0 && this.buf[this.head + i + 1] === MAGIC1) {
          start = i;
          break;
        }
      }
      if (start === -1) {
        // Keep at most the final byte (could be the first half of a magic).
        const keep = pending > 0 && this.buf[this.tail - 1] === MAGIC0 ? 1 : 0;
        this.stats.discardedBytes += pending - keep - offset > 0 ? pending - keep - offset : 0;
        this.head = this.tail - keep;
        return frames;
      }
      if (start > offset) {
        this.stats.discardedBytes += start - offset;
        if (!resyncCounted) this.stats.resyncs++;
      }
      resyncCounted = false;

      if (pending - start < HEADER_LEN) {
        this.head += start;
        return frames;
      }

      const at = this.head + start;
      const payloadLen = this.view.getUint32(at + 10, true);

      if (payloadLen > MAX_PAYLOAD) {
        // Corrupt length — skip past this magic and rescan.
        this.stats.resyncs++;
        this.stats.discardedBytes += 2;
        resyncCounted = true;
        offset = start + 2;
        continue;
      }

      const total = HEADER_LEN + payloadLen + CRC_LEN;
      if (pending - start < total) {
        this.head += start;
        return frames;
      }

      const expected = this.view.getUint32(at + HEADER_LEN + payloadLen, true);
      const actual = crc32(this.buf.subarray(at, at + HEADER_LEN + payloadLen));

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
        version: this.buf[at + 2],
        type: this.buf[at + 3],
        flags: this.buf[at + 4],
        seq: this.view.getUint32(at + 6, true),
        // A copy, not a view: the pending buffer is reused, so a view would
        // be overwritten by the next arriving read.
        payload: this.buf.slice(at + HEADER_LEN, at + HEADER_LEN + payloadLen),
      });
      this.stats.frames++;
      offset = start + total;

      if (offset >= pending) {
        this.head = this.tail;
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
