import { describe, expect, it } from 'vitest';
import { parseManifest, checkCompatibility, canonicalHardwareId, sameHardware } from '../src/firmware/manifest';
import type { FwManifest } from '../src/firmware/manifest';
import type { DeviceInfo } from '@kino/kdp';

const SHA = 'a'.repeat(64);

const goodManifest = {
  schema: 1,
  product: 'kino-v1',
  version: '0.5.0',
  protocol: 1,
  p4: { version: '0.5.0', file: 'p4-app.bin', sha256: SHA },
  xiao: { version: '0.5.0', file: 'xiao-app.bin', sha256: SHA },
  compatibility: { hardware: ['v1'], minimumProtocol: 1 },
};

const device: DeviceInfo = {
  product: 'KINO',
  hardware: 'V1',
  serial: 'KINO000001',
  protocol: 1,
  p4Firmware: '0.1.0',
  cameraFirmware: ['0.1.0', '0.1.0', '0.1.0', '0.1.0'],
  sensors: ['OV3660', 'OV3660', 'OV3660', 'OV3660'],
  sdPresent: true,
  sdFreeMB: 1000,
  activeMode: 'wiggle',
  activeRecipe: 'party-neg',
};

describe('manifest validation', () => {
  it('accepts a valid manifest', () => {
    expect(parseManifest(goodManifest).ok).toBe(true);
  });

  it('rejects the wrong product', () => {
    const r = parseManifest({ ...goodManifest, product: 'other-cam' });
    expect(r.ok).toBe(false);
  });

  it('rejects a malformed sha256', () => {
    const r = parseManifest({ ...goodManifest, p4: { ...goodManifest.p4, sha256: 'nope' } });
    expect(r.ok).toBe(false);
  });

  it('rejects a missing compatibility block', () => {
    const { compatibility: _omitted, ...rest } = goodManifest;
    expect(parseManifest(rest).ok).toBe(false);
  });
});

describe('compatibility check', () => {
  it('passes matching hardware and protocol', () => {
    expect(checkCompatibility(goodManifest as FwManifest, device).ok).toBe(true);
  });

  it('is case-insensitive on hardware revision', () => {
    const m = { ...goodManifest, compatibility: { hardware: ['V1'], minimumProtocol: 1 } };
    expect(checkCompatibility(m as FwManifest, device).ok).toBe(true);
  });

  it('blocks a package needing a newer protocol', () => {
    const m = { ...goodManifest, compatibility: { hardware: ['v1'], minimumProtocol: 3 } };
    const r = checkCompatibility(m as FwManifest, device);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
  });

  it('blocks mismatched hardware', () => {
    const m = { ...goodManifest, compatibility: { hardware: ['v2'], minimumProtocol: 1 } };
    expect(checkCompatibility(m as FwManifest, device).ok).toBe(false);
  });
});

describe('hardware id spellings', () => {
  // The same board under four names: GET_DEVICE_INFO says `V1`,
  // GET_CAPABILITIES says `kino-v1`, hardware/REVISION says `D4-V1`, and a
  // catalog manifest says whatever the publisher typed.
  const spellings = ['V1', 'v1', 'kino-v1', 'D4-V1', 'KINO-V1', ' d4-v1 '];

  it('collapses every accepted spelling to one canonical id', () => {
    for (const s of spellings) expect(canonicalHardwareId(s), s).toBe('v1');
    expect(canonicalHardwareId('V2')).toBe('v2');
    expect(canonicalHardwareId('D4-V2')).toBe('v2');
    expect(sameHardware('kino-v1', 'D4-V1')).toBe(true);
    expect(sameHardware('kino-v1', 'D4-V2')).toBe(false);
  });

  it('accepts a package for this board under any of them', () => {
    for (const manifestSpelling of spellings) {
      for (const deviceSpelling of spellings) {
        const m = { ...goodManifest, compatibility: { hardware: [manifestSpelling], minimumProtocol: 1 } };
        const d = { ...device, hardware: deviceSpelling };
        expect(checkCompatibility(m as FwManifest, d).ok, `${manifestSpelling} vs ${deviceSpelling}`).toBe(true);
      }
    }
  });

  it('still refuses a different board however it is spelled', () => {
    const m = { ...goodManifest, compatibility: { hardware: ['D4-V2', 'kino-v3'], minimumProtocol: 1 } };
    const r = checkCompatibility(m as FwManifest, { ...device, hardware: 'kino-v1' });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain('this KINO is kino-v1');
  });

  it('reads the product line under the same rule', () => {
    expect(parseManifest({ ...goodManifest, product: 'KINO-V1' }).ok).toBe(true);
    expect(parseManifest({ ...goodManifest, product: 'kino-v2' }).ok).toBe(false);
  });
});
