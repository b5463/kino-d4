export { defineSchema, parseVersioned, type SchemaDef } from './registry';
export { SchemaTooNewError, MissingMigrationError } from './errors';

export { deviceInfo, deviceCapabilities, type DeviceInfo, type DeviceCapabilities } from './device';
export { deviceConfig, type DeviceConfig } from './config';
export {
  capture,
  asset,
  roll,
  CAPTURE_MODES,
  CAPTURE_STATUSES,
  ROLL_STATUSES,
  ASSET_ROLES,
  type Capture,
  type Asset,
  type Roll,
} from './media';
export { firmwareManifest, type FirmwareManifest } from './firmware';
