// Minimal reference GIF-LZW decoder used only by tests to verify that the
// encoder produces streams a standard decoder can read.

export function extractFirstFrameIndexed(gif: Uint8Array, width: number, height: number): Uint8Array {
  let pos = 6; // GIF89a
  pos += 7; // logical screen descriptor
  const packed = gif[10];
  if (packed & 0x80) pos += 3 * (1 << ((packed & 0x07) + 1)); // global color table

  // Skip extensions until the first image descriptor.
  while (pos < gif.length) {
    const b = gif[pos];
    if (b === 0x2c) break;
    if (b === 0x21) {
      pos += 2; // introducer + label
      while (gif[pos] !== 0) pos += gif[pos] + 1;
      pos += 1;
    } else {
      throw new Error(`Unexpected block 0x${b.toString(16)} at ${pos}`);
    }
  }
  if (gif[pos] !== 0x2c) throw new Error('No image descriptor found');
  pos += 10; // image descriptor (no local color table expected)

  const minCodeSize = gif[pos++];
  // Concatenate sub-blocks.
  const data: number[] = [];
  while (gif[pos] !== 0) {
    const len = gif[pos++];
    for (let i = 0; i < len; i++) data.push(gif[pos++]);
  }

  return lzwDecode(minCodeSize, Uint8Array.from(data), width * height);
}

function lzwDecode(minCodeSize: number, data: Uint8Array, pixelCount: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let size = minCodeSize + 1;
  let next = eoi + 1;
  let dict: number[][] = [];
  const resetDict = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    next = eoi + 1;
    size = minCodeSize + 1;
  };
  resetDict();

  const out = new Uint8Array(pixelCount);
  let outPos = 0;
  let bitPos = 0;
  let prev: number[] | null = null;

  const readCode = (): number => {
    let code = 0;
    for (let i = 0; i < size; i++) {
      const byte = data[bitPos >> 3];
      if (byte === undefined) return eoi;
      code |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return code;
  };

  while (outPos < pixelCount) {
    const code = readCode();
    if (code === clear) {
      resetDict();
      prev = null;
      continue;
    }
    if (code === eoi) break;

    let entry: number[];
    if (code < next && dict[code]) {
      entry = dict[code];
    } else if (code === next && prev) {
      entry = [...prev, prev[0]];
    } else {
      throw new Error(`Bad LZW code ${code} (next=${next}, size=${size})`);
    }

    for (const px of entry) {
      if (outPos < pixelCount) out[outPos++] = px;
    }

    if (prev && next < 4096) {
      dict[next++] = [...prev, entry[0]];
      if (next === 1 << size && size < 12) size++;
    }
    prev = entry;
  }
  return out;
}
