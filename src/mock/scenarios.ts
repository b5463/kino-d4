// Fault injection switches for the demo device. The debug panel toggles
// these; the mock device reads them when composing responses.

export interface ScenarioFlags {
  /** CAM1 stops answering the P4 camera bus entirely. */
  cam1Offline: boolean;
  /** CAM2 stalls: per-camera commands time out, status shows TIMEOUT. */
  cam2Timeout: boolean;
  /** Battery at 9%, no charger. */
  lowBattery: boolean;
  /** SD card removed. */
  sdMissing: boolean;
  /** Corrupt the CRC of the next response frame (one-shot). */
  crcErrorNext: boolean;
  /** Fail the next CAM3 firmware transfer at ~60% (one-shot). */
  fwFailCam3: boolean;
  /** Report an early firmware: no VSYNC telemetry, phase cal or link bench. */
  legacyFirmware: boolean;
}

export const DEFAULT_SCENARIOS: ScenarioFlags = {
  cam1Offline: false,
  cam2Timeout: false,
  lowBattery: false,
  sdMissing: false,
  crcErrorNext: false,
  fwFailCam3: false,
  legacyFirmware: false,
};

export interface ScenarioDescriptor {
  key: keyof ScenarioFlags;
  label: string;
  oneShot: boolean;
}

export const SCENARIO_LIST: ScenarioDescriptor[] = [
  { key: 'cam1Offline', label: 'CAM1 OFFLINE', oneShot: false },
  { key: 'cam2Timeout', label: 'CAM2 TIMEOUT', oneShot: false },
  { key: 'lowBattery', label: 'LOW BATTERY', oneShot: false },
  { key: 'sdMissing', label: 'SD MISSING', oneShot: false },
  { key: 'crcErrorNext', label: 'CRC ERROR (NEXT FRAME)', oneShot: true },
  { key: 'fwFailCam3', label: 'FAIL NEXT CAM3 UPDATE', oneShot: true },
  { key: 'legacyFirmware', label: 'LEGACY FIRMWARE 0.1.0', oneShot: false },
];
