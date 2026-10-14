/*
 * How the screen moves: every duration and every curve ui.c moves with.
 *
 * ui.c asks for a move by what it is (MOTION_OPEN_MS, motion_smooth()), never
 * by a number. A product whose transitions are all slightly different lengths
 * reads as a product nobody timed, and a length written inline at the one
 * place it is used cannot be compared with the others.
 *
 * Header only, no state, no ESP-IDF: power.c reads the sleep hand-over from
 * here, and the Twin compiles ui.c to wasm with it.
 *
 * ## The rules
 *
 *   ANCHOR  The thing you chose survives into the next state. A move grows
 *           out of the row that was pressed; nothing arrives from nowhere if
 *           something on the screen caused it.
 *   LAND    An outcome finishes in a stable place, with at most one colour
 *           event and one sound at the same instant. Colour arrives, does its
 *           job in MOTION_LAND_MS and leaves. The shutter sound plays only
 *           for a capture the pipeline accepted.
 *   RECEDE  Something unavailable loses presence: a quieter ink on its own
 *           ground. It never turns grey-boxed or red.
 *   SMOOTH  No level changes in a step or a cut. A scrim, a fade or a move
 *           runs on one of the curves below, one value per presented frame.
 *           The dim arrives over MOTION_DIM_MS, leaves over MOTION_UNDIM_MS;
 *           the screen comes back from sleep over MOTION_WAKE_MS.
 *   WIGGLE  The one exception to SMOOTH. A wigglegram is hard cuts at its
 *           frame rate (wiggle.fps, PURE_WIGGLE_FPS_DEFAULT in pure.h), one
 *           way round, the subject pinned. Its smoothness is alignment, never
 *           a crossfade.
 *
 * ANCHOR, LAND and RECEDE are MAO's (docs/m4_1_ui_motion_concept.md in the
 * MAO tree, section 2). SMOOTH and WIGGLE are this camera's.
 */
#pragma once
#include <stdint.h>

/* ---- the curves ------------------------------------------------------- */

/* Smootherstep: no speed and no acceleration at either end. The curve for
 * anything that moves from one place to another, and the one gfx.c eases on. */
static inline float motion_smooth(float t) {
  if (t <= 0.0f) return 0.0f;
  if (t >= 1.0f) return 1.0f;
  return t * t * t * (t * (t * 6.0f - 15.0f) + 10.0f);
}

/* Cubic ease-out: fast off the mark, settling at the end. The curve for the
 * screen coming back to a person who has just touched it: the first frame
 * answers the touch, the rest settle. */
static inline float motion_ease_out(float t) {
  if (t <= 0.0f) return 0.0f;
  if (t >= 1.0f) return 1.0f;
  const float u = 1.0f - t;
  return 1.0f - u * u * u;
}

/* Quadratic ease-in: gathering speed and gone. The curve for something
 * leaving for good, the boot field's retreat. */
static inline float motion_accel(float t) {
  if (t <= 0.0f) return 0.0f;
  if (t >= 1.0f) return 1.0f;
  return t * t;
}

/* ---- moves between screens -------------------------------------------- */

/* Going in is slower than coming back: opening is where you arrive. */
#define MOTION_OPEN_MS 420    /* a screen opening out of the row pressed */
#define MOTION_BACK_MS 340    /* and closing back into it */
#define MOTION_CASCADE_MS 700 /* the menu's rows arriving after the boot */

/* ---- the boot --------------------------------------------------------- */

#define MOTION_SPLASH_GROW_MS 1820 /* the field, out of nothing to the panel */
#define MOTION_SPLASH_HOLD_MS 860  /* full, the cells re-rolling */
#define MOTION_SPLASH_BACK_MS 1080 /* and away, on motion_accel */
#define MOTION_HANDOFF_MS 420      /* any first screen but the menu, dissolving in out of the field */
/* The launch shade warms the field over this window of the whole splash. */
#define MOTION_SPLASH_WARM_FROM_MS 350
#define MOTION_SPLASH_WARM_TO_MS 2300
#define MOTION_FIELD_CELL_MS 260 /* how long a cell holds its mark before re-rolling */
/* Each quadrant closes this fraction of the gap to its camera's state per
 * frame, so a node that answers mid-boot opens its quarter out. */
#define MOTION_FIELD_CAM_FOLLOW 0.10f

/* ---- outcomes --------------------------------------------------------- */

/* LAND: the landed cells in the launch shade, then back to ink on
 * motion_smooth. */
#define MOTION_LAND_HOLD_MS 120
#define MOTION_LAND_BACK_MS 180
#define MOTION_LAND_MS 300
_Static_assert(MOTION_LAND_HOLD_MS + MOTION_LAND_BACK_MS == MOTION_LAND_MS,
               "LAND is one 300 ms event: hold plus return");

/* The review that opens after a shot: at least one loop of the wiggle, and
 * this much after the loop so the last frame is seen. */
#define MOTION_REVIEW_MIN_S 3
#define MOTION_REVIEW_TAIL_MS 800

/* ---- how long things stay --------------------------------------------- */

#define MOTION_TOAST_MS 2200   /* a toast */
#define MOTION_UNDO_MS 30000   /* the undo toast after a delete */
#define MOTION_CAMS_RESTART_BANNER_MS 3000 /* RESTART THE CAMERAS, said */
/* A SHOOT pane that has never had a frame holds its ground this long before
 * it says why, so the picture arrives on black rather than after a false
 * NO CAMERA. */
#define MOTION_SHOOT_SETTLE_MS 1500

/* ---- the light -------------------------------------------------------- */

#define MOTION_DIM_MS 1600  /* the dim scrim arriving, motion_smooth */
#define MOTION_UNDIM_MS 160 /* and leaving on a touch, motion_ease_out */
/* The screen coming back from sleep, and from a sleep called off while it
 * wound down: the scrim lifting from the ground, motion_ease_out. A sleep
 * mark still on the glass takes the first MOTION_WAKE_MARK_MS of it. */
#define MOTION_WAKE_MS 240
#define MOTION_WAKE_MARK_MS 80
_Static_assert(MOTION_WAKE_MARK_MS < MOTION_WAKE_MS, "the picture needs some of the lift");

/*
 * Going to sleep. power.c asks for the mark and waits up to
 * SLEEP_SHOW_WAIT_MS for the UI to say it is up, then gives the screen
 * SLEEP_WIND_MS before it cuts the light. ui.c draws one timeline inside that
 * window: the picture darkens (OUT), the mark fades in (IN), holds (HOLD) and
 * fades out (FADE).
 */
#define SLEEP_SHOW_WAIT_MS 900
#define SLEEP_WIND_MS 2000
#define SLEEP_POLL_MS 20 /* power.c's step while it waits */
#define MOTION_SLEEP_OUT_MS 450
#define MOTION_SLEEP_IN_MS 400
#define MOTION_SLEEP_HOLD_MS 550
#define MOTION_SLEEP_FADE_MS 500
_Static_assert(MOTION_SLEEP_OUT_MS + MOTION_SLEEP_IN_MS + MOTION_SLEEP_HOLD_MS + MOTION_SLEEP_FADE_MS <=
                   SLEEP_WIND_MS,
               "the wind-down must end before power.c cuts the light");

/*
 * Switching off and restarting. RESTARTING holds, the mark holds, the screen
 * lets go of it on motion_smooth over about twenty frames, and black holds
 * while the backlight goes. A blocking loop on purpose: it runs only on the
 * way to esp_restart() or power-off, where no input is acted on.
 */
#define MOTION_RESTARTING_MS 420
#define MOTION_POWER_MARK_MS 520
#define MOTION_POWER_FADE_MS 385
#define MOTION_POWER_FADE_FRAMES 20
#define MOTION_POWER_BLACK_MS 140
