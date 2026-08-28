# Hardware contract — current KINO D4 electrical/software boundary

The electrical facts firmware and software may rely on, each with its confidence label. Software-side message contract: `firmware-contract/`. Hardware snapshot detail: `docs/HARDWARE.md`. Machine-readable: `packages/hardware-profiles/src/profiles/d4-v1.json`.

## Topology (`OFFICIAL_SPEC` for parts, `PROVISIONAL` for wiring)

```
Guition ESP32-P4 module (P4 + C6, 4.3" 480×800, 32 MB PSRAM, 16 MB flash)
  ├── UART ×4 @ 921600 (ladder to 3 Mbaud pending bench) ──► 4 × XIAO ESP32-S3 Sense
  │                                                             └── each owns ONE sensor over DVP
  ├── SYNC_OUT (GPIO20, JP1 pin 17, shared edge to all four nodes)
  ├── FLASH_EN (no header pin in V1 — constant-current driver, 350 mA initial target, enable route pending M2)
  ├── CAM_PWR_EN (no header pin in V1) → per-channel P-MOSFET switches (channel control pins unresolved)
  └── USB-C ◄── Studio (Web Serial)
```

The P4 never reads a camera bus. Each XIAO owns its sensor; the P4 coordinates over UART. This is load-bearing for every timing and capture model.

## Pin assignments

The header is `JP1`, 26 pins, 2×13, 2.54 mm, odd pins left and even pins right. The manufacturer JP1 table, the KINO assignment drawing and the XIAO DVP map live in `docs/HARDWARE.md` (§P4 header JP1, §XIAO camera interface) and in the profile (`gpio`, `header2x13`, `dvpPinMap`). Code source of truth: `firmware/p4/main/board_d4v1.h`. Summary of KINO assignments — **all `PROVISIONAL` until issue #2 closes**; no camera has been wired yet:

| Function | P4 GPIO | JP1 pin | Far end |
|---|---:|---:|---|
| CAM1_TX / CAM1_RX | GPIO1 / GPIO2 | 7 / 9 | XIAO 1 RX GPIO44 / TX GPIO43 |
| CAM2_TX / CAM2_RX | GPIO47 / GPIO46 | 10 / 12 | XIAO 2 RX GPIO44 / TX GPIO43 |
| CAM3_TX / CAM3_RX | GPIO32 / GPIO33 | 19 / 21 | XIAO 3 RX GPIO44 / TX GPIO43 |
| CAM4_TX / CAM4_RX | GPIO45 / GPIO4 | 14 / 13 | XIAO 4 RX GPIO44 / TX GPIO43 |
| SYNC_OUT | GPIO20 | 17 | all four XIAO SYNC_IN |
| FLASH_EN | none | none | unassigned, pending M2 |
| CAM_PWR_EN | none | none | unassigned, pending M2 |
| spare | none | none | none available |

JP1 exposes 11 P4 GPIOs (1, 2, 3, 4, 5, 20, 32, 33, 45, 46, 47). GPIO3 (`BOARD_TOUCH_RESET`) and GPIO5 (`BOARD_LCD_RESET`) are taken by validated peripherals. The 9 free pins carry 8 UART lines and `SYNC_OUT`. `FLASH_EN` and `CAM_PWR_EN` have no pin; the M2 candidate is an I²C GPIO expander on `ESI2C_SDA`/`ESI2C_SCL` (JP1 pins 23/25). GPIO52/51/50/49/35/34/31/30/29/28 are not on the header. The map that used them (commit `1bc8a7e`) was transcribed from an assumed third-party list, not the silkscreen; `docs/HARDWARE.md` §How the wrong map got in records it. The old `CAM_PWR_EN GPIO31 VALIDATED (pin only)` claim is void for the same reason.

Reserved, never repurposed: JP1 pins 20, 22, 24, 26 (`C6_U0RXD`, `C6_U0TXD`, `C6_IO9`, `C6_CHIP_PU`) — the C6 console and programming path, not its transport (that is SDIO on GPIO14–19 plus `EN` GPIO54, internal to the module). XIAO DVP interface is `OFFICIAL_SPEC` (Seeed); the OV5640 target module (MJY5OAF-F3M-V1-compatible, 24-pin) must match it, with AFVDD = **2.8 V**, never generic 3.3 V.

## Sensors

- Current: OV3660, 2048×1536, DVP, no AF (`OFFICIAL_SPEC`). FOV unmeasured (`MEASURE_REQUIRED`).
- Planned: OV5640 with VCM AF, 2592×1944, ~69–72° lens target (`PROVISIONAL`). Sensor identity is capability data (`sensorProfiles` in the profile; per-cam `sensors` in `DeviceInfo`) — behavior keys off the reported sensor, never a global assumption.

## Timing contract

Three separate quantities, never conflated: `gpioTriggerSkewUs` (shared-edge distribution), `vsyncPhaseSkewUs` (sensor frame phase), `effectiveExposureSkewUs` (what ruins or saves the photograph). 100–400 µs is a trigger-distribution **target**, not an exposure guarantee; unmeasurable values return `null` with a reason and Studio preserves the uncertainty.

## Power contract

≤3 A continuous at the battery (harness/connector limit, `SELLER_SPEC`), ~6 A short transient only, 3 A fast fuse, charge 0.6 A preferred / 1.5 A max, SW6106 18 W class with a known light-load shutdown risk. Detail and divergences: `docs/audit/POWER_MODEL.md`.

## Serial contract

Host link: USB-CDC at 921600 (currently a fixed constant — a faster host link has no code yet). P4↔XIAO: 921600 baseline, 1.5/2/3 Mbaud ladder gated by `limits.maxUartBaud` and adopted only after LINK_BENCH proves a rate error-free on the real harness. High baud is never assumed reliable.
