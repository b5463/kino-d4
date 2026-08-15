import { describe, expect, it } from 'vitest';
import { crc32 } from '../src/protocol/crc32';

describe('crc32', () => {
  it('matches the IEEE 802.3 check value for "123456789"', () => {
    const data = new TextEncoder().encode('123456789');
    expect(crc32(data)).toBe(0xcbf43926);
  });

  it('returns 0 for empty input xor-neutral behaviour', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('is order sensitive', () => {
    expect(crc32(new Uint8Array([1, 2]))).not.toBe(crc32(new Uint8Array([2, 1])));
  });
});
