// The rear display's job: showing what the four lenses see.
//
// A four-lens camera whose screen cannot show four lenses is a camera you
// have to guess at. Framing a group shot means knowing what CAM1 and CAM4 are
// cutting off, and no single preview answers that.
//
// The link budget is the whole design constraint. A node's full-size UXGA
// frame is 7.7-30.4 KB, which is about 330 ms across a 921600-baud UART, so
// four of those in sequence is under 1 fps - a slideshow. Two things make a
// real viewfinder possible instead:
//
//   - camnode now accepts 320x240 and 160x120 frame sizes that exist only for
//     this path, roughly an eighth the bytes.
//   - each camera has its own UART (CAM1..CAM4 on UART1..UART4), so the four
//     transfers overlap instead of queueing behind one another.
//
// Decoding is the ESP32-P4's hardware JPEG engine, not a software decoder:
// four streams of software JPEG would cost more than the link does.
#ifndef P4_VIEWFINDER_H
#define P4_VIEWFINDER_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/** Pane size the nodes are asked for, and what each tile buffer holds. */
#define VF_W 320
#define VF_H 240

typedef enum {
  VF_NO_LINK = 0, /* the node never answered - unwired, unpowered, or absent */
  VF_LIVE,        /* a frame decoded within the staleness window */
  VF_STALLED,     /* answered once, nothing recent */
  VF_ERROR,       /* answered, but the frame did not decode */
} vf_state_t;

typedef struct {
  vf_state_t state;
  uint32_t frames;    /* frames decoded since boot */
  uint32_t last_ms;   /* age of the newest frame */
  uint32_t bytes;     /* size of the newest JPEG */
  uint32_t fps_x10;   /* measured, times ten - a viewfinder's rate is the
                       * headline number for whether this is usable at all */
} vf_status_t;

/** Start the preview loop. Safe without any node wired. */
esp_err_t viewfinder_init(void);

/** True once the tiles exist. */
bool viewfinder_ready(void);

/** Begin or end asking the nodes for frames. Off by default: a viewfinder
 *  that runs when nobody is looking is four sensors and four UARTs burning
 *  battery for a dark screen. */
void viewfinder_run(bool on);

/**
 * The newest decoded frame for one camera, RGB565, VF_W x VF_H.
 *
 * Returns NULL when that camera has produced nothing - the caller draws the
 * reason from viewfinder_status() rather than an empty rectangle.
 */
const uint16_t *viewfinder_tile(int cam);

void viewfinder_status(int cam, vf_status_t *out);

#endif
