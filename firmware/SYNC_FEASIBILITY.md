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
> **RESOLVED, 2026-08-28.** The node now runs `fb_count = 2` with
> `CAMERA_GRAB_LATEST`, which is what `esp32-camera` documents for streaming:
> the driver captures continuously and the queue holds only the two most recent
> frames, so the arbitrarily-old frame this section describes cannot be handed
> back. `camsensor_discard_queued()` is retained and still runs ahead of a real
> shutter, bounding the photograph to within a frame period of the command.
>
> The same change was independently required by the viewfinder. With one buffer
> the driver filled it after each return and then stalled, so the P4's preview
> pump - which free-runs against the sensor's frame clock - either caught a
> ready frame or waited a whole frame period. Instrumented on the bench the
> capture request was bimodal, `cap` 10 ms or 62-75 ms with nothing between,
> alternating the frame interval between about 40 ms and 101 ms. Two buffers
> flattened it to 5-9 ms and took the preview from 0.0-8.8 fps to 10.2-18.2.
>
> The sections below are left as written. They are the desk study that
> predicted the defect from source before any hardware existed, and the
> prediction was correct; `fb_count = 1` throughout them describes the
> configuration as it was, not as it is.
>
> Evidence: [`HARDWARE_VALIDATION.md`](HARDWARE_VALIDATION.md) §Stale frame.

**Driver under study:** `firmware/camnode/managed_components/espressif__esp32-camera`
(`component_hash bc9c8a6b51df777a014fa295825b3de5069bc0300c317acff20c97cf4a10ac7d`, pinned in
`firmware/camnode/dependencies.lock`, target `esp32s3`).

**Configuration under study** (`firmware/camnode/main/camera.c:16-42`):

The study was performed against `fb_count = 1` / `CAMERA_GRAB_WHEN_EMPTY`. That
is no longer what ships - see the resolution note above - and the current values
are given in brackets.

```text
fb_count      = 1               (now 2)
grab_mode     = CAMERA_GRAB_WHEN_EMPTY   (now CAMERA_GRAB_LATEST)
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

**The fix, applied in firmware 0.4.2** (public API only, no driver change): before the real fetch,
discard one frame —

```text
fb = esp_camera_fb_get();          /* may be stale */
esp_camera_fb_return(fb);          /* frees the single buffer */
fb = esp_camera_fb_get();          /* starts at the next VSYNC after this point */
```

This bounds the frame start to `[0, one frame period]` after the command, which is the best the
free-running sensor can offer. It costs one frame period per capture. M1 confirmed the defect on
hardware (frames 1.8 s, 3.4 s and 27.0 s old, above), so `camsensor_discard_queued()` in
`camnode/main/camera.c` now runs inside `handle_capture` for every non-preview resolution. Preview
sizes (`640x480`, `320x240`, `160x120`) skip it: a viewfinder frame a frame period old is what a
viewfinder shows anyway, and paying the period per preview would halve its rate. The capture reply
carries the cost as `discardMs`: near zero means a stale frame was waiting and was thrown away,
near a frame period means the buffer was empty. Bench check: after this change `fbGetUs` on
captures 2..N should read one frame period, not ~0, and `frameAgeUs` should be positive.

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

---

## Synchronization targets

Written 2026-09-03, after the first four-camera measurement (#165). Three
quantities, three targets, three states of validation. They are not
interchangeable and a number from one must never be reported against
another's target.

`packages/kdp/src/protocol/timing.ts` is normative for the vocabulary and for
the exposure bands; this section adds the frame-start row, which nothing in the
repository had defined, and records what has been measured against each.

| | quantity | target | authority | measured |
|---|---|---|---|---|
| **A** | **Trigger distribution** - when the shared `SYNC_OUT` edge reaches each node | 100-400 us | `docs/HARDWARE.md` | **met**: the four nodes act on their commands within **129 us** of each other, and the P4's own dispatch spread is 161 us median, 443 us worst of 100 (#165 baseline) |
| **B** | **Frame-start spread** - when each sensor's returned frame began its readout, against the common edge | **proposed below, not yet accepted** | this section | 46.6 ms median, 105.7 ms p95, 109.7 ms max idle; 20.8 ms median once the whole-frame offset is removed (#165) |
| **C** | **Effective exposure spread** - when the scene was actually recorded, rolling shutter included | < 0.5 ms excellent, < 1 ms very good, < 2 ms usable, 2-5 ms visible on fast subjects, 5-10 ms motion contaminated, **> 10 ms not a synchronized capture** | `gradeSkew()` in `timing.ts`, "the V1 product targets" | **unmeasured and unmeasurable with the present instruments** - no VSYNC observation, no optical common-event rig; `kino.capture`'s three skews stay null with their reason |

### Why B needs its own target

Frame start is the closest quantity this firmware can observe. It is not
exposure: `camera_fb_t.timestamp` is the instant DMA was armed for a frame,
the rolling shutter then integrates each row in turn, and the relationship
between the two is not measured. B is therefore a *proxy* target - useful
because it is measurable today and because it bounds C from below (exposure
cannot be better aligned than frame start), and dangerous if anyone reports it
as C.

### The proposal for B

Two error terms were separated in the baseline and they behave differently:

- **Boundary-index error.** In 32 of 91 four-camera sets, at least one camera
  returned a frame one whole 112.4 ms period later than the others. Remove it
  and the median falls from 46.6 ms to 20.8 ms. It is a scheduling artefact:
  the four commands arrive at slightly different points in four independent
  frame cycles, so some cameras catch boundary *k* and others *k+1*.
- **Inter-sensor phase.** With the boundary index removed, the four sensors'
  frame phases still differ by **20.8 ms median, 52.6 ms p95, 54.5 ms max** -
  roughly a uniform spread over half a period. This is what four free-running
  oscillators do, and no command timing can remove it while the sensor decides
  when its own frame starts.

Proposed, for acceptance:

> **B1 (achievable with command timing alone):** frame-start spread median
> <= 25 ms and p95 <= 55 ms on four cameras, idle. This is the boundary-index
> error removed and nothing else. It is not a synchronization claim; it is
> "no camera is a whole frame out".
>
> **B2 (requires controlling the sensor's frame start):** frame-start spread
> p95 <= 10 ms, which is the point at which C could plausibly enter
> `gradeSkew`'s "motion contaminated" band rather than "not a synchronized
> capture". Not reachable by software timing on this architecture.

B1 is a housekeeping target. B2 is the product one, and the measurement says
plainly that it needs either OV3660 frame-timing register control or a body
whose sensors can be externally triggered - the D3 and D4 rungs of the
roadmap's escalation ladder, not the D1/D2 rungs.

### What this means for the V1 claim

`gradeSkew()` calls anything above 10 ms "not a synchronized capture", and the
measured inter-sensor phase spread is 20.8 ms median and 52.6 ms p95 before
exposure timing is even considered. **On free-running OV3660s at 112.4 ms per
frame, the V1 exposure target is not reachable, and no amount of command-side
scheduling changes that.** The roadmap's Gate C asked exactly this question -
"if that interval is 30 ms the product works; if it is 200 ms the product as
conceived does not exist on this architecture" - and the answer for D4-V1 is
that the interval is 112 ms and the residual spread is a fifth to a half of it.

That is a hardware-and-driver conclusion, reached with the instrument built in
0.4.30/0.4.31 and stated here so no later work quietly re-scopes it.

## Where the next step goes, and what registers can and cannot do

Written after the finder-live baseline of 0.4.37 (100 shutters, viewfinder
live, `firmware/HARDWARE_VALIDATION.md`). Design only: nothing here is
implemented, and nothing here should be implemented without the hardware
decision it depends on.

### The architecture this body is, measured

**SOFTWARE_DISPATCH_ONLY.** Four sensors, each free-running on its own XCLK,
triggered by four independent commands over four UARTs, with one shared
`SYNC_OUT` edge used only as a measuring reference. Three numbers place it:

| term | measured | share of the 112.4 ms period |
|---|---|---|
| command dispatch spread | 212 us median, 412 us max | 0.2-0.4% |
| sensor phase (frame-start spread) | 42.0 ms median, 102.8 ms p95 | 37-91% |
| frame period difference between nodes | 69 us (112,353-112,422 us) | 0.06% per frame |

Dispatch is already two to three orders of magnitude better than the thing that
dominates. That is why the phase-aware scheduler was rejected on replay and why
priming changed nothing: both act on the 0.3% term.

### What the 69 us period difference costs — SUPERSEDED, see "The sensors are rate-locked" below

> **This section was wrong and is kept for the record.** It read the 69 us
> figure as a rate difference between the four sensors and concluded that a
> one-time phase alignment decays in about three minutes. The 69 us was
> measured in the finder-live condition, where the returned frame is chosen by
> preview-pump timing rather than by the sensor's phase, so it is a sampling
> artefact and not a rate. Measuring the sensors against each other directly
> (below) gives **1.6 ppm**, which is 400 times smaller and points at a
> different V2 design. The reasoning that followed from it - that only a shared
> clock can hold phase - does not survive.

The four sensors do not merely start out of phase, they *drift*: 69 us per
frame between the fastest and slowest node. A perfect one-time alignment decays
by a full frame period after

    112,387 us / 69 us = 1,629 frames = about 183 seconds

so any scheme that aligns phase once and then leaves the sensors alone is good
for roughly three minutes.

### The OV3660 registers, and the honest limit of what they can do

**Recommended, and already the case: register parity.** All four sensors are
configured from one driver with one set of frame-timing registers, so total
horizontal and total vertical (`HTS`/`VTS`, `0x380C`-`0x380F`) and the PLL
dividers are identical across the four. The 69 us residual is therefore *not* a
register mismatch and cannot be tuned out by changing them - it is XCLK
tolerance. Nothing to do; the value of stating it is that "align the timing
registers" is the obvious first idea and it is already true.

**Not recommended: chasing phase with `VTS` padding.** `VTS` sets the frame
period, so writing a slightly different `VTS` to a lagging sensor would shift
its phase - a software phase-locked loop with the sensors as the oscillators
and `syncToFrameUs` as the error signal. Against it: the error is only
observable once per capture (a capture is the only time the P4 learns a node's
frame start), the loop would need a per-frame error to be stable, a `VTS` write
takes effect at the next frame boundary with a driver-dependent delay, and a
mid-stream `VTS` change is visible as an exposure step because the AE loop is
referenced to frame time. A control loop whose sample rate is "when the user
presses the shutter" is not a control loop. This is the one idea in this area
that looks affordable in firmware and it should not be built.

**The only register work worth doing is a synchronous restart**, and it is a
mitigation rather than a fix: soft-reset all four sensors from one P4 tick so
their internal counters begin together, bounding the phase error to the reset
skew plus 69 us per frame of drift. Cost: every camera drops a frame and the AE
loop re-converges, so it belongs at the start of a session or before a burst,
never inside one. Expected result, from the drift number above: sub-millisecond
phase immediately after the reset, decaying past 10 ms within about 150 frames
(17 s) and past a full period in three minutes. Worth measuring with the
existing instrument before it is believed, because the reset skew over four
UARTs is exactly the kind of term that turns out to dominate.

### The step that actually attacks the dominant term

**One clock for four sensors.** A single oscillator fanned out to all four
XCLK pins removes the 69 us drift by construction: same clock, same `VTS`, same
period, so a one-time alignment holds indefinitely and the synchronous restart
above becomes a real fix instead of a three-minute mitigation. Combined with
the restart, phase error collapses to reset skew.

This is a **hardware change** - a clock buffer and four routed traces, or four
short flying leads on the bench - and therefore a V2 decision, not a firmware
one. It is the D3/D4 rung the escalation ladder already names. Recorded here
with the number that justifies it so the choice is not re-argued from scratch:
without a common clock, no firmware can hold four OV3660s in phase for longer
than about three minutes, and with one, the residual is a single reset skew.

### What ships in the meantime

Nothing in the sync path, and that is a decision rather than a deferral. The
finder-live condition already gives four fresh frames per shutter with a 42 ms
median spread; `wiggle` playback is 10 fps hard cuts, where 42 ms of
inter-camera time on a static subject is invisible and on a moving one reads as
part of the parallax. The product-visible work is alignment, not
synchronization, and it is not blocked by any of the above.

## The sensors are rate-locked: 1.6 ppm, measured

This supersedes the 69 us reasoning above and changes the V2 recommendation.

### Method

`syncToFrameUs` is each node's own frame start against the ONE shared
`SYNC_OUT` edge. For a single shutter the difference between two cameras,

    d_ij = syncToFrameUs_i - syncToFrameUs_j

is their relative frame phase at that instant, with the edge cancelling. Two
consecutive shutters are about 6 s apart, and at even 600 ppm the relative
phase would move only 3.7 ms between samples - far under half a 112.4 ms
period - so the sequence can be unwrapped and its slope IS the relative rate.
A flat `d_ij` means the sensors are rate-locked and a one-time alignment holds;
a sloped one measures how fast an alignment decays.

The measurement must be taken with the **finder idle**. In the finder-live
condition the returned frame is whichever the preview pump's draining left in
flight, so `nodeFrameStartUs` is quantised by pump timing and the phase signal
is destroyed: fitting that data gives 105-465 ppm with a residual RMS of
47-173 ms, i.e. a straight line through noise. That is where the 69 us came
from. Finder-idle captures return the frame boundary immediately BEFORE the
edge (98% of them), which is a direct phase readout.

### Result, from the 0.4.31 finder-idle run, 99 shutters over 17.6 minutes

| pair | least squares | first half | second half | median pairwise | worst residual |
|---|---|---|---|---|---|
| cam1-cam2 | -1.50 ppm | -1.70 | -1.32 | -1.50 | 243 us |
| cam1-cam3 | +1.58 ppm | +1.44 | +1.65 | +1.58 | 162 us |
| cam1-cam4 | -1.10 ppm | -1.25 | -1.03 | -1.10 | 206 us |
| cam2-cam4 | +0.40 ppm | +0.45 | +0.29 | +0.39 | 135 us |

Split halves agree to within 0.4 ppm, an outlier-proof median-of-pairwise-
slopes estimator reproduces least squares to two decimals, and the worst
residual is 243 us against a 112,387 us period. **The four OV3660s are
rate-locked to within +/-1.6 ppm.**

Why that is credible rather than surprising: each node's XCLK is LEDC-derived
from that node's own PLL at exactly 80/5 = 16 MHz, the four sensors run one
identical register set, and the four crystals are the same part on the same
board at the same temperature. A crystal offset also partly cancels in this
measurement, because a node's `esp_timer` and its sensor's XCLK come from the
same crystal.

### What that means

At 1.6 ppm, a one-time phase alignment decays past

| tolerance | time to exceed it |
|---|---|
| 2 ms | about 21 minutes |
| 10 ms | about 1.7 hours |
| one full frame period (112.4 ms) | about 19 hours |

So **rate drift is not the obstacle, and a shared XCLK is not necessary to
hold phase.** The obstacle is that nothing has ever ALIGNED the phases: each
sensor's phase is set by whenever its own `esp_camera_init()` happened to start
streaming after that node booted, and it then holds that offset for hours. In
the run measured, those fixed offsets happened to be spread across about 86 ms
of the 112.4 ms period, which is exactly why the finder-idle spread was 85.9 ms
median with a narrow 47-101 ms range: a stable spread, not a wandering one.

Phase alignment is therefore a **one-shot problem, not a control problem** -
which is also why every rejected idea in this document (phase-aware
scheduling, static delays, VTS chasing, a shutter-sampled loop) was the wrong
shape. They all tried to track something that does not move.

### The residual risk this measurement does not cover

Temperature. Crystal frequency moves tens of ppm across a full temperature
range, and the four sensors do not sit at the same temperature under load. The
17.6 minutes measured here were at thermal steady state on a bench. A V2 gate
must re-measure after a cold start and under sustained capture load; if
relative rate moves to tens of ppm when warm, the 2 ms budget shrinks from
21 minutes to under a minute and a periodic re-alignment becomes necessary.
That is a measurement, not a guess to make now.

## V2: align the phase once, on the edge that is already wired

> **Mechanism revised.** This section proposed reaching the sensor over SCCB
> from the sync ISR, because at the time the only known controls were
> `0x3008`'s reset and standby bits. The V2-A audit below found that the
> OV3660 has a dedicated frame-sync input (`FSIN`, pin E3, enabled by
> `0x3835[0]`), which does the same job by design and takes the SCCB write
> out of the critical path. The sequence and the skew reasoning here still
> stand as the fallback if FSIN turns out to be unreachable on the module;
> read them together with "The OV3660 has a frame-sync input" at the end of
> this document.

With rate drift measured at 1.6 ppm, the V2 problem is not "hold the sensors
together" but "put them together once". That changes the recommendation from a
board change to a firmware mechanism on hardware that already exists.

### What is already in place and proven

```
P4 GPIO32 SYNC_OUT ──┬──> node1 GPIO2 SYNC_IN
   (200 us pulse in  ├──> node2 GPIO2
    capture_fire)    ├──> node3 GPIO2
                     └──> node4 GPIO2      common ground, one 28 AWG branch each
```

Measured: 1000 pulses, 1000/1000 accepted on all four nodes with raw counts
also exactly 1000, zero rejected, timestamps monotonic. Each node already runs
an `IRAM_ATTR` rising-edge ISR that timestamps and counts, with a 10 ms dead
time. The distribution network for a simultaneous instruction to four sensors
is therefore built, tested, and currently used only for measurement.

### The proposed sequence

1. P4 sends a new `NL_CMD_ALIGN` to all four nodes. Nothing time-critical:
   each node simply arms a flag. Command skew between nodes is irrelevant
   because no node acts on receipt.
2. P4 fires one `SYNC_OUT` pulse.
3. Each node's existing sync ISR sees the edge and releases a high-priority
   task that performs the sensor phase reset.
4. All four sensors restart their frame timing from the same physical instant.
   The residual skew is the spread of (ISR release + SCCB transaction + sensor
   response), NOT the spread of four UART commands.
5. Normal grouped capture resumes. `SYNC_OUT` keeps its measurement role, so
   the same instrument that found the problem verifies the fix.

The point of moving the action onto the edge is that it replaces the one term
that cannot be made small - four independent UART commands, measured at 212 us
median and 412 us worst - with terms that can.

### Skew budget, honestly labelled

| term | estimate | basis |
|---|---|---|
| sync ISR to task release | single-digit us | existing ISR is IRAM_ATTR and does two stores |
| SCCB write of the restart register | 70 us at 400 kHz, 270 us at 100 kHz for a 3-byte write | I2C arithmetic; the driver's SCCB rate should be read before this is trusted |
| **variation** of the above between nodes | tens of us | same code, same clock, same instant |
| sensor response to the restart | **UNKNOWN** | not in the driver source; needs the OV3660 datasheet and a bench measurement |

The first three are small and knowable. The fourth is the whole risk, and it is
the one thing no amount of firmware design settles - if the OV3660's restart
latency varies by milliseconds part to part, this approach caps out there.

### The OV3660 controls that exist, from the driver source

Read out of `managed_components/espressif__esp32-camera` (pinned 2.1.7), not
from the datasheet, which this repository does not hold:

- `SYSTEM_CTROL0` is register **0x3008**, and its header comment documents
  **bit 7 as software reset**. The driver's `reset()` writes `0x82`, waits
  100 ms, reloads `sensor_default_regs`, sets AE level, waits another 100 ms.
  So a full software reset is available but costs >200 ms and discards every
  setting, which the node would then have to re-apply.
- Bit 6 of the same register is **software standby** on this sensor family, and
  a standby exit is the cheaper way to restart streaming. **The header does not
  document bit 6, so this is inference and must be confirmed against the
  datasheet before it is designed in.**
- `sensor->set_reg(sensor, reg, mask, value)` and `get_reg()` are exposed in
  `sensor.h` and implemented by `ov3660.c`, so a node can drive any register
  without patching the pinned component. This is what makes the mechanism a
  node-firmware change rather than a fork.
- `set_res_raw()` exposes `totalX`/`totalY` (`HTS`/`VTS`, 0x380c-0x380f)
  directly. That is the handle a VTS phase-chaser would use, and it stays
  unused: see the rejection above, and note that at 1.6 ppm there is nothing
  for a tracking loop to track.
- There is **no hardware reset or power-down line**: `camera.c` initialises
  with `pin_pwdn = -1` and `pin_reset = -1`. A simultaneous hardware reset of
  four sensors is not available without a wiring change, which is why the
  restart has to go over SCCB.

### Why this is preferred over a shared XCLK as the first V2 step

A shared XCLK removes rate error. Rate error is measured at 1.6 ppm and costs
2 ms of alignment every 21 minutes, so removing it buys very little. It also
does not align phase at all - the brief's own section 8 is right about that.
Against that small benefit:

- On the XIAO ESP32-S3 Sense the XCLK is generated **inside the module** by the
  LEDC peripheral on GPIO10 and routed to the camera FPC on the module itself.
  There is no exposed XCLK input. Sharing a clock means either cutting or
  contending with GPIO10's net on four modules, or abandoning the Sense camera
  connector for a custom sensor carrier.
- Four OV3660 XCLK inputs plus routing is a real load at 16 MHz and would want
  a fan-out buffer rather than one GPIO, which is a board change.

So: shared XCLK is a **V2+ option that becomes necessary only if** the measured
relative rate rises materially when warm, or if the SCCB restart turns out to
be non-deterministic. Both are measurements that come first.

### Validation gates for the phase-alignment prototype

| gate | what it proves | how |
|---|---|---|
| **V2-A** | the sensor can be restarted at all over SCCB without a full reset | one node, one register write, frame timing observed to restart |
| **V2-B** | restart latency and its part-to-part variation | one node at a time, edge to first new frame start, 100 repeats |
| **V2-C** | four sensors align on one edge | `syncToFrameUs` spread immediately after an aligned restart, finder idle |
| **V2-D** | the alignment holds | spread at +0 s, +1 min, +5 min, +30 min, cold start and warm |
| **V2-E** | freshness survives it | finder-live capture correctness unchanged, `frameBeforeEdge` still 0% |
| **V2-F** | nothing else regressed | Roll, offline hold, automatic upload, transport error rates |
| **V2-G** | the product target | optical measurement of effective exposure, not frame start |

Only V2-G speaks to `gradeSkew()`. Everything above it measures frame start,
which is what `camera_fb_t.timestamp` can see and no more.

### The optical test, when it comes

`camera_fb_t.timestamp` is the DMA arm - frame start - and the product target
is effective exposure. Nothing measured in V1 or proposed in V2-A..F closes
that gap. The eventual test needs one light event visible to all four sensors
simultaneously, or a moving target with known velocity, so that relative
exposure can be inferred from the images themselves rather than from
timestamps. FLASH_EN is the natural source and it is physically disconnected;
that stays deferred until the timing architecture is chosen, so no flash work
is implied by any of the above.

## Freshness currently depends on the viewfinder, and it should not

### The measured fact

| condition | frames whose exposure started BEFORE the shutter's own sync edge |
|---|---|
| finder live (0.4.30, 0.4.37) | **0 of 391 and 0 of 397** |
| finder idle (0.4.31) | **385 of 393 (98%)** |

A photograph that predates the shutter by up to a frame period is a capture
correctness defect, not a synchronization one - the same class as the original
134-second stale frame at the top of this document, smaller in magnitude.

### Why, exactly

The sensor streams continuously from `esp_camera_init()` with `fb_count = 2` and
`CAMERA_GRAB_LATEST`; `cam_hal.c` sizes the frame queue to `fb_count - 1`, so
one completed frame can wait while DMA fills the other buffer. Nothing about
that depends on the UI.

What depends on the UI is whether that one-deep queue is EMPTY when the shutter
fires:

- **Finder live.** The P4's preview pump has been draining the queue at about
  13 fps, so at shutter time it is usually empty. `camsensor_discard_queued()`
  finds nothing to drop and returns immediately, and `esp_camera_fb_get()` then
  blocks until the next frame completes - a frame that was armed after the
  command. Fresh.
- **Finder idle.** Nothing has drained the queue since the previous capture, so
  it holds one completed frame. `discard_queued()` drops that one, and
  `fb_get()` returns the next frame to complete - which was already in flight
  in the other buffer when the discard ran, so it was armed before the command.
  Stale by up to a frame period.

One discard is one frame short of a guarantee, and the missing frame is
supplied, incidentally, by the preview pump. So the product invariant today is
really: **normal photography is only fresh because the UI happens to be
streaming previews.** That is a coupling nobody chose and nothing enforces.

### Recommendation, design only

Do **not** introduce a `CAM_STREAM_ACTIVE` product state to fix this. The
sensor is already streaming unconditionally; a new state would describe
something that is always true and would still leave freshness resting on a
side effect.

Put the guarantee where the requirement is - in the node's capture predicate.
`node_server.c` already has exactly this pattern for a different reason: after
an encoding change it releases and re-fetches while
`timing.frame_start_us <= camsensor_encoding_changed_us()`, bounded at three
retries. The change is to widen that reference instant to include the command:

```c
const int64_t must_start_after = MAX(camsensor_encoding_changed_us(), cmd_us);
for (int retry = 0; retry < 3 && fb != NULL &&
                    timing.frame_start_us <= must_start_after; retry++) {
  camsensor_release(fb);
  fb = camsensor_capture(&duration_ms, &timing);
}
```

Properties worth having:

- Freshness becomes a property of the capture path, true whether or not any UI
  is running, and stated in one predicate rather than implied by a pump.
- The cost is paid only when the frame really was stale: nothing in the
  finder-live case, one extra frame period (~112 ms) in the finder-idle case.
  Today that case silently returns the wrong instant instead.
- Previews keep skipping it, as they already do.
- The bound stays at three retries, so a sensor that never produces a fresh
  frame fails rather than blocking the node.

Not implemented here: it is a node-firmware change, the nodes are on 0.4.31 and
deliberately untouched through the current work, and it wants its own bench run
(finder idle, 100 captures, expect `frameBeforeEdge` to go from 98% to 0% and
per-set total to rise by about a frame period). It is a correctness fix rather
than a synchronization one, and it does not depend on any V2 decision.

## V2-A: the sensor restart audit, against the datasheet

Source: *OV3660 color CMOS QSXGA (3 megapixel) image sensor with OmniBSI
technology*, PRELIMINARY SPECIFICATION version 1.3, 05.13.2011, OmniVision.
Obtained for this audit; proprietary, so it is cited by section and not
committed.

### What 0x3008 actually is

The register table (section 2.9, table 2-6) and the pinned driver's
`ov3660_regs.h` agree:

```
0x3008  SYSTEM CTROL0  default 0x02  RW
        Bit[7]: Software reset
        Bit[6]: Software power down
        Bit[5]: Reserved
        Bit[4]: SRB clock SYNC enable
        Bit[3]: Isolation suspend select
        Bit[2:0]: Not used
```

The **default is 0x02**, so the correct writes are `0x42` to enter software
power down and `0x02` to leave it - not `0x40` and `0x00`. The driver's
`reset()` writing `0x82` is bit 7 over that same default, which is consistent.

### The two suspend modes, and why the difference decides this gate

Section 2.6, verbatim:

> **2.6.1 hardware standby** - To initiate a hardware standby, the PWDN pin
> (pin F6) must be tied to high. When this occurs, the OV3660 internal device
> clock is halted and **all internal counters are reset** and registers are
> maintained. Majority of the digital circuitry will remain in the power-cut
> state.
>
> **2.6.2 software standby** - Executing a software standby through the SCCB
> interface suspends internal circuit activity but does not halt the device
> clock. **All register content is maintained in standby mode.**

So software standby is documented to be cheap and to preserve configuration -
both properties this experiment wanted. It is **not** documented to reset the
internal counters, and the datasheet states counter reset only for *hardware*
standby. Since re-phasing the frame timing is the entire purpose of the
primitive, its central property is unsupported, and the asymmetry between those
two paragraphs is evidence against it rather than mere silence.

Section 2.5 also corrects a figure this study has been quoting: a software reset
via `0x3008[7]` "clears all registers and resets them to their default values"
and "requires ~2ms settling time". The >200 ms cost is the esp32-camera driver's
own choice - two 100 ms delays plus a full `sensor_default_regs` reload - not a
sensor requirement. Reset still destroys configuration, so it remains unusable
as a phase primitive whatever it costs.

### Verdict

**V2-A SENSOR RESTART NOT PROVEN.** The register and the bit are authoritative;
the re-phasing behaviour is not documented, so nothing was written to any
sensor. Missing documentation, precisely: whether `0x3008[6]` entry and exit
reset the frame timing counters, what the minimum standby dwell is, how many
frames the stream takes to resume, and whether AE and AWB re-converge. None of
that is in the datasheet, the pinned driver, or this repository. It is
answerable only by measurement - and the mechanism below makes that measurement
unnecessary.

## The OV3660 has a frame-sync input, and that changes the V2 mechanism

Found in the same audit and not previously known to this project.

### The evidence

- **Pin E3 is `FSIN`, "frame sync", I/O** (section 1, table 1-1 signal
  descriptions, and block diagram figure 2-1, where FSIN enters the "timing
  generator and system control logic" alongside XVCLK, RESETB and PWDN).
- Table 1-2, configuration under various conditions: FSIN is **"input by
  default (configurable)"** after reset release.
- Direction: `0x3016 PAD OUTPUT ENABLE 00`, default `0x22`, "Bit[2]: FSIN
  output enable (0: input; 1: output)". The default leaves bit 2 clear, so
  **FSIN is an input out of reset**.
- Function (section 7, table 7-8 timing control registers):

```
0x3835  TIMING TC REG35  0x00  RW   Bit[1]: FSIN reverse
                                    Bit[0]: FSIN enable
0x3836  TIMING TC REG36  0x00  RW   Bit[3:0]: FSIN output width
```

`0x3835[0]` enables it and `0x3835[1]` selects polarity. `0x3836` giving an
FSIN **output** width, together with `0x3016[2]` selecting output, means the
part can also *drive* FSIN - so a master/slave chain of sensors is a documented
configuration, not only a slave-to-external-signal one.

### Why this is the right mechanism

It is purpose-built for what V2 needs: an external edge that aligns the
sensor's frame timing.

| mechanism | aligns phase | keeps config | cost | documented |
|---|---|---|---|---|
| `0x3008[7]` software reset | probably, via full reset | **no** | ~2 ms per datasheet, >200 ms as the driver does it | yes |
| `0x3008[6]` software standby | **not documented** | yes | cheap | partly |
| **FSIN + `0x3835[0]`** | **yes, by design** | yes | one edge | **yes** |

And the edge already exists: `SYNC_OUT` on P4 GPIO32 / JP1 pin 19, fanned to
all four nodes, measured at 1000/1000 accepted with zero rejected. The
distribution network for four-sensor frame sync is built and proven. What is
missing is the last few centimetres to each sensor's FSIN pad.

### The one blocking question, and it is hardware

**Is FSIN routed to the camera module's FPC?** Unresolved, and it decides
everything:

- The standard 24-pin DVP camera FPC carries power, SCCB, XVCLK, PCLK, VSYNC,
  HREF, D[9:2], PWDN and RESETB. **FSIN is not normally among them**, and it is
  not in this repository's own DVP record either - `docs/HARDWARE.md` and
  `packages/hardware-profiles/src/profiles/d4-v1.json` record
  `"interface": "DVP"` with no per-signal list.
- The datasheet's reference schematic (figure 2-2) does bring FSIN out as a net
  at the sensor, so whether it reaches the connector was decided by whoever
  designed the XIAO Sense camera module, not by OmniVision.
- Seeed publishes no FPC signal list that resolves it.

The next action is therefore a **physical check on one camera module**:
continuity from the sensor's E3 pad to the FPC, or the module vendor's
schematic. Three outcomes:

1. **FSIN is on the FPC** - V2 needs four short wires from JP1 pin 19 and two
   register writes per node. No board respin, no clock work, and `SYNC_OUT`
   keeps its measuring role exactly as the V2 sketch wanted.
2. **FSIN is not on the FPC but is accessible on the module** - fine-pitch
   rework on four modules. Unattractive but bounded.
3. **FSIN is unreachable** - then the sensor carrier is the thing to change,
   and that is the point at which a custom board is justified. A shared XCLK
   comes along for free on such a board, which is the right time to take it
   rather than now.

What this does not change: PWDN is also unavailable today (`pin_pwdn = -1`),
and hardware standby is the only documented way to reset the counters short of
a full reset. **If the module exposes PWDN on the FPC but not FSIN, hardware
standby becomes a second candidate worth measuring** - it halts the clock,
resets the counters and keeps the registers, which is exactly the primitive
V2-A went looking for and did not find in software.

### SCCB, from configuration rather than estimate

- Bus clock **100 kHz**: `CONFIG_SCCB_CLK_FREQ=100000`, read from the node's
  own resolved `sdkconfig` and `build/config/sdkconfig.h`, not from the Kconfig
  default. The Kconfig range allows up to 400 kHz.
- A register write is 16-bit addressed - device address, register high,
  register low, data: four bytes, 36 bit-times plus start and stop, so **about
  380 us at 100 kHz** and about 95 us at 400 kHz.
- Each node drives its **own** I2C controller (`sccb.c`, one port per node's
  ESP32-S3), so four nodes' writes are genuinely parallel and are not
  serialised through the P4. That was the property the common-edge architecture
  needed, and it holds.

That 380 us matters for a corrected reason. With FSIN the SCCB write is
*setup* - done once, well before the edge - and the edge itself carries the
timing. The write leaves the critical path entirely, which is why FSIN is a
better architecture and not merely a different one.
