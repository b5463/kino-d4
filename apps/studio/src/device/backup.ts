// Camera backup: one local .kino file holding everything a KINO needs to
// become itself again — settings, calibration, custom recipes, custom
// sounds. Photographs are never included; they stay on the SD card.

import { CONFIG_SCHEMA_VERSION } from '@kino/kdp';
import type { CalibrationData, DeviceInfo, KinoConfig } from '@kino/kdp';
import type { Recipe } from '../recipes/recipeTypes';
import { validateRecipe } from '../recipes/recipeTypes';

export const BACKUP_SCHEMA = 1;
export const BACKUP_KIND = 'kino-backup';

export interface BackupSound {
  id: string;
  name: string;
  durationMs: number;
  /** Device-format WAV (16 kHz mono 16-bit), base64. */
  wavBase64: string;
}

export interface KinoBackup {
  schema: number;
  kind: string;
  product: string;
  createdAt: string;
  device: {
    serial: string;
    hardware: string;
    p4Firmware: string;
    /** Absent in backups made before these fields existed. */
    cameraFirmware?: [string, string, string, string];
    protocol?: number;
  };
  /** CONFIG_SCHEMA_VERSION the config block was written under. Absent in older backups (schema-1 config). */
  configSchemaVersion?: number;
  config: KinoConfig;
  calibration: CalibrationData;
  customRecipes: Recipe[];
  /** Absent in backups made before custom sounds existed. */
  customSounds: BackupSound[];
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000; // stack-safe fromCharCode batches
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function buildBackup(
  info: DeviceInfo,
  config: KinoConfig,
  calibration: CalibrationData,
  customRecipes: Recipe[],
  customSounds: BackupSound[] = [],
): KinoBackup {
  // Roll credentials live on the camera, never in Studio persistence
  // (KinoConfig.roll doc) — the identifying block is stripped, not just the
  // token. A backup is a plaintext file people mail around.
  const cleanConfig = structuredClone(config);
  delete cleanConfig.roll;
  return {
    schema: BACKUP_SCHEMA,
    kind: BACKUP_KIND,
    product: info.product,
    createdAt: new Date().toISOString(),
    device: {
      serial: info.serial,
      hardware: info.hardware,
      p4Firmware: info.p4Firmware,
      cameraFirmware: [...info.cameraFirmware],
      protocol: info.protocol,
    },
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    config: cleanConfig,
    calibration: structuredClone(calibration),
    customRecipes: customRecipes.map((r) => structuredClone(r)),
    customSounds: customSounds.map((s) => ({ ...s })),
  };
}

export function backupFilename(info: DeviceInfo): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${info.serial}-${date}.kino`;
}

export interface BackupCheck {
  ok: boolean;
  error?: string;
  backup?: KinoBackup;
  /** Recipes that failed validation and will be skipped on restore. */
  skippedRecipes?: string[];
  /** Sounds that failed validation and will be skipped on restore. */
  skippedSounds?: string[];
}

export function validateBackup(json: unknown): BackupCheck {
  if (typeof json !== 'object' || json === null) {
    return { ok: false, error: 'Backup file is not a JSON object' };
  }
  const b = json as Partial<KinoBackup>;
  if (b.kind !== BACKUP_KIND) {
    return { ok: false, error: 'Not a KINO backup file' };
  }
  if (b.schema !== BACKUP_SCHEMA) {
    return { ok: false, error: `Unsupported backup schema ${String(b.schema)} (this KINO Studio reads schema ${BACKUP_SCHEMA})` };
  }
  if (b.product !== 'KINO') {
    return { ok: false, error: `Backup is for "${String(b.product)}", not KINO` };
  }
  if (typeof b.config !== 'object' || b.config === null || (b.config.mode !== 'wiggle' && b.config.mode !== 'quad')) {
    return { ok: false, error: 'Backup is missing a valid configuration block' };
  }
  if (typeof b.calibration !== 'object' || b.calibration === null || typeof b.calibration.cams !== 'object') {
    return { ok: false, error: 'Backup is missing a valid calibration block' };
  }
  if (!Array.isArray(b.customRecipes)) {
    return { ok: false, error: 'Backup is missing the custom recipe list' };
  }

  const validRecipes: Recipe[] = [];
  const skipped: string[] = [];
  for (const entry of b.customRecipes) {
    const check = validateRecipe(entry);
    if (check.ok) validRecipes.push(check.recipe);
    else skipped.push(typeof (entry as Recipe)?.name === 'string' ? (entry as Recipe).name : 'unnamed recipe');
  }

  // Sounds are optional — pre-sound backups simply have none. Each entry
  // must decode to a plausible WAV inside the device's 128 KB cap.
  const validSounds: BackupSound[] = [];
  const skippedSounds: string[] = [];
  const rawSounds = Array.isArray(b.customSounds) ? b.customSounds : [];
  for (const entry of rawSounds) {
    const e = entry as Partial<BackupSound> | null;
    const name = typeof e?.name === 'string' && e.name.length > 0 ? e.name : 'unnamed sound';
    try {
      if (!e || typeof e.id !== 'string' || !e.id.startsWith('snd-')) throw new Error('bad id');
      if (typeof e.wavBase64 !== 'string' || e.wavBase64.length === 0) throw new Error('no data');
      const wav = base64ToBytes(e.wavBase64);
      if (wav.length < 44 || wav.length > 128 * 1024) throw new Error('bad size');
      if (String.fromCharCode(wav[0], wav[1], wav[2], wav[3]) !== 'RIFF') throw new Error('not a WAV');
      validSounds.push({
        id: e.id,
        name: name.slice(0, 32),
        durationMs: Math.max(0, Math.round(Number(e.durationMs) || 0)),
        wavBase64: e.wavBase64,
      });
    } catch {
      skippedSounds.push(name);
    }
  }

  // Backups written before the roll-stripping fix may still carry the
  // camera's Roll identity; drop it on read so a restore can never post
  // credentials fields back through SET_CONFIG.
  const cleanConfig = structuredClone(b.config) as KinoConfig;
  delete cleanConfig.roll;

  return {
    ok: true,
    backup: { ...(b as KinoBackup), config: cleanConfig, customRecipes: validRecipes, customSounds: validSounds },
    skippedRecipes: skipped,
    skippedSounds,
  };
}
