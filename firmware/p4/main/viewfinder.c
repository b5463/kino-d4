#include "viewfinder.h"

#include <string.h>

#include "cam_link.h"
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

/* A QVGA JPEG at this quality measures a few KB; this is generous headroom so
 * a busy frame is never truncated into a decode failure. */
#define VF_MAX_JPEG (24 * 1024)

/* Older than this and a pane stops claiming to be live. */
#define VF_STALE_MS 2000

/*
 * Viewfinder-shaped timeouts, not capture-shaped ones.
 *
 * A stored capture may fairly wait eight seconds for a slow node. A pane may
 * not: waiting that long freezes the picture someone is framing with, and the
 * next frame is a couple of hundred milliseconds away in any case. A QVGA
 * exposure is tens of milliseconds and its transfer about fifty, so a node
 * that has not answered in 900 ms is not slow, it is absent.
 */
#define VF_CAPTURE_TIMEOUT_MS 900
#define VF_READ_TIMEOUT_MS 600

static uint16_t *s_tile[4];
static uint8_t *s_jpeg[4];
static jpeg_decoder_handle_t s_decoder;
static SemaphoreHandle_t s_decode_lock;
static vf_status_t s_status[4];
static int64_t s_last_frame_us[4];
static bool s_ready;
static volatile bool s_running;
/* Pumps currently inside pump_camera(). viewfinder_hold() waits for zero. */
static volatile int s_pumping;
/* Tiles are frozen until this time; see viewfinder_review(). */
static volatile int64_t s_review_until_us;

bool viewfinder_ready(void) { return s_ready; }
void viewfinder_run(bool on) { s_running = on; }

bool viewfinder_hold(uint32_t timeout_ms) {
  const bool was = s_running;
  s_running = false;
  /* Wait out any pump already talking to a node. Without this the capture
   * races the very frame it is about to invalidate. */
  const int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
  while (s_pumping > 0 && esp_timer_get_time() < deadline) {
    vTaskDelay(pdMS_TO_TICKS(5));
  }
  const uint32_t waited = (uint32_t)((esp_timer_get_time() - (deadline - (int64_t)timeout_ms * 1000)) / 1000);
  if (s_pumping > 0) {
    klog("P4", "vf hold TIMED OUT after %lums, %d still pumping - capturing anyway",
         (unsigned long)waited, s_pumping);
  } else if (was) {
    klog("P4", "vf held in %lums", (unsigned long)waited);
  }
  return was;
}

void viewfinder_release(bool was_running) { s_running = was_running; }

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
  if (camlink_capture_ch(cam, VF_RESOLUTION, VF_QUALITY, VF_CAPTURE_TIMEOUT_MS, &res) !=
      ESP_OK) {
    s_status[cam].state = VF_NO_LINK;
    return false;
  }
  if (res.size == 0 || res.size > VF_MAX_JPEG) {
    camlink_release_ch(cam, res.frame_id);
    s_status[cam].state = VF_ERROR;
    return false;
  }

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
     * had already passed the s_running test would pump AFTER hold() had seen
     * s_pumping == 0 and returned, and the capture it was protecting still
     * lost its frame. Claiming first means hold() either sees the claim and
     * waits, or clears the flag before the claim and we back out here.
     */
    s_pumping++;
    const bool may_pump =
        s_running && esp_timer_get_time() >= s_review_until_us;
    if (!may_pump) {
      s_pumping--;
      /* Idle at 100 ms when stopped, 20 ms while reviewing, so live resumes
       * promptly when the review window closes. */
      vTaskDelay(pdMS_TO_TICKS(s_running ? 20 : 100));
      continue;
    }
    const bool ok = pump_camera(cam);
    s_pumping--;
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
      vTaskDelay(pdMS_TO_TICKS(miss < 3 ? 500 : 2500));
    } else {
      miss = 0;
      vTaskDelay(pdMS_TO_TICKS(5));
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
  ESP_LOGI(TAG, "VIEWFINDER_READY %dx%d per pane, %s q%d, hardware JPEG decode", VF_W, VF_H,
           VF_RESOLUTION, VF_QUALITY);
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
