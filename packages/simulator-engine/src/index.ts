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
