import { describe, expect, it } from 'vitest';
import { buildZip } from '../src/utils/zip';
import { encodeGif } from '../src/utils/gif';
import { extractFirstFrameIndexed } from './gifDecode.helper';

describe('zip writer', () => {
  it('produces a well-formed archive with local, central and end records', () => {
    const zip = buildZip([
      { name: 'C1_RAW.JPG', data: new Uint8Array([1, 2, 3, 4]) },
      { name: 'metadata.json', data: new TextEncoder().encode('{"a":1}') },
    ]);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50); // local header
    // end-of-central-directory record at the tail
    const eocd = new DataView(zip.buffer, zip.length - 22);
    expect(eocd.getUint32(0, true)).toBe(0x06054b50);
    expect(eocd.getUint16(10, true)).toBe(2); // entry count
  });

  it('sanitizes traversal attempts in entry names', () => {
    const zip = buildZip([{ name: '../../evil.txt', data: new Uint8Array([65]) }]);
    const text = new TextDecoder().decode(zip);
    expect(text).not.toContain('..');
  });
});

describe('gif encoder', () => {
  it('emits a GIF89a header, loop extension and trailer', () => {
    const frame = {
      rgba: new Uint8ClampedArray(4 * 4 * 4).fill(128),
      delayMs: 100,
    };
    const gif = encodeGif(4, 4, [frame, frame]);
    expect(String.fromCharCode(...gif.subarray(0, 6))).toBe('GIF89a');
    expect(gif[gif.length - 1]).toBe(0x3b);
    // NETSCAPE application extension present
    const text = new TextDecoder('latin1').decode(gif);
    expect(text).toContain('NETSCAPE2.0');
  });

  it('roundtrips pixel data through a reference LZW decoder', () => {
    // Structured gradient image — enough dictionary churn to exercise code
    // width changes, on a 64×64 frame.
    const w = 64;
    const h = 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = (x * 4) % 256;
        rgba[i + 1] = (y * 4) % 256;
        rgba[i + 2] = ((x + y) * 2) % 256;
        rgba[i + 3] = 255;
      }
    }
    const gif = encodeGif(w, h, [{ rgba, delayMs: 100 }]);
    const decoded = extractFirstFrameIndexed(gif, w, h);
    // Recompute the expected quantized indexes and compare exactly.
    const expected = new Uint8Array(w * h);
    for (let p = 0, q = 0; q < expected.length; p += 4, q++) {
      const r = Math.round(rgba[p] / 51);
      const g = Math.round(rgba[p + 1] / 51);
      const b = Math.round(rgba[p + 2] / 51);
      expected[q] = r * 36 + g * 6 + b;
    }
    expect(decoded).toEqual(expected);
  });

  it('roundtrips noisy data large enough to overflow the 12-bit dictionary', () => {
    const w = 128;
    const h = 128;
    const rgba = new Uint8ClampedArray(w * h * 4);
    let seed = 1234;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = Math.floor(rnd() * 256);
      rgba[i + 1] = Math.floor(rnd() * 256);
      rgba[i + 2] = Math.floor(rnd() * 256);
      rgba[i + 3] = 255;
    }
    const gif = encodeGif(w, h, [{ rgba, delayMs: 100 }]);
    const decoded = extractFirstFrameIndexed(gif, w, h);
    const expected = new Uint8Array(w * h);
    for (let p = 0, q = 0; q < expected.length; p += 4, q++) {
      expected[q] =
        Math.round(rgba[p] / 51) * 36 + Math.round(rgba[p + 1] / 51) * 6 + Math.round(rgba[p + 2] / 51);
    }
    expect(decoded).toEqual(expected);
  });

  it('encodes distinguishable frames', () => {
    const black = { rgba: new Uint8ClampedArray(8 * 8 * 4).fill(0), delayMs: 50 };
    const white = { rgba: new Uint8ClampedArray(8 * 8 * 4).fill(255), delayMs: 50 };
    const gif = encodeGif(8, 8, [black, white]);
    // two image descriptors (0x2C separators)
    let descriptors = 0;
    for (let i = 0; i < gif.length; i++) {
      if (gif[i] === 0x2c && gif[i + 1] === 0 && gif[i + 2] === 0 && gif[i + 3] === 0 && gif[i + 4] === 0) descriptors++;
    }
    expect(descriptors).toBe(2);
  });
});
