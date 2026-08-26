// The camera's own screen: 4.3" 480x800 ST7701S over MIPI-DSI.
//
// Bring-up only at this stage. Nothing here is on the KDP path and nothing
// here may fail loudly: the panel is the newest, least proven peripheral on
// the board, and KDP over USB is how this device is diagnosed and recovered.
// A display that cannot start must leave a camera that can still be talked
// to, so every entry point returns a status the caller is free to ignore.
#ifndef P4_DISPLAY_H
#define P4_DISPLAY_H

#include <stdbool.h>

#include "esp_err.h"

/** Panel geometry, native orientation. The panel is portrait; the product is
 *  held landscape, so content will be rotated later — first light does not
 *  care which way up a colour band is. */
#define DISPLAY_H_RES 480
#define DISPLAY_V_RES 800

/**
 * Power the DSI PHY, reset the panel, start the DSI bus, run the ST7701
 * initialisation and raise the backlight. Safe to call once, after the KDP
 * server is serving.
 */
esp_err_t display_init(void);

/** True once the panel is initialised and drawable. */
bool display_ready(void);

/**
 * Five full-width colour bands, top to bottom in the panel's own
 * orientation: red, green, blue, white, black.
 *
 * A single flat fill would only prove the backlight works. The band order
 * reports three things at once from one look: whether the panel scans out at
 * all, whether the pixel format is RGB565 the way we think it is (a swapped
 * order shows blue where red should be), and which physical edge is row zero,
 * which is what the landscape rotation has to be built against.
 */
esp_err_t display_test_pattern(void);

#endif
