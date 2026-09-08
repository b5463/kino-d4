# KINO D4 Mainboard Rev 1.0 — Phase 1 architecture

Status: **Provisional architecture baseline — NOT FOR FABRICATION**  
Date: 2026-09-05  
EDA baseline: KiCad 10.0.6

## 1. Phase 1 result

The recommended Rev 1.0 architecture is:

```text
USB-C VBUS
  -> CC ESD + VBUS TVS/input filter
  -> STUSB4500 standalone PD sink (5 V fallback, 9 V / 2 A preferred)
  -> controlled input FET / BQ25798 VBUS
                                      +----------------------+
Battery connector -> fuse/reverse     | BQ25798 1S buck-boost|
protection -> gauge shunt -> BAT ------| charger + NVDC path  |
                                      +----------+-----------+
                                                 |
                                              SYS_RAW
                                                 |
                         LTC2955 enable ---------+-> TPS61288L -> SYS_5V
                                                                      |
                  +-------------------+----------------+---------------+
                  |                   |                |               |
               P4_5V             camera bank       MB_3V3       monitors/test
                                      |
                         four TPS2553 protected branches
```

The Guition controller remains a separate assembly. The mainboard supplies it
through JP1 pins 2 and 4 and receives three ground returns on pins 5, 6 and 16.
The four camera nodes are powered by independent mainboard branches.

This topology allows autonomous dead-battery USB-PD negotiation and charging,
NVDC load sharing, battery supplement during source transients, and a true
hardware-off state for the 5 V product load while the charging path remains
available.

## 2. Controller interface — locked logical map

The physical JP1 table was measured in ECN-0002. ECN-0003 reassigned pin 21
from the abandoned internal flash to the shutter input. This is the mapping to
capture in the schematic and harness drawing.

| Pin | Guition net | Mainboard use | Direction at Guition | Status |
|---:|---|---|---|---|
| 1 | 3V3 | `P4_3V3_SENSE_A`; sense only, do not back-power | out | measured header map |
| 2 | 5V | `P4_5V_A` | in | required power pin |
| 3 | 3V3 | `P4_3V3_SENSE_B`; sense only, do not back-power | out | measured header map |
| 4 | 5V | `P4_5V_B` | in | required power pin |
| 5 | GND | `GND` | return | required return |
| 6 | GND | `GND` | return | required return |
| 7 | GPIO52 | `CAM1_P4_TX` | out | UART validated mapping |
| 8 | GPIO33 | `CAM3_P4_RX` | in | UART validated mapping |
| 9 | GPIO51 | `CAM1_P4_RX` | in | UART validated mapping |
| 10 | GPIO31 | `CAM_PWR_EN` global hardware gate | out | measured header map |
| 11 | GPIO50 | `CAM2_P4_TX` | out | UART validated mapping |
| 12 | GPIO30 | `CAM4_P4_TX` | out | UART validated mapping |
| 13 | GPIO49 | `CAM2_P4_RX` | in | UART validated mapping |
| 14 | GPIO29 | `CAM4_P4_RX` | in | UART validated mapping |
| 15 | GPIO35 | **NC — leave physically unconnected** | strap | serial-boot strap |
| 16 | GND | `GND` | return | required return |
| 17 | GPIO34 | `CAM3_P4_TX` | out | strap-safe only as driven output |
| 18 | ESP_3V3 | `C6_3V3_SENSE`; service sense only | out | reserved C6 supply |
| 19 | GPIO32 | `SYNC_MASTER` | out | validated sync source |
| 20 | C6_U0RXD | `C6_UART_RX_SERVICE` pogo only | C6 in | service |
| 21 | GPIO28 | `BTN_SHUTTER_N` | in | validated shutter input |
| 22 | C6_U0TXD | `C6_UART_TX_SERVICE` pogo only | C6 out | service |
| 23 | I2C_SDA | `MB_I2C_SDA` | bidirectional | shared Guition bus |
| 24 | C6_IO9 | `C6_BOOT_SERVICE` pogo only | strap | service; no default pull |
| 25 | I2C_SCL | `MB_I2C_SCL` | out/open-drain | shared Guition bus |
| 26 | C6_CHIP_PU | `C6_EN_SERVICE` pogo only | control | service; preserve polarity |

UART names are from the P4 viewpoint. Each `CAMn_P4_TX` connects to the XIAO
receive pin, GPIO44; each XIAO transmit pin, GPIO43, connects to
`CAMn_P4_RX`. All four links operate at 921600 baud in the current firmware.

Pin 15 is not a spare design resource. Pulling GPIO35 low during reset selects
the serial bootloader, so it must remain unconnected on the motherboard and in
the cable except for an isolated, labelled measurement pad on the Guition side
of a deliberately unpopulated link.

## 3. Power budget

### 3.1 Load allocations at SYS_5V

| Load | Typical | Capture/design case | Protected capacity |
|---|---:|---:|---:|
| Guition board | 0.32 A / 1.60 W | 1.00 A / 5.00 W transient allocation | 1.00 A |
| CAM1 | 0.14 A / 0.70 W | 0.35 A / 1.75 W capture | 0.60 A continuous; about 1 A current limit |
| CAM2 | 0.14 A / 0.70 W | 0.35 A / 1.75 W capture | 0.60 A continuous; about 1 A current limit |
| CAM3 | 0.14 A / 0.70 W | 0.35 A / 1.75 W capture | 0.60 A continuous; about 1 A current limit |
| CAM4 | 0.14 A / 0.70 W | 0.35 A / 1.75 W capture | 0.60 A continuous; about 1 A current limit |
| Mainboard logic/monitoring allowance | 0.10 A / 0.50 W | 0.20 A / 1.00 W | 0.25 A |
| **Total** | **0.98 A / 4.90 W** | **2.60 A / 13.00 W** | **3.65 A / 18.25 W** |

The 4 A / 20 W regulator target is retained as silicon, magnetics and copper
capability. It is not a promise that the provisional 1S battery harness can
supply 20 W continuously.

### 3.2 Source constraints

At 9 V / 2 A, the connector supplies 18 W before conversion loss. With a
representative 90% whole-path efficiency, about 16.2 W remains for system load
plus battery charging. A 1.5 A charge at 4.2 V consumes 6.3 W at the cell before
charger loss. Therefore full-rate charging and the 18.25 W conservative system
case cannot coexist. Charge current must be reduced dynamically as system load
rises.

At the 13 W simultaneous-capture allocation, a 9 V / 2 A source leaves roughly
3 W after representative conversion loss, corresponding to only about 0.6–0.7
A of cell charge current. The 1–1.5 A target is available at ordinary loads,
not guaranteed during simultaneous capture.

At 5 V / 3 A, only 15 W enters the board. Full-rate charge remains possible at
the typical 4.9 W system load, but charging must approach zero near the 13 W
capture case. For a legacy/default-current source, the charger input limit must
stay at its safe autonomous value until the negotiated or advertised current is
known.

### 3.3 Battery-only limit

The provisional harness limit is 3 A continuous. Its theoretical input power
is 9 W at 3.0 V, 11.1 W at 3.7 V and 12.6 W at 4.2 V. At 88–92% boost
efficiency this corresponds to only about 1.6–2.3 A on SYS_5V. A short 6 A
battery pulse can support the 13 W capture allocation, subject to the final
cell, protection circuit, connector, wiring and temperature.

Firmware must therefore implement a source-aware power budget:

1. cap continuous battery-only load to the verified harness/cell limit;
2. reduce or stop charging before requesting battery supplement;
3. stagger camera start-up and avoid four simultaneous 1 A inrush events;
4. shed camera branches on undervoltage, overtemperature or source collapse;
5. log source contract, input limit, rail voltage and branch faults.

The expected typical-load runtime from a nominal 3 Ah, 3.7 V pack is about
1.8 hours after a representative 90% usable-energy and 88% conversion derating.
This is an estimate, not a specification, until measured.

## 4. Power-path decision

### 4.1 Preferred parts

- USB-PD sink: STMicroelectronics `STUSB4500QTR`, with NVM profiles for a 9 V /
  2 A preferred contract and a 5 V fallback. NVM programming and readback are
  production-test requirements.
- Charger/power path: Texas Instruments `BQ25798RQMR`, configured for one 4.2 V
  Li-ion cell, 1–1.5 A normal charge current, JEITA/TS qualification, input
  current limiting and battery supplement.
- Main boost: Texas Instruments `TPS61288LRQQR`, set to 5.0 V. The 15 A switch
  class provides the requested 4 A output design headroom, but thermals and the
  battery path limit usable continuous output.
- Mainboard 3.3 V: Texas Instruments `TPS62162DSGR`, 3.3 V / 1 A from SYS_5V.

The BQ25798 SYS output follows the 1S battery region. TPS61288L is therefore a
real boost stage rather than an optional post-regulator. Its enable is the
product power boundary controlled by the LTC2955.

### 4.2 Why this topology

An NVDC charger keeps the battery and system paths managed while allowing the
battery to supplement an input-limited source. A separate 5 V boost gives the
Guition and camera nodes a stable rail during source removal and across the
full battery discharge curve. The cost is two conversion stages while USB is
present and a concentrated thermal zone that needs careful copper and airflow.

A simple linear charger was rejected because it cannot meet the 9 V input,
load-sharing and thermal requirements. A charger-only plus ideal-diode mux was
rejected for Rev 1 because its transition and supplement behavior is harder to
make deterministic. Using the charger's USB-OTG output as the permanent system
rail remains a fallback study item, not the baseline, because forward charging
and battery-backup transitions must be proven without a rail discontinuity.

## 5. Camera power architecture

Each branch is:

```text
SYS_5V
  -> PAC1954 Kelvin shunt channel
  -> TPS2553DRVR adjustable current-limited switch
  -> 22 uF minimum effective bulk + 100 nF local bypass
  -> CAMn_5V connector contacts
```

The initial current-limit target is approximately 1 A, with the final resistor
selected from measured start-up and capture current. `FAULT_N` from every
TPS2553 is read through a TCA9539 I/O expander. The four enables are generated
by the same expander and ANDed with the direct `CAM_PWR_EN` signal from JP1 pin
10. A pull-down on every enable keeps all cameras off through reset.

This preserves both controls:

- direct P4 global cut-off for the entire bank, including recovery from an I2C
  control fault;
- independent I2C branch cycling for CAM1–CAM4.

The Microchip `PAC1954T-E/4MX` measures all four branch currents. Camera-bank
current is the digital sum of its four channels; a separate physical bank shunt
is not required in the baseline because it would add loss without new fault
isolation. A footprint option may be retained if validation needs an
independent aggregate measurement.

## 6. Synchronization and camera service

`SYNC_MASTER` from JP1 pin 19 drives all four channels of
`SN74LVC125APWRG3`. Each output has:

- a 33 ohm source-series resistor footprint;
- a normally-open 0 ohm bypass/configuration footprint;
- a labelled `CAMn_SYNC` test point;
- a route to XIAO D1 / GPIO2.

The buffer is populated by default. Its output enables are strapped active
through individual 0 ohm links so a branch can be isolated during bring-up.

Every camera position also reserves labelled pads for `CAMn_FSIN`,
`CAMn_PWDN`, `CAMn_RESET` and GND. These are not connected to the OV3660 on a
stock XIAO assembly; using them requires a future sensor interposer. The pads
must not imply that stock hardware exposes those signals.

The proposed camera harness is ten positions so that two contacts may share 5 V,
two may share ground, and UART, sync, XIAO reset and XIAO boot/recovery can be
carried without using a fragile loose wire. The exact family and node-side
interposer remain a mechanical release gate.

## 7. I2C and identification plan

The mainboard uses JP1 pins 23/25 and shares the Guition 400 kHz bus. Candidate
7-bit addresses are:

| Address | Device | Function |
|---:|---|---|
| 0x10 | PAC1954 | four camera branch measurements |
| 0x28 | STUSB4500 | PD contract/status and NVM service |
| 0x40 | INA228 | total SYS_5V current/power |
| 0x50 | 24AA025E48 | board data and factory EUI-48 |
| 0x55 | BQ27441-G1A | fuel gauge |
| 0x6B | BQ25798 | charger/power-path control and ADC |
| 0x74 | TCA9539 | camera enables/faults and power-control status |

Addresses must be confirmed against actual strap states and the Guition touch,
audio and C6 devices before schematic freeze. Add configurable series links
and DNP pull-ups at the mainboard connector. Measure the existing Guition
pull-up resistance before populating any mainboard pull-ups.

Board identity uses `24AA025E48T-I/OT`. Reserve a versioned record containing:

```text
magic, record_version, model, hardware_revision, serial_number,
manufacturing_date, assembly_lot, calibration_revision, calibration_crc
```

The factory EUI-48 is not a substitute for the printed product serial number;
both are stored and linked in the manufacturing record.

## 8. Fuel gauge and monitoring

- `BQ27441DRZR-G1A` is the preferred 4.2 V-cell system-side fuel gauge with a
  10 milliohm Kelvin shunt.
- `INA228AIDGSR` with a 5 milliohm Kelvin shunt measures total SYS_5V current,
  power, energy and charge. The shunt dissipates 80 mW at 4 A.
- `PAC1954T-E/4MX` with four 20 milliohm Kelvin shunts measures the camera
  branches. Each shunt dissipates 20 mW at 1 A.
- BQ25798 reports input, charge/discharge and temperature information as a
  second power-path view.

The battery TEMP conductor belongs to the charger safety loop. Do not load it
with two independent bias networks. Until the cell NTC curve is known, the fuel
gauge uses its internal temperature or host-reported temperature derived from
the charger's qualified measurement.

## 9. Physical power control

The baseline uses `LTC2955CTS8-1#TRMPBF` and a C&K
`KT11B0SAM35LFG` side-actuated, momentary switch at a PCB edge.

- Press while off: LTC2955 enables the 5 V boost.
- Press while on: LTC2955 asserts its interrupt; firmware polls the expander,
  closes files, stops camera branches and pulls KILL low through an open-drain
  transistor.
- Held press: the LTC2955 timer removes enable even if firmware is frozen.

For a nominal 9.0 s forced-off target, the LTC2955 relationship
`C_TMR = 0.19 × t_TMR uF/s` gives about 1.70 uF after subtracting the fixed
64 ms. Use 1.8 uF as the initial value and validate the actual 8–10 s interval
across component and temperature tolerance.

The selected switch is side actuated, right-angle SMT, IP57, approximately
6.3 mm × 6.3 mm at the board, 3 N actuation force and 100,000-cycle rated. The
manufacturer drawing, actuator datum, board-edge offset, travel and enclosure
opening must be converted into a controlled mechanical drawing before the
outline is released.

## 10. Connector strategy

### Guition cable

Preferred motherboard connector: Molex Micro-Lock Plus 1.25 mm dual-row,
right-angle, 26-circuit header `5054482651`, mating housing `5054322601`.
The header is keyed, latched and rated 1.5 A per contact. Pins 2 and 4 carry 5 V
in parallel; pins 5, 6 and 16 are ground returns. The Guition end remains a
correctly keyed 2×13, 2.54 mm receptacle matched to the installed header.

This is a custom discrete-wire transition harness, not a simple IDC ribbon.
Continuity, pin-one orientation and connector sourcing are release gates.

### Battery

Preferred production motherboard connector: Molex Micro-Lock Plus 2.0 mm,
right-angle, 3-circuit `5055780341`, mating housing `5055700301`, ordered
BAT+, TEMP, BAT−. Use 22–24 AWG contacts/wire as qualified by the final crimp
system.

The provisional cell reportedly has a PH2.0-class plug. It must either be
re-terminated by the pack supplier to the locked Micro-Lock assembly or the
product current limit must be reduced to the rating of the final PH connector.
Do not use an unverified adapter lead at 3 A continuous.

### Shutter

Preferred signal connector: JST SH side-entry `SM02B-SRSS-TB(LF)(SN)` with
housing `SHR-02V-S-B`, carrying `BTN_SHUTTER_N` and GND. Add local ESD,
100 kOhm pull-up option and RC footprints; default firmware remains active-low
with 25 ms software debounce.

### Cameras

Ten-position locking connectors are preferred so power and ground can use two
contacts each while UART, sync, XIAO reset and XIAO boot remain serviceable.
JST GH and Molex Micro-Lock Plus are the down-select families. The exact board
header, housing, contact, wire gauge and node-side interposer are unresolved.

## 11. Protection partitioning

The detailed schematic shall include:

- USB-C CC ESD protection, VBUS TVS sized for a 9 V contract, controlled input
  FETs, input current limiting and reverse-current blocking;
- battery connector fuse, reverse-polarity blocking and protection coordinated
  with the production pack's PCM;
- BQ25798 input, battery, thermal and charge protections;
- main 5 V short-circuit/thermal protection plus total current alert;
- four current-limited, reverse-blocking camera switches with individual fault
  reporting;
- ESD/noise protection on enclosure-mounted shutter and power switch wiring;
- series damping and test access on every UART and sync branch.

The exact battery protection IC/FET pair and USB VBUS TVS are intentionally not
frozen before the production-cell and cable data are available.

## 12. Mechanical placement constraints

The KiCad board is currently a 117 mm × 70 mm rectangle with origin at its
upper-left corner. It is an envelope, not a released outline.

Placement order:

1. lock enclosure datum, camera optical axes, battery pocket, Guition position,
   cable exits and bend radii;
2. place side power switch and USB-C from controlled actuator/opening drawings;
3. place the 26-pin Guition connector for a relaxed cable path;
4. place four camera connectors nearest their harness exits and in fixed
   CAM1–CAM4 order;
5. place battery connector and fuse next to the battery entry;
6. cluster charger, boost, inductors and high-current capacitors in a compact
   thermal zone with uninterrupted return paths;
7. place bottom-side pogo field and serial/QR areas;
8. add mounting holes and keep-outs from enclosure CAD; only then route.

No mounting hole, connector location or keep-out in the current PCB file is a
manufacturing coordinate. High-current conversion parts should be kept away
from camera sensors, the display flex and enclosure surfaces likely to be
touched.

## 13. PCB construction baseline

- Four layers, 1.6 mm finished FR-4, Tg 150–160 °C.
- 1 oz copper on all four layers.
- L1 components/signals/local power, L2 continuous ground, L3 power and selected
  signals, L4 components/signals/local power.
- ENIG, black solder mask, white silkscreen.
- Default minimum track/space 0.1524 mm / 0.1524 mm where practical.
- Default finished via drill 0.30 mm with tenting; larger thermal/power vias as
  required.
- High-current rails are polygons/pours with stitched returns, not 6 mil traces.
- Kelvin routes are mandatory for all current shunts.

## 14. Thermal estimates to verify

At the typical 4.9 W load, a representative 92% boost efficiency produces
about 0.43 W loss. At 13 W and 90%, loss is about 1.44 W. Near the 18 W rail
design point, even 90% creates about 2 W in the boost stage. Charger loss can
add another watt-class heat source during simultaneous operation and charging.

These are planning numbers only. The layout needs large copper under and around
the BQ25798 and TPS61288L land patterns, dense thermal stitching compatible
with PCBWay assembly, and temperature test points. Enclosure thermal tests at
maximum display, Wi-Fi/SD activity, four-camera streaming and charge are a
release gate.

## 15. Architecture decisions and revisit triggers

### ADR-001 — NVDC charger plus dedicated 5 V boost

Decision: use BQ25798 followed by TPS61288L.  
Trade-off: robust load sharing and battery supplement at the cost of two-stage
USB operation and concentrated heat.  
Revisit if: measured maximum SYS_5V is below 12 W, or a single-stage charger /
5 V backup topology is demonstrated with clean attach/detach behavior.

### ADR-002 — I2C expansion for independent camera control

Decision: TCA9539 provides per-camera enables and fault inputs; direct GPIO31
remains a global hardware gate.  
Trade-off: firmware and a shared bus are added, but independent cycling is
obtained without stealing measured UART, sync or shutter pins.  
Revisit if: the shared Guition I2C bus cannot tolerate the harness capacitance
or address plan.

### ADR-003 — Product-grade battery connector

Decision: down-select Micro-Lock Plus 2.0 rather than treating the provisional
PH2.0-class plug as automatically suitable for 3 A.  
Trade-off: the production pack may need a custom harness.  
Revisit if: the final pack supplier supplies a documented, keyed PH-family
assembly rated for the required current and temperature.

### ADR-004 — Buffered synchronization fan-out

Decision: populate a four-channel LVC buffer and source resistors by default.  
Trade-off: one IC and small propagation delay are added in exchange for branch
isolation, consistent edge drive and debug access.  
Revisit if: measured cable edges show the unbuffered P4 output is cleaner or
sensor-level FSIN requires a different voltage/domain.

## 16. Release blockers

1. Measure TEMP-to-BAT− resistance at room temperature and obtain the complete
   NTC curve and production-cell/PCM datasheet.
2. Measure Guition start-up, display, Wi-Fi/C6, SD write, four-camera streaming,
   simultaneous capture, inrush and brownout currents.
3. Confirm the final 26-pin, battery, camera and shutter connector assemblies,
   crimp contacts, wire gauges, lengths, current ratings and bend radii.
4. Create the controlled side-switch/opening drawing from the selected switch
   manufacturer data and enclosure datum.
5. Establish mounting-hole coordinates, keep-outs, component height limits and
   board outline from enclosure CAD.
6. Confirm all I2C addresses and measure existing bus pull-ups/capacitance.
7. Complete USB-PD NVM programming, charger autonomous-default and dead-battery
   recovery plans.
8. Confirm PCBWay assembly capability and price at 5, 20, 50 and 200 units for
   exposed-pad/HotRod packages and the chosen connectors.

Until these gates close, detailed power component values, charger TS network,
current-limit resistors, connector footprints, mounting holes and final routing
remain provisional.

## 17. Primary component references

- STUSB4500 datasheet: <https://www.st.com/resource/en/datasheet/stusb4500.pdf>
- BQ25798 product and datasheet: <https://www.ti.com/product/BQ25798>
- TPS61288 product and datasheet: <https://www.ti.com/product/TPS61288>
- LTC2955 product and datasheet: <https://www.analog.com/en/products/ltc2955.html>
- BQ27441-G1 product and datasheet: <https://www.ti.com/product/BQ27441-G1>
- PAC1954 product and datasheet: <https://www.microchip.com/en-us/product/pac1954>
- INA228 product and datasheet: <https://www.ti.com/product/INA228>
- TPS2553 product and datasheet: <https://www.ti.com/product/TPS2553>
- TCA9539 product and datasheet: <https://www.ti.com/product/TCA9539>
- SN74LVC125A product and datasheet: <https://www.ti.com/product/SN74LVC125A>
- 24AA025E48 product and datasheet: <https://www.microchip.com/en-us/product/24AA025E48>
- Molex Micro-Lock Plus family: <https://www.molex.com/en-us/products/connectors/wire-to-board-connectors/micro-lock-plus-connectors>
