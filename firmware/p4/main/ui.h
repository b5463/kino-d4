// The camera's on-screen UI.
//
// Landscape, following the reference camera: a row of four camera indicators
// across the top and a 2x3 grid of large touch tiles below. The panel is
// 480x800 portrait, so everything here is laid out in logical landscape
// coordinates (800x480) and transposed on the way to the framebuffer.
//
// That transpose is still the thing to get right first, and it was once
// checked against six plain rectangles with no text and no icons - which is
// what this comment used to describe. It has not been true for a long time:
// ui.c is a quarter of a megabyte and draws a font, icons, a QR symbol, the
// gallery, the photograph screen and the ROLL screen. What has not changed is
// that there is no UI toolkit: every screen is drawn by this file's own
// primitives, and `firmware/p4/host_preview/` renders them with the same code
// so a layout can be looked at without a panel.
#ifndef P4_UI_H
#define P4_UI_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/** Logical landscape space. The panel's long axis runs horizontally. */
#define UI_W 800
#define UI_H 480

/** Start the UI. Requires display_init(); touch is optional. */
esp_err_t ui_start(void);

/**
 * Which launch shade this start wears: row `boot_count % 8` of K_LAUNCH, the
 * MAO pink and its seven steps toward lavender. Call once, before ui_start().
 * ui.c touches no NVS (the Twin compiles it to wasm), so main.c, which owns
 * the boot count, passes it in. The host renderer and the Twin pass 0, so
 * their pictures do not depend on a counter.
 */
void ui_set_launch_index(uint32_t boot_count);

/**
 * The UI task's pulse, for a reader that is NOT the UI task.
 *
 * The once-a-second health line in ui_task() can only report faults the loop is
 * still running to notice. A task blocked in a draw, starved, or dead never
 * reaches it, and the only symptom is that the lines stop - which is
 * indistinguishable from a healthy idle camera that has nothing to say, and was
 * the reason the old line was emitted unconditionally in the first place
 * (issue #140). Silence is not evidence.
 *
 * So the loop stamps a counter and a timestamp on every pass and something else
 * reads them. GET_RUNTIME_STATS is served on the KDP server task at priority 9
 * and answers whether or not this loop ever runs again, so `lastPassAgeMs`
 * growing without bound is POSITIVE evidence of a wedge.
 *
 * `passes` is 0 before ui_start(), and `age_ms` is 0 then too rather than an
 * enormous number - `passes == 0` is how a reader tells "not started" from
 * "gone". `stalled` is the latched state of the health watch: the loop is
 * running and not presenting work it owes.
 *
 * Divides the job with taskmon.h, which reports stack headroom per task and
 * says nothing about whether a task is still turning over.
 *
 * Any NULL out-parameter is skipped. Safe from any task.
 */
void ui_liveness(uint32_t *passes, uint32_t *age_ms, bool *stalled);

/*
 * The screen over KDP (#246): the UI task's half of kdp_ui.c.
 *
 * The KDP task posts, the UI task answers on its next pass, and neither
 * waits on the other: every shared field has one writer. Nothing here draws
 * on the KDP task. Safe from any task.
 */

/** GET_SCREEN's `screen` names, lower case, in screen_t order. The host's
 *  copy is SCREEN_IDS in packages/kdp/src/protocol/types.ts. */
#define UI_SCREEN_IDS                                                                         \
  "menu", "shoot", "look", "gallery", "photo", "roll", "settings", "display", "sound",       \
      "connection", "storage", "about", "status", "power"
#define UI_SCREEN_COUNT 14

typedef enum {
  UI_SHOT_WAITING = 0, /* the UI task has not reached the ask yet */
  UI_SHOT_DONE,        /* rendered into the canvas: read it out */
  UI_SHOT_BUSY,        /* a move, the boot sequence or the sleep owns the panel */
} ui_shot_state_t;

typedef struct {
  uint32_t gen;    /* gfx_canvas_gen() as the render left it */
  uint8_t screen;  /* index into UI_SCREEN_IDS */
  bool plate;      /* the render is the test plate */
} ui_shot_t;

/** Ask for one render of the current screen into the canvas. Returns the
 *  ticket ui_shot_poll() answers. */
uint32_t ui_shot_ask(void);

/** Where ticket `ticket` has got to; `out` is filled on UI_SHOT_DONE. */
ui_shot_state_t ui_shot_poll(uint32_t ticket, ui_shot_t *out);

/** True while a move, the sleep's wind-down or a wake's lift owns the panel. */
bool ui_screen_moving(void);

/**
 * A tap at logical (x, y), held `hold_ms` and lifted, through the path a
 * finger takes. Queued four deep. Returns how many taps are waiting with
 * this one, or 0 when the queue is full.
 */
int ui_tap_post(int x, int y, int hold_ms);

/** The shutter (true) or FN key, through the queue the physical keys use.
 *  `long_press` adds the 600 ms hold report. False when the queue is full or
 *  the UI has not started. */
bool ui_key_post(bool shutter, bool long_press);

/** Show (true) or drop the test plate. */
void ui_plate_post(bool on);

#endif
