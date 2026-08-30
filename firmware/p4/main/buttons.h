// The camera's physical controls.
//
// A camera you have to look at to take a picture with is not a camera. The
// shutter is a button under a finger, and the screen is where you check what
// it did — so the button path exists in its own right and never routes
// through the UI.
//
// The shutter has a pin: GPIO28 on JP1 21, since ECN-0003 (2026-08-30), a
// 6x6 mm tactile switch to ground with the P4's pull-up on. The FN key does
// not, and this header does not invent one: an unassigned control is
// BOARD_BTN_NONE and is skipped at init. Reading a floating input would
// produce phantom presses, which is a far worse failure than a button that
// does nothing — a camera that fires by itself in a bag ruins the roll and
// the battery.
//
// Wiring the next one up is a single line in board_d4v1.h once a pin exists.
#ifndef P4_BUTTONS_H
#define P4_BUTTONS_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

typedef enum {
  BTN_SHUTTER = 0,
  BTN_FN,
  BTN_COUNT,
} button_id_t;

/**
 * What a press does. Registered by the UI so the button and the on-screen
 * key run exactly the same path — two ways to fire one shutter must not be
 * two implementations of it.
 */
typedef void (*button_handler_t)(button_id_t id, bool long_press);

/** Configure whichever controls have a pin. Safe with none fitted. */
esp_err_t buttons_init(void);

/** True when at least one control has a pin and is being read. */
bool buttons_fitted(void);

void buttons_on_press(button_handler_t handler);

/** True while the shutter is physically held. */
bool button_held(button_id_t id);

#endif
