# ESP32-C6 hardware map — KINO D4 V1

What is actually known about the P4 ↔ ESP32-C6 connection on the
Guition `JC4880P443C-I-W`, and what is not.

**Verdict: the transport routing is NOT established. No P4 pin may be driven
toward the C6 until it is.**

This file exists because the networking work (issue #133) was gated on it. The
gate did not pass. Everything below is evidence from this repository or the
part datasheets; nothing here is inferred from what would be convenient.

## Why this gate exists

A guessed transport pin is not a failed feature, it is a broken camera. The
five C6-facing header pins sit next to lines this firmware already drives —
`GPIO32` (`SYNC_OUT`) and `GPIO28` (`FLASH_EN`) are the header neighbours of
`C6_U0RXD` and `C6_U0TXD`. Driving a guessed SDIO bus into that region can
contend with the C6's own boot straps, and `C6_CHIP_PU` is an enable whose
polarity nothing in this repo records. The failure mode is not "no Wi-Fi", it
is a board that stops booting predictably.

## What the repository establishes

The C6 is fitted to the carrier, and five header pins belong to it. That is
the whole of it.

| Signal | P4 pin | C6 pin | Purpose | Evidence |
|---|---|---|---|---|
| `ESP_3V3` | — | supply | C6 power rail, from the carrier | `packages/hardware-profiles/src/profiles/d4-v1.json:36`; `docs/HARDWARE.md:95` |
| `C6_U0RXD` | **UNKNOWN** | `U0RXD` | C6 console / serial-flash receive | `d4-v1.json:36`; `docs/HARDWARE.md:96` — header net name only, no P4 GPIO given |
| `C6_U0TXD` | **UNKNOWN** | `U0TXD` | C6 console / serial-flash transmit | `d4-v1.json:36`; `docs/HARDWARE.md:97` — net name only |
| `C6_IO9` | **UNKNOWN** | `GPIO9` | C6 boot strap (GPIO9 is the C6 download-mode strap) | `d4-v1.json:36`; `docs/HARDWARE.md:98` — net name only |
| `C6_CHIP_PU` | **UNKNOWN** | `CHIP_PU` | C6 reset / enable | `d4-v1.json:36`; `docs/HARDWARE.md:99` — net name only, **polarity and pull unrecorded** |

All five are recorded as reserved and undriven, which is the one thing this
firmware can safely honour:

> `ESP_3V3`, `C6_U0RXD`, `C6_U0TXD`, `C6_IO9`, and `C6_CHIP_PU` belong to the
> C6 and must not be repurposed.
> — `docs/HARDWARE.md:101`, and again in `docs/audit/HARDWARE_CONTRACT.md:34`

## What is unknown

Every signal a hosted transport needs:

| Signal | State |
|---|---|
| SDIO `CLK` | **UNKNOWN** — no P4 GPIO recorded anywhere in the repo |
| SDIO `CMD` | **UNKNOWN** |
| SDIO `D0`–`D3` | **UNKNOWN** — nor whether the link is 1-bit or 4-bit |
| SDMMC slot for the hosted link | **UNKNOWN** |
| SPI `SCLK`/`MOSI`/`MISO`/`CS`/`HANDSHAKE` (if SPI, not SDIO) | **UNKNOWN** |
| P4 GPIO behind `C6_U0RXD` / `C6_U0TXD` / `C6_IO9` / `C6_CHIP_PU` | **UNKNOWN** — the header table names the nets but, unlike its left column, gives them no `GPIOnn` |
| `C6_CHIP_PU` polarity, pull, and sequencing | **UNKNOWN** |
| Antenna path / RF switch | **NOT RECORDED** — nothing in the repo |
| C6 USB accessibility | **NOT RECORDED** |
| C6 recovery / programming path | **NOT RECORDED** — see "Flashing the C6" below |

There is no schematic, netlist, PCB source, or datasheet for the carrier in
this repository. `hardware/pcb/` and `hardware/cad/` contain only `README.md`.

### The transport is not even known to be SDIO

The repo's prose assumes SDIO throughout — `firmware/FIRMWARE_ROADMAP.md:1026`
requires "C6 SDIO routing confirmed", and `HARDWARE_VALIDATION.md:79` records
"no SDIO bring-up". But the repo's only C6 *pin data* is a UART pair, a strap
and an enable. A UART pair plus `IO9` plus `CHIP_PU` is exactly the set needed
to **flash and console** a C6 — it is not a data transport for Wi-Fi offload.

Those two things disagree, and nothing in the repo reconciles them. Three
possibilities remain open, and they are not equivalent:

1. The carrier routes a full SDIO bus that the header simply does not expose,
   and the four header pins are only the programming path. (This is the
   arrangement on Espressif's own ESP32-P4-Function-EV-Board.)
2. The carrier routes SPI instead.
3. The carrier routes **only** those four pins, in which case there is no
   high-rate transport to the C6 at all and no amount of firmware will produce
   Wi-Fi on this board revision.

Case 3 is a hardware finding, not a firmware task. Until the schematic settles
which of the three holds, writing a transport driver would be writing three
drivers and shipping the wrong one.

## What the P4's own pin budget already constrains

The SD card is the one pin group on this board validated against real
hardware, and it is the constraint any SDIO plan has to survive.

| Signal | P4 GPIO | State |
|---|---|---|
| `SD_CLK` | 43 | VALIDATED 2026-08-26 |
| `SD_CMD` | 44 | VALIDATED |
| `SD_D0`–`SD_D3` | 39, 40, 41, 42 | VALIDATED |
| SD power | on-chip LDO ch4 | VALIDATED |

Source: `firmware/p4/main/board_d4v1.h:47-55`, `HARDWARE_VALIDATION.md`.

`firmware/p4/main/storage.c:40` takes `SDMMC_HOST_DEFAULT()` and never assigns
`host.slot`, so the card's slot index is whatever the installed IDF defaults
to and is not recorded in this repo. A hosted SDIO link needs an SDMMC slot of
its own; whether one is free cannot be answered from here either.

**This is a second, independent unknown**: even given C6 pin numbers, the SD
card's slot occupancy has to be established before an SDIO host can be
configured beside it. Both must be resolved together.

## The C6 side is not ambiguous

One half of the problem is fixed in silicon and needs no schematic. The
ESP32-C6's SDIO **slave** peripheral is not routable through its GPIO matrix —
it is pinned to fixed IOMUX pads:

| C6 signal | C6 pin |
|---|---|
| `CLK` | `GPIO19` |
| `CMD` | `GPIO18` |
| `DAT0` | `GPIO20` |
| `DAT1` | `GPIO21` |
| `DAT2` | `GPIO22` |
| `DAT3` | `GPIO23` |

Source: ESP32-C6 Technical Reference Manual, SDIO slave chapter. `GPIO9` is
the C6's download-mode strap, which is consistent with the `C6_IO9` header net
being exactly that.

This is why `firmware/c6/` can be written, built and versioned now: the slave
image's pin configuration is a property of the C6, not of the carrier. What
cannot be written is the **P4-side host**, whose pins are the unknown.

## Flashing the C6

Unresolved, and worth stating plainly because it gates bench work even after
the schematic arrives. `C6_U0RXD`/`C6_U0TXD`/`C6_IO9`/`C6_CHIP_PU` on the
header are consistent with flashing the C6 from an external USB-serial adapter
wired to those four pins. Whether the P4 can instead drive them — the
"flashing proxy" that would make development practical — depends on the same
missing P4 GPIO numbers.

No proxy has been implemented. Implementing one against guessed pins has the
same failure mode as the transport itself.

## How to close this gate

In order. Each step is cheap; the first is the only one that needs anything
from outside the repository.

1. **Obtain the carrier schematic** from Guition for `JC4880P443C-I-W`, or
   buzz out the module by hand. The community field notes at
   <https://github.com/ultramcu/guition-jc4880p443c-i-w> are the source the SD
   map came from, and `HARDWARE_VALIDATION.md:161` already flags them as
   "useful, but not our unit" — good enough to form a hypothesis, not to drive
   a pin.
2. **Record the transport** — SDIO or SPI, bus width, and every P4 GPIO — in
   the table at the top of this file, with the evidence column naming the
   schematic sheet or the continuity measurement.
3. **Establish the SD card's SDMMC slot** and confirm a slot remains for the
   hosted link. If none does, the transport must be SPI.
4. **Add the pin block to `board_d4v1.h`** as `BOARD_C6_*`, marked
   PROVISIONAL, and add one `HWV_C6_*` row per pin to
   `hardware_validation.h` so the firmware marks them from real events rather
   than from this document.
5. **Enable the host** — see `C6_BRINGUP.md`. The seam is already in place:
   `net_link` reports `C6_NOT_ROUTED` today and needs the pin block and a
   transport implementation, not a redesign.
6. **Move the registry rows** in `HARDWARE_VALIDATION.md` only from observed
   device events.

Until step 2 is done, the honest firmware state is the one it now reports:
the radio is fitted, and the P4 has no route to it.

## Registry rows this gate owes

None have been earned. Listed so they exist before the bench run, not after:

| Row | Evidence needed | State |
|---|---|---|
| `C6_TRANSPORT_ROUTED` | Schematic or continuity trace naming every transport pin | **UNVALIDATED** |
| `C6_ENABLE_POLARITY` | Measured `CHIP_PU` behaviour | **UNVALIDATED** |
| `C6_SLAVE_IMAGE` | `kino-c6.bin` flashed and its version read back | **UNVALIDATED** |
| `C6_LINK_HANDSHAKE` | P4 completes the hosted handshake | **UNVALIDATED** |
| `C6_WIFI_SCAN` | Scan returns a known AP | **UNVALIDATED** |
| `C6_WIFI_ASSOCIATE` | Association with a WPA2 AP | **UNVALIDATED** |
| `C6_DHCP` | Lease obtained | **UNVALIDATED** |
| `C6_DNS` | Name resolved | **UNVALIDATED** |
| `C6_TLS` | Certificate-verified HTTPS response | **UNVALIDATED** |
| `C6_ROLL_UPLOAD` | A capture reaches a Roll from the camera | **UNVALIDATED** |
