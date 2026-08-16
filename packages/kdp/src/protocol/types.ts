// Typed payloads for the KINO serial protocol. Everything here is what the
// device reports or accepts — UI-only state does not belong in this file.

export type CamId = 'cam1' | 'cam2' | 'cam3' | 'cam4';
export type TargetId = CamId | 'p4';

export const CAM_IDS: CamId[] = ['cam1', 'cam2', 'cam3', 'cam4'];
export const ALL_TARGETS: TargetId[] = ['cam1', 'cam2', 'cam3', 'cam4', 'p4'];

/** What Studio offers the device (04 §4): protocol range, nonce, version. */
export interface HelloRequest {
  protocolMin: number;
  protocolMax: number;
  nonce: number;
  client: string | null;
}

export interface HelloResponse {
  product: string;
  /** The protocol the device selected out of the offered range. */
  protocol: number;
  /** Echo of the nonce Studio sent, proving this is a live reply. */
  nonce?: number;
  /** Stable identity of the unit. Optional: older firmware omits it. */
  deviceId?: string;
  /**
   * New value on every device boot (04 §17). A different session ID on a
   * reconnect means the device rebooted and any cached state is stale.
   */
  sessionId?: string | number;
}

// ---- Capability negotiation ----
// Studio must never assume a command exists. Firmware advertises what it
// implements; unsupported features render as "not supported by firmware
// x.y.z" instead of timing out.

export interface Capabilities {
  cameraCount: number;
  wiggle: boolean;
  quad: boolean;
  gallery: boolean;
  flashControl: boolean;
  /** Firmware can report per-sensor VSYNC phase. */
  vsyncTelemetry: boolean;
  /** Firmware can re-phase sensors to align frame timelines. */
  phaseCalibration: boolean;
  /** P4 can forward firmware images to the XIAOs. */
  xiaoProxyUpdate: boolean;
  /** UART link benchmark and baud switching. */
  linkBench: boolean;
  /** Custom sound clips can be stored and used as the shutter sound. */
  customSounds: boolean;
}

export interface DeviceLimits {
  maxUartBaud: number;
  currentUartBaud: number;
  maxResolution: Resolution;
  maxGalleryPageSize: number;
}

export interface CapabilitiesResponse {
  protocol: number;
  hardware: string;
  firmware: string;
  capabilities: Capabilities;
  limits: DeviceLimits;
  configSchemaVersion: number;
}

export type CapabilityName = keyof Capabilities;

export interface DeviceInfo {
  product: string;
  hardware: string;
  serial: string;
  protocol: number;
  p4Firmware: string;
  cameraFirmware: [string, string, string, string];
  sensors: [string, string, string, string];
  sdPresent: boolean;
  sdFreeMB: number;
  activeMode: ShootMode;
  activeRecipe: string;
}

export type CameraState =
  | 'ready'
  | 'busy'
  | 'capturing'
  | 'updating'
  | 'rebooting'
  | 'timeout'
  | 'offline'
  | 'error';

export interface CameraInfo {
  id: CamId;
  online: boolean;
  /** Null when `sensorDetected` is false (04 §20 sensor-missing) — the module still answers the bus, but has nothing to report. */
  sensor: string | null;
  sensorDetected: boolean;
  firmware: string;
  state: CameraState;
  latencyMs: number;
  uartErrors: number;
  lastCapture: {
    ageS: number;
    jpegKB: number;
    durationMs: number;
    /**
     * Spread of the shared trigger edge's arrival across the four cameras.
     * NOT exposure alignment: 300 µs here is routine while the sensors were
     * 20 ms apart. It was called `skewUs`, and the same quantity was called
     * `triggerSkewUs` in capture metadata — two names, neither saying GPIO,
     * which is how it kept being read as proof of sync.
     */
    gpioSkewUs: number;
  } | null;
}

export interface PowerStatus {
  batteryV: number;
  batteryPct: number;
  state: 'battery' | 'usb' | 'charging';
  charging: boolean;
}

export interface StorageStatus {
  present: boolean;
  totalMB: number;
  freeMB: number;
}

export type ShootMode = 'wiggle' | 'quad';
export type Resolution = '1600x1200' | '2048x1536';

/** Playback loop. Bounce never jumps CAM4 → CAM1; continuous does, on purpose. */
export type WiggleLoop = 'bounce' | 'continuous' | 'sweep';
export type WiggleDirection = 'ltr' | 'rtl';

export interface WiggleConfig {
  resolution: Resolution;
  flash: boolean;
  fps: number; // 5..15 playback
  loop: WiggleLoop;
  direction: WiggleDirection;
  recipeId: string;
  previewCam: CamId;
  jpegQuality: number; // 60..95
  denoise: number; // 0..2
  sharpness: number; // 0..2
  saveOriginals: boolean;
}

export type GainStrategy = 'auto' | 'low' | 'high';
export type SlotColorMode = 'recipe' | 'mono';
export type SlotFlash = 'fire' | 'skip';

export interface QuadSlotConfig {
  recipeId: string;
  exposureBias: number; // EV, -2..+2
  gain: GainStrategy;
  flash: SlotFlash;
  colorMode: SlotColorMode;
  note: string;
}

export interface QuadConfig {
  flash: boolean;
  slots: Record<CamId, QuadSlotConfig>;
}

// General capture + body behavior (spec: Shoot settings / sounds / display).

export const BUILTIN_SHUTTER_SOUNDS = ['click', 'cheap-digi', 'tiny-beep', 'mechanical', 'silent'] as const;
export type BuiltinShutterSound = (typeof BUILTIN_SHUTTER_SOUNDS)[number];

export interface ShootConfig {
  flashMode: 'auto' | 'on' | 'off';
  viewfinder: CamId;
  previewQuality: 'low' | 'normal' | 'high';
  /** A builtin id (BUILTIN_SHUTTER_SOUNDS) or the id of an uploaded SoundInfo. */
  shutterSound: string;
  volume: number; // 0..10 master
  displayAfterShotS: number; // 0 off, 1..3 seconds, -1 hold
}

export interface BodyConfig {
  brightness: number; // 1..10
  autoDimS: number;
  sleepS: number;
  /** Camera bank power-down after inactivity, seconds. 0 = never. */
  camIdleTimeoutS: number;
  sounds: { startup: boolean; ui: boolean; save: boolean; warning: boolean };
  buttons: {
    fn: 'flash' | 'mode' | 'next-look' | 'gallery' | 'favorite';
    slide: 'power-lock' | 'mode' | 'flash';
  };
}

export interface KinoConfig {
  mode: ShootMode;
  wiggle: WiggleConfig;
  quad: QuadConfig;
  shoot: ShootConfig;
  body: BodyConfig;
}

export const CONFIG_SCHEMA_VERSION = 1;

/**
 * Configuration always travels inside a versioned envelope so a field
 * rename in firmware becomes a migration instead of a broken Studio.
 * configRevision increments on every accepted write.
 */
export interface ConfigEnvelope {
  schemaVersion: number;
  device: string;
  configRevision: number;
  config: KinoConfig;
}

export interface CamCalibration {
  ev: number; // exposure compensation, EV
  r: number; // red multiplier
  g: number; // green multiplier
  b: number; // blue multiplier
  x: number; // alignment offset, px
  y: number; // alignment offset, px
  rot: number; // rotational correction, degrees
}

export type FlashLevel = 'low' | 'medium' | 'high';
export type FlashDistance = '0.5-1' | '1-2' | '2-3';

export interface CalibrationData {
  reference: CamId;
  cams: Record<CamId, CamCalibration>;
  capturedAt: string | null;
  saved: boolean;
  /** Physical left-to-right position → logical camera. */
  order: [CamId, CamId, CamId, CamId];
  orderVerifiedAt: string | null;
  /** Measured optical centers, mm from CAM1. */
  spacingMm: [number, number, number, number];
  spacingSource: 'nominal' | 'measured';
  flash: { level: FlashLevel; distance: FlashDistance; calibratedAt: string | null };
}

export const NEUTRAL_CAL: CamCalibration = {
  ev: 0,
  r: 1,
  g: 1,
  b: 1,
  x: 0,
  y: 0,
  rot: 0,
};

export interface RuntimeStats {
  uptimeS: number;
  resetReason: string;
  freeHeapKB: number;
  freePsramKB: number;
  tempC: { p4: number; cams: [number, number, number, number] };
  protocol: {
    droppedPackets: number;
    crcFailures: number;
    cameraTimeouts: number;
    sdErrors: number;
  };
}

export type LogSource = 'P4' | 'C1' | 'C2' | 'C3' | 'C4' | 'PWR' | 'SD' | 'PROTO';

export interface LogEntry {
  t: number; // epoch ms
  src: LogSource;
  msg: string;
}

export interface SelfTestCheck {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

export interface SelfTestEvent {
  index: number;
  total: number;
  name: string;
  status: 'running' | 'pass' | 'fail' | 'skip';
  detail?: string;
  done?: boolean;
  results?: SelfTestCheck[];
}

export interface CalibrationEvent {
  step: 'capture' | 'analyze' | 'result' | 'error';
  cam?: CamId;
  message?: string;
  offsets?: Record<CamId, CamCalibration>;
}

// ---- Firmware ----

export type FwTargetState =
  | 'idle'
  | 'receiving'
  | 'verifying'
  | 'applying'
  | 'rebooting'
  | 'ready'
  | 'error';

export interface FwQueryResponse {
  targets: Record<TargetId, { version: string; state: FwTargetState }>;
}

export interface FwBeginRequest {
  target: TargetId;
  size: number;
  sha256: string;
  version: string;
}

export interface FwBeginResponse {
  sessionId: number;
  chunkSize: number;
}

export interface FwEndResponse {
  ok: boolean;
  verified: boolean;
}

export interface FwStatusResponse {
  target: TargetId;
  state: FwTargetState;
  version: string;
  error?: string;
}

export interface ProtocolError {
  code: string;
  message: string;
}

// ---- Async jobs (04 §15) ----
// Calibration, firmware, stress tests, storage checks and large exports do not
// fit a request/response deadline. The command returns a job ID immediately and
// the device reports through events that carry no sequence ID (04 §16), so the
// jobId is the only routing key.

export interface JobStartResponse {
  jobId: string;
  accepted: boolean;
}

export interface JobProgress {
  jobId: string;
  /** 0..1. */
  progress: number;
  /** Machine-readable stage, e.g. "capture" / "verify". */
  step?: string;
  message?: string;
}

/** Device error object as delivered by JOB_FAILED (04 §18). */
export interface JobFailure extends ProtocolError {
  details?: Record<string, unknown>;
  recoverable?: boolean;
  suggestedActions?: string[];
}

/** Shape is per-command, so the wire type stays open. */
export type JobResult = unknown;

export interface JobCompleteEvent {
  jobId: string;
  result?: JobResult;
}

export interface JobFailedEvent {
  jobId: string;
  error?: JobFailure;
}

// ---- Media ----

export type CaptureKind = 'wiggle' | 'quad';

export interface CaptureSummary {
  id: string; // WG_0042 / QD_0007
  kind: CaptureKind;
  ts: number; // epoch ms
  recipeIds: string[]; // 1 entry for wiggle, 4 for quad
  favorite: boolean;
  resolution: Resolution;
  totalKB: number;
}

export interface CaptureFile {
  name: string; // C1.JPG .. C4.JPG
  sizeBytes: number;
  sha256: string;
}

export interface CaptureInfo extends CaptureSummary {
  files: CaptureFile[];
  meta: {
    flash: boolean;
    batteryV: number;
    p4Firmware: string;
    cameraFirmware: string[];
    gpioSkewUs: number;
    exposure: { cam: CamId; shutter: string; gain: number }[];
  };
}

export interface MediaListRequest {
  cursor?: number;
  limit?: number;
}

export interface MediaListResponse {
  total: number;
  items: CaptureSummary[];
  nextCursor: number | null;
  hasMore: boolean;
}

export interface CaptureEvent {
  id: string;
  kind: CaptureKind;
}

export interface PhaseMeasurement {
  cam: CamId;
  /** Offset of this sensor's VSYNC from the reference camera, µs. */
  phaseUs: number;
}

export interface PhaseResult {
  cams: PhaseMeasurement[];
  spreadUs: number;
  frameIntervalUs: number;
  reference: CamId;
  /** Set once re-phasing has brought the spread inside the target. */
  aligned: boolean;
}

export interface LinkChannelResult {
  cam: CamId;
  bytes: number;
  kbytesPerSec: number;
  crcErrors: number;
  framingErrors: number;
}

export interface LinkBenchResult {
  baud: number;
  durationMs: number;
  channels: LinkChannelResult[];
  /** True only when every channel finished with zero errors. */
  clean: boolean;
  /** Concurrent = all four UARTs streaming at once (the V1 design). */
  concurrent: boolean;
}

// The envelope is the wire contract; the recipe document itself is defined by
// the app (Studio's recipeTypes today), so it stays a parameter rather than a
// dependency back into an app.
export interface RecipesResponse<R = unknown> {
  factory: R[];
  custom: R[];
}

// ---- Sounds ----
// Custom clips are stored on the device as 16 kHz mono 16-bit WAV. Studio
// converts whatever the user drops to that format before upload.

export interface SoundInfo {
  id: string; // snd-<slug>
  name: string;
  sizeBytes: number;
  durationMs: number;
}

export interface SoundsResponse {
  custom: SoundInfo[];
  maxCustom: number;
  maxSoundKB: number;
}

export interface SoundBeginRequest {
  id: string;
  name: string;
  sizeBytes: number;
  durationMs: number;
}

export interface SoundBeginResponse {
  sessionId: number;
  chunkSize: number;
}
