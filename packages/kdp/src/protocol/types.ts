// Typed payloads for the KINO serial protocol. Everything here is what the
// device reports or accepts — UI-only state does not belong in this file.

export type CamId = 'cam1' | 'cam2' | 'cam3' | 'cam4';
/**
 * Everything on the body that carries its own firmware image.
 *
 * `c6` is the radio coprocessor on the Guition carrier. It was added because
 * the D4 has a sixth image and `FW_QUERY` could not name it: a C6 running an
 * out-of-date hosted-slave image is a second thing that can be stale in the
 * field, and a version model that cannot report it cannot diagnose it.
 *
 * Additive. `ALL_TARGETS` gains a member; nothing that reads a specific target
 * changes. A device that has no C6, or has one it cannot reach, reports the
 * target with an empty `version` — see FwQueryResponse.
 */
export type TargetId = CamId | 'p4' | 'c6';

export const CAM_IDS: CamId[] = ['cam1', 'cam2', 'cam3', 'cam4'];
export const ALL_TARGETS: TargetId[] = ['cam1', 'cam2', 'cam3', 'cam4', 'p4', 'c6'];

/** What Studio offers the device (04 §4): protocol range, nonce, version. */
export interface HelloRequest {
  protocolMin: number;
  protocolMax: number;
  nonce: number;
  client: string | null;
  /**
   * The host's wall clock, so the device can date the pictures it takes.
   *
   * Optional and additive. The D4 has no RTC, no battery-backed clock and no
   * network, so HELLO is the only moment it can learn the date — and a device
   * that is never told keeps saying its timestamps are unset rather than
   * inventing one. Firmware rejects anything outside 2020..2100, which is
   * what a seconds-for-milliseconds mix-up looks like.
   */
  hostEpochMs?: number;
  /** The host's offset from UTC, so the device can write local time. Omitted
   * means the device writes +00:00 rather than guessing a timezone. */
  hostUtcOffsetMin?: number;
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
  /**
   * What the device's clock is worth right now.
   *
   * `host` — a host set it this session. `persisted` — restored across a power
   * cycle and drifting, so it is a lower bound rather than a reading.
   * `unset` — the device has never been told the time and its timestamps are
   * uptime since the epoch. Absent on firmware without a clock at all.
   */
  clockSource?: 'host' | 'persisted' | 'unset';
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
  /**
   * Network / Roll command group (KDP 0xa0–0xa9). `network` covers
   * NETWORK_LIST/SET/DELETE/STATUS; `roll` covers ROLL_* and the upload
   * queue. Both optional: firmware without the group omits them, and
   * absence is an answer, not an unknown.
   *
   * `rollUpload` is the third flag of the group. It is deliberately NOT
   * declared here — it shipped before this interface was settled and is
   * still read off the reported object by `supportsRollUpload`; typing it
   * now would silently change that gate's shape.
   */
  network?: boolean;
  roll?: boolean;
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
  /**
   * CAMERA_ARM accepted: the sensor is primed and waiting for the shared
   * trigger edge. Not `busy` — an armed camera has nothing to do but wait,
   * and one still armed after a burst missed the trigger rather than ran
   * slow. Exits are the capture itself and the arm timeout; there is no
   * CAMERA_DISARM (firmware-contract/commands.md records why).
   */
  | 'armed'
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

/**
 * STORAGE_BENCH request. Sustained throughput, not a health check —
 * STORAGE_SELF_TEST already answers "does the card work".
 */
export interface StorageBenchRequest {
  /** Total payload written per pass. */
  sizeMB: number;
  /** Write unit. The burst path writes whole JPEGs; block size decides stalls. */
  blockKB: number;
  passes: number;
}

export interface StorageBenchResult {
  writeMBs: number;
  readMBs: number;
  /**
   * Slowest single block across every pass. This is the number that decides a
   * four-frame burst: the burst stalls on its worst block, and an average
   * hides exactly the event that drops a frame.
   */
  worstBlockMs: number;
  p95BlockMs: number;
  /** Bytes actually written, so the rates can be checked against the clock. */
  bytes: number;
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
  /**
   * Worst successful request RTT since the last counter reset, in ms. The
   * bench needs the tail and not the latest sample: a link that stalls once
   * in fifty requests reads as healthy every time you look at the last one.
   */
  latencyMaxMs: number;
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

/**
 * GET_MODES (0x20). The modes this device will accept in SET_MODE, so a host
 * does not have to assume the whole `ShootMode` union is available. Firmware
 * that ships one mode answers a one-element list rather than NACKing.
 */
export interface GetModesResponse {
  modes: ShootMode[];
}

/**
 * CAMERA_ARM (0x31). `armWindowMs` is how long the sensors stay primed before
 * they fall back to `ready`. The host needs the number: there is no
 * CAMERA_DISARM, so the window and the capture are the only two exits.
 */
export interface CameraArmResponse {
  ok: boolean;
  armWindowMs: number;
}
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
  /** Die temperatures from the real on-chip sensors. Null = no reading
   * available (node offline, sensor unsupported) — never a fabricated
   * number. Milestone 1B firmware reports p4 and cam1; cam2-4 arrive with
   * their links. */
  tempC: { p4: number | null; cams: [number | null, number | null, number | null, number | null] };
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
  /**
   * Monotonic microseconds since the device booted (`esp_timer_get_time()`).
   *
   * Additive and optional; older firmware omits it. `t` keeps its meaning
   * unchanged — epoch milliseconds from the device's wall clock, which is
   * 1970-era until a host sets it and can jump when one does.
   *
   * Use `t` to say WHEN. Use `us` to say in WHAT ORDER, and how far apart:
   * during camera bring-up a UART command going out, a node answering and a
   * worker being released can all fall inside one millisecond, and at
   * millisecond resolution the log claims they were simultaneous.
   *
   * No epoch is shared with anything — not with `t`, not with another device,
   * not across a reboot. Only differences within one device's run mean
   * anything.
   */
  us?: number;
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

/**
 * What each image on the body is running.
 *
 * An empty `version` means the device could not read one — a camera node that
 * has never answered, or a C6 the host has no transport to. It does NOT mean
 * version zero, and a consumer must not render it as one. `state` describes an
 * update in progress, so a target that is merely unreachable is `idle` with an
 * empty version rather than `error`: nothing has failed, nothing was tried.
 */
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
    /** Alignment calibration as it was at the shutter press. Optional and
     * additive (no protocol version bump): current firmware does not record
     * it — a consumer that finds it absent falls back to live calibration
     * and must never invent offsets. `version` identifies the calibration
     * state that produced these numbers. */
    calibration?: {
      version: string;
      cams: Partial<Record<CamId, { x: number; y: number; rot: number }>>;
    };
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
  /** Additive; absent on firmware that predates the capture pipeline. */
  captureUuid?: string;
  /** `complete` when every online camera stored a frame, `partial` when some
   * did not. A host that ignores this discovers a missing frame on download
   * instead of at the shutter. */
  status?: 'complete' | 'partial';
  frameCount?: number;
  /** What fired it: `shutter`, `shutter-hold`, `button`, or `host`. */
  triggeredBy?: string;
}

/**
 * MEDIA_READ / MEDIA_THUMB — bytes out of one file in a capture.
 *
 * The reply is the raw file bytes with KDP_FLAG_BINARY set, not JSON: a
 * 300 KB JPEG through base64 would cost a third again in transfer for
 * nothing. The caller knows the offset and length it asked for, so a reply
 * shorter than `length` means end of file. Errors are JSON with the ERROR
 * flag, so the two are never ambiguous.
 */
export interface MediaReadRequest {
  id: string;
  /** `C1.JPG`..`C4.JPG`, `THUMB.JPG` or `META.JSON`. Defaults to `C1.JPG`.
   * An allow-list on the device; anything else is BAD_REQUEST. */
  file?: string;
  offset?: number;
  /** Clamped by the device to what one frame can carry (8192 bytes). */
  length?: number;
}

/**
 * MEDIA_THUMB reads THUMB.JPG, which the device writes at capture time.
 *
 * Paged the same way as MEDIA_READ, for the same reason: a thumbnail is small
 * but not bounded, and a noisy frame can encode past MAX_PAYLOAD. Omitting
 * `offset` and `length` asks for the first 8192 bytes, which is the whole
 * file for any ordinary thumbnail — so the common case is still one round
 * trip and a reply shorter than the cap still means end of file.
 *
 * A capture from firmware that predates thumbnails answers NOT_FOUND, and the
 * client falls back to MEDIA_READ of a frame.
 */
export interface MediaThumbRequest {
  id: string;
  offset?: number;
  length?: number;
}

/**
 * CAMERA_CAPTURE — the product's own shutter, over the wire.
 *
 * The body of the reply is a `kino.capture` v1 document, the same one written
 * to the card as META.JSON, plus the figures that only matter to whoever
 * asked for the capture.
 *
 * `dispatchSpreadUs` (inside `timing`) is how far apart the four capture
 * commands went out. It is NOT any of the three skews, all of which stay null
 * with a reason: the nodes expose on command arrival rather than on a trigger
 * edge, and a free-running rolling shutter's exposure has no fixed
 * relationship to either.
 */
export interface CameraCaptureResult {
  /** The whole reply for a client that only needs to know it worked. */
  ok: true;
  schema: 'kino.capture';
  version: 1;
  id: string;
  captureUuid: string;
  deviceId: string;
  mode: string;
  capturedAt: string;
  clockSource: 'host' | 'persisted' | 'unset';
  frameCount: number;
  resolution: string;
  status: 'complete' | 'partial';
  timing: {
    gpioTriggerSkewUs: null;
    vsyncPhaseSkewUs: null;
    effectiveExposureSkewUs: null;
    unavailableReason: string;
    dispatchSpreadUs: number;
  };
  frames: {
    cam: CamId;
    file: string | null;
    bytes?: number;
    crc32?: string;
    error?: string;
  }[];
  dir: string;
  bytes: number;
  totalMs: number;
  camerasOnline: number;
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
