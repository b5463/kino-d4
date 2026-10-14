/*
 * The body's own screen over KDP (#246): GET_SCREEN, SCREEN_PLATE, UI_TAP and
 * UI_KEY, the Screen group, capability `screenControl`.
 *
 * A bench has to see the panel and press it without a person at the camera:
 * the palette on the real glass, the launch shade, the review shutter and the
 * pocket sleep were all checked by hand on 0.4.62 because nothing else could.
 *
 * This module answers on the KDP task and never draws. It asks the UI task
 * (ui.h, "The screen over KDP") and reads what the UI task left in the canvas.
 * GET_SCREEN renders through gfx_render_canvas() into the canvas the body
 * already has; the only allocation is one 3 KB page buffer in PSRAM, made on
 * the first page. Every build answers: the USB host can already capture and
 * delete, so a tap or a key gives it nothing it did not have.
 */
#ifndef P4_KDP_UI_H
#define P4_KDP_UI_H

#include <stdint.h>

#include "cJSON.h"
#include "kdp_module.h"

/** One of the four Screen commands. `req` is the parsed JSON body, or NULL. */
kdp_module_reply_t kdp_ui_handle(uint8_t cmd, const cJSON *req);

#endif
