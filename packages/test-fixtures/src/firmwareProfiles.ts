// Firmware profiles for the reference device (issue #72).
//
// The mock has always been the demo of a finished KINO. Real firmware now
// exists, and honest emulation of it matters more than a lively demo: a
// Studio built against the demo device silently depends on commands the
// bench will NACK. A profile pins the mock to one firmware generation —
// versions, which cameras have live links, which capabilities are
// advertised, and which commands exist at all. The dispatcher and the
// capability report derive from the same profile, so they cannot drift.
import { Cmd } from '@kino/kdp';

export type FirmwareProfileId = 'd4-m1b' | 'd4-sim-full';

export interface FirmwareProfile {
  id: FirmwareProfileId;
  label: string;
  /** Brief §42: anything beyond the shipped firmware is a clearly labeled
   * simulated future, never presented as current firmware support. */
  simulatedFuture: boolean;
  p4Fw: string;
  camFw: string;
  /** CAM1..CAM4 — false reports the node offline, like an unwired UART. */
  camsOnline: [boolean, boolean, boolean, boolean];
  /** Merged over GET_CAPABILITIES.capabilities (last spread wins). Null
   * restores the mock's own derived capability report. */
  capabilities: Record<string, boolean> | null;
  maxUartBaud: number;
  /** Command ids this firmware implements; anything else answers
   * UNSUPPORTED_COMMAND. Null = the mock's full surface (demo device). */
  implementedCommands: readonly number[] | null;
}

/** The exact KDP surface of firmware/p4/main/kdp_server.c at 0.1.0 (M1B). */
export const M1B_COMMANDS: readonly number[] = [
  Cmd.HELLO,
  Cmd.GET_DEVICE_INFO,
  Cmd.GET_CAPABILITIES,
  Cmd.GET_STORAGE_STATUS,
  Cmd.GET_CAMERA_INFO,
  Cmd.CAMERA_STATUS,
  Cmd.CAMERA_TEST,
  Cmd.STORAGE_SELF_TEST,
  Cmd.CAMERA_LINK_STATS,
  Cmd.CAMERA_LINK_STATS_RESET,
  Cmd.CAMERA_SOAK_TEST,
  Cmd.GET_HW_VALIDATION,
  Cmd.GET_RUNTIME_STATS,
  Cmd.GET_LOGS,
  Cmd.CLEAR_LOGS,
  Cmd.SELF_TEST,
  Cmd.REBOOT,
];

const M1B_CAPABILITIES: Record<string, boolean> = {
  wiggle: false,
  quad: false,
  gallery: false,
  flashControl: false,
  vsyncTelemetry: false,
  phaseCalibration: false,
  xiaoProxyUpdate: false,
  linkBench: false,
  customSounds: false,
  autofocus: false,
  focusLock: false,
  manualFocus: false,
  rollUpload: false,
  network: false,
  syncBench: false,
  benchDiagnostics: true,
};

export const FIRMWARE_PROFILES: Record<FirmwareProfileId, FirmwareProfile> = {
  'd4-m1b': {
    id: 'd4-m1b',
    label: 'CURRENT FIRMWARE 0.1.0 — Milestone 1B',
    simulatedFuture: false,
    p4Fw: '0.1.0',
    camFw: '0.1.0',
    camsOnline: [true, false, false, false],
    capabilities: M1B_CAPABILITIES,
    maxUartBaud: 921600,
    implementedCommands: M1B_COMMANDS,
  },
  'd4-sim-full': {
    id: 'd4-sim-full',
    label: 'SIMULATED FUTURE — full demo device',
    simulatedFuture: true,
    p4Fw: '0.1.0',
    camFw: '0.1.0',
    camsOnline: [true, true, true, true],
    capabilities: null,
    maxUartBaud: 3_000_000,
    implementedCommands: null,
  },
};

export const FIRMWARE_PROFILE_LIST: FirmwareProfile[] = Object.values(FIRMWARE_PROFILES);

/**
 * Installed-artifact version → profile. Flashing the real repository build
 * (firmware/VERSION) onto the Twin makes it behave like that firmware —
 * including losing the FW_* surface itself, exactly as the physical M1B
 * build would.
 */
export const PROFILE_FOR_VERSION: Record<string, FirmwareProfileId> = {
  '0.1.0': 'd4-m1b',
};
