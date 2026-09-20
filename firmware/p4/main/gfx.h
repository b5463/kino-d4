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

/**
 * The drawing target: a window onto the logical UI_W x UI_H screen.
 *
 * `px` holds `w` x `h` pixels, `stride` per row, with logical (x0, y0) at
 * px[0]. Pixels outside the window are not stored anywhere and every
 * primitive clips to it. The whole canvas is the window most of the time;
 * a tile renderer makes it a band of the screen in internal SRAM and runs the
 * same drawing code once per band, which is how a frame reaches the panel
 * without a landscape copy of it in PSRAM to rotate.
 */
typedef struct {
  uint16_t *px;
  int x0, y0, w, h;
  int stride;
} gfx_target_t;

const gfx_target_t *gfx_target(void);

/** Rotate the canvas onto the back framebuffer and show it. */
void gfx_present(void);

/** A frame's drawing code: draws the whole logical screen into gfx_target(). */
typedef void (*gfx_draw_fn)(void *ctx);

/**
 * Draw a frame and put it on the panel.
 *
 * The one way a frame reaches the screen. The compositor decides where
 * `draw` draws - the whole canvas, or one band of the screen at a time in
 * internal SRAM, written to the portrait framebuffer transposed - and `draw`
 * must be a pure function of the UI's state: it may be called several times
 * for one frame, and every call must draw the same picture.
 */
void gfx_render(gfx_draw_fn draw, void *ctx);

/**
 * Draw a frame into the landscape canvas in PSRAM and leave it there, so a
 * transition can keep it (gfx_stash, gfx_layer_keep, gfx_snapshot, the push
 * and the dissolve all read the canvas). Nothing reaches the panel.
 */
void gfx_render_canvas(gfx_draw_fn draw, void *ctx);

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

/** One screen pushing the other off. `from_right` is where the NEW frame
 *  comes from; deeper is rightward. Needs gfx_snapshot() first, as the
 *  dissolve does. */
void gfx_slide(int duration_ms, bool from_right);

/** A rectangle the compositor can move on its own. */
typedef struct {
  int16_t x, y, w, h;
} gfx_band_t;

/**
 * Keep the frame just drawn, and hand pieces of it back.
 *
 * For a transition that has to be DRAWN rather than composited: stash the
 * destination, draw each frame of the move yourself with the real fonts, and
 * blit in the part of the destination that has arrived. gfx_stash_blit()
 * copies from the stash into the canvas and clips both ends.
 */
void gfx_stash(void);
void gfx_stash_blit(int dx, int dy, int sx, int sy, int w, int h);

/**
 * A second retained layer, for the parts of a move that only translate.
 *
 * The stash holds where a transition is GOING. This holds a picture that is
 * simply being carried around: draw it once with gfx_layer_keep(), then blit
 * the pieces each frame instead of drawing them again.
 *
 * It is the one idea this renderer takes from a scene graph, and it is worth
 * taking because of what it does to the frame's cost CURVE. A move that
 * redraws its contents costs whatever those contents happen to cost at that
 * phase; a move that blits them costs the same on every frame. Even frames
 * are what the eye reads as smooth - more than fast ones.
 */
void gfx_layer_keep(void);
void gfx_layer_blit(int dx, int dy, int sx, int sy, int w, int h);

/**
 * A list arriving, one row at a time, over the frame already drawn.
 *
 * The bands come in from the right in order, staggered. `ground` is what is
 * behind them - the page's own background, because the row is not there yet.
 * Does not need a snapshot: everything it composites is the new frame.
 */
void gfx_cascade(int duration_ms, const gfx_band_t *bands, int n, uint16_t ground);

/** Frames presented and the time they took, for bandwidth checks. */
void gfx_stats(uint32_t *frames, uint32_t *last_ms);

/** Microseconds spent presenting (rotate plus hand-over) since boot. */
uint64_t gfx_present_us_total(void);

/** Microseconds a render pass has spent drawing and writing tiles out, since boot. */
void gfx_pass_split(uint64_t *draw_us, uint64_t *xpose_us);

#endif
