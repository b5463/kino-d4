# D4-V1 hardware validation record

The source of truth for what has actually been bench-proven on physical D4-V1
hardware. The firmware keeps a live per-unit registry of the same items
(`p4/main/hardware_validation.[ch]`, readable over KDP with
`GET_HW_VALIDATION`); this file is the human record across units and time.

Rules:

- `VALIDATED` means the operation ran on our physical board and was observed.
  A datasheet, a community field note, or a compiling `#define` is never
  validation.
- Firmware auto-marks only `UNVALIDATED → VALIDATED`, from real events. It
  never auto-marks `FAILED` — software cannot tell a wrong pin from an empty
  SD slot or an unplugged harness. A failure is diagnosed at the bench and
  recorded here with the measured replacement.
- Do not rewrite history. A failed assumption keeps its row, marked `FAILED`,
  with the replacement in a new row.

## Status — updated 2026-08-27, firmware 0.4.0

0.4.0 added the network, Roll and upload-queue surface. It earned **no rows**:
the ESP32-C6 has no recorded transport route from the P4, so nothing in it has
been exercised on hardware. The rows it owes are listed in
[`C6_HARDWARE_MAP.md`](C6_HARDWARE_MAP.md) so they exist before the bench run
rather than after it. The live bench session below is 0.3.0's and is unaffected.

**Nothing below was inferred from code.** A row moves on an observed event on a
physical unit, and the firmware auto-marks only `UNVALIDATED → VALIDATED`. The
registry grew from 23 to 41 items in 0.3.0 (CAM2–4, sync trigger, `FLASH_EN`,
shutter) so the four-camera bring-up has somewhere to record its answers; all
18 new rows are `UNVALIDATED` and will stay so until the harness exists.

### The one thing to read first

**No camera node has ever been connected to a P4.** Everything in the camera
column below is either standalone-module evidence or unvalidated. The entire
capture pipeline — four-camera coordination, CRC verification, card write,
thumbnails, gallery, `EVT_CAPTURE`, `MEDIA_READ` — is `CODE DONE` and has never
photographed anything.

### Firmware 0.2.0 / 0.3.0 evidence, recorded late

The 0.1.0 sections below were written at the time. The display and touch runs
were recorded only in commit messages and are transcribed here now; that gap
was itself a process failure, since this file is the declared source of truth
and it sat two minor versions behind the firmware.

| Subsystem | Evidence | Source | Status |
|---|---|---|---|
| ST7701S panel over MIPI-DSI | *"First light… five colour bands on the screen, confirmed on hardware"* — after three faults each hiding the next: PSRAM at 20 MHz (DPI underrun), 800 async draw calls, and a panel-specific init table | commit `b8dff7a` | **VALIDATED** |
| Backlight GPIO23 | Driven with the panel; plain GPIO, not LEDC | commit `b8dff7a` | **VALIDATED** |
| GT911 touch | *"GT911 touch and a first on-screen UI, both verified on hardware"* | commit `8b4ddf3` | **VALIDATED** |
| Shared I²C bus | Scan reported 0x14, 0x18, 0x5d; codec must be brought up before the touch poll or every transaction NACKs | commit `8b4ddf3` | **VALIDATED** |
| ES8311 codec + NS4150 amp | Answered at 0x18; amp enable GPIO11 drives a speaker. Shutter/tick levels chosen from measured output | 0.2.0 audio work | **VALIDATED** |
| MSM381 microphone | reg 0x44 `ADCDAT_SEL` = 5 is a digital DAC loopback, not the mic; a volume sweep produced bit-identical output. Analog front end unconfigured | 0.2.0 audio work | **FAILED — not usable** |
| `CAM_PWR_EN` GPIO31 | Pin driven both ways for the camera bank. Whether the AO4407 channels downstream follow it is still a scope job | 0.2.0 power work | ~~VALIDATED (pin only)~~ **VOID** — GPIO31 is not a JP1 header pin (silkscreen check, commit `944b68e`). Toggling it proved the GPIO cell works and nothing about the camera bank, which was never connected. `CAM_PWR_EN` is now `BOARD_GPIO_NONE`; registry row `CAM_PWR_EN_GPIO31`, UNVALIDATED |
| Config persistence | A setting survived a real power cycle over the live link | 0.2.0 | **VALIDATED** |
| UI on the panel | 8 screens render on hardware; boot dissolve measured at 26 frames in 452 ms (≈57 fps) via the PPA | 0.2.0/0.3.0 | **VALIDATED** |
| Icon expansion | 575 ms for six icons, streamed; icons ready at t=2984 ms against a boot dissolve at t=4974 | commit `5768d3c` | **VALIDATED** |

### First camera on the wire, 2026-08-28

A XIAO ESP32-S3 (MAC `68:EE:8F:47:0B:6C` — a different unit from the module in
the 0.1.0 section) with an OV3660, wired to CAM1 on the measured header:
GND on JP1 5, `CAM1_TX` GPIO52 on JP1 7 to the node's D7, `CAM1_RX` GPIO51 on
JP1 9 from the node's D6. Both boards on their own USB; ground shared through
the single GND wire. `SYNC_OUT`, `FLASH_EN` and `CAM_PWR_EN` unwired.

| Item | Evidence | Status |
|---|---|---|
| `CAM1_TX_GPIO52` / `CAM1_RX_GPIO51` (JP1 7/9) | First traffic on the link: `rxBytes` 285, `crcErrors` 0, `decoderResyncs` 0, `connected: true`. The pins the per-pin scan measured are the pins a node answers on | **VALIDATED** |
| `CAM1_BAUD_921600` | The whole session ran at 921600 with 0 CRC errors and 0 resyncs | **VALIDATED** |
| `CAM1_NODE_LINK` | The P4 read the node's own session, firmware 0.4.1, reset reason, heap 8076 KB, PSRAM 7808 KB and chip revision across the UART | **VALIDATED** |
| `CAM1_SENSOR_DETECT` | `sensorPid 0x3660`, `sensor: OV3660`, `state: ready`, reported through the P4 rather than from the node's own console | **VALIDATED** |
| `CAM1_CAPTURE` | `CAMERA_TEST` repeatedly returns a frame; UXGA at quality 95 measured 108,567 B | **VALIDATED** |
| `CAM1_JPEG_TRANSFER` | Node CRC == transfer CRC on every completed capture, 5/5 in a controlled run | **VALIDATED** |
| `CAM1_SD_WRITE` | Stored-file CRC read back off the card == node CRC, 5/5. `MEDIA_READ` then reassembled 49,740 B host-side, SOI/EOI intact, and the image opened as a correct coherent scene | **VALIDATED** |

Node standalone before wiring: `Detected OV3660 camera`, SCCB `0x3c`, 8 MB
octal PSRAM at 80 MHz with `SPI SRAM memory test OK`, and the driver's own PLL
report — `VCO 128 MHz, PLLCLK 128 MHz, SYSCLK 32 MHz, PCLK 8 MHz` — which is
the arithmetic the Phase 1 audit derived from source and the driver's own
"40MHz SYSCLK / 10MHz PCLK" comment contradicts. The silicon agrees with the
audit.

### No camera attached at all, 2026-08-28

The state every unit boots into on a bench, and the one most likely to be met
by someone who has not wired anything yet. P4 alone on COM8, no node on any
channel.

| Check | Result |
|---|---|
| `CAMERA_CAPTURE` with nothing attached | NACK `CAMERA_OFFLINE` "No camera answered" in **1.7 s**, plus a `LOG` event. Refused, not hung |
| Sanity sweep — `HELLO`, `GET_DEVICE_INFO`, `GET_CAPABILITIES`, `GET_STORAGE_STATUS`, `GET_RUNTIME_STATS`, `GET_HW_VALIDATION`, `GET_LOGS` | 7/7 OK, 1.1–9.3 ms each |
| Framing across the session | 8 frames, **0 CRC failures, 0 resyncs** |
| Task watchdog | None. `resetReason: power-on`, uptime 75 s, free heap 23408 KB |
| `taskmon` | 18 tasks, `tasksUnmeasured: 0` |
| Host clock | `clock set to 2026-08-28T22:02:46+02:00 by host (moved +88865 s)`, `t` a real epoch — the clock unification holding |

Four channels each cost `DEFAULT_TIMEOUT_MS` on the probe, serialised, so a
full probe round with nothing attached is about 12 s and repeats. It starves
nothing since the poll was fixed, but it is a lot of link time spent proving
absence, and it delays boot.

Note for the open `xfer` jitter question: the runtime reports **eight**
camera-related tasks, `cap1`–`cap4` in cam_link and `vf_cam1`–`vf_cam4` in the
viewfinder, not the four assumed when the priority-3 round-robin was proposed
as the cause. Whatever that contention is, there is twice as much of it.

### Viewfinder frame timing, 2026-08-28

One camera on CAM1, preview at 320x240 q30, timed inside the P4's pump task and
reported once a second per camera. Reported by the finder itself rather than
inferred from a transfer log, because the question was where a frame's time
goes, not how long a frame took.

| Stage | `fb_count = 1` | `fb_count = 2`, `GRAB_LATEST` |
|---|---|---|
| `cap` — sensor capture request | **10 ms or 62–75 ms, bimodal** | **5–9 ms** |
| `xfer` — JPEG over the UART | 26–31 ms | 28–52 ms |
| `dec` — hardware JPEG decode | 1–3 ms | 1–2 ms |
| frame bytes | 2232–3427 B | 2477–2973 B |
| rate | 0.0–8.8 fps | **10.2–18.2 fps** |

The bimodal `cap` is the whole finding. Frame bytes, transfer time and decode
time were all flat while a hand moved in front of the lens, so neither JPEG
size nor the wire nor the decoder explained a frame interval that alternated
between about 40 ms and 101 ms. With one buffer the driver fills it after each
return and then stalls, so a request either caught a ready frame or waited a
whole sensor period — the pump free-runs against the sensor's frame clock, and
which one you got was phase.

Two things follow that are worth keeping:

- Movement did not cause the variance, it revealed it. A 2.5x jitter in frame
  interval is invisible on a still scene and obvious on a moving one, which is
  why the first hypothesis — motion means detail means a bigger JPEG — was
  wrong. The bytes column is what disproved it.
- `xfer` is now the jitter, in steps of about 10 ms, which is one tick at
  `CONFIG_FREERTOS_HZ=100`. The 28–32 ms cases are the link at its full
  ~90 KB/s, so the excursions are scheduling rather than data. Four
  `camera_task`s share priority 3 with `audio_task` and three of them are
  pumping cameras that are not fitted. Not yet measured, and not yet changed.

### Link poll busy-wait, 2026-08-28

A task watchdog on `IDLE0` with `cam_probe` on CPU 0, at 6750 ms into boot.
`pdMS_TO_TICKS(1)` is **zero ticks** at 100 Hz and `vTaskDelay(0)` does not
block, so the "read what has arrived" poll in `cam_link` and `node_server` span
at task priority for the whole timeout instead of sleeping. With one camera
fitted, three absent channels span out a 900 ms viewfinder timeout on repeat,
starving `IDLE0` and the UI task that feeds the DPI panel — seen on the bench
as stutter and a flat blue flash. Blocking for one byte and then draining the
rest with no wait keeps the latency and restores the sleep. Watchdog gone.

### Stale frame: CONFIRMED

`SYNC_FEASIBILITY.md` predicted from source that with `fb_count=1` a capture
after a release returns an already-queued frame instantly. It does.

| Measurement | Value |
|---|---|
| `fb_get` on the stale path | 471–598 us (a fresh UXGA frame costs ~112 ms) |
| Frame age before the command | 1.8 s, 3.4 s, 27.0 s, **134.0 s** |

The 134-second figure is the signature: the node handed back a photograph of
whatever was in front of the lens over two minutes before the shutter. The
first capture after any idle period is small (3–5 KB) and ancient; the next is
a real frame of 90–240 KB. That size pattern ran through the whole session and
was the stale frame all along.

The verdict `SYNC_FEASIBILITY.md` was waiting for is therefore
**STALE_FRAME_CONFIRMED**, and the discard-fetch fix it specifies is now
warranted by measurement rather than by reading the driver.

### Not proven, and blocking

| Item | State |
|---|---|
| Product capture path (`SHOOT`, `CAMERA_CAPTURE`) on large frames | **FAILS.** Isolated: UXGA q95 at 108,567 B through `kdp_server`'s loop succeeds; 109,349 B through `capture.c`'s worker fails, transfer dying at 0–9%. Same resolution, quality and size, different code path. The link reports 8,076–8,139 bytes of the 8,210 a full chunk needs, 0 frames decoded, 0 CRC errors, and a longer timeout recovers nothing — a dropped tail, not a slow one |
| Frame ownership between viewfinder and capture | Mechanism proven (viewfinder parked: 5/5 pass; viewfinder live: 4/5 fail with BAD_ID). `viewfinder_hold()` is in place at `capture_fire` but has not been shown to take effect. Note that `fb_count` is now 2, so the single-frame contention this describes no longer has the same shape and the test needs re-running |
| Thumbnail written by the product path | `thumb_write` has still never run: every capture on the card came from `CAMERA_TEST`, which does not write one. The gallery renders by falling back to `C1.JPG` |
| `CAM2`–`CAM4`, `SYNC`, `FLASH_EN`, `CAM_PWR_EN`, shutter | No harness. Unchanged |

### First live P4 bench session, 2026-08-27

The first session in which a host talked KDP to a physical P4 and got answers.
Board: ESP32-P4 rev v1.3, 40 MHz crystal, MAC `80:F1:B2:D1:21:BC`, reporting
serial `KD4-D121BC`. Transport: USB-Serial-JTAG on COM8. Firmware 0.3.0 at
commits `b35592e` (instruments) and `42d04da` (clock). Images flashed app-only
at `0x10000`, esptool hash-verified:

| Image | Bytes | sha256 (first 32) |
|---|---|---|
| `kino-p4.bin` (instruments) | 790,176 | `b8063f6e4bb7402acd4df5c56ad22922` |
| `kino-p4.bin` (clock) | 790,432 | `5ed37b7dfabd0e3d91bc6b8fcca6a920` |

Both hashes reproduced across separate clean builds in separate container runs,
which is what `CONFIG_APP_REPRODUCIBLE_BUILD` was turned on for.

| Subsystem | Evidence | Status |
|---|---|---|
| KDP over USB-Serial-JTAG, host to P4 | `GET_DEVICE_INFO` answered in 2.9 ms, decoder clean (0 CRC failures, 0 resyncs). All nine §7 commands answered | **VALIDATED** |
| SD card, sustained read/write with CRC | `STORAGE_BENCH`: 64 KiB and 1 MiB passes, `crc32Written == crc32Read` on both, `cleanupOk: true`, and free bytes returned byte-identical to the pre-bench baseline so `BENCH.TMP` was really removed. 0.589 MB/s write, 1.348 MB/s read, worst block 128.833 ms, p95 57.532 ms | **VALIDATED** |
| SD card, short write/verify | `STORAGE_SELF_TEST` pass, 65,536 B in 148 ms | **VALIDATED** |
| Task stack telemetry | `GET_RUNTIME_STATS` reports 17 tasks, `tasksUnmeasured: 0`. Was reporting a freed TCB as a measurement; see the two fixes below | **VALIDATED after fix** |
| Wall clock, host sync | `HELLO` with `hostEpochMs` moved `clockSource` `unset` → `host`, and the correction's own log entry carried `t=1787856462636` — within 1 ms of the epoch sent. Before the fix that same entry read `t=526536` | **VALIDATED** |
| Wall clock, survives a soft reset | After `REBOOT`: `clockSource` `persisted`, first log entry of the new boot already stamped 2026-08-27T18:48:32Z, wall time advanced 29.6 s rather than moving backwards | **VALIDATED** |
| Monotonic clock independence | `us` strictly increasing across all 15 entries spanning a 56-year wall-clock jump (+22.7 s forward across the jump itself), and restarted at 80,089 µs on the next boot while `t` stayed epoch | **VALIDATED** |

Two defects were found by these instruments and fixed in the same session:

- `GET_RUNTIME_STATS` called `uxTaskGetStackHighWaterMark()` on the icon
  builder's freed TCB, reading 0, then 1460, then 1380 across three calls —
  drifting freed heap, and 0 reads as a task that nearly overflowed. Now 2292,
  identical across four calls over 35 s, flagged `exited`. Commit `baecc8e`.
- `cam_probe` had 356 free bytes of 4096 while merely timing out on four empty
  channels. The branch taken when a node *answers* is the expensive one, so the
  overflow would have landed on the node-greeting checkpoint and read as a link
  fault. 8192 now, measuring 4452 free. Commit `b35592e`.

Not proven in this session, and not to be inferred from the above:

| Item | Why not |
|---|---|
| FAT file timestamps | The source-level linkage IS verified: ESP-IDF's `get_fattime()` (`components/fatfs/diskio/diskio.c`) reads `time(NULL)`, which is the clock `settimeofday()` now sets. But no file survives on the card for its mtime to be read back — `STORAGE_BENCH` and `STORAGE_SELF_TEST` both clean up. **The mtime check belongs to the first persistent real capture.** Note FAT records UTC (TZ unset) and clamps to 1980 on an unset clock |
| Persisted-clock restore from NVS | The reboot test cannot isolate it. On a *soft* reset both NVS and the still-running RTC hold the time and the policy deliberately takes the later one, which is the RTC. Proving the NVS path needs a full power cycle, which clears the RTC and leaves NVS intact — a physical unplug. `pure_clock_restore_action()` covers it in host tests |
| Anything on the camera link | No node has been connected. All CAM, SYNC, `FLASH_EN` and shutter rows remain `UNVALIDATED` |

### Not validated, and not inferable from code

Every one of these has firmware written for it and no hardware evidence
whatsoever. Listed explicitly so nobody reads working code as a working
subsystem.

| Item | State |
|---|---|
| CAM1 UART through the P4 (`CAM1_TX` GPIO52, JP1 pin 7 / `CAM1_RX` GPIO51, JP1 pin 9) | **UNVALIDATED** — no node has answered yet, issue #2. The header positions themselves are measured: JP1 7 answered as GPIO52 under a per-pin scan (ECN-0002) |
| CAM1 baud 921600 over the harness | **UNVALIDATED** |
| CAM1 node link (`node_link` over KDP framing) | **UNVALIDATED** |
| CAM1 sensor detected *through the P4* | **UNVALIDATED** — the standalone run below is a different unit and a different path |
| CAM1 JPEG transfer over the link | **UNVALIDATED** |
| CAM1 SD write of a transferred frame | **UNVALIDATED** |
| CAM2 / CAM3 / CAM4 — every row (`CAM2_TX` GPIO50 pin 11 / `CAM2_RX` GPIO49 pin 13; `CAM3_TX` GPIO34 pin 17 / `CAM3_RX` GPIO33 pin 8; `CAM4_TX` GPIO30 pin 12 / `CAM4_RX` GPIO29 pin 14) | **UNVALIDATED** — no harness has ever existed. JP1 13 (`CAM2_RX`) is one of the two pins the scan measured directly |
| Four-camera concurrent capture | **UNVALIDATED** — Gate B |
| Exposure synchronization / inter-camera skew | **UNVALIDATED and UNMEASURED** — Gate C. Frame period derived at ~112 ms from driver source; no hardware confirmation |
| Stale-frame lifecycle | **PREDICTED FROM SOURCE, UNCONFIRMED** — see the M1 runbook's Phase 15 gate |
| `SYNC_TRIGGER_GPIO32` (`SYNC_OUT`, JP1 pin 19) | **UNVALIDATED** — driven by `capture.c`; no node reads the edge, so nothing has seen it |
| `FLASH_EN_GPIO28` / flash hardware | **UNVALIDATED** — routed on JP1 pin 21, never driven into a load; no flash board exists; `flashHardware: false` |
| `CAM_PWR_EN_GPIO31` | **UNVALIDATED** — no header pin left on JP1. The old GPIO31 row above is void |
| Physical shutter / Fn button | **UNVALIDATED** — pins deliberately `BOARD_BTN_NONE`; no switch fitted |
| Battery voltage / percentage / low-battery shutdown | **NOT APPLICABLE on this board** — no sense divider reaches the P4 (deviation D10). Needs a hardware revision |
| Backlight brightness / dim stage | **NOT APPLICABLE** — plain GPIO, not PWM (deviation D11) |
| P4 → C6 SDIO mapping | **IDENTIFIED AND RECONCILED, REQUIRES BENCH VALIDATION.** SDMMC slot 1 on GPIO14–19 with EN on GPIO54. Identified from Guition documentation for this carrier, then reconciled against two independent primary sources: Espressif's own ESP-Hosted defaults for a P4 host with a C6 coprocessor pin all six to exactly these numbers (`min == max`), and `ESP_HOSTED_HOST_RESET_GPIO` defaults to 54 for every P4 target. Evidence chain: [`C6_HARDWARE_MAP.md`](C6_HARDWARE_MAP.md). **No pin has been driven.** The radio is a build-time opt-in that is off by default, because enabling ESP-Hosted drives these pins before `app_main` on every boot and the routing is corroborated rather than measured |
| GPIO54 (`CHIP_PU`) polarity | **UNCONFIRMED.** ESP-Hosted defaults to active-low ("LOW asserts reset, HIGH runs") and ships an explicit active-high override for boards whose EN is buffered through an inverting transistor. Which this carrier is has not been measured. One constant, `BOARD_C6_EN_ACTIVE_LOW`, so the bench can flip it |
| SD / C6 bus coexistence | **RESOLVED IN SOFTWARE, REQUIRES BENCH VALIDATION.** The two buses share no pin *and* — the part that mattered — no longer share a slot. One SDMMC controller serves both; `SDMMC_HOST_DEFAULT()` selects slot 1, so the card had been sitting on the slot ESP-Hosted needs. The card is now explicitly on slot 0, whose IOMUX pads are exactly GPIO39–44 (`soc/esp32p4/include/soc/sdmmc_pins.h`), and slot 1 has no IOMUX path at all. Espressif ship this arrangement as `esp_hosted`'s `mcu_hosted_sdio_sdmmc_combined` example. **Unproven on hardware: the card has never been mounted from slot 0**, and that is now the first thing a bench run must check |
| SD card on slot 0 | **UNVALIDATED.** The 2026-08-26 mount that validated GPIO39–44 was on slot 1. The pins are unchanged and are the chip's dedicated SD pads, so this is expected to be a no-op or an improvement — but it is a change to a validated path and has not been re-observed |
| Wi-Fi association / DHCP / DNS / TLS | **NOT VALIDATED — never attempted.** No radio has been exercised on this hardware. The state model, credential store and `NETWORK_*` surface are CODE DONE and host-tested; nothing above them has run |
| C6 coprocessor image | **CODE DONE, UNVALIDATED** — `firmware/c6` is Espressif's official ESP-Hosted coprocessor (component pinned to 3.0.6), 1 105 872 bytes, and two clean builds of one commit match. Never flashed; no version read back. The C6's SDIO slave pads are fixed in silicon, so the image is correct independently of the carrier |
| C6 module flash size | **UNKNOWN, and it gates the first flash.** The coprocessor image needs the 4 MB OTA table — it is 122 KB too large for the 2 MB one, so a smaller part means a different image, not a smaller table. An oversized `FLASHSIZE` flashes and then fails to boot. `esptool flash_id` over the recovery path before the first write |
| ESP-Hosted version compatibility | **UNVERIFIED, and it is a gate rather than a warning.** This board is publicly reported to ship a factory C6 image older than current hosts expect, and a protocol mismatch presents as a transport fault — the failure most likely to be misdiagnosed as bad Wi-Fi, bad credentials or a Roll problem. Host, coprocessor and RPC versions must be read and compared before any Wi-Fi debugging |
| Networking / KINO Roll from the camera | **CODE DONE except the transport, UNVALIDATED.** Durable SD queue, boot reconciliation, retry/backoff, idempotency, roll membership and the `ROLL_*`/`UPLOAD_*` surface are implemented and host-tested. The HTTP client is a seam. **No capture has ever reached a Roll from this body.** Issue #133 |
| Roll assigned from Studio over USB | **CODE DONE, UNVALIDATED** — `ROLL_JOIN` accepts a Studio-resolved assignment, persists it across reboot, and the ROLL screen renders its join QR. Needs no radio. Never run on a board |
| On-device QR (Roll join code) | **CODE DONE, UNVALIDATED on a panel.** The encoder is verified module-for-module against `qrcode@1.5.4` over 713 strings, and the render is verified in `host_preview`. **No phone has scanned one off the display** — pitch, backlight and viewing angle are unproven |
| OTA / `FW_*` / firmware update over KDP | **NOT IMPLEMENTED** — single `factory` partition, no OTA slots |
| Light/deep sleep | **NOT IMPLEMENTED** — backlight and camera bank only |
| Thermal response | **NOT IMPLEMENTED** — die temperature readable, nothing acts on it |
| `STORAGE_BENCH` throughput on a real card | **CODE DONE, UNVALIDATED** — implemented in 0.3.0, never run on hardware |
| Per-task stack high-water figures | **CODE DONE, UNVALIDATED** — exposed in `GET_RUNTIME_STATS`, never read from a board |

## Status — 2026-08-25, firmware 0.1.0

The first physical hardware has been run: one XIAO ESP32-S3 Sense camera
module, standalone over USB-C with `firmware/uvc-preview`. **No P4 and no
harness were involved**, so only the two rows that describe the sensor and its
capture path can move. Everything about the link, the pin map and the baud
stays `UNVALIDATED` — nothing tonight exercised them, and a row that changes
on anything less than the operation itself makes this file worthless.

### P4 host board, 2026-08-26

Guition JC4880P443C-I-W, MAC `80:F1:B2:D1:21:BC`, serial `KD4-D121BC`,
firmware 0.1.0. USB only — no camera harness, no battery. Eight rows moved,
auto-marked by the firmware from real events and read back over
`GET_HW_VALIDATION`.

| Observation | Value |
|---|---|
| Chip | ESP32-P4 rev v1.3, 360 MHz, 16 MB Boya flash |
| PSRAM | 32 MB AP Memory, 256 Mbit, X16, memory test **OK**, 32722 KB free at idle |
| SD card | mounted 29820 MB, FAT, 4-bit high-speed, on-chip LDO ch4 |
| `STORAGE_SELF_TEST` | **ok**, 65536 bytes, 125 ms, no failed phase |
| KDP | all 17 M1B commands answered over USB-Serial-JTAG |
| Capabilities | every flag `false` except `benchDiagnostics` — matches the `d4-m1b` profile exactly |
| P4 die temperature | 27 °C at idle |
| Reset reason | `usb` |
| CAM1 with nothing attached | `txFrames 3, rxBytes 0, timeouts 3, lastError TIMEOUT` |

The camera rows stay `UNVALIDATED` in the device's own registry, correctly: no
node has ever answered this P4. Note that `CAM1_SENSOR_DETECT` and
`CAM1_CAPTURE` are `VALIDATED` in the table below on the strength of the
standalone module bench, which is a different unit and a different path. The
device registry and this file are both right in their own frame — the P4 has
not seen a sensor, and a sensor has been seen.

Not established: anything about the camera UARTs, the node link, or the
harness. Nothing tonight connected a camera to this board.

### Camera module 1, MAC `7C:4F:AD:20:87:8C` (ESP32-S3 QFN56 rev v0.2, 8 MB octal PSRAM,
8 MB GD flash):

| Observation | Value |
|---|---|
| Sensor identity | `PID=0x3660`, driver reports "Detected OV3660", SCCB address `0x3c` |
| Sensor registers | every setter `uvc-preview` uses is implemented, denoise included |
| Capture | 210 consecutive JPEGs, none truncated (SOI/EOI checked on the device) |
| JPEG size, VGA q12 | 7.7–30.4 KB |
| PCLK | 8 MHz, from XCLK 16 MHz (`VCO 128 MHz, SYSCLK 32 MHz`) |
| Frame corruption | 48% of frames at XCLK 20 MHz, 0.5% at 16 MHz — see the changelog and issue |
| Colour | G +5.2% against neutral on a lit white wall, with Espressif's OV3660 tuning applied |

**Not** established by this run: that the frames are free of mid-stream
corruption. The device-side check reads two bytes at each end of the JPEG and
catches truncation only.

| Item | Assumption source | Status |
|---|---|---|
| `USB_SERIAL_JTAG` | Observed 2026-08-26: host frame decoded over USB-Serial-JTAG | VALIDATED |
| `SD_CLK_GPIO43` | Observed 2026-08-26: card mounted 29820 MB, 4-bit | VALIDATED |
| `SD_CMD_GPIO44` | Observed 2026-08-26: card mounted 29820 MB, 4-bit | VALIDATED |
| `SD_D0_GPIO39` | Observed 2026-08-26: card mounted 29820 MB, 4-bit | VALIDATED |
| `SD_D1_GPIO40` | Observed 2026-08-26: card mounted 29820 MB, 4-bit | VALIDATED |
| `SD_D2_GPIO41` | Observed 2026-08-26: card mounted 29820 MB, 4-bit | VALIDATED |
| `SD_D3_GPIO42` | Observed 2026-08-26: card mounted 29820 MB, 4-bit | VALIDATED |
| `SD_LDO_CH4` | Observed 2026-08-26: card powered and mounted 29820 MB | VALIDATED |
| `CAM1_TX_GPIO52` (JP1 pin 7) | Manufacturer `JC4880P443C-I-W` drawing, and MEASURED: a per-pin scan reported JP1 7 as GPIO52 (ECN-0002). The KINO assignment is still electrically unproven — no node has answered (d4-v1.json, issue #2) | UNVALIDATED |
| `CAM1_RX_GPIO51` (JP1 pin 9) | Same drawing. Not individually scanned; its neighbours JP1 7 and JP1 13 both matched the drawing exactly | UNVALIDATED |
| `CAM1_BAUD_921600` | M1B baseline; escalation is milestone 2 bench work | UNVALIDATED |
| `CAM1_NODE_LINK` | node_link over KDP framing | UNVALIDATED |
| `CAM1_SENSOR_DETECT` | Observed 2026-08-25 on module 1: `PID=0x3660` at SCCB `0x3c`, standalone over USB | VALIDATED |
| `CAM1_CAPTURE` | Observed 2026-08-25 on module 1: 210 JPEGs into node PSRAM, standalone over USB | VALIDATED |
| `CAM1_JPEG_TRANSFER` | Chunked UART read-out, CRC-verified | UNVALIDATED |
| `CAM1_SD_WRITE` | /KINO/CAPTURES/<uuid>/ write + read-back CRC | UNVALIDATED |

Field-note source: <https://github.com/ultramcu/guition-jc4880p443c-i-w> —
useful, but not our unit.

Header correction, 2026-08-28: the camera-side rows were renamed when the JP1
map was replaced (`docs/HARDWARE.md` §P4 header JP1). The rename changes no
status — every camera row was and is `UNVALIDATED`. The only row whose status
moved is `CAM_PWR_EN GPIO31`, from `VALIDATED (pin only)` to void, above.

## How a row changes

A row may also change from a standalone module bench with
[`uvc-preview`](uvc-preview/README.md), which is how `CAM1_SENSOR_DETECT` and
`CAM1_CAPTURE` moved — but only those two. A module answering over USB says
nothing about the pin map it will hang off, the baud it will run, or whether
the P4 can reach it.

Run the procedure in [`BENCH_M1B.md`](BENCH_M1B.md). After each stage, read
`GET_HW_VALIDATION` (Studio → Developer → Bench Diagnostics) and copy the
device's verdicts here with the date, firmware version, wiring revision, and
failure notes. Issue #66 carries the running record; issue #3 consumes it.
