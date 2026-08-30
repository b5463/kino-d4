# D4 V1 wiring

This file defines logical connections and wire classes. Final ESP32-P4 GPIO numbers remain unassigned until hardware validation.

## Power path

```text
505573 LiPo positive
  → F3A fuse near the pouch
  → 1S protection board
  → SW6106 charger / boost module
  → 5 V main rail
      → ESP32-P4 display module
      → four switched camera channels
```

Battery return, power-module return, display ground, all camera grounds, and signal ground share the system ground. Route main power in 20 AWG silicone wire. Keep high current off thin perfboard traces.

The battery harness is rated at no more than 3 A sustained. A 10 A marking on the protection board does not raise that system limit.

## Camera harnesses

Each camera node has one detachable four-pin harness and one separate sync wire.

| Net | Direction | Gauge | Provisional color |
|---|---|---:|---|
| `CAMn_5V` | switched 5 V rail to XIAO | 24 AWG | red |
| `CAMn_GND` | system ground to XIAO | 24 AWG | black |
| `CAMn_TX` | P4 TX to XIAO RX | 28 AWG | blue |
| `CAMn_RX` | XIAO TX to P4 RX | 28 AWG | green |
| `CAMn_SYNC` | shared P4 sync output to XIAO sync input | 28 AWG | yellow |

The colors are the current harness convention, not an electrical property. Label both ends. Confirm connector orientation with continuity before plugging in a camera.

## Camera power switch

One high-side channel controls each camera:

```text
P4 CAM_PWR_n high
  → 4.7 kΩ base resistor
  → 2N3904 on
  → P-channel MOSFET gate pulled low
  → camera 5 V on
```

Each channel uses an AO4407 or AO4407A P-channel MOSFET, a 100 kΩ gate pull-up, a recommended 100 kΩ base-to-ground resistor, and a 1N5819 series Schottky diode. Confirm the adapter pinout against the exact MOSFET datasheet before soldering.

## GPIO map

| Function | P4 pin | Status |
|---|---|---|
| `CAM_PWR_1` | `GPIO_TBD` | bench validation required |
| `CAM_PWR_2` | `GPIO_TBD` | bench validation required |
| `CAM_PWR_3` | `GPIO_TBD` | bench validation required |
| `CAM_PWR_4` | `GPIO_TBD` | bench validation required |
| `CAM1_TX` / `CAM1_RX` | `GPIO_TBD` / `GPIO_TBD` | bench validation required |
| `CAM2_TX` / `CAM2_RX` | `GPIO_TBD` / `GPIO_TBD` | bench validation required |
| `CAM3_TX` / `CAM3_RX` | `GPIO_TBD` / `GPIO_TBD` | bench validation required |
| `CAM4_TX` / `CAM4_RX` | `GPIO_TBD` / `GPIO_TBD` | bench validation required |
| `SYNC_OUT` | `GPIO_TBD` | bench validation required |
| `FLASH_EN` | none in D4-V1 | external module, ECN-0003 |
| `CAM_PWR_EN` | `GPIO_TBD` | bench validation required |
| `BTN_SHUTTER` | `GPIO28` / JP1 21 | validated 2026-08-30 — `HWV_BTN_SHUTTER` earned on the first press, `firmware/HARDWARE_VALIDATION.md` |
| `BTN_FN` | `GPIO_TBD` | bench validation required |
| `SLIDE_MODE` | `GPIO_TBD` | bench validation required |

The `PROVISIONAL` candidate for each row lives in `packages/hardware-profiles/src/profiles/d4-v1.json` (`gpio`, with the JP1 pin for each signal) and `firmware/p4/main/board_d4v1.h`. A row here moves off `GPIO_TBD` only with bench evidence.

The P4's `JP1` header (26-pin, 2×13) exposes twelve P4 GPIOs, measured on the board (ECN-0002). Eleven carry signals: the four UART pairs take 8, `SYNC_OUT` takes `GPIO32` on pin 19, `CAM_PWR_EN` takes `GPIO31` on pin 10, and `BTN_SHUTTER` takes `GPIO28` on pin 21 (ECN-0003). `GPIO35` on pin 15 is the twelfth and stays unconnected: it is the serial-bootloader strap. `BTN_FN`, `SLIDE_MODE` and the four `CAM_PWR_n` lines have no header pin on this carrier; their route is an open M2 question, the standing candidate being an I²C GPIO expander on pins 23/25.

`BTN_SHUTTER` is wired as a 6 × 6 × 4.3 mm tactile switch between JP1 pin 21 and GND on JP1 pin 6 or pin 16. No external pull-up and no debounce capacitor: the P4's internal pull-up holds the pin high, the input is active low, and firmware debounces 25 ms. `HWV_BTN_SHUTTER` was earned on the first debounced press on 2026-08-30 (unit `KD4-D121BC`, firmware 0.4.7), and that press took a photograph; with a meter against pin 6 the pin reads 3.3 V idle and 0 V held.

Locking this table requires a pin-capability review, continuity check, single-camera bring-up, and a four-camera load test. Update firmware, the twin profile, and this file in the same change.

## Display ribbon

The main module uses a 26-pin, 2×13, 2.54 mm female-to-female IDC ribbon about 100 mm long. Mark pin 1 at both ends. Keep the red stripe visible after assembly. Do not fold the ribbon hard against the connector body.

## Flash

D4-V1 has no built-in flash. The constant-current direct-flash assembly was dropped in design package 0.1.3 (ECN-0003) when its enable pin, `GPIO28` on JP1 21, went to the shutter button. The P4 controls no flash enable line in this revision.

A separate external flash module is intended instead. Its part, drive current, and control interface are not chosen, so nothing here specifies how it connects. Do not wire a flash enable to JP1 pin 21; that pin is an input with a pull-up on it now.

## Before power

1. Disconnect the battery and USB.
2. Check every rail for a short to ground.
3. Confirm battery, diode, capacitor, and MOSFET polarity.
4. Confirm connector pin 1 and UART direction.
5. Power the unloaded rail from a current-limited bench supply.
6. Add the display, then one camera, then the remaining cameras.

Record the final continuity map and GPIO assignments with the build. A photograph alone is not a wiring record.
