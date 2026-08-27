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

export type FirmwareProfileId = 'd4-m1b' | 'd4-body-0-2' | 'd4-capture-0-3' | 'd4-sim-full';

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

/**
 * The exact KDP surface of `firmware/p4/main/kdp_server.c` at 0.2.0.
 *
 * M1B plus the settings store, power status, shooting modes and the read side
 * of the gallery — the commands Studio and Twin were already calling against a
 * firmware that answered `UNSUPPORTED_COMMAND` to all of them.
 */
export const BODY_0_2_COMMANDS: readonly number[] = [
  ...M1B_COMMANDS,
  Cmd.GET_POWER_STATUS,
  Cmd.GET_CONFIG,
  Cmd.SET_CONFIG,
  Cmd.SAVE_CONFIG,
  Cmd.RESET_CONFIG,
  Cmd.GET_MODES,
  Cmd.SET_MODE,
  Cmd.MEDIA_LIST,
  Cmd.MEDIA_INFO,
  Cmd.MEDIA_DELETE,
  Cmd.MEDIA_FAVORITE,
];

const BODY_0_2_CAPABILITIES: Record<string, boolean> = {
  ...M1B_CAPABILITIES,
  configStore: true,
  /** Idle dim/sleep and camera-bank power-down are implemented. */
  powerManagement: true,
  /**
   * Battery telemetry is not, and cannot be on this body: no sense divider
   * reaches the P4 and the SW6106 carrier carries no gauge, so `batteryV` and
   * `batteryPct` are null. See firmware-contract D10.
   */
  powerTelemetry: false,
  /**
   * Listing, inspecting, deleting and favouriting captures work. `gallery`
   * stays false because MEDIA_READ and MEDIA_THUMB do not exist — a client
   * that needs pixels still cannot get them.
   */
  mediaIndex: true,
};

export const CAPTURE_0_3_COMMANDS: readonly number[] = [
  ...BODY_0_2_COMMANDS,
  Cmd.CAMERA_CAPTURE,
  Cmd.MEDIA_READ,
  Cmd.MEDIA_THUMB,
];

const CAPTURE_0_3_CAPABILITIES: Record<string, boolean> = {
  ...BODY_0_2_CAPABILITIES,
  /** MEDIA_READ and MEDIA_THUMB return bytes, so pixels can leave the camera. */
  gallery: true,
  /**
   * One press captures every online camera into one folder. Both modes use
   * the same four sensors and differ only in how a host presents the frames
   * it already has, so they are true together or not at all.
   */
  wiggle: true,
  quad: true,
  /** GPIO28 is driven across the exposure window. What it drives is a bench
   * LED until the flash board exists — a hardware fact, not a firmware one. */
  flashControl: true,
  /**
   * Still false, and this is the one worth reading twice. The body pulses
   * GPIO32 on every capture and reports how far apart the four commands went
   * out, but the nodes expose on command arrival rather than on that edge,
   * and their rolling shutters free-run. All three skews in `kino.capture`
   * stay null with a reason. Dispatch spread is not exposure skew.
   */
  vsyncTelemetry: false,
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
  'd4-body-0-2': {
    id: 'd4-body-0-2',
    label: 'CURRENT FIRMWARE 0.2.0 — body, settings and power',
    simulatedFuture: false,
    p4Fw: '0.2.0',
    camFw: '0.1.0',
    /* Still one wired node: the settings and power work changed nothing about
     * how many cameras are jumpered to the P4. */
    camsOnline: [true, false, false, false],
    capabilities: BODY_0_2_CAPABILITIES,
    maxUartBaud: 921600,
    implementedCommands: BODY_0_2_COMMANDS,
  },
  'd4-capture-0-3': {
    id: 'd4-capture-0-3',
    label: 'CURRENT FIRMWARE 0.3.0 — capture pipeline and gallery',
    simulatedFuture: false,
    p4Fw: '0.3.0',
    camFw: '0.1.0',
    /* Four channels are now greeted and four workers fetch frames, but the
     * bench harness still has one node on it. What changed is that the other
     * three report offline because nothing answered, not because nothing
     * asked. */
    camsOnline: [true, false, false, false],
    capabilities: CAPTURE_0_3_CAPABILITIES,
    maxUartBaud: 921600,
    implementedCommands: CAPTURE_0_3_COMMANDS,
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
  '0.2.0': 'd4-body-0-2',
  '0.3.0': 'd4-capture-0-3',
};
