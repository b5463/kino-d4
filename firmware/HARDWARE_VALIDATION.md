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

### THUMB.JPG is written, 2026-08-29

`thumb_write` had never once succeeded in this project. It does now, at both
capture sizes, and `MEDIA_THUMB` reads the file back off the card in ~13.7 ms.

**Why it never worked.** `ppa_do_scale_rotate_mirror` checks the destination
against the cache line and rejects both a misaligned pointer and a size that
is not a multiple of it:

    ((uint32_t)out.buffer & 63) == 0 && (out.buffer_size & 63) == 0

The scale target came from `jpeg_alloc_encoder_mem(..., JPEG_ENC_ALLOC_INPUT_BUFFER)`,
and IDF's input branch is a plain `heap_caps_calloc` - no alignment, no
rounding, because the encoder only ever READS that buffer. The PPA writes it.
A PSRAM block lands on 64 about one time in sixteen, so the call returned
`ESP_ERR_INVALID_ARG` almost always. `thumb_load` had worked all along because
its destination is a gallery tile allocated with `heap_caps_aligned_calloc(64,
...)` and sized by `THUMB_TILE_BYTES`.

This is the third time PPA alignment has cost this project a bug. The rule is
now in one place: `ensure_ppa_dst()`.

**The second fault, behind the first.** With the scale fixed, the encoder step
ran for the first time. It is configured `JPEG_DOWN_SAMPLING_YUV420`, whose MCU
is 16x16, and IDF neither validates nor pads the dimensions. 2048x1536 reduces
to 256x192 and is whole; 1600x1200 reduces to 300x225 and is whole in neither
axis.

Trimming the output to a multiple of 16 alone does not work, and the bench said
so: 2048x1536 wrote and 1600x1200 did not. The PPA also checks the SCALED
source block against the destination picture - `(uint32_t)(scale_x *
in.block_w) <= out.pic_w` - and a full 1600-wide block at 3/16 still scales to
300, which no longer fits the 288 the rounding left. The source block is now
cropped to match the trimmed output, satisfying both rules.

| Capture size | reduction | thumbnail |
|---|---|---|
| 2048x1536 | 2/16 -> 256x192 | **written, readable** |
| 1600x1200 | 3/16 -> 300x225, trimmed to 288x224 | **written, readable** |

A `MEDIA_THUMB` immediately after a capture can time out; the device is
finishing its gallery refresh. Re-read a moment later and it is 13.5-13.8 ms.

### Capture works: the compositor was blacking out the link ISR, 2026-08-29

The product capture path is **VALIDATED**. It had never completed reliably.

| Configuration | Result |
|---|---|
| `CAMERA_CAPTURE`, 1600x1200 | **5/5**, 1.7-2.5 s, zero retries |
| `CAMERA_CAPTURE`, 2048x1536 (sensor native) | **6/6**, 2.5-3.5 s, zero retries |
| `CAMERA_TEST`, 1600x1200 (control) | 12/12, zero read timeouts |

**The fault.** A capture lost 14-73 bytes out of nearly every chunk, with zero
CRC errors, while `CAMERA_TEST` moved the same frame over the same wire
perfectly. The arithmetic identified it: past a 128-byte FIFO at 921600 baud,
losing that many bytes means interrupts were off for **1.5-2.2 ms**. Far too
short for a flash erase, which would have cost thousands of bytes, and exactly
the length of a cache writeback.

`capture_fire` sets `s_stage`; `run_capture` never does. `ui_task` treats a
non-idle capture stage as busy and repaints and presents every 60-90 ms for the
whole transfer, where `CAMERA_TEST` leaves it idle presenting nothing.
`gfx_present` does a blocking PPA rotate and a DPI handoff across two 768 KB
PSRAM framebuffers, and the cache maintenance under it runs in a critical
section - interrupts off on the running core. Tasks were unpinned and
`camlink_init` runs from `app_main` on CPU0, so about half the presents landed
on the core owning the link interrupts. The retry landed in a different phase
on a different core and succeeded, which is why every chunk after the first
failed exactly once.

Pinning `ui_task` to CPU1 fixes it with no trade-off: preview and shutter both
run at full rate.

Two contributing faults were fixed with it. `cam_probe` greets cam0..cam3
serially at 3000 ms each holding the channel mutex, walks the same order
`capture_fire` does so the two could lockstep, and slipped HELLO frames -
each opening with `uart_flush_input` - between chunk reads; it now stands down
while a capture runs. And `camlink_get_info_ch` read a cached struct under that
same mutex with `portMAX_DELAY`, turning "which cameras are online" into a
multi-second wait on the shutter path.

### Tried and rejected, so it is not tried again

Everything below was measured, not reasoned about, and none of it is kept.
Several were measured while the compositor fault was still present, which is
the honest reason they looked inconclusive at the time.

| Change | Result |
|---|---|
| `CONFIG_UART_ISR_IN_IRAM=y` | **Made it worse.** 0/5 with, 12/12 without. The stated reason in `sdkconfig.defaults` was later shown wrong; the measurement stands, the explanation does not |
| UART driver event queue | Added to name the overrun, which it did; more ISR work is the wrong direction and it is removed |
| Capture workers at priority 8 instead of 5 | No change. Task starvation cannot lose bytes - the RX ring is 33 KB, about 360 ms of wire. Only an ISR blackout can |
| `NL_CHUNK_MAX` 8192 -> 2048 | Worse: overruns track request turnarounds, not bytes. 4 overruns became 30 |
| `NL_DEFAULT_BAUD` 921600 -> 460800 | Fewer overruns, not zero, and doubles every transfer |
| `LINK_RX_BUF` 33 KB -> 66 KB | No change. This is what ruled out the reader being outrun |
| Node `fb_count` 2 -> 1 | No change to the link; brings back the preview beat |
| Drain-to-silence after a timeout | Markedly worse; written for a cascade the measurements contradicted |
| `CHUNK_READ_TIMEOUT_MS` 800 | Captures failed. Sized against a link that was already broken |

Budgets after the fix, sized for the wire rather than the fault: chunk timeout
1000 ms (eleven times a chunk's 89 ms), 2 retries, 8000 ms per frame.

### Capture at 2048x1536, and the UART overrun that limits it, 2026-08-29

One camera on CAM1, stills at the sensor's native 2048x1536 - the largest size
the OV3660 produces without interpolation, so the largest that does not cost
image quality. Frames measured 91-170 KB.

The product capture path completes where it previously never did: **2 of 5**,
about 20 s each, carried over lost chunks by retries. The remaining failures
are all one fault.

| Configuration tried | Overruns per capture | Result |
|---|---|---|
| 8 KB chunks, 921600, 4000 ms | 4-5 (good runs), ~30 (bad) | **2/5 pass** — kept |
| 8 KB chunks, 921600, 800 ms | same | 0/4 — budget too short for a retry to be worth taking |
| 2 KB chunks, 460800 | ~30 | 1/4 — four times the requests, four times the overruns |
| 8 KB chunks, 460800 | 1-4 | 0/4 — fewer overruns, still fatal |
| RX ring 33 KB -> 66 KB | unchanged | no effect |

**The fault.** `UART_FIFO_OVF` on the P4's link UART. The RX FIFO is 128 bytes,
which at 921600 baud is 1.39 ms of tolerance, and the ESP-IDF driver resets the
FIFO when it overflows - so the entire frame in flight is lost, not corrupted.
A whole 8210-byte chunk dies to one momentary window. The link carried 452 KB
with **zero CRC errors** across the same session, so this is not signal
integrity and not the cable.

Two measurements pin down what it is not:

- Doubling the driver's ring buffer changed nothing, which rules out the reader
  being outrun and leaves the ISR being held off.
- Overruns scale with the number of request/response turnarounds rather than
  with bytes carried: quartering the chunk size quadrupled the request count
  and took a capture from 4 overruns to 30.

`CONFIG_UART_ISR_IN_IRAM=y` is set and did help - it moved the first failure
from chunk 0 to chunk 1 - so a disabled flash cache was part of it but is not
the whole story. Roughly a fifth of chunk requests still lose bytes.

**Hardware flow control is not available.** It would end this outright, but JP1
has twelve free GPIOs and eleven are committed (eight CAM TX/RX, `SYNC_OUT`,
`FLASH_EN`, `CAM_PWR_EN`). The twelfth is GPIO35, a boot strapping pin that
must stay unconnected. There is no room for four RTS/CTS pairs, so the four-
camera rig should not be wired differently on account of this.

The remaining lead is UART DMA. The ESP32-P4 has UHCI, which moves UART RX into
a DMA descriptor chain and removes the per-byte ISR deadline that this fault is
made of. That is the fix worth trying next; everything above only manages the
symptom.

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

### The camera reaches a real KINO backend and registers - LAN only, 2026-08-29

Not the production host: the repository's own Fastify API (`@kino/api`,
`tsx src/dev.ts`) running on this development PC over the dev compose
(Postgres 16, Redis 7, MinIO, `kino-dev-*`), migrations current via
`src/migrate.ts`. Nothing public was touched: no DNS, no openresty, no Caddy,
no port forwarding. The C6 was not flashed.

**Topology.** D4 on BRCD, `10.20.80.181`. PC on Ethernet `10.20.99.57/24`,
gateway `10.20.99.1` - **not the BRCD subnet**, and it did not need to be: the
site router forwards between them (PC -> D4 ping 31 ms, one hop). Fastify
listens on `0.0.0.0:3000` by default; an existing inbound Allow rule for TCP
3000 already covered it (no rule created). Loopback `/api/healthz` 200 in
86 ms, LAN IP 200 in 24 ms, body `{"ok":true,"db":true,"redis":true,"storage":true}`.

**Pointing the camera at it** (`e030feb`, D18): a stored `network.apiBase`
read at request time, validated by the host-tested `pure_api_base_ok()`
(http/https, host, optional port, no path, never credentials), replacing the
compiled production default only when set. `SET_CONFIG` -> `SAVE_CONFIG` ->
`GET_CONFIG` shows `http://10.20.99.57:3000`; it survived a reflash of the app
partition. This stored value is the only route an `http://` base can take
into the client; the compiled default stays https and `C6_TLS` cannot be earned
over http.

**Two firmware defects surfaced by the first real reply, both measured:**

- `roll_http_perform()` never read a body. It used `esp_http_client_perform()`
  with no event handler, which reads and discards the response, then
  `read_response()` on nothing. The probe's 200 carried no body; the
  registration 200 carrying `{deviceId, deviceToken}` was refused as "the
  register reply had no credential" while Postgres already held the device
  row. Now open / write / fetch_headers / read, as the upload path always did
  (`90b8d74`). After: probe 200 in 33 ms **with** the health body.
- `kdp_server` stack: 580 bytes free after one `ROLL_CREATE` on 8 KB - two
  nested 1 KB response buffers under cJSON. 12 KB now; 4.7-6.0 KB free
  measured after the same call.

**LOCAL_API_HTTP: PASS.** Physical D4 -> Fastify `GET /api/healthz` -> 200,
35 ms; the API's own request log shows `remoteAddress 10.20.80.181`.

**LOCAL_DEVICE_REGISTER: PASS**, through the production codepath and nothing
else - `ROLL_CREATE` from the camera:

| Step | Result |
|---|---|
| `POST /api/studio/devices/register` (unauthenticated) | **200 in 53 ms**, `{deviceId, deviceToken}` parsed, credential stored in `kino_rollsec` |
| `POST /api/device/rolls` (bearer) | **201 in 174 ms** |
| Reply to KDP | `rollId roll__Mg6PTK...`, `slug RRG8AZ`, `role host`, `active true`, `tokenStatus ok` - no token value anywhere in it |
| `ROLL_DEVICE_REGISTER` | auto-marked "server issued a device credential" |
| Second `ROLL_CREATE` | `INVALID_STATE "Already on roll RRG8AZ"` - the stored credential short-circuits `ensure_registered()`; no second POST |
| Postgres `devices` | **one** row for `KD4-D121BC` (`dev_-4qo...`, KINO D4, v1) after every attempt this session |
| Postgres `rolls` | one, `RRG8AZ` "bench-local", `live`, `created_by` that device |

On the backend's own idempotency: the local `DEVICE_REGISTRATION_MODE` is
`rotate` (the dev default; production is forced to `first-write-wins`), so a
same-serial re-register from the PC returned 200 with a rotated token rather
than the 409 the route documents for production. One row either way.

**Health across the phase:** boot-382 held through every request (no reboot),
`transportErrors 0`, `reconnects 0`, `sdErrors 0`, `droppedLogEvents 0` with a
host draining, heap 27.0 MB. Passphrase and `kdt_` token searched on
`GET_LOGS` and `GET_CONFIG` after every step: **0**.

**C6-E (production HTTPS) is not redefined by this.** It stays deferred on
server-side routing: DNS, SNTP and a certificate-verified TLS session to
`kino.acronym.sk` are proven; the 2xx waits on the API being deployed there.
Media upload (ROLL-B) was not attempted.

### First radio - scan, association, DHCP, time, DNS, TLS - Gates C6-D and C6-E, 2026-08-29

Unit `KD4-D121BC`, coprocessor ESP-Hosted 3.0.6 (rewritten earlier today),
P4 radio images built from clean archives: `38b1c825...` (`0ac40d2`, scan),
`09e50840...` (`172966f`, API base `https://kino.acronym.sk`). Test AP `BRCD`,
credential supplied by the operator and never written anywhere but the
`NETWORK_SET` payload. No camera attached. CP2102 on COM10 witnessing the C6.

**Two panics on the way, both measured and fixed.** The first
`NETWORK_LIST { "scan": true }` rebooted the P4 (`resetReason: panic`) - twice,
because the first fix was to the wrong stack. The console mirrored on
USB-Serial-JTAG then said what it was: `Guru Meditation Error: Core 0 panic'ed
(Stack protection fault). Detected in task "sys_evt"`. The scan-done handler
runs on ESP-IDF's event task, 2304 bytes by default and never sized here, with
a 1.3 KB result array on it and an NVS write below that. Static buffer and
`CONFIG_ESP_SYSTEM_EVENT_TASK_STACK_SIZE=4096` (`0ac40d2`); no panic since.

**Scan** (`C6_WIFI_SCAN`): 2450 ms, six networks, all 2.4 GHz WPA2. `BRCD`
at **-77 dBm, channel 11**, BSSID `78:8a:20:8d:32:cc`. Row auto-marked
"6 network(s) seen". The scan had no trigger on the KDP surface before
`2b8f058` added the optional `scan` field to `NETWORK_LIST` (D16).

**Association and DHCP** (`C6_WIFI_ASSOCIATE`, `C6_DHCP`), after saving the
credential and rebooting into auto-join:

| Uptime | State | Detail |
|---|---|---|
| +4.2 s | `C6_BOOTING` | transport coming up |
| +8.4 s | `WIFI_CONNECTING` | ssid `BRCD` |
| +12.6 s | **`IP_READY`** | `10.20.80.181`, channel 11 |

The C6's own radio log: `wifi:connected with BRCD, aid = 7, channel 11, BW20,
bssid = 78:8a:20:8d:32:cc`, `security: WPA2-PSK, rssi:-80`, auth -> assoc ->
run in ~40 ms. Reproduced on three further reboots. `NETWORK_STATUS` reports
`state connected`, `internet true`, `savedNetworks 1`. Gateway and DNS server
are not exposed by `NETWORK_STATUS`; recorded as not surfaced rather than
guessed. `rssi` reads null after association - the got-IP path's
`esp_wifi_sta_get_ap_info()` is not populating it; noted, not chased here.

**Wrong passphrase, one attempt:** `WIFI_CONNECTING` -> `WIFI_IDLE /
ASSOC_FAILED` (802.11 reasons 2, 205) -> **`AUTH_FAILED`** (802.11 reason 15,
four-way handshake timeout). Never `IP_READY`; KDP answered throughout. With
the wrong credential stored, and again after restoring the right one, both
passphrases were searched for on `GET_LOGS`, `GET_CONFIG` and `NETWORK_LIST`:
**0, 0, 0** each time. `NETWORK_LIST` shows `"password": "....."` (four
bullets) and `hasPassword: true`.

**Persistence and reconnect after a P4 reboot:** correct credential restored,
`REBOOT`, `IP_READY 10.20.80.181` at +12.5 s with no host involvement,
`clockSource network`. That is §21A.

**Time** (`C6_SNTP`): the clock policy adopted the network time on the first
association - `clockSource: network`, row marked "wall clock adopted from the
network". A defect surfaced beside it: `NETWORK_STATUS` kept
`reason: CLOCK_UNTRUSTED` after the adoption, and `roll_http_ready()` refuses
TLS on exactly that reason, so every HTTPS request would have been held for
the life of the boot on a clock that was fine. `on_sync()` now releases the
hold (`172966f`); measured after: `IP_READY / NONE / "clock trusted from the
network"`.

**DNS, TLS, HTTPS** (`NETWORK_STATUS { "probe": true }`, `36623b7`, D17 - one
unauthenticated `GET /api/healthz` through the Roll HTTP client, certificate
bundle attached, no way to skip verification in this build):

| Leg | Result |
|---|---|
| DNS `kino.acronym.sk` | **27 ms**, `inet` - `C6_DNS` marked "API host resolved" |
| TLS + HTTP round trip | **557 ms**, total 584 ms. An HTTP response came back, which the client only delivers after a completed, certificate-verified handshake against the public bundle |
| HTTP status | **404** - `GET /api/healthz -> 404` |

The 404 is the server's, not the camera's: from a PC, every path on
`kino.acronym.sk` answers 404 with `server: openresty`, which is not the
Caddy/Fastify stack `infra/` describes - the KINO API is not deployed at that
host today. `C6_TLS` stays **UNVALIDATED**: the rule wants a 2xx over https,
and bending it to fit a 404 would be marking the row from the wrong evidence.
It will earn itself on the first 2xx once the API is up.

| Gate | Verdict |
|---|---|
| C6-D | **PASS** - scan, association, DHCP, wrong-password refusal, reboot persistence |
| C6-E | **FAIL (server side)** - SNTP, DNS and a verified TLS session pass; the harmless 2xx cannot happen until the API is deployed at the configured host |

Health across the phase: SD mounted first attempt on every boot, 0
`sdErrors`, heap 27.0 MB, PSRAM 27.0 MB, `droppedLogEvents` 58 with no host
draining, tightest stacks `upqueue` 1.3 KB and `kdp_server` 1.6 KB free.
`GET_CAPABILITIES.radioRouted` reads true; `network` and `roll` stay false by
design until Studio's fail-closed gate is revisited.

### The new coprocessor boots, the link comes up, the versions agree - Gate C6-C, 2026-08-29

**First normal boot** (strap removed, one recovery pulse from the P4, CP2102 on
COM10 witnessing): one `POWERON`, `boot:0xc (SPI_FAST_FLASH_BOOT)`, ESP-IDF
v5.5.1 second-stage bootloader, **our** partition table (`ota_0` 0x10000/1792K,
`ota_1` 0x1d0000/1792K, `nvs`/`otadata`/`phy_init` at the factory offsets),
app loaded from 0x10000, project **`kino-c6`** version 1, ESP-IDF v5.5.1,
**`ESP-Hosted Firmware version :: EH-3.0.6`**, `Transport used :: SDIO only`,
`SDIO_SLAVE: Using SDIO interface (TX_MODE=0)`, `SDIO datapath mode: SW_AGGR`,
`host reset handler task started`, `Returned from app_main()`. No panic, no
reset loop.

**P4 restored** to the canonical clean-source radio image (`24f8b11b...`,
`551e281`; reports 0.4.1 because that is the committed `VERSION`). Camera-first
baseline first: SD mounted, 1 attempt, no error; KDP up; no camera attached.

**C6-B, re-proven against the new slave** (boot-368, streamed klog):

```
 1.509s  own reset: GPIO54 low-asserted 12008us, released, settled 20005us
 3.391s  connect_to_slave rc=0 in 1846ms
 3.394s  SDIO after init: rx_ready=1 tx_ready=1
 3.402s  coprocessor id=13 target=esp32c6
 3.416s  link ready, C6 3.0.6 against host 3.0.6
         idf: eh_sdio: Card init success, TRANSPORT_RX_ACTIVE
         idf: eh_init_evt: RPC version negotiated: V2
         idf: eh_init_evt: esp-hosted fw versions: host=3.0.6 coprocessor=3.0.6 (match)
         idf: eh_init_evt: SDIO SW_AGGR negotiated (e2h=15872B h2e=15872B)
```

The C6's console, independently: `Slave init_config received from host`,
`Host capabilities: 44`, `RPC version negotiated: V2`, `Negotiation complete`.
`esp_hosted_get_cp_info()` now answers (`id=13 target=esp32c6`); with the 2.3.2
slave it returned empty fields.

**C6-C: PASS.** The version RPC answered 3.0.6; the firmware's gate and
esp_hosted's own check both accept it; the state machine advanced past the
gate for the first time: `radioState WIFI_IDLE`, `reason NO_CREDENTIALS`,
`detail "no network saved to join on its own"`, `transportErrors 0`.
Reproduced on boots 367 and 368.

| Row | Status | Evidence |
|---|---|---|
| `C6_SDIO_PINS` | VALIDATED | `rx_ready == 1`, again, on the new slave |
| `C6_LINK_HANDSHAKE` | VALIDATED | `rx_ready && tx_ready` |
| `C6_SLAVE_VERSION` | **VALIDATED** | auto-marked "C6 3.0.6 serves host 3.0.6" from the compatible RPC - the predicate's first true on hardware |

Nothing above the transport has run yet: no scan, no association. The scan
had no trigger anywhere on the KDP surface until `2b8f058`.

### The coprocessor is rewritten, 2026-08-29 - ESP-Hosted 2.3.2 -> 3.0.6

Every gate in front of the write was met before it, and the write is
reversible from a verified backup. Unit `KD4-D121BC`. Adapter: CP2102 on
**COM10** (`VID_10C4 PID_EA60`), TXD measured **3.25 V** idle before
connection, wired GND / pin 20 `C6_U0RXD` <- TXD / pin 22 `C6_U0TXD` -> RXD,
no adapter power to the board. esptool **v5.3.1**.

**Getting into the ROM loader.** The P4 ran the recovery image
(`33a2a9b6...`, `72ee96b`): one announced 500 ms GPIO54 pulse five seconds
after boot, then inert - no SDIO pin configured, ESP-Hosted never initialised.
The operator held JP1 pin 24 (`C6_IO9`) to pin 16 (GND); a P4 `REBOOT`
produced the pulse; the C6 ROM answered on COM10. The same pulse re-entered the
loader a second time later in the session when the stub lost sync, which is
the recovery path working as designed.

| Step | Result |
|---|---|
| Identification (`chip-id`, no reset, no write) | **ESP32-C6FH4 (QFN32), revision v0.2**, embedded 4 MB, 40 MHz crystal, BASE MAC `58:e6:c5:d3:17:fc` (the console's BT MAC `...:fe` is base+2) |
| `flash-id` | manufacturer `0x46`, device `0x4016`, **detected 4 MB** - agrees with the boot log and the chip features |
| Factory backup, read 1 | `read-flash 0 0x400000`, 376 s at 115200: **4 194 304 B**, SHA-256 `94fd8d9719e100634628b2af5a24ff55dfb54f6f2f0d1e321950d96c474e9181` |
| Factory backup, read 2 | Same command after a re-pulse: **identical hash**. (921600 desynced the CP2102 stream; nothing was written, the default rate was used) |
| Structure | bootloader magic `0xe9` at 0x0, app magic `0xe9` at 0x10000, table magic `0x50aa` at 0x8000 |
| Factory table, decoded from flash | `nvs` 0x9000/16K · `otadata` 0xd000/8K · `phy_init` 0xf000/4K · `ota_0` 0x10000/1536K · `ota_1` 0x190000/1536K · md5 entry. Only 0x0-0x12ffff is programmed; `ota_1` is erased |

The backup lives outside the repository as
`factory-c6-before-hosted-3.0.6.bin` (and `-read2.bin`), local bench evidence
only; the vendor image is not redistributed here.

**The write.** Offsets from the build's `flasher_args.json`, nothing invented:

```
esptool --port COM10 --chip esp32c6 --before no-reset --after no-reset write-flash
  --flash-mode dio --flash-freq 80m --flash-size 4MB
  0x0     bootloader.bin           22 416 B  89746864...
  0x8000  partition-table.bin       3 072 B  73e7f5c6...
  0xd000  ota_data_initial.bin      8 192 B  7d2c7ac4...
  0x10000 kino-c6.bin           1 105 872 B  3616fe6e6e6329f7443dce0f19232bb6aded9091801db874f150a18a1baaee61
```

Each image "Hash of data verified" by esptool; the app in 56.2 s. Then an
independent `read-flash 0 0x120000` compared against the four sources at
their offsets: **all four match byte for byte**, and the app region hashes to
the full `3616fe6e...baaee61`. `nvs` (0x9000-0xd000) and `phy_init`
(0xf000-0x10000) compare **unchanged** against the factory backup. The padding
after our smaller bootloader inside 0x0-0x8000 differs from the factory's, as
it must, and nothing lives there. Stale factory bytes remain beyond our app's
end inside `ota_0`, which is normal - the image header carries its length.

Source: `kino-c6.bin` from a clean archive of `551e281`, built twice,
byte-identical, esp_hosted 3.0.6 (`component_hash 1b1c2aa8...`), ESP-IDF
v5.5.1, table `partitions_eh_cp_ota_4m.csv` (`ota_0` 0x10000/1792K,
`ota_1` 0x1d0000/1792K; `nvs`/`otadata`/`phy_init` at the factory offsets).

Rollback, if ever needed: `write-flash 0x0 factory-c6-before-hosted-3.0.6.bin`
from the ROM loader, same strap, same pulse.

What followed - strap removed, first boot, P4 restored, C6-B re-proven, C6-C
passed - is the section above this one.

### GPIO54 is CHIP_PU, on the meter - Gate B2, 2026-08-29

The one electrical row the radio work had left open. Operator measurement,
multimeter, black probe JP1 pin 16 (GND), red probe JP1 pin 26 (`C6_CHIP_PU`),
during the firmware's three announced 3 s assert / 3 s release cycles
(`KINO_C6_EN_BENCH_MS=3000`, radio build 0.4.2, unit `KD4-D121BC`):

| Phase | Firmware drove GPIO54 | Pin 26 measured |
|---|---|---|
| released (rest) | HIGH | **~3.3 V** |
| asserted | LOW | **~0 V** |
| released | HIGH | **~3.3 V** |

Repeated across the cycles. The C6 console, captured on COM9 at the same
time, showed a `POWERON` boot **6.00 s** after each previous one - one per
release, exactly the cycle period - then two more 80 ms apart for the
firmware's own 20 ms reset and ESP-Hosted's pulse.

`C6_EN_GPIO54`: **VALIDATED** - by the meter, which is what the row means.
Active-low confirmed: LOW holds the C6 off, HIGH lets it run. The firmware's
constant `BOARD_C6_EN_ACTIVE_LOW 1` and ESP-Hosted's
`CONFIG_ESP_HOSTED_SDIO_RESET_ACTIVE_LOW=y` are both correct as shipped.
Recorded by hand: the firmware does not, and must not, mark this row itself.

### The CH340 must not touch the C6's RX yet, 2026-08-29

Measured by the operator: **CH340G TXD idle = 4.7 V** relative to CH340 GND.
That is above the ESP32-C6's 3.3 V I/O rating, so CH340 TXD may **not** be
connected to JP1 pin 20 (`C6_U0RXD`) directly. The RX-only wiring in use
(pin 16 GND, pin 22 `C6_U0TXD` -> CH340 RXD) is unaffected and stays.

Proposed remedy, not yet installed: a 1 kOhm / 2 kOhm divider from CH340 TXD
to GND, midpoint to pin 20, giving ~3.13 V from 4.7 V. Before ROM-loader
access is allowed the operator confirms, in this order: divider fitted;
common GND; midpoint measured with TXD idle; result 3.0-3.3 V. **Midpoint:
NOT YET MEASURED.** Never connect CH340 VCC, 5 V or 3V3 to the board.

Everything that needs the C6's UART RX - ROM download mode, `chip_id`,
`flash_id`, the factory backup, the slave write - waits on that measurement.
The plan for when it clears is in [`C6_BRINGUP.md`](C6_BRINGUP.md) step 3.

### What the LOG queue fixed, and what it did not, 2026-08-29

`5850b69`: a LOG event no longer waits on a host that is not draining
USB-Serial-JTAG; the caller enqueues and returns, a priority-1 task owns the
wire, a full queue drops and counts. On the first boot of that image
(boot-357) `droppedLogEvents` read 20 with no host reading - the events that
would previously have stalled their callers.

It did **not** unfreeze the UI. `ui screen 0 ... frames 41 STALLED` persists,
from ~16 s uptime, before `esp_hosted_init()` is reached, with no camera
attached, `ui` task 5.6 KB stack free. So the UI stall is a separate defect
in the UI/viewfinder path and not a logging or radio finding. Left for its
owner; recorded so it is not mistaken for either.

Also measured on the same boot: `GET_CAPABILITIES.radioRouted` reads **true**
on the radio build and agrees with `NETWORK_STATUS` for the first time
(`5850b69`, `34a5bbc`).

### The SDIO bus enumerates, 2026-08-29 - Gate C6-B

The first time the P4 and its coprocessor have exchanged a byte. Unit
`KD4-D121BC`, radio build 0.4.2, two independent witnesses on every boot: the
P4's own klog via KDP on COM8, and the C6's console on JP1 pin 22 via a CH340
on COM9, RX-only. No camera attached. Nothing was flashed to the C6.

**Root cause of every previous failure: enumeration had never been attempted.**
`esp_hosted_init()` brings up the host-side vserial and RPC layers and returns;
the reset pulse, `sdmmc_card_init()` and the RX_ACTIVE state live in
`ensure_slave_bus_ready()`, reached from one place in the pinned 3.0.6 source -
`esp_hosted_connect_to_slave()`. The component's auto-init constructor calls
both; this firmware disables that constructor (correctly - it drives GPIO14-19
and GPIO54 before `app_main()`) and had reproduced only the first half. Fixed in
`a2ab8ef`.

| Witness | Before the fix (boot-347) | After (boot-348, reproduced boot-352) |
|---|---|---|
| C6 console, boots per bring-up | 4 = three bench cycles + our own reset | **5** - the fifth is `eh_sdio: Reset co-processor using GPIO[54]` |
| IDF log (captured) | `transport_init: bus backend up`, then nothing | `Function 0 Blocksize: 512`, `Function 1 Blocksize: 512`, **`Card init success, TRANSPORT_RX_ACTIVE`**, `SDIO Host operating in STREAMING MODE`, `slave chip id: 0x0d (esp32c6)` |
| `eh_host_mcu_transport_state_is_rx_ready()` | 0 | **1** |
| `..._is_tx_ready()` | 0 | **1** |
| `esp_hosted_connect_to_slave()` | never called | rc=0 in **1854 ms** (1500 ms settle + card init) |
| C6 console, host contact | none | `host reconfig event` -> `Slave init_config received from host` -> `Host capabilities: 44` -> `slave_rpc: Received Req [0x15e]` x3, each answered `[0x25e]` |
| Version RPC | unanswered | **answered: coprocessor 2.3.2** |
| Registry | - | `C6_SDIO_PINS` and `C6_LINK_HANDSHAKE` auto-marked from `rx_ready && tx_ready` |

Configuration as compiled, read from the generated sdkconfig and the IDF log,
not from source comments: SDMMC slot 1, 4-bit, 40 000 kHz, CLK 18, CMD 19,
D0-D3 14-17, reset GPIO 54 active-low, `CP_RESET_STRATEGY_ALWAYS`, settle
1500 ms, `CP_BRINGUP_ON_TIMEOUT_NONE`, no internal LDO for slot 1.
`sdmmc_host_init: SDMMC host already initialized, skipping init flow` is the
card on slot 0 having taken the controller first; `sdmmc_host_init_slot(1)`
then configures slot 1 on its own and the two coexist. Both slots are up at
once on this unit, with the card mounted (1 attempt, 0 `sdErrors`) throughout.

**Version gate: the coprocessor is refused, correctly.** esp_hosted's own
check: `esp-hosted fw versions: host=3.0.6 coprocessor=2.3.2` ->
`E: major version mismatch - OTA coprocessor from host`. The firmware's own
gate reached the same verdict for the wrong reason: it compared against
`ESP_HOSTED_VERSION_*_1` (2.12.6, an "upstream-mcu compat" macro, a different
version space) and printed "cannot serve host 2.12.6". Corrected to the
component's release constants (`PROJECT_VERSION_*_1`) so the two agree. The
supervisor parks on `C6_BAD_FIRMWARE` as designed: `transportErrors: 0`, no
reset loop.

Two observations that are not radio findings, recorded so nobody mistakes
them for one:

- The UI watchdog logs `frames 41 STALLED` from ~16 s uptime on this build,
  before `esp_hosted_init()` is called, with no camera attached. Not caused by
  the hosted tasks - it predates them in the boot - and the `ui` task has
  5.2 KB of stack free. Separate issue.
- One `REBOOT` moved the session counter 348 -> 352. Not understood; watched
  across the rest of the session and it did not move again without cause.

| Row | Status | Evidence |
|---|---|---|
| `C6_SDIO_PINS` | **VALIDATED** | `rx_ready == 1` after `sdmmc_card_init()`, twice, two witnesses |
| `C6_LINK_HANDSHAKE` | **VALIDATED** | `rx_ready && tx_ready`, and the slave logging the host's RPCs |
| `C6_SLAVE_VERSION` | UNVALIDATED | RPC answered 2.3.2; refused against host 3.0.6. Stays open until a compatible coprocessor answers |
| `C6_EN_GPIO54` | **VALIDATED** (later the same day) | Meter on JP1 pin 26: ~3.3 / ~0 / ~3.3 V across the cycles. See the B2 section above |

C6-B: **PASS**. C6-C: **FAIL** - assessed for the first time, with real data on
both sides. Nothing above the transport was attempted; Wi-Fi was not started.

### The C6 answers, 2026-08-29 - passive UART, RX only

The first evidence that the coprocessor exists as anything but a footprint.
Entirely passive: one wire from the C6's console TX to a CH340 receive pin, and
a ground. Nothing was transmitted, nothing was strapped, and no flash was
touched.

| | |
|---|---|
| P4 firmware | 0.4.2, `3e6bc1277fc9861dabeea6631c8d6cd260465b2e9d2679d1d3d40391e14a73ef` |
| P4 session | boot-285 through boot-344 |
| Adapter | CH340G on COM9 (`VID_1A86 PID_7523`), 115200 8N1, no flow control |
| Wiring | JP1 pin 16 GND -> CH340 GND; JP1 pin 22 `C6_U0TXD` -> CH340 RXD. CH340 TX, VCC, `C6_IO9` and `C6_CHIP_PU` all left disconnected |
| Captured | 15 936 bytes, four complete boots |

Idle with no reset: **zero bytes in 15 s**, which is what a coprocessor that
booted long ago looks like. The output below arrived only when the C6 was
reset.

| Field | Value |
|---|---|
| ROM | `ESP-ROM:esp32c6-20220919`, build Sep 19 2022 |
| Reset reason | `rst:0x1 (POWERON)`, `boot:0xc (SPI_FAST_FLASH_BOOT)` |
| Chip revision | v0.2, efuse block v0.3 |
| **Flash** | **4 MB**, QIO, 80 MHz |
| Partitions | `nvs` 0x9000, `otadata` 0xd000, `phy_init` 0xf000, **`ota_0` 0x10000 len 0x180000**, **`ota_1` 0x190000 len 0x180000** |
| App project | `network_adapter`, version `f0a63f7-dirty` |
| App built | Aug 26 2025 11:55:53, ESP-IDF v5.5 |
| **Application** | **`ESP-Hosted-MCU Slave FW version :: 2.3.2`** |
| **Transport** | **`Transport used :: SDIO only`** |
| SDIO slave | `SDIO_SLAVE: Using SDIO interface`, `sdio_init: sending mode: SDIO_SLAVE_SEND_PACKET` |
| BT MAC | `58:e6:c5:d3:17:fe` |

Three things follow, and none of them was known before this capture.

**The C6 is alive and it is already an ESP-Hosted slave.** Not a vendor AT
image, not a Thread image, not an empty part. It brings its SDIO slave up on
every boot. So `C6_NOT_PROVEN_ALIVE` is retired and the classification is
`FACTORY_C6_HOSTED_BUT_SDIO_LINK_FAILING`.

**GPIO54 resets it.** Four `POWERON` boots arrived, aligned with the three
`KINO_C6_EN_BENCH_MS` assert/release cycles plus `bring_up()`'s own. A
`CHIP_PU` held low and released is exactly a power-on reset, which is what the
ROM reports. This is functional corroboration of the enable line and of
active-low polarity - it is **not** the meter reading, and `C6_EN_GPIO54`
stays `UNVALIDATED` until an operator reports the pin-26 voltages.

**The slave is 2.3.2 and the host is 3.0.6.** That is the first hard evidence
for why `C6-B` fails, and it is a major-version gap rather than a patch one.
It does not by itself explain a failure at SDIO *enumeration*, which is an SD
protocol handshake below anything ESP-Hosted versions, so the transport
question is now "why does a slave that says it is listening not enumerate",
not "is there a slave at all".

`C6-B` stays **FAIL** - `rx_ready` is still 0, and a live console proves the
CPU runs, not that the bus works. `C6-C` stays **CANNOT ASSESS**: a banner
string is not a protocol handshake.

### microSD on SDMMC slot 0, 2026-08-28

The one change 0.4.x made to an already-validated path. The 2026-08-26 mount
that earned GPIO39-44 was on slot 1 - the slot ESP-Hosted needs - so the card
moved to slot 0 and the row went back to `UNVALIDATED` until re-observed. This
is that observation. P4 alone on COM8, firmware 0.4.1, unit `KD4-D121BC`.

| Check | Result |
|---|---|
| Mount | `mounted: true`, 29 812 MB total / 29 810 MB free, FAT, **`mountAttempts: 1`** |
| `SD_SLOT0` registry row | Auto-marked `validated`, detail "mounted 29820MB" |
| `STORAGE_SELF_TEST` | `ok: true`, `failedPhase: null`, 65 536 B in **163 ms** |
| `STORAGE_BENCH` 64 KiB | 0.694 MB/s write, 1.359 MB/s read, worst block 42.1 ms, `crcMatch: true` (`a6275846` written and read), `cleanupOk: true` |
| `STORAGE_BENCH` 1 MiB | 0.623 MB/s write, 1.350 MB/s read, worst block 57.0 ms, p95 55.5 ms, `crcMatch: true` (`158987c5` written and read), `cleanupOk: true` |
| Free-space accounting | `freeBytes` 31 258 738 688 before and after both benches - `BENCH.TMP` removed, nothing leaked |
| `writeTestStatus` | `none` -> `pass` |
| Framing across the session | 0 CRC failures, 0 resyncs |

Against the slot-1 reference of 2026-08-26 (~0.59 MB/s write, ~1.35 MB/s read,
worst block ~129 ms): read is unchanged, write is 5-18% faster, and the worst
block is less than half. There is no regression to look for. The direction is
the expected one - slot 0 reaches these pads through IOMUX rather than through
the GPIO matrix.

`SD_SLOT0` is **VALIDATED**. `SD_C6_COEXIST` is not, and cannot be until the
radio is enabled: nothing has yet contended for the controller.

### C6 first light, 2026-08-28 - stopped before the first pin

Attempted after the slot-0 result above, on the same unit and session. It did
not proceed, and no C6 pin was driven.

| Gate | Result |
|---|---|
| B3 - microSD on slot 0 | **PASS**, above |
| B2 - GPIO54 / `CHIP_PU` semantics | **NOT ATTEMPTED.** Requires a meter or a scope on the control net. There is no KDP command that reads a raw GPIO, so the level cannot be sampled in-band, and the only other way to learn it is to drive it - which is the thing being avoided |
| C6-B onward | **NOT ATTEMPTED.** Enabling ESP-Hosted asserts GPIO54 and GPIO14-19 on init. Doing that before B2 is the blind toggle the procedure exists to prevent |

The bench images for the next attempt are built and pinned; see
[`C6_BRINGUP.md`](C6_BRINGUP.md). Note that `C6 module flash size` above still
gates the first C6 write independently of B2.

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
| P4 → C6 SDIO mapping | **VALIDATED 2026-08-29.** SDMMC slot 1 on GPIO14–19 enumerated the onboard C6 (`Card init success, TRANSPORT_RX_ACTIVE`, `rx_ready && tx_ready`), reproduced on two boots and witnessed from the C6's own console. Session recorded above. The routing was corroborated on paper first; it is now measured |
| GPIO54 (`CHIP_PU`) polarity | **VALIDATED 2026-08-29** on the meter: pin 26 reads ~3.3 V released, ~0 V asserted, ~3.3 V released, across three announced cycles, with the C6 console reporting a `POWERON` boot on every release. Active-low, as configured. Session recorded above |
| SD / C6 bus coexistence | **VALIDATED 2026-08-29** for the static case: card mounted on slot 0 (1 attempt, 0 `sdErrors`) with the C6 enumerated on slot 1 of the same controller, both up at once. `SD_C6_COEXIST` itself stays `UNVALIDATED`: it is defined as a scan before and after card I/O with the radio associated, and no scan has run |
| SD card on slot 0 | **VALIDATED 2026-08-28**, firmware 0.4.1 on `KD4-D121BC`: mounted first attempt, self-test and both benches pass with matching CRCs and clean cleanup, and throughput is at or above the slot-1 reference. Session recorded above |
| Wi-Fi association / DHCP / DNS / TLS | **VALIDATED 2026-08-29** through association, DHCP, SNTP and DNS, with a certificate-verified TLS session to the API host; the 2xx that marks `C6_TLS` waits on the API being deployed. Session recorded above |
| C6 coprocessor image | **CODE DONE, UNVALIDATED** — `firmware/c6` is Espressif's official ESP-Hosted coprocessor (component pinned to 3.0.6), 1 105 872 bytes, and two clean builds of one commit match. Never flashed; no version read back. The C6's SDIO slave pads are fixed in silicon, so the image is correct independently of the carrier |
| C6 module flash size | **UNKNOWN, and it gates the first flash.** The coprocessor image needs the 4 MB OTA table — it is 122 KB too large for the 2 MB one, so a smaller part means a different image, not a smaller table. An oversized `FLASHSIZE` flashes and then fails to boot. `esptool flash_id` over the recovery path before the first write |
| ESP-Hosted version compatibility | **UNVERIFIED, and it is a gate rather than a warning.** This board is publicly reported to ship a factory C6 image older than current hosts expect, and a protocol mismatch presents as a transport fault — the failure most likely to be misdiagnosed as bad Wi-Fi, bad credentials or a Roll problem. Host, coprocessor and RPC versions must be read and compared before any Wi-Fi debugging |
| Networking / KINO Roll from the camera | **Registration VALIDATED 2026-08-29** against the real backend on the LAN: `ROLL_CREATE` registered the device and created a roll through the production codepath (200 then 201). Upload not yet attempted - **no capture has reached a Roll from this body.** Issue #133 |
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
