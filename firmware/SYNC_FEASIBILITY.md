# Camera synchronization feasibility study

Desk study against the pinned camera driver, performed before any synchronization mechanism is
written. M0.D of [`FIRMWARE_ROADMAP.md`](FIRMWARE_ROADMAP.md).

> **CONFIRMED ON HARDWARE, 2026-08-28. Verdict: STALE_FRAME_CONFIRMED.**
>
> The prediction below — that with `fb_count=1` a capture after a release
> returns an already-queued frame instantly — was measured on the first camera
> ever wired to a P4. `fb_get` returns in 471–598 us where a fresh UXGA frame
> costs ~112 ms, and the frame handed back was 1.8 s, 3.4 s, 27.0 s and in one
> case **134.0 s** older than the shutter that asked for it.
>
> The tell ran through the whole bring-up without being recognised: the first
> capture after any idle period is 3–5 KB and the next is 90–240 KB. That was
> never exposure — it was a two-minute-old frame of a dark room.
>
> The discard-fetch fix specified in this document is therefore warranted by
> measurement rather than by reading the driver. It has NOT been applied.
> Evidence: [`HARDWARE_VALIDATION.md`](HARDWARE_VALIDATION.md) §Stale frame.

**Driver under study:** `firmware/camnode/managed_components/espressif__esp32-camera`
(`component_hash bc9c8a6b51df777a014fa295825b3de5069bc0300c317acff20c97cf4a10ac7d`, pinned in
`firmware/camnode/dependencies.lock`, target `esp32s3`).

**Configuration under study** (`firmware/camnode/main/camera.c:16-42`):

```text
fb_count      = 1
grab_mode     = CAMERA_GRAB_WHEN_EMPTY
fb_location   = CAMERA_FB_IN_PSRAM
pixel_format  = PIXFORMAT_JPEG
frame_size    = FRAMESIZE_UXGA (1600x1200)
jpeg_quality  = 12
xclk_freq_hz  = 16000000        (BOARD_CAM_XCLK_HZ)
pin_pwdn      = -1
pin_reset     = -1
```

**Method.** Source reading only. No hardware was involved. Every claim below cites a file and line.
Where the source does not settle a question, it is marked as requiring hardware or the OV3660
datasheet rather than being filled in.

---

## Current capture behavior

`camsensor_capture()` (`firmware/camnode/main/camera.c:120`) is a bare `esp_camera_fb_get()` wrapped
in an `esp_timer` measurement. `esp_camera_fb_get()`
(`driver/esp_camera.c:389`) does no capture work of its own — it calls `cam_take(FB_GET_TIMEOUT)`
and then stamps width/height/format onto whatever frame comes back.

`cam_take()` (`driver/cam_hal.c:686`) is a **queue receive**:

```c
if (xQueueReceive(cam_obj->frame_buffer_queue, (void *)&dma_buffer, remaining) == pdFALSE) {
    continue;
}
```

It does not start a capture, arm anything, or touch the sensor. It waits for a frame that a
**separate, always-running task** has already finished.

That task is `cam_task` (`driver/cam_hal.c:273`), created at
`driver/cam_hal.c:620` with `xTaskCreatePinnedToCore(..., configMAX_PRIORITIES - 2, ...)`. It is an
event-loop over `cam_obj->event_queue`, fed from ISR by `ll_cam_send_event()`
(`driver/cam_hal.c:250`).

**Consequence: capture is producer-driven, not request-driven.** `esp_camera_fb_get()` is a
consumer. Nothing in the call path can influence when light is integrated.

---

## esp32-camera frame lifecycle

Traced through `driver/cam_hal.c`:

| Stage | Where | Notes |
|---|---|---|
| VSYNC asserted by sensor | sensor hardware | free-running; nothing in firmware requests it |
| VSYNC ISR fires | `ll_cam_send_event(cam, CAM_VSYNC_EVENT, ...)` — `cam_hal.c:250` | queues an event; **does not** timestamp for the app |
| `cam_task` sees VSYNC while `CAM_STATE_IDLE` | `cam_hal.c:281` | `if (cam_event == CAM_VSYNC_EVENT)` |
| Frame start decision | `cam_start_frame(&frame_pos)` — `cam_hal.c:235` | **gated on buffer availability** |
| Buffer availability check | `cam_get_next_frame()` — `cam_hal.c:222` | returns true only if some `frames[x].en` is set |
| DMA started | `ll_cam_start(cam_obj, *frame_pos)` — `cam_hal.c:238` | |
| **Frame timestamped** | `cam_hal.c:241-243` | `esp_timer_get_time()` written into `frames[pos].fb.timestamp` |
| State → `CAM_STATE_READ_BUF` | `cam_hal.c:285` | DMA transfers line data |
| EOF | `CAM_IN_SUC_EOF_EVENT` | JPEG length finalised, EOI checked in `cam_take` (`cam_hal.c:769`) |
| Frame queued to app | `xQueueSend(cam_obj->frame_buffer_queue, ...)` — `cam_hal.c:404` | |
| Next frame started, or IDLE | `cam_start_frame()` at `cam_hal.c:423` | IDLE if no buffer free |
| App receives it | `cam_take()` → `esp_camera_fb_get()` | |
| App returns it | `esp_camera_fb_return()` → `cam_give()` — `cam_hal.c:788` | sets `frames[x].en = 1` |

### Does the returned frame's exposure predate `esp_camera_fb_get()`?

**Yes, and in the current node flow it usually does.** This is the study's most important finding.

With `fb_count = 1` there is exactly one frame buffer, so buffer availability is a hard gate:

1. `NL_CMD_CAPTURE` arrives. `handle_capture()` (`node_server.c:180-184`) releases any held frame,
   then calls `camsensor_capture()`.
2. `esp_camera_fb_get()` blocks; `cam_task` starts a frame at the next VSYNC; EOF queues it;
   `cam_take` returns it. **This frame is fresh** — its exposure began after the command.
3. The P4 reads the frame out over UART, then sends `NL_CMD_RELEASE`. `handle_release()`
   (`node_server.c:237`) → `camsensor_release()` (`camera.c:126`) → `esp_camera_fb_return()` →
   `cam_give()` → `frames[0].en = 1`.
4. **`cam_task` immediately captures another frame** at the next VSYNC and queues it. With no second
   buffer, `cam_start_frame()` then fails and the state returns to `CAM_STATE_IDLE`.
5. The next `NL_CMD_CAPTURE` finds `s_fb == NULL`, so step 1's release is skipped, and
   `esp_camera_fb_get()` **returns the frame queued in step 4 immediately** — a frame whose exposure
   began moments after the *previous* capture, which may be seconds or minutes earlier.

So the first photograph after a release is of the shutter moment; every subsequent one is of the
moment just after the previous readout. `CAMERA_GRAB_WHEN_EMPTY` does not help here — it governs
queue-overwrite behaviour when `frame_cnt > 1` (`cam_hal.c:609`, which only special-cases
`CAMERA_GRAB_LATEST`), not staleness with a single buffer.

**This is a capture-correctness defect, not merely a synchronization one**, and it is independent of
the wigglegram question: a single-camera KINO would photograph the wrong instant too.

**How to detect it on the bench (M1, no code change needed):** `camsensor_capture()` already
measures the wall time around `esp_camera_fb_get()` and the node reports it as `durationMs`. A fresh
frame costs roughly one frame period; a stale frame returns in ~0 ms. **A `durationMs` near zero on
captures 2..N is the signature.** M0 adds the telemetry that makes this visible without inference
(see *Recommended M2 measurement*).

**Pre-designed fix, deliberately NOT applied in M0** (public API only, no driver change): before the
real fetch, discard one frame —

```text
fb = esp_camera_fb_get();          /* may be stale */
esp_camera_fb_return(fb);          /* frees the single buffer */
fb = esp_camera_fb_get();          /* starts at the next VSYNC after this point */
```

This bounds the frame start to `[0, one frame period]` after the command, which is the best the
free-running sensor can offer. It costs one frame period per capture. It is left unimplemented until
M1 confirms the defect on hardware, per the roadmap's *validate before rewriting* rule.

---

## VSYNC / timing hooks

### What exists

| Hook | Location | Visibility | Useful? |
|---|---|---|---|
| **`camera_fb_t.timestamp`** | `driver/include/esp_camera.h:169` | **PUBLIC** | **Yes — the key enabler** |
| `CAM_VSYNC_EVENT` | `driver/cam_hal.c:281` | private (internal event queue) | not reachable from the app |
| `CAM_IN_SUC_EOF_EVENT` | `driver/cam_hal.c` ISR path | private | not reachable |
| `ll_cam_vsync_intr_enable()` | `driver/cam_hal.c:683` | private (`private_include/cam_hal.h`) | enable/disable only, no callback |
| `ll_cam_do_vsync()` | called at `cam_hal.c:240` | private | *manual* VSYNC to the DMA, not the sensor |
| `cam_get_available_frames()` | `driver/cam_hal.c:804` | private header | would answer "is a frame already queued" |
| `cam_give_all()` | `driver/cam_hal.c:798` | private header | bulk frame release |

**There is no public VSYNC callback, frame-start callback, EOF callback, DMA event, semaphore or
queue exposed to the application.** The events exist but terminate inside `cam_task`.

### The one that matters

`camera_fb_t.timestamp` is public and documented in the header as:

> *"Timestamp since boot of the first DMA buffer of the frame"*

and it is written in `cam_start_frame()` (`cam_hal.c:241-243`) at the moment DMA is armed for that
frame — i.e. immediately after the VSYNC that started it:

```c
uint64_t us = (uint64_t)esp_timer_get_time();
cam_obj->frames[*frame_pos].fb.timestamp.tv_sec  = us / 1000000UL;
cam_obj->frames[*frame_pos].fb.timestamp.tv_usec = us % 1000000UL;
```

**This gives every frame a node-local, microsecond frame-start time, through public API, with no
driver modification.** It is the single most valuable thing this study found, because it converts
"we cannot see sensor timing" into "we can, per frame, in `esp_timer` units".

Two caveats, both important:

1. It is **frame start**, not exposure centre or exposure start. For a rolling shutter the two differ
   per row, and the electronic shutter's integration window is not observable here at all. Frame
   start is the correct *anchor* for comparing sensors; it is not the exposure instant.
2. It is each node's **own `esp_timer`**, which shares no epoch with the other nodes or the P4.
   Cross-node comparison therefore needs a common event — which the existing `BOARD_SYNC_OUT`
   (GPIO32) → `BOARD_SYNC_IN` (GPIO2) trace can provide, with each node timestamping the edge in its
   own `esp_timer` and reporting `frame_start − edge`. That difference **is** comparable across
   nodes without any clock synchronisation.

---

## Can the node be armed?

### Classification: **B — possible with a small driver extension**, and in a restricted sense **A**

Two different questions hide inside "can it be armed", and they have different answers.

#### Question 1: can frame start be gated on a GPIO edge?

**Yes, with public API only.** Buffer availability is the gate (`cam_get_next_frame()`,
`cam_hal.c:222`). With `fb_count = 1`, holding the frame stalls capture at `CAM_STATE_IDLE`; releasing
it lets the next VSYNC start a frame. So:

```text
ARM:      node holds the single buffer          → capture stalled
TRIGGER:  GPIO ISR releases it (esp_camera_fb_return)
          → cam_task starts a frame at the NEXT VSYNC
READOUT:  esp_camera_fb_get() returns it
```

No driver change. But note what this achieves and what it does not: the frame starts at *that
sensor's next VSYNC*, which is **0 to one full frame period** after the edge. Four sensors released
by one edge still start at four independent VSYNCs.

**Gating on the edge alone does not reduce skew below one frame period.** It removes the staleness of
the current flow and it makes the start *causally* tied to the trigger, which is worth having — but
it is not synchronization.

#### Question 2: can the four sensors be made to start frames together?

This is the product question, and the public API alone does not answer it. Two routes:

**Route A — phase-aware triggering (public API + arithmetic).** Each node can learn its own VSYNC
phase and period from a history of `fb->timestamp` values, and report them. The P4, knowing each
node's phase relative to a shared GPIO edge, computes a per-node pre-delay so that all four frames
start at a common target time. Achievable skew is bounded by VSYNC period stability (jitter and
drift) over the prediction interval — **measurable, and currently unmeasured**. No driver fork.
Requires only that the node report `fb->timestamp` and an edge timestamp, both of which are
available today.

**Route B — sensor-level frame reset (register control).** Force the sensors' frame phase to align by
stopping and restarting streaming, or by using the OV3660's frame-control registers, so that all
four VSYNCs are coherent. See the next section. Semantics need the datasheet.

Route A is strictly cheaper and should be measured first. It is why the primary verdict is not
`DRIVER_FORK_REQUIRED`.

#### Why not classification A outright

Two mechanical obstacles keep this at B rather than A:

1. The **staleness path** must be closed first (a discard fetch, or `cam_give_all()` from the private
   header, or a driver-level flush). Without it, an "armed" node can still hand back a pre-trigger
   frame.
2. `cam_get_available_frames()` — the natural way to ask "is a stale frame already queued" — is
   declared in `driver/private_include/cam_hal.h`, not in the public header. Using it means either
   reaching into the private include path (a small, contained extension) or inferring queue state
   from `durationMs`, which is indirect.

Neither is a fork. Both are small and local.

---

## OV3660 sensor-control options

`sensor_t` declares register access at `driver/include/sensor.h:261-265`:

```c
int (*get_reg)     (sensor_t *sensor, int reg, int mask);
int (*set_reg)     (sensor_t *sensor, int reg, int mask, int value);
int (*set_res_raw) (sensor_t *sensor, int startX, ..., int totalX, int totalY, ...);
int (*set_pll)     (sensor_t *sensor, int bypass, int mul, int sys, int root, int pre, int seld5, int pclken, int pclk);
int (*set_xclk)    (sensor_t *sensor, int timer, int xclk);
```

and OV3660 **implements all of them** (`sensors/ov3660.c:1047-1050`), so runtime register read/write
is available with no driver change.

Relevant registers, from `sensors/private_include/ov3660_regs.h`:

| Register | Address | Header's description | Status |
|---|---|---|---|
| `X_TOTAL_SIZE_H/L` (HTS) | `0x380c/0x380d` | "Total horizontal size" | readable/writable; used by `set_framesize` |
| `Y_TOTAL_SIZE_H/L` (VTS) | `0x380e/0x380f` | "Total vertical size" | readable/writable; used by `set_framesize` |
| `X_OUTPUT_SIZE_H/L` | `0x3808/0x3809` | DVP output width | set by `set_framesize` |
| `Y_OUTPUT_SIZE_H/L` | `0x380a/0x380b` | DVP output height | set by `set_framesize` |
| `TIMING_TC_REG20` | `0x3820` | "Timing Control Register"; header notes **Bit[3] Gate PCLK under VSYNC**, **Bit[0] VSYNC polarity** | partially documented |
| `TIMING_TC_REG21` | `0x3821` | "Timing Control Register" | partially documented |
| `FRAME_CTRL01` | `0x4201` | "Control Passed Frame Number. When both ON and OFF number set to 0x00, frame control is in bypass mode" | **promising, semantics not documented** |
| `FRAME_CTRL02` | `0x4202` | "Control Masked Frame Number" | **promising, semantics not documented** |

`FRAME_CTRL01`/`FRAME_CTRL02` read like a "pass N frames then mask" primitive — exactly the shape a
single-shot trigger wants. **The header comment is not enough to build on.** Bit layout, whether the
counter restarts on write, and what happens mid-frame are all unstated.

> **Requires OV3660 datasheet investigation:** `0x4201`/`0x4202` bit semantics and restart behaviour;
> software-standby / streaming stop-start register and its effect on frame phase; whether a frame
> reset is available that does not disturb AEC/AWB convergence; exposure (integration) register
> layout and whether integration start is observable.

Two further cautions:

- **Do not casually change XCLK.** 16 MHz was chosen because 20 MHz corrupted 48% of frames against
  0.5% at 16 MHz (`HARDWARE_VALIDATION.md`). `set_xclk` exists; using it to chase frame rate would
  reopen a solved integrity problem.
- **Register writes go through SCCB**, which is neither instant nor deterministic. A per-capture
  register write is not a low-jitter trigger mechanism; it is a configuration action.

---

## Frame-period calculation

### The PLL path actually taken

`set_framesize()` (`sensors/ov3660.c:358-365`) for `PIXFORMAT_JPEG`:

```c
if (framesize == FRAMESIZE_QXGA || sensor->xclk_freq_hz == 16000000) {
    //40MHz SYSCLK and 10MHz PCLK
    ret = set_pll(sensor, false, 24, 1, 3, false, 0, true, 8);
}
```

Our configuration hits this branch (`xclk_freq_hz == 16000000`). **The comment is wrong.** Working
`calc_sysclk()` (`sensors/ov3660.c:128-148`) with `(bypass=false, mul=24, sys_div=1, pre_div=3,
root_2x=false, seld5=0, pclk_manual=true, pclk_div=8)`:

```text
pll_pre_div2x = pll_pre_div2x_map[3] = 6
pll_root_div  = 1
pll_seld52x   = pll_seld52x_map[0]   = 2

VCO    = (16000000/1000) * 24 * 1 * 2 / 6   = 128000 kHz = 128 MHz
PLLCLK = 128000 * 1000 * 2 / 1 / 2          = 128 MHz
PCLK   = 128000000 / 2 / 8                  =   8 MHz
SYSCLK = 128000000 / 4                      =  32 MHz
```

All three agree exactly with the standalone bench observation recorded in
`HARDWARE_VALIDATION.md` — *"PCLK 8 MHz, from XCLK 16 MHz (VCO 128 MHz, SYSCLK 32 MHz)"*. The code is
right and its comment is stale; the bench confirms the code.

### Array timing

UXGA 1600x1200 is `ASPECT_RATIO_4X3` (`driver/sensor.c:41`). The 4:3 row of
`ratio_table` (`sensors/private_include/ov3660_settings.h:11`) is:

```text
//  mw,   mh,  sx,  sy,   ex,   ey, ox, oy,   tx,   ty
{ 2048, 1536,   0,   0, 2079, 1547, 16, 6, 2300, 1564 }, //4x3
```

so **HTS = 2300**, **VTS = 1564**.

Binning is `w <= max_width/2 && h <= max_height/2` (`ov3660.c:326`). For UXGA: `1600 <= 1024` is
false, so **binning is off** and the full `total_y` is written (`ov3660.c:342`).

### Which clock drives the array?

Two candidate models, and the evidence discriminates between them.

| Model | UXGA period | UXGA fps | VGA period (binned, VTS=783) | VGA fps |
|---|---|---|---|---|
| `HTS × VTS / PCLK` (8 MHz) | 449.7 ms | 2.2 | 225.1 ms | 4.4 |
| `HTS × VTS / SYSCLK` (32 MHz) | **112.4 ms** | **8.9** | 56.3 ms | 17.8 |

The one hardware datapoint we have is the standalone bench: *"the sensor sustains at least 16 fps"*
at VGA (`HARDWARE_VALIDATION.md`, module 1, JPEG q12). That is consistent with the **SYSCLK model
(17.8 fps)** and inconsistent with the PCLK model (4.4 fps).

This makes physical sense in JPEG mode: `set_pll` sets `pclk_manual` and `PCLK_RATIO`
(`ov3660.c:170-173`), which decouples the DVP output clock from array readout — the array reads at
SYSCLK into the compression engine and VFIFO, and the compressed bytes are clocked out at PCLK. DVP
*output duration* is then a function of JPEG size, not of `HTS × VTS`.

### Result

```text
expected FPS:                                     ~8.9 fps  (UXGA, JPEG, XCLK 16 MHz)
expected frame period:                            ~112 ms
worst-case relative phase, two free-running       ~112 ms   (uniform 0 .. one frame period)
sensors:
```

**Assumptions, stated plainly:**

- Array readout is clocked at SYSCLK = 32 MHz, inferred from the VGA measurement above, **not** from
  a datasheet statement.
- `HTS × VTS` from the driver's own 4:3 table, with binning off for UXGA.
- No additional inter-frame delay is inserted by the JPEG engine or VFIFO drain. If the VFIFO cannot
  drain a large JPEG at PCLK 8 MHz within one array frame, the effective period is longer and
  variable with scene content. **A 30 KB JPEG at 8 MHz PCLK is ~30 ms**, comfortably inside 112 ms,
  so this is unlikely to dominate — but it is not proven.
- Exposure (integration) time is set by AEC and is not part of this calculation. In a dim party room
  the integration window may approach the frame period, which matters for motion blur and for what
  "exposure skew" even means.

> **All three numbers require hardware confirmation.** The clean way to get the frame period on the
> bench is to read consecutive `fb->timestamp` deltas — which M0's telemetry now exposes.

### Why ~112 ms is the headline

112 ms of uncorrelated inter-camera phase is a long time for a party subject. A hand or a turning
head moves visibly in 112 ms. This makes it **likely** that the free-running case fails the
photographic test and that M4 will be needed — but "likely" is not "measured", and the whole point of
M2 is to replace this inference with images.

---

## Least-invasive sync options

Ordered by cost. Each row states what it buys.

| # | Option | Invasiveness | Expected skew | Buys |
|---|---|---|---|---|
| 0 | **Report `fb->timestamp` + edge timestamp** | telemetry only, public API | none (measurement) | Turns skew from unknown into measured. **Done in M0.** |
| 1 | **Discard-fetch to kill staleness** | node, public API, ~5 lines | 0..1 frame period, *causally after* the trigger | Removes unbounded staleness. Correctness fix, not sync. |
| 2 | **Buffer-hold arm + GPIO release** | node, public API + GPIO ISR | 0..1 frame period | Frame start causally tied to a shared edge. Foundation for #3. |
| 3 | **Phase-aware triggering** | node reports phase; P4 computes per-node delay | VSYNC jitter over the prediction interval — **unmeasured** | The first option that can beat one frame period without touching the sensor. |
| 4 | **Sensor frame reset / frame-control registers** | `set_reg` via public API, but **undocumented semantics** | potentially coherent VSYNC | True phase alignment. Needs the datasheet; risks AEC/AWB disturbance. |
| 5 | **Driver fork** (expose VSYNC callback, arm DMA without VSYNC) | fork of a pinned component | as #3/#4 | Only if #3 is close but blocked by driver structure. |
| 6 | **Architecture change** | new sensors / new nodes / P4 MIPI-CSI | one clock domain | Last resort. Gate C failure branch. |

**Recommended sequence:** 0 now (M0) → 1 and 2 confirmed on hardware (M1) → measure (M2) → only then
3, and only if 2's measured skew fails the photographic test.

---

## Risks

| Risk | Severity | Note |
|---|---|---|
| **Stale-frame defect is real and unnoticed** | **HIGH** | Captures 2..N photograph the wrong instant. Affects single-camera KINO too. Detectable in M1 via `durationMs` ≈ 0 and `frameStartUs` far behind the request. |
| 112 ms frame period makes free-running sync unusable | HIGH | Derived, not measured. If confirmed, M4 is not optional. |
| Phase-aware triggering defeated by VSYNC jitter | MEDIUM | Unmeasured. If jitter is a large fraction of the period, #3 buys little. |
| `FRAME_CTRL01/02` semantics differ from the header comment | MEDIUM | Do not build on the comment. Datasheet or empirical bit-mapping required. |
| Frame period varies with JPEG size / scene | MEDIUM | Would make skew scene-dependent, which is worse than a constant. Measure across bright and dim scenes. |
| Exposure time approaching frame period in dim rooms | MEDIUM | "Skew" becomes ill-defined when integration windows are long and overlapping. The photographic test is the arbiter, not the number. |
| Driver is pinned by hash; a fork ends that | LOW-MEDIUM | Options 0–4 all avoid it. Keep it that way if possible. |
| Changing XCLK to chase frame rate | LOW but costly | Would reopen the 48%-corruption problem solved at 16 MHz. |

---

## Recommended M2 measurement

The roadmap's original plan was to photograph a millisecond clock. **That remains the ground truth
and should still be done** — it is the only method that measures light rather than firmware. But this
study found a second, much cheaper method that can run first and continuously.

### Primary (cheap, automatic, every capture)

Each node reports, per capture:

| Field | Source | Meaning |
|---|---|---|
| `frameStartUs` | `fb->timestamp` (public) | node-local µs when this frame's DMA began |
| `captureMs` | existing `durationMs` | wall time inside `esp_camera_fb_get()` — **≈0 signals a stale frame** |
| `syncEdgeUs` | node GPIO ISR (when option 2 lands) | node-local µs of the shared trigger edge |

Then `frameStartUs − syncEdgeUs` is **comparable across nodes with no clock synchronisation**, and
the spread of that difference across four nodes is the frame-start skew. Consecutive `frameStartUs`
deltas give the frame period directly, per sensor, at no cost.

This is instrumentation, not a mechanism, so it is in scope for M0. `syncEdgeUs` waits for option 2.

### Secondary (ground truth, M2 proper)

Photograph a millisecond timing reference, per `FIRMWARE_ROADMAP.md` §10 Stage A. This is what
validates the primary method: if `frameStartUs − syncEdgeUs` spread and the photographed skew agree,
the cheap method is trusted thereafter. If they disagree, the photograph wins and we have learned
that frame start is a poor proxy for exposure.

### Explicitly not a measurement of synchronization

`dispatchSpreadUs` measures when the P4 put four commands on four UARTs. It is a scheduler metric.
It must never be reported as, substituted for, or compared against exposure skew. The
`kino.capture.timing` block continues to report all three contract skews as `null` with an
`unavailableReason`.

---

## Verdict

```text
SMALL_DRIVER_EXTENSION
```

**Scope of that classification.** An arm-and-trigger flow *can* be built on the public API alone
(buffer-hold gating plus a GPIO ISR, option 2), and the per-frame timestamp needed to measure and
later to predict VSYNC phase is public (`camera_fb_t.timestamp`). What keeps this at *small driver
extension* rather than *public API possible* is that closing the stale-frame path cleanly wants
`cam_get_available_frames()` / `cam_give_all()`, which live in
`driver/private_include/cam_hal.h` — a contained reach into a private header, not a fork.

**Secondary notes:**

- `PUBLIC_API_POSSIBLE` applies to options 0, 1, 2 and 3 in isolation. A team willing to infer queue
  state from `durationMs` instead of calling the private helper could stay entirely public.
- `SENSOR_REGISTER_CONTROL_REQUIRED` becomes the classification **if** phase-aware triggering
  (option 3) cannot beat one frame period. `set_reg`/`get_reg` are implemented for OV3660, so the
  route is open, but `0x4201`/`0x4202` semantics need the datasheet.
- `UNKNOWN_REQUIRES_HARDWARE` applies to the *sufficiency* question throughout. This study
  establishes what is mechanically possible; it cannot establish whether the achievable skew makes a
  good wigglegram. Only M2 can.

**Implication for M2.** M2 gains a cheap continuous measurement it did not have, and gains one
critical new checkpoint: confirm or refute the stale-frame defect before trusting any skew number.
A skew measured across stale frames would be meaningless.

**Implication for M4.** The escalation ladder is re-ordered by this study. Original D1 (arm in
driver) is now split: staleness fix and buffer-hold arming are cheap and come first; the rung that
actually reduces skew below a frame period is phase-aware triggering, which was originally D2 and
should be attempted before any sensor-register work. Sensor registers move down, and a driver fork
moves down again.

**No synchronization mechanism was implemented in this phase.** Options 1 and 2 are specified above
and left for M1/M4 with hardware evidence in hand.
