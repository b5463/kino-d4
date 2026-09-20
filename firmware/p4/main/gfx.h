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
 * Nothing today: every present is synchronous. A caller that presents and
 * then sleeps or restarts says so with this, so that a compositor which
 * defers the hand-over has one place to land the last frame. (One was built
 * and measured; see gfx.c for why it is not in use.)
 */
void gfx_flush(void);

/**
 * Present the canvas with one rectangle of it taken from the STASH.
 *
 * For a move whose destination has arrived inside a growing card: the
 * card's rectangle (x, y, w, h) is rotated straight out of the stash into
 * the panel, read from stash row `sy` (0 for a card hung from the arriving
 * screen's top edge), and the canvas round it is rotated as usual, so the
 * CPU never copies the card - at the end of an open move that copy was a
 * whole screen per frame. The caller draws everything outside the rectangle
 * as normal and nothing inside it. Falls back to copying through the canvas
 * if block rotates were found not to land exactly at init.
 */
void gfx_present_with_stash(int x, int y, int w, int h, int sy);

/** Whether block rotates were verified at init; a caller that skips drawing
 *  a region it means to present from the stash must check this first. */
bool gfx_blocks_ok(void);

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
/** Stash what is ON THE PANEL rather than what was just drawn. The same
 *  buffer today; kept apart at the call sites so a compositor that keeps
 *  them apart does not have to find them. */
void gfx_stash_shown(void);

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
/** Keep what is on the panel, not what was just drawn - see gfx_stash_shown(). */
void gfx_layer_keep_shown(void);

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

#endif
