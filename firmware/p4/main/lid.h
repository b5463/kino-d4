/*
 * The lens cover, read from what the cameras see.
 *
 * The field body's sliding cover sits 0.2 mm in front of four opaque cells
 * (hardware 0.1.4, ECN-0004). Closed, every camera sees the same nothing;
 * open, every camera sees the room. That is enough to know where the cover is
 * without the Hall switch the shell is drilled for - and unlike the switch it
 * needs no part fitted before the face is glued on.
 *
 * The decision itself lives in pure.c (`pure_lid_update`) so it can be tested
 * on a workstation. This module is only the half that gets numbers into it and
 * acts on what comes out.
 *
 * WHERE THE NUMBERS COME FROM
 *
 * The viewfinder already pulls a frame from every camera and decodes it to
 * RGB565 for the tiles. Reading a mean off those costs one pass over memory:
 * no capture, no UART, no second JPEG decoder. So this watcher runs on the
 * viewfinder's frames and nothing else.
 *
 * The consequence, stated plainly: WITH THE VIEWFINDER OFF THERE IS NO SIGNAL.
 * The state goes unknown and the watcher does nothing. That covers the case
 * the feature is actually for - the cover going on while you are shooting -
 * and does not cover a camera already idle in a bag, where `camIdleTimeoutS`
 * has cut the camera rail and there is nothing to meter anyway.
 *
 * WHAT IT CANNOT DO
 *
 * It cannot wake the camera. Waking optically means keeping a node powered to
 * watch for light, about 100 mA, roughly 30 h of standby off the 3000 mAh
 * cell; and a node needs one to two seconds to boot and initialise its sensor,
 * so the rail cannot be duty-cycled cheaply either. Waking stays with touch,
 * the shutter, and the Hall switch when one is fitted.
 *
 * It also cannot tell a closed cover from a dark room. That failure is benign
 * - if all four lenses see nothing there is nothing to photograph - but it is
 * why this drives idle behaviour and not, say, a shutter interlock.
 */
#ifndef P4_LID_H
#define P4_LID_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/** Start the watcher. Requires viewfinder_init() and power_init(). */
esp_err_t lid_init(void);

/**
 * Whether a settled `closed` may put the camera to sleep.
 *
 * Set from `body.coverWatch` at boot and on every accepted SET_CONFIG, so the
 * thresholds can be measured and the result tried without a reflash. The
 * default is false, and stays false until somebody has read PURE_LID_DARK and
 * PURE_LID_LIT off the bench log with the cover on and the cover off. Those two numbers cannot be
 * derived: the node runs auto-exposure, so a covered sensor does not report
 * zero, it reports amplified noise, and how much is a property of the part.
 * Until they are measured this watcher observes and logs and changes nothing,
 * which is the only honest default for something whose mistake is to put the
 * camera to sleep in the middle of a party.
 */
void lid_set_acting(bool on);
bool lid_acting(void);

typedef struct {
  int state;          /* pure_lid_state_t */
  int mean[4];        /* last mean luminance per camera, -1 for no reading */
  int answered;       /* cameras that gave a reading last round */
  uint32_t closes;    /* settled open -> closed edges since boot */
  uint32_t opens;     /* settled closed -> open edges since boot */
  uint32_t slept;     /* times a closed edge actually asked for sleep */
} lid_state_t;

void lid_get(lid_state_t *out);

#endif
