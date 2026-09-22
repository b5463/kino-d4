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

/**
 * Draw through a view instead of the target proper, until cleared with NULL.
 *
 * A view is a target whose window is a sub-rectangle of the real one with its
 * origin moved: drawing code that thinks it is at (0, 0) lands wherever the
 * view says, clipped to it. This is how a move draws a whole screen into a
 * growing card, or a menu column shifted sideways, with the screen's own
 * drawing code and no copy of anything.
 */
void gfx_target_view(const gfx_target_t *view);

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
 * Which drawing pass this is. Goes up once per gfx_render() or
 * gfx_render_canvas(), and stays the same across the many calls of `draw`
 * inside one tile pass - so drawing code that gathers state it does not need
 * to gather seventy times a frame can key a cache on it.
 */
uint32_t gfx_pass_id(void);

/** Run `draw` through the tile pass and time only the drawing; nothing is
 *  written out or shown. For finding out what a screen costs on the bench. */
uint32_t gfx_measure_draw_us(gfx_draw_fn draw, void *ctx);

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

/**
 * One screen pushing the other off, one frame at a time, composed in the
 * panel's own orientation. gfx_snapshot() first (the screen leaving), then
 * draw the screen arriving into the stash (gfx_render_stash) and call
 * gfx_slide_prepare() once; each frame gfx_slide_show() shows `o` columns of
 * the arriving screen from its edge with the leaving one moved `b` columns
 * the other way. `from_right` is where the NEW screen comes from; deeper is
 * rightward. Counts as a frame and waits for the panel like one.
 */
void gfx_slide_prepare(void);
void gfx_slide_show(int o, int b, bool from_right);

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
/** Draw a frame straight into the stash, and read it back: for a move whose
 *  card is a screen too costly to draw every frame (the finder's four live
 *  panes, a page of thumbnails), drawn once here and blitted from here. */
void gfx_render_stash(gfx_draw_fn draw, void *ctx);
const uint16_t *gfx_stash_px(void);

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

/** Frames presented and the time they took, for bandwidth checks. */
void gfx_stats(uint32_t *frames, uint32_t *last_ms);

/** Microseconds spent presenting (rotate plus hand-over) since boot. */
uint64_t gfx_present_us_total(void);

/** Microseconds spent drawing, writing tiles out, and waiting for the panel's
 *  refresh end, since boot. */
void gfx_pass_split(uint64_t *draw_us, uint64_t *xpose_us, uint64_t *vsync_us);

#endif
