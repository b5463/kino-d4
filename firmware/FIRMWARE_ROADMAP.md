# KINO D4 firmware roadmap — current state to validated prototype

Dependency-ordered plan from firmware 0.3.0 to a physically validated KINO D4, then toward
product-ready firmware. Derived from the Phase 1 baseline audit of HEAD `7a6066a`.

**Status:** planning document. Nothing here is implemented.
**Companion documents:** [`HARDWARE_VALIDATION.md`](HARDWARE_VALIDATION.md) (bench evidence),
[`FIRMWARE_START_PLAN.md`](FIRMWARE_START_PLAN.md) (original tree plan),
[`../firmware-contract/README.md`](../firmware-contract/README.md) (protocol + deviations D1–D14).

**Baseline drift at time of writing.** A concurrent workstream replaced the home-screen icon set
with baked Windows XP (Luna) artwork (`icons_xp.h`, `scripts/bake-xp-icons.mjs`, `icons.c` −431
lines net). Two consequences: `mesh3d.c` is **not** orphaned (still drives the STATUS screen at
`ui.c:517`), and there is now a release-blocking licensing item (§14) that sits off the engineering
critical path.

---

## Table of contents

1. [Executive recommendation](#1-executive-recommendation)
2. [Current starting point](#2-current-starting-point)
3. [Dependency graph](#3-dependency-graph)
4. [Hard architecture decision gates](#4-hard-architecture-decision-gates)
5. [Milestone roadmap](#5-milestone-roadmap)
6. [Parallel workstreams](#6-parallel-workstreams)
7. [NEXT WORK — before full hardware exists](#7-next-work--before-full-hardware-exists)
8. [First one-camera bring-up checklist](#8-first-one-camera-bring-up-checklist)
9. [First four-camera bring-up checklist](#9-first-four-camera-bring-up-checklist)
10. [Synchronization experiment plan](#10-synchronization-experiment-plan)
11. [Firmware-update strategy](#11-firmware-update-strategy)
12. [Networking / Roll sequencing](#12-networking--roll-sequencing)
13. [Studio command triage](#13-studio-command-triage)
14. [Release gates](#14-release-gates)
15. [Deferred work](#15-deferred-work)
16. [Top 10 next engineering actions](#16-top-10-next-engineering-actions)

---

## 1. Executive recommendation

**Spend the next effort on one question and almost nothing else: can four free-running OV3660
sensors on four ESP32-S3 nodes expose closely enough to make a wigglegram?**

Everything downstream of that answer is contingent on it, and the answer is currently *unknown* —
not "probably fine", not "needs tuning". Unknown. The audit established that the node never reads
`SYNC_IN`, each sensor free-runs, and `esp_camera_fb_get()` returns whatever frame completes next.
The per-camera uncertainty is one frame interval, uncorrelated. If that interval is 30 ms the
product works; if it is 200 ms the product as conceived does not exist on this architecture, and no
amount of Roll integration, flash hardware, or UI polish changes that.

The good news is that this question is **much cheaper to answer than the roadmap templates assume**.
Three deviations from the obvious plan shorten the path substantially:

1. **The mechanism question can be answered today, with zero hardware.** Whether `esp32-camera`
   2.1.7 can be made to arm-and-trigger is a source-reading exercise against
   `managed_components/espressif__esp32_camera`. If the driver structurally cannot do it, we learn
   that before touching a wire — and the fallback conversation starts weeks earlier.
2. **The skew number needs two cameras, not four.** Two independently free-running sensors exhibit
   the same relative-phase problem as four. A 2-camera bench answers Gate C at half the hardware
   cost and half the bring-up time. Four cameras are needed for the *photographic* verdict, not the
   engineering measurement.
3. **The measurement needs no firmware instrumentation at all.** Point both cameras at a running
   millisecond display, capture, read the two timestamps off the JPEGs. That is the ground truth, it
   measures exposure rather than dispatch, and it requires nothing we do not already have.

So the recommended shape is: **a short firmware-only hardening pass (M0) that includes the desk
study, then one camera (M1), then two cameras and the skew answer (M2), then everything else.** Do
not build flash hardware, networking, update infrastructure, or Roll before M2 returns a number.
Three of those four are large, and all four are worthless if the architecture cannot photograph.

The second-order recommendation: **fix the display gate in M0.** `buttons_init()` and
`power_init()` sitting behind `display_init()` success means a panel fault costs the physical
shutter and the camera-bank power-down. That is five lines, needs no hardware, and removes a failure
mode that will otherwise bite during exactly the bring-up sessions where the panel is being
disturbed.

---

## 2. Current starting point

| Dimension | State |
|---|---|
| Firmware version | 0.3.0, branch `feat/p4-display`, HEAD `7a6066a` (+ uncommitted icon work) |
| P4 app | 744 KB of a 1500 KB single `factory` partition; ~14.4 MB flash unallocated |
| Builds | P4 + camnode + uvc-preview via `espressif/idf:v5.5.1`, all green in CI |
| Tests | `kdp_core` 46 host checks ✅ · Studio 280/280 ✅ · fixtures 139/139 ✅ · **zero P4 app tests** |
| Bench-proven | P4 boot, 32 MB PSRAM, ST7701S first light, GT911 touch, SD 4-bit @29820 MB, USB/KDP (31 cmds), ES8311+amp, one standalone OV3660 @210 JPEGs. (`CAM_PWR_EN` was listed here on the strength of toggling GPIO31; GPIO31 is not a header pin, so that row is void — `HARDWARE_VALIDATION.md`) |
| **Never proven** | **Any camera reaching the P4.** Camera UART pins UNVALIDATED — and the first map was wrong: GPIO52/51/50/49/34/33/30/29 are not on the JP1 header. Current map: `docs/HARDWARE.md` §P4 header JP1. Capture pipeline has never photographed |
| Absent entirely | synchronization mechanism, flash hardware, networking, firmware update, battery telemetry, physical buttons |
| Preserve as-is | KDP framing, capture UUIDs, two-stage CRC, metadata-last commit, hwv registry, async workers, PPA renderer, NVS config model |

### Architecture as built

```text
KINO D4 BODY
│
├── ESP32-P4  (Guition JC4880P443C-I-W)
│   ├── display (ST7701S / MIPI-DSI)
│   ├── touch (GT911)
│   ├── UI (hand-written PPA renderer, no LVGL)
│   ├── capture coordination
│   ├── storage (SDMMC 4-bit)
│   ├── USB / KDP
│   └── thumbnail pipeline (HW JPEG + PPA)
│
├── UART1 → ESP32-S3 → OV3660 camera 1
├── UART2 → ESP32-S3 → OV3660 camera 2
├── UART3 → ESP32-S3 → OV3660 camera 3
└── UART4 → ESP32-S3 → OV3660 camera 4
```

The P4 has **no camera interface**. Its MIPI-CSI peripheral is unused. Every photograph reaches the
body as a JPEG over a 921600-baud serial link (~92 KB/s per channel).

---

## 3. Dependency graph

```text
                        ┌──────────────────────────────────────┐
                        │  M0  BASELINE HARDENING      [NOW]   │
                        │  firmware-only, no hardware needed   │
                        └───┬──────────────┬───────────────┬───┘
                            │              │               │
         ┌──────────────────┘              │               └────────────────┐
         │                                 │                                │
  M0.A display-gate fix           M0.D SYNC DESK STUDY            M0.G instrumentation
  M0.B host tests + CI            (read esp32-camera 2.1.7)       (timestamps, telemetry)
  M0.C storage/config debt        ↓ answers: is arm-and-trigger    ↓ feeds M2 measurement
                                    even POSSIBLE?
                                         │
                                         │  ── if structurally impossible ──┐
                                         │                                   │
                        ┌────────────────▼─────────────────┐                 │
                        │  M1  ONE-CAMERA VERTICAL SLICE   │                 │
                        │  [1-CAM]  12 checkpoints         │                 │
                        │  ══ GATE A: UART transport ══    │                 │
                        └────────────────┬─────────────────┘                 │
                                         │ PASS                              │
                        ┌────────────────▼─────────────────┐                 │
                        │  M2  TWO-CAMERA SKEW ANSWER      │                 │
                        │  [2-CAM]  measurement, not code  │                 │
                        │  ══ GATE C: SYNCHRONIZATION ══   │◄────────────────┘
                        └────────┬───────────────┬─────────┘
                                 │               │
                    skew ACCEPTABLE       skew UNACCEPTABLE
                                 │               │
                                 │      ┌────────▼──────────────────────────┐
                                 │      │ M4  DETERMINISTIC SYNC            │
                                 │      │ [2-CAM] node ARM + GPIO trigger   │
                                 │      │ escalating: D1 arm → D2 VSYNC     │
                                 │      │ → D3 sensor regs → D4 ARCH CHANGE │
                                 │      └────────┬──────────────────────────┘
                                 │               │ re-measure
                                 └───────┬───────┘
                                         ▼
                        ┌──────────────────────────────────┐
                        │  M3  FOUR-CAMERA TRANSPORT       │
                        │  [4-CAM] ══ GATE B: throughput ══│
                        │  + PHOTOGRAPHIC wiggle verdict   │
                        └────────────────┬─────────────────┘
                                         │
       ┌─────────────────┬───────────────┼──────────────┬──────────────────┐
       │                 │               │              │                  │
┌──────▼──────┐  ┌───────▼──────┐  ┌─────▼──────┐ ┌─────▼──────┐  ┌────────▼───────┐
│ M5 FLASH    │  │ M6 PHYSICAL  │  │ M7 STORAGE │ │ M8 UPDATE  │  │ M9 POWER       │
│ [FLASH HW]  │  │ SHUTTER + UX │  │ RELIABILITY│ │ + REPART.  │  │ [P4] then      │
│ ══ GATE D ══│  │ [HW REVISION │  │ [NOW/P4]   │ │ [NOW/P4]   │  │ [HW REVISION]  │
│ needs M2/M4 │  │  for pins]   │  │            │ │            │  │ ══ GATE E ══   │
└──────┬──────┘  └───────┬──────┘  └─────┬──────┘ └─────┬──────┘  └────────┬───────┘
       │                 │               │              │                  │
       └─────────────────┴───────┬───────┴──────────────┴──────────────────┘
                                 ▼
                    ┌────────────────────────────┐
                    │  PARTY PROTOTYPE GATE      │
                    │  an evening of real use    │
                    └────────────┬───────────────┘
                                 │
                    ┌────────────▼───────────────┐
                    │ M10 NETWORKING / C6        │
                    │ [NETWORK HW] ══ GATE F ══  │
                    └────────────┬───────────────┘
                                 ▼
                    ┌────────────────────────────┐
                    │ M11 KINO ROLL              │
                    └────────────┬───────────────┘
                                 ▼
                    ┌────────────────────────────┐
                    │ M12 PRODUCTION HARDENING   │
                    └────────────────────────────┘
```

**The one deviation worth arguing about:** the skew answer (M2, two cameras) sits *before*
four-camera transport (M3). Justification: skew is the project's largest uncertainty, and relative
exposure phase between two independent free-running sensors is the same physics as between four. Two
cameras is half the hardware, half the harness debugging, and answers Gate C sooner. Four cameras
then answers a *different* question — concurrent throughput (Gate B) and the photographic verdict —
which is downstream of knowing the sync number is survivable.

### Hardware tags

| Tag | Meaning |
|---|---|
| `NOW` | No physical camera hardware required |
| `P4` | Existing P4 body board only |
| `1-CAM` | P4 + one XIAO + one OV3660 |
| `2-CAM` | P4 + two nodes (skew measurement) |
| `4-CAM` | All four camera nodes |
| `FLASH HW` | Requires flash circuitry |
| `HW REVISION` | Requires a PCB/electrical change |
| `NETWORK HW` | Requires ESP32-C6 bring-up |

---

## 4. Hard architecture decision gates

### Gate A — P4 ↔ S3 UART transport

- **Question:** can the UART architecture reliably move real captures?
- **Evidence required:** M1 checkpoints 1–12 complete; then 500 consecutive single-camera captures
  at 1600×1200 with zero unrecovered CRC mismatches and zero unrecovered link timeouts. Transfer
  duration distribution recorded.
- **PASS:** proceed to M2. Mark `CAM1_TX/RX`, `CAM1_BAUD_921600`, `CAM1_NODE_LINK`,
  `CAM1_JPEG_TRANSFER`, `CAM1_SD_WRITE` VALIDATED.
- **FAIL modes and fallbacks:**
  - *Pins wrong* → correct `board_d4v1.h` + `d4-v1.json`, re-run. Cheap.
  - *Baud unreliable* → drop to 460800, measure, then decide whether to escalate later
    (`SET_LINK_BAUD` exists in the contract, unimplemented).
  - *Framing/CRC errors under load* → investigate UART FIFO/DMA config before blaming the wire;
    `kdp_core` is host-tested so the framing logic itself is not the suspect.
  - *Throughput unacceptable even when correct* (>6 s/frame) → reduce default capture resolution, or
    escalate to a faster link. **Architecture-level fallback:** SPI or SDIO between P4 and nodes — a
    hardware revision, and a large one.

### Gate B — four-node concurrent throughput

- **Question:** can four channels run concurrently without loss?
- **Evidence required:** 500 four-camera captures; per-channel CRC mismatch count, timeout count,
  node reset count; total shutter-to-commit duration distribution; heap and PSRAM flat over the run.
- **PASS:** four-camera capture is `BENCH DONE`.
- **FAIL:** if concurrency is the problem (contention, ISR starvation, PSRAM bandwidth against the
  framebuffer), first try core pinning — currently **no task is pinned**, which is an untested lever.
  Then try staggering transfers rather than fully overlapping. Only then consider a link change.

### Gate C — synchronization *(the critical gate)*

- **Question:** can four OV3660/S3 nodes expose closely enough to produce the intended wigglegram?
- **Evidence required:** two-stage.
  1. **Engineering:** measured inter-camera exposure skew distribution (mean, p95, max) over ≥200
     captures, obtained by photographing a running millisecond timer.
  2. **Photographic:** the KINO subject set (§10) shot and judged.
- **Threshold: must be measured/defined.** No defensible number exists yet. The relationship to
  derive: at what skew does a turning head or a moving hand stop reading as parallax and start
  reading as a glitch? That is a judgement made on images, not on a spec.
- **PASS (skew acceptable as-is):** skip M4 entirely. This is the best outcome and is genuinely
  possible if the frame period is short.
- **PASS-WITH-WORK:** skew unacceptable but M4's escalation ladder closes it. Proceed to M4.
- **FAIL:** M4 exhausted and skew still unacceptable → **the architecture cannot deliver the product
  as conceived.** Fallback directions, in increasing cost:
  - (a) lower resolution to shorten the frame period, trading pixels for sync;
  - (b) accept a narrower product claim (four-perspective stills rather than motion-tolerant
    wigglegram) and constrain the subject;
  - (c) global-shutter or externally-triggerable sensors — new modules, new nodes, board revision;
  - (d) direct MIPI-CSI capture on the P4, using the peripheral currently unused — the largest
    change, and the only one that puts all four sensors in one clock domain.

### Gate D — flash

- **Question:** can one flash event illuminate all four intended exposures correctly?
- **Evidence required:** measured flash pulse timing against measured exposure windows for all four
  cameras; per-camera luminance uniformity across a capture; recharge interval; peak current.
- **Depends on Gate C** — you cannot align a strobe to exposures whose timing you do not know. This
  is the reason flash sits at M5, not earlier.
- **PASS:** flash is `BENCH DONE`.
- **FAIL:** if one strobe cannot cover the spread, fallbacks: a longer/continuous LED illumination
  window (loses motion-freezing, which is a real product cost indoors), or per-camera illumination,
  or flash becomes conditional on M4 having tightened the window.

### Gate E — power

- **Question:** can the architecture run from the intended battery without unacceptable brownout,
  thermal, or runtime problems?
- **Evidence required:** measured idle current, capture-burst current, four-node bank current, flash
  peak, die temperature under sustained capture, and runtime on the intended cell.
- **PASS:** runtime and thermals acceptable for a party-length session.
- **FAIL:** firmware levers first (CPU frequency, light sleep, aggressive camera-bank gating, panel
  duty). If insufficient → **hardware revision**: battery divider or fuel gauge (also required for
  *any* telemetry), possibly a larger cell.

### Gate F — connectivity coexistence

- **Question:** can C6 connectivity coexist with capture without degrading photography?
- **Evidence required:** capture timing and CRC error rates measured with the radio idle,
  associated, and actively uploading. Current draw in each state.
- **PASS:** uploads may run during a session.
- **FAIL:** upload only while idle or on charge. **This must not block the camera** — the product
  requirement is that KINO D4 is fully usable with zero network.

---

## 5. Milestone roadmap

### M0 — Baseline hardening

**Goal.** Remove every defect and gap that can be closed without camera hardware, and answer the
synchronization *feasibility* question on paper before spending bench time on it.

**Why now.** There is a hardware wait; this is the work that fits inside it. Two items are genuinely
urgent rather than opportunistic: the display gate (M0.A) removes a failure mode that will interfere
with bring-up, and the desk study (M0.D) can invalidate the architecture before we build a harness
for it.

**Effort M · Risk LOW** (except M0.D: **Effort S · Risk CRITICAL** — it can change the whole plan)

**Hardware required:** `NOW` throughout. M0.H optionally `P4`.

**Existing implementation we build on:** `main.c`, `buttons.c`, `power.c`, `config_store.c`,
`storage.c`, `kdp_server.c`, `klog.c`, `hardware_validation.c`,
`firmware/components/kdp_core/host_tests/`, `firmware/p4/host_preview/`,
`.github/workflows/firmware.yml`.

**Depends on:** nothing. **Blocks:** M1 (via M0.G), M2 (via M0.D and M0.G).

#### Tasks

**M0.A — Ungate physical controls and power from the display** `[NOW]` `XS`

- Move `buttons_init()` and `power_init()` out of the `if (lcd_err == ESP_OK)` branch in `main.c`
  (currently lines 168–231) to unconditional calls.
- Keep `display_backlight()` calls inside `power.c` tolerant of a panel that never came up — check
  `display_ready()` at the call site rather than gating the whole subsystem.
- Rationale to record in the commit: a panel fault currently costs the physical shutter and the
  camera-bank power-down, which are the two things that matter most when the screen is dead.

**M0.B — Host tests for P4 pure logic** `[NOW]` `S`

- New `firmware/p4/host_tests/` following the `kdp_core/host_tests` pattern (plain gcc,
  `-Wall -Wextra -Werror`).
- Cover: `capture_quality_to_sensor()` (the 60..95 → 20..5 inversion — the bug class that already
  shipped once), `clock_iso8601()` + `clock_set()` bounds, `scale_sixteenths()`,
  `capture_meta_json()` field set against `kino.capture` v1, and the `media_summary()` key mapping
  (`mode`/`capturedAtMs`, the other bug that already shipped).
- These five functions are exactly where the last two real defects lived, and all five are testable
  with no IDF.

**M0.C — CI gates** `[NOW]` `XS`

- Add `host_preview` build to `.github/workflows/firmware.yml` (a change breaking the renderer is
  currently uncaught).
- Add the new `firmware/p4/host_tests` target.
- Add a firmware **size gate** — fail if `kino-p4.bin` exceeds a threshold. Set it from current
  744 KB with headroom; the number matters more once M8 repartitions.

**M0.D — SYNCHRONIZATION FEASIBILITY DESK STUDY** `[NOW]` `S` · **Risk CRITICAL**

Read `firmware/camnode/managed_components/espressif__esp32_camera` (2.1.7, pinned in
`dependencies.lock`) and answer, in a written document:

1. What does `esp_camera_fb_get()` actually return under `fb_count=1, CAMERA_GRAB_WHEN_EMPTY`? Does
   the returned frame's integration begin before or after the call?
2. Is there any hook — callback, semaphore, event — fired on VSYNC or frame start?
3. Can DMA be armed and held, then released on a GPIO edge, without forking the driver?
4. Does `sensor_t` expose `set_reg`/`get_reg` for direct OV3660 register access, and which registers
   govern frame timing, standby, and frame-start?
5. What is the OV3660 frame period at UXGA with XCLK 16 MHz / PCLK 8 MHz (measured on the standalone
   bench)? **This number bounds the best-case skew** and can be derived now.

**Output:** `firmware/SYNC_FEASIBILITY.md` with a verdict of *achievable in driver* / *achievable
with fork* / *achievable only via sensor registers* / *not achievable*, plus the frame-period figure.

**This is the single highest-value task in M0.** It costs a day of reading and can save weeks of
bench work pointed in the wrong direction.

**M0.E — Node ARM protocol *design* (design only, no implementation)** `[NOW]` `XS`

- Specify `NL_CMD_ARM` (0x13), `NL_CMD_TRIGGER_INFO` (0x14), and `NL_STATE_ARMED` in
  `firmware/components/node_link/include/node_link/node_link.h`. Opcode space is wide open
  (0x03–0x0f, 0x13–0x1f, 0x21+).
- Define the JSON shapes: arm request, ready report, and a post-capture timing report carrying
  node-side timestamps (arm received, GPIO edge seen, capture start, frame complete).
- **Do not implement the node side yet** — M0.D may show the mechanism has to be different.
  Committing a header and a document is cheap; committing a mechanism is not.

**M0.F — Storage and config debt** `[NOW]` `M`

- Pre-capture free-space reservation: refuse with `SD_FULL` when free space is below a computed
  reserve (4 frames at the configured resolution + thumbnail + metadata + margin). The reference
  device already has this scenario; firmware never returns the code.
- Orphan-folder recovery: on boot, sweep `/sdcard/KINO/CAPTURES/` for directories lacking
  `META.JSON` and either complete or remove them. A reboot mid-capture currently leaves a folder
  nothing will ever explain.
- Config **migration**: `schemaVersion` is written and never read. Add a read path and a versioned
  migration hook, even if the only migration today is identity.
- Corrupted `META.JSON`: `media_summary()` and `gallery.c` must both survive an unparseable file —
  verify and add tests (M0.B).

**M0.G — Bring-up instrumentation** `[NOW]` `S`

- Add microsecond-resolution timestamps to `klog` entries (currently a plain ring). Bring-up
  diagnosis depends on relative ordering across tasks.
- Extend `capture_report_t` telemetry with the metrics §9 requires: node boot time, command latency,
  per-stage durations, and a per-capture record of the four `fire_us` offsets (already captured, not
  exported).
- Implement `STORAGE_BENCH` (0x4c) — it is currently gated `true` by `benchDiagnostics` and missing,
  which will produce a NACK the first time anyone trusts the flag. Alternatively drop the flag;
  implementing is better because M7 needs the numbers.
- Add a KDP command or extend `GET_RUNTIME_STATS` to report per-task high-water stack marks. Twelve
  tasks with hand-chosen stack sizes have never been measured.

**M0.H — Documentation and registry truth** `[NOW]` / `P4` `S`

- Extend `hardware_validation.c`'s 23 items with rows for `CAM2/3/4_*`, `SYNC_TRIGGER`, `FLASH_EN`,
  `BTN_SHUTTER`. Today the registry structurally cannot record the four-camera bring-up it is meant
  to govern.
- Bring `HARDWARE_VALIDATION.md` forward from 0.1.0 to 0.3.0, recording the display and touch runs
  that commits `b8dff7a` / `8b4ddf3` claim and the file does not.
- Update `firmware/README.md`'s stale "current milestone is `MILESTONE_1B_PLAN.md`".

**M0.I — Capability honesty** `[NOW]` `XS`

- Decide and apply: either implement `STORAGE_BENCH` (M0.G) or clear `benchDiagnostics`.
- Reconsider `wiggle: true` / `quad: true`. These are true in the sense that the capture pipeline
  exists and false in the sense that no synchronization does. **Recommendation: gate both behind
  Gate C** — set them false until measured skew is acceptable, and record the reasoning as a
  deviation. A host reading `wiggle: true` reasonably expects wigglegrams.
- `flashControl: true` similarly: honest about the command, silent about the absent hardware. Suggest
  a `flashHardware: false` companion flag rather than flipping the existing one.

#### Deliberately postponed from the M0 candidate list

| Candidate | Why postponed |
|---|---|
| Card insertion/removal *architecture* | Needs a decision on whether hot-swap is a product requirement at all, and touches the mount path that bring-up depends on. Do the free-space and orphan work (M0.F) now; leave dynamic card state to M7. |
| Node-side ARM *implementation* | Blocked on M0.D. Building it before the study risks building the wrong mechanism. |
| Core pinning | It is a Gate B lever. Changing scheduling now removes a variable we may need. Hold it for M3. |
| Full-screen capture review / on-device delete | Pure UX, zero risk reduction. M6. |
| Mic front-end | Not on the path to a photograph. Defer indefinitely unless audio capture becomes a product feature. |

#### Tests

- New `firmware/p4/host_tests` green under `-Werror`.
- `kdp_core` 46 checks still green.
- `host_preview` builds and renders all screens in CI.
- All three IDF builds green; size gate passes.
- `npm test`, `version:check`, `license:check` green.

#### Pass criteria

- `main.c` calls `buttons_init()` and `power_init()` unconditionally; a forced `display_init()`
  failure still yields a working power task and (once pins exist) a working shutter — verifiable on
  `P4` by temporarily failing the panel.
- ≥5 pure functions under host test, including both historical bug sites.
- CI runs 4 build/test jobs including `host_preview` and the size gate.
- `firmware/SYNC_FEASIBILITY.md` exists with a verdict and a frame-period number.
- `node_link.h` carries ARM/TRIGGER opcodes and shapes, unimplemented and documented as such.
- A capture attempt with <reserve free space returns `SD_FULL`; a boot with a planted orphan folder
  cleans or completes it.
- `hardware_validation.c` has rows for all four cameras, sync, flash, and buttons.

#### Exit gate

All M0 pass criteria met **and** `SYNC_FEASIBILITY.md` reviewed. If the study returns *not
achievable*, escalate to the Gate C failure branch **before** building the harness — M1 still
proceeds (transport is worth proving regardless), but M4 planning starts immediately and in parallel.

#### Failure branch

M0 items are individually low-risk. The one that can redirect the project is M0.D. If it concludes
the driver cannot be made to arm, M2 becomes a pure measurement exercise to quantify how bad the
free-running case is, and M4's ladder starts at rung D3 (sensor registers) or D4 (architecture
change) rather than D1.

---

### M1 — One-camera vertical slice

**Goal.** Prove `P4 ↔ UART ↔ XIAO S3 ↔ OV3660` end to end, through a real capture on the card,
retrievable in Studio. Closes **Gate A**.

**Why now.** It is the first physical gate and everything camera-side depends on it. It is also the
cheapest possible hardware step: one node, one sensor, jumpers.

**Effort M · Risk HIGH** (provisional pin map; never-exercised path)

**Hardware required:** `1-CAM` — P4 body + 1× XIAO ESP32-S3 + 1× OV3660 + jumpers.

**Existing implementation:** `cam_link.c` (channel 0), `capture.c`, `storage.c`, `thumb.c`,
`gallery.c`, `kdp_server.c` (`CAMERA_TEST`, `CAMERA_CAPTURE`, `MEDIA_*`), `camnode/node_server.c`,
`camnode/camera.c`, `hardware_validation.c`.

**Depends on:** M0.G, M0.A. **Blocks:** M2, M3, everything camera-side.

#### Tasks

1. Confirm the harness wiring against `board_d4v1.h` and `d4-v1.json` — **electrical review before
   power** (§8).
2. Flash `camnode` to the node; confirm standalone sensor detect via its own console before
   connecting to the P4.
3. Execute the §8 checklist, checkpoint by checkpoint, recording the §9 metrics at each.
4. As checkpoints pass, let firmware auto-mark the hwv registry; transcribe to
   `HARDWARE_VALIDATION.md` with date, firmware version, and wiring revision.
5. Fix defects as found. **Expect defects** — this path has never run. Do not batch fixes; one
   checkpoint at a time so each failure has one candidate cause.
6. Run 500 consecutive single-camera captures via `CAMERA_SOAK_TEST`; record heap delta, CRC
   mismatches, timeouts, duration distribution.

#### Files likely involved

`firmware/p4/main/board_d4v1.h`, `cam_link.c`, `capture.c`, `storage.c`, `thumb.c`,
`hardware_validation.c`, `firmware/camnode/main/{node_server.c,camera.c,board_xiao_s3.h}`,
`firmware/HARDWARE_VALIDATION.md`, `packages/hardware-profiles/src/profiles/d4-v1.json`.

#### Tests

`CAMERA_TEST cam1` (5-stage timing + 3-way checksums), `CAMERA_LINK_STATS`, `CAMERA_SOAK_TEST` at
500, `STORAGE_SELF_TEST`, `MEDIA_LIST/INFO/READ/THUMB` against the real capture, plus a host-side
byte-for-byte comparison of a `MEDIA_READ` download against the file read off the card in a reader.

#### Hardware validation procedure

§8, in order, no skipping.

#### Pass criteria

- All 12 §8 checkpoints observed.
- **500 consecutive captures at 1600×1200: zero unrecovered CRC mismatches, zero unrecovered link
  timeouts, zero node resets.** Heap and PSRAM flat within measurement noise.
- Transfer duration recorded with mean and p95. *Absolute throughput threshold: must be
  measured/defined* — we do not yet know what shutter-to-commit a user tolerates.
- A `MEDIA_READ` of `C1.JPG` hashes identically to the file read on a laptop.
- `THUMB.JPG` opens as a valid JPEG at the expected ~300×225 and visibly matches the frame.
- `META.JSON` validates against `kino.capture` v1.
- hwv registry shows `CAM1_*` VALIDATED; `HARDWARE_VALIDATION.md` updated.

#### Exit gate

Gate A PASS.

#### Failure branch

See Gate A fallbacks. Note the useful diagnostic ladder already built: all-zero `rxBytes` with
rising `timeouts` = pins or harness; frames arriving with CRC mismatch = signal integrity or baud;
failure at a consistent transfer percentage = timeout budget; failure at random percentages =
electrical.

---

### M2 — Two-camera skew measurement *(the critical milestone)*

**Goal.** Produce the number that decides the product: measured inter-camera exposure skew. Closes
**Gate C** engineering half.

**Why now.** Immediately after transport works and **before** scaling to four. This is the project's
largest uncertainty and two cameras answer it. Spending four-node bring-up effort first would delay
the answer for no information gain.

**Effort S (measurement) · Risk CRITICAL** — this milestone can invalidate the architecture.

**Hardware required:** `2-CAM` — P4 + 2× XIAO + 2× OV3660. Plus a **millisecond timing reference**
(see §10).

**Existing implementation:** everything from M1, plus `capture.c`'s per-camera `fire_us` recording
and `dispatchSpreadUs`. `M0.D`'s study.

**Depends on:** M1 (Gate A PASS), M0.D, M0.G. **Blocks:** M3, M4, M5, and the entire product claim.

#### Tasks

1. Bring CAM2 online; confirm both channels independently per the M1 checkpoints (abbreviated — the
   path is proven, only the channel is new).
2. Build the timing target (§10 Stage A).
3. Capture ≥200 two-camera captures of the target. Extract both timestamps per capture off the
   images.
4. Compute the skew distribution: mean, median, p95, max, and shape. Establish whether it is uniform
   over a frame period (expected for free-running) or clustered.
5. Correlate measured exposure skew against `dispatchSpreadUs` for the same captures — **expect no
   correlation**, and record that explicitly. It is the evidence that dispatch spread must never be
   reported as sync.
6. Shoot the §10 Stage A2 photographic subject set with two cameras and judge.
7. Write `firmware/SYNC_MEASUREMENT.md`: distribution, method, raw data location, and a **product
   verdict**.

#### Tests

No new automated tests — this is instrumented measurement. Add a host script to extract timestamps
from a capture folder and emit the distribution, so the measurement is repeatable after M4.

#### Hardware validation procedure

§10.

#### Pass criteria

- ≥200 paired captures with both timestamps legible.
- Skew distribution characterised with p95 and max.
- Frame period independently confirmed against M0.D's derived figure.
- A documented verdict: *acceptable* / *unacceptable* / *acceptable only for constrained subjects*,
  with images supporting it.
- **Numeric acceptance threshold: must be measured/defined in this milestone.** Establishing it is
  M2's output, not its input.

#### Exit gate

Gate C decided, one of three ways: skip M4 · enter M4 · enter Gate C failure branch.

#### Failure branch

Gate C FAIL. Enter M4 with the escalation ladder, having first re-read M0.D to know which rung to
start on. If M0.D said *not achievable* and M2 says *unacceptable*, the honest conclusion is
available immediately and the fallback conversation (Gate C, options a–d) starts without spending M4.

---

### M3 — Four-camera transport and the photographic verdict

**Goal.** All four nodes concurrent, and the wigglegram judged on four real frames. Closes
**Gate B**.

**Why now.** After the skew answer. Four cameras add concurrency risk and the fourth-frame
photographic judgement, neither of which is worth paying for before Gate C.

**Effort M · Risk MEDIUM-HIGH**

**Hardware required:** `4-CAM`.

**Existing implementation:** `cam_link.c` four channels, `capture.c` four workers + `s_card`
serialisation + partial-capture handling, `viewfinder.c` four `camera_task`s, `cam_probe_task`
four-channel greeting.

**Depends on:** M2. **Blocks:** M5, M6, party-prototype gate.

#### Tasks

1. Scale per §9: CAM1 → +CAM2 → +CAM3 → +CAM4, validating detection and individual capture at each
   step before concurrency.
2. Concurrent capture; verify the four workers genuinely overlap (compare wall-clock total against
   the sum of individual transfers — the design predicts ≈ slowest single transfer, not the sum).
3. Verify `s_card` mutex serialisation does not become the bottleneck; measure SD write duration
   against transfer duration.
4. Verify partial-capture handling by unplugging one node: the capture must commit `partial` with
   three frames and a named reason.
5. **Core pinning experiment** — the Gate B lever held back from M0. Measure with tasks unpinned
   (current), then with UART/capture workers pinned away from the UI/framebuffer core.
6. 500 four-camera captures; full §9 metrics.
7. Thermal and current measurement under sustained four-camera capture (feeds Gate E).
8. Shoot the full §10 subject set with four cameras; render wigglegrams; **judge the effect**.

#### Tests

`CAMERA_SOAK_TEST` ×500 four-camera, `CAMERA_LINK_STATS` per channel, `STORAGE_BENCH` (from M0.G)
for worst-block write timing, failure injection per §24-class subset (node unplug, node reboot,
one-camera failure).

#### Pass criteria

- **500 four-camera captures: zero unrecovered CRC mismatches on any channel, zero unrecovered
  timeouts, zero node resets, heap and PSRAM flat.**
- Concurrency proven: total transfer ≈ slowest channel, not the sum. *Ratio threshold: must be
  measured/defined.*
- Unplugging one node yields `status: "partial"`, three valid frames, and a per-camera reason — with
  the other three unaffected.
- Four-frame wigglegrams produced and judged against §10's subject set.
- Thermal and current recorded.

#### Exit gate

Gate B PASS **and** a documented photographic verdict on four frames. This is the **Wiggle Alpha**
release gate.

#### Failure branch

Gate B fallbacks (core pinning, staggered transfer, link change). If the four-frame photographic
verdict is worse than the two-frame prediction, re-open Gate C — four uncorrelated phases have a
wider spread than two, and M4 may be needed even if M2 passed.

---

### M4 — Deterministic capture synchronization *(conditional)*

**Goal.** Reduce measured exposure skew to the M2-defined threshold with the least invasive
mechanism available.

**Why now.** Only if M2 or M3 says the free-running case is unacceptable. Skipping this milestone is
a valid and desirable outcome.

**Effort L · Risk CRITICAL**

**Hardware required:** `2-CAM` to develop and measure; `4-CAM` to confirm.

**Existing implementation:** `BOARD_SYNC_OUT 20` (JP1 pin 17; was 32 before the header correction) + `trigger_pulse()` (P4 side already done),
`BOARD_SYNC_IN 2` (defined, unread), M0.E's protocol design, M0.D's feasibility verdict.

**Depends on:** M2 (Gate C FAIL or PASS-WITH-WORK), M0.D, M0.E. **Blocks:** M5 (Gate D), the wiggle
product claim.

#### Escalation ladder — stop at the first rung that meets the threshold

**D1 — Arm and trigger in the driver** `[2-CAM]` `M`

- Implement `NL_CMD_ARM` in `camnode/node_server.c`: prepare the sensor, install a GPIO ISR on
  `BOARD_SYNC_IN`, enter `NL_STATE_ARMED`, report READY.
- P4: `capture.c` arms all channels, waits for all READY, *then* pulses `BOARD_SYNC_OUT`, then reads
  out.
- Node returns timing: arm received, GPIO edge, capture start, frame complete.
- This alone may not help if the driver still hands back a free-running frame — which is precisely
  what M0.D determines.

**D2 — VSYNC observation and phase reporting** `[2-CAM]` `M`

- Node observes VSYNC (`BOARD_CAM_VSYNC 38`) and reports frame-start timestamps, giving the P4 real
  phase data.
- Enables *phase-aware triggering*: the P4 delays the trigger so the edge lands at a consistent
  point in each sensor's frame — closing skew statistically without controlling the sensor.
- Also finally gives `CAMERA_PHASE` (0x36) and `SYNC_BENCH` (0x46) something real to report, and
  `vsyncTelemetry` something to be true about.

**D3 — Sensor register control** `[2-CAM]` `L`

- Via `sensor_t`'s `set_reg`/`get_reg` (confirm in M0.D): investigate OV3660 frame-start,
  standby/wake, and frame-timing registers to force a frame boundary on demand.
- Higher risk: undocumented registers, per-sensor variation, and it may destabilise the tuning
  already validated.

**D4 — Architecture change** `HW REVISION` `XL`

- Only if D1–D3 fail. Options per Gate C (a)–(d), in cost order. The MIPI-CSI-direct option is the
  only one that puts all four sensors in one clock domain, and it discards the node architecture.

#### Tests

Re-run M2's measurement script after each rung. Regression: node ARM must not break the
unsynchronized path, and a node that never sees an edge must time out and report rather than hang
(`capture.c`'s `xEventGroupWaitBits(s_done, ask, portMAX_DELAY)` relies on every worker setting its
bit — an armed node that never fires must still complete).

#### Pass criteria

- Measured skew p95 within the M2-defined threshold, confirmed on `4-CAM`.
- Photographic subject set re-shot and improved.
- No regression in M1/M3 soak numbers.
- An armed node that never receives a trigger fails cleanly within a bounded time.

#### Exit gate

Gate C PASS with mechanism.

#### Failure branch

Ladder exhausted → Gate C FAIL → architecture decision. **This is the milestone allowed to conclude
the current architecture cannot meet the requirement.** If it does, say so plainly and cost the four
fallbacks rather than iterating further.

---

### M5 — Flash

**Goal.** Real flash hardware illuminating four exposures correctly. Closes **Gate D**.

**Why now.** After exposure timing is known. Aligning a strobe to unknown exposure windows is not
possible, which is why the current implementation uses a 900 ms window — a workaround for missing
information, not a design.

**Effort M (firmware) · Risk MEDIUM** · flash *driver hardware* is an EE input, not firmware.

**Hardware required:** `FLASH HW` + `4-CAM`.

**Existing implementation:** `capture.c` `gpio_setup()`, `flash_wanted()`, `FLASH_MAX_MS 900`,
`s_exposed` event group, unconditional release at `finish:`; `shoot.flashMode` config;
`SCREEN_FLASH`.

**Depends on:** M2 or M4 (Gate C), M3. **Blocks:** party-prototype gate for indoor use.

#### Staged plan

1. **GPIO test** `[P4]` — scope `BOARD_FLASH_EN` pulse timing and width against `capture.c`'s
   intent. Firmware-only; do now if a scope is available.
2. **Driver hardware** `[FLASH HW]` — **EE deliverable.** Firmware's requirement: an enable/trigger
   input, a stated maximum on-time, a stated recharge interval, and — if available — a ready/fault
   output. Do not design the circuit here.
3. **Current and recharge measurement** `[FLASH HW]` — peak current, recharge time, effect on the
   battery rail (issue #4 notes the amp already couples to `VOUT-BAT`).
4. **Timing** — align the pulse to the measured exposure window from M2/M4. Replace the 900 ms
   bounded window with a targeted pulse if sync allows.
5. **Single-camera photographs**, then **four-camera**.
6. **Motion tests** — the §10 subject set, flash-lit.
7. **Thermal and power** under repeated flash.

#### Firmware scope (explicitly)

Enable/trigger interface; pulse timing; timeout; capture coordination; recharge state *if the
hardware provides it*; fault handling; UI state (`SCREEN_FLASH`, capture banner); flash mode
resolution — including replacing today's `auto`-defers-to-mode with something real if a light sensor
ever appears; power gating so flash cannot fire below a battery threshold (needs M9).

#### Pass criteria

- Pulse timing verified on a scope against the measured exposure window.
- Four-camera flash captures show luminance uniformity across frames. *Uniformity threshold: must be
  measured/defined.*
- Recharge interval measured; the shutter is gated on it rather than firing into an uncharged flash.
- Peak current measured and within the cell's capability.
- A flash fault (if detectable) degrades to no-flash rather than blocking the capture.

#### Exit gate

Gate D PASS.

#### Failure branch

Gate D fallbacks. Worth stating early: if sync is loose *and* one strobe cannot cover the spread,
indoor party photography — the primary use case — is materially compromised, and that couples Gate D
back to Gate C.

---

### M6 — Complete physical camera UX

**Goal.** A camera you operate with a button, that tells you what happened, and that shows you the
photograph.

**Effort M · Risk LOW-MEDIUM**

**Hardware required:** `HW REVISION` for button pins (or a confirmed existing pin); `4-CAM` to
exercise.

**Existing implementation:** `buttons.c` (full debounce/long-press, pins `-1`), `fire_shutter()`
shared by touch and button, capture banner over every screen, `shoot.displayAfterShotS`,
`gallery.c`, wake-gesture swallowing in `ui.c`.

**Depends on:** M0.A, M3. Button pins from schematic.

#### Tasks

- Assign `BOARD_BTN_SHUTTER` (and `BOARD_BTN_FN`) once the schematic confirms pins; validate no
  floating-input self-trigger over a long idle soak — the reason they are `-1` today.
- Half-press only if the hardware supports it; do not invent a two-stage switch.
- Capture while the screen is asleep: already correct in principle (a button press is not swallowed
  on wake, unlike touch) — verify on hardware.
- Accidental-capture avoidance: consider a hold-to-arm or lock, informed by real pocket/bag testing.
- Full-screen capture review: tapping a gallery tile opens the frame; navigate C1–C4.
- On-device delete with confirmation (`MEDIA_DELETE` exists over KDP; the camera cannot delete its
  own photograph).
- Mode slide: no firmware exists and no pin is assigned — a product decision before an engineering
  task.
- Verify capture feedback under failure: `SD_FULL`, one camera down, thumbnail failure all produce a
  legible banner.

#### Pass criteria

- Physical shutter fires a capture from every screen and from a dark screen.
- 24 h idle with no spurious capture.
- Long-press behaviour defined and implemented.
- A capture is reviewable full-screen and deletable on-device.
- Every failure class in the capture subset produces an accurate on-screen message.

#### Exit gate

A person unfamiliar with the project can take, review, and delete a photograph without a laptop.

---

### M7 — Storage reliability

**Goal.** No photograph is lost or silently corrupted by storage behaviour.

**Effort M · Risk MEDIUM**

**Hardware required:** `NOW` for most; `P4` to validate; `4-CAM` for realistic captures.

**Existing implementation — preserve.** Two-stage CRC, `fflush`+`fsync`+`fclose` with all three
checked, metadata-last commit, `rmdir`-only delete, NVS capture sequence, card-as-only-index. **Do
not rewrite this.** Add production concerns around it.

**Depends on:** M0.F, M3.

#### Tasks

- Card removal during capture and during idle — detection and graceful degradation.
- Card insertion after boot (mount is currently attempted once).
- Filesystem error mid-write; write interruption; reboot during commit (extends M0.F's orphan sweep).
- Corrupted `META.JSON` in `gallery.c` and `media_summary()`.
- Thumbnail failure must not fail the capture (already the design — verify).
- Large capture counts: `gallery.c` caps at `MAX_SCAN 240` and `MEDIA_MAX_LIST 512`; verify
  behaviour at 1000+ and that the cap is *reported*, not silent.
- FAT limits: directory entry counts, LFN heap pressure, fragmentation over thousands of captures.
- `STORAGE_BENCH` worst-block write timing (M0.G) against the four-frame burst — the slowest block
  decides the burst, and the average hides it.

#### Pass criteria

- Card pulled mid-capture: no crash, an accurate error, and either a clean or absent folder — never
  a half-folder.
- 1000-capture card: gallery pages correctly, listing reports truncation.
- Reboot injected during commit: boot sweep leaves no orphan.
- Planted corrupt `META.JSON`: gallery and `MEDIA_LIST` both survive.
- `STORAGE_BENCH` worst-block figure documented and within the burst budget.

#### Exit gate

Every storage failure class has a defined, tested behaviour.

---

### M8 — Firmware updates and repartitioning

**Goal.** The camera can be serviced without a cable and a local IDF.

**Why now.** Positioned after the camera works but **before** hardware ships. Repartitioning is
disruptive and gets harder once units are in the field with data on them. The trigger is "before
units leave the bench", not "when convenient".

**Effort L · Risk MEDIUM**

**Hardware required:** `NOW` to implement; `P4` to validate; `4-CAM` for node update.

**Existing implementation:** version plumbing (`KINO_FW_VERSION` → `HELLO`/capabilities/UI), Studio's
complete `FW_*` client (6 methods, zero handlers), `scripts/firmware-daemon.mjs`, ~14.4 MB
unallocated flash.

**Depends on:** M3 (do not repartition before the camera is proven). **Blocks:** field
serviceability, product-beta gate.

#### V1 required vs later — keep these separate

**V1 required:** partition layout with two OTA slots + `otadata`; `FW_QUERY/BEGIN/CHUNK/END/ABORT/
STATUS` handlers; image validation before switching slots; rollback on failed boot;
interrupted-update recovery; NVS survival across the repartition; version compatibility checks; a
documented factory-recovery procedure (cable + esptool is acceptable as the floor).

**Later (production security):** secure boot, signed images, anti-rollback, encrypted flash. **Do
not conflate these with V1.** They change the flashing workflow and the key-management burden, and
none of them is needed to service a prototype.

#### Tasks

- Design the partition layout. Inputs: current app 744 KB, so two ~2 MB app slots is comfortable;
  plus `nvs`, `phy_init`, `otadata`, and a decision on partitions for custom sounds (`SOUND_*` is
  unimplemented), recipes, and a coredump partition (`espcoredump` is linked with nowhere to write).
- Implement the `FW_*` handlers against Studio's existing client — the client is the contract, so
  match it rather than inventing.
- Node update path: `xiaoProxyUpdate` is currently `false`; four nodes each needing a USB-C cable is
  not serviceable. Decide whether the P4 proxies node updates over the existing UART link.
- Future C6 image as a third target in `FW_QUERY`.

#### Pass criteria

- New partition table flashed; NVS config and capture sequence survive.
- A full update cycle over KDP succeeds and the device boots the new image.
- An update interrupted at ≥3 points (mid-chunk, before END, after END pre-reboot) recovers to a
  bootable image every time.
- A deliberately corrupted image is rejected, not booted.
- Rollback verified from a knowingly bad image.
- `FW_QUERY` reports P4 + 4 nodes (+ C6 when it exists).

#### Exit gate

A firmware bug can be fixed on an assembled unit without opening it.

#### Failure branch

If OTA proves unreliable, USB + esptool remains the floor — but then the update UI must be removed
from Studio rather than left as a client with no counterpart.

---

### M9 — Power and battery

**Goal.** Know what the camera costs, and let it die gracefully. Closes **Gate E**.

**Effort M (existing HW) + L (revision) · Risk HIGH** — this can force a board change.

**Hardware required:** `P4`/`4-CAM` for measurement; `HW REVISION` for telemetry.

**Existing implementation:** `power.c` three-stage machine, `CAM_PWR_EN` gating, honest `null`
battery reporting (D10), readable die temperature, config-driven thresholds re-read every pass.

**Depends on:** M3 for realistic load. **Blocks:** party-prototype and product-beta gates.

#### Existing hardware — firmware can do this now

- Measure idle current at 360 MHz with PSRAM at 80 MHz and the panel streaming. **This has never
  been measured and may be the dominant term.**
- Measure capture-burst, four-node-bank, and (post-M5) flash-peak current.
- CPU frequency and `esp_pm` configuration — untested levers. Note the constraint: the DPI panel
  needs ~46 MB/s sustained from PSRAM, so frequency scaling interacts directly with the display.
- Light sleep feasibility with a DPI panel and four UARTs — likely constrained, worth establishing.
- Panel-off and camera-bank-off effectiveness, measured rather than assumed.
- Thermal under sustained capture.
- Runtime on the intended cell.

#### Hardware revision — firmware cannot solve these

- Battery divider or fuel gauge to the P4. **Blocks all telemetry, low-battery warning,
  critical-capture inhibit, and safe shutdown** (D10).
- Charger telemetry from the SW6106.
- A proper power button / latch — there is no defined shutdown path today.
- Backlight PWM (D11 — `body.brightness` is stored and unimplementable on a plain GPIO).

**Do not create firmware milestones that depend on telemetry hardware that does not exist.** The
battery-dependent features are specified here and scheduled only against a revision.

#### Pass criteria

- Idle, capture, bank, and flash currents measured and documented.
- Runtime on the intended cell measured for a realistic session.
- Die temperature under sustained capture within limits.
- A documented decision on whether a battery-sense revision is required for V1.

#### Exit gate

Gate E decided.

---

### M10 — Networking / ESP32-C6

**Goal.** A radio, without degrading the camera. Closes **Gate F**.

**Why now.** After the camera reliably photographs. The one exception: C6 bring-up (transport only)
can run **in parallel** from M3 onward on a second board, because it touches nothing on the capture
path — see §6.

**Effort XL · Risk HIGH**

**Hardware required:** `NETWORK HW` — C6 SDIO routing confirmed, plus a slave image.

**Existing implementation:** none. The contract, the reference device, and
`docs/roll/ROLL_DEVICE_CONTRACT.md` exist. Filed as issue #133.

**Depends on:** M3 (do not divert before photographs work), schematic confirmation of SDIO routing.
**Blocks:** M11.

#### Staged plan

`P4 ↔ C6 transport` → `radio firmware (hosted slave)` → `Wi-Fi scan` → `credentials` → `connect` →
`network diagnostics` → `HTTP/TLS` → `Roll registration` → `upload`

#### Particular attention

- **Credential security:** must never appear in `GET_CONFIG` output or a config backup. This
  constrains where they are stored — not the existing `config_store` JSON envelope.
- Reboot persistence; connectivity loss mid-operation.
- **No-network operation must remain fully functional.** This is a hard requirement, not a
  nice-to-have.
- Uploads while capturing — the Gate F question. Bandwidth, ISR contention, current.
- The C6 becomes a second updatable image (M8).

#### Pass criteria

- Camera joins a network chosen on-device and reports it in `NETWORK_STATUS`.
- **Capture timing and CRC error rates measured with radio idle / associated / uploading, and
  unchanged within noise** — or upload is restricted to idle/charging.
- Credentials absent from `GET_CONFIG` and from a backup, verified by inspection.
- `FW_QUERY` reports the C6 image version.
- Pulling the network mid-upload loses nothing.

#### Exit gate

Gate F PASS.

---

### M11 — KINO Roll

**Goal.** Captures reach Roll reliably, and never at the cost of the photograph.

**Effort L · Risk MEDIUM**

**Hardware required:** `NETWORK HW`.

**Existing implementation:** capture UUIDs already on the card and reboot-durable — the identifier a
Roll upload needs exists. `ROLL_DEVICE_CONTRACT.md`. `SCREEN_ROLL` honest placeholder. The Twin
bridge is **browser code and not reusable on the device**.

**Depends on:** M10, M7 (durable local storage first).

#### Target flow

`capture committed locally` → `upload job created` → `thumbnail uploaded` → `capture visible in
Roll` → `C1–C4 uploaded` → `server verifies` → `job complete`

#### Tasks

- SD-backed upload queue surviving reboot mid-transfer. **The card is authoritative** — a Roll
  failure must never lose a photograph.
- Idempotency via capture UUID; duplicate prevention across retries and reboots.
- Retry with backoff; offline accumulation; reconciliation on reconnect.
- `ROLL_CREATE/JOIN/LEAVE/STATUS`, `UPLOAD_ENQUEUE/QUEUE_STATUS/QUEUE_RETRY`.
- On-device roll UI including the join QR — the thing that makes doing it on the camera worthwhile.
- Thumbnail-first ordering so a capture appears in Roll before its originals finish.

#### Pass criteria

- A capture taken offline uploads on reconnect, in order, with no duplication — verified across a
  reboot mid-queue.
- Killing the network mid-upload and restoring it completes the job.
- 100 captures queued offline then drained without loss or duplication.
- With Roll unreachable indefinitely, the camera keeps shooting normally.

#### Exit gate

A guest joins by QR and sees photographs appear, and pulling the network breaks nothing locally.

---

### M12 — Production hardening

**Goal.** Credible under realistic use and failure.

**Effort L · Risk MEDIUM**

**Hardware required:** `4-CAM` (+ `FLASH HW`, `NETWORK HW` as available).

**Depends on:** all prior.

#### Tasks

- **Failure injection**, in full: node unplugged mid-transfer; node silent; one of four fails; bad
  CRC; SD removed mid-capture; SD full; thumbnail encoder fails; P4 reboots during commit; node
  reboots during capture; C6 reboots; Wi-Fi vanishes mid-upload; update interrupted; display fails
  to init; touch absent; low memory; repeated shutter presses; long soak. **Each needs a defined,
  tested behaviour** — the deliverable is a table, not a pass/fail.
- Watchdog: subscribe tasks to `esp_task_wdt`; today there is none, and a hung task is invisible
  until it resets.
- Coredump partition (M8) + a way to retrieve a backtrace over KDP.
- Brownout handler.
- Per-task stack high-water review (M0.G data) — twelve hand-chosen stack sizes, never measured.
- Core pinning finalised from M3's experiment.
- **Party soak:** an evening of realistic use. Hundreds of captures, flash, repeated presses,
  sleep/wake, card near full, network coming and going.
- Release readiness: `HARDWARE_VALIDATION.md` current, contract deviations current, capability flags
  matching reality.
- **Icon licensing resolved** (§14) — a release blocker independent of engineering.

#### Pass criteria

- Every failure class has a documented behaviour and a test.
- A party soak completes with zero lost photographs and zero unrecovered faults.
- No task exceeds 70% stack high-water.
- A forced crash yields a retrievable backtrace.

#### Exit gate

**Product Beta.**

---

## 6. Parallel workstreams

```text
TIME ──────────────────────────────────────────────────────────────────────►

FIRMWARE CORE    [M0 ══════════]                    [M6]──[M7]──[M8]──[M12]
                        │                             ▲     ▲     ▲      ▲
CAMERA NODES     [M0.D/E]──────[M1]──[M2]──[M4?]──[M3]┘     │     │      │
                                 │     │           │        │     │      │
HW VALIDATION            [M0.H]──[M1]──[M2]──────[M3]───────┘     │      │
                                       │           │              │      │
FLASH HW (EE)    [spec ──────────────── wait for Gate C ───][M5]──┘      │
                                                   │                     │
STUDIO           [M0.I]────[cmd triage]────────────[M8 client already ok]─┤
                                                                          │
NETWORKING/C6    [schematic check]···[C6 transport spike ═══]····[M10]────┤
                                      ▲ PARALLEL from M3                  │
ROLL                                              [contract]······[M11]───┤
                                                                          │
QA/TOOLING       [M0.B/C]──[measurement scripts]──[failure injection]─────┘
```

**Genuinely parallel:**

- **M0.D (desk study)** runs alongside all other M0 work and gates nothing in M0.
- **Flash hardware specification** (an EE task) proceeds during M0–M3; only *validation* waits for
  Gate C.
- **C6 transport spike** can start at M3 on a second board — it touches no capture code. Cap it at
  transport-only; do not build `NETWORK_*`/`ROLL_*` until M10 proper.
- **Studio command triage** (§13) is a documentation exercise, doable during M0.
- **QA tooling** — the M2 skew-extraction script and failure-injection harness — builds ahead of the
  milestones that use it.
- **Hardware validation record** updates continuously.

**Convergence points:** Gate C (M2) converges the node and flash streams. Gate B (M3) converges
everything camera-side and releases M5–M9. The party-prototype gate converges the physical camera
before connectivity begins.

**Hard serialisations that cannot be parallelised:** M1 → M2 → M3 (each needs the previous proven);
Gate C → M5 (cannot time a strobe to unknown exposures); M8's repartition → any field hardware;
M10 → M11.

---

## 7. NEXT WORK — before full hardware exists

### Do now in firmware

| # | Task | Item | Effort | Why now |
|---|---|---|---|---|
| 1 | Ungate `buttons_init()` / `power_init()` from display success | M0.A | XS | A panel fault costs the shutter and battery protection — and bring-up disturbs the panel |
| 2 | **Synchronization feasibility desk study** | M0.D | S | Can invalidate the architecture for the cost of a day's reading |
| 3 | Host tests for the five pure functions | M0.B | S | Both real defects to date lived here and no test could have caught them |
| 4 | CI: `host_preview`, P4 host tests, size gate | M0.C | XS | Cheap, and the renderer is currently unguarded |
| 5 | Pre-capture free-space reserve + `SD_FULL` | M0.F | S | Prevents a class of corrupt capture before the first real one |
| 6 | Orphan capture-folder sweep on boot | M0.F | S | Bring-up will reboot mid-capture repeatedly |
| 7 | Config `schemaVersion` read + migration hook | M0.F | S | The envelope is designed to evolve and currently cannot |
| 8 | Microsecond `klog` timestamps + capture telemetry export | M0.G | S | Bring-up diagnosis depends on cross-task ordering |
| 9 | `STORAGE_BENCH` (or clear `benchDiagnostics`) | M0.G/I | S | Advertised and missing; M7 needs the numbers |
| 10 | hwv rows for CAM2/3/4, sync, flash, buttons | M0.H | XS | The registry cannot currently record the bring-up it governs |
| 11 | `HARDWARE_VALIDATION.md` → 0.3.0 | M0.H | S | Source of truth is two versions stale |
| 12 | Per-task stack high-water reporting | M0.G | XS | Twelve stack sizes, never measured |
| 13 | Studio command triage document | §13 | S | Decides what M8/M10 must actually implement |
| 14 | Skew-measurement extraction script | M2 prep | S | Ready before the cameras are |

### Prepare now, execute when one camera is connected

- **`NL_CMD_ARM` / `NL_CMD_TRIGGER_INFO` header + shapes** (M0.E) — commit the protocol, not the
  mechanism. Implementation waits on M0.D's verdict.
- **The §8 bring-up checklist as an executable runbook** — a document with a blank result column,
  filled at the bench.
- **The M2 timing target** (§10) — build the physical millisecond display now; it needs no camera.
- **Failure-injection harness scaffolding** — the node-unplug and CRC-corruption cases can be
  written against `cam_link.c` before a node exists.
- **Flash hardware requirements document** for the EE side — enable/trigger interface, max on-time,
  recharge interval, optional ready/fault. Firmware's ask, not a circuit.

### Do not build yet

| Item | Waiting on |
|---|---|
| Node ARM **implementation** | M0.D — the mechanism may need to be different, and building the wrong one costs more than waiting |
| Any flash timing work beyond a GPIO scope check | Gate C — you cannot align a strobe to unknown exposure windows |
| `NETWORK_*` / `ROLL_*` / `UPLOAD_*` handlers | M10, which waits on M3. A network stack with nothing worth uploading is the definition of premature |
| C6 hosted slave image | Schematic confirmation of SDIO routing |
| Repartition + `FW_*` handlers | M3. Repartitioning before the camera is proven risks doing it twice |
| Secure boot / signed images | M8's V1 layer, and a key-management decision |
| Battery telemetry, low-battery warning, critical-capture inhibit, safe shutdown | Hardware revision (D10). No sense path exists — building against imaginary telemetry is the trap this section exists to prevent |
| Backlight brightness control | Hardware revision (D11) — plain GPIO, not PWM |
| Card hot-swap architecture | A product decision on whether hot-swap is required, plus M7 |
| Full-screen review, on-device delete, mode slide | M6 — pure UX, zero risk reduction |
| Core pinning | M3 — it is a Gate B lever, and changing scheduling now removes a variable |
| Mic front-end | Not on the path to a photograph |
| Sensor upgrade to OV5640 | Gate C. If sync fails it may become part of the answer; deciding earlier is guessing |

---

## 8. First one-camera bring-up checklist

**Preconditions:** M0.A, M0.G, M0.H complete; `camnode` and P4 firmware built;
`HARDWARE_VALIDATION.md` open; a laptop with Studio and a card reader.

> ⚠ Electrical items marked `[CONFIRM]` are **not established by the repository** and must be
> confirmed against the schematic before power is applied. The repository documents the pin map only,
> and marks it PROVISIONAL (issue #2). The header is `JP1` (26-pin, 2×13, odd pins left, pin 1 top);
> the manufacturer table is in `docs/HARDWARE.md` §P4 header JP1. **Do not wire from any note that
> names GPIO52/51 — those pins are not on the header.**

```text
PHASE 0 — before power
 1. [CONFIRM] Common ground between P4 carrier and XIAO node: JP1 pin 5 or 6.
 2. Node supply: the XIAO is powered from its own USB-C for this session.
    P4 and XIAO are connected by GND + TX/RX only. (CAM_PWR_EN has no header
    pin in V1, so nothing on the P4 can gate a node rail yet.)
 3. [CONFIRM] Logic levels: both 3.3 V, no level shifting required.
 4. Verify TX/RX CROSSING:
      P4 CAM1_TX GPIO52 (JP1 pin 7) → XIAO RX GPIO44 (BOARD_LINK_RX)
      P4 CAM1_RX GPIO51 (JP1 pin 9) ← XIAO TX GPIO43 (BOARD_LINK_TX)
    Straight-through is the single most likely first-hour mistake. Count
    pins from pin 1; do not trust ribbon position.
 5. [CONFIRM] Node UART1 pads D6/D7 are not shared with its own console in a way
    that fights the link (board_xiao_s3.h warns these are UART0's default pads).
 6. Leave SYNC_OUT (GPIO32, JP1 pin 19) UNCONNECTED for this session. FLASH_EN
    has no pin. Fewer variables; neither is needed for any checkpoint below.
 7. Photograph the harness. Wiring revision goes in HARDWARE_VALIDATION.md.

PHASE 1 — node alone
 8. Flash camnode over the node's own USB-C. Do NOT connect the P4 yet.
 9. On the node console confirm: sensor detected, PID=0x3660, SCCB 0x3c,
    XCLK 16 MHz. If the sensor is absent, stop — this is a node problem.
10. Confirm the node reports NL_STATE_READY.

PHASE 2 — electrical communication                        ◄ CHECKPOINT 1
11. Power the P4. Connect the harness.
12. Studio → CAMERA_LINK_STATS cam1.
    Expect: txFrames rising, rxBytes > 0.
    rxBytes == 0 with rising timeouts  → pins, crossing, ground, or baud.
    CRC errors with rxBytes > 0        → signal integrity or baud mismatch.
13. RECORD: txFrames, rxBytes, timeouts, crcErrors, lastError.

PHASE 3 — node greeting                                   ◄ CHECKPOINT 2
14. GET_CAMERA_INFO. Expect cam1.online == true.
15. Expect klog "C1 node online — fw <v>, sensor OV3660, boot <reason>".
16. MARK: CAM1_TX_GPIO1, CAM1_RX_GPIO2, CAM1_BAUD_921600, CAM1_NODE_LINK.
17. RECORD: node boot time, HELLO round-trip.

PHASE 4 — camera status                                   ◄ CHECKPOINT 3
18. CAMERA_STATUS cam1. Expect sensorDetected true, sensor "OV3660",
    sensorPid "0x3660", node heap/PSRAM plausible.
19. MARK: CAM1_SENSOR_DETECT (now on the real path, not standalone).

PHASE 5 — single capture                                  ◄ CHECKPOINT 4
20. CAMERA_TEST cam1 — the instrumented bench path, NOT the product path.
21. Expect ok, and timing.captureCommandToJpegReadyMs plausible (~380–520 ms
    was the standalone figure).
22. RECORD the full 5-stage timing breakdown.

PHASE 6 — JPEG transfer                                   ◄ CHECKPOINT 5
23. From the same result: jpegBytes plausible for UXGA q12.
24. RECORD transfer duration → derive effective bytes/sec. Compare against the
    ~92 KB/s the 921600 baud link predicts.
25. If it fails at a CONSISTENT percentage → timeout budget.
    RANDOM percentages → electrical.

PHASE 7 — CRC verification                                ◄ CHECKPOINT 6
26. checksums.nodeJpegCrc32 == checksums.transferCrc32, and match == true.
27. MARK: CAM1_JPEG_TRANSFER.

PHASE 8 — SD write                                        ◄ CHECKPOINT 7
28. Same result: dir == /sdcard/KINO/CAPTURES/<uuid>, sdWriteMs recorded.
29. RECORD sdWriteMs.

PHASE 9 — read-back CRC                                   ◄ CHECKPOINT 8
30. checksums.storedFileCrc32 == nodeJpegCrc32.
31. MARK: CAM1_SD_WRITE.
32. ── Gate A's core claim is now proven for one camera. ──

PHASE 10 — the PRODUCT path                               ◄ CHECKPOINT 9
33. Press SHOOT on the camera's own screen. (Physical button has no pin yet.)
34. Expect the shutter sound on the press, then the capture banner progressing
    CAPTURING → READING FRAMES → WRITING TO CARD → result.
35. Expect banner "CAP_00000N - 1 of 1 frames" with KB and ms.
36. CAMERA_CAPTURE over KDP; expect ok:true plus a kino.capture document, and
    the three skews null with an unavailableReason.

PHASE 11 — THUMB.JPG                                      ◄ CHECKPOINT 10
37. Card reader: /KINO/CAPTURES/<uuid>/THUMB.JPG opens, ~300×225,
    visibly matches C1.JPG. Not grey, not truncated.
38. If absent: check the klog for "no thumbnail for CAP_xxxxxx" — a thumbnail
    failure must NOT have failed the capture.

PHASE 12 — META.JSON                                      ◄ CHECKPOINT 11
39. META.JSON validates against kino.capture v1.
40. Confirm: frameCount 1; status "complete"; frames[0].crc32 matches the file;
    clockSource "unset" (no host time yet) — then reconnect Studio with
    hostEpochMs and confirm it becomes "host".
41. Confirm capturedAtMs is present and non-zero.

PHASE 13 — gallery                                        ◄ CHECKPOINT 12a
42. MENU → GALLERY. The capture appears with its label, mode, and 1/4 in red
    (partial — correct with one camera).
43. Tile shows the photograph, not LOADING or NO IMAGE.

PHASE 14 — Studio MEDIA_*                                 ◄ CHECKPOINT 12b
44. MEDIA_LIST: capture present, kind from META's mode, ts non-zero
    (this was the media_summary bug — verify it is fixed).
45. MEDIA_INFO: files present, frameCount agrees with the file count.
46. MEDIA_READ C1.JPG in pages; reassemble host-side; sha256 must equal the
    file read in the card reader.
47. MEDIA_THUMB: first page ≤8192 bytes, starts FF D8.
48. Studio's conformance suite: run it, record pass/shape/unsupported per case.

PHASE 15 — STALE-FRAME CHECK          ◄◄ GATE. DO THIS BEFORE ANY SKEW WORK ►►

    firmware/SYNC_FEASIBILITY.md predicts, from driver source, that with
    fb_count=1 a capture after a release returns an ALREADY QUEUED frame
    immediately: a photograph of the moment just after the PREVIOUS readout
    rather than of the shutter. The first capture after a release is fresh;
    every subsequent one may not be.

    This is capture CORRECTNESS, not synchronization - a single-camera KINO
    would photograph the wrong instant too - and a skew number measured across
    stale frames is meaningless. So it is checked before M2, not during it.

    The firmware already reports everything needed. No code change, no extra
    tooling.

49. Point the camera at a clock, a running stopwatch, or anything whose
    appearance changes second to second.
50. CAMERA_TEST cam1. RECORD from the response and from the capture's
    META.JSON frames[0]:
        durationMs / nodeFbGetUs      time the node spent in fb_get()
        nodeFrameStartUs              node esp_timer at that frame's DMA arm
        nodeFrameAgeUs                command arrival minus frame start
51. WAIT a known interval - 10 s is plenty and makes a stale frame obvious.
52. CAMERA_TEST cam1 again. RECORD the same three fields.
53. Repeat steps 51-52 at least five times, varying the wait (2 s, 10 s, 30 s).
54. Also watch GET_LOGS for lines the firmware raises by itself:
        C1 STALE? fb_get <n> us, frame <n> us before command
    capture.c emits that whenever fb_get returns in under 20 ms, which no
    genuinely fresh UXGA frame can do (the derived frame period is ~112 ms).

    ── EXPECTED IF THE DEFECT IS REAL ──
        capture 1:      durationMs ~= one frame period (~110 ms or more)
        captures 2..N:  durationMs ~= 0, nodeFbGetUs a few hundred us
                        nodeFrameAgeUs grows with the wait interval
                        the photographed clock reads EARLIER than the shutter
                        by roughly the wait
        and the STALE? log line appears on captures 2..N

    ── EXPECTED IF IT IS NOT ──
        every capture:  durationMs ~= one frame period
                        nodeFrameAgeUs small and roughly constant
                        the photographed clock matches the shutter instant

55. DECIDE, and write the answer into HARDWARE_VALIDATION.md either way:

    CONFIRMED  ->  **STOP. Do not proceed to M2 skew measurement.**
                   Implement the stale-buffer correction first: discard one
                   frame before the real fetch (specified in
                   SYNC_FEASIBILITY.md, "Pre-designed fix"), re-run this
                   phase, and only then continue. Measuring skew across stale
                   frames would produce a number that means nothing and a
                   Gate C decision built on it.

    NOT CONFIRMED -> document the ACTUAL observed lifecycle in
                   HARDWARE_VALIDATION.md, including the fb_get durations and
                   frame ages that show it, and correct
                   SYNC_FEASIBILITY.md's prediction. A source-derived
                   prediction that hardware refutes is a finding worth
                   recording, not something to quietly drop.

PHASE 16 — soak
56. CAMERA_SOAK_TEST cam1, 500 captures, keepAll=false.
57. RECORD: successful/attempted, heapDeltaKB, per-error tally, node resets.
58. GET_RUNTIME_STATS: check `tasks[].minFreeBytes` for every task after the
    soak. Anything under ~25% of its configured stack wants raising before M3.
59. Transcribe every marked row into HARDWARE_VALIDATION.md with date,
    firmware version, wiring revision.

── EXIT ──
One real OV3660 photograph exists on the P4's SD card, its stored bytes
verify against the sensor's own checksum, and it can be retrieved
byte-identically through KINO Studio.
```

---

## 9. First four-camera bring-up checklist

**Preconditions:** Gate A PASS; Gate C decided (M2 complete); hwv rows for CAM2/3/4 exist (M0.H).

```text
PHASE A — incremental detection
 1. CAM1 only: repeat §8 phases 2–4 abbreviated. Baseline.
 2. Add CAM2. GET_CAMERA_INFO: cam1+cam2 online, cam3+cam4 offline.
    Verify the OFFLINE reporting is honest — a false-online is worse than a
    false-offline, because capture will then wait on a dead channel.
 3. CAMERA_LINK_STATS per channel. Confirm channel independence.
 4. Add CAM3, then CAM4, repeating 2–3 at each step.
 5. RECORD node boot time per channel; confirm cam_probe_task greets all four
    in turn (this greeted only CAM1 before it was fixed).

PHASE B — individual capture
 6. CAMERA_TEST on each of cam1..cam4 in turn.
 7. RECORD per channel: command latency, capture duration, JPEG size,
    transfer duration, effective bytes/sec, sdWriteMs, all three checksums.
 8. Compare JPEG sizes across the four sensors — a large outlier means a
    tuning or exposure difference that will show in the wigglegram.

PHASE C — concurrent capture
 9. Press SHOOT. Expect banner "4 of 4 frames".
10. From META.JSON's frames[]: per-camera nodeMs, transferMs, writeMs,
    fireOffsetUs.
11. VERIFY CONCURRENCY: total shutter-to-commit ≈ SLOWEST single transfer,
    not the SUM. If it approximates the sum, the workers are not overlapping
    and that is a defect, not a tuning issue.
12. RECORD dispatchSpreadUs — and record explicitly that this is NOT skew.

PHASE D — throughput and integrity
13. 500 four-camera captures.
14. RECORD per channel: CRC mismatches, timeouts, node resets, dropped
    capture requests. Plus heap, PSRAM, per-task stack high-water,
    SD write duration distribution, total shutter-to-commit distribution.
15. Core pinning experiment: repeat unpinned, then with UART/capture workers
    pinned off the UI core. Compare.

PHASE E — skew (photographic verdict)
16. Re-run the §10 measurement with four cameras. Four uncorrelated phases
    have a WIDER spread than the two measured in M2 — quantify it.
17. Shoot the full §10 subject set. Render wigglegrams. JUDGE.

PHASE F — thermal and current
18. Sustained capture: P4 die temperature, node temperatures if readable.
19. Current: idle, four-node bank on, during capture, during transfer.
20. Runtime estimate on the intended cell.

PHASE G — failure injection
21. Unplug CAM3 mid-transfer → expect status "partial", 3 frames, a named
    reason for cam3, other three unaffected.
22. Power-cycle CAM2 → expect offline then recovery, logged.
23. Hold CAM4's node in reset → expect a bounded timeout, not a hang.
    (capture.c waits portMAX_DELAY on all done bits; every worker must set
    its bit on every failure path. This is the test of that claim.)
24. Corrupt a transfer deliberately → expect a CRC mismatch reported, not stored.
25. Remove the SD mid-capture → no crash, accurate error, no half-folder.
26. Fill the card → expect SD_FULL from the M0.F reserve, not a failed write.
27. Repeated rapid shutter presses → expect drops, not a queue of stale shots.

PHASE H — record
28. Mark every hwv row earned. Transcribe to HARDWARE_VALIDATION.md.
29. Write the four-camera measurement report.

── EXIT ──
Gate B PASS, and a documented photographic verdict on four-frame wigglegrams.
```

---

## 10. Synchronization experiment plan

The plan must produce **two** answers: an engineering number and a photographic judgement. Neither
alone is sufficient.

### Stage A — measure current behaviour (no architecture change, no firmware change)

**Method: photograph a running clock.** This is the ground truth because it measures *when light was
integrated*, which is the only thing that matters and the only thing no internal timestamp can tell
us.

- **Target:** a millisecond-resolution display large and bright enough to read in a JPEG. Options in
  order of preference:
  1. a microcontroller-driven 7-segment or LED-matrix millisecond counter;
  2. a high-refresh monitor showing a millisecond timer;
  3. an LED array where a single lit position advances every millisecond — most robust to motion
     blur and cheapest to read.
- **Procedure:** all cameras framed on the target; ≥200 captures; read each frame's displayed value;
  skew = difference between frames of the same capture.
- **Outputs:** distribution (mean, median, p95, max, shape). A uniform distribution across a frame
  period confirms free-running; clustering would be a surprise worth investigating.
- **Also record:** frame period derived independently, and `dispatchSpreadUs` for each capture.
- **Critical control:** correlate measured skew against `dispatchSpreadUs`. **Expect no
  correlation.** Recording that non-correlation is what permanently retires the temptation to report
  dispatch spread as synchronization.

**This stage requires no firmware change at all** and can be executed the same day two cameras are
connected.

### Stage A2 — photographic judgement

Shoot the KINO subject set, render four-frame wigglegrams, and judge. Ordered from easiest to
hardest:

| Subject | What it probes |
|---|---|
| Person standing still | Baseline — parallax only. If this fails, something other than skew is wrong |
| Person turning head | Slow rotation; the most common party subject |
| Hand movement / gesture | Medium-speed limb motion |
| Moving drink / raised glass | A small fast object with a hard edge |
| Two people, one moving | Differential motion in one frame |
| Walking across frame | Fast lateral translation — hardest for skew |
| Dancing | Realistic worst case |
| Flash-lit party scene | The primary use case, once M5 exists |

**Judgement criterion:** at what point does inter-frame difference stop reading as *depth* and start
reading as a *glitch*? A wigglegram tolerates parallax by design — it is the effect. It does not
tolerate a subject that has visibly moved between frames.

**The acceptance threshold is derived here, from these images, and written down.** It is not an input
to this plan.

### Stage B — instrumentation (only if Stage A says work is needed)

Expose, per capture: P4 trigger timestamp; node GPIO-edge timestamp; node capture-start;
VSYNC/frame-start if accessible; frame-complete; transfer-start. Node-side timestamps travel back in
the `NL_CMD_TRIGGER_INFO` reply (M0.E's design). This turns skew from a measured black box into an
attributable budget — and tells us *which* stage is contributing.

### Stage C — node arming (M4.D1)

```text
P4 ──── NL_CMD_ARM ────►  all nodes
        nodes prepare sensor, install GPIO ISR, enter NL_STATE_ARMED
P4 ◄─── READY ─────────   all nodes
P4 ──── GPIO edge on SYNC_OUT ────► all SYNC_IN simultaneously
        nodes capture the next controlled frame
P4 ──── NL_CMD_READ ───►  readout as today
```

**Note the honest caveat:** arming removes *command dispatch* jitter, which we already know is
microseconds. It only improves *exposure* skew if the node can additionally control which frame it
returns. That is exactly what M0.D determines, and it is why the desk study precedes this work.

### Stage D — sensor-level investigation (M4.D3)

Only if C is insufficient. Investigate, in this order, and **assume none will work until
demonstrated**: VSYNC observation with phase-aware triggering; OV3660 register control of frame
start/standby; frame reset or restart; XCLK manipulation (risky — 16 MHz was chosen to fix a 48%
corruption rate and must not be disturbed casually); external hardware synchronization.

### The four independent performance problems — track separately, never conflate

| Problem | Question | Current knowledge | Measured by |
|---|---|---|---|
| **Exposure synchronization** | When did light reach each sensor? | **UNKNOWN** | Stage A clock photograph |
| **Capture completion** | When did each JPEG exist? | ~380–520 ms standalone | `nodeMs` per frame |
| **Transport** | How long from S3 to P4? | ~92 KB/s predicted, unmeasured | `transferMs` per frame |
| **Persistence** | How long to commit to card? | 125 ms for 64 KB self-test | `writeMs` + `STORAGE_BENCH` |

Only the first decides whether the product exists. The other three decide whether it feels good.

---

## 11. Firmware-update strategy

**When to repartition: after M3 (camera proven), before any unit leaves the bench with data on it.**
Not earlier — repartitioning before the camera works risks doing it twice. Not later — once units
are in the field with captures and NVS state, a layout change becomes a migration problem instead of
a reflash.

**Current:** `nvs` 24 KB · `phy_init` 4 KB · `factory` 1500 KB. App is 744 KB. ~14.4 MB of 16 MB
unallocated.

**Layout inputs to decide in M8:** two app slots comfortably sized (current app fits twice over in
4 MB with room for growth); `otadata`; `nvs` — consider enlarging, since 24 KB now holds the config
envelope, the capture sequence, the hwv registry, and the clock; a coredump partition
(`espcoredump` is linked with nowhere to write); and partitions for custom sounds (`SOUND_*`
unimplemented) and recipes if those become V1 features.

**V1 required:** OTA slots + `otadata`; the six `FW_*` handlers matched to Studio's **existing**
client; image validation before slot switch; rollback on failed boot; interrupted-update recovery at
every stage; NVS survival across the repartition; version compatibility checks; a documented
cable-and-esptool factory recovery as the floor.

**Later, and deliberately separate:** secure boot, signed images, anti-rollback, flash encryption.
These change the flashing workflow and add key management. **Do not bundle them into V1** — they are
a production-security project, not an update project.

**Node and C6 updates.** Four nodes each needing their own USB-C cable is not serviceable.
`xiaoProxyUpdate` is `false` today; M8 should decide whether the P4 proxies node images over the
existing UART link. The C6, when it exists, becomes a third target that `FW_QUERY` must report — an
image that can silently go stale in the field is a support problem waiting to happen.

---

## 12. Networking / Roll sequencing

**Begin M10 after M3.** Rationale: networking is XL effort and HIGH risk, and it improves nothing
about photography. A camera that uploads unreliable photographs quickly is worse than one that
reliably keeps them on a card.

**One safe parallel exception:** a **C6 transport spike** — P4↔C6 SDIO only — may run from M3 on a
second board, because it touches no capture code. Cap it strictly at transport; do not let it grow
into `NETWORK_*` handlers before M10 proper.

**Sequence:** `P4↔C6 transport` → `radio slave firmware` → `Wi-Fi scan` → `credentials` →
`connect` → `network diagnostics` → `HTTP/TLS` → `Roll registration` → `upload` →
`resilient queue`.

**Hard requirements throughout:**

- **KINO D4 must be fully usable with zero network.** Not degraded — fully usable. Every network
  feature is additive.
- Credentials must never appear in `GET_CONFIG` or a config backup, which rules out the existing JSON
  envelope as their home.
- The **SD card stays authoritative.** A Roll failure, a dead server, or a lost network must never
  lose a photograph.
- Idempotency on capture UUID — already generated and reboot-durable, which is the one piece of Roll
  groundwork that exists.
- Gate F: capture timing and CRC error rates measured with the radio idle, associated, and uploading.
  If uploading degrades capture, uploads are restricted to idle or charging.

**Roll's target flow** (`capture committed locally` → `job created` → `thumbnail uploaded` →
`visible in Roll` → `C1–C4 uploaded` → `server verifies` → `complete`) builds on
`ROLL_DEVICE_CONTRACT.md`. **Do not invent a second contract.** The Twin bridge is browser code and
is not reusable on the device — it is a contract reference, not an implementation to port.

---

## 13. Studio command triage

31 of 71 implemented. Classifying the missing 40:

### V1 required

`FW_QUERY/BEGIN/CHUNK/END/ABORT/STATUS` (M8 — Studio's client already exists) · `FACTORY_RESET` (a
consumer device needs it) · `ENTER/EXIT_MAINTENANCE` (gates the update path safely)

### Useful diagnostic — schedule with the milestone that needs the number

`STORAGE_BENCH` (M0.G — **already advertised**, so this is a correctness fix) · `LINK_BENCH` +
`SET_LINK_BAUD` (Gate A fallback: if 921600 is unreliable, these become the tools) ·
`CAMERA_PHASE` (M4.D2 — real once VSYNC is observed) · `SYNC_BENCH` (M4 — nothing to measure until
arming exists) · `CAMERA_PREVIEW` (Studio-side viewfinder; the on-device one exists, so this is
convenience)

### Later

`NETWORK_*` (M10) · `ROLL_*`, `UPLOAD_*` (M11) · `GET/SET/UPLOAD/DELETE_RECIPE` (needs a flash
partition and a product decision on looks) · `GET_SOUNDS`, `SOUND_*` (needs a partition;
`customSounds` correctly `false`) · `CAMERA_CALIBRATE` (alignment matters for wigglegram quality —
revisit after Gate C, since it may be part of the answer) · `CAMERA_ARM` (subsumed by M4's node
arming; the KDP-level command may not be needed)

### Intentionally unsupported

`CAMERA_FOCUS` — the OV3660 is fixed-focus. `camnode` already gates an autofocus flag on
`OV5640_PID`, so this becomes relevant only if the sensor changes. **Keep it unimplemented and keep
the capability false** rather than stubbing it.

**Principle:** the protocol evolves according to real device needs, not because an opcode exists. An
implemented command that returns invented data is worse than a NACK — the current fail-closed
`UNSUPPORTED_COMMAND` behaviour is correct and should be preserved.

---

## 14. Release gates

| Gate | Purpose | Requires | Definition of done |
|---|---|---|---|
| **Bring-up build** | Engineers can diagnose every subsystem | M0 | `CODE DONE` + diagnostics `BENCH DONE` |
| **Alpha camera** | Reliably captures four images and writes them locally | M1 + M3 (Gates A, B) | Four-camera capture `BENCH DONE` — 500 captures, no corruption |
| **Wiggle alpha** | Four images synchronized well enough for the intended effect | M2 (+ M4 if needed) — **Gate C** | Skew within the measured threshold, photographic set judged acceptable |
| **Party prototype** | Survives an actual evening of repeated captures | M5, M6, M7, M9 (Gates D, E) | Party soak `PRODUCT DONE` — zero lost photographs |
| **Connected prototype** | Studio + Roll work without compromising photography | M10, M11 (Gate F) | Upload `PRODUCT DONE`, capture unaffected, offline fully usable |
| **Product beta** | Update, recovery, power, storage, failure handling credible | M8, M12 | Every failure class has a tested behaviour |

### Three definitions of done — use throughout

| Level | Meaning |
|---|---|
| **CODE DONE** | Implementation exists and builds |
| **BENCH DONE** | Physically verified under controlled conditions |
| **PRODUCT DONE** | Exercised under realistic KINO use and failure conditions |

Worked example:

```text
Four-camera capture

CODE DONE:     P4 coordinates four nodes and persists all frames.  ← TRUE TODAY
BENCH DONE:    500 captures complete without corruption.            ← M3
PRODUCT DONE:  A realistic party session produces reliable          ← Party prototype
               usable wigglegrams.
```

No semantic version numbers assigned. The repository's scheme (`firmware/VERSION`, `versions.json`,
`npm run version:check`, tag prefix `kino-fw-v`) exists and is used, but mapping these gates onto
0.4.0/0.5.0/1.0.0 is a release decision, not an engineering one — and premature numbering invites
treating a version bump as progress.

> ⚠ **Blocking any public release, at any gate:** the Windows XP (Luna) icon artwork now baked into
> `icons_xp.h`. Microsoft does not license these for redistribution, and a `THIRD_PARTY_NOTICES.md`
> entry does not create that right; `license:check` passes because it validates SPDX metadata, not
> redistribution permission. This blocks *release*, not engineering, so it sits off the critical path
> — but it needs original artwork (or licensed equivalents) before anything ships or the repository
> goes public.

---

## 15. Deferred work

Consolidating §7's "do not build yet" with the reasoning:

| Deferred | Waiting on | Why deferring is correct |
|---|---|---|
| Node ARM implementation | M0.D | The mechanism may be different; building the wrong one costs more than a day of reading |
| Flash timing | Gate C | Cannot align a strobe to unknown exposure windows — this is why the current code uses a 900 ms window |
| All networking handlers | M3 | A network stack with nothing worth uploading |
| C6 slave image | Schematic SDIO confirmation | Unconfirmed routing |
| Repartition + `FW_*` | M3 | Repartitioning before the camera is proven risks doing it twice |
| Secure boot / signed images | M8 V1 + key decision | Conflating security with serviceability delays both |
| All battery-dependent features | HW revision (D10) | **No sense path exists.** Building against imaginary telemetry is the specific trap this section prevents |
| Backlight brightness | HW revision (D11) | Plain GPIO, not PWM |
| Card hot-swap architecture | Product decision + M7 | Touches the mount path bring-up depends on |
| Full-screen review, on-device delete, mode slide | M6 | Pure UX, zero risk reduction |
| Core pinning | M3 | A Gate B lever; changing scheduling now removes a variable |
| Recipes, custom sounds | Flash partition (M8) + product decision | Both need storage that does not exist |
| `CAMERA_FOCUS` | Sensor change | OV3660 is fixed-focus; keep it honestly unimplemented |
| Mic front-end | Product decision | Not on the path to a photograph |
| OV5640 migration | Gate C | May become part of the sync answer; deciding now is guessing |

### Preserve — do not rewrite without evidence

The audit found these sound, and several encode hard-won lessons. Replacing any of them requires
concrete evidence of defect, not preference.

| System | Why it stays |
|---|---|
| **KDP framing** (`kdp_core`) | Portable C99, 46 host checks, target-independent |
| **Capture UUID approach** | RFC 4122 v4 from hardware RNG; already the Roll idempotency key |
| **Two-stage CRC architecture** | Transfer vs stored are genuinely different claims |
| **Metadata-last commit** | A folder of unexplained JPEGs is worse than no folder |
| **`rmdir`-only delete** | Cannot take a file it did not write |
| **Diagnostic registry** | Auto-marks only from real events, never auto-marks FAILED |
| **Async capture workers** | Four independent channels are what make concurrency possible; the sequential alternative is 12 s |
| **Native PPA UI renderer** | Measured ~57 fps against 5–8 fps for the obvious alternative; LVGL would discard that |
| **NVS JSON config model** | A struct would silently drop unknown fields and make Studio appear to save settings it then loses |
| **`host_preview`** | Found three visual defects on first run, with zero test hooks in firmware |
| **Fail-closed `UNSUPPORTED_COMMAND`** | Never a silent timeout |
| **Honest `null`-with-reason reporting** | D10, D11, D13 — the discipline that keeps the contract trustworthy |

---

## 16. Top 10 next engineering actions

Exact execution order. Items 1–9 need no camera hardware.

| # | Action | Item | HW | Effort | Rationale |
|---|---|---|---|---|---|
| **1** | Read `esp32-camera` 2.1.7 in `managed_components`; answer the five M0.D questions; write `firmware/SYNC_FEASIBILITY.md` with a verdict and the OV3660 UXGA frame period | M0.D | `NOW` | S | **Highest-value action available.** Can redirect the architecture for a day's reading, and its output shapes M2 and M4 |
| **2** | Move `buttons_init()` and `power_init()` out of the `display_init()` success branch in `main.c`; make `power.c`'s backlight calls tolerate an absent panel | M0.A | `NOW` | XS | Five lines. Removes a failure mode that will bite during the bring-up sessions that disturb the panel |
| **3** | Create `firmware/p4/host_tests/`; cover `capture_quality_to_sensor`, `clock_iso8601`/`clock_set` bounds, `scale_sixteenths`, `capture_meta_json` field set, `media_summary` key mapping | M0.B | `NOW` | S | Both defects that have already shipped lived in exactly these functions, and no existing test could catch either |
| **4** | Add `host_preview`, the new host tests, and a firmware size gate to `.github/workflows/firmware.yml` | M0.C | `NOW` | XS | Locks in #3 and guards the renderer, currently unguarded |
| **5** | Implement pre-capture free-space reserve returning `SD_FULL`, and the boot-time orphan-folder sweep | M0.F | `NOW` | S | Bring-up will reboot mid-capture repeatedly and will fill cards. Both produce corrupt state today |
| **6** | Add microsecond `klog` timestamps; export the per-capture stage timings and four `fire_us` offsets; add per-task stack high-water to `GET_RUNTIME_STATS` | M0.G | `NOW` | S | Bring-up diagnosis depends on cross-task ordering. Build the instruments before you need them |
| **7** | Extend `hardware_validation.c` with `CAM2/3/4_*`, `SYNC_TRIGGER`, `FLASH_EN`, `BTN_SHUTTER` rows; bring `HARDWARE_VALIDATION.md` to 0.3.0 with the display and touch runs | M0.H | `NOW` | S | The registry structurally cannot record the bring-up it governs |
| **8** | Specify `NL_CMD_ARM` (0x13), `NL_CMD_TRIGGER_INFO` (0x14), `NL_STATE_ARMED` and their JSON shapes in `node_link.h` — **header and document only, no implementation** | M0.E | `NOW` | XS | Cheap to commit the protocol; expensive to commit the wrong mechanism before #1 lands |
| **9** | Build the millisecond timing target; write the host-side skew-extraction script; turn §8 into an executable runbook with a blank result column | M2 prep | `NOW` | S | The measurement rig should be ready and trusted before the cameras arrive |
| **10** | Execute the §8 one-camera bring-up checklist, phase by phase, recording every metric — **stop at the first failing checkpoint and fix before proceeding** | M1 | `1-CAM` | M | Gate A. The first physical gate, and everything camera-side waits on it |

Actions 1–9 are parallelisable across people. Action 10 is the moment the roadmap meets hardware,
and its discipline — one checkpoint at a time, one candidate cause per failure — is what will make
the difference between a productive first day and a confusing one.

---

## The question this roadmap answers

> Given everything already implemented, what is the shortest, safest path from today's firmware to
> taking a real, reliable four-camera KINO D4 wigglegram on physical hardware?

**M0.D (a day of reading) → M0.A/B/C/F/G/H (a firmware-only hardening pass) → M1 (one camera, twelve
checkpoints) → M2 (two cameras and a photographed clock).**

That reaches the project's biggest uncertainty with two camera nodes rather than four, using
measurement rather than new architecture, and it is the point at which we will know whether KINO D4
can take the photograph it exists to take.
