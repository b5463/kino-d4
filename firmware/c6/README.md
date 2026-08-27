# `kino-c6` — ESP32-C6 radio coprocessor image

The second image the KINO D4 needs to build, flash and version. The P4 runs the
camera; this chip is meant to be its radio and nothing else — no capture, no
Roll, no KDP, no product logic. Anything above the host link belongs to
`firmware/p4/`.

**This image has never run on a D4.** The P4 has no established route to the C6
(`firmware/C6_HARDWARE_MAP.md`), so it cannot be exercised on the bench yet, and
none of the `C6_*` rows in `firmware/HARDWARE_VALIDATION.md` have been earned.
It builds, it is reproducible, and it is versioned. That is the whole claim.

## What it does today

At boot, on UART0:

1. Initialises NVS, so the Wi-Fi PHY calibration is not redone every boot.
2. Starts Wi-Fi in station mode and runs one all-channel scan.
3. Reports the host link state, which is `not-routed`.
4. Prints one banner line with a fixed prefix and stable keys:

```
KINO-C6 fw=0.3.0 role=radio-coprocessor mac=aa:bb:cc:dd:ee:ff radio=up aps=7 link=not-routed
```

`fw=` is `KINO_FW_VERSION`, read from `firmware/VERSION` by
`main/CMakeLists.txt` — the same file the P4 and the four camera nodes read, so
one repo version describes the whole camera. This is the string the P4's KDP
`FW_QUERY` (0x60) will surface for the C6 once the link exists. `FW_QUERY` is
not implemented on the P4 side yet.

There is no association, no DHCP and no IP stack. `esp_netif` and `lwip` are
deliberately absent: a coprocessor with its own TCP/IP stack gives the camera
two stacks on one link, which shows up as duplicated ARP under load. Espressif's
hosted slave excludes both for the same reason.

## Build

No local ESP-IDF. One canonical environment, IDF v5.5.1, the same version pinned
in `.github/workflows/firmware.yml` and `scripts/firmware-daemon.mjs`:

```
docker run --rm -v "C:\path\to\kino d4:/project" -w /project/firmware/c6 espressif/idf:v5.5.1 idf.py set-target esp32c6 build
```

Output is `build/kino-c6.bin`.

`CONFIG_APP_REPRODUCIBLE_BUILD=y`, so two clean builds of one commit produce
byte-identical output — measured, not assumed. Note what "one commit" means
here: `esp_app_desc.version` carries `git describe --always --tags --dirty`, so
the `.bin` changes when HEAD moves even if nothing under `firmware/c6/` changed.
That is source identity, not build-clock noise, and it is the property a bench
record wants. Delete `build/` **and** `sdkconfig` between the two builds, or the
comparison proves nothing.

## C6 SDIO slave pinout

Fixed in silicon. The C6's SDIO *slave* peripheral is not routable through the
GPIO matrix — it is wired to IOMUX pads — so unlike everything in
`firmware/p4/main/board_d4v1.h`, these numbers are not provisional and need no
schematic. They are the reason this image can be written while the P4-side host
cannot.

| C6 signal | C6 pin |
|---|---|
| `CLK` | `GPIO19` |
| `CMD` | `GPIO18` |
| `DAT0` | `GPIO20` |
| `DAT1` | `GPIO21` |
| `DAT2` | `GPIO22` |
| `DAT3` | `GPIO23` |

Source: ESP32-C6 Technical Reference Manual, SDIO slave chapter. Mirrored in
`main/board_c6.h`. `main/transport.c` configures none of them — see below.

## The P4-side routing is unresolved

`firmware/C6_HARDWARE_MAP.md` is the record. In short: the carrier
(Guition `JC4880P443C-I-W`) exposes five C6 header nets — `ESP_3V3`,
`C6_U0RXD`, `C6_U0TXD`, `C6_IO9`, `C6_CHIP_PU` — and no P4 GPIO number is known
for any of them. No SDIO or SPI transport pin is known at all, and it is not
established that the carrier routes SDIO rather than SPI, or either.

So `main/transport.c` drives nothing. It logs the C6-side pads and returns
`ESP_ERR_NOT_SUPPORTED`. Clocking an unrouted bus on `GPIO19`–`GPIO23` is not a
missing feature, it is a board that stops booting predictably; the header
neighbours of the C6 pins are lines the P4 firmware already drives.

## Why no `esp_hosted` yet

The intended architecture is Espressif's supported path: `esp_hosted` slave on
the C6, `esp_wifi_remote` + `esp_hosted` host on the P4. No custom radio
protocol. That is not what this image contains, and the reason is not the
registry being unreachable — it was reachable, and `espressif/esp_hosted`
resolves for `esp32c6`.

`espressif/esp_hosted` (latest 0.0.10) ships the slave under `slave/` as a
**standalone IDF project** — its own `CMakeLists.txt` with
`project(network_adapter)`, its own `main/Kconfig.projbuild`, its own partition
tables. It is not a component you can compose into another app. Adding it to
this project as a managed dependency and registering its sources as `main` fails
at configure time on two counts, both measured on IDF v5.5.1 / esp32c6:

- **Kconfig collision.** The component's own root `Kconfig` (the host driver)
  and `slave/main/Kconfig.projbuild` define the same symbols —
  `ESP_HOST_INTERFACE`, `ESP_SPI_HOST_INTERFACE`, `ESP_SDIO_HOST_INTERFACE`,
  `SPI_CONTROLLER`, `ESP_PKT_STATS` and dozens more, including whole `choice`
  blocks. kconfiglib reports every one as "defined in multiple locations".
- **A hard CMake error.** On a target with native Wi-Fi — which a slave chip is,
  by definition — the component's root `CMakeLists.txt` takes its
  `CONFIG_SOC_WIFI_SUPPORTED` branch, registers with no sources, and so becomes
  an INTERFACE library. Its `idf_component_optional_requires(PRIVATE sdmmc)` at
  line 64 then fails: "INTERFACE library can only be used with the INTERFACE
  keyword of target_link_libraries". This fires as soon as
  `CONFIG_ESP_SDIO_HOST_INTERFACE` is set, which the slave's Kconfig defaults to
  `y` on the C6.

The remaining route to a real hosted slave is to vendor Espressif's Apache-2.0
sources into this repo, which needs a `REUSE.toml` entry and a licence decision
outside this directory. Not done here.

What is here instead is a seam. `main/transport.h` is the one place the slave
transport replaces, and it carries the ordered steps. Nothing else in this image
changes when it is closed.

## Flashing

Unresolved in practice, and worth stating plainly because it gates bench work
even after the schematic arrives.

The four C6 header nets `C6_U0RXD`, `C6_U0TXD`, `C6_IO9` and `C6_CHIP_PU` are
exactly the set needed to flash and console a C6 from an external USB-serial
adapter:

| Header net | C6 pin | External adapter |
|---|---|---|
| `C6_U0RXD` | `U0RXD` | adapter TX |
| `C6_U0TXD` | `U0TXD` | adapter RX |
| `C6_IO9` | `GPIO9` | hold low at reset for download mode |
| `C6_CHIP_PU` | `CHIP_PU` | reset / enable — **polarity and pull unrecorded** |

Ground is common. Hold `C6_IO9` low, pulse `C6_CHIP_PU`, release `C6_IO9`, then:

```
python -m esptool --chip esp32c6 -p PORT -b 460800 write_flash 0x0 build/bootloader/bootloader.bin 0x8000 build/partition_table/partition-table.bin 0x10000 build/kino-c6.bin
```

Two things this cannot tell you. The P4 GPIO numbers behind those four nets are
unknown, so the P4 cannot act as a flashing proxy and no proxy is implemented —
building one against guessed pins has the same failure mode as the transport
itself. And `C6_CHIP_PU` polarity is unmeasured, so the reset sequence above is
the usual arrangement for an ESP32, not this board's confirmed one.

Flash size is left at the IDF default of 2 MB. The C6 module's part number is
not recorded anywhere in this repo (`docs/HARDWARE.md:47` says only
"ESP32-P4 + ESP32-C6"), and a configured flash size larger than the die actually
has produces an image that flashes and then fails to boot. 2 MB is the smallest
C6 configuration, so it is the one that cannot be wrong. Raise it once the
module is identified.

## Layout

```
CMakeLists.txt        project(kino-c6); no EXTRA_COMPONENT_DIRS, on purpose
sdkconfig.defaults    every non-default line carries its reason
dependencies.lock     pins what a clean build fetches (issue #90)
main/main.c           app_main: NVS, radio, host link, banner
main/identity.h       version and banner format, read from firmware/VERSION
main/board_c6.h       SDIO slave pads, fixed in silicon
main/radio.c/.h       Wi-Fi station init and one scan
main/transport.c/.h   THE SEAM — host link, not routed
```

`build/`, `sdkconfig` and `managed_components/` are ignored by the repo root
`.gitignore` via its `firmware/*/` rules, the same as `p4/` and `camnode/`.
Neither of those carries a `.gitignore` of its own, and neither does this one.
