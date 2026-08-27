# firmware/c6 — ESP32-C6 ESP-Hosted coprocessor

The radio image for the ESP32-C6 on the Guition `JC4880P443C-I-W`
(module `JC-ESP32P4-M3-C6`). It is Espressif's official ESP-Hosted
**coprocessor** firmware, built for `esp32c6` with the SDIO transport. The P4
is the host: it owns the IP stack and drives this chip's Wi-Fi over RPC.

This project is a thin shell around one pinned component. `main/` starts NVS
and the default event loop and prints one identifying line; everything else —
the radio, the RPC server, the SDIO slave — is
`espressif/esp_hosted`, selected by the `CONFIG_ESP_HOSTED_CP_*` options in
`sdkconfig.defaults`. There is no KINO networking code here and there must not
be: capture, Roll and KDP are the P4's, and a coprocessor that also holds
product logic gives the camera a second place to disagree with itself.

**Nothing in this directory has been flashed or run on hardware.** Read
`firmware/C6_HARDWARE_MAP.md` and the two gates below before writing C6 flash.

## GATE 1 — the C6 module's flash size is not established

> `sdkconfig.defaults` sets `CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y`.
> **The C6 module's actual flash size is UNKNOWN** (`firmware/C6_HARDWARE_MAP.md`,
> "What is still unknown"). An image built for more flash than the die carries
> **flashes successfully and then fails to boot**, and `ota_1` at offset
> `0x1D0000` is past the end of a 2 MB part. Confirm the module's flash size
> against the actual board — `esptool.py flash_id` over the recovery path in
> GATE 2 — **before the first write**.

4 MB is not a preference. It is what the reference selects for the C6, and the
coprocessor image does not fit the 2 MB alternative:

| | |
|---|---|
| `build/kino-c6.bin` | 1 105 872 bytes (1080 KB) |
| `partitions_eh_cp_ota_4m.csv` slot | `0x1C0000` = 1 835 008 bytes (1792 KB) — fits, 39% headroom |
| `partitions_eh_cp_ota_2m.csv` slot | `0xF0000` = 983 040 bytes (960 KB) — **does not fit**, over by 122 KB |

So if the module turns out to carry less than 4 MB, the answer is a different
image (drop features, drop dual OTA), not a smaller partition table. Do not
"fix" this by editing the CSV: those offsets are the coprocessor OTA contract
and changing them invalidates every already-flashed unit.

## GATE 2 — prove recovery before the first flash write

The C6 has no USB path this repo can rely on. Its console and download pins
reach the carrier's 2×13 header as `C6_U0RXD`, `C6_U0TXD`, `C6_IO9` and
`C6_CHIP_PU` (`packages/hardware-profiles/src/profiles/d4-v1.json`,
`docs/HARDWARE.md`), so flashing is an **external USB-serial adapter**
operation:

| Header net | C6 pin | Adapter |
|---|---|---|
| `C6_U0RXD` | `U0RXD` | adapter TX |
| `C6_U0TXD` | `U0TXD` | adapter RX |
| `C6_IO9` | `GPIO9` | pull LOW at reset to enter download mode |
| `C6_CHIP_PU` | `CHIP_PU` | LOW = held off, HIGH = running |
| `ESP_3V3` | supply | ground reference only — do not back-feed |

Sequence, and the order matters:

1. Wire the adapter. **Do not write anything yet.**
2. Read what is already there: `esptool.py --port <adapter> flash_id`, then
   `read_flash` the factory image to a file and keep it. This board is publicly
   reported to ship C6 firmware older than current hosts expect, and that
   factory image is the only copy of it that will ever exist. Losing it removes
   the ability to compare a working link against a broken one.
3. `flash_id` also answers GATE 1.
4. Prove the recovery path *works*, not just that it reads: erase and re-flash
   the factory image you just saved, and confirm the module still boots. A
   recovery path that has never been exercised is not a recovery path.
5. Only then write this image.

Whether the P4 can drive those four pins — the proxy that would make this a
one-cable operation — needs P4-side GPIO numbers for them, which the repo does
not record.

## GATE 3 — the version-compatibility gate

A version mismatch between host and coprocessor **presents as a transport
problem, not a Wi-Fi problem**: no handshake, no link, no scan, and nothing on
either console that says "versions". Expect to be misled by it.

Three separate versions are in play. Keep them straight:

| Version | Where it lives | What it gates |
|---|---|---|
| ESP-Hosted component | `dependencies.lock`, pinned `3.0.6` | the RPC wire and the SDIO framing |
| C6 factory image | on the module now, **unread** | whether the board works before we touch it |
| KINO repo version | `firmware/VERSION`, in the console banner | which commit built this image |

Rules:

- **The host and this coprocessor must be built from the same
  `espressif/esp_hosted` version.** `main/idf_component.yml` pins `"3.0.6"`
  exactly — not `"~3.0.6"` — so a patch release cannot move one side under a
  regenerated lock file. When the version is bumped, bump the P4 host in the
  same commit and reflash both.
- The console banner reports the KINO version, not the protocol version. The
  coprocessor reports its own firmware and RPC version to the host over RPC,
  from inside the component. Do not use the banner to judge compatibility.
- Do not flash over the factory image before reading it (GATE 2 step 2). A
  factory image that answers a version handshake is information.

## Pins

### C6 side — fixed in silicon

The SDIO **slave** pads are not routable through the C6's GPIO matrix. The
component states this itself: in
`coprocessor/eh_cp_transport/Kconfig.cp.sdio` each pin is declared
`range N N if IDF_TARGET_ESP32C6` with the help text *"Value cannot be
configured. Displayed for reference."* Confirmed in the generated `sdkconfig`
of this project:

| Signal | C6 GPIO |
|---|---|
| `CLK` | 19 |
| `CMD` | 18 |
| `D0` | 20 |
| `D1` | 21 |
| `D2` | 22 |
| `D3` | 23 |

`GPIO9` is the download strap (GATE 2). No firmware here drives it.

### P4 side — from the hardware map

Carrier routing, per `firmware/C6_HARDWARE_MAP.md` (identified, **not
bench-proven**):

| Signal | P4 GPIO | C6 GPIO |
|---|---|---|
| `D0` | 14 | 20 |
| `D1` | 15 | 21 |
| `D2` | 16 | 22 |
| `D3` | 17 | 23 |
| `CLK` | 18 | 19 |
| `CMD` | 19 | 18 |
| `EN` | 54 | `CHIP_PU` |

`CLK` and `CMD` cross over — P4 `GPIO18` (clock) meets C6 `GPIO19`, P4 `GPIO19`
(command) meets C6 `GPIO18`. The two chips number these functions in opposite
order; it is not a transcription error.

The P4 host must put the radio on **SDMMC slot 1** (GPIO matrix) and the microSD
card on **slot 0** (IOMUX pads 39-44). One controller, two slots, shared clock
tree and DMA. See the slot-allocation section of the hardware map.

This project does not configure any P4 pin and cannot get the P4 side wrong.
`CONFIG_EH_TRANSPORT_CP_SDIO_GPIO_RESET` is left at `-1`, meaning the
coprocessor is reset through its own `EN`/`CHIP_PU` line rather than a spare
GPIO — which is what P4 `GPIO54` drives. `CHIP_PU` polarity on this carrier is
**unconfirmed**; see "GPIO54 semantics" in the hardware map before driving it.

## Build

```bash
docker run --rm -v "$PWD:/project" -w /project/firmware/c6 \
  espressif/idf:v5.5.1 idf.py build
```

`espressif/idf:v5.5.1` is the one canonical environment
(`docs/FIRMWARE_BUILDER.md`), and `esp_hosted` 3.0.6 requires IDF ≥ 5.5. Output
is `build/kino-c6.bin`. CI builds this project in the `idf-build` matrix and
builds it twice in the `reproducible` job
(`.github/workflows/firmware.yml`); no workflow change was needed for this
rewrite.

On Windows, build inside the container's own filesystem rather than the bind
mount — object files go missing under parallel ninja on a Windows mount, which
is a host filesystem problem and not a build one.

`CONFIG_APP_REPRODUCIBLE_BUILD=y`: two clean builds of one commit produce the
same `.bin`, so a hash in a bench record identifies the source that made it.
Measured on this tree (`rm -rf build sdkconfig` between builds):

```
bytes:  1105872
sha256: 5d98256bc901dfd0f9d788a0c4e8d779e49286366a61619b35a6010dfbe0abb8
```

## Configuration worth knowing

Defaults inherited from the component that will matter at the bench:

| Symbol | Value | Note |
|---|---|---|
| `EH_TRANSPORT_CP_SDIO_MODE_SW_AGGR` | `y` | software frame aggregation. Needs a host that negotiates it — an `esp_hosted` 3.x host does; an old factory image may not. |
| `EH_TRANSPORT_CP_SDIO_PSEND_PSAMPLE` | `y` | slave timing. **First thing to try** if the link enumerates but transfers corrupt: the component offers three other edge combinations. |
| `EH_TRANSPORT_CP_SDIO_HIGH_SPEED` | `y` | actual speed is whatever the P4's SDMMC controller negotiates. |
| `EH_TRANSPORT_CP_SDIO_CHECKSUM` | `n` | upstream default. The coprocessor advertises its choice and the host mirrors it, so this is the single control point. |
| `BT_ENABLED` | `n` | no D4 Bluetooth feature; the controller costs flash in an image that must fit an OTA slot. |

## Files

```
CMakeLists.txt                  project, no EXTRA_COMPONENT_DIRS
sdkconfig.defaults              role, transport, flash size, partitions
partitions_eh_cp_ota_4m.csv     Espressif's, Apache-2.0, vendored verbatim
dependencies.lock               pins esp_hosted 3.0.6 by content hash
main/idf_component.yml          the exact-version pin and why
main/CMakeLists.txt             reads firmware/VERSION into the banner
main/main.c                     NVS, event loop, one console line
main/identity.h                 banner keys
```

`radio.c/h`, `transport.c/h` and `board_c6.h` were deleted in the rewrite. The
first four were a bespoke Wi-Fi STA app and a hand-rolled host-link seam, both
superseded by the component; keeping them alongside ESP-Hosted would be a
second networking path. `board_c6.h` held the six SDIO pin numbers that the
component now declares and enforces itself — the table above is the record, and
a duplicate set of `#define`s nothing includes is only somewhere to drift.

## Reference

The authoritative model for this project is, inside the resolved component:

```
esp_hosted/examples/mcu_hosted_sdio_sdmmc_combined/cp/
```

An SDIO coprocessor sharing one SDMMC controller with an SD card — the D4's
exact case. Its README states the allocation in the same terms the hardware map
does, and its host half scans Wi-Fi before *and* after filesystem I/O
specifically to prove the radio survives card init. That is the coexistence
check to run at the bench.
