// KDP command/event identifiers. Numeric values are normative and mirror
// packages/kdp/src/protocol/commands.ts — that file is the source of truth
// (firmware-contract/README.md, authority table). Do not renumber here.
#ifndef KDP_PROTOCOL_H
#define KDP_PROTOCOL_H

#define KDP_PROTOCOL_VERSION 1

// Commands (host -> device request TYPE, echoed on the response).
typedef enum {
  // Discovery
  KDP_CMD_HELLO = 0x01,
  KDP_CMD_GET_DEVICE_INFO = 0x02,
  KDP_CMD_GET_CAMERA_INFO = 0x03,
  KDP_CMD_GET_POWER_STATUS = 0x04,
  KDP_CMD_GET_STORAGE_STATUS = 0x05,
  KDP_CMD_GET_CAPABILITIES = 0x06,

  // Configuration
  KDP_CMD_GET_CONFIG = 0x10,
  KDP_CMD_SET_CONFIG = 0x11,
  KDP_CMD_SAVE_CONFIG = 0x12,
  KDP_CMD_RESET_CONFIG = 0x13,

  // Shooting
  KDP_CMD_GET_MODES = 0x20,
  KDP_CMD_SET_MODE = 0x21,
  KDP_CMD_GET_RECIPES = 0x22,
  KDP_CMD_SET_RECIPE = 0x23,
  KDP_CMD_UPLOAD_RECIPE = 0x24,
  KDP_CMD_DELETE_RECIPE = 0x25,

  // Sounds
  KDP_CMD_GET_SOUNDS = 0x26,
  KDP_CMD_SOUND_BEGIN = 0x27,
  KDP_CMD_SOUND_CHUNK = 0x28,
  KDP_CMD_SOUND_END = 0x29,
  KDP_CMD_SOUND_READ = 0x2a,
  KDP_CMD_SOUND_DELETE = 0x2b,

  // Camera
  KDP_CMD_CAMERA_STATUS = 0x30,
  KDP_CMD_CAMERA_ARM = 0x31,
  KDP_CMD_CAMERA_TEST = 0x32,
  KDP_CMD_CAMERA_CAPTURE = 0x33,
  KDP_CMD_CAMERA_PREVIEW = 0x34,
  KDP_CMD_CAMERA_CALIBRATE = 0x35,
  KDP_CMD_CAMERA_PHASE = 0x36,
  KDP_CMD_CAMERA_FOCUS = 0x37,

  // Diagnostics
  KDP_CMD_GET_LOGS = 0x40,
  KDP_CMD_CLEAR_LOGS = 0x41,
  KDP_CMD_SELF_TEST = 0x42,
  KDP_CMD_GET_RUNTIME_STATS = 0x43,
  KDP_CMD_LINK_BENCH = 0x44,
  KDP_CMD_SET_LINK_BAUD = 0x45,
  KDP_CMD_SYNC_BENCH = 0x46,
  // Milestone 1B bench diagnostics (issue #66), capability `benchDiagnostics`.
  KDP_CMD_STORAGE_SELF_TEST = 0x47,
  KDP_CMD_CAMERA_LINK_STATS = 0x48,
  KDP_CMD_CAMERA_LINK_STATS_RESET = 0x49,
  KDP_CMD_CAMERA_SOAK_TEST = 0x4a,
  KDP_CMD_GET_HW_VALIDATION = 0x4b,

  // Maintenance
  KDP_CMD_ENTER_MAINTENANCE = 0x50,
  KDP_CMD_EXIT_MAINTENANCE = 0x51,
  KDP_CMD_REBOOT = 0x52,
  KDP_CMD_FACTORY_RESET = 0x53,

  // Firmware
  KDP_CMD_FW_QUERY = 0x60,
  KDP_CMD_FW_BEGIN = 0x61,
  KDP_CMD_FW_CHUNK = 0x62,
  KDP_CMD_FW_END = 0x63,
  KDP_CMD_FW_ABORT = 0x64,
  KDP_CMD_FW_STATUS = 0x65,

  // Media
  KDP_CMD_MEDIA_LIST = 0x70,
  KDP_CMD_MEDIA_INFO = 0x71,
  KDP_CMD_MEDIA_THUMB = 0x72,
  KDP_CMD_MEDIA_READ = 0x73,
  KDP_CMD_MEDIA_DELETE = 0x74,
  KDP_CMD_MEDIA_FAVORITE = 0x75,

  // Network / Roll / upload queue. Deliberately above the event range so a
  // command id and an event id can never collide in a protocol trace.
  KDP_CMD_NETWORK_LIST = 0xa0,
  KDP_CMD_NETWORK_SET = 0xa1,
  KDP_CMD_NETWORK_DELETE = 0xa2,
  KDP_CMD_NETWORK_STATUS = 0xa3,
  KDP_CMD_ROLL_STATUS = 0xa4,
  KDP_CMD_ROLL_CREATE = 0xa5,
  KDP_CMD_ROLL_JOIN = 0xa6,
  KDP_CMD_ROLL_LEAVE = 0xa7,
  KDP_CMD_UPLOAD_QUEUE_STATUS = 0xa8,
  KDP_CMD_UPLOAD_QUEUE_RETRY = 0xa9,
  KDP_CMD_UPLOAD_ENQUEUE = 0xaa,
} kdp_cmd_t;

// Events (device -> host, unsolicited, KDP_FLAG_EVENT set, sequence 0).
// KDP_EVT_SELF_TEST (0x84) and KDP_CMD_SELF_TEST (0x42) share a name in the
// TS enums; the KDP_CMD_/KDP_EVT_ prefixes are the required namespacing.
typedef enum {
  KDP_EVT_LOG = 0x80,
  KDP_EVT_STATUS = 0x81,       // id allocated, payload unspecified — do not emit
  KDP_EVT_FW_PROGRESS = 0x82,  // id allocated, payload unspecified — do not emit
  KDP_EVT_CALIBRATION = 0x83,
  KDP_EVT_SELF_TEST = 0x84,
  KDP_EVT_CAPTURE = 0x85,
  KDP_EVT_PHASE = 0x86,
  KDP_EVT_JOB_PROGRESS = 0x87,
  KDP_EVT_JOB_COMPLETE = 0x88,
  KDP_EVT_JOB_FAILED = 0x89,
} kdp_evt_t;

// Frame flag bitmask.
enum {
  KDP_FLAG_NONE = 0x00,
  KDP_FLAG_RESPONSE = 0x01,
  KDP_FLAG_EVENT = 0x02,
  KDP_FLAG_ERROR = 0x04,  // only ever combined with RESPONSE
  KDP_FLAG_BINARY = 0x08,
};

#endif
