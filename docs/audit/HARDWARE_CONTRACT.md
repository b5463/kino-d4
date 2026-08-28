# Hardware contract — current KINO D4 electrical/software boundary

The electrical facts firmware and software may rely on, each with its confidence label. Software-side message contract: `firmware-contract/`. Hardware snapshot detail: `docs/HARDWARE.md`. Machine-readable: `packages/hardware-profiles/src/profiles/d4-v1.json`.

## Topology (`OFFICIAL_SPEC` for parts, `PROVISIONAL` for wiring)

```
Guition ESP32-P4 module (P4 + C6, 4.3" 480×800, 32 MB PSRAM, 16 MB flash)
  ├── UART ×4 @ 921600 (ladder to 3 Mbaud pending bench) ──► 4 × XIAO ESP32-S3 Sense
  │                                                             └── each owns ONE sensor over DVP
  ├── SYNC_OUT (GPIO32, JP1 pin 19, shared edge to all four nodes)
  ├── FLASH_EN (no header pin in V1 — constant-current driver, 350 mA initial target, enable route pending M2)
  ├── CAM_PWR_EN (no header pin in V1) → per-channel P-MOSFET switches (channel control pins unresolved)
  └── USB-C ◄── Studio (Web Serial)
```

The P4 never reads a camera bus. Each XIAO owns its sensor; the P4 coordinates over UART. This is load-bearing for every timing and capture model.

## Pin assignments

The header is `JP1`, 26 pins, 2×13, 2.54 mm, odd pins left and even pins right. The manufacturer JP1 table, the KINO assignment drawing and the XIAO DVP map live in `docs/HARDWARE.md` (§P4 header JP1, §XIAO camera interface) and in the profile (`gpio`, `header2x13`, `dvpPinMap`). Code source of truth: `firmware/p4/main/board_d4v1.h`. Summary of KINO assignments — **all `PROVISIONAL` until issue #2 closes**; no camera has been wired yet:

| Function | P4 GPIO | JP1 pin | Far end |
|---|---:|---:|---|
| CAM1_TX / CAM1_RX | GPIO52 / GPIO51 | 7 / 9 | XIAO 1 RX GPIO44 / TX GPIO43 |
| CAM2_TX / CAM2_RX | GPIO50 / GPIO49 | 11 / 13 | XIAO 2 RX GPIO44 / TX GPIO43 |
| CAM3_TX / CAM3_RX | GPIO34 / GPIO33 | 17 / 8 | XIAO 3 RX GPIO44 / TX GPIO43 |
| CAM4_TX / CAM4_RX | GPIO30 / GPIO29 | 12 / 14 | XIAO 4 RX GPIO44 / TX GPIO43 |
| SYNC_OUT | GPIO32 | 19 | all four XIAO SYNC_IN |
| FLASH_EN | GPIO28 | 21 | flash driver enable |
| CAM_PWR_EN | GPIO31 | 10 | camera bank high-side switch |
| spare | none | none | none available |

JP1 exposes 12 P4 GPIOs (52, 51, 50, 49, 35, 34, 32, 28 left; 33, 31, 30, 29 right), carrying 11 signals with GPIO35 on pin 15 spare. GPIO1/2/3/4/5/20/45/46/47 are NOT on this header: they belong to the `JC-ESP32P4-M3-DEV`, a different carrier sharing only the P4 module, and the map that used them (ECN-0001) was disproved at the bench by a TX-to-RX loopback across JP1 7-9 that received zero bytes. The header was then measured pin by pin (ECN-0002): JP1 13 is GPIO49 and JP1 7 is GPIO52. `GPIO34` and `GPIO35` are ESP32-P4 strapping pins; GPIO35 is the serial-bootloader strap and stays unconnected, GPIO34 carries `CAM3_TX` as an output only. `CAM_PWR_EN` is routed again on GPIO31 (pin 10), so the M2 I²C expander ECN-0001 proposed is unnecessary.

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
