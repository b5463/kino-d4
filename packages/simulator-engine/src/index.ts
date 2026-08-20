// @kino/simulator-engine — TwinSimulator: boot machine + capture choreography
// layered over @kino/test-fixtures' MockKinoDevice, for the KINO Twin's 3D view.

export { TwinSimulator } from './TwinSimulator';
export { choreographCapture, type TimelineEvent } from './choreography';
export {
  BOOT_STAGES,
  CAPTURE_STAGES,
  type BootStage,
  type CaptureStage,
  type SimEvent,
} from './events';
export {
  computePower,
  ACTIVITY_PRESETS,
  type ActivityState,
  type PowerWarning,
  type PowerSample,
} from './power';
export { thermalStep, type ThermalState, type ThermalZone, type ThermalStepResult } from './thermal';
export { flashBandRisk, type FlashRisk } from './flashRisk';
export {
  SimRecorder,
  simSessionDoc,
  base64ToBytes,
  type SimSessionDoc,
  type SimSessionEvent,
} from './recorder';
export { replaySession, verifyReplay } from './replay';
export { TwinDeviceServer } from './TwinDeviceServer';
