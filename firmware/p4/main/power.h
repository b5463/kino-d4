// Power management: what the camera switches off when nobody is using it.
//
// A party camera lives on a 3000 mAh cell with a 4.3in panel and a backlight
// that is the single largest continuous load on the board. The settings that
// govern it are not invented here - BodyConfig in the KDP contract already
// defines `autoDimS`, `sleepS`, `camIdleTimeoutS` and `brightness`, and
// Studio writes them. This module is the half that honours them.
//
// What it cannot do is report a battery. There is no sense divider to the P4
// and no fuel gauge on this build, so GET_POWER_STATUS reports the rail state
// it can establish and says the battery is unmeasured rather than inventing a
// voltage - the same choice the contract already makes for `busV`.
#ifndef P4_POWER_H
#define P4_POWER_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/** Start the idle watcher. Requires config_init() and display_init(). */
esp_err_t power_init(void);

/**
 * Report activity, which cancels dim and wakes the panel.
 *
 * Called from the touch path and from anything else a person did on purpose.
 * A KDP request does NOT count: Studio polling status every second would keep
 * the backlight on forever in a bag.
 */
void power_activity(void);

typedef enum {
  POWER_AWAKE = 0, /* panel lit */
  POWER_DIM,       /* past autoDimS */
  POWER_ASLEEP,    /* past sleepS, panel off */
} power_stage_t;

typedef struct {
  power_stage_t stage;
  uint32_t idle_s;      /* seconds since the last activity */
  bool display_on;
  bool cam_bank_on;
  bool usb_attached;    /* a host is talking to us over USB */
} power_state_t;

void power_get(power_state_t *out);

/** Force the panel back on, as a touch would. */
void power_wake(void);

/**
 * True while the gesture that woke the screen is still on the glass.
 *
 * The UI uses this to swallow that whole press, so a camera pulled out of a
 * bag lights up instead of firing whatever tile a thumb landed on. It lives
 * here rather than in the UI because the deciding moment - a contact arriving
 * while the panel is dark - is seen by the touch task, and the UI samples
 * state far too rarely to catch it: power_activity() runs on every 15 ms
 * touch poll, and the UI only compared stages every 20 ms against a stage
 * that a 500 ms housekeeping task was responsible for changing. Whichever ran
 * first won, so the same gesture sometimes woke the screen and sometimes woke
 * it and pressed a tile.
 */
bool power_wake_gesture(void);

/** Called by the UI when the finger lifts, ending any wake gesture. */
void power_end_wake_gesture(void);

#endif
