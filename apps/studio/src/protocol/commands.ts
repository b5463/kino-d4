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

  // Diagnostics
  GET_LOGS = 0x40,
  CLEAR_LOGS = 0x41,
  SELF_TEST = 0x42,
  GET_RUNTIME_STATS = 0x43,
  /** Per-channel UART stress test at the current or a candidate baud. */
  LINK_BENCH = 0x44,
  SET_LINK_BAUD = 0x45,

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

  // Media (gallery access through the P4 file server)
  MEDIA_LIST = 0x70,
  MEDIA_INFO = 0x71,
  MEDIA_THUMB = 0x72,
  MEDIA_READ = 0x73,
  MEDIA_DELETE = 0x74,
  MEDIA_FAVORITE = 0x75,
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
}

export enum FrameFlags {
  NONE = 0x00,
  RESPONSE = 0x01,
  EVENT = 0x02,
  ERROR = 0x04,
  BINARY = 0x08,
}
