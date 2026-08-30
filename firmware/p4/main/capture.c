#include "capture.h"
#include "cam_sched.h"

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
#include "kdp_recipes.h"
#include "klog.h"
#include "meta.h"
#include "net_link.h"
#include "node_link/node_link.h"
#include "power.h"
#include "pure.h"
#include "roll_state.h"
#include "storage.h"
#include "taskmon.h"
#include "thumb.h"
#include "upload_queue.h"
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

/*
 * One chunk is 8192 B, about 89 ms of line time at 921600 baud, so this is
 * eleven times the cost of the thing it waits for.
 *
 * It was 4000 ms, sized on a bench run where a chunk read arrived 8075 bytes
 * of 8192 at 1528 ms and roughly every chunk needed a retry. That run has been
 * superseded: the compositor was blacking out the link ISR, and once that was
 * fixed the losses went away with it. A chunk now either arrives or is gone,
 * so a long budget only makes a doomed frame take longer to admit it - and the
 * budget is spent four times over, once per camera, on every failing capture.
 */
#define CHUNK_READ_TIMEOUT_MS 1000

/* Attempts after the first. Two: measured captures now need zero, so this is
 * for a genuine glitch, and three attempts at 1000 ms bounds a bad chunk at
 * 3 s instead of the 16 s the old pairing allowed. */
#define CHUNK_RETRIES 2

/*
 * Total budget for one frame's transfer, and it exists for the screen.
 *
 * capture_fire holds the viewfinder for its whole duration - correctly, since
 * the node has one frame and the finder would invalidate the one being read.
 * But per-chunk retries have no collective bound: 30 chunks that each take a
 * 1000 ms timeout and two retries is 90 s, and every second of it is a
 * frozen preview and a frozen shutter. A capture that has spent this long is
 * not going to succeed; failing lets the finder and the UI have the machine
 * back, which matters more than the last attempt.
 *
 * 8 s is what a frame costs plus room to be unlucky. A 241 KB frame - the
 * largest this firmware asks for, QXGA at quality 95 - is 30 chunks, about
 * 2.7 s of line time at 921600 baud, so this is roughly 3x a full-size
 * transfer and about 15x a 50 KB one.
 *
 * It was 25 s, chosen from a run where captures took 18-35 s because roughly a
 * fifth of chunk requests lost bytes to a UART overrun; 15 s was tried then and
 * cut off captures that would have completed. That run was superseded by the
 * fix for the compositor blacking out the link ISR, which is what was causing
 * the losses. The comment there said this budget should come down once the
 * bytes stopped being lost, and it has.
 */
#define XFER_BUDGET_MS 8000

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
  /* Set only on the thumbnail camera, and only when its worker deliberately
   * left `jpeg` allocated for capture_fire to hand to thumb_write. */
  uint32_t jpeg_bytes;
  /* The worker records that this camera earned its hardware-validation marks;
   * capture_fire writes them once every transfer has finished. Written by one
   * worker, read by the coordinator after the done bits, so no lock. */
  bool hwv_pending;
  /* High-water mark of this worker's stack after its last frame, bytes. */
  uint32_t stack_min;
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
/* Who may talk to the nodes: the shutter or maintenance (cam_sched.h). The
 * struct is touched under s_sched_lock for a few instructions; a capture
 * admitted while a probe is on the wire waits on s_probe_clear, which the
 * probe's end gives exactly when the last in-flight probe returns. */
static cam_sched_t s_sched;
static SemaphoreHandle_t s_sched_lock;
static SemaphoreHandle_t s_probe_clear;
/* One in-flight probe is bounded by its own request timeout: 300 ms on an
 * absent channel, DEFAULT_TIMEOUT_MS (3000) on a present node that stopped
 * answering. Past this the capture proceeds anyway and says so; the channel
 * mutex still keeps the wire serial, so nothing can overlap. */
#define PROBE_BOUNDARY_MS 3500u
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
 * BOARD_FLASH_EN == BOARD_GPIO_NONE (the pin went to the shutter, ECN-0003,
 * see board_d4v1.h) the flash request is accepted and does nothing; -1 is
 * never handed to the GPIO driver. This is the live path on D4-V1, not a
 * fallback. */
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

  /* Decided by the preprocessor, not at runtime, because the pin number is a
   * compile-time constant either way. On D4-V1 it is BOARD_GPIO_NONE (-1)
   * since ECN-0003, and `1ULL << -1` is a negative shift count: an error as a
   * constant expression and a -Wshift-count-negative warning even in a branch
   * that provably never runs. The #if keeps that expression out of the
   * translation unit entirely rather than dressing it up in a variable. */
#if BOARD_FLASH_EN == BOARD_GPIO_NONE
  ESP_LOGW(TAG, "flash unassigned: no P4 pin for FLASH_EN since ECN-0003, requests are no-ops");
#else
  io.pin_bit_mask = 1ULL << BOARD_FLASH_EN;
  if (gpio_config(&io) != ESP_OK) {
    ESP_LOGE(TAG, "cannot drive flash GPIO%d", BOARD_FLASH_EN);
    return;
  }
  gpio_set_level((gpio_num_t)BOARD_FLASH_EN, 0);
  s_flash_ready = true;
#endif
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

/** Write one staged frame to the card. */
static void store_frame(int cam, capture_frame_t *f, const uint8_t *jpeg, uint32_t size,
                        uint32_t transfer_crc) {
  const int64_t t0 = esp_timer_get_time();
  /* One writer at a time: the capture folder has a single open file handle,
   * and four cameras finishing together would otherwise interleave. Holding
   * this while another camera is still pulling bytes is the point - the card
   * works during the transfers instead of after them. */
  xSemaphoreTake(s_card, portMAX_DELAY);

  esp_err_t err = storage_capture_frame_begin(s_store, cam);
  if (err == ESP_OK) {
    err = storage_capture_append(s_store, jpeg, size);
    if (err == ESP_OK) {
      err = storage_capture_frame_end(s_store);
    } else {
      /* A short fwrite, so the bytes on the card are the front of a JPEG and
       * nothing else. This used to call frame_end() here as well - which closed
       * the file cleanly, set the frame's written bit, and left the stub on the
       * card. META.JSON then listed a frame that is half a picture, and every
       * reader of the capture believed it. Abandon closes the handle, which is
       * what the old code was right to care about, and takes the file with it. */
      storage_capture_frame_abandon(s_store);
    }
  }
  xSemaphoreGive(s_card);

  if (err != ESP_OK) {
    frame_failf(f, "card write failed");
    return;
  }
  f->write_ms = ms_since(t0);

  /*
   * No read-back CRC. This used to reopen C%d.JPG and storage_file_crc32() the
   * whole file, which cost 40-75 ms per frame - 160-300 ms across four - inside
   * the shutter, and did it as four concurrent freads against the same card
   * while sibling cameras were still writing to it.
   *
   * It proved nothing the two checks either side had not already proved: the
   * transfer CRC was compared against the node's own CRC in do_frame before
   * this function is reached, and storage_capture_frame_end() reports what
   * fwrite, fflush and fclose returned - FatFs commits the file in f_close -
   * which is what actually catches a card that dropped the write. A read-back over the same FAT driver and the same block cache that
   * just wrote the bytes is not an independent witness of them.
   *
   * f->crc keeps its meaning: on a successful write the stored bytes are the
   * transferred bytes, so it is the same 32-bit value the read-back produced.
   * crc_match is true for the same reason it was before - do_frame returns on a
   * transfer/node mismatch and never calls this, and a node that reported no
   * CRC at all counted as a match then too.
   */
  f->crc = transfer_crc;
  f->crc_match = true;
  f->ok = true;
}

/* True when NL_CMD_SENSOR has put a JPEG quality into this camera and owns
 * the register; defined below with the sensor cache it reads. */
static bool sensor_owns_quality(int cam);

static void do_frame(worker_t *w) {
  const int cam = w->cam;
  capture_frame_t *f = &s_active->cam[cam];

  const int64_t dispatch_us = esp_timer_get_time();
  f->dispatch_us = dispatch_us;
  f->fire_us = (int32_t)(dispatch_us - s_trigger_us);
  camlink_capture_result_t cap;
  /* NL_CMD_SENSOR is the single writer of the JPEG quality register once it
   * has applied one to this camera: a CAPTURE that also carried `quality`
   * overwrote the look's value with the mode default an instant before the
   * exposure, and META then recorded the value that had just been clobbered.
   * Passing 0 makes camlink_capture_ch omit the field entirely, and the
   * node's handle_capture leaves the sensor alone. Before the first
   * successful apply (or after a node reset cleared the cache) the CAPTURE
   * command carries the mode default exactly as it always did. */
  const int cap_quality = sensor_owns_quality(cam) ? 0 : s_sensor_quality;
  esp_err_t err = camlink_capture_ch(cam, s_resolution, cap_quality,
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

  /*
   * 64-byte aligned, and rounded up to a whole 64 bytes.
   *
   * This buffer is not only staging: the thumbnail camera's copy is handed
   * straight to thumb_write(), which passes it to jpeg_decoder_process() as
   * bit_stream. A plain heap_caps_malloc lands on 64 bytes about one time in
   * sixteen in PSRAM, and thumb.c records what that cost - ESP_ERR_INVALID_ARG
   * on essentially every capture this firmware ever took. The size is rounded
   * for the same reason the alignment exists: the cache-line checks are on the
   * address and the length both.
   *
   * Allocated this way for all four cameras rather than only the thumbnail
   * one: which camera that is depends on a config string, and a buffer that is
   * correct only when the setting has not changed is a defect waiting for the
   * setting to change. Paired with heap_caps_free below and at `finish`.
   */
  const size_t staged = ((size_t)cap.size + 63u) & ~(size_t)63u;
  w->jpeg = heap_caps_aligned_alloc(64, staged, MALLOC_CAP_SPIRAM);
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
      heap_caps_free(w->jpeg);
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
      /* Counted on every failed attempt, including the last one. It used to be
       * incremented only when another attempt was going to follow, so the case
       * that matters most - a chunk that failed all three ways and killed the
       * frame - reported two failures instead of three. */
      f->chunk_retries++;
      if (attempt < CHUNK_RETRIES) {
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
      heap_caps_free(w->jpeg);
      w->jpeg = NULL;
      camlink_release_ch(cam, cap.frame_id);
      return;
    }
    crc = kdp_crc32_update(crc, w->jpeg + offset, got);
    offset += got;
  }
  f->transfer_ms = ms_since(t_xfer);
  camlink_release_ch(cam, cap.frame_id);

  const uint32_t transfer_crc = kdp_crc32_final(crc);
  char transfer_hex[12];
  snprintf(transfer_hex, sizeof transfer_hex, "%08lx", (unsigned long)transfer_crc);
  if (cap.crc32[0] != '\0' && strcmp(transfer_hex, cap.crc32) != 0) {
    frame_failf(f, "link corrupted the frame (%s vs %s)", transfer_hex, cap.crc32);
    heap_caps_free(w->jpeg);
    w->jpeg = NULL;
    return;
  }
  if (w->jpeg[0] != 0xFF || w->jpeg[1] != 0xD8) {
    frame_failf(f, "not a JPEG — no SOI marker");
    heap_caps_free(w->jpeg);
    w->jpeg = NULL;
    return;
  }
  f->bytes = cap.size;

  store_frame(cam, f, w->jpeg, cap.size, transfer_crc);

  /* The thumbnail still comes from the frame already in PSRAM - reading a
   * 72-241 KB file back off the card to make one would undo the point - but it
   * is written by capture_fire once every transfer is done, not here. So this
   * worker hands its staging buffer over instead of freeing it, and capture_fire
   * frees it at `finish` on every path. Exactly one camera per capture does
   * this: s_thumb_cam is chosen by the coordinator before any worker runs. */
  if (f->ok && cam == s_thumb_cam && thumb_ready()) {
    w->jpeg_bytes = cap.size;
  } else {
    heap_caps_free(w->jpeg);
    w->jpeg = NULL;
  }

  /* Not marked here. hwv_mark_validated writes NVS, and capture_fire does it
   * after the last transfer - see the loop past the done bits. */
  w->hwv_pending = f->ok;
}

static void worker_task(void *arg) {
  worker_t *w = arg;
  for (;;) {
    xSemaphoreTake(w->go, portMAX_DELAY);
    do_frame(w);
    w->stack_min = (uint32_t)uxTaskGetStackHighWaterMark(NULL) * sizeof(StackType_t);
    xEventGroupSetBits(s_done, 1u << w->cam);
  }
}

/* ---------------------------------------------------------------- */
/* META.JSON                                                        */
/* ---------------------------------------------------------------- */

_Static_assert(sizeof(((capture_report_t *)0)->roll_id) == ROLL_ID_LEN,
               "capture_report_t.roll_id must hold a full roll id");

void capture_meta_json(const capture_report_t *r, void *cjson_object) {
  meta_build_capture(r, s_device_id, cjson_object);
}

/* ---------------------------------------------------------------- */
/* the capture itself                                               */
/* ---------------------------------------------------------------- */

/* When this path last watched the camera bank come up, on the P4's monotonic
 * clock. 0 means it has never seen the transition. */
static int64_t s_bank_up_us;

/** Make sure the cameras have power and have finished booting. */
static bool cams_powered(void) {
  power_activity();
  power_state_t p;
  power_get(&p);
  /* Already up before this capture was even asked for, so the nodes booted
   * some time ago and there is nothing to settle. */
  if (p.cam_bank_on) return true;

  /* The bank comes back on because the activity above reset the idle timer,
   * but the power task only re-evaluates twice a second and the nodes then
   * have to boot. Waiting here is what makes the first press after an idle
   * period take a picture instead of reporting four dead cameras. */
  klog("P4", "waking the camera bank for a capture");
  for (int i = 0; i < 20 && !p.cam_bank_on; i++) {
    vTaskDelay(pdMS_TO_TICKS(50));
    power_get(&p);
    if (p.cam_bank_on) s_bank_up_us = esp_timer_get_time();
  }
  if (!p.cam_bank_on) return false;

  /* Only what is left of the settle.
   *
   * s_bank_up_us is stamped in the poll above at the moment the rail was first
   * seen up, so this pays the remainder of the nodes' boot time rather than a
   * flat 900 ms on top of however long the poll already took. Stamping it here
   * instead - which an earlier version did - makes up_ms always zero and the
   * subtraction dead. */
  const uint32_t up_ms = s_bank_up_us > 0 ? ms_since(s_bank_up_us) : 0;
  if (up_ms < CAM_BANK_SETTLE_MS) vTaskDelay(pdMS_TO_TICKS(CAM_BANK_SETTLE_MS - up_ms));
  return true;
}

static void sched_take(void) {
  if (s_sched_lock != NULL) xSemaphoreTake(s_sched_lock, portMAX_DELAY);
}
static void sched_give(void) {
  if (s_sched_lock != NULL) xSemaphoreGive(s_sched_lock);
}

bool capture_lock(uint32_t timeout_ms) {
  if (s_lock == NULL) return false;
  if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) return false;
  /* s_lock is the exclusion; the scheduler is told so probes stop beginning.
   * Admission cannot fail here - s_lock guarantees no other capture is
   * active - so the answer is not consulted. */
  sched_take();
  (void)cam_sched_capture_admit(&s_sched);
  sched_give();
  return true;
}

void capture_unlock(void) {
  sched_take();
  cam_sched_capture_done(&s_sched);
  sched_give();
  if (s_lock != NULL) xSemaphoreGive(s_lock);
}

bool capture_probe_begin(int cam) {
  if (s_sched_lock == NULL) return false;
  sched_take();
  const bool go = cam_sched_probe_begin(&s_sched, cam);
  sched_give();
  return go;
}

void capture_probe_end(int cam) {
  if (s_sched_lock == NULL) return;
  sched_take();
  const bool wake = cam_sched_probe_end(&s_sched, cam);
  sched_give();
  if (wake && s_probe_clear != NULL) xSemaphoreGive(s_probe_clear);
}

void capture_sched_stats(uint32_t *probes_run, uint32_t *probes_deferred,
                         uint32_t *capture_waits) {
  sched_take();
  if (probes_run != NULL) *probes_run = s_sched.probes_run;
  if (probes_deferred != NULL) *probes_deferred = s_sched.probes_deferred;
  if (capture_waits != NULL) *capture_waits = s_sched.capture_waits;
  sched_give();
}

/* An admitted capture lets a probe already on the wire reach its boundary,
 * and waits for nothing else: no probe can begin once capture_lock() is held.
 * Returns how long it waited. */
static uint32_t wait_for_probe_boundary(void) {
  const int64_t t0 = esp_timer_get_time();
  for (;;) {
    sched_take();
    const bool ready = cam_sched_capture_ready(&s_sched);
    if (ready) cam_sched_capture_started(&s_sched);
    sched_give();
    if (ready) break;
    const uint32_t waited = ms_since(t0);
    if (waited >= PROBE_BOUNDARY_MS) {
      klog("P4", "a node probe overran its boundary (%lu ms); capturing anyway",
           (unsigned long)waited);
      sched_take();
      cam_sched_capture_started(&s_sched);
      sched_give();
      break;
    }
    /* A stale give (a probe that ended after the loop already saw ready) only
     * costs one more pass through the check above. */
    if (s_probe_clear != NULL) {
      xSemaphoreTake(s_probe_clear, pdMS_TO_TICKS(PROBE_BOUNDARY_MS - waited));
    } else {
      vTaskDelay(pdMS_TO_TICKS(10));
    }
  }
  return ms_since(t0);
}

/* ---------------------------------------------------------------- */
/* sensor settings, applied before the trigger                      */
/* ---------------------------------------------------------------- */

/*
 * What one NL_CMD_SENSOR round trip costs, and why the budget is what it is.
 *
 * The request is at most 72 bytes of JSON and the reply about 90, plus 18
 * bytes of KDP framing each way: call it 200 bytes. At 921600 baud, 8N1, ten
 * bits per byte, that is 92160 B/s - so the wire time is about 2.2 ms per
 * camera, and four cameras is under 10 ms of a capture that takes seconds.
 * The node's own work is five SCCB register blocks, sub-millisecond.
 *
 * 500 ms is therefore not a transfer budget, it is a "this node has stopped
 * answering" budget - two hundred times the cost of the thing it waits for.
 * Nothing else is on the wire at this point: the viewfinder is held and the
 * workers have not been released. Past this the capture goes ahead with the
 * sensor as it was, which is the whole failure policy for this command.
 */
#define SENSOR_APPLY_TIMEOUT_MS 500

/* What was last ASKED of each node, so a capture that changes nothing sends
 * nothing, and what the node last reported it ACCEPTED, which is what
 * META.JSON carries. The two are kept apart on purpose: the node snaps a
 * gainCeiling of 12 to 8X, and caching the snapped value would make the next
 * capture ask for 12 again on a sensor already holding it. */
static camlink_sensor_t s_sensor_sent[CAPTURE_CAMS];
static camlink_sensor_t s_sensor_state[CAPTURE_CAMS];

static bool sensor_owns_quality(int cam) {
  return cam >= 0 && cam < CAPTURE_CAMS && s_sensor_sent[cam].has_quality;
}
/* The node boot session the cache above belongs to. A node that reset has a
 * sensor back at driver defaults while the cache still says it was set, and
 * the next capture would skip the round trip and shoot at the wrong exposure.
 * The session id changes on every node boot (NL_CMD_HELLO), so comparing it is
 * how a reset invalidates the cache. */
static char s_sensor_session[CAPTURE_CAMS][sizeof(((camlink_info_t *)0)->session)];

/**
 * Read one config value as a double, reporting whether it was there at all.
 *
 * Two reasons this is not config_int(). It truncates - it is
 * `(int)valuedouble` - and exposureBias is the one fractional setting in the
 * envelope: -1.5 EV would arrive as -1 and the slider's half-steps would do
 * nothing. And it cannot say "absent", which here is a distinct answer from
 * zero: a slot with no exposureBias of its own must leave the look's value
 * standing, while a slot set to exactly 0 EV must override it.
 *
 * There is no config_double(), so this walks the live document. config_store.h
 * documents that pointer as borrowed; it is read here and not held.
 */
static bool cfg_num(const char *path, double *out) {
  const cJSON *node = config_get();
  if (node == NULL) return false;
  const char *p = path;
  while (*p != '\0') {
    const char *dot = strchr(p, '.');
    const size_t len = dot != NULL ? (size_t)(dot - p) : strlen(p);
    char key[32];
    if (len == 0 || len >= sizeof key) return false;
    memcpy(key, p, len);
    key[len] = '\0';
    node = cJSON_GetObjectItem(node, key);
    if (node == NULL) return false;
    if (dot == NULL) break;
    p = dot + 1;
  }
  if (!cJSON_IsNumber(node)) return false;
  *out = node->valuedouble;
  return true;
}

/** True when `want` asks for something `sent` did not already ask for. Only
 * the flagged fields are compared: an unflagged field says nothing about the
 * sensor, so it can neither match nor differ. */
static bool sensor_differs(const camlink_sensor_t *want, const camlink_sensor_t *sent) {
  if (want->has_ae_level && (!sent->has_ae_level || sent->ae_level != want->ae_level))
    return true;
  if (want->has_gain_ceiling &&
      (!sent->has_gain_ceiling || sent->gain_ceiling != want->gain_ceiling))
    return true;
  if (want->has_denoise && (!sent->has_denoise || sent->denoise != want->denoise)) return true;
  if (want->has_sharpness && (!sent->has_sharpness || sent->sharpness != want->sharpness))
    return true;
  if (want->has_quality && (!sent->has_quality || sent->quality != want->quality)) return true;
  return false;
}

/** Strip the fields that already hold, so the request carries only the change.
 * This is what makes the steady state - four cameras, nothing touched since
 * the last shot - cost zero bytes on the wire. */
static void sensor_keep_changed(camlink_sensor_t *want, const camlink_sensor_t *sent) {
  if (want->has_ae_level && sent->has_ae_level && sent->ae_level == want->ae_level)
    want->has_ae_level = false;
  if (want->has_gain_ceiling && sent->has_gain_ceiling &&
      sent->gain_ceiling == want->gain_ceiling)
    want->has_gain_ceiling = false;
  if (want->has_denoise && sent->has_denoise && sent->denoise == want->denoise)
    want->has_denoise = false;
  if (want->has_sharpness && sent->has_sharpness && sent->sharpness == want->sharpness)
    want->has_sharpness = false;
  if (want->has_quality && sent->has_quality && sent->quality == want->quality)
    want->has_quality = false;
}

/**
 * What camera `cam` should be shooting at, merged from the three sources.
 *
 * Later wins, and the order is the product decision:
 *
 *   1. the mode's own defaults - wiggle.jpegQuality, which is what every
 *      capture has always used;
 *   2. the active look's capture block - wiggle.recipeId in WIGGLE,
 *      quad.slots.camN.recipeId in QUAD. A look is a deliberate choice made
 *      after the mode default, so it beats it;
 *   3. the QUAD slot's own exposureBias and gain, which exist for nothing else
 *      but overriding the look on one camera. QUAD only: a wiggle has no
 *      per-camera slots.
 *
 * A look's `look` block (contrast, saturation, ...) is NOT read here. There is
 * no grading on this camera and there is not going to be; the look block is
 * Studio's at import, and the LOOK screen says so.
 *
 * A look's `resolution` is also deliberately ignored, unlike its jpegQuality:
 * one capture has one resolution (wiggle.resolution) for all four sensors,
 * because the frames of a quad are the same four sensors as a wiggle. The
 * asymmetry is easy to misread as an omission; it is a decision.
 */
static void sensor_settings_for(int cam, const char *mode, camlink_sensor_t *want) {
  memset(want, 0, sizeof *want);
  const bool quad = strcmp(mode, "quad") == 0;

  /* 1. mode defaults. s_sensor_quality is already the sensor scale.
   *
   * denoise and sharpness are mode defaults too (the settings envelope
   * carries wiggle.denoise and wiggle.sharpness), and reading them here is
   * load-bearing beyond correctness: it means quality, denoise and sharpness
   * are ALWAYS present in `want`, so a look that stops naming one falls back
   * to the default instead of leaving the sensor wherever the last look put
   * it. Only aeLevel and gainCeiling can go present-to-absent, and
   * apply_sensor_settings() restores those two explicitly. */
  if (s_sensor_quality > 0) {
    want->has_quality = true;
    want->quality = s_sensor_quality;
  }
  {
    double v = 0;
    want->has_denoise = true;
    want->denoise = cfg_num("wiggle.denoise", &v) ? (int)v : 1;
    want->has_sharpness = true;
    want->sharpness = cfg_num("wiggle.sharpness", &v) ? (int)v : 1;
  }

  /* 2. the look this camera is wearing. */
  char recipe_id[KDP_RECIPE_ID_MAX];
  if (quad) {
    char path[40];
    snprintf(path, sizeof path, "quad.slots.cam%d.recipeId", cam + 1);
    config_str_copy(path, recipe_id, sizeof recipe_id);
  } else {
    config_str_copy("wiggle.recipeId", recipe_id, sizeof recipe_id);
  }
  if (recipe_id[0] != '\0') {
    recipe_capture_t rc;
    if (kdp_recipes_capture_block(recipe_id, &rc)) {
      if (rc.has_jpeg_quality) {
        const int q = pure_quality_to_sensor(rc.jpeg_quality_percent);
        if (q > 0) {
          want->has_quality = true;
          want->quality = q;
        }
      }
      if (rc.has_exposure_bias) {
        want->has_ae_level = true;
        want->ae_level = pure_ev_to_ae_level(rc.exposure_bias);
      }
      if (rc.has_gain_limit) {
        /* Sent as the look wrote it; the node snaps to a real gainceiling_t
         * step and reports what it snapped to. */
        want->has_gain_ceiling = true;
        want->gain_ceiling = rc.gain_limit;
      }
      if (rc.has_denoise) {
        want->has_denoise = true;
        want->denoise = rc.denoise;
      }
      if (rc.has_sharpness) {
        want->has_sharpness = true;
        want->sharpness = rc.sharpness;
      }
    }
  }

  /* 3. the slot itself, QUAD only. */
  if (quad) {
    char path[40];
    snprintf(path, sizeof path, "quad.slots.cam%d.exposureBias", cam + 1);
    double ev = 0;
    /* Only when the slot actually carries the key. A slot without one leaves
     * the look's exposureBias standing; a slot set to exactly 0 EV overrides
     * it, which is the difference a presence check buys over a zero. */
    if (cfg_num(path, &ev)) {
      want->has_ae_level = true;
      want->ae_level = pure_ev_to_ae_level(ev);
    }
    snprintf(path, sizeof path, "quad.slots.cam%d.gain", cam + 1);
    char gain[12];
    config_str_copy(path, gain, sizeof gain);
    if (gain[0] != '\0') {
      const int ceiling = pure_gain_to_ceiling(gain);
      if (ceiling > 0) {
        want->has_gain_ceiling = true;
        want->gain_ceiling = ceiling;
      } else {
        /* "auto" means leave the AGC alone, and it has to be able to override
         * a look that named a gainLimit - otherwise a slot set to auto shoots
         * at the look's ceiling and the control does nothing. */
        want->has_gain_ceiling = false;
      }
    }
  }
}

/**
 * Put every online camera's settings into its sensor, before the trigger.
 *
 * Sends only what changed since this camera's last apply, so the ordinary case
 * - nothing touched since the last shot - costs no wire time at all. When
 * something did change it is one ~200-byte round trip per camera, about 2.2 ms
 * at 921600 baud (see SENSOR_APPLY_TIMEOUT_MS).
 *
 * A NACK or a timeout is one klog line and the capture proceeds: the sensor
 * keeps whatever it had, and a photograph with yesterday's exposure beats no
 * photograph. What must NOT happen is META.JSON then claiming the new values -
 * so the frame records s_sensor_state, which only ever holds what a node
 * reported it accepted.
 */
static void apply_sensor_settings(uint32_t ask, capture_report_t *r) {
  for (int i = 0; i < CAPTURE_CAMS; i++) {
    if ((ask & (1u << i)) == 0) continue;

    /* A node that rebooted is back at driver defaults whatever the cache
     * remembers. Comparing the boot session is how that is noticed; without
     * it a node reset between two captures shoots the second one at the
     * sensor's defaults while the report claims the slot's settings. */
    camlink_info_t info;
    camlink_get_info_ch(i, &info);
    if (strcmp(info.session, s_sensor_session[i]) != 0) {
      memset(&s_sensor_sent[i], 0, sizeof s_sensor_sent[i]);
      memset(&s_sensor_state[i], 0, sizeof s_sensor_state[i]);
      snprintf(s_sensor_session[i], sizeof s_sensor_session[i], "%s", info.session);
    }

    camlink_sensor_t want;
    sensor_settings_for(i, r->mode, &want);

    /* A field that was sent before and is wanted no more must be RESTORED,
     * not skipped: the sensor still holds the old value, and an absent field
     * is sensor_differs()'s "says nothing" case, so without this a slot moved
     * from gain "low" to "auto" kept shooting at the 4x ceiling and the
     * control did nothing from its second use onward. Only these two can go
     * present-to-absent (see sensor_settings_for): aeLevel restores to 0 (the
     * AEC's own target) and gainCeiling to 16 - the OV3660's working middle,
     * chosen rather than measured, because the driver does not expose what
     * the init table set and "auto" has to mean something concrete. */
    if (!want.has_ae_level && s_sensor_sent[i].has_ae_level) {
      want.has_ae_level = true;
      want.ae_level = 0;
    }
    if (!want.has_gain_ceiling && s_sensor_sent[i].has_gain_ceiling) {
      want.has_gain_ceiling = true;
      want.gain_ceiling = 16;
    }

    if (!sensor_differs(&want, &s_sensor_sent[i])) {
      r->cam[i].sensor = s_sensor_state[i];
      continue;
    }
    const camlink_sensor_t full = want;
    sensor_keep_changed(&want, &s_sensor_sent[i]);

    camlink_sensor_t applied;
    const esp_err_t err =
        camlink_set_sensor_ch(i, &want, &applied, SENSOR_APPLY_TIMEOUT_MS);
    if (err != ESP_OK) {
      /* One line, and it names what could not be set rather than only that
       * something could not: a capture that comes out at the wrong exposure
       * has to be explainable from the log alone. The cache is NOT updated,
       * so the next capture tries again. */
      klog(cam_tag(i), "sensor settings refused (%s); shooting as-is",
           esp_err_to_name(err));
      r->cam[i].sensor = s_sensor_state[i];
      continue;
    }
    s_sensor_sent[i] = full;
    s_sensor_state[i] = applied;
    r->cam[i].sensor = applied;
  }
}

esp_err_t capture_fire(const char *source, capture_report_t *out) {
  if (!capture_lock(0)) return ESP_ERR_INVALID_STATE;
  /* Admitted. Photography wins from here; a probe already on a wire gets its
   * one bounded transaction and the capture starts the instant it returns. */
  const uint32_t probe_wait_ms = wait_for_probe_boundary();

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
  /* Gate F: what the body was doing when the shutter asked for the card, and
   * how long the card took. Snapshotted before the wait so it describes the
   * moment of the shutter, not the moment after the upload yielded. */
  net_status_t shutter_net;
  net_link_status(&shutter_net, esp_timer_get_time() / 1000);
  upload_queue_report_t shutter_q;
  upload_queue_status(&shutter_q);
  const uint32_t shutter_internal_kb = (uint32_t)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024);
  const uint32_t shutter_dma_kb =
      (uint32_t)(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA) / 1024);
  const int64_t t_lock0 = esp_timer_get_time();
  const bool card_held = storage_acquire(STORAGE_USER_CAPTURE, STORAGE_WAIT_FOREVER);
  const uint32_t sd_wait_ms = (uint32_t)((esp_timer_get_time() - t_lock0) / 1000);

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
  const bool vf_was_running = viewfinder_hold(VF_HOLD_MS);

  const int64_t t_start = esp_timer_get_time();
  capture_report_t r;
  memset(&r, 0, sizeof r);
  r.request_us = t_start;
  r.sd_wait_ms = sd_wait_ms;
  r.probe_wait_ms = probe_wait_ms;
  snprintf(r.radio_state, sizeof r.radio_state, "%s", net_state_name(shutter_net.state));
  snprintf(r.radio_detail, sizeof r.radio_detail, "%.47s", shutter_net.detail);
  r.upload_active = shutter_q.uploading > 0;
  r.upload_pending = shutter_q.pending;
  r.internal_free_kb = shutter_internal_kb;
  r.largest_dma_kb = shutter_dma_kb;
  snprintf(r.source, sizeof r.source, "%s", source != NULL ? source : "unknown");
  r.status = "failed";
  r.clock_source = clock_source_str();
  snprintf(r.mode, sizeof r.mode, "%s", config_str("mode", "wiggle"));
  /* The looks in force, snapshotted now like roll_id below: MEDIA_LIST reads
   * META's recipeIds, and until 0.4.9 nothing wrote them, so every photograph
   * listed as recipe-less whatever look took it. Quad keeps one entry per
   * slot in cam order, duplicates and all, so index i is cam i+1's look. */
  _Static_assert(sizeof r.recipe_ids[0] == KDP_RECIPE_ID_MAX,
                 "capture_report_t.recipe_ids must hold a full look id");
  if (strcmp(r.mode, "quad") == 0) {
    static const char *const SLOTS[4] = {"quad.slots.cam1.recipeId", "quad.slots.cam2.recipeId",
                                         "quad.slots.cam3.recipeId", "quad.slots.cam4.recipeId"};
    for (int i = 0; i < 4; i++) {
      config_str_copy(SLOTS[i], r.recipe_ids[i], sizeof r.recipe_ids[i]);
    }
    r.recipe_id_count = 4;
  } else {
    config_str_copy("wiggle.recipeId", r.recipe_ids[0], sizeof r.recipe_ids[0]);
    r.recipe_id_count = 1;
  }
  /* One resolution for every mode. `quad` has no resolution of its own in the
   * settings envelope - the four frames of a quad are the same four sensors
   * as a wiggle, shown differently. */
  /* The fallback is 1600x1200 because that is what config_store.c seeds into a
   * fresh settings envelope and what kdp_server.c's bench capture uses. It read
   * 2048x1536 here, so a settings file missing wiggle.resolution shot at 1.64x
   * the pixels of every other path - a 72-241 KB frame instead of a 50-150 KB
   * one, on a link that costs about 89 ms per 8192-byte chunk - and nothing in
   * the report said why the capture had got slower. */
  snprintf(r.resolution, sizeof r.resolution, "%s",
           config_str("wiggle.resolution", "1600x1200"));
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
  /* Roll provenance is decided here, at the shutter, and nowhere later. A
   * photograph taken on a Roll belongs to that Roll whatever the camera
   * joins afterwards; one taken off a Roll belongs to none, however active a
   * Roll is when the upload queue gets to it. Measured before this line
   * existed: every META.JSON on the bench card said rollId null, and boot
   * reconciliation then stamped all of them with whichever Roll was current. */
  {
    roll_state_t roll;
    if (roll_state_active() && roll_state_get(&roll) && roll.roll_id[0] != '\0') {
      snprintf(r.roll_id, sizeof r.roll_id, "%s", roll.roll_id);
    }
  }
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

  /*
   * The sensors, before the trigger and before the flash.
   *
   * Here rather than inside do_frame() for two reasons. The workers run
   * concurrently and a settings round trip inside one would sit between the
   * trigger and that camera's capture command, widening the dispatch spread
   * this pipeline exists to keep small - and unevenly, since only the cameras
   * that changed would pay it. And the flash is not on yet: a node taking its
   * 500 ms timeout here costs nothing but time, while the same wait after
   * flash_set(1) would be 500 ms of 350-500 mA out of the battery.
   */
  apply_sensor_settings(ask, &r);

  flash = flash_wanted(r.mode);
  xEventGroupClearBits(s_exposed, ALL_CAMS_MASK);
  xEventGroupClearBits(s_done, ALL_CAMS_MASK);
  /* All four, not just the ones in `ask`: a camera that answered last capture
   * and is unplugged now would otherwise be marked validated again from a stale
   * flag, and its stale jpeg_bytes would size a thumbnail. */
  for (int i = 0; i < CAPTURE_CAMS; i++) {
    s_worker[i].hwv_pending = false;
    s_worker[i].jpeg_bytes = 0;
  }

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

  /*
   * The hardware-validation marks, here rather than in the workers.
   *
   * hwv_mark_validated writes NVS, and an ESP-IDF flash write runs
   * spi_flash_disable_interrupts_caches_and_other_cpu(): every link UART
   * interrupt on both cores is off for 0.5-0.8 ms on a page write and 30-45 ms
   * on a sector erase. The RX FIFO is 128 bytes - 1.39 ms at 921600 baud - and
   * RTS/CTS are not wired, so a mark fired from cam1's worker eats bytes out of
   * cam2's in-flight chunk. Each item only ever writes once per device, but on
   * a four-camera rig that one write lands inside a sibling's transfer. Nothing
   * is on the wire at this point.
   *
   * Per channel, not CAM1 only: the four-camera bring-up has to be able to say
   * which cameras have actually written a frame to the card.
   */
  for (int i = 0; i < CAPTURE_CAMS; i++) {
    if (!s_worker[i].hwv_pending) continue;
    s_worker[i].hwv_pending = false;
    hwv_mark_validated(hwv_cam_item(i, HWV_CAM1_JPEG_TRANSFER),
                       "transfer CRC matched the node's");
    /* Not "read-back CRC" any more: store_frame no longer re-reads the file,
     * so what this item now attests is a write that fwrite, fflush and fclose
     * all reported OK - not a read-back. Anything stronger belongs in
     * STORAGE_SELF_TEST, which reads the card back deliberately. */
    hwv_mark_validated(hwv_cam_item(i, HWV_CAM1_SD_WRITE), "frame written and closed clean");
    if (i == 0) hwv_mark_validated(HWV_CAM1_CAPTURE, "capture stored, transfer CRC matched");
  }

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

  /*
   * THUMB.JPG, out of the transfer window.
   *
   * thumb_write is a full-resolution hardware JPEG decode plus a PPA scale, and
   * the esp_cache_msync calls around those run over multi-megabyte PSRAM
   * buffers - cache maintenance that blocks interrupts in bursts. Run inside a
   * worker it did that while up to three siblings were mid-chunk, against 1.39
   * ms of FIFO slack, and it also held back that worker's done bit so every
   * other camera waited for a picture none of them needed.
   *
   * The buffer is the thumbnail camera's staging frame, which its worker left
   * allocated on purpose; `finish` frees it whichever way this capture ends.
   * Before META.JSON on purpose, so thumbnail_ms is in the document that
   * describes the capture it belongs to.
   */
  if (s_thumb_cam >= 0 && s_worker[s_thumb_cam].jpeg != NULL) {
    char thumb_path[96];
    snprintf(thumb_path, sizeof thumb_path, "%s/THUMB.JPG", store.dir);
    const int64_t th0 = esp_timer_get_time();
    const esp_err_t th =
        thumb_write(s_worker[s_thumb_cam].jpeg, s_worker[s_thumb_cam].jpeg_bytes, thumb_path);
    r.thumbnail_ms = ms_since(th0);
    if (th != ESP_OK) {
      /* Not a capture failure - the frames are on the card and readable, and a
       * gallery without a thumbnail is slower rather than wrong - but it goes
       * in the ring, not just the console. As ESP_LOGW it was invisible to
       * GET_LOGS, so a capture reporting a thumbnailMs with no THUMB.JPG on
       * the card looked like a mystery instead of a reported failure. */
      klog("P4", "no thumbnail for %s: %s", store.id, esp_err_to_name(th));
    }
  }

  r.ok = true;
  r.status = r.stored == r.online ? "complete" : "partial";
  r.total_ms = ms_since(t_start);
  storage_lock_stats(&r.lock_yields, &r.lock_timeouts);
  for (int i = 0; i < CAPTURE_CAMS; i++) {
    if (!r.cam[i].attempted || s_worker[i].stack_min == 0) continue;
    if (r.worker_stack_min == 0 || s_worker[i].stack_min < r.worker_stack_min) {
      r.worker_stack_min = s_worker[i].stack_min;
    }
  }

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
  /* The thumbnail camera's worker leaves its staged frame allocated for the
   * thumb_write above; every other worker path already freed its own and left
   * NULL. One sweep here so no goto - SD_FULL, CAPTURE_FAILED, a META.JSON
   * that would not commit - can drop a 72-241 KB PSRAM buffer on the floor.
   * Every worker is idle by the time any of them can hold a buffer: the only
   * path that releases them ends at the done bits above. */
  for (int i = 0; i < CAPTURE_CAMS; i++) {
    heap_caps_free(s_worker[i].jpeg);
    s_worker[i].jpeg = NULL;
    s_worker[i].jpeg_bytes = 0;
  }
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

/*
 * Publish a report for a press that never became a capture.
 *
 * capture_fire() answers ESP_ERR_INVALID_STATE without touching s_stage or
 * s_last, which is right for the synchronous caller - kdp_server turns it into
 * a BUSY NACK on the spot. On this path there is nobody to return it to: the UI
 * queued the press, moved to its capturing screen and waits for capture_stage()
 * to reach CAPTURE_DONE, so a dropped press left the screen waiting for a
 * report that was never coming, until the next capture published one.
 *
 * capture_request() checks capture_busy() first, but that is a sample of a
 * try-lock: a bench command or a probe sweep can take the lock in the gap
 * between the check and this task's xQueueReceive.
 */
static void publish_busy(const char *source) {
  capture_report_t r;
  memset(&r, 0, sizeof r);
  r.request_us = esp_timer_get_time();
  snprintf(r.source, sizeof r.source, "%s", source != NULL ? source : "unknown");
  snprintf(r.mode, sizeof r.mode, "%s", config_str("mode", "wiggle"));
  r.clock_source = clock_source_str();
  clock_iso8601(r.captured_at, sizeof r.captured_at);
  r.captured_at_ms = clock_now_ms();
  fail(&r, "BUSY", "The camera was already busy");
  klog("P4", "press dropped: %s", r.err_msg);
  s_last = r;
  s_stage = CAPTURE_DONE;
  /* The listeners run on this task, the same as after a real capture. Both of
   * them - the gallery rescan and the upload enqueue - ignore a report that is
   * not ok, so this publishes the state without inventing any work. */
  for (int i = 0; i < s_listeners; i++) s_on_done[i](&r);
}

static void capture_task(void *arg) {
  (void)arg;
  for (;;) {
    char source[16];
    if (xQueueReceive(s_requests, source, portMAX_DELAY) != pdTRUE) continue;
    /* The card lock and the viewfinder hold both live inside capture_fire(),
     * so the host path through kdp_server gets them too. */
    if (capture_fire(source, NULL) == ESP_ERR_INVALID_STATE) publish_busy(source);
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
  cam_sched_init(&s_sched);
  s_sched_lock = xSemaphoreCreateMutex();
  s_probe_clear = xSemaphoreCreateBinary(); /* starts taken: nothing to wake yet */
  s_card = xSemaphoreCreateMutex();
  s_exposed = xEventGroupCreate();
  s_done = xEventGroupCreate();
  s_requests = xQueueCreate(1, 16);
  if (s_lock == NULL || s_card == NULL || s_exposed == NULL || s_done == NULL ||
      s_requests == NULL || s_sched_lock == NULL || s_probe_clear == NULL) {
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
