#include "viewfinder.h"

#include <stdatomic.h>
#include <string.h>

#include "cam_link.h"
#include "config_store.h"
#include "driver/jpeg_decode.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "taskmon.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "klog.h"

static const char *TAG = "viewfinder";

/* 320x240 at quality 18. Quality is looser than a capture's 12 because these
 * bytes are crossing a UART several times a second and will never be stored -
 * a viewfinder frame exists to be looked at once and thrown away. */
#define VF_RESOLUTION "320x240"
/* 30, not 18. Sensor scale, where HIGHER is more compressed.
 *
 * The finder is throughput-bound, not sensor-bound: a capture measured 44629 B
 * transferred in 1389 ms, 32.1 KB/s against a 921600 baud line's 92.2 KB/s, so
 * 68% of a frame's cost is moving it and the preview's frame rate is very
 * nearly its file size. Compressing the preview harder is the one lever that
 * does not touch the transfer path, which has an unresolved defect on large
 * frames and is the wrong thing to build on today.
 *
 * A preview exists to judge framing and focus and is thrown away; the
 * photograph keeps its own quality setting and is unaffected. */
#define VF_QUALITY 30

/*
 * What shoot.previewQuality is, in the only unit the node understands.
 *
 * The setting was stored and never read (issue #144). These are the three
 * values it now selects, and the trade they buy is the arithmetic already
 * written above: at 921600 baud the line carries 92160 B/s, transfer is 68%
 * of a preview frame's cost, and the frame rate is very nearly the reciprocal
 * of the file size. So a frame of B bytes spends B/92160 seconds on the wire
 * whatever the sensor did to produce it, and the whole lever this setting has
 * is B.
 *
 * The resolution stays 320x240 on all three. It is not a free parameter: the
 * tiles, the staging buffers and the pane blit are all VF_W x VF_H, and a
 * 160x120 frame would decode into a quarter of a tile. Quality is the one
 * knob that changes the byte count without changing anything downstream.
 *
 * NOT MEASURED PER STEP on the bench yet. The reference point is the one
 * figure that has been measured - 44629 B in 1389 ms, 32.1 KB/s achieved -
 * and the per-frame klog line below prints bytes, transfer ms and fps for
 * every camera every 5 s, which is where the three settings get their real
 * numbers. Expect LOW to roughly halve the bytes of NORMAL and HIGH to
 * roughly double them; confirm against that line before quoting figures.
 */
#define VF_QUALITY_LOW 45
#define VF_QUALITY_NORMAL VF_QUALITY
#define VF_QUALITY_HIGH 18

/* A QVGA JPEG at this quality measures a few KB; this is generous headroom so
 * a busy frame is never truncated into a decode failure. */
#define VF_MAX_JPEG (24 * 1024)

/* Older than this and a pane stops claiming to be live. */
#define VF_STALE_MS 2000


/* VF_CAPTURE_TIMEOUT_MS and VF_READ_TIMEOUT_MS moved to viewfinder.h: a
 * capture's viewfinder_hold() timeout is arithmetic on them (VF_HOLD_MS) and
 * has to be derived from the same numbers rather than guessed beside them. */

static uint16_t *s_tile[4];
static uint8_t *s_jpeg[4];
static jpeg_decoder_handle_t s_decoder;
static SemaphoreHandle_t s_decode_lock;
static vf_status_t s_status[4];
static int64_t s_last_frame_us[4];
static int64_t s_report_us[4]; /* throttles the per-frame timing line below */
static bool s_ready;
static volatile bool s_want_run; /* what the UI asked for */
static atomic_int s_holds;       /* outstanding viewfinder_hold() calls */
/* Pumps currently inside pump_camera(). viewfinder_hold() waits for zero.
 *
 * Atomic, not volatile. Four camera tasks increment and decrement this, and
 * they are created unpinned on a dual-core part, so two of them can execute
 * the load-add-store at the same instant; `volatile int` only stops the
 * compiler caching it. A lost increment lets hold() return while a pump is
 * still on the wire, which is the BAD_ID mid-transfer this counter exists to
 * prevent. A lost decrement leaves it stuck above zero, so every hold waits
 * out its full VF_HOLD_MS and then captures anyway - the same hazard plus a
 * 3.3 s shutter lag. */
static atomic_int s_pumping;
/* Tiles are frozen until this time; see viewfinder_review(). */
static volatile int64_t s_review_until_us;
/* The sensor quality the four pump tasks ask for. Read from the config, not a
 * constant; see vf_read_quality(). */
static volatile int s_quality = VF_QUALITY_NORMAL;

/**
 * Take shoot.previewQuality off the config.
 *
 * Called at init and on every off->on edge of viewfinder_run(), which is the
 * cheapest hook there is: the UI already calls viewfinder_run() every pass
 * with (screen == SHOOT), so the edge is exactly "the SHOOT screen just became
 * active" and costs one config read per visit rather than one per frame.
 * Changing the setting in Studio and going back to the finder therefore
 * applies it without a reboot.
 */
static void vf_read_quality(void) {
  char want[16];
  config_str_copy("shoot.previewQuality", want, sizeof want);
  int q = VF_QUALITY_NORMAL;
  if (strcmp(want, "low") == 0) q = VF_QUALITY_LOW;
  else if (strcmp(want, "high") == 0) q = VF_QUALITY_HIGH;
  if (q != s_quality) {
    klog("P4", "vf quality %d -> %d (%s)", s_quality, q, want[0] ? want : "normal");
  }
  s_quality = q;
}

bool viewfinder_ready(void) { return s_ready; }
/*
 * What the UI wants, which is not the same as what the finder may do.
 *
 * ui_task calls this every pass with (s_screen == SCR_SHOOT), so a hold that
 * lived in the same variable was overwritten within microseconds of being
 * taken. That is why viewfinder_hold() never demonstrably worked: a capture
 * parked the finder, the next UI pass restarted it, and the two then fought
 * over the same channel and the same node frame - the capture's chunk reads
 * interleaved with preview reads on cam1, at the finder's 600 ms timeout
 * rather than the capture's, and the transfer died.
 *
 * The wish and the veto are now separate. Only a matching release lifts a
 * hold, and viewfinder_run can be called as often as the UI likes without
 * being able to break one.
 */
void viewfinder_run(bool on) {
  /* The rising edge only. This is called every UI pass, and re-reading the
   * config on all of them would put a mutex take and a dotted-path walk in
   * the finder's hot path for a value that can only change while the SHOOT
   * screen is not up. */
  if (on && !s_want_run) vf_read_quality();
  s_want_run = on;
}

/** The finder may pump only if the UI wants it and nothing is holding it. */
static bool vf_may_run(void) {
  return s_want_run && atomic_load(&s_holds) == 0;
}

bool viewfinder_hold(uint32_t timeout_ms) {
  const bool was = s_want_run;
  atomic_fetch_add(&s_holds, 1);
  /* Wait out any pump already talking to a node. Without this the capture
   * races the very frame it is about to invalidate. */
  const int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
  while (atomic_load(&s_pumping) > 0 && esp_timer_get_time() < deadline) {
    /* One tick, not 5 ms: at 100 Hz pdMS_TO_TICKS(5) is zero ticks and this
     * wait would spin at the caller's priority against the very pump task it
     * is waiting for. */
    vTaskDelay(1);
  }
  const uint32_t waited = (uint32_t)((esp_timer_get_time() - (deadline - (int64_t)timeout_ms * 1000)) / 1000);
  const int still = atomic_load(&s_pumping);
  if (still > 0) {
    klog("P4", "vf hold TIMED OUT after %lums, %d still pumping - capturing anyway",
         (unsigned long)waited, still);
  } else if (was) {
    klog("P4", "vf held in %lums", (unsigned long)waited);
  }
  return was;
}

void viewfinder_release(bool was_running) {
  (void)was_running; /* The UI's wish was never overwritten, so nothing to put back. */
  /*
   * Decrement first, then repair, because the obvious guard is a bug.
   *
   * "if (load() > 0) fetch_sub()" is a check and an act that are separately
   * atomic and jointly are not: two releases that both observe 1 both
   * decrement and leave -1. vf_may_run() tests for exactly 0, and the guard
   * then stops any later release from bringing a negative value back up, so
   * the finder is off until the board is rebooted - which is precisely the
   * "preview got stuck" this replaced a self-healing design with.
   *
   * The old absolute assignment recovered by accident on the UI's next
   * viewfinder_run(); nothing replaced that, so the repair is explicit and
   * loud. An underflow means a release without a hold, which is a real bug
   * worth seeing rather than silently absorbing.
   */
  const int prev = atomic_fetch_sub(&s_holds, 1);
  if (prev <= 0) {
    atomic_store(&s_holds, 0);
    klog("P4", "vf release with no hold outstanding (was %d) - counter reset", prev);
  }
}

void viewfinder_review(uint32_t ms) {
  s_review_until_us = esp_timer_get_time() + (int64_t)ms * 1000;
}

const uint16_t *viewfinder_tile(int cam) {
  if (!s_ready || cam < 0 || cam > 3) return NULL;
  return s_status[cam].frames > 0 ? s_tile[cam] : NULL;
}

uint32_t viewfinder_fps_x10(int cam) {
  if (!s_ready || cam < 0 || cam > 3) return 0;
  return s_status[cam].fps_x10;
}

void viewfinder_status(int cam, vf_status_t *out) {
  if (out == NULL) return;
  if (!s_ready || cam < 0 || cam > 3) {
    memset(out, 0, sizeof *out);
    return;
  }
  *out = s_status[cam];
  if (s_status[cam].frames > 0) {
    const uint32_t age = (uint32_t)((esp_timer_get_time() - s_last_frame_us[cam]) / 1000);
    out->last_ms = age;
    if (out->state == VF_LIVE && age > VF_STALE_MS) out->state = VF_STALLED;
  }
}

/**
 * Pull one frame from a node and decode it into that camera's tile.
 *
 * capture -> read -> release, which is the only shape the node link offers:
 * there is no streaming command, so a viewfinder is a capture loop run at a
 * frame size small enough to afford it.
 */
static bool pump_camera(int cam) {
  camlink_capture_result_t res;
  /* The capture request is the sensor actually taking a picture, and the first
   * round of instrumentation left it out - which hid three quarters of the
   * frame period. It is timed here because it is the only part of a preview
   * frame whose cost depends on what the lens is pointed at. */
  const int64_t cap_start_us = esp_timer_get_time();
  if (camlink_capture_ch(cam, VF_RESOLUTION, s_quality, VF_CAPTURE_TIMEOUT_MS, &res) !=
      ESP_OK) {
    s_status[cam].state = VF_NO_LINK;
    return false;
  }
  if (res.size == 0 || res.size > VF_MAX_JPEG) {
    camlink_release_ch(cam, res.frame_id);
    s_status[cam].state = VF_ERROR;
    return false;
  }

  const int64_t cap_us = esp_timer_get_time() - cap_start_us;
  const int64_t xfer_start_us = esp_timer_get_time();
  size_t got_total = 0;
  while (got_total < res.size) {
    size_t got = 0;
    const size_t want = res.size - got_total;
    if (camlink_read_ch(cam, res.frame_id, got_total, s_jpeg[cam] + got_total, want,
                        VF_READ_TIMEOUT_MS, &got) != ESP_OK ||
        got == 0) {
      break;
    }
    got_total += got;
  }
  const int64_t xfer_us = esp_timer_get_time() - xfer_start_us;
  camlink_release_ch(cam, res.frame_id);

  if (got_total != res.size) {
    s_status[cam].state = VF_ERROR;
    return false;
  }

  jpeg_decode_cfg_t cfg = {
      .output_format = JPEG_DECODE_OUT_FORMAT_RGB565,
        /* BGR, which in this enum means LITTLE endian, not blue-first. ESP-IDF:
   *
   *   "Enumeration for jpeg big/small endian output."
   *   JPEG_DEC_RGB_ELEMENT_ORDER_BGR  "the color component in small endian"
   *   JPEG_DEC_RGB_ELEMENT_ORDER_RGB  "the color component in big endian"
   *
   * The name reads like a channel swap and is a byte swap. With _RGB the
   * decoder wrote big-endian RGB565 into a pipeline that is little-endian
   * everywhere else - the panel is LCD_COLOR_PIXEL_FORMAT_RGB565 with
   * LCD_RGB_ELEMENT_ORDER_RGB, the PPA is PPA_SRM_COLOR_MODE_RGB565 and
   * every UI draw is a native uint16_t. Swapping the two bytes of an
   * RGB565 pixel moves the green LSBs into red and the red MSBs into
   * blue, so smooth gradients came out as hard rainbow contours over
   * correct geometry. The stored JPEG was always fine; only the screen
   * was wrong. */
      .rgb_order = JPEG_DEC_RGB_ELEMENT_ORDER_BGR,
  };
  uint32_t out_size = 0;
  /* One engine, four producers: the decode itself is serialised even though
   * the four transfers are not. That is the right way round - a QVGA decode
   * is a fraction of a millisecond in hardware, while a transfer is tens of
   * milliseconds, so the link is what the frame rate is made of. */
  const int64_t dec_start_us = esp_timer_get_time();
  xSemaphoreTake(s_decode_lock, portMAX_DELAY);
  const esp_err_t err = jpeg_decoder_process(s_decoder, &cfg, s_jpeg[cam], got_total,
                                             (uint8_t *)s_tile[cam],
                                             (uint32_t)(VF_W * VF_H * sizeof(uint16_t)),
                                             &out_size);
  xSemaphoreGive(s_decode_lock);
  if (err != ESP_OK) {
    s_status[cam].state = VF_ERROR;
    return false;
  }

  const int64_t now = esp_timer_get_time();
  if (s_status[cam].frames > 0) {
    const int64_t dt = now - s_last_frame_us[cam];
    if (dt > 0) {
      const uint32_t inst = (uint32_t)(10000000 / dt);
      /* Smoothed, because the headline number for a viewfinder is whether it
       * is usable, and a figure that jumps every frame answers nothing. */
      s_status[cam].fps_x10 = s_status[cam].fps_x10
                                  ? (s_status[cam].fps_x10 * 3 + inst) / 4
                                  : inst;
    }
  }
  s_last_frame_us[cam] = now;
  s_status[cam].frames++;
  s_status[cam].bytes = res.size;
  s_status[cam].state = VF_LIVE;

  /*
   * Where a preview frame's time actually goes, once a second per camera.
   *
   * A JPEG is as big as the scene is detailed, so moving in front of the lens
   * makes every frame bigger, and at a fixed 921600 baud - 92 KB/s once the
   * start and stop bits are paid for - a bigger frame is a slower frame. That
   * turns scene motion into a varying frame interval, which is seen as stutter
   * even when the average rate is fine. These three numbers say whether the
   * wire is the reason: bytes against xfer ms is the achieved line rate, and
   * dec ms says whether the decoder is a factor at all.
   */
  const int64_t dec_us = esp_timer_get_time() - dec_start_us;
  if (now - s_report_us[cam] >= 5000000) { /* 5 s: four cameras at 1 Hz drowns the ring */
    s_report_us[cam] = now;
    klog("P4", "cam%d vf %uB cap %ums xfer %ums dec %ums %u.%u fps", cam + 1,
         (unsigned)res.size, (unsigned)(cap_us / 1000), (unsigned)(xfer_us / 1000),
         (unsigned)(dec_us / 1000), (unsigned)(s_status[cam].fps_x10 / 10),
         (unsigned)(s_status[cam].fps_x10 % 10));
  }
  return true;
}

/**
 * One task per camera, and that is the entire reason this is a viewfinder.
 *
 * Pumped in a single loop, four cameras take four transfers back to back and
 * the panes update at a quarter of the rate one camera manages. Each node has
 * its own UART and its own channel mutex in cam_link, so four tasks put four
 * transfers on the wire at once and the slowest node sets the pace instead of
 * the sum of all four.
 */
static void camera_task(void *arg) {
  const int cam = (int)(intptr_t)arg;
  bool announced = false;
  int miss = 0; /* consecutive failures, for the backoff below */
  for (;;) {
    /*
     * Claim the slot BEFORE testing whether we may run, because the reverse
     * order is a check-then-act race and it cost a bench cycle: a task that
     * had already passed the may-run test would pump AFTER hold() had seen
     * s_pumping == 0 and returned, and the capture it was protecting still
     * lost its frame. Claiming first means hold() either sees the claim and
     * waits, or clears the flag before the claim and we back out here.
     */
    atomic_fetch_add(&s_pumping, 1);
    const bool may_pump =
        vf_may_run() && esp_timer_get_time() >= s_review_until_us;
    if (!may_pump) {
      atomic_fetch_sub(&s_pumping, 1);
      /* Being held is not the camera failing. Without this the finder came
       * back from every capture already deep in the absent-camera backoff. */
      miss = 0;
      /* Idle at 100 ms when stopped, 20 ms while reviewing, so live resumes
       * promptly when the review window closes. */
      vTaskDelay(pdMS_TO_TICKS(vf_may_run() ? 20 : 100));
      continue;
    }
    const bool ok = pump_camera(cam);
    atomic_fetch_sub(&s_pumping, 1);
    if (ok && !announced) {
      announced = true;
      klog("P4", "cam%d viewfinder live", cam + 1);
    }
    if (!ok) {
      announced = false;
      /*
       * Back off hard on a camera that is not there, and harder the longer it
       * stays away. An absent node costs VF_CAPTURE_TIMEOUT_MS before it fails,
       * so at a flat 500 ms retry three empty channels churned the link and the
       * scheduler continuously while the one fitted camera was trying to run a
       * viewfinder - which is felt as stutter on the camera that IS there.
       *
       * Capped so that plugging a node in still feels immediate rather than
       * requiring a reboot.
       */
      if (miss < 8) miss++;
      /*
       * Retry fast the first couple of times, slowly only once the camera
       * looks genuinely absent.
       *
       * A flat 500 ms was written for a channel with nothing on it. Applied to
       * a fitted camera it is an amplifier: about one preview read in six now
       * loses bytes to a UART overrun, and each one cost 600 ms of read
       * timeout plus 500 ms of this - over a second of dead screen for a
       * single dropped frame. Measured on the bench as a rate that decayed
       * from 4.8 fps to 0.9 and recovered, over and over, while the per-frame
       * work stayed at 60 ms.
       *
       * A camera that answered moments ago is not missing, it dropped a frame.
       * Two quick retries cost almost nothing and recover it invisibly; the
       * long backoff still arrives for a channel that really is empty.
       */
      static const uint16_t backoff_ms[] = {0, 40, 120, 300, 500, 900, 1500, 2500, 2500};
      vTaskDelay(pdMS_TO_TICKS(backoff_ms[miss]));
    } else {
      miss = 0;
      /* One tick between frames. Not a rate cap - the finder is free to run as
       * fast as the link allows - just a guaranteed yield, so a fast camera can
       * never monopolise the core against the UI task that feeds the panel. */
      vTaskDelay(1);
    }
  }
}

esp_err_t viewfinder_init(void) {
  if (s_ready) return ESP_OK;

  for (int i = 0; i < 4; i++) {
    s_tile[i] = heap_caps_aligned_calloc(64, 1, (size_t)VF_W * VF_H * sizeof(uint16_t),
                                         MALLOC_CAP_SPIRAM);
    if (s_tile[i] == NULL) {
      ESP_LOGE(TAG, "no room for tile %d", i);
      return ESP_ERR_NO_MEM;
    }
    s_status[i].state = VF_NO_LINK;
  }
  /* A staging buffer per camera, because four transfers are in flight at
   * once and they would otherwise write over each other. The JPEG engine
   * reads these by DMA, so they want the aligned, cache-friendly allocation
   * rather than a plain malloc. */
  for (int i = 0; i < 4; i++) {
    s_jpeg[i] = heap_caps_aligned_calloc(64, 1, VF_MAX_JPEG, MALLOC_CAP_SPIRAM);
    if (s_jpeg[i] == NULL) {
      ESP_LOGE(TAG, "no room for the jpeg staging buffer %d", i);
      return ESP_ERR_NO_MEM;
    }
  }
  s_decode_lock = xSemaphoreCreateMutex();
  if (s_decode_lock == NULL) return ESP_ERR_NO_MEM;

  /* Hardware decode. Four software JPEG streams would cost more CPU than the
   * link costs bandwidth, and the P4 has an engine for exactly this. */
  jpeg_decode_engine_cfg_t eng = {.timeout_ms = 60};
  const esp_err_t err = jpeg_new_decoder_engine(&eng, &s_decoder);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "JPEG decoder unavailable: %s", esp_err_to_name(err));
    return err;
  }

  s_ready = true;
  vf_read_quality();
  ESP_LOGI(TAG, "VIEWFINDER_READY %dx%d per pane, %s q%d, hardware JPEG decode", VF_W, VF_H,
           VF_RESOLUTION, s_quality);
  for (int i = 0; i < 4; i++) {
    char name[12];
    snprintf(name, sizeof name, "vf_cam%d", i + 1);
    TaskHandle_t vh = NULL;
    /* 8 KB, not 4.
     *
     * At 4096 this overflowed and reset the board, reliably, within seconds
     * of the shoot screen appearing - reported as "going to shoot restarts
     * it". None of the big buffers are on this stack, which is what made it
     * look safe: cam_link keeps its decode storage and its transmit buffer
     * in the per-channel struct. What is on the stack is the call chain -
     * camlink_capture_ch's 768-byte response frame, the 512-byte read
     * buffer under it, the JPEG decoder's own frame - and then a log line on
     * top, because ESP_LOG formats through vsnprintf and a timeout on an
     * unwired camera is exactly when it fires. vf_cam3 went over while
     * reporting that CAM3 was not answering.
     *
     * Sized with margin rather than trimmed to fit, and registered below so
     * GET_RUNTIME_STATS reports the real high-water mark - the next change
     * to this number should come from that measurement, not from another
     * guess. */
    xTaskCreate(camera_task, name, 8192, (void *)(intptr_t)i, 3, &vh);
    taskmon_register(name, vh);
  }
  return ESP_OK;
}
