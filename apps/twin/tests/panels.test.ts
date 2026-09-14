import { describe, expect, it } from 'vitest';
import { tagLabel } from '../src/panels/provenance';

describe('panel helpers', () => {
  it('keeps provenance labels blunt', () => {
    expect(tagLabel('ESTIMATED')).toBe('ESTIMATED');
    expect(tagLabel('SIMULATED')).toBe('SIMULATED');
  });
});
