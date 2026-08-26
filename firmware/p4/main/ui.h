// The camera's on-screen UI.
//
// Landscape, following the reference camera: a row of four camera indicators
// across the top and a 2x3 grid of large touch tiles below. The panel is
// 480x800 portrait, so everything here is laid out in logical landscape
// coordinates (800x480) and transposed on the way to the framebuffer.
//
// This first pass carries no text and no icons on purpose. Orientation, the
// touch-to-pixel mapping and the press feedback all have to be right before a
// UI toolkit is worth adding, and a wrong transpose is much easier to see in
// six plain rectangles than under a layer of widgets.
#ifndef P4_UI_H
#define P4_UI_H

#include <stdbool.h>

#include "esp_err.h"

/** Logical landscape space. The panel's long axis runs horizontally. */
#define UI_W 800
#define UI_H 480

/** Start the UI. Requires display_init(); touch is optional. */
esp_err_t ui_start(void);

#endif
