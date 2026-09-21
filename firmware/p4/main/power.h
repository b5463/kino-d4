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
 * Ask for sleep now, without waiting out `sleepS`.
 *
 * For a deliberate act that means "I have finished" - the lens cover going on
 * is the one that exists (lid.c). It ages the idle clock past the configured
 * timeout rather than switching the panel off here, so the transition still
 * goes through the one path in power_task that knows about the backlight, the
 * stage, and the finger that may be arriving in the same pass.
 *
 * Honours the configuration: with `sleepS` at 0 the camera is set never to
 * sleep, and this does nothing rather than overriding that.
 */
void power_sleep_now(void);

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

/**
 * The panel is about to go dark for sleep, and power_task is waiting for
 * the UI to put the camera's mark on it first - so a sleep reads as the
 * camera going away, not as a screen that failed. True for at most 900 ms;
 * the UI answers with power_sleep_shown(), and the mark is held a moment
 * before the backlight goes. A touch in that window calls the sleep off.
 */
bool power_sleep_pending(void);
void power_sleep_shown(void);

/**
 * Cut the camera bank's power for a moment and restore it: the one reset the
 * P4 has over the four nodes. Used when a node has stopped answering after
 * a firmware update, so its bootloader can roll back; every node restarts.
 */
void power_cam_bank_cycle(void);

#endif
