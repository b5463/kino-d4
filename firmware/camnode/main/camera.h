// Sensor abstraction for the camera node. Identity comes from the detected
// SCCB PID — never from a compile-time assumption (OV3660 today, OV5640_AF
// planned). Milestone 1 exposes detect + single capture only.
#ifndef CAMNODE_CAMERA_H
#define CAMNODE_CAMERA_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_camera.h"
#include "esp_err.h"

esp_err_t camsensor_init(void);

/** Detected sensor name ("OV3660", "OV5640", ...) or NULL when no sensor
 * answered the bus. */
const char *camsensor_name(void);
bool camsensor_detected(void);

/** Detected SCCB product id (e.g. 0x3660, 0x5640), 0 when none. */
uint16_t camsensor_pid(void);

/** True when the detected sensor model supports VCM autofocus (OV5640).
 * Says nothing about the module's AFVDD wiring — that is bench work. */
bool camsensor_autofocus_capable(void);

/** JPEG quality, esp32-camera scale (lower is better). Clamped to 5..63. */
esp_err_t camsensor_set_quality(int quality);

/** "WIDTHxHEIGHT" for the sensor's maximum JPEG frame, NULL when unknown. */
const char *camsensor_max_resolution(void);

/**
 * The capture knobs NL_CMD_SENSOR carries, one `has_` flag per field.
 *
 * A flag is what separates "leave this alone" from a real value, and every
 * one of these has a meaningful zero: aeLevel 0 is the metering target the
 * sensor boots at, denoise 0 is denoise off, sharpness 0 is neutral. Without
 * the flags a request that only wants to change the gain ceiling would drag
 * three other knobs to zero with it.
 *
 * `gain_ceiling` is an X-FACTOR (2, 4, 8, 16, 32, 64, 128), not the
 * gainceiling_t ordinal the driver takes — the wire carries the number a
 * person can reason about and camsensor_apply() does the conversion.
 *
 * `quality` is the esp32-camera scale, 5..63, LOWER is better.
 */
typedef struct {
  bool has_ae_level;
  int ae_level;      /* -2..2 */
  bool has_gain_ceiling;
  int gain_ceiling;  /* x-factor 2..128 */
  bool has_denoise;
  int denoise;       /* 0..8 */
  bool has_sharpness;
  int sharpness;     /* -3..3 */
  bool has_quality;
  int quality;       /* 5..63, lower is better */
} camsensor_settings_t;

/**
 * Write the requested knobs into the sensor, clamped to what the detected
 * part actually accepts (ov3660.c is the reference for every range).
 *
 * Only the fields `in` flags are touched. `applied`, when given, receives the
 * node's whole last-applied set — not just this call's fields — because that
 * is what the SENSOR reply and NL_CMD_STATUS both report, and a caller that
 * sends one field still wants to know what the sensor is sitting at.
 *
 * A field the driver refuses, or that the detected sensor has no setter for,
 * is left out of the last-applied set rather than recorded as a success. The
 * P4 stores this in META.JSON, so claiming a value that never reached a
 * register would put a wrong exposure in the photograph's own record.
 *
 * ESP_ERR_INVALID_STATE when no sensor answered the bus.
 */
esp_err_t camsensor_apply(const camsensor_settings_t *in, camsensor_settings_t *applied);

/** The last-applied set, for NL_CMD_STATUS. All flags false until something
 * has actually been written since boot. */
void camsensor_applied(camsensor_settings_t *out);

/**
 * Switch frame size.
 *
 * Capture sizes are "1600x1200" and "2048x1536" — the KDP `Resolution` type.
 * Viewfinder sizes are "640x480", "320x240" and "160x120", which are
 * deliberately NOT on that type: they exist only to be small enough to cross
 * the node UART several times a second, and a capture must never be stored at
 * one of them.
 */
esp_err_t camsensor_set_resolution(const char *resolution);

/** True for the sizes that exist only to feed the viewfinder. */
bool camsensor_is_preview_resolution(const char *resolution);

/**
 * What one esp_camera_fb_get() call did, in the node's own esp_timer domain.
 *
 * This exists for the stale-frame question firmware/SYNC_FEASIBILITY.md
 * raises. With fb_count=1 the driver captures one frame after the buffer is
 * released and then stalls, so a later fb_get() can return that already-queued
 * frame immediately - a photograph of the moment after the PREVIOUS readout
 * rather than of the shutter.
 *
 * The signature is `fb_get_us` near zero with `frame_start_us` far behind the
 * request. Both are recorded here so M1 can see it on the first session
 * instead of inferring it.
 */
typedef struct {
  uint32_t duration_ms;   /* wall time inside esp_camera_fb_get() */
  int64_t fb_get_start_us;/* node esp_timer before the call */
  int64_t fb_get_end_us;  /* node esp_timer after it returned */
  int64_t fb_get_us;      /* end - start, microseconds */
  /* camera_fb_t.timestamp: "Timestamp since boot of the first DMA buffer of
   * the frame", written by cam_start_frame() when DMA is armed. This is FRAME
   * START, not exposure start and not exposure centre - a rolling shutter
   * integrates per row. Named for what the driver documents. */
  int64_t frame_start_us;
} camsensor_timing_t;

/** Capture one JPEG frame. Caller owns the buffer until camsensor_release().
 * `timing` may be NULL. */
camera_fb_t *camsensor_capture(uint32_t *duration_ms, camsensor_timing_t *timing);

/**
 * esp_timer time of the last register write that changes how a frame is
 * ENCODED (quality, framesize). A photograph must come from a frame armed
 * after this instant - fb->timestamp / timing.frame_start_us is in the same
 * domain - or its bottom may be quantised under two different tables. Zero
 * until the first change after boot.
 */
int64_t camsensor_encoding_changed_us(void);
void camsensor_release(camera_fb_t *fb);

/**
 * Fetch and throw away whatever frame the driver already has queued, so the
 * next camsensor_capture() starts a frame AFTER this call rather than
 * returning one exposed before the command arrived.
 *
 * Only fetches when the driver reports a queued frame. With the queue empty it
 * returns 0 immediately rather than blocking a whole FB_GET_TIMEOUT (4000 ms)
 * waiting for one, which would double the worst-case cost of a capture on the
 * node's single task. Returns the milliseconds it cost, so a caller can report
 * what the discard, rather than the exposure, paid for. See
 * SYNC_FEASIBILITY.md, "Stale frames". */
uint32_t camsensor_discard_queued(void);

#endif
