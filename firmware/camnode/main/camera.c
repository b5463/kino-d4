#include "camera.h"

#include <string.h>

#include "board_xiao_s3.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

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

/* What NL_CMD_SENSOR has actually got into the sensor since this node booted.
 * Reported by the SENSOR reply and by NL_CMD_STATUS, and it is what the P4
 * writes into META.JSON - so nothing may be recorded here that a driver call
 * did not accept. Cleared by camsensor_init(): after a reset the sensor is at
 * whatever esp_camera_init() left, and the honest answer is "nothing applied"
 * rather than a set of numbers carried over from the previous boot. */
static camsensor_settings_t s_applied;

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

  /* Back to driver defaults: nothing has been applied on this boot. The JPEG
   * quality is the one exception and it is seeded from the read-back rather
   * than from the config literal above, for the same reason s_quality is -
   * esp_camera_init can clamp, and STATUS must report the sensor, not the
   * request. The other four have no honest seed: ov3660's status fields for
   * gainceiling and sharpness hold raw register contents, not the wire units
   * this struct is in, and converting one into the other would be an invented
   * number in a field the P4 stores in a photograph's metadata. */
  memset(&s_applied, 0, sizeof s_applied);
  s_applied.has_quality = true;
  s_applied.quality = s_quality;

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
    /*
     * The sensor answered SCCB and esp_camera_init SUCCEEDED - so it is
     * present, initialised and streaming - but its PID is absent from
     * esp_camera_sensor_get_info's table, so the name, the maximum frame size
     * and the autofocus verdict are unknown.
     *
     * s_detected used to be left false here, and camsensor_detected() gates
     * handle_capture: a working camera answered every CAPTURE with
     * HARDWARE_ERROR "No sensor detected" because a lookup table did not know
     * its part number. Unknown is not absent. It is detected, with the three
     * unknown fields left unknown: s_name carries the PID so a bench line
     * names something real, s_max_res stays empty (HELLO reports null, and
     * the resolution the P4 asks for is validated by set_framesize either
     * way) and autofocus stays false, which is what an unknown sensor is
     * entitled to claim.
     */
    s_pid = sensor->id.PID;
    s_detected = true;
    snprintf(s_name, sizeof s_name, "pid-0x%04x", sensor->id.PID);
    s_max_res[0] = '\0';
    ESP_LOGW(TAG,
             "sensor PID 0x%04x not in the driver's table; reporting it as "
             "detected with name/maxSize/autofocus unknown",
             sensor->id.PID);
  }

  /*
   * What the sensor thinks its exposure loop is doing, once, at boot.
   *
   * Diagnostic for issue #156: every camera returned a near-black frame in a
   * well-lit room (measured mean luma 5.3/255 on a 1600x1200 still pulled off
   * the card), and this node has never configured auto-exposure at all - it
   * writes ae_level and gainceiling, which are trims ON TOP of a loop nobody
   * enables, and inherits whatever esp_camera_init left behind. The driver's
   * reset() loads sensor_default_regs and 0x3503 (AEC/AGC manual enable) is
   * not in that table, so AE is nominally automatic - which the black frames
   * contradict. Printing the sensor's own view is cheaper than reasoning
   * about which of the two is wrong.
   *
   * init_status() has just read these back off the part, so they are the
   * hardware's answer rather than a copy of a request. One line, at boot,
   * on a path that runs once.
   */
  ESP_LOGI(TAG,
           "AE at boot: aec=%u aec2=%u agc=%u ae_level=%d aec_value=%u agc_gain=%u "
           "gainceiling=%u awb=%u awb_gain=%u wb_mode=%u",
           sensor->status.aec, sensor->status.aec2, sensor->status.agc,
           (int)sensor->status.ae_level, sensor->status.aec_value, sensor->status.agc_gain,
           sensor->status.gainceiling, sensor->status.awb, sensor->status.awb_gain,
           sensor->status.wb_mode);

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

/*
 * When a register that shapes the JPEG ENCODING last changed, esp_timer time.
 *
 * The OV3660 encodes in-sensor while it free-runs, and a quality write landing
 * mid-readout re-tables the quantiser under the frame currently being output:
 * the top of that frame is old-quality, the bottom is garbage. Bench
 * KD4-D121BC, 2026-08-31: three 320x240 previews (register at the finder's
 * quality) then a UXGA capture at the look's quality 9 stored CAP_000611/612
 * with the bottom ~15% as coloured noise - a valid EOI, a matching CRC, and a
 * ruined photograph, because the CRC covers what the sensor emitted.
 *
 * The photograph path compares this against fb->timestamp (stamped at DMA
 * arm): a frame ARMED after the write was encoded wholly under the new
 * tables; a frame armed before it may not have been. Previews do not check -
 * one soft preview frame is invisible at 3 fps, and the finder is the thing
 * writing the register in the first place.
 */
static int64_t s_encode_changed_us;

int64_t camsensor_encoding_changed_us(void) { return s_encode_changed_us; }

esp_err_t camsensor_set_quality(int quality) {
  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor == NULL) return ESP_ERR_INVALID_STATE;
  if (quality < 5) quality = 5;
  if (quality > 63) quality = 63;
  /* Already there: writing it again is a register transaction the viewfinder
   * would pay on every frame for no change in the picture. */
  if (quality == s_quality) return ESP_OK;
  if (sensor->set_quality(sensor, quality) != 0) return ESP_FAIL;
  s_encode_changed_us = esp_timer_get_time();
  s_quality = quality;
  s_applied.has_quality = true;
  s_applied.quality = quality;
  return ESP_OK;
}

/*
 * Clamping and unit conversion for NL_CMD_SENSOR, per ov3660.c.
 *
 * Every range below is read off the driver, not off a datasheet: the setters
 * return -1 for an out-of-range value and the caller cannot tell that apart
 * from an SCCB failure, so anything out of range is clamped here rather than
 * refused. The one range that is NARROWER than the driver's is ae_level -
 * ov3660 takes -5..5, node_link.h fixes the wire at -2..2 because that is the
 * span Studio's exposureBias slider covers and a wider wire would let a
 * request through that no user interface can produce or undo.
 */
#define AE_LEVEL_MIN (-2)      /* node_link.h contract; driver allows -5..5 */
#define AE_LEVEL_MAX 2
#define DENOISE_MIN 0          /* ov3660.c set_denoise: level < 0 || level > 8 */
#define DENOISE_MAX 8
#define SHARPNESS_MIN (-3)     /* ov3660.c set_sharpness: level > 3 || level < -3 */
#define SHARPNESS_MAX 3

static int clamp_int(int v, int lo, int hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/*
 * X-factor to gainceiling_t, snapping to the nearest legal step.
 *
 * sensor.h's gainceiling_t is an ordinal 0..6 for 2X..128X, so the wire's
 * x-factor is a log2 lookup and not an arithmetic conversion. A look's
 * `gainLimit` is an arbitrary number (the factory looks carry 12 and 16), so
 * anything between two steps is snapped; a tie goes DOWN, to the cleaner of
 * the two, because the alternative is silently granting a look more noise than
 * it asked for.
 *
 * What this does NOT claim: on the OV3660 the driver writes the ordinal
 * straight into the AEC gain-ceiling registers 0x3A18/0x3A19 rather than a
 * gain value, so how much this moves the picture is a bench question. It is
 * the only gain-ceiling API esp32-camera exposes, and `applied` reports the
 * step that was written, so the card records what the sensor was told.
 */
/*
 * The gain ceiling, in the units the SENSOR wants - which are not the units
 * the driver's prototype claims.
 *
 * esp32-camera types set_gainceiling() as taking a gainceiling_t enum
 * (GAINCEILING_2X..128X = 0..6), and for OV2640 that is what it is. The
 * OV3660 implementation ignores the enum meaning entirely and writes the
 * number straight into the AEC gain-ceiling registers:
 *
 *     write_reg(0x3A18, (l >> 8) & 3); write_reg(0x3A19, l & 0xFF);
 *
 * Those hold a 10-bit ceiling in 1/16 steps, so the value IS the gain times
 * sixteen. The part's own power-on default is 248 = 15.5x, read back on the
 * bench at boot.
 *
 * Passing the enum therefore asked for a ceiling of 3, which is 0.19x - the
 * AGC was forbidden from applying any gain at all. Measured consequence
 * (issue #156): agc_gain pinned at 2 of 30 and a mean luma of 5.3/255 in a
 * well-lit room on all four cameras, with only an emissive subject like a
 * monitor bright enough to register. Nothing wrote this register before the
 * sensor path landed in 0.4.9, so the sensors ran on their sane 15.5x default
 * until the firmware "configured" them.
 *
 * OV2640 keeps the enum: the same call means two different things depending
 * on the part, so the conversion has to know which part it is talking to.
 */
static int gainceiling_raw_for_sensor(int pid, int factor, int *snapped) {
  static const int FACTORS[] = {2, 4, 8, 16, 32, 64, 128};
  const int n = (int)(sizeof FACTORS / sizeof FACTORS[0]);
  int best = 0;
  for (int i = 1; i < n; i++) {
    const int d_best = factor > FACTORS[best] ? factor - FACTORS[best] : FACTORS[best] - factor;
    const int d_i = factor > FACTORS[i] ? factor - FACTORS[i] : FACTORS[i] - factor;
    if (d_i < d_best) best = i; /* strictly less: a tie keeps the lower step */
  }
  if (pid == OV3660_PID) {
    /* 1/16 steps, ten bits. 64x is the ceiling the registers can express
     * (1023/16); the wire allows 128x, so it snaps down rather than wrapping
     * into the two high bits of 0x3A18. */
    int raw = FACTORS[best] * 16;
    if (raw > 1023) {
      raw = 64 * 16;
      best = 5; /* 64x */
    }
    if (snapped != NULL) *snapped = FACTORS[best];
    return raw;
  }
  if (snapped != NULL) *snapped = FACTORS[best];
  return (int)(GAINCEILING_2X + best);
}

esp_err_t camsensor_apply(const camsensor_settings_t *in, camsensor_settings_t *applied) {
  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor == NULL) return ESP_ERR_INVALID_STATE;
  if (in == NULL) {
    if (applied != NULL) *applied = s_applied;
    return ESP_OK;
  }

  /* Each knob: clamp, write, and only then record. A setter that returns
   * non-zero leaves the previous last-applied value in place - the sensor did
   * not move, so neither does the record the P4 puts in META.JSON. */
  if (in->has_ae_level && sensor->set_ae_level != NULL) {
    const int v = clamp_int(in->ae_level, AE_LEVEL_MIN, AE_LEVEL_MAX);
    if (sensor->set_ae_level(sensor, v) == 0) {
      s_applied.has_ae_level = true;
      s_applied.ae_level = v;
    } else {
      ESP_LOGW(TAG, "sensor refused aeLevel %d", v);
    }
  }
  if (in->has_gain_ceiling && sensor->set_gainceiling != NULL) {
    int snapped = 0;
    const int raw = gainceiling_raw_for_sensor(s_pid, in->gain_ceiling, &snapped);
    if (sensor->set_gainceiling(sensor, (gainceiling_t)raw) == 0) {
      s_applied.has_gain_ceiling = true;
      s_applied.gain_ceiling = snapped;
    } else {
      ESP_LOGW(TAG, "sensor refused gainCeiling %dX", snapped);
    }
  }
  if (in->has_denoise && sensor->set_denoise != NULL) {
    const int v = clamp_int(in->denoise, DENOISE_MIN, DENOISE_MAX);
    if (sensor->set_denoise(sensor, v) == 0) {
      s_applied.has_denoise = true;
      s_applied.denoise = v;
    } else {
      ESP_LOGW(TAG, "sensor refused denoise %d", v);
    }
  }
  if (in->has_sharpness && sensor->set_sharpness != NULL) {
    const int v = clamp_int(in->sharpness, SHARPNESS_MIN, SHARPNESS_MAX);
    if (sensor->set_sharpness(sensor, v) == 0) {
      s_applied.has_sharpness = true;
      s_applied.sharpness = v;
    } else {
      ESP_LOGW(TAG, "sensor refused sharpness %d", v);
    }
  }
  /* Through camsensor_set_quality, not the setter directly: that function owns
   * the 5..63 clamp, the change-only guard the viewfinder depends on, and the
   * s_quality cache the CAPTURE path compares against. Two places writing the
   * same register with two caches is how the finder ends up paying a register
   * transaction per frame again. */
  if (in->has_quality) {
    if (camsensor_set_quality(in->quality) != ESP_OK) {
      ESP_LOGW(TAG, "sensor refused quality %d", in->quality);
    }
  }

  if (applied != NULL) *applied = s_applied;
  return ESP_OK;
}

void camsensor_applied(camsensor_settings_t *out) {
  if (out != NULL) *out = s_applied;
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
  s_encode_changed_us = esp_timer_get_time();
  /*
   * What the sensor ACCEPTED, read back - not what was requested.
   *
   * This recorded `size`. A driver that clamps (or returns 0 having written
   * nothing) then left s_framesize claiming a mode the sensor is not in, and
   * the change-only guard above turned the next REAL request for that mode
   * into a no-op returning ESP_OK. The viewfinder would have gone on being
   * served capture-sized frames while every call said it had switched.
   *
   * status.framesize is the driver's own record of the last accepted write.
   * If it disagrees with the request the guard now re-attempts next time,
   * which is the behaviour that recovers.
   */
  s_framesize = sensor->status.framesize;
  if (s_framesize != size) {
    ESP_LOGW(TAG, "set_framesize %d accepted as %d", (int)size, (int)s_framesize);
  }

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
    /*
     * Ask the driver first, the way camsensor_discard_queued() does and for
     * the same reason. A bare fb_get() on an empty queue blocks for the
     * driver's 4000 ms, and this runs before a capture's budget has even
     * started - so a mode change with nothing queued could spend the P4's
     * whole timeout before the photograph was attempted (#205). The comment
     * above says this costs a frame period per fetch, and that is only true
     * when a frame is actually coming.
     */
    if (!esp_camera_available_frames()) break;
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
  /* The driver's own ceiling, for the callers that have no deadline of their
   * own. A capture always has one - see camsensor_capture_by(). */
  return camsensor_capture_by(esp_timer_get_time() + 4000 * 1000, duration_ms, timing);
}

camera_fb_t *camsensor_capture_by(int64_t deadline_us, uint32_t *duration_ms,
                                  camsensor_timing_t *timing) {
  const int64_t start = esp_timer_get_time();
  /*
   * Wait for a frame to be queued rather than inside the fetch.
   *
   * esp_camera_available_frames() is the same question camsensor_discard_queued
   * asks. Once it is true the fetch returns at once, so the only waiting
   * happens here, where the deadline can be seen. 5 ms steps: the sensor's
   * frame period is about 112 ms, so this costs at most a couple of percent of
   * one and never misses a frame by more than that.
   */
  while (!esp_camera_available_frames()) {
    if (esp_timer_get_time() >= deadline_us) {
      const int64_t gave_up = esp_timer_get_time();
      if (duration_ms != NULL) *duration_ms = (uint32_t)((gave_up - start) / 1000);
      if (timing != NULL) {
        timing->duration_ms = (uint32_t)((gave_up - start) / 1000);
        timing->fb_get_start_us = start;
        timing->fb_get_end_us = gave_up;
        timing->fb_get_us = gave_up - start;
        timing->frame_start_us = 0;
      }
      return NULL;
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
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

/*
 * Smallest byte count that can be a real JPEG from this sensor.
 *
 * A bare JFIF header with quantisation and Huffman tables is already about
 * 600 bytes before a single MCU, and the smallest size this node is ever
 * asked for is 160x120. 512 is comfortably below any real frame and
 * comfortably above the handful of bytes a stalled DMA leaves behind, which
 * is the case this bound is for.
 */
#define JPEG_MIN_BYTES 512

/*
 * How far back from the end EOI is looked for.
 *
 * FFD9 should be the final two bytes, but the DMA writes in fixed-size bursts
 * and drivers pad the tail, so a strict last-two-bytes test would reject good
 * frames. 64 bytes is longer than any padding observed and short enough that
 * a frame missing its whole last row still fails.
 */
#define JPEG_EOI_SEARCH 64

bool camsensor_jpeg_valid(const camera_fb_t *fb, const char **why) {
  if (fb == NULL || fb->buf == NULL) {
    if (why != NULL) *why = "no frame";
    return false;
  }
  if (fb->format != PIXFORMAT_JPEG) {
    /* The node asked for JPEG and never reconfigures the format, so this can
     * only mean the driver handed back something else - a case that used to
     * be CRC'd and shipped as a photograph. */
    if (why != NULL) *why = "not JPEG pixel format";
    return false;
  }
  if (fb->len < JPEG_MIN_BYTES) {
    if (why != NULL) *why = "implausibly short";
    return false;
  }
  if (fb->buf[0] != 0xFF || fb->buf[1] != 0xD8) {
    if (why != NULL) *why = "no SOI";
    return false;
  }
  /* EOI, which is the marker a truncated encode actually loses. The P4
   * checked SOI only, and a frame cut off at 90% keeps its SOI. */
  const size_t back = fb->len < JPEG_EOI_SEARCH ? fb->len : JPEG_EOI_SEARCH;
  for (size_t i = fb->len - back; i + 1 < fb->len; i++) {
    if (fb->buf[i] == 0xFF && fb->buf[i + 1] == 0xD9) return true;
  }
  if (why != NULL) *why = "no EOI";
  return false;
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
