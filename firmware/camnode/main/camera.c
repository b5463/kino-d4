#include "camera.h"

#include <string.h>

#include "board_xiao_s3.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "camera";

static bool s_detected;
static uint16_t s_pid;
static char s_name[16];
static char s_max_res[16];

/* What the sensor is currently configured for, so a request that changes
 * nothing costs nothing. Seeded from camsensor_init's own config below. */
/* One number for the buffer count, so the drain below cannot drift from it.
 * Under GRAB_LATEST the driver's frame queue is CAMERA_FB_COUNT - 1 deep
 * (cam_hal.c: frame_buffer_queue_len = frame_cnt - 1), so one buffer is always
 * the one the DMA is filling. */
#define CAMERA_FB_COUNT 2
#define CAMERA_FB_QUEUE_DEPTH (CAMERA_FB_COUNT - 1)

/* What the framebuffers are cut for, and what the sensor sits at until the
 * first request changes it. The alloc size must be the larger of the two. */
#define CAMERA_ALLOC_FRAMESIZE FRAMESIZE_QXGA
#define CAMERA_DEFAULT_FRAMESIZE FRAMESIZE_UXGA

static framesize_t s_framesize;
static int s_quality;

esp_err_t camsensor_init(void) {
  camera_config_t config = {
      .pin_pwdn = -1,
      .pin_reset = -1,
      .pin_xclk = BOARD_CAM_XCLK,
      .pin_sccb_sda = BOARD_CAM_SIOD,
      .pin_sccb_scl = BOARD_CAM_SIOC,
      .pin_d7 = BOARD_CAM_Y9,
      .pin_d6 = BOARD_CAM_Y8,
      .pin_d5 = BOARD_CAM_Y7,
      .pin_d4 = BOARD_CAM_Y6,
      .pin_d3 = BOARD_CAM_Y5,
      .pin_d2 = BOARD_CAM_Y4,
      .pin_d1 = BOARD_CAM_Y3,
      .pin_d0 = BOARD_CAM_Y2,
      .pin_vsync = BOARD_CAM_VSYNC,
      .pin_href = BOARD_CAM_HREF,
      .pin_pclk = BOARD_CAM_PCLK,
      .xclk_freq_hz = BOARD_CAM_XCLK_HZ,
      .ledc_timer = LEDC_TIMER_0,
      .ledc_channel = LEDC_CHANNEL_0,
      .pixel_format = PIXFORMAT_JPEG,
      /*
       * Init at the LARGEST size the node will ever be asked for, not at the
       * default one.
       *
       * esp_camera_init sizes the framebuffers once, here, and never again:
       * cam_hal.c under CONFIG_CAMERA_JPEG_MODE_FRAME_SIZE_AUTO takes
       * width*height/5. camsensor_set_resolution only calls set_framesize,
       * which writes sensor registers - the buffer keeps the size it was born
       * with. Initialising at UXGA gives 1600*1200/5 = 384000 B, and a
       * 2048x1536 JPEG that exceeds that overruns the DMA target: the driver
       * reports FB-OVF and fb_get returns NULL, so a QXGA capture fails on a
       * node that had been working at UXGA all session.
       *
       * QXGA is 2048*1536/5 = 629145 B per buffer, 1258290 B for the two, in
       * PSRAM on the 8 MB part. The owner shoots at 2048x1536, so that is the
       * size the buffers have to be cut for; the drop to the configured
       * default below is a register write into buffers that are already large
       * enough.
       */
      .frame_size = CAMERA_ALLOC_FRAMESIZE,
      .jpeg_quality = 12,
      /*
       * Two buffers and GRAB_LATEST, which is what esp32-camera documents for
       * streaming and what the viewfinder measurement demanded.
       *
       * With fb_count=1 and GRAB_WHEN_EMPTY the driver fills the one buffer
       * after each return and then stalls until the next fb_get. The P4's
       * preview pump free-runs against the sensor's frame clock, so a request
       * either caught a ready frame or waited a whole frame period, and the
       * bench log is bimodal on exactly that: cap was 10 ms or 62-75 ms with
       * nothing in between, making the frame interval alternate between about
       * 40 ms and 101 ms. Constant bytes, constant transfer, 2.5x jitter -
       * felt as stutter whenever the scene moved.
       *
       * With two buffers the driver captures continuously, so a request is
       * served from a frame already in hand. esp_camera.h calls GRAB_WHEN_EMPTY
       * "less resources but first 'fb_count' frames might be old"; GRAB_LATEST
       * takes the newest instead.
       *
       * The queue is one frame deep, not two. cam_hal.c sizes
       * frame_buffer_queue to fb_count - 1 under GRAB_LATEST, so with
       * fb_count=2 exactly one completed frame can be waiting while the DMA
       * fills the other buffer. While s_fb is held across readout that other
       * buffer is the only free one, so the driver has nowhere to put a second
       * frame and the queue cannot grow past one.
       *
       * This also bounds staleness for stills. HARDWARE_VALIDATION.md records
       * a frame handed back 134 s after it was exposed; the queue now holds at
       * most one frame, and camsensor_discard_queued still runs ahead of a
       * real shutter.
       */
      .fb_count = CAMERA_FB_COUNT,
      .fb_location = CAMERA_FB_IN_PSRAM,
      .grab_mode = CAMERA_GRAB_LATEST,
  };

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "sensor init failed: %s", esp_err_to_name(err));
    return err;
  }

  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor == NULL) return ESP_FAIL;

  /* Seed the configured-state cache from what init actually applied, read back
   * off the sensor rather than copied out of the config. esp_camera_init
   * clamps frame_size down to the sensor's own maximum, so on a part whose
   * ceiling is below CAMERA_ALLOC_FRAMESIZE the config and the hardware
   * disagree - and the cache is what the change-only guards in
   * set_quality/set_resolution compare against, so a wrong seed turns a real
   * request into a silent no-op.
   *
   * Outside the info!=NULL block below on purpose: it has to be seeded whether
   * or not the PID is in the driver's table, because a zeroed s_framesize is
   * FRAMESIZE_96X96, a size the node never asks for. */
  s_framesize = sensor->status.framesize;
  s_quality = sensor->status.quality;

  camera_sensor_info_t *info = esp_camera_sensor_get_info(&sensor->id);
  if (info != NULL) {
    strncpy(s_name, info->name, sizeof s_name - 1);
    s_pid = sensor->id.PID;
    s_detected = true;
    switch (info->max_size) {
      case FRAMESIZE_QSXGA: strcpy(s_max_res, "2592x1944"); break;
      case FRAMESIZE_QXGA: strcpy(s_max_res, "2048x1536"); break;
      case FRAMESIZE_UXGA: strcpy(s_max_res, "1600x1200"); break;
      default: s_max_res[0] = '\0'; break;
    }
    ESP_LOGI(TAG, "sensor detected: %s (PID 0x%04x)", s_name, sensor->id.PID);
  } else {
    /* The sensor answered SCCB - esp_camera_init succeeded - but its PID is
     * not in the driver's table, so name, maximum size and the autofocus
     * verdict are all unknown. HELLO then reports sensorDetected false on a
     * sensor that is present, which is the honest answer and a bench fact
     * worth a line rather than a silent branch. */
    ESP_LOGW(TAG, "sensor PID 0x%04x not in the driver's table", sensor->id.PID);
  }

  /* Drop from the allocation size to the working default. Registers only; the
   * buffers stay cut for whatever init allocated, which is why this is safe in
   * this direction and would not be in the other. Guarded on the read-back
   * size, so a sensor the driver already clamped below the default is left
   * where it is. framesize_t is ordered smallest to largest. */
  if (s_framesize > CAMERA_DEFAULT_FRAMESIZE) {
    if (sensor->set_framesize(sensor, CAMERA_DEFAULT_FRAMESIZE) == 0) {
      s_framesize = CAMERA_DEFAULT_FRAMESIZE;
    } else {
      ESP_LOGW(TAG, "could not set the default framesize; staying at %d", (int)s_framesize);
    }
  }
  return ESP_OK;
}

const char *camsensor_name(void) { return s_detected ? s_name : NULL; }
bool camsensor_detected(void) { return s_detected; }
uint16_t camsensor_pid(void) { return s_detected ? s_pid : 0; }
bool camsensor_autofocus_capable(void) { return s_detected && s_pid == OV5640_PID; }
const char *camsensor_max_resolution(void) { return s_max_res[0] ? s_max_res : NULL; }

esp_err_t camsensor_set_quality(int quality) {
  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor == NULL) return ESP_ERR_INVALID_STATE;
  if (quality < 5) quality = 5;
  if (quality > 63) quality = 63;
  /* Already there: writing it again is a register transaction the viewfinder
   * would pay on every frame for no change in the picture. */
  if (quality == s_quality) return ESP_OK;
  if (sensor->set_quality(sensor, quality) != 0) return ESP_FAIL;
  s_quality = quality;
  return ESP_OK;
}

/**
 * Set the sensor's frame size.
 *
 * The two large sizes are the KDP `Resolution` type - what a capture is
 * stored at. The small ones are not on that type and deliberately never
 * will be: they exist for the rear-display viewfinder, where the whole point
 * is a frame small enough to cross a 921600-baud UART several times a second.
 *
 * The arithmetic is the reason they had to be added. A stored frame at
 * 1600x1200 or 2048x1536 measures 90-240 KB on this sensor
 * (SYNC_FEASIBILITY.md, "the next is 90-240 KB"; cam_link.c sizes the P4's RX
 * ring against the same figure). At 921600 baud, 8N1, that is 92160 B/s of
 * payload, so one camera costs 0.98-2.60 s of link time and a four-up
 * viewfinder would be a slideshow at well under 1 fps. The 7.7-30.4 KB figure
 * that used to be quoted here is uvc-preview's, and it is VGA in console mode
 * - a different size on a different link.
 */
esp_err_t camsensor_set_resolution(const char *resolution) {
  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor == NULL) return ESP_ERR_INVALID_STATE;
  framesize_t size;
  if (strcmp(resolution, "1600x1200") == 0) size = FRAMESIZE_UXGA;
  else if (strcmp(resolution, "2048x1536") == 0) size = FRAMESIZE_QXGA;
  else if (strcmp(resolution, "640x480") == 0) size = FRAMESIZE_VGA;
  else if (strcmp(resolution, "320x240") == 0) size = FRAMESIZE_QVGA;
  else if (strcmp(resolution, "160x120") == 0) size = FRAMESIZE_QQVGA;
  else return ESP_ERR_INVALID_ARG;
  /*
   * The one that matters. set_framesize rewrites a register block and the
   * sensor resyncs, dropping frames while it settles. The viewfinder asks for
   * 320x240 on every preview frame, so unconditionally writing this made the
   * finder pay a mode change per frame it showed - 0.8 fps measured on the
   * bench - and captures at UXGA/QXGA alternating with it kept the sensor
   * switching modes continuously.
   */
  if (size == s_framesize) return ESP_OK;
  if (sensor->set_framesize(sensor, size) != 0) return ESP_FAIL;
  s_framesize = size;

  /*
   * Throw away what is queued, because it is the previous size.
   *
   * With fb_count=2 and GRAB_LATEST the driver keeps capturing, so at the
   * moment the mode changes the queue still holds frames exposed at the old
   * framesize. The next fb_get hands one of those back and it is not the
   * picture that was asked for: a viewfinder that requested 320x240 was being
   * given a 130 KB frame left over from a 2048x1536 capture, which is larger
   * than VF_MAX_JPEG, so the finder rejected it and the pane read "no camera"
   * on a camera that was working perfectly.
   *
   * CAMERA_FB_QUEUE_DEPTH frames, because that is how many the queue can be
   * holding: fb_count - 1 under GRAB_LATEST, one buffer being the DMA target.
   * Draining fb_count would spend one extra whole frame period waiting for a
   * frame that was never queued. Costs a frame period per fetch and only on an
   * actual mode change, which the change-only guard above already makes rare.
   */
  for (int i = 0; i < CAMERA_FB_QUEUE_DEPTH; i++) {
    camera_fb_t *stale = esp_camera_fb_get();
    if (stale == NULL) break;
    esp_camera_fb_return(stale);
  }
  return ESP_OK;
}

/** True for the sizes that exist only to feed the viewfinder. */
bool camsensor_is_preview_resolution(const char *resolution) {
  return resolution != NULL &&
         (strcmp(resolution, "640x480") == 0 || strcmp(resolution, "320x240") == 0 ||
          strcmp(resolution, "160x120") == 0);
}

camera_fb_t *camsensor_capture(uint32_t *duration_ms, camsensor_timing_t *timing) {
  const int64_t start = esp_timer_get_time();
  camera_fb_t *fb = esp_camera_fb_get();
  const int64_t end = esp_timer_get_time();
  if (duration_ms != NULL) *duration_ms = (uint32_t)((end - start) / 1000);
  if (timing != NULL) {
    timing->duration_ms = (uint32_t)((end - start) / 1000);
    timing->fb_get_start_us = start;
    timing->fb_get_end_us = end;
    timing->fb_get_us = end - start;
    /* fb->timestamp is a struct timeval the driver fills at DMA arm. Folded
     * to microseconds here so the wire carries one number in the node's own
     * esp_timer domain - the same domain fb_get_start_us is in, which is what
     * makes the two comparable. */
    timing->frame_start_us =
        fb != NULL ? (int64_t)fb->timestamp.tv_sec * 1000000 + fb->timestamp.tv_usec : 0;
  }
  return fb;
}

void camsensor_release(camera_fb_t *fb) {
  if (fb != NULL) esp_camera_fb_return(fb);
}

uint32_t camsensor_discard_queued(void) {
  /*
   * Drops the oldest queued frame so the shutter does not photograph the past.
   *
   * This was written against fb_count=1, where the driver captured one frame
   * after each return and then stalled, handing back an image exposed up to
   * 134 s before the command. The config is now fb_count=2 with GRAB_LATEST,
   * which already bounds the queue to the one most recent frame, so the
   * pathological case is gone - but a queued frame is still a frame from
   * before the command, and dropping it here keeps the photograph causally
   * after the shutter press rather than one frame period ahead of it.
   *
   * Ask the driver first. esp_camera_available_frames() is
   * uxQueueMessagesWaiting on the frame queue, so it says whether a completed
   * frame is actually sitting there. With nothing queued this used to call
   * fb_get anyway and wait for the driver to fill a buffer: FB_GET_TIMEOUT is
   * 4000 ms, so a discard plus the capture that follows it was two 4 s waits
   * back to back on the node's only task - 8 s in which STATUS, HELLO and
   * RELEASE all go unanswered, and the P4's own capture budget expires. With
   * the gate the worst case is one fb_get, so one 4 s wait.
   *
   * This bounds the photograph to a frame period of the command.
   * It does not synchronise anything between cameras; that is the sync work
   * SYNC_FEASIBILITY.md scopes. It only stops the camera photographing the
   * past.
   */
  if (!esp_camera_available_frames()) return 0;
  const int64_t t0 = esp_timer_get_time();
  camera_fb_t *stale = esp_camera_fb_get();
  if (stale != NULL) esp_camera_fb_return(stale);
  return (uint32_t)((esp_timer_get_time() - t0) / 1000);
}
