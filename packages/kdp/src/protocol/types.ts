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
  /**
   * OV5640_AF capability group (audit #55). Absent on OV3660 firmware — the
   * whole focus surface disappears with it. Never assume these from the
   * sensor name; the firmware declares what it actually drives.
   */
  autofocus?: boolean;
  /** AF can lock the lens for a capture group (Wiggle: focus → lock → arm → capture). */
  focusLock?: boolean;
  /** The VCM position can be set directly (MANUAL mode). */
  manualFocus?: boolean;
  /**
   * Milestone 1B bench diagnostics (issue #66): STORAGE_SELF_TEST,
   * CAMERA_LINK_STATS(_RESET), CAMERA_SOAK_TEST, GET_HW_VALIDATION, and the
   * extended CAMERA_TEST / GET_STORAGE_STATUS payloads. Optional: firmware
   * predating 1B omits it.
   */
  benchDiagnostics?: boolean;
}

/** Focus modes (audit #55). PARTY AUTO: AF then lock then capture. PARTY
 * FIXED: the stored calibrated position for common party distance. MANUAL:
 * direct lens position. Continuous per-camera AF is deliberately absent —
 * four independently hunting lenses destroy Wiggle frame consistency. */
export type FocusMode = 'party-auto' | 'party-fixed' | 'manual';

export type FocusState = 'idle' | 'searching' | 'locked' | 'failed';

export interface CameraFocus {
  mode: FocusMode;
  state: FocusState;
  /** VCM step position, null until the lens has been driven. */
  vcmPosition: number | null;
  /** Estimated subject distance in meters; null when unknown/unmeasured. */
  estimatedDistanceM: number | null;
  /** Locked for the capture group. */
  locked: boolean;
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
  /** Present only on autofocus sensors (capability `autofocus`); undefined
   * on OV3660 modules — absence means "this camera has no focus to report". */
  focus?: CameraFocus;
}

export interface PowerStatus {
  batteryV: number;
  batteryPct: number;
  state: 'battery' | 'usb' | 'charging';
  charging: boolean;
  /** Charge current in amps when a charger is attached (audit #57). */
  chargingA?: number;
  /** The 5 V rail as the firmware measures it. Optional — a firmware without
   * a rail ADC omits it, and Studio shows '—' rather than inventing 5.00. */
  busV?: number;
  /** Fuse state when the firmware can sense it. */
  fuse?: 'ok' | 'blown';
}

export interface StorageStatus {
  present: boolean;
  totalMB: number;
  freeMB: number;
  // Milestone 1B diagnostics (benchDiagnostics capability). All optional —
  // older firmware omits them; present/totalMB/freeMB stay the stable core.
  mounted?: boolean;
  /** e.g. "FAT32". Null when unknown or not mounted. */
  filesystem?: string | null;
  capacityBytes?: number;
  freeBytes?: number;
  /** Last mount/IO error as a short code or message; null when none. */
  lastError?: string | null;
  /** Mount attempts since boot, successful or not. */
  mountAttempts?: number;
  /** Result of the most recent STORAGE_SELF_TEST this boot. */
  writeTestStatus?: 'none' | 'pass' | 'fail';
}

// ---- Milestone 1B bench diagnostics (issue #66) ----
// Gated by the `benchDiagnostics` capability. These measure the single-camera
// path; none of them are exposure/sync telemetry and none may be reported as
// skew.

export type StorageSelfTestPhase =
  | 'POWER_ENABLE_FAILED'
  | 'MOUNT_FAILED'
  | 'WRITE_FAILED'
  | 'READ_FAILED'
  | 'VERIFY_FAILED'
  | 'REMOVE_FAILED';

export interface StorageSelfTestResult {
  ok: boolean;
  /** The exact failing phase, null on success. */
  failedPhase: StorageSelfTestPhase | null;
  durationMs: number;
  bytesTested: number;
  message?: string;
}

export interface CameraLinkStats {
  cam: CamId;
  baud: number;
  connected: boolean;
  rxFrames: number;
  txFrames: number;
  rxBytes: number;
  txBytes: number;
  crcErrors: number;
  decoderResyncs: number;
  timeouts: number;
  /** Request retries performed by the P4. Zero until a retry policy exists. */
  retries: number;
  /** Responses whose sequence id was already answered. */
  duplicateFrames: number;
  lastSequence: number;
  /** Node-reported reset reason from its last HELLO; null when never seen. */
  lastNodeBootReason: string | null;
  lastError: string | null;
}

/** Per-stage bench timing for one diagnostic capture. Wall-clock buckets on
 * the P4 side — NOT exposure timing, never a skew figure. */
export interface CaptureTiming {
  requestToNodeMs: number;
  captureCommandToJpegReadyMs: number;
  jpegTransferMs: number;
  sdWriteMs: number;
  totalMs: number;
}

/** CRC-32 (IEEE, same polynomial as KDP framing) as 8 lowercase hex chars. */
export interface CaptureChecksums {
  nodeJpegCrc32: string;
  transferCrc32: string;
  storedFileCrc32: string;
  /** True only when all three agree. */
  match: boolean;
}

export interface MemoryStats {
  p4HeapKBBefore: number;
  p4HeapKBAfter: number;
  p4PsramKBBefore: number;
  p4PsramKBAfter: number;
  /** Node-reported figures; null when the node did not report them. */
  nodeHeapKB: number | null;
  nodePsramKB: number | null;
}

/** CAMERA_TEST response with benchDiagnostics. `jpegKB` and `durationMs`
 * remain for pre-1B consumers; `durationMs` equals `timing.totalMs`. */
export interface CameraTestResult {
  ok: boolean;
  cam: CamId;
  captureUuid: string;
  captureId: string;
  resolution: string;
  jpegBytes: number;
  jpegKB: number;
  durationMs: number;
  timing: CaptureTiming;
  checksums: CaptureChecksums;
  memory: MemoryStats;
}

export interface SoakTestRequest {
  cam: CamId;
  /** Clamped by the device; the reference clamps to 1–1000. */
  captures: number;
  /** Delay between captures; the reference clamps to 100–60000 ms. */
  delayMs: number;
  resolution?: Resolution;
  jpegQuality?: number;
  /** false (default): keep first and last capture, delete the rest as the
   * run progresses; failed captures are always kept for inspection. */
  keepAll?: boolean;
}

/** JOB_COMPLETE result of CAMERA_SOAK_TEST. Min/max/avg are null when no
 * capture succeeded. `p4Resets` is 0 by construction — a P4 reset ends the
 * job with a session change instead of completing it. */
export interface SoakTestSummary {
  cam: CamId;
  attempted: number;
  successful: number;
  failed: number;
  crcErrors: number;
  timeouts: number;
  nodeResets: number;
  p4Resets: number;
  sdErrors: number;
  minJpegBytes: number | null;
  maxJpegBytes: number | null;
  avgJpegBytes: number | null;
  minCaptureReadyMs: number | null;
  maxCaptureReadyMs: number | null;
  avgCaptureReadyMs: number | null;
  minTransferMs: number | null;
  maxTransferMs: number | null;
  avgTransferMs: number | null;
  minSdWriteMs: number | null;
  maxSdWriteMs: number | null;
  avgSdWriteMs: number | null;
  heapDeltaKB: number;
  psramDeltaKB: number;
  firstCaptureUuid: string | null;
  lastCaptureUuid: string | null;
  /** Failure codes with occurrence counts, e.g. {code:"TRANSFER_TIMEOUT",count:2}. */
  errors: { code: string; count: number }[];
}

export type HwValidationStatus = 'unvalidated' | 'validated' | 'failed' | 'not-applicable';

/** One entry of the runtime hardware-validation registry. An item becomes
 * `validated` only when the corresponding real event happened on this unit —
 * compile-time configuration is never validation. */
export interface HwValidationItem {
  id: string;
  status: HwValidationStatus;
  detail?: string;
}

export interface HwValidationReport {
  p4ResetReason: string;
  items: HwValidationItem[];
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
  /** Flash pulse start relative to the trigger, ms. Optional — firmware
   * without configurable flash timing omits it (default 0). */
  flashDelayMs?: number;
  /** Flash pulse duration, ms (default 1.0). Whether a given delay/duration
   * covers every camera's exposure is what the flash-timing bench measures. */
  flashDurationMs?: number;
  /** Focus mode for the group (only meaningful with the `autofocus` capability). */
  focusMode?: FocusMode;
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
  /** Roll credentials live on the camera, never in Studio persistence. */
  roll?: {
    credentials?: {
      deviceId: string;
      /** Write-only on SET_CONFIG; omitted from GET_CONFIG and backups. */
      deviceToken?: string;
      hasDeviceToken?: boolean;
      serverUrl: string;
    };
  };
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
  /** PARTY FIXED focus position for this camera (VCM steps), stored by the
   * device from a locked AF result. Absent without the autofocus capability. */
  focusPosition?: number | null;
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
