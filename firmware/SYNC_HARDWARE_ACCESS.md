# V2 hardware accessibility audit: FSIN, PWDN, RESET on the XIAO Sense camera stack

Design and documentation only, 2026-09-05. Nothing was soldered, probed,
written or driven. Firmware 0.4.42 / camnode 0.4.38 unchanged. This answers
one question: which sensor control signals can be reached on the camera
hardware D4 has today, and by what. It follows the V2-A audit in
[`SYNC_FEASIBILITY.md`](SYNC_FEASIBILITY.md) and precedes V2-C, which has not
started. Issue #165.

## 1. Exact hardware

| Part | What is known | Source |
|---|---|---|
| XIAO ESP32-S3 (main board) | ESP32-S3R8, 30-pin Hirose DF40 board-to-board (B2B) to the Sense board. Latest published design: `202003753_XIAO ESP32S3 Sense_v1.5_SCH&PCB_260226` (KiCad, 2026-02-26), footprint library still named `v1.2_230725`. The revision on the four fitted units is not readable without dismantling and is UNKNOWN. | Seeed KiCad archive linked from the wiki |
| Sense expansion board | `XIAO ESP32S3 Exp. Board v1.0`, first release 2023-03-23 (Linus Liao). The only published revision. Rails: SGM2036S-2.8 for AVDD and DOVDD, SGM2036S-1.3 for DVDD (net named `VCC_1V8`, part is 1.3 V; not our concern here, recorded because it is odd). | `XIAO_ESP32S3_ExpBoard_v1.0_SCH.pdf` (image PDF) |
| Camera connector | JA1 `AFC01-S24FCC-00`, 24-position 0.5 mm FPC, pins 25/26 shield to ground | same schematic |
| Camera module | OV3660 on a 24-pin flex, the module Seeed ships in place of the discontinued OV2640. Seeed publishes no module drawing or part number; the forum states it is pin-for-pin compatible with the OV2640 module. Module revision marking on our units: UNKNOWN (no photograph in the repository). | Seeed wiki, Seeed forum thread 285171 |
| Sensor | OV3660 CSP, PID 0x3660 read at SCCB 0x3C (2026-08-25) | `HARDWARE_VALIDATION.md` |

Seeed board revision history is one line; there is no evidence of a
re-routed connector between 2023 and now. The datasheet used is OmniVision
OV3660 preliminary specification v1.3 (2011-05-13), the copy Seeed hosts.

## 2. OV3660 FSIN, from the datasheet

- Pad **E3 FSIN**, I/O, "frame sync". Pad circuit class: same as the data
  pads (`PAD ... PD`, an input with a pull-down and an enableable driver).
  After reset it is an input, high-z configurable.
- Registers, and this is all the datasheet says about FSIN:

| Register | Bit | Text | Default |
|---|---|---|---|
| 0x3835 TIMING TC REG35 | [0] | FSIN enable | 0x00 |
| 0x3835 | [1] | FSIN reverse | |
| 0x3836 TIMING TC REG36 | [3:0] | FSIN output width | 0x00 |
| 0x3016 PAD OUTPUT ENABLE 00 | [2] | FSIN output enable (0 input, 1 output) | 0x00 |
| 0x3019 PAD OUTPUT VALUE 00 | [2] | FSIN (GPIO value when driven as pad) | |
| 0x301C PAD SELECT 00 | [2] | IO FSIN select (pad as GPIO or as function) | 0x00 |
| 0x302C PAD CONTROL | [1] | FSIN input enable | column-shifted in the extracted table; read as 0x03 with caution |

- **Timing semantics: not documented.** There is no functional section on
  frame synchronisation in v1.3. The revision history of v1.2 (2011-01-31)
  records that OmniVision *removed* "support for internal and external frame
  synchronization for frame exposure mode" from the features list and removed
  "/ frame exposure" from the shutter specification. The register bits stayed.
  Whether one pulse sets frame phase, whether a pulse is needed every frame,
  what the sensor does between pulses, and what "output width" times, are all
  UNKNOWN from authoritative text. Section 13 lists what would have to be
  measured; nothing here may be assumed.
- Electrical (table 8-3, DC, typical conditions DOVDD = 1.8 V): VIL max
  0.54 V, VIH min 1.26 V, CIN max 10 pF. At the Sense board DOVDD of 2.8 V
  the thresholds are UNKNOWN (not tabulated). Absolute maximum on any I/O:
  -0.3 V to **VDD-IO + 1 V**, so 3.8 V with DOVDD 2.8 V.

## 3. Camera module routing: the 24-pin flex as the Sense board expects it

The Sense connector follows the common 24-pin DVP module pinout (the one
ESP32-CAM class modules use), not the OmniVision reference flex (which puts
STROBE on 1 and FSIN on 10). Read from the v1.0 schematic:

| JA1 pin | Sense board net | | JA1 pin | Sense board net |
|---|---|---|---|---|
| 1 | **NC, floating pad** | | 13 | IO10/XMCLK |
| 2 | AGND | | 14 | IO11/DVP_Y8 |
| 3 | IO40/CAM_SDA | | 15 | DGND |
| 4 | AVCC_2V8 (AVDD) | | 16 | IO12/DVP_Y7 |
| 5 | IO39/CAM_SCL | | 17 | IO13/DVP_PCLK |
| 6 | **RESET: R9 10 kΩ to VCC_3V3, no GPIO** | | 18 | IO14/DVP_Y6 |
| 7 | IO38/DVP_VSYNC | | 19 | IO15/DVP_Y2 |
| 8 | **PWDN: R10 10 kΩ to GND, no GPIO** | | 20 | IO16/DVP_Y5 |
| 9 | IO47/DVP_HREF | | 21 | IO17/DVP_Y3 |
| 10 | VCC_1V8 net (DVDD, 1.3 V LDO) | | 22 | IO18/DVP_Y4 |
| 11 | VCC_2V8 (DOVDD) | | 23 | NC on the module side; **tied to GND** on the board |
| 12 | IO48/DVP_Y9 | | 24 | NC on the module side; **VCC_2V8 through D6** (AF_VCC for the OV5640 module) |

SCCB pull-ups: R7/R8 4.7 kΩ to VCC_2V8 (R16 0 Ω fitted, R13 to 3V3 DNP). So
Seeed keeps the SCCB in the 2.8 V domain but pulls RESET to 3.3 V, which is
within the sensor VDD-IO + 1 V absolute maximum.

**FSIN presence on the module flex: UNKNOWN.** The connector has no FSIN net.
The only flex position a module could carry FSIN on without shorting it is
pin 1, which the board leaves floating; pins 23 and 24 are tied to ground and
2.8 V respectively, so a module that put FSIN or STROBE there would have it
strapped. No published Seeed document states what the OV3660 module routes to
pin 1. Determination: **FSIN_ROUTING_UNKNOWN** (module), and on the board
case **F, the signal is not included**, with pin 1 as the one candidate pad.

RESET: FPC pin 6, active low at the sensor (RESETB, internal pull-up per the
pad table), held high by R9. PWDN: FPC pin 8, active high, held low by R10.
Neither crosses the B2B: all 30 B2B positions are accounted for on both
boards (14 camera, 4 SD, 2 microphone, LED, VIN, 3V3, grounds; positions 20
and 32 are unconnected on the main board and unconnected on the Sense board).
That is the physical reason for `pin_pwdn = -1` and `pin_reset = -1`: the
signals exist on the module and on the connector, and are **strapped on the
expansion board**, not merely left off the ESP32. They are not hard-wired to
a rail; each is a 10 kΩ resistor to a rail, which an external driver can
override.

## 4. Sense-board routing summary

| Signal | Where it goes | Class |
|---|---|---|
| FSIN | not present as a net; JA1 pin 1 floating pad is the only possible landing | F (not included) / candidate pad |
| PWDN | JA1 pin 8 to R10 (10 kΩ, 0201) to GND | D (terminated by pull) |
| RESET | JA1 pin 6 to R9 (10 kΩ, 0201) to VCC_3V3 | D (terminated by pull) |

No test pads on these nets. TP1..TP5 on the Sense board are LDO outputs and
AVDD, not control signals.

## 5. Accessible physical points

| Point | Signal | Difficulty | Safety |
|---|---|---|---|
| A 24-pin 0.5 mm FPC breakout or pass-through adapter inserted between module and JA1 | all 24, so pins 1, 6, 8 on a 2.54 mm header | **EASY** (no soldering to Seeed parts; adds an adapter and a longer flex) | safe; flex extension adds a few pF and length to PCLK/XCLK, which the Seeed layout note asks to keep short; verify streaming after fitting |
| JA1 connector pad 6 / 8 / 1 (0.5 mm pitch, board side) | RESET / PWDN / candidate FSIN | FINE-PITCH | board-side rework on a live product board; a bridge to a neighbour is a shorted DVP line |
| R9 / R10 pad (0201) | RESET / PWDN | DO-NOT-ATTEMPT casually (0201 is 0.6 x 0.3 mm) | a lifted pad loses the pull and the sensor floats |
| Module flex pads 1 / 6 / 8 (0.5 mm, flex side) | candidate FSIN / RESET / PWDN | FINE-PITCH; flex takes heat badly | soldering on the flex risks the flex, not the boards |
| Sensor pad E3 | FSIN | DO-NOT-ATTEMPT: CSP ball under the die, under the lens holder; not reachable at all | |

There is no exposed header pin, test pad, or large via for any of the three
signals on the Sense board. The breakout adapter is the only EASY access, and
it also makes the pin-1 question answerable with a meter instead of a loupe.

## 6. Direct FSIN fan-out from P4 GPIO32 (if FSIN turned out to be reachable)

- P4 GPIO drives 3.3 V. Sensor FSIN is a DOVDD-domain input, 2.8 V here,
  absolute maximum 3.8 V, so a 3.3 V edge is within rating without a level
  shifter. VIH at DOVDD 2.8 V is UNKNOWN; 3.3 V exceeds any plausible VIH.
- Loading: four inputs at CIN 10 pF max plus harness (about 100 mm each,
  roughly 10 pF per 100 mm) is on the order of 80 pF. A P4 GPIO at default
  drive strength moves that in well under a microsecond. One 3.3 V output
  can drive four inputs; no buffer is required electrically.
- Recommended: 100 Ω series at each branch (edge damping over the harness,
  and a current limit if a node is powered off while the P4 drives), and the
  same wiring discipline the proven SYNC_OUT branch already uses. A small
  buffer is preferable only if the FSIN branch has to run alongside the
  existing SYNC_OUT to the XIAO, because then GPIO32 would carry two loads
  of different lengths.
- Unknowns: FSIN pull-down value (affects the idle level with the P4 off),
  VIH/VIL at 2.8 V, and whether FSIN is edge- or level-sensitive.

## 7. Node-local FSIN drive (P4 SYNC_OUT to XIAO GPIO2 ISR to a XIAO pad to FSIN)

- Viable in hardware: the XIAO has free pads the camnode does not use. D0
  (GPIO1), D3 (GPIO4), D4 (GPIO5), D5 (GPIO6) are free; D2, D8, D9, D10 are
  wired to the Sense SD slot the camnode does not use, so free electrically
  but shared. D1 is SYNC_IN, D6/D7 the UART.
- Software path: GPIO ISR on the S3 with the nodes running no Wi-Fi, a few
  microseconds latency; the four nodes already act on a UART command within
  129 µs of each other, and an ISR-driven pad would be tighter than that.
  Expected added jitter: single-digit microseconds, UNKNOWN until measured.
  Against a 15 fps frame period (66.7 ms) and the current 4.9 ms spread it
  is negligible.
- Advantage: the node can gate, delay, or refuse the pulse in software (for
  instance not forwarding during a capture read-out). Disadvantage: a second
  variable per node, and it still needs the FSIN landing that section 3 says
  we do not have.

## 8. Sensor master/slave (CAM1 FSIN as output to CAM2-4)

The register set allows the pad to be an output (0x3016[2], 0x3019[2],
0x3836 "FSIN output width"), so a sensor can drive its FSIN pad. What it
drives, and when, is undocumented. Compared with the P4 as generator: the
P4 path is one wire we already have proven, is independent of any camera,
and boots in a known order; a sensor master makes CAM1 a single point of
failure, ties phase to whichever mode CAM1 is in, and rests on undocumented
behaviour. **Not recommended**, and not documented well enough to be chosen.

## 9. PWDN hardware standby as the fallback (PATH C candidate)

Documented (section 2.6.1): PWDN high halts the internal device clock, resets
all internal counters, keeps registers, cuts most digital circuitry. That is
exactly the "counters reset, registers kept" primitive V2-A found software
standby could not promise. What is documented about timing is only the
power-up sequence: PWDN may go low 5 ms after AVDD is stable; SCCB access
20 ms after PWDN goes low. Not documented: minimum assertion width, first
valid frame after release, whether AEC/AGC state survives (registers do;
the exposure counters are reset by definition), and whether XCLK must keep
running during standby (it is an input from the S3 and would keep running
regardless). Shared drive: four 10 kΩ pull-downs in parallel are 2.5 kΩ, so
one 3.3 V GPIO sources about 1.3 mA; 3.3 V on a 2.8 V-domain pad is within
absolute maximum. Expected limitation: the release edge sets the *start* of
frame timing, and the sensor then needs its own start-up frames; a common
release should put the four sensors within microseconds of each other
initially, and the measured 1.6 ppm rate lock says they would stay within a
millisecond for minutes. This is the smallest documented mechanism that
matches the problem statement (initial phase, not drift).

## 10. RESET as a last resort

Accessible exactly like PWDN (pin 6, 10 kΩ pull-up to 3.3 V; drive low with
an open-drain or a GPIO through 1 kΩ). It clears every register: after
release, 2 ms settle, 20 ms before SCCB, then the whole esp32-camera sensor
initialisation (the OV3660 init table and the D4 format, size, quality, flip
and AE settings) has to be replayed, which today lives inside
`esp_camera_init`. Cost: a full re-init per synchronisation, hundreds of
SCCB writes at 100 kHz, tens of milliseconds, and every AE/AWB convergence
restarted. Worse than PWDN on every axis. Documented to work, so it stays on
the list.

## 11. Operator continuity check (documentation is inconclusive on pin 1)

On ONE module only; CAM3 has the most handling history. Camera power off.
Release the JA1 latch and withdraw the module flex; do not touch the sensor
or the lens.

1. Loupe: look at flex pad 1 (follow the pin-1 mark on the connector). Does
   a trace leave the pad into the flex? Record YES / NO / cannot tell.
2. Meter on continuity, probe tips on the flex pads, never on the sensor:
   - PROBE A pad 1, PROBE B pad 2 (AGND): expected **no beep**.
   - PROBE A pad 1, PROBE B pad 15 (DGND): expected **no beep**.
   - PROBE A pad 1, PROBE B pad 11 (DOVDD): expected **no beep**.
   - PROBE A pad 23, PROBE B pad 15; then pad 24 to pad 15: expected **no
     beep** (confirms the module leaves 23/24 open as the board assumes).
3. Meter on resistance, pad 1 to pad 15: a reading in the tens of kΩ to
   MΩ suggests a routed pad with the internal pull-down of the sensor; open
   suggests NC. This is a hint, not proof: the pull-down value is not
   specified.

A beep on any pad-1 test means pin 1 is a ground or supply on this module
and cannot be FSIN. No beep plus a visible trace means "routed somewhere",
still not proof of FSIN. The only way to prove FSIN on pin 1 without
touching E3 is electrical, through the adapter in section 13, and that is a
V2-C step, not this audit.

## 12. Architecture classification

**PATH F: INSUFFICIENT DOCUMENTATION, CONTINUITY TEST REQUIRED.** The board
side is fully documented (FSIN not present; PWDN and RESET strapped through
10 kΩ, reachable only at fine pitch or through an adapter). The module side
is not: whether the OV3660 flex carries FSIN to the one free pad is unknown,
and Seeed publishes nothing that settles it. If the check in section 11 rules
pin 1 out, the body drops to **PATH C** (FSIN hidden, PWDN hardware-standby
prototype) with the adapter as the access method. If pin 1 is routed and
later proves to be FSIN, it becomes PATH B or D depending on whether the
adapter or fine-pitch work carries the wire.

## 13. Recommended next gate (before V2-C)

**ACCESS-1.** Fit one 24-pin 0.5 mm FPC pass-through adapter with a header
between one module and its Sense board. Confirm the camera still streams
(same preview frame rate, no shortReads beyond the parked baseline). Then,
with no register written and nothing driven: measure the idle level on
header pins 1, 6 and 8 (expected: 6 at 3.3 V, 8 at 0 V, 1 either floating
or a defined level), and the pin-1 resistance to ground. That gives the
first hard fact about pin 1 and proves the only EASY access point works
without hurting the stream. V2-C then has two candidate experiments in
order: (1) a PWDN pulse on that one camera, watching VSYNC phase move with
the release edge; (2) only if pin 1 measured as routed, the FSIN register
experiment on that one camera. What those experiments must settle about
FSIN: one pulse or every frame, edge or level, what happens between pulses,
and what "output width" times.

## 14. If a custom carrier is ever needed (PATH E, not chosen)

Minimum signals to expose: D0-D7 (Y2-Y9), PCLK, VSYNC, HREF, SCCB SDA/SCL,
XCLK, FSIN, PWDN, RESETB, AVDD 2.8 V, DOVDD (1.8 V recommended by
OmniVision), DVDD 1.5 V, AGND, DGND. Test pads: FSIN, PWDN, RESETB, XCLK,
VSYNC, STROBE. Not designed here.

## Sources

- Seeed wiki, XIAO ESP32-S3 getting started (schematic and datasheet links).
- `XIAO_ESP32S3_ExpBoard_v1.0_SCH.pdf`, Seeed, 2023-03-24 (connector,
  pulls, rails; image PDF, read at 340 dpi).
- `202003753_XIAO ESP32S3 Sense_v1.5_SCH&PCB_260226.zip`, Seeed KiCad (B2B
  net list from the PCB file).
- OmniVision OV3660 preliminary specification v1.3, 2011-05-13, as hosted
  by Seeed (pad table, reference flex, sections 2.5, 2.6, 7.1, 7.8, 8.1,
  8.3, revision history).
- Seeed forum thread 285171 (module compatibility statement only).
