// The compositor: a landscape canvas, and the P4's pixel hardware between it
// and the panel.
//
// The UI is landscape and the panel is portrait, so something has to rotate.
// Doing it in the drawing primitives - writing each logical row down a column
// of the panel buffer - costs a 960-byte stride per pixel in PSRAM, which
// means a cache miss per pixel and a renderer that cannot animate. The
// ESP32-P4 has a Pixel-Processing Accelerator that rotates and alpha-blends
// whole frames in hardware, so the CPU draws into a plain linear landscape
// buffer and the PPA does the geometry.
//
// That is also what makes transitions smooth: a dissolve is one hardware
// blend per frame rather than 384000 CPU blends, and it is driven by the
// clock rather than by a frame counter, so it eases correctly whatever frame
// rate the memory bus actually delivers.
#ifndef P4_GFX_H
#define P4_GFX_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/** Register the PPA clients and take the panel's framebuffers. */
esp_err_t gfx_init(void);

/** True once the compositor owns a canvas and can present it. */
bool gfx_ready(void);

/**
 * The drawing surface: UI_W x UI_H, RGB565, row-major, no gaps.
 *
 * Landscape and linear, which is the whole point - a horizontal run is a
 * contiguous run of memory here, so fills and blits are sequential writes.
 */
uint16_t *gfx_canvas(void);

/** Rotate the canvas onto the back framebuffer and show it. */
void gfx_present(void);

/**
 * Remember the canvas as the starting point of the next dissolve.
 *
 * Call this, redraw the canvas into whatever should come next, then call
 * gfx_dissolve().
 */
void gfx_snapshot(void);

/**
 * Ease from the snapshot to the current canvas over `duration_ms`.
 *
 * Driven by elapsed time rather than a fixed number of frames: a dissolve
 * that counts frames and sleeps a fixed interval per frame stutters whenever
 * a frame runs long, because the motion is tied to how fast the frames
 * happen to land rather than to the clock.
 */
void gfx_dissolve(int duration_ms);

/** Frames presented and the time they took, for bandwidth checks. */
void gfx_stats(uint32_t *frames, uint32_t *last_ms);

#endif
