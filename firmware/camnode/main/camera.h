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
