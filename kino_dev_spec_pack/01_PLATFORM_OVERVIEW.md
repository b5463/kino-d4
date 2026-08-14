# KINO Platform Overview

## 1. Product model

KINO is a multi-camera photography platform. The first hardware is **KINO D4**, optimized for indoor house parties and intentional imperfection: direct flash, 4:3 framing, cheap-digicam/disposable-camera energy, four viewpoints, and wigglegram output.

The permanent software products are:

### KINO Studio
The precise workshop behind the camera:
- setup and provisioning;
- device configuration;
- calibration;
- synchronization bench;
- film looks;
- firmware and rollback;
- device recovery;
- gallery/media access;
- Roll setup;
- diagnostics;
- build/service tooling.

### KINO Roll
The live shared photo layer:
- event/party creation;
- camera uploads;
- guest gallery;
- wiggle playback;
- host moderation;
- archive;
- recap/export;
- future processing/AI derivatives.

## 2. Future-proofing rules

Studio must not hard-code:
- exactly 4 cameras forever;
- OV3660 forever;
- UART forever;
- one synchronization method;
- one resolution;
- one firmware target.

Every device reports capabilities.

Example D4 V1:

```json
{
  "product": "KINO D4",
  "hardwareRevision": "D4-V1",
  "cameraCount": 4,
  "cameraSensor": "OV3660",
  "maxResolution": "2048x1536",
  "syncMethod": "vsync-assisted",
  "cameraTransport": "uart",
  "storage": ["microsd"],
  "network": ["wifi"],
  "display": true,
  "speaker": true
}
```

A later 12 MP device may instead report hardware sync and USB/MIPI-based camera paths without requiring a Studio rewrite.

## 3. Versioned contracts

Use schema identifiers such as:

```text
kino.device-info
kino.device-capabilities
kino.device-config
kino.calibration
kino.look
kino.profile
kino.capture
kino.roll
kino.asset
kino.firmware-manifest
kino.device-backup
kino.diagnostic-report
```

Every persistent/portable structure has:
- schema name;
- schema version;
- migration path.

## 4. Device protocol

Use **KDP — KINO Device Protocol**.

KDP is transport-independent.

Initial transport:
- USB serial / Web Serial.

Possible future transports:
- USB bulk;
- Wi-Fi;
- BLE;
- native desktop bridge.

Studio talks to a `DeviceTransport` abstraction, not directly to Web Serial from feature code.

## 5. State discipline

Studio keeps separate:
- **device truth** — what camera currently reports;
- **draft state** — user edits not yet committed;
- **transient state** — updates, transfers, calibration jobs, retries.

## 6. Local-first rules

Camera:
- captures offline;
- saves to SD first;
- upload happens later;
- internet must never be required to shoot.

Studio:
- USB device functionality works without account/cloud.

Roll:
- server required for sharing, but never for capture.

## 7. Originals are immutable

Media pipeline:

```text
ORIGINAL CAPTURE
      ↓
KINO PROCESSING
      ↓
EXPORT / SERVER DERIVATIVES
```

Never overwrite originals. AI enhancement is always an optional derivative.

## 8. D4 V1 shooting modes

### Wiggle
All cameras matched as closely as practical:
- exposure;
- gain;
- WB;
- color recipe;
- resolution;
- flash event.

Default animation:

```text
1 → 2 → 3 → 4 → 3 → 2 → repeat
```

### Quad
Four different recipes captured together.

Default concept:

```text
CAM1  Party Neg
CAM2  Motion
CAM3  Raw Digi Flash
CAM4  Acros-ish
```

## 9. D4 image character

Default party target:
- 1600×1200;
- 4:3;
- JPEG;
- low denoise;
- modest sharpening;
- direct-ish white flash;
- no HDR;
- no beauty mode;
- no phone-style night mode.

Target feeling:

```text
cheap disposable camera
+
2000s compact digicam
+
four-camera wigglegram
```

## 10. Roll terminology

A **Roll** is a shared live/archived capture stream.

Use language like:
- Start a Roll
- Join a Roll
- Open Roll
- 47 photos on this Roll
- Download Roll
- Close Roll

Recommended public URL:

```text
kino.acronym.sk/r/7F3K9Q
```
