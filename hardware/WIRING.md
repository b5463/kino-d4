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
      → constant-current flash driver
```

Battery return, power-module return, display ground, all camera grounds, flash-driver ground, and signal ground share the system ground. Route main power in 20 AWG silicone wire. Keep high current off thin perfboard traces.

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
| `UART1_TX` / `UART1_RX` | `GPIO_TBD` / `GPIO_TBD` | bench validation required |
| `UART2_TX` / `UART2_RX` | `GPIO_TBD` / `GPIO_TBD` | bench validation required |
| `UART3_TX` / `UART3_RX` | `GPIO_TBD` / `GPIO_TBD` | bench validation required |
| `UART4_TX` / `UART4_RX` | `GPIO_TBD` / `GPIO_TBD` | bench validation required |
| `SYNC_OUT` | `GPIO_TBD` | bench validation required |
| `FLASH_EN` | `GPIO_TBD` | bench validation required |
| `BTN_SHUTTER` | `GPIO_TBD` | bench validation required |
| `BTN_FN` | `GPIO_TBD` | bench validation required |
| `SLIDE_MODE` | `GPIO_TBD` | bench validation required |

Locking this table requires a pin-capability review, continuity check, single-camera bring-up, and a four-camera load test. Update firmware, the twin profile, and this file in the same change.

## Display ribbon

The main module uses a 26-pin, 2×13, 2.54 mm female-to-female IDC ribbon about 100 mm long. Mark pin 1 at both ends. Keep the red stripe visible after assembly. Do not fold the ribbon hard against the connector body.

## Flash

The flash LED is driven through an adjustable constant-current module. Begin at 350 mA. The P4 controls the driver's enable input through `FLASH_EN`; it does not source LED current.

The LED star, thermal pad, and copper heatsink form one thermal stack. Confirm electrical isolation where required by the exact LED carrier.

## Before power

1. Disconnect the battery and USB.
2. Check every rail for a short to ground.
3. Confirm battery, diode, capacitor, and MOSFET polarity.
4. Confirm connector pin 1 and UART direction.
5. Power the unloaded rail from a current-limited bench supply.
6. Add the display, then one camera, then the remaining cameras.

Record the final continuity map and GPIO assignments with the build. A photograph alone is not a wiring record.
