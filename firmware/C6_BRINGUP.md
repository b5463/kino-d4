# ESP32-C6 bring-up

How to take the KINO D4's radio from "fitted but unreachable" to "uploading to
Roll", and what is already done.

Read [`C6_HARDWARE_MAP.md`](C6_HARDWARE_MAP.md) first. Step 1 below is a
hardware task and everything after it is blocked on it.

## Where this stands

| Stage | State |
|---|---|
| C6 slave image builds reproducibly | see [`c6/README.md`](c6/README.md) |
| P4 transport routing known | **BENCH DONE 2026-08-29** — slot 1 on GPIO14–19 enumerated the C6, three boots, two witnesses; GPIO54 confirmed as `CHIP_PU` on the meter (B2 PASS) — [`C6_HARDWARE_MAP.md`](C6_HARDWARE_MAP.md) |
| P4 transport driver | **BENCH DONE 2026-08-29** — `net_hosted.c`; it had been calling `esp_hosted_init()` without `esp_hosted_connect_to_slave()`, so enumeration was never attempted (`a2ab8ef`). Still a build-time opt-in, OFF by default |
| Version gate | **BENCH DONE 2026-08-29** — refused the factory 2.3.2 (`C6_BAD_FIRMWARE`, no reset loop), then **passed the rewritten 3.0.6**: `link ready, C6 3.0.6 against host 3.0.6`, `C6_SLAVE_VERSION` validated, state `WIFI_IDLE`. Compared the wrong constant at first (`ESP_HOSTED_VERSION_*_1` = 2.12.6); now uses `PROJECT_VERSION_*_1` like the component |
| Network state model | CODE DONE, host-tested (127 + 75 checks) |
| Wi-Fi scan / associate / DHCP | **BENCH DONE 2026-08-29** — six networks scanned, `BRCD` joined at -77 dBm, lease `10.20.80.181`, wrong passphrase refused with `AUTH_FAILED`, reconnect after reboot |
| SNTP as a clock source | **BENCH DONE 2026-08-29** — `clockSource network` on first association; the stale `CLOCK_UNTRUSTED` hold that would have blocked TLS is released on adoption (`172966f`) |
| Wi-Fi credential store | CODE DONE |
| `NETWORK_*` KDP commands | CODE DONE — answer honestly, refuse what needs a radio |
| `ROLL_*` KDP commands | **BENCH DONE 2026-08-29** — `ROLL_CREATE` registered the device and created roll `RRG8AZ` on the local backend; `ROLL_DEVICE_REGISTER` earned |
| Durable upload queue | **BENCH DONE 2026-08-30** — a capture reaches a Roll on the LAN backend: document 201, thumbnail first, original byte-identical, one row; survives the API going away (retry landed 13.5 s after it returned) and a P4 reboot with the upload pending (5.9 s, on 0.4.4 — 0.4.3 waited on the previous boot's clock, fixed `ec22ea3`). 34 stale records on the bench card retired, none relabelled. Capture wins the card over an upload. **C6-only reset: on 0.4.5 the link was never re-established (ROLL-C test 3 FAIL); 0.4.6 recovers it without a P4 reboot - `radio_recovery.c`, five consecutive recoveries in 9.8-21.8 s (one 122.9 s in the component's own deinit), and ROLL-C test 3 PASS with the same UUID uploaded once, byte-identical. LOCAL ROLL E2E GO** |
| Roll HTTP client | **BENCH DONE 2026-08-29** — against the production host: DNS, verified TLS, 404 (not deployed). Against the real backend on the LAN (`network.apiBase`, D18): health 200 with body, register 200, create roll 201. It had never read a response body until `90b8d74` |
| Radio variant in CI | CODE DONE — `p4-radio` job, its own 1440 KB guard |
| microSD on slot 0 (prerequisite) | **BENCH DONE 2026-08-28** — the slot move is proven on `KD4-D121BC`; see `HARDWARE_VALIDATION.md` |
| Any of it on hardware | **Transport and version gate, yes.** The coprocessor was rewritten to the pinned 3.0.6 from a verified 4 MB backup (`HARDWARE_VALIDATION.md`), boots cleanly, enumerates, and passes the gate. The link sits in `WIFI_IDLE` waiting for a network. Scan and association are next |

Every "BENCH DONE 2026-08-29" above is a session recorded in
[`HARDWARE_VALIDATION.md`](HARDWARE_VALIDATION.md), which owns the bench state
for this repository: transport, version gate, association, DHCP, SNTP, DNS, a
verified TLS session, and `ROLL_CREATE` against a real backend on the LAN. Every
"CODE DONE" means only that the code exists and compiles — nothing about it has
been observed on a board. Where a row here and `HARDWARE_VALIDATION.md` disagree,
that file wins and this one is stale.

## Bench baseline, 2026-08-28

The exact images for the next attempt. Built from a clean `git archive` of the
commit below plus the pinned `dependencies.lock`, never from a working tree,
and each built twice from scratch to prove the hash is a property of the source
rather than of the build directory.

| Image | Bytes | SHA-256 |
|---|---|---|
| `kino-p4.bin` default, no radio | 822 160 | `8d168da6edff9c049b2aebeb6bfda915bfc20885ee65475a379381562afbf624` |
| `kino-p4.bin` radio | 1 419 920 | `3b07e25e7de98933a0f7930bfe10f6c8c221ceb7f11c4148134f8249a095c49d` |
| `kino-c6.bin` slave | 1 105 872 | `3616fe6e6e6329f7443dce0f19232bb6aded9091801db874f150a18a1baaee61` |

All three are byte-identical across two clean builds. The C6 hash also matches
the one recorded before this session, so the slave image is stable across
environments and not merely repeatable inside one.

Baseline: HEAD `3a1073e`, `espressif/idf:v5.5.1`, `esp_hosted` 3.0.6
(`component_hash 1b1c2aa8…`), `esp_wifi_remote` 1.6.4
(`component_hash 50d3beaf…`). The lockfile now pins the resolved artifacts
by hash rather than only by version constraint, so a clean checkout fetches the
same bytes.

The radio image leaves 116 080 bytes (7.6%) of the 1 536 000-byte `factory`
partition. It fits; it will not fit two OTA slots, which is an M8 input and not
a bench blocker.

**The default image is the recovery baseline.** Keep it flashable: it boots,
mounts the card, runs KDP and answers `STORAGE_SELF_TEST` and `STORAGE_BENCH`
with the radio absent entirely, which is what makes it possible to tell a radio
fault from a board fault.

## Why the order is this order

The camera has to keep working throughout. Networking is additive: a dead
radio, a missing C6, or a failed handshake may cost uploads and must never
cost a photograph. So the transport comes up asynchronously, after the UI and
the capture pipeline are already usable, and every stage below fails into a
reported state rather than a retry loop or a reset.

## 1. Establish the routing — DONE, AND MEASURED

The mapping is in [`C6_HARDWARE_MAP.md`](C6_HARDWARE_MAP.md) with its evidence
chain: SDMMC slot 1 on `GPIO14`-`GPIO19`, `EN` on `GPIO54`, identified from
Guition documentation (E2) and corroborated pin-for-pin by Espressif's own
ESP-Hosted defaults for a P4 host with a C6 coprocessor (E3, E4), where min
equals max for every pin.

That was the paper argument. It has since been measured:
`HARDWARE_VALIDATION.md` records `C6_SDIO_PINS` and `C6_LINK_HANDSHAKE`
**VALIDATED 2026-08-29** — `sdmmc_card_init()` enumerated the C6 on slot 1 with
`rx_ready && tx_ready`, twice, witnessed from the C6's own console — and
`C6_EN_GPIO54` **VALIDATED 2026-08-29** on the meter.

What is still open, and it is what step 5 is for:

- `GPIO54`'s polarity on this carrier. ESP-Hosted defaults to active-low and
  carries an explicit active-high override because boards with a
  transistor-buffered `EN` invert it. Ours is unmeasured.
- whether any P4 GPIO reaches `C6_U0RXD`, `C6_U0TXD`, `C6_IO9` (JP1 pins 20,
  22, 24). None of the eleven P4 GPIOs on JP1 is known to, so C6 flashing is
  an external-adapter operation.
- the C6 SDIO IO power rail, and whether it needs an LDO channel of its own.

Buzz the module out or get the schematic before the first bench run. The SD map
came from a community field note and was still re-measured on our own unit
before its rows moved.

## 2. Add the pin block — DONE

`firmware/p4/main/board_d4v1.h` carries `BOARD_C6_SLOT`, `BOARD_C6_D0`-`D3`,
`BOARD_C6_CLK`, `BOARD_C6_CMD`, `BOARD_C6_EN` and `BOARD_C6_EN_ACTIVE_LOW`.
Every P4 pin assignment lives in that file and nowhere else, which is what
makes a pin change reviewable — `net_hosted.c` hands them to ESP-Hosted at
runtime rather than duplicating them in `sdkconfig.radio`.

Two `_Static_assert`s in `net_hosted.c` hold the invariants a comment cannot:

- `BOARD_C6_SLOT != BOARD_SD_SLOT`. One SDMMC controller serves both slots, and
  a collision presents as a card that stops mounting when the radio comes up.
- `BOARD_C6_EN_ACTIVE_LOW` equals `CONFIG_ESP_HOSTED_SDIO_RESET_ACTIVE_LOW`.
  Two places name that polarity and the bench will flip it; flipping only one
  of them must not compile.

The registry rows exist. Thirteen were appended to `hwv_item_t` — appended, not
inserted, because the enum ordinal is the NVS key and shifting it would make a
unit flashed across the change read its old evidence against the wrong rows.
They are ordered the way this procedure runs, so a bench session that stops
halfway leaves an obvious high-water mark, and a `_Static_assert` keeps the
name table in step with the enum.

Only `SD_SLOT0` can flip in the default build — the other twelve need a radio
that no build links by default.

## 3. Flash the slave image

`firmware/c6/README.md` has the command. The C6's SDIO slave pins are fixed in
silicon (CLK `GPIO19`, CMD `GPIO18`, DAT0–3 `GPIO20`–`GPIO23`), so the slave
image needs nothing from step 1 — which is why it could be built first.

Flashing needs `C6_U0RXD`/`C6_U0TXD`/`C6_IO9`/`C6_CHIP_PU`. Whether the P4 can
drive them — the flashing proxy that would make this a one-cable operation —
depends on the same GPIO numbers step 1 produces. Until then it is an external
USB-serial adapter on the header.

## 3a. The coprocessor image, and the procedure that waits on a divider

Status 2026-08-29. The factory coprocessor was ESP-Hosted 2.3.2 against a
3.0.6 host; the transport worked and the version gate refused, so the
coprocessor had to be updated. **It has been.** `HARDWARE_VALIDATION.md`
records the write on `KD4-D121BC`: a verified full 4 MB factory backup read
twice to the same SHA-256, then the four images written and esptool-verified,
then an independent read-back of 0x0-0x120000 matching byte for byte, with
`nvs` and `phy_init` unchanged against the backup. The C6 now boots, enumerates
and passes the gate at 3.0.6.

The two gates below stood in front of that write, one of them physical. They
are kept because they apply again to any other board.

**The image.** Built from a clean archive of `551e281`, twice, byte-identical:
`kino-c6.bin` **1 105 872 B**,
`3616fe6e6e6329f7443dce0f19232bb6aded9091801db874f150a18a1baaee61` - the same
hash recorded on 2026-08-28, so it is stable across environments as well as
repeatable. `esp_hosted` 3.0.6 (`component_hash 1b1c2aa8...`), ESP-IDF v5.5.1,
4 MB flash, custom table `partitions_eh_cp_ota_4m.csv`:

| Partition | Offset | Size | Factory equivalent |
|---|---|---|---|
| `nvs` | 0x9000 | 16 K | same offset |
| `otadata` | 0xd000 | 8 K | same offset |
| `phy_init` | 0xf000 | 4 K | same offset |
| `ota_0` | 0x10000 | 1792 K | factory: 0x10000, 1536 K |
| `ota_1` | 0x1d0000 | 1792 K | factory: 0x190000, 1536 K |

Generated flash set (`flash_args`): bootloader at 0x0, partition table at
0x8000, `ota_data_initial.bin` at 0xd000, `kino-c6.bin` at 0x10000. **Migration
review:** `nvs`, `otadata` and `phy_init` keep the factory offsets, so the
write set never touches the factory NVS or PHY calibration; only the OTA slots
grow, and the 1.1 MB image ends well inside factory `ota_0`. The factory table
is replaced by ours, which is intended.

**Gate one - physical.** CH340G TXD idles at **4.7 V**, measured. It may not be
connected to `C6_U0RXD` until a 1 k / 2 k divider is fitted and its midpoint is
measured at 3.0-3.3 V with TXD idle. RX-only wiring stays as it is. No adapter
VCC to the board, ever.

**Gate two - the P4 must be inert.** A normal radio build pulses GPIO54 once
for the operator and again inside `connect_to_slave()`, which would pull the
C6 out of its bootloader mid-write. So the recovery image
(`-DKINO_C6_RECOVERY=1`, built: `33a2a9b62dc989eadd9f7b2074660a65407d8a070eea4de9f926fed5db72bd0e`,
1 172 400 B) announces, waits five seconds for the strap, pulses GPIO54 low for
500 ms, releases, and never touches the C6 again - no SDIO pin, no ESP-Hosted.

**The sequence, once both gates clear** (nothing below has been run):

1. Flash the recovery image to the P4 on COM8. Wait for `RECOVERY: hold JP1 pin 24 (C6_IO9) LOW now`.
2. Operator holds pin 24 to GND; the P4 pulses reset; `RECOVERY: released`. Release pin 24 after the ROM banner shows `boot:0x... (DOWNLOAD...)` on COM9, or after ~2 s.
3. Identify, write nothing: `esptool --port COM9 --chip esp32c6 --before no_reset --after no_reset chip_id`. Require ESP32-C6, revision ~v0.2; record MAC.
4. Confirm geometry: `... flash_id`. Require 4 MB. Record manufacturer and device ID.
5. Back up everything: `... read_flash 0 0x400000 factory-c6-kd4-d121bc.bin`; SHA-256 it; keep it local, not in the repository; record size, hash, date, MAC, factory version 2.3.2.
6. Decode the factory table from the backup (`gen_esp32part.py` on the 0x8000 region) and record it beside ours.
7. Write per the generated `flash_args`, `--flash_size 4MB`, then `verify_flash` - or rely on esptool's write verification and read back the app region hash.
8. Release IO9, pulse reset once more (the recovery image is still on the P4 - a P4 `REBOOT` repeats its single pulse), capture the whole COM9 boot. Require a clean boot, our partition table, `ESP-Hosted-MCU Slave FW version :: 3.0.x`, SDIO slave up.
9. Flash the normal radio image back to the P4. Camera-first baseline first; then require rx_ready and tx_ready again, then the version RPC.

## 4. Turn on the host — DONE, and OFF BY DEFAULT

### The command

```
cd firmware/p4
rm -f dependencies.lock
idf.py -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.radio" \
       -DKINO_ROLL_API_BASE=https://<the API host> \
       build
```

`rm -f dependencies.lock` matters: a lock the component manager considers up to
date makes it download nothing, and the build then fails in confusing ways.
Delete `build/` too when switching between the two variants — the sdkconfig is
cached there.

`KINO_ROLL_API_BASE` has no default. This repository records no public KINO API
hostname, and a plausible wrong one compiled into a binary is worse than a
refusal that says the address is missing; without it every Roll call refuses
with exactly that. `KINO_SNTP_SERVER` overrides `pool.ntp.org` the same way,
for a bench with no route to the public pool.

### Why it is an opt-in and not a `#define`

Espressif's own P4 host configuration sets
`CONFIG_ESP_HOSTED_AUTO_CALL_INIT_BEFORE_APP_MAIN=y`, which installs an
`__attribute__((constructor))` that calls `esp_hosted_init()` **before**
`app_main()`. With `CONFIG_ESP_HOSTED_HOST_CP_RESET_STRATEGY_ALWAYS=y` beside
it, enabling the component drives `GPIO14`-`GPIO19` and `GPIO54` on every boot,
before a single line of KINO firmware runs — before the display, the card and
the capture pipeline exist, so a fault would present as a dead camera rather
than a dead radio.

The routing is corroborated and unmeasured, and `GPIO54`'s polarity is
unconfirmed. Shipping that on by default would drive unproven pins on every
power-up of every unit.

So:

| | default build | `sdkconfig.radio` |
|---|---|---|
| `CONFIG_ESP_HOSTED` | `n`, explicitly in `sdkconfig.defaults` | `y` |
| radio sources | not compiled | `net_hosted.c`, `net_wifi.c`, `net_time.c`, `roll_http.c` |
| `net_link` reports | `NET_C6_NOT_ROUTED` | the real state |
| pins driven | none | GPIO14-19, GPIO54 |
| `kino-p4.bin` | 800 KB | 1384 KB |

`sdkconfig.radio` also sets `AUTO_CALL_INIT_BEFORE_APP_MAIN=n`, so even in the
radio build nothing is driven until `net_hosted_start()` says so — which
`main.c` calls last, after the UI and the capture pipeline are already usable.
That is also what allows the runtime pin configuration: with the constructor on,
ESP-Hosted's shadow config is locked and every setter returns
`ESP_TRANSPORT_ERR_ALREADY_SET`.

The two halves are cross-checked in `main/CMakeLists.txt`. Naming the fragment
without `CONFIG_ESP_HOSTED=y`, or setting `CONFIG_ESP_HOSTED=y` without the
fragment, is a `FATAL_ERROR` — the second case is the dangerous one, because it
would drive the C6 pins with no driver compiled behind them.

Note on CMake: the switch is read from `SDKCONFIG_DEFAULTS`, not from
`CONFIG_ESP_HOSTED`. ESP-IDF processes a component's `CMakeLists.txt` twice —
once to expand `REQUIRES`, once to build — and `CONFIG_*` is not populated in
the first pass. Measured: `if(CONFIG_ESP_HOSTED)` around
`list(APPEND kino_reqs ...)` compiled the radio sources with none of their
include directories and failed on `esp_crt_bundle.h: No such file or directory`
while every other component resolved fine.

### What the sequence does

`net_hosted.c`:

```
hold GPIO54 at the reset level         -> NET_C6_BOOTING   (counts a reset)
release it, settle
hand ESP-Hosted our pins, esp_hosted_init()
    -> SDIO enumerates on slot 1
version exchange (a GATE, see below)   -> NET_C6_LINK_READY
esp_netif + esp_wifi_init + STA start  -> NET_RADIO_READY
                                       -> NET_WIFI_IDLE
auto-join the stored network, if there is one
```

Failures map onto reasons that already existed, so `NETWORK_STATUS`, the RADIO
screen and Studio need no change:

| Failure | Reason |
|---|---|
| SDIO does not enumerate | `NET_REASON_C6_NO_RESPONSE`, state `C6_ABSENT` |
| the version RPC times out | `NET_REASON_C6_NO_RESPONSE` |
| the coprocessor version is incompatible | `NET_REASON_C6_BAD_FIRMWARE` |
| the link drops after coming up | `NET_REASON_C6_LINK_LOST` |
| `esp_wifi_init` fails | `NET_REASON_RADIO_FAILURE` |
| wrong passphrase | `NET_REASON_AUTH_FAILED`, and it does **not** retry |
| no address | `NET_REASON_DHCP_TIMEOUT` |
| no trustworthy clock, so no TLS | `NET_REASON_CLOCK_UNTRUSTED` (new enumerator) |

A wrong passphrase deliberately does not retry: the access point counts the
attempts and a camera that hammers it gets blacklisted, which then looks like a
hardware fault. Everything else lets the driver's own retry do the work rather
than stacking a second loop on top.

### The version exchange is a gate, not a warning

`esp_hosted_get_coprocessor_fwversion()` first, before Wi-Fi is touched at all.
The rule: MAJOR must match exactly; a coprocessor MINOR below the host's is
refused; above is accepted and logged. On refusal the sequence stops at
`NET_REASON_C6_BAD_FIRMWARE` and never enters Wi-Fi.

This matters here specifically. This carrier is publicly reported to ship a C6
factory image older than current hosts expect, and an incompatible coprocessor
does not announce itself as one — RPCs time out, the transport looks flaky, and
the whole thing gets diagnosed as bad Wi-Fi or bad soldering. The host version,
the coprocessor version and the RPC protocol version are all recorded *before*
the decision, so a refused link still says what it refused. `NETWORK_STATUS`
reports all three, plus C6 present, SDIO link state, reset count, reconnects and
transport bytes.

The RPC protocol version is not separately queryable in esp_hosted 3.0.6: the
host's RPC layer is compile-time (`rpc_v2`, msg_id dispatch) and there is no
"tell me your protocol version" call outside the version RPC itself. So the
protocol check *is* that call succeeding, and a coprocessor that cannot answer
it maps to `C6_NO_RESPONSE` rather than to a version number nobody has.
`protocol_version` is reported as `rpc-v2`, which is what this host speaks, and
not as something the coprocessor confirmed.

Read the factory image before flashing over it. `FW_QUERY` and the log line
`c6: coprocessor image <name> <version>` are that reading, and a version is
information whether or not it is compatible.

### Pinned versions, and the size that comes with them

`espressif/esp_hosted 3.0.6` and `espressif/esp_wifi_remote 1.6.4`, pinned with
`==` in `main/idf_component.yml`. Both are declared in EVERY build and enabled
in none by default — declaring them is what keeps the radio variant buildable in
CI, and the Kconfig switch is what keeps the pins untouched.

`esp_wifi_remote` is **not** a valid CMake `REQUIRES` name; requiring it fails
with "Failed to resolve component". It is a managed dependency and it *provides*
`esp_wifi` for targets with no radio of their own, so `esp_wifi` is what goes in
`REQUIRES`. Espressif's own combined example does the same thing. Including
IDF's `esp_wifi.h` without esp_wifi_remote actually in the build gives
`CONFIG_ESP_WIFI_STATIC_RX_BUFFER_NUM undeclared`, which is the symptom of
getting this wrong.

Measured on this commit, both builds in the espressif/idf:v5.5.1 container:

| Build | `kino-p4.bin` | Factory partition free |
|---|---|---|
| default | 819 744 B (800 KB) | 47% |
| radio | 1 417 264 B (1384 KB) | 8% |

The radio stack costs **584 KB**. The CI guards are 1100 KB for the default
build and 1440 KB for the radio one, and the second is a ceiling with 56 KB of
slack rather than headroom. Two consequences worth stating rather than
discovering:

- the CMN certificate bundle is load-bearing. `DEFAULT_FULL` measured 1434 KB,
  4% of the partition free. If the API host's root is not in CMN, add that root
  — do not switch to FULL.
- **this variant does not fit a two-slot OTA partition table.** M8's repartition
  has to size its slots for this binary, not for the default one.

## 5. Prove the radio, in this order

Each step is a separate registry row, and a row moves only on an observed
device event. Read them back with `GET_HW_VALIDATION` (Studio → Developer →
Bench Diagnostics) rather than trusting this document.

1. `NETWORK_STATUS` reports `C6_LINK_READY`, and `FW_QUERY` reports the C6
   image version → `C6_SLAVE_IMAGE`, `C6_LINK_HANDSHAKE`
2. `NETWORK_LIST`/scan returns a known nearby AP with a plausible RSSI →
   `C6_WIFI_SCAN`
3. `NETWORK_SET` then association → `C6_WIFI_ASSOCIATE`
4. DHCP lease, and `NETWORK_STATUS` reaches `IP_READY` — **not** merely
   `WIFI_ASSOCIATED** → `C6_DHCP`
5. Name resolution → `C6_DNS`
6. A certificate-verified HTTPS response → `C6_TLS`

Do not skip 4. Reporting `connected` on association is the defect that makes a
camera claim it is online while nothing resolves;
`net_link_can_upload()` accepts only `IP_READY` for that reason, and the host
tests assert it.

### Recovery, which is the half that gets skipped

- reboot the P4 → reconnects on its own
- reboot the C6 → the P4 notices, reports `C6_LINK_LOST`, recovers
- power the AP off → **the camera stays fully usable**, and says why
- power the AP on → reconnects with no intervention
- repeat several times → no leak, no wedge

## 6. Clock, before TLS can be trusted — DONE

The D4 has no RTC. `clock.c` now carries four sources and `capturedAt` travels
with a `clockSource` saying which:

| Source | Rank | What it is |
|---|---|---|
| `host` | 3 | a host set it this session |
| `network` | 2 | an SNTP answer this session |
| `persisted` | 1 | carried across a power cycle; a lower bound that drifts |
| `unset` | 0 | the reading is 1970 plus uptime, and no consumer can mistake it |

Two rules, in `pure_clock_adopt_action()` and host-tested:

- a HIGHER-ranked source may move the clock in either direction. That is what a
  correction is, and it is what `clock_set()` has always done for a host: a
  persisted time that is wrong by a year has to be fixable.
- an EQUAL-ranked AUTOMATIC source may never move it backwards. A second SNTP
  sync reading 200 ms earlier is noise, and adopting it would let one capture be
  dated before an earlier one. A host at the same rank is exempt — that is a
  person typing a time in.

`net_time.c` makes the refusals unreachable rather than handling them, and the
reason is worth knowing: lwIP's SNTP calls `settimeofday()` itself and invokes
the callback afterwards, so a refused answer would have to be undone, and
`clock.c` holds no second copy of the time to undo it with — there is exactly
one wall clock on this device, deliberately. So SNTP is not started at all while
the clock is already `host`, and it is stopped after the first success. What is
left is exactly the case the policy adopts: `unset` or `persisted` becoming
`network`.

The camera needs to learn what year it is, not to correct drift over an evening.
A single sync per session is that, and it is also the only shape in which a
network time cannot move the clock backwards.

**TLS waits on it.** `clock_trustworthy_for_tls()` accepts `host` and `network`
only. `persisted` is refused because it is a lower bound that drifts with
however long the camera sat in a bag, and a certificate checked against it can
fail for a reason that has nothing to do with the certificate. The queue reports
`NET_REASON_CLOCK_UNTRUSTED` and stops, with the state left at `IP_READY`
because the network really is up — saying otherwise would send someone to look
at the router.

**Contract deviation, recorded not resolved.** `clockSource` is typed
`'host' | 'persisted' | 'unset'` in `packages/kdp/src/protocol/types.ts`, and
`apps/studio/src/developer/conformance.ts` throws on anything else. A
radio-build device emitting `network` fails that check. See
`firmware-contract/README.md` D16; widening the union is a `packages/**` change
and belongs with the milestone that ships the radio.

## 7. Fill the HTTP seam — DONE

`roll_http.c` is the wire, `roll_api.c` is the procedure, and neither re-decides
anything the queue already owns. `upload_queue.c`'s function-pointer seam now
points at `roll_api_step()`, which is implemented twice — with the HTTP client
in the radio build, and as "no radio in this build" otherwise — so the queue,
its persistence and its retry policy run identically either way. That is what
keeps the host tests worth having when no radio has been exercised.

Every step of `docs/roll/ROLL_DEVICE_CONTRACT.md` is implemented:

| Step | Call |
|---|---|
| register once | `POST /api/studio/devices/register` |
| create a Roll | `POST /api/device/rolls` |
| join a Roll | `POST /api/device/rolls/join` |
| the capture | `POST /api/device/rolls/{rollId}/captures` |
| each asset | `assets/init` -> part `PUT`s -> `uploads/{id}/complete` |
| finish | `POST /api/device/captures/{id}/complete` |

What was kept, and why each one is easy to get wrong:

- **Certificate verification, always.** `esp_crt_bundle_attach` on every
  request, and there is no flag in `roll_http.c` to turn it off. The two
  problems that tempt people into disabling it — a wrong clock and a private CA
  — have their own answers, in step 6 and in the bundle respectively.
- **The token stays in one frame.** `roll_state_apply_credential_to()` hands it
  to the callback that builds the `Authorization` header and nothing else; the
  header buffer is wiped before that returns. Every error string that leaves
  goes through `rq_redact()`, including the API's own `{code, message}` body,
  which is the most likely place a URL with a token in it would be echoed back.
- **No local re-classification.** `rq_classify_status()` owns drop/retry/
  re-read/halt, including the 422 case where the contract's two sections have to
  be reconciled. `roll_api.c` reports the status verbatim. A missing credential
  is reported as 401 rather than 0, so the queue halts rather than retrying
  forever: no credential and a dead credential need the same action from the
  user, and neither is transient.
- **Persist before the next network operation.** Unchanged — that is
  `upload_queue.c`'s write-back after `rq_apply()`, and it is what stops a
  reboot re-uploading a frame that already landed.
- **The card is the truth.** The registered document is META.JSON as written at
  commit time, with exactly three fields patched: `rollId` (null at commit
  time), `deviceId` (empty on a camera that had not registered) and
  `frameCount` (from the files that will actually be uploaded). `mode` is forced
  to `single` for a one-frame capture, because Roll renders Wiggle controls from
  that field.
- **Photography wins the card.** Every read takes
  `storage_acquire(STORAGE_USER_UPLOAD, 200 ms)` and polls
  `storage_yield_requested()` between 16 KiB chunks — in the hash as well as in
  the part `PUT`. When a capture wants the card, the part is abandoned
  mid-stream and the request returns status 0, which the queue treats as
  transient. That is correct rather than merely acceptable: the contract's part
  re-`PUT` is idempotent, an abandoned upload costs nothing, and a dropped frame
  costs a photograph.

`ROLL_CREATE` and slug-only `ROLL_JOIN` no longer return `NETWORK_UNAVAILABLE`
once the radio is up. Both block the KDP task for as long as the API takes,
which is accepted: they are deliberate user actions with a spinner in front of
them, the alternative is a job model for one call, and the capture path never
waits on the KDP task. A failure is mapped to a code a host can act on — 404 is
`NOT_FOUND`, 429 says joining is locked for a while (the API locks it after ten
wrong slugs, and a generic failure invites the eleventh), 401/403 is
`UNAUTHORIZED`, and no response at all falls back to the radio's own reason.

**Not implemented:** `GET /api/device/rolls/current` and the optional
`GET .../status` poll. Neither is needed to upload: membership is cached in NVS
and the queue drives transitions by uploading.

**Untestable on a host, and therefore unproven:** everything in this step. There
is no server double in this repository that the firmware could be pointed at,
`apps/twin`'s bridge is the browser's implementation of the same contract rather
than a mock for this one, and `KINO_ROLL_API_BASE` has no default. The first
real evidence will be a bench run against a live API.

## 8. Gate F — coexistence

The exit criterion, from `FIRMWARE_ROADMAP.md`: capture timing and camera-node
CRC error rates measured with the radio idle, associated, and uploading, and
**unchanged within noise** against the radio-off baseline. Otherwise uploads are
restricted to idle or charging.

Most of the mechanism is in place and needs measuring, not designing: the upload
worker runs at priority 2, below the UI (4) and the capture workers (5), and it
takes `storage_acquire(STORAGE_USER_UPLOAD, ...)` for every card access, so a
capture holding the card at `STORAGE_USER_CAPTURE` shuts it out. That is not
only about CPU — the mount has one descriptor budget
(`STORAGE_MAX_OPEN_FILES`) and one SDMMC bus.

### The open risk: ESP-Hosted's RX worker runs at priority 22

`CONFIG_ESP_HOSTED_HOST_DEFLT_TASK_PRIORITY` defaults to 22 and that is what
Espressif's own example ships. On this camera 22 outranks everything:

| Task | Priority |
|---|---|
| ESP-Hosted SDIO RX worker | **22** |
| KDP server | 9 |
| capture coordinator and workers | 5 |
| UI | 4 |
| C6 supervisor (`c6link`) | 3 |
| upload worker | 2 |

**It can be lowered — the Kconfig range is 1..25 — and it deliberately is not.**
Below 5 the RX worker can be starved by a four-camera transfer; the coprocessor
keeps pushing, its queue overflows, and the result is a transport fault during a
capture. That trades the hazard this priority causes for the one it prevents,
and which way the trade actually falls is a measurement. No board has been
powered, so there is no measurement, and guessing in either direction would be
worse than saying so.

So it ships at the reference value with the hazard recorded, and Gate F is what
resolves it. What to measure, in order:

1. baseline: capture timing spread and camera-node CRC error rates with the
   radio build flashed but the C6 held in reset;
2. the same with the link up and Wi-Fi idle;
3. the same associated and with a lease;
4. the same while a four-frame capture uploads.

If step 4 shows capture timing degrading, the levers are, in order of
preference: lower `CONFIG_ESP_HOSTED_HOST_DEFLT_TASK_PRIORITY` toward 6 and
re-measure both hazards; raise the capture workers above it; or restrict uploads
to idle and charging, which is the roadmap's own fallback.

One thing is already decided rather than measured:
`CONFIG_ESP_HOSTED_HOST_TRANSPORT_RESTART_ON_FAILURE` is **n**, against the
component's default of y. With it on, a runtime transport failure calls
`esp_restart()` — the P4 reboots itself, losing the frame in flight, the open
capture folder and the session, because Wi-Fi hiccuped. Networking is additive
on this body: a dead radio may cost uploads and must never cost a photograph.
The `TRANSPORT_FAILURE` event is emitted either way, so the failure is still
reported.

The second half of coexistence is the one Espressif's combined example tests for
us: it scans Wi-Fi before *and* after filesystem I/O specifically to prove the
radio survives card init. Run that check — a scan, mount the card, a scan — as
`SD_C6_COEXIST` before trusting any of the numbers above.

## 9. Only then, the capability flags

`GET_CAPABILITIES` gains `network` and `roll` when the matching commands
answer for real — not when they exist. Studio's `supports()` gate is
fail-closed, so a flag set early makes Studio issue commands the camera cannot
honour, and the user sees a broken panel instead of an absent one.

The camera reports `radioFitted` and `radioRouted` separately in the meantime,
which is the same split `flashControl` and `flashHardware` already use: the
firmware can do it, and the hardware is or is not there.
