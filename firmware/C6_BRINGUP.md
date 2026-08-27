# ESP32-C6 bring-up

How to take the KINO D4's radio from "fitted but unreachable" to "uploading to
Roll", and what is already done.

Read [`C6_HARDWARE_MAP.md`](C6_HARDWARE_MAP.md) first. Step 1 below is a
hardware task and everything after it is blocked on it.

## Where this stands

| Stage | State |
|---|---|
| C6 slave image builds reproducibly | see [`c6/README.md`](c6/README.md) |
| P4 transport routing known | **BLOCKED** — no pins recorded for this carrier |
| P4 transport driver | not written — blocked on the above |
| Network state model | CODE DONE, host-tested |
| Wi-Fi credential store | CODE DONE |
| `NETWORK_*` KDP commands | CODE DONE — answer honestly, refuse what needs a radio |
| `ROLL_*` KDP commands | CODE DONE — the Studio-assigned path works without a radio |
| Durable upload queue | CODE DONE, host-tested |
| Roll HTTP client | seam only — blocked on the transport |
| Any of it on hardware | **NOTHING. No radio has ever been exercised.** |

Nothing in this file has been run on a board. The last row is the one that
matters, and it stays that way until step 6.

## Why the order is this order

The camera has to keep working throughout. Networking is additive: a dead
radio, a missing C6, or a failed handshake may cost uploads and must never
cost a photograph. So the transport comes up asynchronously, after the UI and
the capture pipeline are already usable, and every stage below fails into a
reported state rather than a retry loop or a reset.

## 1. Establish the routing — HARDWARE, BLOCKING

Get the `JC4880P443C-I-W` schematic from Guition, or buzz the module out by
hand. Determine:

- whether the P4↔C6 transport is SDIO or SPI, and its bus width;
- every P4-side GPIO on that bus;
- the P4 GPIOs behind `C6_U0RXD`, `C6_U0TXD`, `C6_IO9`, `C6_CHIP_PU`;
- `C6_CHIP_PU`'s polarity, pull and required sequencing;
- which SDMMC slot the SD card occupies, and whether one remains.

Three outcomes are open, and they are not equivalent — see
`C6_HARDWARE_MAP.md`, "The transport is not even known to be SDIO". If the
carrier routes only those four header pins, there is no transport and this is
a hardware finding, not a firmware task.

Record the answers in `C6_HARDWARE_MAP.md`'s table with the schematic sheet or
the continuity measurement named in the evidence column. **Do not proceed on a
community field note.** The SD map came from one and was still re-measured on
our own unit before its rows moved.

## 2. Add the pin block

In `firmware/p4/main/board_d4v1.h`, beside the SD block:

```c
// --- ESP32-C6 hosted radio (PROVISIONAL until validated, issue #2) ---
#define BOARD_C6_EN      /* ... */
#define BOARD_C6_BOOT    /* ... */
#define BOARD_C6_CLK     /* ... */
#define BOARD_C6_CMD     /* ... */
#define BOARD_C6_D0      /* ... */
// D1..D3 if 4-bit
#define BOARD_C6_SLOT    /* SDMMC slot, and it must not be the card's */
```

Every P4 pin assignment lives in that file and nowhere else — that rule is
what makes a pin change reviewable. Add one `HWV_C6_*` row per pin to
`hardware_validation.h`, appending only: the enum ordinal is the NVS key, so
inserting in the middle silently relabels every stored verdict on every unit
already in the field. The warning block in that header says so.

## 3. Flash the slave image

`firmware/c6/README.md` has the command. The C6's SDIO slave pins are fixed in
silicon (CLK `GPIO19`, CMD `GPIO18`, DAT0–3 `GPIO20`–`GPIO23`), so the slave
image needs nothing from step 1 — which is why it could be built first.

Flashing needs `C6_U0RXD`/`C6_U0TXD`/`C6_IO9`/`C6_CHIP_PU`. Whether the P4 can
drive them — the flashing proxy that would make this a one-cable operation —
depends on the same GPIO numbers step 1 produces. Until then it is an external
USB-serial adapter on the header.

## 4. Turn on the host

In `firmware/p4/main/net_link.c`, set:

```c
#define BOARD_C6_ROUTED true
```

That constant is the gate, and it is the last switch rather than the first
because everything above it is already written against the full state set.
Then fill the marked block in `net_link_init()`:

```
assert C6 reset       -> NET_C6_BOOTING
release, open the transport, handshake
version exchange      -> NET_C6_LINK_READY   (fill s_net.c6_version)
esp_wifi_remote init  -> NET_RADIO_READY
                      -> NET_WIFI_IDLE
```

Every failure below already has a reason enumerator, so
`NETWORK_STATUS`, the RADIO screen and Studio need no change:

| Failure | Reason |
|---|---|
| C6 does not answer the handshake | `NET_REASON_C6_NO_RESPONSE` |
| slave reports an incompatible version | `NET_REASON_C6_BAD_FIRMWARE` |
| link drops after coming up | `NET_REASON_C6_LINK_LOST` |
| `esp_wifi_remote` init fails | `NET_REASON_RADIO_FAILURE` |

Components to add to `firmware/p4/main/CMakeLists.txt`: `esp_wifi_remote`,
`esp_hosted`, `esp_netif`, `esp_event`, and for step 7 `esp_http_client`,
`esp-tls`, `mbedtls`.

**Budget for the size guard.** `.github/workflows/firmware.yml` fails the
build above `LIMIT_KB=1100`. The binary is well under that today; a Wi-Fi
stack plus mbedTLS plus an HTTP client will plausibly exceed the headroom.
Raise the limit in that workflow *and say why* in the same commit — the
workflow's own failure message asks for exactly that. Note the partition table
is still the stock single-app-large `factory` at 1500 KB; repartitioning is
M8, and the guard has a marker pointing at it.

Reasons this stack was NOT added ahead of step 1: it cannot work without the
pins, and linking ~300 KB of radio and TLS to prove a `#define` is false costs
the size gate for nothing.

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

## 6. Clock, before TLS can be trusted

The D4 has no RTC. `clock.c` carries three sources — host-set, persisted,
unset — and `capturedAt` travels with a `clockSource` saying which. A
certificate cannot be validated against a clock that is wrong by years, and
disabling verification to get past that is not an option.

Add SNTP once there is an address, and integrate it as a *source* rather than
an override: SNTP outranks `persisted` and `unset`, and must not silently
replace a host-set time that a bench operator has just supplied. Do not let
TLS depend on it before the first sync completes; report the failure as
`NET_REASON_DNS_FAILURE`/TLS rather than looping.

## 7. Fill the HTTP seam

`upload_queue.c` has the step order written out — register, thumb, frames
1..N, complete — with the transport behind a function-pointer seam that
returns "no transport" today. `docs/roll/ROLL_DEVICE_CONTRACT.md` is the
normative procedure, and `apps/twin/src/roll/bridge.ts` is a working
implementation of the same contract to read against.

Two things to keep while filling it in:

- **Persist before every network operation.** The write-back after
  `rq_apply()` is what stops a reboot re-uploading a frame that already
  landed. `roll_queue.h` explains why progress is a set of completion flags
  and not a byte offset.
- **Do not re-classify responses locally.** `rq_classify_status()` owns the
  drop/retry/re-read/halt decision and is host-tested against the contract's
  own table, including the 422 case where the contract's two sections have to
  be reconciled.

## 8. Gate F — coexistence

The exit criterion, from `FIRMWARE_ROADMAP.md`: capture timing and camera-node
CRC error rates measured with the radio idle, associated, and uploading, and
**unchanged within noise** against the radio-off baseline. Otherwise uploads
are restricted to idle or charging.

The mechanism is already in place and needs measuring, not designing: the
upload worker runs below the UI and the capture workers, and
`upload_queue_pause_for_capture()` holds it off entirely while a capture is in
flight. That is not only about CPU — the FAT volume is mounted with
`max_files = 4`, and a capture already holds a frame handle plus a read-back
handle for its CRC check, so an upload reader competing for a handle and for
the SDMMC bus is a real hazard rather than a theoretical one.

Measure, do not assume. Photography wins; an upload that lands a few seconds
later costs nothing.

## 9. Only then, the capability flags

`GET_CAPABILITIES` gains `network` and `roll` when the matching commands
answer for real — not when they exist. Studio's `supports()` gate is
fail-closed, so a flag set early makes Studio issue commands the camera cannot
honour, and the user sees a broken panel instead of an absent one.

The camera reports `radioFitted` and `radioRouted` separately in the meantime,
which is the same split `flashControl` and `flashHardware` already use: the
firmware can do it, and the hardware is or is not there.
