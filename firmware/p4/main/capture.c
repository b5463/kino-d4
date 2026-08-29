#include "capture.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "board_d4v1.h"
#include "cJSON.h"
#include "clock.h"
/* storage.h already carries the card-access lock this path takes, so the
 * capture path no longer needs to know that uploads exist at all — the
 * coordination is with the *card*, not with a particular consumer of it.
 * Enqueue still arrives through capture_on_done(), the way the gallery does. */
#include "config_store.h"
#include "driver/gpio.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "hardware_validation.h"
#include "kdp/crc32.h"
#include "klog.h"
#include "meta.h"
#include "node_link/node_link.h"
#include "power.h"
#include "pure.h"
#include "storage.h"
#include "taskmon.h"
#include "thumb.h"
#include "viewfinder.h"

static const char *TAG = "capture";

/* The trigger edge. 200 us is far longer than any receiver needs and short
 * enough to be invisible in the capture budget; it exists to be seen on a
 * scope during bring-up, not to meet a timing spec nothing implements yet. */
#define TRIGGER_PULSE_US 200

/* A node has to expose, encode a UXGA JPEG and answer. The bench run measured
 * 380-520 ms for that; four seconds is generous enough that a timeout means
 * something is wrong rather than merely slow. */
#define NODE_CAPTURE_TIMEOUT_MS 4000
/* 4000, not 1500.
 *
 * 1500 was sized when a frame was ~50 KB. At the sensor's ceiling - QXGA
 * 2048x1536 at quality 95 - a frame is 72-241 KB, and the bench measured a
 * chunk read arriving 8075 bytes of 8192 at 1528 ms: it very nearly made it,
 * and the capture was thrown away for 28 ms. That is a budget set against the
 * wrong frame size, not a link fault - the same run reported 0 CRC errors and
 * 0 resyncs.
 *
 * One chunk is 8192 B, about 89 ms of line time at 921600 baud, so 4000 ms is
 * roughly 45x the wire cost and still bounded: a node that has genuinely
 * stopped answering fails a capture in seconds rather than hanging it. */
/*
 * A chunk is 8192 bytes and the wire runs at 921600 baud, so the data itself
 * is about 89 ms. 4000 ms was a guess made before any hardware existed, and it
 * is now the single largest cost of a capture: with retries in place a chunk
 * that loses bytes waits out the whole budget before asking again, which is
 * what made a 200 KB frame take 19.8 s. 800 ms is nine times the expected
 * transfer. Shortening it to 800 ms was tried and made captures fail: an
 * overrun costs the whole chunk, so the budget has to be long enough for the
 * retry that follows to be worth attempting. 4000 ms with three retries
 * measured 4/4 captures at 2048x1536.
 */
#define CHUNK_READ_TIMEOUT_MS 4000

/* Attempts after the first. Three, because an overrun is a momentary window
 * and a link that misses the same range four times is genuinely broken. */
#define CHUNK_RETRIES 3

/*
 * Total budget for one frame's transfer, and it exists for the screen.
 *
 * capture_fire holds the viewfinder for its whole duration - correctly, since
 * the node has one frame and the finder would invalidate the one being read.
 * But per-chunk retries have no collective bound: 21 chunks that each take a
 * 4000 ms timeout and three retries is minutes, and every second of it is a
 * frozen preview and a frozen shutter. A capture that has spent this long is
 * not going to succeed; failing lets the finder and the UI have the machine
 * back, which matters more than the last attempt.
 *
 * 25 s is chosen from measurement, not comfort. Captures that succeed at
 * 2048x1536 take 18-35 s while roughly a fifth of chunk requests lose bytes to
 * a UART overrun, so 15 s was tried and cut off captures that would have
 * completed - three of three failed "over budget" that had been succeeding.
 * This is a bound on the damage, not a fix: the preview is still held for as
 * long as the capture runs, and the honest repair is to stop losing bytes
 * (UART DMA), after which this budget should come down with it.
 */
#define XFER_BUDGET_MS 25000

/* Longest the flash is allowed to stay on. It is released as soon as every
 * node reports its capture finished; this only bounds the case where one
 * never answers. At 350-500 mA the difference matters to the battery. */
#define FLASH_MAX_MS 900

/* After switching the camera bank on, the nodes have to boot before they can
 * answer. Measured at 410 ms on the bench unit; 900 leaves margin without
 * making a first shot after an idle period feel broken. */
#define CAM_BANK_SETTLE_MS 900

#define ALL_CAMS_MASK ((1u << CAPTURE_CAMS) - 1u)

/* ---------------------------------------------------------------- */
/* module state                                                     */
/* ---------------------------------------------------------------- */

typedef struct {
  int cam;
  SemaphoreHandle_t go;
  uint8_t *jpeg; /* PSRAM staging for this camera's frame */
} worker_t;

static worker_t s_worker[CAPTURE_CAMS];
/* Bit i set once cap(i+1) is actually running. See the mask check in
 * capture_fire: waiting on a worker that does not exist never returns. */
static uint32_t s_workers_ready;
static EventGroupHandle_t s_exposed; /* bit per camera: node finished capturing */
static EventGroupHandle_t s_done;    /* bit per camera: worker is finished */
static SemaphoreHandle_t s_card;     /* one writer at a time on the card */
/*
 * One capture pipeline at a time, for EVERY kind of capture.
 *
 * Product captures (shutter, button, CAMERA_CAPTURE) and the bench captures
 * in kdp_server (CAMERA_TEST, the soak job, STORAGE_SELF_TEST, STORAGE_BENCH)
 * used to hold two different locks that never looked at each other. A node
 * holds exactly one frame and a new capture command replaces it, so a bench
 * capture landing on cam1 while a product worker was mid-transfer turned the
 * worker's next chunk read into BAD_ID. The per-channel mutex in cam_link
 * covers one request and reply, not a capture/read/release sequence.
 *
 * A binary semaphore rather than a mutex, on purpose: the soak job takes this
 * on the KDP task and gives it back from its own task when the run ends, and
 * FreeRTOS asserts when a mutex is given by a task that does not hold it.
 * Nothing here needs priority inheritance - holders are at priority 5 and 9
 * and never wait on each other. */
static SemaphoreHandle_t s_lock;
static QueueHandle_t s_requests;
static TaskHandle_t s_task;

/* Written by the coordinator before the workers are released, read by them
 * afterwards. Not locked because the release is the handoff. */
static capture_report_t *s_active;
static storage_capture_t *s_store;
static int64_t s_trigger_us;
static char s_resolution[16];
static int s_sensor_quality;
/* Which camera's frame becomes THUMB.JPG. Chosen once by the coordinator
 * before any worker runs, so exactly one worker makes it and no two race for
 * the file. -1 when no camera is online, which cannot reach the workers. */
static int s_thumb_cam = -1;

static capture_report_t s_last;
static char s_device_id[20] = "kino-d4";
static volatile capture_stage_t s_stage = CAPTURE_IDLE;
static volatile uint32_t s_count;
static capture_done_cb_t s_on_done[CAPTURE_MAX_LISTENERS];
static int s_listeners;

/* ---------------------------------------------------------------- */
/* small helpers                                                    */
/* ---------------------------------------------------------------- */

void capture_uuid4(char *out, size_t cap) {
  uint8_t b[16];
  esp_fill_random(b, sizeof b);
  b[6] = (b[6] & 0x0F) | 0x40;
  b[8] = (b[8] & 0x3F) | 0x80;
  snprintf(out, cap, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
           b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12],
           b[13], b[14], b[15]);
}

int capture_quality_to_sensor(int percent) { return pure_quality_to_sensor(percent); }

bool capture_parse_resolution(const char *s, uint32_t *width, uint32_t *height) {
  return pure_parse_resolution(s, width, height);
}

static uint32_t ms_since(int64_t t0) { return (uint32_t)((esp_timer_get_time() - t0) / 1000); }

/** "C1".."C4" - the contract LogSource for a per-camera log line. */
static const char *cam_tag(int cam) {
  static const char *TAGS[CAPTURE_CAMS] = {"C1", "C2", "C3", "C4"};
  return (cam >= 0 && cam < CAPTURE_CAMS) ? TAGS[cam] : "P4";
}

static void fail(capture_report_t *r, const char *code, const char *msg) {
  r->ok = false;
  r->status = "failed";
  snprintf(r->err_code, sizeof r->err_code, "%s", code);
  snprintf(r->err_msg, sizeof r->err_msg, "%s", msg);
}

/* ---------------------------------------------------------------- */
/* trigger and flash                                                */
/* ---------------------------------------------------------------- */

static bool s_gpio_ready;
/* True only when BOARD_FLASH_EN names a pin and that pin configured. With
 * BOARD_FLASH_EN == BOARD_GPIO_NONE (no JP1 pin left, see board_d4v1.h) the
 * flash request is accepted and does nothing; -1 is never handed to the
 * GPIO driver. */
static bool s_flash_ready;

static void flash_set(int level) {
  if (s_flash_ready) gpio_set_level((gpio_num_t)BOARD_FLASH_EN, level);
}

static void gpio_setup(void) {
  if (s_gpio_ready) return;
  gpio_config_t io = {
      .pin_bit_mask = 1ULL << BOARD_SYNC_OUT,
      .mode = GPIO_MODE_OUTPUT,
      .pull_up_en = GPIO_PULLUP_DISABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
  };
  if (gpio_config(&io) != ESP_OK) {
    ESP_LOGE(TAG, "cannot drive sync GPIO%d", BOARD_SYNC_OUT);
    return;
  }
  gpio_set_level(BOARD_SYNC_OUT, 0);
  s_gpio_ready = true;

  /* Through a variable, not the macro: `1ULL << -1` as a constant expression
   * is a compile error even inside a branch that never runs. */
  const int flash_pin = BOARD_FLASH_EN;
  if (flash_pin == BOARD_GPIO_NONE) {
    ESP_LOGW(TAG, "flash unassigned: no JP1 pin for FLASH_EN, flash requests are no-ops");
    return;
  }
  io.pin_bit_mask = 1ULL << flash_pin;
  if (gpio_config(&io) != ESP_OK) {
    ESP_LOGE(TAG, "cannot drive flash GPIO%d", flash_pin);
    return;
  }
  gpio_set_level((gpio_num_t)flash_pin, 0);
  s_flash_ready = true;
}

/** Decide whether this shot uses the flash. */
static bool flash_wanted(const char *mode) {
  const char *how = config_str("shoot.flashMode", "auto");
  if (strcmp(how, "off") == 0) return false;
  if (strcmp(how, "on") == 0) return true;
  /* "auto" has nothing to be automatic about: the D4 V1 has no ambient light
   * sensor and the viewfinder's metering is a preview average on one camera,
   * not a photometric reading. Rather than guess, auto defers to the mode's
   * own switch, which is a decision someone actually made. */
  if (strcmp(mode, "quad") == 0) return config_bool("quad.flash", false);
  return config_bool("wiggle.flash", false);
}

static void trigger_pulse(void) {
  if (!s_gpio_ready) return;
  gpio_set_level(BOARD_SYNC_OUT, 1);
  esp_rom_delay_us(TRIGGER_PULSE_US);
  gpio_set_level(BOARD_SYNC_OUT, 0);
}

/* ---------------------------------------------------------------- */
/* one camera's frame                                               */
/* ---------------------------------------------------------------- */

static void frame_failf(capture_frame_t *f, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(f->err, sizeof f->err, fmt, ap);
  va_end(ap);
  f->ok = false;
}

/** Write one staged frame to the card, then read it back and check it. */
static void store_frame(int cam, capture_frame_t *f, const uint8_t *jpeg, uint32_t size,
                        const char *node_crc) {
  const int64_t t0 = esp_timer_get_time();
  /* One writer at a time: the capture folder has a single open file handle,
   * and four cameras finishing together would otherwise interleave. Holding
   * this while another camera is still pulling bytes is the point - the card
   * works during the transfers instead of after them. */
  xSemaphoreTake(s_card, portMAX_DELAY);

  esp_err_t err = storage_capture_frame_begin(s_store, cam);
  if (err == ESP_OK) {
    err = storage_capture_append(s_store, jpeg, size);
    /* End the frame either way: an append that failed still left a file
     * handle open, and leaking it would block every later frame. */
    const esp_err_t end = storage_capture_frame_end(s_store);
    if (err == ESP_OK) err = end;
  }
  char path[96];
  snprintf(path, sizeof path, "%s/C%d.JPG", s_store->dir, cam + 1);
  xSemaphoreGive(s_card);

  if (err != ESP_OK) {
    frame_failf(f, "card write failed");
    return;
  }
  f->write_ms = ms_since(t0);

  /* Read the file back. The transfer CRC only proves the bytes crossed the
   * UART intact; this proves the card kept them, which is a different and
   * more commonly broken thing on cheap cards. */
  uint32_t stored_crc = 0, stored_bytes = 0;
  if (storage_file_crc32(path, &stored_crc, &stored_bytes) != ESP_OK) {
    frame_failf(f, "stored frame unreadable");
    return;
  }
  f->crc = stored_crc;
  if (stored_bytes != size) {
    frame_failf(f, "card kept %lu of %lu B", (unsigned long)stored_bytes,
                (unsigned long)size);
    return;
  }
  char hex[12];
  snprintf(hex, sizeof hex, "%08lx", (unsigned long)stored_crc);
  f->crc_match = node_crc[0] == '\0' || strcmp(hex, node_crc) == 0;
  if (!f->crc_match) {
    frame_failf(f, "stored %s, node said %s", hex, node_crc);
    return;
  }
  f->ok = true;
}

static void do_frame(worker_t *w) {
  const int cam = w->cam;
  capture_frame_t *f = &s_active->cam[cam];

  const int64_t dispatch_us = esp_timer_get_time();
  f->dispatch_us = dispatch_us;
  f->fire_us = (int32_t)(dispatch_us - s_trigger_us);
  camlink_capture_result_t cap;
  esp_err_t err = camlink_capture_ch(cam, s_resolution, s_sensor_quality,
                                     NODE_CAPTURE_TIMEOUT_MS, &cap);
  /* Release the flash as soon as this node is done exposing, whatever the
   * outcome — a node that failed is not going to expose again this shot. */
  xEventGroupSetBits(s_exposed, 1u << cam);

  if (err == ESP_ERR_TIMEOUT) {
    frame_failf(f, "no answer in %d ms", NODE_CAPTURE_TIMEOUT_MS);
    return;
  }
  if (err != ESP_OK) {
    frame_failf(f, "node refused the capture");
    return;
  }
  if (cap.size < 4) {
    camlink_release_ch(cam, cap.frame_id);
    frame_failf(f, "node reported %lu B", (unsigned long)cap.size);
    return;
  }
  f->node_ms = cap.duration_ms;
  /* The node's own view, for the stale-frame check. Node esp_timer domain:
   * comparable only against other figures from the SAME node. */
  f->node_fb_get_us = cap.fb_get_us;
  f->node_frame_start_us = cap.frame_start_us;
  f->node_frame_age_us = cap.frame_age_us;

  /*
   * The stale-frame signature, flagged the moment it appears rather than left
   * for someone to notice in a table. firmware/SYNC_FEASIBILITY.md predicts
   * that with fb_count=1 a capture after a release returns an ALREADY QUEUED
   * frame instantly - a photograph of the moment after the previous readout.
   *
   * Threshold: a genuinely fresh frame costs roughly one frame period, derived
   * at ~112 ms for UXGA. 20 ms is comfortably below any real capture and
   * comfortably above scheduling noise. Logged, never corrected here: M1
   * confirms the behaviour on hardware before the lifecycle is touched.
   */
  if (cap.fb_get_us > 0 && cap.fb_get_us < 20000) {
    klog(cam_tag(cam), "STALE? fb_get %lld us, frame %lld us before command",
         (long long)cap.fb_get_us, (long long)cap.frame_age_us);
  }

  w->jpeg = heap_caps_malloc(cap.size, MALLOC_CAP_SPIRAM);
  if (w->jpeg == NULL) {
    camlink_release_ch(cam, cap.frame_id);
    frame_failf(f, "no room to stage %lu B", (unsigned long)cap.size);
    return;
  }

  const int64_t t_xfer = esp_timer_get_time();
  uint32_t crc = kdp_crc32_begin();
  uint32_t offset = 0;
  while (offset < cap.size) {
    if (ms_since(t_xfer) > XFER_BUDGET_MS) {
      klog(cam_tag(cam), "transfer gave up at %lu of %lu B after %ums",
           (unsigned long)offset, (unsigned long)cap.size, (unsigned)ms_since(t_xfer));
      frame_failf(f, "transfer over budget at %lu%% of %lu B",
                  (unsigned long)((uint64_t)offset * 100 / cap.size),
                  (unsigned long)cap.size);
      free(w->jpeg);
      w->jpeg = NULL;
      camlink_release_ch(cam, cap.frame_id);
      return;
    }
    size_t want = cap.size - offset;
    if (want > NL_CHUNK_MAX) want = NL_CHUNK_MAX;
    size_t got = 0;
    const int64_t t_chunk = esp_timer_get_time();
    /*
     * Retry the chunk, because a lost byte is not a lost frame.
     *
     * There is no hardware flow control on this link - RTS and CTS are not
     * wired - so at 921600 baud a long enough interrupt-disabled window
     * overflows the RX FIFO and the bytes are simply gone. cam_link now
     * reports that as a UART overrun rather than leaving it to look like a
     * silent node. It is transient and load-dependent: the same size through
     * kdp_server's loop transfers cleanly, so the wire and the node are fine.
     *
     * A READ is addressed by offset and the node holds the frame until it is
     * released, so the remedy is simply to ask again for the same range. This
     * is what makes a four-camera capture survivable: four concurrent
     * transfers is four times the exposure to a window that only has to
     * happen once to kill a whole frame.
     *
     * Deliberately NOT added to CAMERA_TEST. That path is the bench control
     * for raw link behaviour, and retrying there would hide the very faults
     * it exists to measure.
     */
    esp_err_t rerr = ESP_FAIL;
    for (int attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
      got = 0;
      rerr = camlink_read_ch(cam, cap.frame_id, offset, w->jpeg + offset, want,
                             CHUNK_READ_TIMEOUT_MS, &got);
      if (rerr == ESP_OK && got > 0) break;
      if (attempt < CHUNK_RETRIES) {
        f->chunk_retries++;
        klog(cam_tag(cam), "chunk at %lu failed (%s), retry %d of %d",
             (unsigned long)offset, esp_err_to_name(rerr), attempt + 1, CHUNK_RETRIES);
      }
    }
    if (rerr != ESP_OK || got == 0) {
      /* Where it stopped separates a dead link from a slow one. */
      klog(cam_tag(cam), "chunk FAILED at offset %lu want %u after %d attempts, %ums",
           (unsigned long)offset, (unsigned)want, CHUNK_RETRIES + 1,
           (unsigned)ms_since(t_chunk));
      frame_failf(f, "link died at %lu%% of %lu B after %d attempts",
                  (unsigned long)((uint64_t)offset * 100 / cap.size),
                  (unsigned long)cap.size, CHUNK_RETRIES + 1);
      free(w->jpeg);
      w->jpeg = NULL;
      camlink_release_ch(cam, cap.frame_id);
      return;
    }
    crc = kdp_crc32_update(crc, w->jpeg + offset, got);
    offset += got;
  }
  f->transfer_ms = ms_since(t_xfer);
  camlink_release_ch(cam, cap.frame_id);

  char transfer_hex[12];
  snprintf(transfer_hex, sizeof transfer_hex, "%08lx", (unsigned long)kdp_crc32_final(crc));
  if (cap.crc32[0] != '\0' && strcmp(transfer_hex, cap.crc32) != 0) {
    frame_failf(f, "link corrupted the frame (%s vs %s)", transfer_hex, cap.crc32);
    free(w->jpeg);
    w->jpeg = NULL;
    return;
  }
  if (w->jpeg[0] != 0xFF || w->jpeg[1] != 0xD8) {
    frame_failf(f, "not a JPEG — no SOI marker");
    free(w->jpeg);
    w->jpeg = NULL;
    return;
  }
  f->bytes = cap.size;

  store_frame(cam, f, w->jpeg, cap.size, cap.crc32);

  /* The thumbnail comes from the frame already in memory, before it is freed.
   * Reading it back off the card to make one would cost a second read of
   * every capture for a picture we are holding right now. */
  if (f->ok && cam == s_thumb_cam && thumb_ready()) {
    char path[96];
    snprintf(path, sizeof path, "%s/THUMB.JPG", s_store->dir);
    const int64_t th0 = esp_timer_get_time();
    const esp_err_t th = thumb_write(w->jpeg, cap.size, path);
    if (s_active != NULL) s_active->thumbnail_ms = ms_since(th0);
    if (th != ESP_OK) {
      /* Not a capture failure. The frames are on the card and readable; a
       * gallery without a thumbnail is slower, not wrong. */
      ESP_LOGW(TAG, "no thumbnail for %s", s_store->id);
    }
  }

  free(w->jpeg);
  w->jpeg = NULL;

  if (f->ok) {
    /* Per channel, not CAM1 only: the four-camera bring-up has to be able to
     * say which cameras have actually written a verified frame to the card. */
    hwv_mark_validated(hwv_cam_item(cam, HWV_CAM1_JPEG_TRANSFER), "transfer CRC matched the node's");
    hwv_mark_validated(hwv_cam_item(cam, HWV_CAM1_SD_WRITE), "read-back CRC matched the node's");
    if (cam == 0) hwv_mark_validated(HWV_CAM1_CAPTURE, "capture stored and verified from the card");
  }
}

static void worker_task(void *arg) {
  worker_t *w = arg;
  for (;;) {
    xSemaphoreTake(w->go, portMAX_DELAY);
    do_frame(w);
    xEventGroupSetBits(s_done, 1u << w->cam);
  }
}

/* ---------------------------------------------------------------- */
/* META.JSON                                                        */
/* ---------------------------------------------------------------- */

void capture_meta_json(const capture_report_t *r, void *cjson_object) {
  meta_build_capture(r, s_device_id, cjson_object);
}

/* ---------------------------------------------------------------- */
/* the capture itself                                               */
/* ---------------------------------------------------------------- */

/** Make sure the cameras have power and have finished booting. */
static bool cams_powered(void) {
  power_activity();
  power_state_t p;
  power_get(&p);
  if (p.cam_bank_on) return true;

  /* The bank comes back on because the activity above reset the idle timer,
   * but the power task only re-evaluates twice a second and the nodes then
   * have to boot. Waiting here is what makes the first press after an idle
   * period take a picture instead of reporting four dead cameras. */
  klog("P4", "waking the camera bank for a capture");
  for (int i = 0; i < 20 && !p.cam_bank_on; i++) {
    vTaskDelay(pdMS_TO_TICKS(50));
    power_get(&p);
  }
  if (!p.cam_bank_on) return false;
  vTaskDelay(pdMS_TO_TICKS(CAM_BANK_SETTLE_MS));
  return true;
}

bool capture_lock(uint32_t timeout_ms) {
  if (s_lock == NULL) return false;
  return xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) == pdTRUE;
}

void capture_unlock(void) {
  if (s_lock != NULL) xSemaphoreGive(s_lock);
}

esp_err_t capture_fire(const char *source, capture_report_t *out) {
  if (!capture_lock(0)) return ESP_ERR_INVALID_STATE;

  /*
   * Take the card for the whole capture, at capture priority, HERE.
   *
   * This lived in capture_task() first, wrapped around the call to this
   * function, and the same reasoning that moved the viewfinder hold (below)
   * applies: KDP's CAMERA_CAPTURE calls capture_fire() directly, so a
   * host-triggered capture never held the card and shared the SDMMC bus with
   * whatever the upload worker or a MEDIA_READ was doing. The reason to hold
   * the card is the bus and the timing - four concurrent frame writes whose
   * spread is the number this pipeline exists to keep small - not the handle
   * budget, which the audit in storage.h found comfortable.
   *
   * STORAGE_WAIT_FOREVER, deliberately. A capture is never refused the card;
   * the lower-priority holder sees storage_yield_requested() go true and lets
   * go between chunks, so the wait is bounded by one chunk rather than one
   * whole file. Released at `finish`, on this task, after the done-listeners
   * have run - upload_queue's listener writes UPLOAD.JSON through
   * storage_acquire_unless_held(), which is what lets it run inside this hold
   * from either caller. A NULL lock means storage_init() never ran, and then
   * the capture fails below on SD_NOT_MOUNTED for the right reason.
   */
  const bool card_held = storage_acquire(STORAGE_USER_CAPTURE, STORAGE_WAIT_FOREVER);

  /*
   * Take the cameras off the viewfinder, HERE.
   *
   * A camera node holds exactly one frame: node_server's handle_capture
   * releases whatever it held and bumps the frame id, so a viewfinder frame
   * taken mid-transfer invalidates the frame being transferred and the next
   * chunk read comes back BAD_ID.
   *
   * This lived in capture_task() first, which was wrong and quietly so:
   * KDP's CAMERA_CAPTURE calls capture_fire() directly (kdp_server.c), so the
   * host path never went near the task and never took the hold. The symptom
   * was a product capture failing with "link died at 0%" while the bench
   * command beside it worked. capture_fire is the one function every capture
   * goes through, so the hold belongs at this lock and nowhere else.
   *
   * viewfinder_hold() also waits for a pump already in flight, which setting
   * the run flag alone does not.
   */
  const bool vf_was_running = viewfinder_hold(1500);

  const int64_t t_start = esp_timer_get_time();
  capture_report_t r;
  memset(&r, 0, sizeof r);
  r.request_us = t_start;
  snprintf(r.source, sizeof r.source, "%s", source != NULL ? source : "unknown");
  r.status = "failed";
  r.clock_source = clock_source_str();
  snprintf(r.mode, sizeof r.mode, "%s", config_str("mode", "wiggle"));
  /* One resolution for every mode. `quad` has no resolution of its own in the
   * settings envelope - the four frames of a quad are the same four sensors
   * as a wiggle, shown differently. */
  snprintf(r.resolution, sizeof r.resolution, "%s",
           config_str("wiggle.resolution", "2048x1536"));
  clock_iso8601(r.captured_at, sizeof r.captured_at);
  r.captured_at_ms = clock_now_ms();

  /* Everything the failure paths below jump past has to be declared up here:
   * a goto over an initialiser leaves the variable unset, and `store` in
   * particular is what the cleanup would try to abort. */
  uint32_t ask = 0;
  storage_capture_t store;
  bool folder_open = false;
  bool flash = false;
  int32_t first = 0, last = 0;
  bool have_span = false;
  cJSON *meta = NULL;
  char *text = NULL;
  esp_err_t committed = ESP_FAIL;

  s_stage = CAPTURE_TRIGGERING;
  gpio_setup();

  if (!storage_present()) {
    fail(&r, "SD_NOT_MOUNTED", "No card to write the capture to");
    goto finish;
  }
  if (!cams_powered()) {
    fail(&r, "CAMERA_OFFLINE", "The camera bank did not come back on");
    goto finish;
  }

  /* Which cameras are worth asking. A camera that has never answered gets no
   * command: waiting four seconds for each of three empty sockets would make
   * a one-camera bench unit feel broken. */
  const int64_t probe0 = esp_timer_get_time();
  for (int i = 0; i < CAPTURE_CAMS; i++) {
    camlink_info_t info;
    camlink_get_info_ch(i, &info);
    if (info.online) {
      ask |= 1u << i;
      r.cam[i].attempted = true;
      r.online++;
    } else {
      snprintf(r.cam[i].err, sizeof r.cam[i].err, "no link");
    }
  }
  r.probe_ms = ms_since(probe0);

  /*
   * Never wait on a worker that was not created.
   *
   * `ask` is built from which cameras answered, and capture_init returns on
   * the first task it fails to create while main.c only logs that failure and
   * carries on. A camera in `ask` with no worker behind it means its done bit
   * is never set, and the wait for those bits below is portMAX_DELAY - so the
   * capture would hang forever holding the viewfinder hold, the capture lock
   * and the card. Cheap to make impossible, and it degrades to the ordinary
   * "no camera answered" path.
   */
  if ((ask & ~s_workers_ready) != 0) {
    klog("P4", "cam mask %#x has no worker, dropping to %#x", (unsigned)ask,
         (unsigned)(ask & s_workers_ready));
    for (int i = 0; i < CAPTURE_CAMS; i++) {
      if ((ask & (1u << i)) && !(s_workers_ready & (1u << i))) {
        snprintf(r.cam[i].err, sizeof r.cam[i].err, "no worker");
        r.cam[i].attempted = false;
        if (r.online > 0) r.online--;
      }
    }
    ask &= s_workers_ready;
  }

  if (ask == 0) {
    fail(&r, "CAMERA_OFFLINE", "No camera answered");
    goto finish;
  }

  /*
   * Check the card has room BEFORE creating anything.
   *
   * The order is the point. Creating the folder first and discovering the
   * shortfall at frame three leaves two frames and no metadata on the card -
   * exactly the orphan the boot sweep then has to clean up. Refusing here
   * costs a photograph that was never possible and leaves the card untouched.
   *
   * The reserve is a conservative bound, not an estimate (see
   * storage_capture_reserve_bytes). On a 32 GB card it never fires; on a card
   * with 2 MB left it always does, which is the whole intent.
   */
  {
    uint32_t rw = 0, rh = 0;
    if (!capture_parse_resolution(r.resolution, &rw, &rh)) {
      /* Unparseable resolution reserves for the largest frame this firmware
       * advertises rather than for nothing. */
      rw = 0;
      rh = 0;
    }
    uint64_t need = 0, avail = 0;
    if (!storage_capture_space_ok(r.online, rw, rh, &need, &avail)) {
      char msg[96];
      snprintf(msg, sizeof msg, "Needs %lu KB, %lu KB free",
               (unsigned long)(need / 1024), (unsigned long)(avail / 1024));
      fail(&r, "SD_FULL", msg);
      goto finish;
    }
  }

  capture_uuid4(r.uuid, sizeof r.uuid);
  if (storage_capture_open(&store, r.uuid, "CAP") != ESP_OK) {
    fail(&r, "SD_WRITE_FAILED", "Could not create the capture folder");
    goto finish;
  }
  folder_open = true;
  snprintf(r.id, sizeof r.id, "%s", store.id);
  snprintf(r.dir, sizeof r.dir, "%s", store.dir);

  s_active = &r;
  s_store = &store;
  s_sensor_quality = capture_quality_to_sensor(config_int("wiggle.jpegQuality", 85));
  snprintf(s_resolution, sizeof s_resolution, "%s", r.resolution);

  /* The camera the thumbnail is made from: the one the operator was framing
   * with, when it is online, and otherwise the lowest camera that is. The
   * fallback is what makes a bench unit with only CAM1 fitted produce
   * thumbnails at all - the default preview camera is cam2. */
  s_thumb_cam = -1;
  {
    const char *want = config_str("shoot.viewfinder", "cam2");
    const int wanted = (want[0] == 'c' && want[1] == 'a' && want[2] == 'm')
                           ? want[3] - '1'
                           : -1;
    if (wanted >= 0 && wanted < CAPTURE_CAMS && (ask & (1u << wanted))) {
      s_thumb_cam = wanted;
    } else {
      for (int i = 0; i < CAPTURE_CAMS; i++) {
        if (ask & (1u << i)) {
          s_thumb_cam = i;
          break;
        }
      }
    }
  }

  flash = flash_wanted(r.mode);
  xEventGroupClearBits(s_exposed, ALL_CAMS_MASK);
  xEventGroupClearBits(s_done, ALL_CAMS_MASK);

  if (flash) flash_set(1);
  s_trigger_us = esp_timer_get_time();
  trigger_pulse();
  /* Major transitions are logged with the ring's microsecond stamp so bring-up
   * can order them against the per-camera lines below. Deliberately a handful
   * per capture, not per chunk: a log that perturbs the timing it measures is
   * worse than none. */
  klog("P4", "trigger +%lld us, %d cam(s), flash %s",
       (long long)(s_trigger_us - r.request_us), r.online, flash ? "on" : "off");
  for (int i = 0; i < CAPTURE_CAMS; i++) {
    if (ask & (1u << i)) xSemaphoreGive(s_worker[i].go);
  }

  if (flash) {
    xEventGroupWaitBits(s_exposed, ask, pdFALSE, pdTRUE, pdMS_TO_TICKS(FLASH_MAX_MS));
    flash_set(0);
  }

  /* Every worker sets its bit exactly once per capture, including on every
   * failure path, so this cannot hang on a camera that misbehaves — only on
   * one whose own timeouts have not expired yet, which they always do. */
  s_stage = CAPTURE_READING;
  xEventGroupWaitBits(s_done, ask, pdFALSE, pdTRUE, portMAX_DELAY);
  s_stage = CAPTURE_WRITING;
  klog("P4", "all frames in at +%lld us", (long long)(esp_timer_get_time() - r.request_us));

  for (int i = 0; i < CAPTURE_CAMS; i++) {
    if ((ask & (1u << i)) == 0) continue;
    const int32_t at = r.cam[i].fire_us;
    if (!have_span) {
      first = last = at;
      have_span = true;
    } else {
      if (at < first) first = at;
      if (at > last) last = at;
    }
    if (r.cam[i].ok) {
      r.stored++;
      r.bytes += r.cam[i].bytes;
    }
  }
  r.spread_us = have_span ? (uint32_t)(last - first) : 0;

  if (r.stored == 0) {
    /* Name the first camera that actually failed, not cam1 - on a bench unit
     * with one camera fitted, cam1's "no link" is the least informative
     * message available and hides the real one. */
    const char *why = "No frame was stored";
    for (int i = 0; i < CAPTURE_CAMS; i++) {
      if (r.cam[i].attempted && r.cam[i].err[0] != '\0') {
        why = r.cam[i].err;
        break;
      }
    }
    fail(&r, "CAPTURE_FAILED", why);
    goto finish;
  }

  r.ok = true;
  r.status = r.stored == r.online ? "complete" : "partial";
  r.total_ms = ms_since(t_start);

  meta = cJSON_CreateObject();
  capture_meta_json(&r, meta);
  text = cJSON_PrintUnformatted(meta);
  cJSON_Delete(meta);
  if (text == NULL) {
    fail(&r, "OUT_OF_MEMORY", "Could not build META.JSON");
    goto finish;
  }
  const int64_t meta0 = esp_timer_get_time();
  committed = storage_capture_commit(&store, text);
  r.meta_commit_ms = ms_since(meta0);
  cJSON_free(text);
  if (committed != ESP_OK) {
    /* The frames are on the card but nothing describes them. A folder of
     * unexplained JPEGs is worse than no folder: it would be imported as a
     * capture with no mode, no timestamp and no frame order. */
    fail(&r, "SD_WRITE_FAILED", "Frames written but META.JSON failed");
    goto finish;
  }
  folder_open = false;

  s_count++;
  clock_persist();
  klog("P4", "%s %d/%d frames, %lu KB, %lu ms, spread %lu us", r.id, r.stored, r.online,
       (unsigned long)(r.bytes / 1024), (unsigned long)r.total_ms,
       (unsigned long)r.spread_us);

finish:
  flash_set(0);
  /* One place that undoes a half-made capture, so no failure path can leave
   * a folder of frames nothing will ever explain. */
  if (folder_open && !r.ok) storage_capture_abort(&store);
  if (!r.ok) {
    r.total_ms = ms_since(t_start);
    klog("P4", "capture failed - %s: %s", r.err_code, r.err_msg);
    ESP_LOGE(TAG, "%s: %s", r.err_code, r.err_msg);
  }
  s_active = NULL;
  s_store = NULL;
  s_last = r;
  s_stage = CAPTURE_DONE;
  if (out != NULL) *out = r;
  for (int i = 0; i < s_listeners; i++) s_on_done[i](&r);
  /* Hold the tiles on the shot just taken before live resumes, the way a
   * camera reviews a frame. They already carry the last frame before the
   * shutter, so this costs no decode.
   *
   * Only when there is something to review. A failed capture has no shot, and
   * freezing the panes for 450 ms after each attempt made a failing capture
   * path look like a failing screen. */
  if (r.ok) viewfinder_review(450);
  viewfinder_release(vf_was_running);
  if (card_held) storage_release(STORAGE_USER_CAPTURE);
  capture_unlock();
  return r.ok ? ESP_OK : ESP_FAIL;
}

/* ---------------------------------------------------------------- */
/* async entry, for the shutter key and the physical button          */
/* ---------------------------------------------------------------- */

static void capture_task(void *arg) {
  (void)arg;
  for (;;) {
    char source[16];
    if (xQueueReceive(s_requests, source, portMAX_DELAY) != pdTRUE) continue;
    /* The card lock and the viewfinder hold both live inside capture_fire(),
     * so the host path through kdp_server gets them too. */
    capture_fire(source, NULL);
  }
}

bool capture_request(const char *source) {
  if (s_requests == NULL || capture_busy()) return false;
  char slot[16];
  snprintf(slot, sizeof slot, "%s", source != NULL ? source : "shutter");
  return xQueueSend(s_requests, slot, 0) == pdTRUE;
}

capture_stage_t capture_stage(void) { return s_stage; }

void capture_ack(void) {
  if (s_stage == CAPTURE_DONE) s_stage = CAPTURE_IDLE;
}

bool capture_busy(void) {
  if (!capture_lock(0)) return s_lock != NULL;
  capture_unlock();
  return false;
}

void capture_last(capture_report_t *out) {
  if (out != NULL) *out = s_last;
}

uint32_t capture_count(void) { return s_count; }

void capture_on_done(capture_done_cb_t cb) {
  if (cb == NULL || s_listeners >= CAPTURE_MAX_LISTENERS) return;
  s_on_done[s_listeners++] = cb;
}

esp_err_t capture_init(const char *device_id) {
  if (s_lock != NULL) return ESP_OK;
  if (device_id != NULL && device_id[0] != '\0') {
    snprintf(s_device_id, sizeof s_device_id, "%s", device_id);
  }

  s_lock = xSemaphoreCreateBinary();
  if (s_lock != NULL) xSemaphoreGive(s_lock); /* binary semaphores start taken */
  s_card = xSemaphoreCreateMutex();
  s_exposed = xEventGroupCreate();
  s_done = xEventGroupCreate();
  s_requests = xQueueCreate(1, 16);
  if (s_lock == NULL || s_card == NULL || s_exposed == NULL || s_done == NULL ||
      s_requests == NULL) {
    return ESP_ERR_NO_MEM;
  }
  memset(&s_last, 0, sizeof s_last);
  s_last.status = "none";
  s_last.clock_source = clock_source_str();

  for (int i = 0; i < CAPTURE_CAMS; i++) {
    s_worker[i].cam = i;
    s_worker[i].go = xSemaphoreCreateBinary();
    if (s_worker[i].go == NULL) return ESP_ERR_NO_MEM;
    char name[16];
    snprintf(name, sizeof name, "cap%d", i + 1);
    /* 8 KB, and it is a bring-up safety value rather than a measured fit.
     *
     * The 4 KB it replaces carried the note that the deepest thing here was
     * "chunk shuffling and a 96-byte snprintf". A bench read on 2026-08-28
     * disagreed: cap1 reported 32 bytes free of 4096, while cap2-4 - which no
     * node has ever answered on - still held ~3800. Only cap1 had walked the
     * transfer-then-SD-write path, and that path now also carries a per-chunk
     * klog, whose vsnprintf lands on this stack.
     *
     * All four, not cam1 alone: cap2-4 run the same function over the same
     * path and are shallow only because nothing has answered on them yet.
     *
     * Right-size all four after M1 / Gate A, from four live channels. Do not
     * trim this on a channel count of one. */
    /* Priority 5. Raising these to 8 was tried on 2026-08-29 on the theory
     * that the worker was being preempted for longer than the 1.39 ms the RX
     * FIFO tolerates, and it changed nothing - 0/5 either way - so the
     * difference between this path and CAMERA_TEST is not scheduling. */
    TaskHandle_t wh = NULL;
    if (xTaskCreate(worker_task, name, 8192, &s_worker[i], 5, &wh) != pdPASS) {
      return ESP_ERR_NO_MEM;
    }
    taskmon_register(name, wh);
    s_workers_ready |= 1u << i; /* only a task that exists can set its done bit */
  }
  /* 6 KB: this one builds META.JSON, which is the largest allocation-heavy
   * thing in the module. */
  if (xTaskCreate(capture_task, "capture", 6144, NULL, 5, &s_task) != pdPASS) {
    return ESP_ERR_NO_MEM;
  }
  taskmon_register("capture", s_task);

  gpio_setup();
  if (s_flash_ready) {
    ESP_LOGI(TAG, "ready — %d workers, trigger on GPIO%d, flash on GPIO%d", CAPTURE_CAMS,
             BOARD_SYNC_OUT, BOARD_FLASH_EN);
  } else {
    ESP_LOGI(TAG, "ready — %d workers, trigger on GPIO%d, flash unassigned", CAPTURE_CAMS,
             BOARD_SYNC_OUT);
  }
  return ESP_OK;
}
