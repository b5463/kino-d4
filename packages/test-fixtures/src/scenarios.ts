// Fault injection switches for the demo device. The debug panel toggles
// these; the mock device reads them when composing responses.
//
// The first twelve are the mock requirements of 04 §19 and carry the spec's
// own names. The next block predates that list and stays because Studio's
// simulator panel and its degradation paths are built on them. The final
// block is the KINO Twin spec's §20 fault-injection list — device-wide
// conditions (link/handshake/roll/storage/power). Per-camera faults
// (offline, power-open, sensor-missing, no-vsync, slow-uart, crc-noise) are
// a separate mechanism — see `CamFault` below — because they target one of
// four cameras rather than the whole device.

export interface ScenarioFlags {
  // ---- 04 §19 ----

  /** Every response leaves the device as several partial writes. */
  splitFrames: boolean;
  /** Responses are buffered and flushed several-per-write. */
  coalescedFrames: boolean;
  /** Corrupt the CRC of the next response frame (one-shot). */
  badCrc: boolean;
  /** Emit an ESP32 boot banner (raw ASCII, no framing) before the next reply. */
  bootSpew: boolean;
  /** Every command answers ~10x slower, near the client's timeout. */
  delayedResponses: boolean;
  /** Firmware that NACKs the whole optional command surface. */
  unsupportedCommands: boolean;
  /** Drop the link without warning (one-shot), like a yanked USB cable. */
  disconnect: boolean;
  /** Fail the next CAM3 firmware transfer at ~60% (one-shot). */
  failedUpdate: boolean;
  /** CAM1 stops answering the P4 camera bus entirely. */
  offlineCameraNode: boolean;
  /** Reboot with a fresh session ID (one-shot) — 04 §17 stale-state detection. */
  sessionRestart: boolean;
  /** Gallery holds 2,000+ captures instead of the 22-shot demo party. */
  largeGallery2k: boolean;
  /** Roll upload queue starts backed up and drains over simulated time. */
  uploadBacklog: boolean;

  // ---- pre-§19 simulator faults ----

  /** CAM2 stalls: per-camera commands time out, status shows TIMEOUT. */
  cam2Timeout: boolean;
  /** Battery at 9%, no charger. */
  lowBattery: boolean;
  /** SD card removed. */
  sdMissing: boolean;
  /** Report an early firmware: no VSYNC telemetry, phase cal or link bench. */
  legacyFirmware: boolean;

  // ---- KINO Twin §20 fault injection ----

  /** Ignore the next HELLO after attach (one-shot) — 04 §12 boot glitch. */
  dropFirstHello: boolean;
  /** HELLO answers protocol 99 instead of the real version — 04 §12. */
  protocolMismatch: boolean;
  /** Storage reports 0 MB free; captures NACK SD_FULL. */
  sdFull: boolean;
  /** Battery reports 3.55 V and dips a further 0.25 V during a capture. */
  batterySag: boolean;
  /** Power status reports the fuse blown; the device force-closes like a dead rail. */
  fuseBlown: boolean;
  /** NETWORK_STATUS reports disconnected regardless of any saved network. */
  wifiLost: boolean;
  /** ROLL_STATUS reports the upload server unreachable. */
  rollServerUnreachable: boolean;
  /** ROLL_STATUS reports a token-expired auth state; uploads stall. */
  rollTokenExpired: boolean;
  /** Capture proceeds with the flash skipped, logged rather than fired. */
  flashUnavailable: boolean;
  /** The flash calibration test reports a driver fault and a thermal flag. */
  flashOverload: boolean;
  /** CAM4 reports firmware 0.0.9 and GET_CAPABILITIES notes the mismatch. */
  nodeFwMismatch: boolean;
  /** CAM3's VSYNC phase jumps to 31,000 µs — visible in the phase snapshot. */
  vsyncOffsetLarge: boolean;
}

/**
 * Faults that live on one camera rather than the whole device (KINO Twin
 * §20). Set with `MockKinoDevice.setCamFault`, read with `.camFault`.
 * `offline`/`power-open` take the camera off the bus entirely; the rest
 * degrade a still-answering camera in a specific, narrow way.
 */
export type CamFault = 'offline' | 'power-open' | 'sensor-missing' | 'no-vsync' | 'slow-uart' | 'crc-noise';

export type ScenarioKey = keyof ScenarioFlags;

export interface ScenarioDescriptor {
  key: ScenarioKey;
  label: string;
  /** Fires once and disarms itself rather than staying on. */
  oneShot: boolean;
  /** What the device does while this is armed. */
  describe: string;
}

const descriptor = (
  key: ScenarioKey,
  label: string,
  oneShot: boolean,
  describe: string,
): ScenarioDescriptor => ({ key, label, oneShot, describe });

/**
 * The scenario registry. Keyed by scenario name so a consumer can look one up
 * (`scenarios.uploadBacklog`) and so the 04 §19 coverage check is a key check.
 */
export const scenarios = {
  splitFrames: descriptor('splitFrames', 'SPLIT FRAMES', false, 'each response is written in several fragments'),
  coalescedFrames: descriptor('coalescedFrames', 'COALESCED FRAMES', false, 'several responses arrive in one read'),
  badCrc: descriptor('badCrc', 'BAD CRC (NEXT FRAME)', true, 'next response carries a corrupt CRC'),
  bootSpew: descriptor('bootSpew', 'BOOT SPEW', false, 'unframed ESP32 boot banner precedes replies'),
  delayedResponses: descriptor('delayedResponses', 'DELAYED RESPONSES', false, 'every command answers near the timeout'),
  unsupportedCommands: descriptor('unsupportedCommands', 'UNSUPPORTED COMMANDS', false, 'the optional command surface NACKs'),
  disconnect: descriptor('disconnect', 'DISCONNECT', true, 'the link drops without a reboot'),
  failedUpdate: descriptor('failedUpdate', 'FAIL NEXT CAM3 UPDATE', true, 'the next CAM3 flash write fails at ~60%'),
  offlineCameraNode: descriptor('offlineCameraNode', 'CAM1 OFFLINE', false, 'CAM1 never answers the camera bus'),
  sessionRestart: descriptor('sessionRestart', 'SESSION RESTART', true, 'the device reboots with a new session ID'),
  largeGallery2k: descriptor('largeGallery2k', 'LARGE GALLERY (2K)', false, 'the SD card holds 2,000+ captures'),
  uploadBacklog: descriptor('uploadBacklog', 'UPLOAD BACKLOG', false, 'the roll upload queue starts backed up'),

  cam2Timeout: descriptor('cam2Timeout', 'CAM2 TIMEOUT', false, 'CAM2 answers too late, or not at all'),
  lowBattery: descriptor('lowBattery', 'LOW BATTERY', false, 'the pack reports 3.42 V'),
  sdMissing: descriptor('sdMissing', 'SD MISSING', false, 'no card is mounted'),
  legacyFirmware: descriptor('legacyFirmware', 'LEGACY FIRMWARE 0.1.0', false, 'pre-timing firmware without the optional features'),

  dropFirstHello: descriptor('dropFirstHello', 'DROP FIRST HELLO', true, 'the next HELLO after attach goes unanswered'),
  protocolMismatch: descriptor('protocolMismatch', 'PROTOCOL MISMATCH', false, 'HELLO answers protocol 99'),
  sdFull: descriptor('sdFull', 'SD FULL', false, 'the card reports 0 MB free; captures NACK SD_FULL'),
  batterySag: descriptor('batterySag', 'BATTERY SAG', false, 'the pack reports 3.55 V and dips further under load'),
  fuseBlown: descriptor('fuseBlown', 'FUSE BLOWN', false, 'power status reports the fuse blown; the link drops like a dead rail'),
  wifiLost: descriptor('wifiLost', 'WIFI LOST', false, 'NETWORK_STATUS reports disconnected'),
  rollServerUnreachable: descriptor('rollServerUnreachable', 'ROLL SERVER UNREACHABLE', false, 'ROLL_STATUS reports the upload server unreachable'),
  rollTokenExpired: descriptor('rollTokenExpired', 'ROLL TOKEN EXPIRED', false, 'ROLL_STATUS reports a token-expired auth state; uploads stall'),
  flashUnavailable: descriptor('flashUnavailable', 'FLASH UNAVAILABLE', false, 'capture proceeds with the flash skipped'),
  flashOverload: descriptor('flashOverload', 'FLASH OVERLOAD', false, 'the flash test reports a driver fault and a thermal flag'),
  nodeFwMismatch: descriptor('nodeFwMismatch', 'NODE FW MISMATCH', false, 'CAM4 reports firmware 0.0.9, capabilities note the mismatch'),
  vsyncOffsetLarge: descriptor('vsyncOffsetLarge', 'VSYNC OFFSET LARGE', false, "CAM3's VSYNC phase jumps to 31,000 us"),
} satisfies Record<ScenarioKey, ScenarioDescriptor>;

/** The twelve 04 §19 mock requirements, in spec order. */
export const SPEC_SCENARIO_KEYS = [
  'splitFrames',
  'coalescedFrames',
  'badCrc',
  'bootSpew',
  'delayedResponses',
  'unsupportedCommands',
  'disconnect',
  'failedUpdate',
  'offlineCameraNode',
  'sessionRestart',
  'largeGallery2k',
  'uploadBacklog',
] as const satisfies readonly ScenarioKey[];

export const SCENARIO_LIST: ScenarioDescriptor[] = Object.values(scenarios);

export const DEFAULT_SCENARIOS: ScenarioFlags = Object.fromEntries(
  SCENARIO_LIST.map((s) => [s.key, false]),
) as unknown as ScenarioFlags;
