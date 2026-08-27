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

/** Capture one JPEG frame. Caller owns the buffer until camsensor_release(). */
camera_fb_t *camsensor_capture(uint32_t *duration_ms);
void camsensor_release(camera_fb_t *fb);

#endif
