// Minimal animated GIF89a encoder: fixed 6×6×6 web-safe palette + LZW.
// Era-correct output for wigglegram export — no dependencies, runs in a
// worker-free pass because frames are small (gallery originals).

const PALETTE_SIZE = 256; // 216 web-safe colors, rest black

function buildPalette(): Uint8Array {
  const pal = new Uint8Array(PALETTE_SIZE * 3);
  let i = 0;
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        pal[i * 3] = r * 51;
        pal[i * 3 + 1] = g * 51;
        pal[i * 3 + 2] = b * 51;
        i++;
      }
    }
  }
  return pal;
}

function quantize(rgba: Uint8ClampedArray, out: Uint8Array) {
  for (let p = 0, q = 0; q < out.length; p += 4, q++) {
    const r = Math.round(rgba[p] / 51);
    const g = Math.round(rgba[p + 1] / 51);
    const b = Math.round(rgba[p + 2] / 51);
    out[q] = r * 36 + g * 6 + b;
  }
}

class ByteWriter {
  private chunks: number[] = [];
  u8(v: number) {
    this.chunks.push(v & 0xff);
  }
  u16(v: number) {
    this.chunks.push(v & 0xff, (v >> 8) & 0xff);
  }
  bytes(data: Uint8Array | number[]) {
    for (const b of data) this.chunks.push(b);
  }
  toUint8Array(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}

/**
 * GIF LZW with variable code width and 255-byte sub-blocks. Width changes
 * follow the canonical (ppmtogif-derived) ordering: a code is written at
 * the current width first, and the width grows *afterwards* once the table
 * size passes the width's ceiling — the exact behavior standard decoders
 * mirror. Dictionary keys are numeric: (prefixCode << 8) | pixel.
 */
function lzwEncode(pixels: Uint8Array, minCodeSize: number, out: ByteWriter) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let next = eoiCode + 1;
  let dict = new Map<number, number>();
  let pendingReset = false;

  const block: number[] = [];
  let cur = 0;
  let curBits = 0;

  const write = (code: number) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      block.push(cur & 0xff);
      cur >>= 8;
      curBits -= 8;
      if (block.length === 255) {
        out.u8(255);
        out.bytes(block);
        block.length = 0;
      }
    }
    // Post-write width adjustment, exactly one code later than the add.
    if (pendingReset) {
      codeSize = minCodeSize + 1;
      pendingReset = false;
    } else if (next >= 1 << codeSize && codeSize < 12) {
      codeSize++;
    }
  };

  write(clearCode);

  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    write(prefix);
    if (next < 4096) {
      dict.set(key, next++);
    } else {
      // Table full: clear code goes out at the current 12-bit width, the
      // width reset applies right after it — decoders do the same.
      pendingReset = true;
      write(clearCode);
      dict = new Map();
      next = eoiCode + 1;
    }
    prefix = k;
  }
  write(prefix);
  write(eoiCode);

  if (curBits > 0) block.push(cur & 0xff);
  if (block.length > 0) {
    out.u8(block.length);
    out.bytes(block);
  }
  out.u8(0); // block terminator
}

export interface GifFrame {
  /** RGBA pixel data, width×height×4. */
  rgba: Uint8ClampedArray;
  /** Per-frame delay in milliseconds. */
  delayMs: number;
}

export function encodeGif(width: number, height: number, frames: GifFrame[]): Uint8Array {
  const out = new ByteWriter();
  // Header + logical screen descriptor
  out.bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  out.u16(width);
  out.u16(height);
  out.u8(0xf7); // global color table, 8 bits, 256 entries
  out.u8(0);
  out.u8(0);
  out.bytes(buildPalette());

  // NETSCAPE loop-forever extension
  out.bytes([0x21, 0xff, 0x0b]);
  out.bytes([0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30]);
  out.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);

  const indexed = new Uint8Array(width * height);
  for (const frame of frames) {
    // Graphics control: delay in 1/100 s
    out.bytes([0x21, 0xf9, 0x04, 0x04]);
    out.u16(Math.max(2, Math.round(frame.delayMs / 10)));
    out.u8(0);
    out.u8(0);
    // Image descriptor
    out.u8(0x2c);
    out.u16(0);
    out.u16(0);
    out.u16(width);
    out.u16(height);
    out.u8(0);
    // Pixel data
    quantize(frame.rgba, indexed);
    out.u8(8); // LZW min code size
    lzwEncode(indexed, 8, out);
  }

  out.u8(0x3b); // trailer
  return out.toUint8Array();
}
