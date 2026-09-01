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
#include <stdint.h>

#include "esp_err.h"

/** Logical landscape space. The panel's long axis runs horizontally. */
#define UI_W 800
#define UI_H 480

/* Bench only: send the composed screens back over the console as base64 so
 * they can be decoded into pictures. 0 for normal builds - it costs several
 * seconds of boot and floods the log. */
#ifndef KINO_UI_FRAME_DUMP
#define KINO_UI_FRAME_DUMP 0
#endif

/** Start the UI. Requires display_init(); touch is optional. */
esp_err_t ui_start(void);

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

#endif
