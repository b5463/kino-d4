// KINO Twin simulator's own event stream — sits above MockKinoDevice's raw
// KDP wire and telemetry tap. SimEvent adds the boot-stage machine and the
// capture choreography timeline the 3D view renders, plus a pass-through of
// every device telemetry event. Studio never sees any of this; it only ever
// reads the KDP bytes the device writes to its sink (§10/§20).
import type { CamId } from '@kino/kdp';
import type { TwinTelemetry } from '@kino/test-fixtures';
import type { PowerSample } from './power';

export const BOOT_STAGES = [
  'POWER_OFF',
  'BOOTING_P4',
  'CAMERA_RAIL_START',
  'CAMERA_NODES_BOOT',
  'STORAGE_MOUNT',
  'NETWORK_INIT',
  'READY',
] as const; // §12
export type BootStage = (typeof BOOT_STAGES)[number];

export const CAPTURE_STAGES = [
  'IDLE',
  'ARMING',
  'WAIT_SYNC',
  'EXPOSING',
  'JPEG_READY',
  'TRANSFERRING',
  'STORED',
  'READY',
] as const; // §13
export type CaptureStage = (typeof CAPTURE_STAGES)[number];

export type SimEvent =
  | { t: 'boot'; stage: BootStage }
  | { t: 'cam-stage'; cam: CamId; stage: CaptureStage }
  | { t: 'sync-pulse' }
  | { t: 'uart'; cam: CamId; active: boolean; bytesPerSec: number }
  | { t: 'device'; telemetry: TwinTelemetry } // forwarded, see TwinSimulator
  | { t: 'power'; sample: PowerSample }; // §7/§15, 2 Hz — see TwinSimulator.samplePower
