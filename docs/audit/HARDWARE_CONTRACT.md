# Hardware contract — current KINO D4 electrical/software boundary

The electrical facts firmware and software may rely on, each with its confidence label. Software-side message contract: `firmware-contract/`. Hardware snapshot detail: `docs/HARDWARE.md`. Machine-readable: `packages/hardware-profiles/src/profiles/d4-v1.json`.

## Topology (`OFFICIAL_SPEC` for parts, `PROVISIONAL` for wiring)

```
Guition ESP32-P4 module (P4 + C6, 4.3" 480×800, 32 MB PSRAM, 16 MB flash)
  ├── UART ×4 @ 921600 (ladder to 3 Mbaud pending bench) ──► 4 × XIAO ESP32-S3 Sense
  │                                                             └── each owns ONE sensor over DVP
  ├── SYNC_TRIGGER (GPIO32, shared edge to all four nodes)
  ├── FLASH_EN (GPIO28, constant-current driver, 350 mA initial target)
  ├── CAM_PWR_EN (GPIO31) → per-channel P-MOSFET switches (channel control pins unresolved)
  └── USB-C ◄── Studio (Web Serial)
```

The P4 never reads a camera bus. Each XIAO owns its sensor; the P4 coordinates over UART. This is load-bearing for every timing and capture model.

## Pin assignments

The full 2×13 header table and the XIAO DVP map live in `docs/HARDWARE.md` (§P4 header, §XIAO camera interface) and in the profile (`gpio`, `header2x13`, `dvpPinMap`). Summary of KINO assignments — **all `PROVISIONAL` until issue #2 closes**:

| Function | Pin |
|---|---|
| CAM1 TX/RX | GPIO52 / GPIO51 |
| CAM2 TX/RX | GPIO50 / GPIO49 |
| CAM3 TX/RX | GPIO34 / GPIO33 |
| CAM4 TX/RX | GPIO30 / GPIO29 |
| SYNC_TRIGGER | GPIO32 |
| FLASH_EN | GPIO28 |
| CAM_PWR_EN | GPIO31 |
| spare | GPIO35 |

Reserved, never repurposed: `ESP_3V3`, `C6_U0RXD`, `C6_U0TXD`, `C6_IO9`, `C6_CHIP_PU`. XIAO DVP interface is `OFFICIAL_SPEC` (Seeed); the OV5640 target module (MJY5OAF-F3M-V1-compatible, 24-pin) must match it, with AFVDD = **2.8 V**, never generic 3.3 V.

## Sensors

- Current: OV3660, 2048×1536, DVP, no AF (`OFFICIAL_SPEC`). FOV unmeasured (`MEASURE_REQUIRED`).
- Planned: OV5640 with VCM AF, 2592×1944, ~69–72° lens target (`PROVISIONAL`). Sensor identity is capability data (`sensorProfiles` in the profile; per-cam `sensors` in `DeviceInfo`) — behavior keys off the reported sensor, never a global assumption.

## Timing contract

Three separate quantities, never conflated: `gpioTriggerSkewUs` (shared-edge distribution), `vsyncPhaseSkewUs` (sensor frame phase), `effectiveExposureSkewUs` (what ruins or saves the photograph). 100–400 µs is a trigger-distribution **target**, not an exposure guarantee; unmeasurable values return `null` with a reason and Studio preserves the uncertainty.

## Power contract

≤3 A continuous at the battery (harness/connector limit, `SELLER_SPEC`), ~6 A short transient only, 3 A fast fuse, charge 0.6 A preferred / 1.5 A max, SW6106 18 W class with a known light-load shutdown risk. Detail and divergences: `docs/audit/POWER_MODEL.md`.

## Serial contract

Host link: USB-CDC at 921600 (currently a fixed constant — a faster host link has no code yet). P4↔XIAO: 921600 baseline, 1.5/2/3 Mbaud ladder gated by `limits.maxUartBaud` and adopted only after LINK_BENCH proves a rate error-free on the real harness. High baud is never assumed reliable.
