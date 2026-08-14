import { describe, expect, it } from 'vitest';
import { parseManifest, checkCompatibility } from '../src/firmware/manifest';
import type { FwManifest } from '../src/firmware/manifest';
import type { DeviceInfo } from '../src/protocol/types';

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
