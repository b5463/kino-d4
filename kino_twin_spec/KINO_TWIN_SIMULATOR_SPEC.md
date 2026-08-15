# KINO Twin Simulator — Software Specification

**Status:** developer implementation handoff  
**Target:** production-quality engineering simulator for KINO hardware  
**Primary profile:** KINO D4 V1  
**Integrates with:** KINO Studio via the same KINO Device Protocol (KDP) used by physical hardware

## 1. Purpose

Build a browser-based **3D digital twin + virtual-device simulator** for the real KINO camera. This is not a decorative render. It must model the physical camera closely enough to help with mechanical layout, wiring, optics, power planning, debugging, and Studio development before the real camera is assembled.

The simulator must do two jobs at once:

1. **Digital twin** — interactive 3D visualization of the camera, all major internals, wiring, optical axes, field of view, clearances and component states.
2. **Virtual KINO device** — expose the same KDP behavior as the physical camera so KINO Studio can connect to it, configure it, capture, run diagnostics, update firmware, see faults, browse gallery data, and simulate KINO Roll networking.

Architecture:

```text
KINO D4 physical camera ── KDP ──► KINO Studio
                                      ▲
                                      │ same KDP application layer
                                      │
KINO Twin Simulator ──────────────────┘
```

Studio feature code must not contain fake-device special cases. It talks to a `DeviceTransport`; real serial and simulator transports feed the same decoder, request manager, capability negotiation, config store, diagnostics, and UI.

---

# 2. Recommended stack

```text
React + TypeScript + Vite
Three.js
React Three Fiber
@react-three/drei
Zustand or equivalent lightweight state store
shared @kino/kdp package
shared @kino/schemas package
Vitest
Playwright
```

Runtime 3D asset format: **GLB / glTF 2.0**.

Source CAD may be STEP/STP/DXF and converted through FreeCAD/Blender into optimized GLB assets.

---

# 3. Main application layout

Desktop-first engineering layout:

```text
┌──────────────────────────────────────────────────────────────────────┐
│ KINO Twin | D4 V1 | ● SIM READY | Studio ● CONNECTED              │
├───────────────┬──────────────────────────────────┬───────────────────┤
│ COMPONENTS    │                                  │ INSPECTOR         │
│               │                                  │                   │
│ □ Enclosure   │             3D VIEW              │ CAM2              │
│ □ P4/display  │                                  │ 21×17.8×15 mm    │
│ □ CAM1        │                                  │ OV3660           │
│ □ CAM2        │                                  │ UART 2.0M        │
│ □ CAM3        │                                  │ Power ON          │
│ □ CAM4        │                                  │ FOV: unknown      │
│ □ Battery     │                                  │ [Inject fault]    │
│ □ Power       │                                  │                   │
│ □ Flash       │                                  │                   │
│ □ Wiring      │                                  │                   │
├───────────────┴──────────────────────────────────┴───────────────────┤
│ BAT 3.86V | 5V 4.94V | 2.1A | SD OK | Roll LIVE | 0 pending       │
└──────────────────────────────────────────────────────────────────────┘
```

Required viewport controls:
- orbit, pan, zoom;
- fit-all;
- front, rear, top, bottom, left, right;
- camera-lens view;
- explode slider;
- x-ray/transparent enclosure;
- internals-only;
- enclosure-only;
- wiring-only;
- optical FOV view;
- measurement mode.

---

# 4. Scene coordinate system

All geometry is stored in **millimetres**.

```text
+X = camera left-to-right when viewed from front
+Y = upward
+Z = forward toward the subject
```

Origin = provisional enclosure geometric center.

Initial body envelope, **PROVISIONAL until real hardware is measured**:

```text
126 mm W × 80 mm H × 36 mm D
```

Front plane around `Z = +18 mm`, rear around `Z = -18 mm`.

The final enclosure is expected to use a **black PETG structural skeleton** with **2–3 mm clear acrylic outer panels**, M2 heat-set inserts and exposed screws. Acrylic is skin/window material, not the primary structural camera mount.

---

# 5. Camera geometry

Four lenses on one horizontal front row.

Current target pitch:

```text
20–24 mm adjustable
22 mm default
```

At 22 mm pitch, provisional lens-center X positions are:

```text
CAM1  -33 mm
CAM2  -11 mm
CAM3  +11 mm
CAM4  +33 mm
```

The four camera nodes are children of a single rigid **camera-bar assembly** so moving the bar cannot accidentally alter relative optical alignment.

Flash position:
- front-facing;
- above lens row;
- centered over CAM2/CAM3;
- not under the camera row.

The simulator must expose lens center spacing as both a slider and exact numeric input.

---

# 6. Hardware-dimension confidence system

Every component dimension must have a provenance state:

```text
MEASURED       user measured actual part with calipers
OFFICIAL_CAD   manufacturer STEP/DXF
OFFICIAL_SPEC  manufacturer dimension drawing/table
SELLER_SPEC    exact purchased listing/seller data
PROVISIONAL    design estimate only
CONFLICT       trustworthy sources disagree
```

A visually accurate but dimensionally false twin is unacceptable.

When two public sources conflict, store both and show `MEASURE TO LOCK` rather than silently choosing one.

Priority for final enclosure work:

```text
MEASURED actual part
> OFFICIAL_CAD
> OFFICIAL_SPEC
> exact SELLER_SPEC
> PROVISIONAL
```

---

# 7. Actual KINO D4 V1 component profile

## 7.1 Main controller/display

**Guition JC4880P443C-I-W**

Public verified specifications:
- ESP32-P4 + ESP32-C6;
- P4 dual-core up to 360 MHz;
- 4.3-inch IPS capacitive touch;
- 480×800;
- 32 MB PSRAM;
- 16 MB flash;
- active display area 93.60 × 56.16 mm;
- 5 V operation;
- public manufacturer figure roughly 320 mA module consumption.

Mechanical-source conflict exists:
- Guition manufacturer page reports module envelope **117.01 × 69.41 mm**;
- another public manual reports board around **114.40 × 66.80 mm**.

The simulator must store both until the actual board is measured.

Rear of final camera: the 4.3-inch display faces outward.

Represent major keepouts:
- both USB-C ports;
- TF/microSD slot;
- speaker connector;
- battery connector;
- 2×13 header;
- camera connector;
- UART/I2C connectors.

## 7.2 Camera nodes

**4 × Seeed Studio XIAO ESP32-S3 Sense**

Official public dimensions with expansion board:

```text
21.0 × 17.8 × 15.0 mm
```

Relevant specs:
- ESP32-S3, up to 240 MHz;
- 8 MB PSRAM;
- 8 MB flash;
- removable camera module;
- expansion board includes microSD;
- current sensors: OV3660.

Prefer the official Seeed STEP model converted to GLB.

Each node gets independent runtime state:
- powered/off;
- booting/ready/fault;
- sensor detected;
- firmware version;
- UART baud/error count;
- VSYNC rate/phase;
- JPEG size;
- capture state.

## 7.3 Current sensors — OV3660

Current D4 V1:
- four OV3660 modules;
- maximum 2048×1536 (~3 MP);
- rolling shutter;
- free-running sensor behavior.

**Do not hard-code a field of view for OV3660.** FOV belongs to the sensor+lens/module combination and must come from a module specification or measurement.

Fields:

```json
{
  "sensor": "OV3660",
  "resolution": [2048,1536],
  "horizontalFovDeg": null,
  "verticalFovDeg": null,
  "fovConfidence": "MEASURE_REQUIRED"
}
```

Optional experimental profile: **OV5640**, 2592×1944 (~5 MP), still rolling shutter. Lens FOV remains separately defined. Simulator may offer candidate lens scenarios such as 60°, 70°, 75°, 90° or 120°, always labelled as design scenarios, not actual sensor facts.

## 7.4 Battery

Current primary battery:

```text
505573 LiPo
1S
3.7 V nominal
3000 mAh
11.1 Wh nominal
```

Nominal size-code proxy:

```text
~5 × 55 × 73 mm
```

Actual pouch folds/lead exit must be measured before enclosure lock.

Seller-confirmed supplied harness limits:
- power leads: 24 AWG;
- PH2.0-3P connector;
- safe sustained current **≤3 A**;
- very short pulse up to **6 A**;
- NTC lead 26–28 AWG signal only;
- preferred charge current **600 mA**;
- maximum charge current **1500 mA**;
- do not model 3 A / 1C charging as acceptable.

The simulator should show battery body, lead exit, connector, NTC wire, foam clearance and battery tray.

## 7.5 Fuse

Current purchased part:

```text
F3A fast axial fuse
3 A
```

Place near battery positive.

Simulator state:
- healthy;
- overheated warning if model estimates sustained overload;
- blown.

Time-current behavior is approximate until an actual fuse curve is entered.

## 7.6 BMS

Current:

```text
1S 10 A protection board
```

Exact PCB dimensions are currently `MEASURE_REQUIRED`.

Do not interpret “10 A BMS” as a 10 A system rating: the stock battery harness has the tighter ≤3 A sustained limit.

## 7.7 SW6106 power board

Current main charger/boost board:
- SW6106 controller;
- bidirectional fast-charge/power-bank class;
- controller supports up to 18 W class operation;
- KINO main rail uses 5 V.

The exact purchased carrier was listed around **28 × 28 mm**, about **11.36 mm max height including connector**, but SW6106 carrier PCBs vary substantially. Mark this `SELLER_SPEC / MEASURE_REQUIRED`.

Model:
- PCB;
- USB-C;
- USB-A if physically present on exact board;
- B+/B- pads;
- K input;
- major inductor;
- port insertion keepouts.

Charge simulation must obey the battery's max 1.5 A charge current rather than the chip's theoretical capability.

## 7.8 Camera power-switch bank

Four identical channels:

```text
AO4407/AO4407A P-channel MOSFET
SOP8→DIP8 adapter
2N3904 NPN
4.7 kΩ base resistor
100 kΩ gate pull-up
100 kΩ base-to-GND recommended
1N5819 series Schottky
```

Behavior:

```text
P4 CAM_PWR GPIO high
→ 2N3904 on
→ P-channel gate pulled low
→ camera 5 V on
```

The 3D mesh can simplify tiny passive parts, but net/pin logic must remain data-correct.

## 7.9 Capacitors

Current parts:
- 1000 µF 10 V low-ESR electrolytics;
- 100 nF 50 V ceramics.

Placement is editable; show central bulk capacitance and branch decoupling.

## 7.10 Flash assembly

Current:
- one 3 W CRI90 natural-white LED star;
- LED Vf roughly 3.0–3.6 V;
- adjustable constant-current driver;
- initial KINO target 350 mA;
- test around 500 mA later if power/thermal measurements permit;
- 20×20×7 mm copper pin-fin heatsink;
- 0.5 mm thermal pad;
- 1 mm opal acrylic diffuser.

Do not default to the driver's possible 1.5 A maximum.

## 7.11 Speaker

Current:

```text
8 Ω
2 W
approx. 25 × 35 mm face envelope
1.25 mm 2-pin plug
```

Thickness must be measured.

## 7.12 Storage

Central storage:

```text
SanDisk Ultra microSD
32 GB
```

Represent actual standard microSD size 15×11×1 mm plus slot insertion/ejection keepout.

## 7.13 P4 carrier/ribbon

Current:
- 26-pin 2×13 2.54 mm female-to-female IDC ribbon;
- about 10 cm;
- keyed/boxed male 2×13 header on carrier.

Show pin-1/red-stripe orientation and bend radius.

## 7.14 Camera harnesses

Four detachable PH2.0 4P harnesses:

```text
+5V
GND
P4 TX → XIAO RX
P4 RX ← XIAO TX
```

Plus one separate 28 AWG shared sync wire per camera.

Main power uses 20 AWG silicone wire. Logic/signals use 28 AWG.

Optional visible wire convention:

```text
red    +5V
black  GND
yellow trigger/control
blue   UART TX
green  UART RX
```

High current must be shown as direct 20 AWG bus wiring, not thin perfboard traces.

## 7.15 Controls

Current parts:
- 6×6×4.3 mm tactile buttons;
- MSK-22D14 SPDT slide switch.

Slide switch is logic/mode input only, not main battery current.

## 7.16 Internal carrier

Current small DKAWS/Perma-Proto-style board. Exact dimensions are not locked; model as editable provisional proxy until measured.

Likely mounted items:
- switch bank;
- transistors/resistors;
- camera connectors;
- capacitors;
- P4 box header;
- LED driver.

---

# 8. 3D interaction requirements

## Component inspector

Selecting any component shows:

```text
name/model
instance ID
dimensions
source/confidence
position/rotation
mounting holes
connector keepouts
power net
signal nets
simulated current state
firmware state where applicable
connected components
```

## Exploded view

Separate in logical order:

```text
front acrylic
flash/diffuser
camera bar
four camera nodes
internal carrier
P4/display
speaker
SW6106/BMS/fuse
battery/battery tray
rear acrylic
```

Explosion amount = 0–100%.

## X-ray mode

Clear panels + translucent skeleton; internals and wires remain visible. This should resemble the intended final transparent KINO aesthetic rather than an arbitrary generic camera.

## Wiring view

Toggles:

```text
POWER
UART
SYNC
FLASH
BUTTONS
ALL
```

Selecting `CAM2 UART` highlights only CAM2 TX/RX and endpoints.

GPIO pin assignments are data-driven because final P4 pins are still subject to hardware validation.

## Keepouts and collisions

Show:
- USB insertion volumes;
- SD card ejection path;
- XIAO service USB access;
- cable bend areas;
- battery cushion/expansion allowance;
- speaker opening;
- button travel;
- heatsink/diffuser spacing.

Warn on:

```text
COLLISION
<0.5 mm hard-part clearance
<1.0 mm cable clearance
USB access blocked
SD ejection blocked
```

---

# 9. Optical visualization

This is a major feature, not decoration.

For every camera show:
- optical axis;
- sensor plane;
- horizontal and vertical FOV frustum;
- neighboring overlap;
- common four-camera overlap.

Distance planes:

```text
0.8 m
1.0 m
1.5 m
2.0 m
3.0 m
custom
```

Allow camera pitch 20–24 mm and arbitrary lens FOV.

Use case: compare a future 70° OV5640 module against 90° or 120° without physically rebuilding the camera.

Do not ray-trace photo quality. Geometry/parallax only.

Optional subject proxies:
- single person;
- three-person party group;
- adjustable width/height.

---

# 10. Simulator ↔ Studio connection

Studio uses:

```ts
interface DeviceTransport {
  connect(): Promise<void>
  disconnect(): Promise<void>
  read(): AsyncIterable<Uint8Array>
  write(data: Uint8Array): Promise<void>
}
```

Implementations:

```text
SerialDeviceTransport     physical KINO via Web Serial
SimulatorTransport        KINO Twin
MockTransport             tests
```

KINO Twin must speak **raw KDP bytes**, not a separate convenient simulator JSON API that bypasses protocol behavior.

Connection options:

1. **In-process SimulatorTransport** for automated tests.
2. **BroadcastChannel** when Studio and Twin are deployed same-origin, e.g. `/studio` and `/dev/twin`.
3. Tiny **WebSocket dev bridge** when separate localhost ports are used.

Studio pages must never directly read Twin's internal state store.

---

# 11. Default simulated identity

```json
{
  "product": "KINO D4",
  "hardwareRevision": "D4-V1",
  "serial": "KD4-SIM-0001",
  "protocolVersion": 1,
  "cameraCount": 4,
  "cameraSensor": "OV3660"
}
```

Default capabilities include:
- wiggle;
- quad;
- flash;
- speaker;
- gallery;
- microSD;
- Wi-Fi;
- KINO Roll upload;
- VSYNC telemetry;
- camera-node proxy update.

Capability values are editable to test future firmware/hardware.

---

# 12. Simulated boot and KDP handshake

Boot state machine:

```text
POWER_OFF
→ BOOTING_P4
→ CAMERA_RAIL_START
→ CAMERA_NODES_BOOT
→ STORAGE_MOUNT
→ NETWORK_INIT
→ READY
```

KDP connection sequence:

```text
HELLO
→ DEVICE_INFO
→ CAPABILITIES
→ CONFIG_SCHEMA
→ current config/status
```

Simulator fault knobs:
- first HELLO dropped;
- delayed reply;
- boot garbage before KDP magic;
- bad CRC;
- protocol mismatch;
- reconnect with new session ID.

This must exercise the same decoder resynchronization as real firmware.

---

# 13. Capture simulation

Per-camera state machine:

```text
IDLE
→ ARMING
→ WAIT_SYNC
→ EXPOSING
→ JPEG_READY
→ TRANSFERRING
→ STORED
→ READY
```

All cameras capture before image transfer begins.

Model four independent UARTs and concurrent transfer into P4 PSRAM.

Selectable UART rates:

```text
921600
1.5 Mbaud
2.0 Mbaud
3.0 Mbaud
```

Simulate:
- JPEG size;
- transfer duration;
- CRC failures;
- retries;
- camera offline;
- one slow channel.

3D visualization on capture:
1. camera power rails illuminate;
2. sync net pulses;
3. each sensor displays exposure-phase marker;
4. JPEG packet streams animate toward P4;
5. SD activity shows write;
6. optional Wi-Fi upload follows afterward.

---

# 14. Synchronization model

The simulator must never imply that one shared GPIO pulse proves synchronized exposure.

Separate metrics:

```text
GPIO distribution skew
VSYNC/frame-phase skew
effective exposure skew
```

OV3660 is free-running rolling shutter. OV5640 is also treated as rolling shutter in this design.

Preset scenarios:

```text
Excellent      <0.5 ms
Very good      0.5–1 ms
Usable         1–2 ms
Motion risk    2–5 ms
Poor           5–10 ms
Bad            >10 ms
```

Example simulator baseline may be around 0.15 ms GPIO / 1.2 ms VSYNC / 1.5 ms effective exposure, but it must be labelled **SIMULATED**, never represented as measured V1 hardware performance.

Studio Skew Bench should receive the values through KDP.

---

# 15. Power simulation

This is a behavioral engineering model, not SPICE or safety certification.

Every number is tagged:

```text
MEASURED
MANUFACTURER
SELLER
ESTIMATED
SIMULATED
```

Initial public profiles:
- Guition P4/display around 0.32 A @ 5 V from manufacturer data;
- Seeed XIAO Sense public camera workload figures include roughly 0.14 A average and ~0.347 A peak @ 5 V in their example workload; use only as initial simulation defaults until KINO measurements exist.

Power states:

```text
Idle
Preview
Four-camera capture
Capture + flash
Parallel UART transfer
Wi-Fi Roll upload
Worst-overlap stress test
```

Battery rules:
- warning if sustained battery-side current >3 A;
- 3–6 A shown as short-transient-only region;
- >6 A critical;
- charging >600 mA labelled above preferred rate;
- charging >1500 mA critical/not allowed.

Show:
- battery voltage;
- estimated current;
- estimated 5 V bus voltage;
- voltage sag;
- fuse state;
- connector/wire warning;
- boost loss estimate.

Import real measurements later and override estimates.

---

# 16. Flash and rolling-shutter visualization

Flash timeline can display:

```text
camera VSYNC phases
rolling sensor readout window
flash trigger delay
flash pulse duration
```

Changing flash timing should visually show qualitative risk of exposure bands.

Flash current presets:

```text
350 mA default
500 mA experimental
650 mA only for controlled testing profile
```

Do not present 1.5 A as a KINO recommendation.

Thermal state should be qualitative unless measured:

```text
COOL
WARM
HOT
CRITICAL
```

Monitor battery, SW6106, LED, heatsink and battery connector.

---

# 17. Gallery simulation

Ship fixture captures:
- normal Wiggle;
- Quad;
- dark party;
- direct flash;
- moving subject;
- incomplete capture;
- corrupt JPEG;
- missing frame;
- large 2,000+ capture gallery.

Studio gallery must use the same cursor pagination and binary asset transfer as real hardware.

---

# 18. KINO Roll simulation

Twin does not replace the Roll server. It simulates camera-side network state and can optionally connect to staging.

States:

```text
Wi-Fi connected/offline
Roll joined/not joined
0/3/42 pending uploads
uploading
server unreachable
token expired
Roll closed
```

Core rule remains:

```text
capture → SD first → camera ready → background upload
```

No Roll/server condition may prevent simulated capture.

---

# 19. Firmware-update simulation

Simulate:
- sequential camera-node updates;
- P4 update;
- verification;
- reboot;
- health check;
- rollback;
- checksum mismatch;
- CAM3 update failure;
- disconnect mid-update.

3D behavior:
- target component highlights;
- progress/status appears beside board;
- reboot visibly resets states.

---

# 20. Fault injection

Required faults:

```text
Disconnect CAM1/2/3/4
Camera power open circuit
UART CRC noise
UART slow link
Sensor missing
No VSYNC
Large VSYNC phase offset
Flash unavailable
Flash overload
SD removed
SD full
Battery low
Battery sag
Fuse blown
Wi-Fi lost
Roll server unreachable
Node firmware mismatch
P4 reboot
XIAO reboot
```

Fault propagation must occur through KDP. Example:

```text
Twin user disconnects CAM3
→ simulated firmware state changes
→ KDP reports CAM3 offline
→ Studio health turns CAM3 red
→ Studio self-test fails CAM3
```

Do not directly manipulate Studio UI from simulator code.

---

# 21. Recording / replay

Every simulation session can record:
- KDP frames;
- state transitions;
- commands;
- fault injection;
- timestamps;
- random seed.

Export:

```text
*.kino-sim.json
```

Replay must be deterministic.

A bug report should be reproducible by importing one file and pressing Replay.

---

# 22. 3D asset pipeline

Fidelity tiers:

### Tier A — exact official CAD
Use where available, especially XIAO Sense.

### Tier B — parametric accurate proxy
Battery, speaker, heatsink, acrylic panels, standard microSD.

### Tier C — editable provisional proxy
Exact BMS, SW6106 carrier, perfboard, unknown marketplace modules until measured.

Pipeline:

```text
STEP/STP/DXF
→ FreeCAD/Blender
→ remove tiny unnecessary geometry
→ confirm millimetre scale
→ set stable origin
→ logical mesh names
→ GLB
```

Keep major geometry:
- PCB outline;
- mounting holes;
- connectors;
- switches;
- SD slot;
- processor/module blocks;
- camera connector;
- service keepouts.

Do not model every 0402 resistor at runtime.

---

# 23. Component measurement workflow

Twin must have a `Measure actual part` workflow.

For a component, enter:

```text
width
height
depth
hole coordinates
connector protrusions
wire exit point
```

A measured override is stored separately from canonical manufacturer data.

Before final enclosure CAD, required actual measurements include:
- Guition board full envelope/thickness;
- connector protrusions;
- SW6106 carrier;
- BMS;
- battery actual pouch size including folds;
- battery lead exit;
- perfboard;
- LED driver;
- speaker thickness;
- OV3660 lens protrusion;
- camera ribbon clearance;
- final acrylic thickness.

---

# 24. Export from Twin

Required:
- scene/layout JSON;
- component/BOM JSON;
- screenshot PNG;
- dimension report;
- collision report;
- wiring/net report;
- simulator scenario file.

Future:
- front-panel DXF hole centers;
- transform CSV for CAD reference;
- STEP reference assembly if practical.

Twin is not a replacement for Fusion 360/FreeCAD for final manufacturable enclosure geometry.

---

# 25. Repository structure

Recommended:

```text
apps/
  studio/
  twin/
packages/
  kdp/
  schemas/
  hardware-profiles/
  three-assets/
  simulator-engine/
  test-fixtures/
```

Hardware data should be declarative:

```text
hardware-profiles/d4-v1.json
hardware-profiles/d4-v1-ov5640-experiment.json
```

A future KINO device should primarily require a new hardware profile + 3D assets, not rewriting Twin or Studio.

---

# 26. Acceptance bar

The simulator is complete when a Studio developer with **no physical camera** can:

1. open KINO Twin;
2. inspect a dimensionally sourced D4 V1 assembly;
3. change camera spacing and lens FOV and see parallax/FOV overlap;
4. connect KINO Studio using SimulatorTransport;
5. complete HELLO / DEVICE_INFO / CAPABILITIES / CONFIG_SCHEMA;
6. configure Wiggle/Quad/looks;
7. perform a four-camera capture;
8. see real KDP-driven state changes in 3D;
9. run UART stress tests;
10. run Skew Bench with separate GPIO/VSYNC/exposure metrics;
11. browse a large simulated gallery;
12. simulate Roll connectivity and upload backlog;
13. run firmware update UX;
14. disconnect CAM3 and see Studio diagnose it through KDP;
15. simulate battery sag/fuse fault;
16. save and replay the exact scenario;
17. replace provisional dimensions with measured values without touching application code.

The goal is a **real digital engineering twin of KINO D4 and a permanent simulator architecture for future KINO hardware**, not a one-off 3D mockup.
