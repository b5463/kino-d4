// GT911 capacitive touch on the camera's own screen.
//
// Separate from display.c on purpose: the panel can light without touch
// working, touch can answer without the panel drawing, and during bring-up
// each needs to fail without taking the other down. Neither may take KDP with
// it.
#ifndef P4_TOUCH_H
#define P4_TOUCH_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/**
 * Bring up the I2C bus and the GT911. Safe to call after display_init();
 * failure is a reported state, never fatal.
 */
esp_err_t touch_init(void);

/** True once the controller answered and is being polled. */
bool touch_ready(void);

/**
 * Most recent touch, in the panel's native coordinate space (480x800, the
 * same space display.c draws in). Returns false when nothing is down.
 *
 * Native rather than rotated: the UI rotation is not decided yet, and a
 * driver that silently pre-rotates is a driver you cannot use to work out
 * what the rotation should be.
 */
bool touch_get(uint16_t *x, uint16_t *y);

/** Total touches seen since boot — a cheap "is the panel wired" counter. */
uint32_t touch_count(void);

#endif
