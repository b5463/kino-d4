import { describe, expect, it } from 'vitest';
import { buildBackup, validateBackup, bytesToBase64, base64ToBytes, BACKUP_SCHEMA } from '../src/device/backup';
import type { BackupSound } from '../src/device/backup';
import { FACTORY_RECIPES } from '@kino/test-fixtures';
import type { DeviceInfo, KinoConfig, CalibrationData } from '@kino/kdp';
import { NEUTRAL_CAL } from '@kino/kdp';
import { encodeWav, SOUND_SAMPLE_RATE } from '../src/utils/soundFx';

const info: DeviceInfo = {
  product: 'KINO',
  hardware: 'V1',
  serial: 'KINO000012',
  protocol: 1,
  p4Firmware: '0.5.0',
  cameraFirmware: ['0.5.0', '0.5.0', '0.5.0', '0.5.0'],
  sensors: ['OV3660', 'OV3660', 'OV3660', 'OV3660'],
  sdPresent: true,
  sdFreeMB: 20000,
  activeMode: 'wiggle',
  activeRecipe: 'party-neg',
};

const config: KinoConfig = {
  mode: 'wiggle',
  wiggle: {
    resolution: '1600x1200',
    flash: true,
    fps: 10,
    loop: 'bounce',
    direction: 'ltr',
    recipeId: 'party-neg',
    previewCam: 'cam2',
    jpegQuality: 86,
    denoise: 1,
    sharpness: 1,
    saveOriginals: true,
  },
  quad: {
    flash: true,
    slots: {
      cam1: { recipeId: 'party-neg', exposureBias: 0, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: '' },
      cam2: { recipeId: 'motion', exposureBias: 0, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: '' },
      cam3: { recipeId: 'raw-digi', exposureBias: 0, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: '' },
      cam4: { recipeId: 'mono', exposureBias: 0, gain: 'auto', flash: 'fire', colorMode: 'mono', note: '' },
    },
  },
  shoot: {
    flashMode: 'auto',
    viewfinder: 'cam2',
    previewQuality: 'normal',
    shutterSound: 'cheap-digi',
    volume: 6,
    displayAfterShotS: 2,
  },
  body: {
    brightness: 7,
    autoDimS: 20,
    sleepS: 120,
    camIdleTimeoutS: 180,
    sounds: { startup: true, ui: false, save: true, warning: true },
    buttons: { fn: 'flash', slide: 'mode' },
  },
};

const calibration: CalibrationData = {
  reference: 'cam2',
  cams: {
    cam1: { ...NEUTRAL_CAL, ev: 0.1 },
    cam2: { ...NEUTRAL_CAL },
    cam3: { ...NEUTRAL_CAL, x: 2 },
    cam4: { ...NEUTRAL_CAL, rot: -0.2 },
  },
  capturedAt: '2026-08-13T10:00:00.000Z',
  saved: true,
  order: ['cam1', 'cam2', 'cam3', 'cam4'],
  orderVerifiedAt: null,
  spacingMm: [0, 19, 38, 57],
  spacingSource: 'nominal',
  flash: { level: 'medium', distance: '1-2', calibratedAt: null },
};

const customRecipe = { ...JSON.parse(JSON.stringify(FACTORY_RECIPES[0])), id: 'my-party', name: 'My Party', factory: false };

describe('backup round trip', () => {
  it('builds a backup that validates', () => {
    const backup = buildBackup(info, config, calibration, [customRecipe]);
    expect(backup.schema).toBe(BACKUP_SCHEMA);
    const check = validateBackup(JSON.parse(JSON.stringify(backup)));
    expect(check.ok).toBe(true);
    expect(check.backup?.customRecipes).toHaveLength(1);
    expect(check.backup?.config.wiggle.fps).toBe(10);
    expect(check.skippedRecipes).toHaveLength(0);
  });

  it('rejects a non-backup JSON file', () => {
    expect(validateBackup({ hello: 'world' }).ok).toBe(false);
  });

  it('rejects the wrong product', () => {
    const backup = buildBackup(info, config, calibration, []);
    expect(validateBackup({ ...backup, product: 'OtherCam' }).ok).toBe(false);
  });

  it('rejects a future schema instead of guessing', () => {
    const backup = buildBackup(info, config, calibration, []);
    expect(validateBackup({ ...backup, schema: 99 }).ok).toBe(false);
  });

  it('skips invalid recipes but keeps the rest', () => {
    const backup = buildBackup(info, config, calibration, [customRecipe]);
    const tampered = JSON.parse(JSON.stringify(backup));
    tampered.customRecipes.push({ id: 'BROKEN!!', name: 'Broken' });
    const check = validateBackup(tampered);
    expect(check.ok).toBe(true);
    expect(check.backup?.customRecipes).toHaveLength(1);
    expect(check.skippedRecipes).toHaveLength(1);
  });
});

function testSound(id: string, durationMs = 200): BackupSound {
  const frames = Math.round((SOUND_SAMPLE_RATE * durationMs) / 1000);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / SOUND_SAMPLE_RATE) * 0.4;
  return { id, name: id.slice(4), durationMs, wavBase64: bytesToBase64(encodeWav(samples, SOUND_SAMPLE_RATE)) };
}

describe('custom sounds in backups', () => {
  it('base64 helpers round-trip binary data', () => {
    const bytes = new Uint8Array(70000).map((_, i) => (i * 37 + 11) & 0xff);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips sounds through a backup file', () => {
    const snd = testSound('snd-zap', 300);
    const backup = buildBackup(info, config, calibration, [], [snd]);
    const check = validateBackup(JSON.parse(JSON.stringify(backup)));
    expect(check.ok).toBe(true);
    expect(check.backup?.customSounds).toHaveLength(1);
    expect(check.backup?.customSounds[0]).toEqual(snd);
    expect(check.skippedSounds).toHaveLength(0);
  });

  it('accepts a pre-sound backup with no customSounds field', () => {
    const backup = buildBackup(info, config, calibration, [customRecipe]);
    const old = JSON.parse(JSON.stringify(backup));
    delete old.customSounds;
    const check = validateBackup(old);
    expect(check.ok).toBe(true);
    expect(check.backup?.customSounds).toEqual([]);
  });

  it('skips tampered sounds but keeps valid ones', () => {
    const backup = buildBackup(info, config, calibration, [], [testSound('snd-good')]);
    const tampered = JSON.parse(JSON.stringify(backup));
    tampered.customSounds.push(
      { id: 'click', name: 'builtin id', durationMs: 100, wavBase64: tampered.customSounds[0].wavBase64 },
      { id: 'snd-garbage', name: 'not base64', durationMs: 100, wavBase64: '!!!not-base64!!!' },
      { id: 'snd-noriff', name: 'not a wav', durationMs: 100, wavBase64: bytesToBase64(new Uint8Array(100)) },
      { id: 'snd-huge', name: 'too big', durationMs: 100, wavBase64: bytesToBase64(new Uint8Array(200 * 1024)) },
    );
    const check = validateBackup(tampered);
    expect(check.ok).toBe(true);
    expect(check.backup?.customSounds).toHaveLength(1);
    expect(check.backup?.customSounds[0].id).toBe('snd-good');
    expect(check.skippedSounds).toEqual(['builtin id', 'not base64', 'not a wav', 'too big']);
  });
});
