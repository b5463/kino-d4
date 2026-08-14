# KINO Device Protocol (KDP)

## 1. Purpose

KDP is the stable contract between KINO Studio and camera firmware.

Requirements:
- binary-safe;
- transport-independent;
- capability-aware;
- versioned;
- resynchronizing;
- update-safe;
- future hardware friendly.

## 2. Transport

Initial:
- Web Serial over USB.

Future:
- USB bulk;
- Wi-Fi;
- BLE;
- native bridge.

## 3. Framing

Recommended packet:

```text
OFFSET  FIELD
0       MAGIC[2]       "KI"
2       PROTOCOL_VER   uint8
3       TYPE           uint8
4       FLAGS          uint8
5       RESERVED       uint8
6       SEQUENCE       uint32 LE
10      PAYLOAD_LEN    uint32 LE
14      PAYLOAD        bytes
...     CRC32          uint32 LE
```

Routine payload max:
- ~4096 bytes.

Firmware chunk:
- 4096–8192 bytes.

Decoder must:
- scan magic;
- tolerate boot spew;
- tolerate split/coalesced frames;
- reject CRC failures;
- resync without reset.

## 4. HELLO

Studio sends:
- supported protocol range;
- random nonce;
- Studio version.

Device replies:
- selected protocol;
- nonce echo;
- device ID;
- boot/session ID.

Retry up to 3 times.

## 5. Capability negotiation

Immediately:

```text
GET_DEVICE_INFO
GET_CAPABILITIES
GET_CONFIG_SCHEMA
```

Example:

```json
{
  "schema": "kino.device-capabilities",
  "version": 1,
  "cameraCount": 4,
  "features": {
    "wiggle": true,
    "quad": true,
    "vsyncTelemetry": true,
    "phaseCalibration": false,
    "gallery": true,
    "rollUpload": true,
    "xiaoProxyUpdate": true,
    "flashControl": true
  },
  "limits": {
    "maxResolution": "2048x1536",
    "maxCameraUartBaud": 2000000
  }
}
```

## 6. Unsupported commands

Never silently time out.

Return NACK with reason:
- UNSUPPORTED_COMMAND;
- INVALID_STATE;
- INVALID_ARGUMENT;
- BUSY;
- STORAGE_FULL;
- HARDWARE_ERROR;
- VERSION_MISMATCH;
- CHECKSUM_FAILED.

## 7. Command groups

### Discovery
```text
HELLO
GET_DEVICE_INFO
GET_CAPABILITIES
GET_CONFIG_SCHEMA
GET_CAMERA_INFO
GET_POWER_STATUS
GET_STORAGE_STATUS
```

### Configuration
```text
GET_CONFIG
SET_CONFIG
PATCH_CONFIG
SAVE_CONFIG
RESET_CONFIG
```

### Cameras
```text
CAMERA_STATUS
CAMERA_ARM
CAMERA_DISARM
CAMERA_TEST
CAMERA_CAPTURE
CAMERA_PREVIEW_START
CAMERA_PREVIEW_STOP
CAMERA_CALIBRATE
CAMERA_GET_TIMING
```

### Modes / looks
```text
GET_MODES
SET_MODE
GET_LOOKS
SET_LOOK
UPLOAD_LOOK
DELETE_LOOK
GET_PROFILES
SET_PROFILE
```

### Gallery/media
```text
GALLERY_LIST
CAPTURE_GET
ASSET_GET
ASSET_DELETE
CAPTURE_DELETE
STORAGE_CHECK
STORAGE_FORMAT
```

### Network/Roll
```text
NETWORK_LIST
NETWORK_SET
NETWORK_DELETE
NETWORK_STATUS
ROLL_STATUS
ROLL_CREATE
ROLL_JOIN
ROLL_LEAVE
UPLOAD_QUEUE_STATUS
UPLOAD_QUEUE_RETRY
```

### Diagnostics
```text
GET_LOGS
CLEAR_LOGS
SELF_TEST
UART_STRESS_TEST
SYNC_BENCH
FLASH_TEST
SPEAKER_TEST
BUTTON_TEST
```

### Maintenance
```text
ENTER_MAINTENANCE
EXIT_MAINTENANCE
REBOOT
FACTORY_RESET
```

### Firmware
```text
FW_QUERY
FW_BEGIN
FW_CHUNK
FW_END
FW_ABORT
FW_STATUS
FW_ROLLBACK
```

## 8. Config schema

```json
{
  "schema": "kino.device-config",
  "version": 1,
  "revision": 12,
  "config": {
    "mode": "wiggle",
    "resolution": "1600x1200",
    "flash": "auto",
    "wiggle": {
      "fps": 10,
      "direction": "ltr",
      "loop": "bounce"
    }
  }
}
```

Firmware migrates older supported versions.

## 9. Gallery pagination

Never send entire gallery.

Request:

```json
{
  "cursor": null,
  "limit": 100,
  "filters": {}
}
```

Response:

```json
{
  "items": [],
  "nextCursor": "opaque_cursor",
  "hasMore": true
}
```

## 10. Binary media transfer

Do not embed large files in JSON.

Flow:
1. request asset;
2. metadata response;
3. chunk stream;
4. chunk sequence + CRC;
5. completion hash.

Support resume by chunk index/offset.

## 11. Firmware update

Normal path:
- application OTA;
- inactive partition;
- SHA-256;
- size validation;
- hardware compatibility;
- post-boot health;
- rollback.

P4 acts as update gateway for camera nodes.

Camera node identity is topology, not unique firmware builds.

## 12. Firmware manifest

```json
{
  "schema": "kino.firmware-manifest",
  "version": 1,
  "release": "0.6.1",
  "protocolMin": 1,
  "protocolMax": 1,
  "compatibleHardware": ["D4-V1"],
  "targets": {
    "main": {
      "file": "p4-app.bin",
      "sha256": "..."
    },
    "cameraNode": {
      "file": "xiao-app.bin",
      "sha256": "..."
    }
  },
  "updateOrder": ["cameraNode", "main"]
}
```

## 13. Timing telemetry

KDP must distinguish:

```text
gpioTriggerSkewUs
vsyncPhaseSkewUs
effectiveExposureSkewUs
```

If unavailable:
- return null + reason.

Do not fabricate.

## 14. D4 V1 rolling-shutter caveat

OV3660 is free-running rolling shutter.

Shared trigger means camera-node request timing is close; it does not prove exposure timing is close.

Firmware should expose VSYNC timestamps and attempt sensor re-phasing strategies where possible.

## 15. Async job model

Long operations return job ID.

```json
{
  "jobId": "job_123",
  "accepted": true
}
```

Events:
- JOB_PROGRESS;
- JOB_COMPLETE;
- JOB_FAILED.

Use for:
- calibration;
- firmware;
- stress tests;
- storage checks;
- large exports.

## 16. Sequence IDs

Every request has sequence ID.
Responses echo it.
Async events are separate.

## 17. Session ID

Each device boot creates a session ID.
Studio detects unexpected reboot/stale state.

## 18. Errors

Example:

```json
{
  "code": "CAMERA_OFFLINE",
  "message": "CAM3 did not respond",
  "details": {
    "camera": 3,
    "uartErrors": 4
  },
  "recoverable": true,
  "suggestedActions": [
    "CAMERA_TEST",
    "CAMERA_POWER_CYCLE"
  ]
}
```

## 19. Mock requirements

Mock must simulate:
- split frames;
- coalesced frames;
- bad CRC;
- boot spew;
- delayed responses;
- unsupported commands;
- disconnect;
- failed update;
- offline camera node;
- session restart;
- 2,000+ gallery entries;
- upload backlog.
