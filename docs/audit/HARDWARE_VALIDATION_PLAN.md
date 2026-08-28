# Hardware validation plan

Everything below is unmeasured. Twin and Studio carry these values as `PROVISIONAL`, `OFFICIAL_SPEC`, or `SELLER_SPEC`; nothing graduates to `MEASURED`/`VERIFIED` until the physical D4 produces the number. Each item names the tool and the record destination. Bench issues: #1 (measurements), #2 (GPIO lock), #3 (bring-up), #4 (power/flash/UART/timing results).

## Electrical — before firmware locks anything

| Measurement | Method | Records to |
|---|---|---|
| Every JP1 assignment drives its function: CAM1 TX/RX GPIO52/51 (pins 7/9), CAM2 GPIO50/49 (pins 11/13), CAM3 GPIO34/33 (pins 17/8), CAM4 GPIO30/29 (pins 12/14), SYNC_OUT GPIO32 (pin 19) | continuity from the P4 pad to the JP1 pin, then scope on each pin under firmware control. Header positions are already measured (ECN-0002); what is unproven is that each drives its intended function | `d4-v1.json` gpio (`PROVISIONAL` → `VERIFIED`), issue #2 |
| FLASH_EN (GPIO28, pin 21) and CAM_PWR_EN (GPIO31, pin 10) drive their loads | scope each pin under firmware control, then confirm the AO4407 channel follows CAM_PWR_EN | M1 §37, `docs/HARDWARE.md` §P4 header JP1 |
| Per-camera power switching: one shared enable vs individual channel pins | drive CAM_PWR_EN through its chosen route, probe each AO4407 channel | `docs/HARDWARE.md` §Camera power switching |
| GPIO3 / GPIO5 stay owned by touch and LCD reset while CAM1–4 and SYNC_OUT are driven on their neighbours | touch and panel keep working under four-channel UART traffic | issue #2 |
| C6 pins undisturbed by KINO wiring | Wi-Fi throughput during full camera load | issue #3 |

## Timing — the product-deciding numbers

| Measurement | Method | Records to |
|---|---|---|
| Trigger distribution skew across four XIAOs | scope on SYNC_TRIGGER at each node, ≥250 triggers | Skew Bench, `gpioTriggerSkewUs` |
| VSYNC phase distribution per sensor, drift rate | XIAO timestamps VSYNC edges against trigger | `vsyncPhaseSkewUs` |
| Effective exposure skew, aligned vs unaligned | Skew Bench soak + moving-subject test (metronome/turntable) | `effectiveExposureSkewUs`; the 100–400 µs figure stays a target until this exists |
| Flash pulse rise/fall and true duration at 350/500/650 mA | scope on LED current shunt | flash timeline model calibration |
| Flash-to-exposure overlap sufficiency per ambient level | banding test frames at 0.8/1/1.5/2/3 m | Wiggle calibration defaults |

## Sensors and optics

| Measurement | Method | Records to |
|---|---|---|
| OV3660 real FOV (H/V) per assembled module | target chart at measured distance | `horizontalFovDeg`/`verticalFovDeg` (currently null, `MEASURE_REQUIRED`) |
| OV5640 module fit: 24-pin seating, AFVDD 2.8 V rail present, I²C address, VCM range | bench one module on one XIAO before buying four | `sensorProfiles.OV5640_AF` → `MEASURED` |
| AF behavior: focus acquisition time, VCM settle, hunting under party light | firmware AF sweep tool | camera pipeline AF model |
| Optical-center positions vs board centers at final pitch | backlit pinhole or chart alignment | per-camera calibration offsets |
| Lens pitch as built (20–24 mm design window, 22 mm default) | calipers on locked enclosure | `cameraPitchMm` → `MEASURED` |

## Power — seller limits verified, not trusted

| Measurement | Method | Records to |
|---|---|---|
| Battery harness continuous limit: confirm ≤3 A is safe on 24 AWG + PH2.0 (temperature rise) | load test with thermocouple on connector | power model `SELLER_SPEC` → `MEASURED` |
| Worst-overlap draw: 4 cams capturing + flash 500 mA + Wi-Fi upload + display | inline ammeter, scope for transients | power model presets |
| Voltage sag depth/duration during capture+flash | scope on battery and 5 V rail | `batterySag` model |
| SW6106 light-load shutdown threshold and timing | decade load box, walk the current down | `sw6106Shutdown` scenario timing |
| 3 A fuse actual blow time at 4/5/6 A | sacrificial fuses, timed | fuse i²t approximation |
| Charge at 600 mA and 1500 mA: cell temperature, connector temperature | thermocouple soak | charge thresholds (`0.6 A preferred / 1.5 A max`, seller-approved) |
| Real capacity at D4 load profile | full discharge cycle | SOC model |

## Serial links

| Measurement | Method | Records to |
|---|---|---|
| Highest error-free baud per channel: 921600 / 1.5 M / 2 M / 3 M, all four concurrent, ≥100 MB each | LINK_BENCH | final baud choice (02§25) |
| Boot spew shape of real P4 and XIAO ROMs | capture raw bytes at open | decoder resync fixtures |
| Transfer throughput with SD write concurrent | four-capture soak | choreography model constants |

## Storage, controls, thermals

| Measurement | Method | Records to |
|---|---|---|
| SD sustained write speed in-device, card of record | SD benchmark tool | storage model |
| Flash heatsink temperature at duty-cycle worst case | thermocouple, 20 × 20 × 7 mm sink | thermal model, enclosure air-gap check |
| UTR-8100 shell temperature near flash/heatsink | thermocouple after soak | enclosure material decision (SLA shell must not bear heat) |
| Button travel and slide-switch feel through the shell | assembled prototype | control keepouts |

## Twin promotion rule

When a value lands, update `d4-v1.json` (or the owning model constant) in the same change that records the bench evidence, flip its confidence label, and run `graphify update`. A measured value with a stale `PROVISIONAL` label is treated as a bug.
