// KINO serial protocol command/event identifiers.
// Keep numeric values in sync with firmware protocol.h.

export const PROTOCOL_VERSION = 1;

export enum Cmd {
  // Discovery
  HELLO = 0x01,
  GET_DEVICE_INFO = 0x02,
  GET_CAMERA_INFO = 0x03,
  GET_POWER_STATUS = 0x04,
  GET_STORAGE_STATUS = 0x05,
  GET_CAPABILITIES = 0x06,

  // Configuration
  GET_CONFIG = 0x10,
  SET_CONFIG = 0x11,
  SAVE_CONFIG = 0x12,
  RESET_CONFIG = 0x13,

  // Shooting
  GET_MODES = 0x20,
  SET_MODE = 0x21,
  GET_RECIPES = 0x22,
  SET_RECIPE = 0x23,
  UPLOAD_RECIPE = 0x24,
  DELETE_RECIPE = 0x25,

  // Sounds. Custom clips exceed one frame (MAX_PAYLOAD), so upload is a
  // chunked session like firmware: BEGIN → CHUNK* → END.
  GET_SOUNDS = 0x26,
  SOUND_BEGIN = 0x27,
  SOUND_CHUNK = 0x28,
  SOUND_END = 0x29,
  SOUND_READ = 0x2a,
  SOUND_DELETE = 0x2b,

  // Camera
  CAMERA_STATUS = 0x30,
  CAMERA_ARM = 0x31,
  CAMERA_TEST = 0x32,
  CAMERA_CAPTURE = 0x33,
  CAMERA_PREVIEW = 0x34,
  CAMERA_CALIBRATE = 0x35,
  /** VSYNC phase measurement and re-phasing. */
  CAMERA_PHASE = 0x36,
  /**
   * Focus control (audit #55) — requires the `autofocus` capability; firmware
   * without it NACKs UNSUPPORTED_COMMAND. Actions: trigger (AF sweep on every
   * AF camera), lock/unlock, set (manual VCM position, `manualFocus`),
   * mode (party-auto | party-fixed | manual), store-fixed (persist the
   * current locked positions as the PARTY FIXED calibration).
   */
  CAMERA_FOCUS = 0x37,

  // Diagnostics
  GET_LOGS = 0x40,
  CLEAR_LOGS = 0x41,
  SELF_TEST = 0x42,
  GET_RUNTIME_STATS = 0x43,
  /** Per-channel UART stress test at the current or a candidate baud. */
  LINK_BENCH = 0x44,
  SET_LINK_BAUD = 0x45,
  /**
   * Skew Bench: fire N triggers and report per-camera timing for each. An
   * async job (04 §15) — hundreds of triggers outlive any request deadline.
   */
  SYNC_BENCH = 0x46,

  // Milestone 1B bench diagnostics (issue #66). Gated by the
  // `benchDiagnostics` capability; firmware without it NACKs
  // UNSUPPORTED_COMMAND.
  /** Non-destructive SD write/read-back/verify; reports the failing phase. */
  STORAGE_SELF_TEST = 0x47,
  /** Per-camera UART link counters (frames, bytes, CRC errors, timeouts). */
  CAMERA_LINK_STATS = 0x48,
  CAMERA_LINK_STATS_RESET = 0x49,
  /**
   * Repeated single-camera capture loop. An async job (04 §15): N captures
   * outlive any request deadline; result is a SoakTestSummary.
   */
  CAMERA_SOAK_TEST = 0x4a,
  /** Runtime hardware-validation registry: what this unit has bench-proven. */
  GET_HW_VALIDATION = 0x4b,
  /**
   * Sustained SD write/read throughput with per-block timing. STORAGE_SELF_TEST
   * proves the card works; this says whether it keeps up. A four-frame burst
   * stalls on the slowest block, so `worstBlockMs` is the number that decides
   * the burst — the average hides it.
   */
  STORAGE_BENCH = 0x4c,

  // Maintenance
  ENTER_MAINTENANCE = 0x50,
  EXIT_MAINTENANCE = 0x51,
  REBOOT = 0x52,
  FACTORY_RESET = 0x53,

  // Firmware
  FW_QUERY = 0x60,
  FW_BEGIN = 0x61,
  FW_CHUNK = 0x62,
  FW_END = 0x63,
  FW_ABORT = 0x64,
  FW_STATUS = 0x65,
  /**
   * Reserved, not implemented: return to the previous OTA slot. The contract
   * — slot state machine, NACK codes, and why V1 ships without it — is in
   * docs/RELEASE_TRUST.md. The number is held here so it cannot be reused and
   * so no UI is built against an invented shape: M1B firmware has a single
   * application partition, so there is no previous slot to return to.
   */
  FW_ROLLBACK = 0x66,

  // Media (gallery access through the P4 file server)
  MEDIA_LIST = 0x70,
  MEDIA_INFO = 0x71,
  MEDIA_THUMB = 0x72,
  MEDIA_READ = 0x73,
  MEDIA_DELETE = 0x74,
  MEDIA_FAVORITE = 0x75,

  // Network / Roll (04 §7). Deliberately above the event range so a command
  // id and an event id can never collide in a protocol trace.
  NETWORK_LIST = 0xa0,
  NETWORK_SET = 0xa1,
  NETWORK_DELETE = 0xa2,
  NETWORK_STATUS = 0xa3,
  ROLL_STATUS = 0xa4,
  ROLL_CREATE = 0xa5,
  ROLL_JOIN = 0xa6,
  ROLL_LEAVE = 0xa7,
  UPLOAD_QUEUE_STATUS = 0xa8,
  UPLOAD_QUEUE_RETRY = 0xa9,
  /**
   * Queue one capture already on the SD card for upload to the active Roll
   * (02 §16 "push to Roll"). Only meaningful while the device is on a Roll —
   * there is nowhere else for the bytes to go.
   */
  UPLOAD_ENQUEUE = 0xaa,
}

// Unsolicited frames pushed by the device (FrameFlags.EVENT set).
export enum Evt {
  LOG = 0x80,
  STATUS = 0x81,
  FW_PROGRESS = 0x82,
  CALIBRATION = 0x83,
  SELF_TEST = 0x84,
  /** A new capture was committed to the SD card. Payload: { id, kind }. */
  CAPTURE = 0x85,
  /** Sensor re-phasing progress. */
  PHASE = 0x86,

  // Async job model (04 §15). These carry no request sequence ID (04 §16) —
  // the jobId in the payload is the only thing tying them to a caller.
  JOB_PROGRESS = 0x87,
  JOB_COMPLETE = 0x88,
  JOB_FAILED = 0x89,
}

export enum FrameFlags {
  NONE = 0x00,
  RESPONSE = 0x01,
  EVENT = 0x02,
  ERROR = 0x04,
  BINARY = 0x08,
}
