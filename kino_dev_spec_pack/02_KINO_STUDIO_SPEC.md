# KINO Studio — Full Product Specification

## 1. Definition

KINO Studio is the permanent browser-based utility for all KINO cameras. It is not merely a D4 firmware flasher.

It covers:
- setup;
- provisioning;
- Wi-Fi;
- Roll setup;
- shooting configuration;
- Wiggle/Quad modes;
- film looks;
- calibration;
- synchronization diagnostics;
- gallery/media management;
- firmware updates;
- camera-node updates;
- rollback;
- recovery;
- Build Mode;
- logs and developer tools.

## 2. Platform

Recommended stack:
- React;
- TypeScript;
- Vite;
- Web Serial;
- IndexedDB;
- Service Worker/static caching.

Desktop target:
- Chrome;
- Edge;
- Chromium-family browsers.

Unsupported browsers must show an explicit explanation.

## 3. Top-level navigation

```text
Overview
Shoot
Wiggle
Quad
Looks
Calibration
Gallery
Roll
Device
Updates
Developer
```

Developer is hidden by default.

## 4. First launch

```text
KINO Studio

[ Connect KINO ]

Open saved profile
Firmware recovery
Demo mode
Documentation
```

Show:
- Studio version;
- browser compatibility;
- Web Serial status;
- cached firmware package state.

## 5. Connection workflow

1. `Connect KINO`.
2. Browser serial picker.
3. Open serial.
4. Decoder ignores/resyncs through boot garbage.
5. `HELLO` with nonce.
6. Retry up to 3 times.
7. `DEVICE_INFO`.
8. `CAPABILITIES`.
9. `CONFIG_SCHEMA`.
10. Current config.
11. Camera-node status.
12. Power/storage/network status.
13. Render only supported features.

Do not toggle DTR/RTS except explicit recovery workflows.

## 6. Persistent connection strip

Example:

```text
● KINO D4 001      USB CONNECTED
Battery 72%   SD 24.1 GB free   WIGGLE · PARTY NEG
```

States:
- Connected;
- Connecting;
- Reconnecting;
- Maintenance;
- Updating;
- Recovery;
- Disconnected;
- Protocol mismatch;
- Hardware error.

## 7. Overview

Goal: answer “Is my KINO ready?”

```text
KINO D4
READY

Mode        WIGGLE
Look        Party Neg
Resolution  2M
Flash       Auto
Roll        Friday House Party
```

Health:

```text
MAIN      ✓
CAM1      ✓
CAM2      ✓
CAM3      ✓
CAM4      ✓
SD        ✓
FLASH     ✓
NETWORK   ✓
```

Quick actions:
- Change mode;
- Change look;
- Test cameras;
- Start/Join Roll;
- Gallery;
- Check updates.

## 8. Shoot page

Capability-aware controls.

D4 V1:

### Resolution
- 1600×1200 / 2M — default;
- 2048×1536 / 3M.

### JPEG quality
Friendly:
- Small;
- Normal;
- Fine;
- Maximum.

Advanced numerical value available.

### Flash
- Auto;
- On;
- Off.

### Preview camera
- CAM1–CAM4;
- default CAM2.

### Shutter sound
- Off;
- Low;
- Medium;
- High.

### Post-shot review
- Off;
- 1s;
- 2s;
- 3s;
- Hold.

## 9. Wiggle page

### Playback sequence
Default:

```text
1 → 2 → 3 → 4 → 3 → 2
```

### Loop
- Bounce — default;
- Continuous sweep;
- One sweep.

### Direction
- Left → Right;
- Right → Left.

### Speed
- 5–15 fps;
- default 10 fps.

Friendly labels:
- Dreamy;
- Slow;
- Normal;
- Fast;
- Hyper.

### Crop
- Auto overlap — default;
- Preserve max frame;
- Custom.

### Browser preview
- play/pause;
- scrub viewpoints;
- speed;
- reverse;
- raw/processed toggle;
- download test render.

### Export
- MP4;
- animated WebP;
- GIF;
- individual JPEGs;
- contact sheet;
- ZIP.

## 10. Skew Bench

This is a first-class Studio feature.

Do not collapse sync into one misleading number.

Display separately:

### GPIO distribution skew
How close camera nodes received/handled the common trigger.

### VSYNC/frame-phase skew
Difference in sensor frame timing.

### Effective exposure skew
Best available estimate/measurement of actual recorded scene timing.

Example:

```text
GPIO distribution
CAM1 +0.00ms
CAM2 +0.09ms
CAM3 +0.14ms
CAM4 +0.11ms
Spread 0.14ms

VSYNC phase
CAM1 +0.00ms
CAM2 +0.61ms
CAM3 +1.20ms
CAM4 +0.42ms
Spread 1.20ms
```

Quality bands:

```text
<0.5 ms    Excellent
0.5–1 ms   Very good
1–2 ms     Good target
2–5 ms     Warning
5–10 ms    Poor for moving subjects
>10 ms     Fail intended synchronized use
```

100–400 µs is a target, not an assumption.

## 11. Quad page

Four independent camera recipes.

```text
CAM1        CAM2        CAM3        CAM4
Party Neg   Motion      Raw Digi    Acros-ish
```

Per camera:
- recipe;
- exposure bias;
- gain limit;
- WB;
- contrast;
- saturation;
- sharpness;
- denoise;
- flash participation if hardware supports it.

Presets:
- PARTY FOUR;
- FILM FOUR;
- CHAOS;
- RAW FOUR.

## 12. Looks library

Fuji-inspired, not claims of exact Fujifilm reproduction.

Defaults:
- Party Neg;
- Chrome;
- Superia;
- Velvia-ish;
- Acros-ish;
- Flash Digi;
- Raw Digi;
- Warm 2007;
- Cold Flash;
- Disposable.

Each look has:
- ID;
- name;
- creator;
- revision;
- description;
- capture settings;
- tone settings;
- color settings;
- optional character effects.

## 13. Look editor

### Capture
- exposure compensation;
- gain ceiling;
- denoise;
- sharpness;
- sensor contrast;
- sensor saturation;
- WB mode.

### Tone
- black point;
- white point;
- gamma;
- contrast;
- highlight compression;
- shadow lift;
- editable curve.

### Color
- temperature;
- tint;
- saturation;
- RGB controls;
- matrix.

### Character
- grain;
- vignette;
- bloom;
- halation approximation;
- chromatic offset;
- JPEG degradation.

Prefer real sensor character over fake effects.

## 14. LUT support

Advanced:
- `.cube`;
- KINO look JSON.

Recommended device LUT:
- 17×17×17.

## 15. Calibration

### Sensor matching
Correct only enough for stable wiggle:
- brightness;
- RGB gains;
- exposure offset.

### Geometry
- X;
- Y;
- rotation;
- crop;
- optional distortion.

Never align away true parallax.

### Camera order
Wizard maps physical left→right lens order.

### Lens spacing
Store measured lens center positions.

### Flash calibration
- level;
- pre-flash delay;
- pulse timing;
- distance preset;
- highlight clipping diagnostics.

## 16. Gallery

Browse SD media through KDP.

Views:
- Wiggles;
- Quad sets;
- Captures;
- Individual assets.

Actions:
- preview;
- download;
- ZIP;
- delete;
- favorite;
- inspect metadata;
- push to Roll.

Requirements:
- cursor pagination;
- virtualized list/grid;
- lazy assets;
- support 2,000+ captures.

## 17. Roll page

Functions:
- configure Wi-Fi;
- saved networks;
- server URL default `https://kino.acronym.sk`;
- register/pair device;
- create Roll;
- join Roll;
- show upload queue;
- show guest QR;
- open host dashboard;
- test server.

Camera remains usable offline.

## 18. Device page

Main:
- product;
- serial;
- hardware revision;
- KDP protocol version;
- config schema version;
- firmware;
- flash/PSRAM;
- uptime;
- reset reason;
- SD;
- network.

Per camera:
- online/offline;
- sensor;
- firmware;
- PSRAM;
- UART error counters;
- capture count;
- calibration state.

## 19. Battery / power

Where supported:
- battery voltage;
- estimated percentage;
- charging;
- NTC temperature;
- capture voltage sag;
- camera rail state;
- flash state;
- brownout/reset history.

## 20. Updates

Normal view:

```text
Your KINO is up to date.
Installed 0.6.1
Latest    0.6.1
```

Expandable targets:
- Main P4;
- CAM1–CAM4.

Primary action:
- `Update KINO`.

No five-binary workflow for normal users.

## 21. Update sequence

Recommended:
1. validate hardware;
2. maintenance mode;
3. update camera nodes sequentially;
4. verify each;
5. update P4;
6. reboot;
7. reconnect;
8. health check.

Manifest may override order.

Require:
- SHA-256;
- compatibility checks;
- rollback;
- health validation.

## 22. Recovery Center

### Main P4
Advanced browser bootloader flashing only after tested against actual board.

### Camera node
If node update agent is dead:
- open service cover;
- direct USB-C to affected XIAO;
- reinstall firmware.

## 23. Build Mode

Wizard:

```text
1. Main board test
2. CAM1 test
3. CAM2 test
4. CAM3 test
5. CAM4 test
6. Camera power switching
7. Physical camera order
8. UART stress test
9. Sync Bench
10. Flash
11. Speaker
12. SD
13. Calibration
14. Complete
```

## 24. Self Test

```text
P4 memory              PASS
Display                PASS
Touch                  PASS
SD                     PASS
Speaker                PASS
Flash                  PASS
CAM1 comms             PASS
CAM1 sensor            PASS
CAM2 comms             PASS
CAM2 sensor            PASS
CAM3 comms             PASS
CAM3 sensor            PASS
CAM4 comms             PASS
CAM4 sensor            PASS
Sync trigger           PASS
Battery voltage        PASS
```

Export report.

## 25. UART stress test

Test:
- 460800;
- 921600;
- 1.5M;
- 2M;
- 3M.

All four channels concurrently.

Select highest error-free rate over meaningful transfer volume.

Target architecture:

```text
CAM1 UART ─┐
CAM2 UART ─┤
CAM3 UART ─┼── P4 PSRAM ── SD
CAM4 UART ─┘
```

Capture first, transfer after.

## 26. Developer Mode

Includes:
- logs;
- protocol inspector;
- command console;
- heap/PSRAM;
- task stats;
- UART errors;
- timing;
- reset causes;
- camera reboot;
- camera rail cycle;
- local binary install;
- NVS reset;
- calibration reset.

## 27. Capability behavior

Studio must never assume command support.

Unsupported command returns:
- `UNSUPPORTED_COMMAND`.

UI shows:
- not supported by current firmware.

## 28. Config versioning

Example:

```json
{
  "schema": "kino.device-config",
  "version": 1,
  "revision": 7,
  "config": {
    "mode": "wiggle",
    "resolution": "1600x1200",
    "flash": "auto"
  }
}
```

Support migrations.

## 29. Backup / restore

`Back Up KINO` contains:
- config;
- calibration;
- looks;
- Quad presets;
- flash setup;
- button mappings;
- preferences.

Selective restore supported.

Hardware calibration should not casually be imported to another physical camera.

## 30. Time sync

On connect, optionally sync camera time from computer.

## 31. Error UX

Bad:
`Error 104`

Good:

```text
CAMERA 3 NOT RESPONDING

KINO lost communication with CAM3.

Try:
• Test CAM3 again
• Power-cycle camera bank
• Check CAM3 connector

[Test Again] [Diagnostics]
```

## 32. Studio production acceptance

Studio is ready when:
- mock and serial transports pass same protocol tests;
- capability negotiation is implemented;
- config schema is versioned;
- HELLO retries/resync work;
- large gallery is paginated + virtualized;
- update rollback/recovery are tested;
- Build Mode can take blank hardware to calibrated READY;
- Skew Bench reports meaningful sensor timing;
- Roll setup works without CLI intervention.
