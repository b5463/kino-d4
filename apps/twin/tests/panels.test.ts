import { describe, expect, it } from 'vitest';
import { tagLabel } from '../src/panels/provenance';

describe('panel helpers', () => {
  it('keeps provenance labels blunt', () => {
    expect(tagLabel('ESTIMATED')).toBe('ESTIMATED');
    expect(tagLabel('SIMULATED')).toBe('SIMULATED');
  });
});

import { FIRMWARE_PROFILE_LIST } from '@kino/test-fixtures';
import { profileOptionLabel, profileOptions } from '../src/panels/FaultPanel';

describe('firmware profile selector', () => {
  it('lists shipped builds newest first and the simulated future last', () => {
    const ids = profileOptions().map((p) => p.id);
    expect(ids[0]).toBe('d4-settings-0-4-9');
    expect(ids[ids.length - 1]).toBe('d4-sim-full');
    expect(ids).toHaveLength(FIRMWARE_PROFILE_LIST.length);
  });

  it('names a shipped build by the version a flashed camera reports, and the demo device as simulated', () => {
    const current = FIRMWARE_PROFILE_LIST.find((p) => p.id === 'd4-settings-0-4-9')!;
    expect(profileOptionLabel(current)).toBe(`${current.p4Fw} · settings reach the hardware`);
    const future = FIRMWARE_PROFILE_LIST.find((p) => p.id === 'd4-sim-full')!;
    expect(profileOptionLabel(future)).toMatch(/^SIMULATED FUTURE · /);
  });
});
