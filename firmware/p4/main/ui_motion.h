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

/* Quadratic ease-out: the same shape, a softer start. Not in use: it is the
 * fallback for motion_by_hand() below. */
static inline float motion_ease_out_quad(float t) {
  if (t <= 0.0f) return 0.0f;
  if (t >= 1.0f) return 1.0f;
  const float u = 1.0f - t;
  return 1.0f - u * u;
}

/*
 * The curve of a move a person started: a tap, a key, the shutter. Applied to
 * the move's time, so the first frame answers the press. A move nobody touched
 * (the review opening and closing on its own, the start) stays on
 * motion_smooth().
 *
 * Cubic ease-out puts the card 11.0 % of the way there at 16 ms of an open and
 * 13.5 % at 16 ms of a back move, about 1.5x the smootherstep peak speed in
 * the first step. If that reads abrupt on the panel at 51-58 fps, set
 * MOTION_HAND_QUAD to 1: quadratic ease-out, 7.5 % and 9.2 % at 16 ms. It is
 * 0 until the bench says otherwise.
 */
#define MOTION_HAND_QUAD 0
static inline float motion_by_hand(float t) {
  return MOTION_HAND_QUAD ? motion_ease_out_quad(t) : motion_ease_out(t);
}

/* ---- moves between screens -------------------------------------------- */

/* Going in is slower than coming back: opening is where you arrive. A move a
 * person started runs on motion_by_hand(), any other on motion_smooth(). */
#define MOTION_OPEN_MS 420 /* a screen opening out of the row pressed */
#define MOTION_BACK_MS 340 /* and closing back into it */

/* ---- the start (#245) --------------------------------------------------
 *
 * The ODD JOBS mark, the four cameras answering under it, and the four
 * becoming the SHOOT card's mark as the menu builds round them. Times from
 * the first frame. A cell fills when its own camera answers, never before
 * MOTION_START_CELL_FROM_MS and never within MOTION_START_CELL_GAP_MS of the
 * cell before it. The build starts MOTION_START_SETTLE_MS after the last
 * cell is in, never before MOTION_START_MIN_HOLD_MS. A camera silent at
 * MOTION_START_WAIT_MS is drawn missing and the build starts without it. The
 * build never starts after WAIT + MISSING + SETTLE, even for a camera that
 * answered just before it: that cell finishes inside the travel. So the menu
 * lands by WAIT + MISSING + SETTLE + BUILD, 2770 ms. A camera that answers
 * during the build still fills, over what is left of it but never less than
 * MOTION_START_LATE_FILL_MS; one that answers later than that is left an
 * outline, and the menu's next camera read fills its cell on the card.
 */
#define MOTION_START_MARK_IN_MS 450    /* the mark, ground to ink */
#define MOTION_START_SLOTS_FROM_MS 250 /* the four outlines under it */
#define MOTION_START_SLOTS_IN_MS 300
#define MOTION_START_CELL_FROM_MS 450 /* the first a cell can fill */
#define MOTION_START_CELL_GAP_MS 70   /* the least between two cells' fills */
#define MOTION_START_CELL_IN_MS 180   /* one cell, outline to filled */
#define MOTION_START_SETTLE_MS 150
#define MOTION_START_MIN_HOLD_MS 800
#define MOTION_START_WAIT_MS 1600
#define MOTION_START_MISSING_MS 200 /* a silent camera's outline, quiet to ink */
/* The build, on its own clock from the frame it starts. */
#define MOTION_START_RECEDE_MS 280 /* the mark, ink to ground, lifting */
#define MOTION_START_RISE_PX 16
#define MOTION_START_INK_MS 180 /* the cells to the card's ink, their box to the shade */
#define MOTION_START_TRAVEL_FROM_MS 120
#define MOTION_START_TRAVEL_MS 480 /* the cells and their box out to the card */
#define MOTION_START_ROWS_FROM_MS 240
#define MOTION_START_ROWS_MS 580 /* the five rows, staggered */
#define MOTION_START_WORDS_FROM_MS 580
#define MOTION_START_WORDS_MS 240 /* the card's words, shade to ink */
#define MOTION_START_BUILD_MS 820
/* The shortest fill a camera heard during the build gets. */
#define MOTION_START_LATE_FILL_MS 120
/* A finger during the start: the rest of the build, every beat in step, in
 * this long. A key lands the menu on the spot and fires on the same pass. */
#define MOTION_START_CUT_MS 300
/* A start still running this long after its first frame had its loop stalled
 * (a hidden Twin tab, a UI task held): it lands the menu at once with the
 * cameras that answer. Well past the 2770 ms ceiling plus a build, and well
 * inside the 30 s an int16 st_* field holds. */
#define MOTION_START_LATE_MS 5000
_Static_assert(MOTION_START_WAIT_MS + MOTION_START_MISSING_MS + MOTION_START_SETTLE_MS +
                       2 * MOTION_START_BUILD_MS < MOTION_START_LATE_MS &&
                   MOTION_START_LATE_MS < 30000,
               "the stall guard never cuts a start that is still on time");
_Static_assert(MOTION_START_ROWS_FROM_MS + MOTION_START_ROWS_MS <= MOTION_START_BUILD_MS &&
                   MOTION_START_WORDS_FROM_MS + MOTION_START_WORDS_MS <= MOTION_START_BUILD_MS &&
                   MOTION_START_TRAVEL_FROM_MS + MOTION_START_TRAVEL_MS <= MOTION_START_BUILD_MS &&
                   MOTION_START_RECEDE_MS <= MOTION_START_BUILD_MS,
               "every beat of the build ends inside it");
_Static_assert(MOTION_START_LATE_FILL_MS <= MOTION_START_CELL_IN_MS && MOTION_START_LATE_FILL_MS < MOTION_START_CUT_MS,
               "a late fill is a compressed fill, and fits a finger's build");
_Static_assert(MOTION_START_INK_MS <= MOTION_START_TRAVEL_FROM_MS + MOTION_START_TRAVEL_MS,
               "the cells reach the card's ink before they land");
_Static_assert(MOTION_START_WAIT_MS + MOTION_START_MISSING_MS + MOTION_START_SETTLE_MS +
                       MOTION_START_BUILD_MS <= 3000,
               "a start with a silent camera lands the menu inside 3 s");

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

/* PULSE: the card pill on SHOOT answering a shutter that capture.c refused
 * for the card. Out MOTION_PILL_PULSE_PX a side, then back, on motion_smooth
 * both ways. */
#define MOTION_PILL_PULSE_UP_MS 140
#define MOTION_PILL_PULSE_BACK_MS 280
#define MOTION_PILL_PULSE_MS 420
#define MOTION_PILL_PULSE_PX 6
_Static_assert(MOTION_PILL_PULSE_UP_MS + MOTION_PILL_PULSE_BACK_MS == MOTION_PILL_PULSE_MS,
               "PULSE is one 420 ms event: out plus back");

/* ---- how long things stay --------------------------------------------- */

#define MOTION_TOAST_MS 2200   /* a toast */
#define MOTION_UNDO_MS 30000   /* the undo toast after a delete */
#define MOTION_CAMS_RESTART_BANNER_MS 3000 /* RESTART THE CAMERAS, said */
/* A SHOOT pane that has never had a frame holds its ground this long before
 * it says why, so the picture arrives on black rather than after a false
 * NO PICTURE. */
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
