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

/*
 * Viewfinder-shaped timeouts, not capture-shaped ones.
 *
 * A stored capture may fairly wait eight seconds for a slow node. A pane may
 * not: waiting that long freezes the picture someone is framing with, and the
 * next frame is a couple of hundred milliseconds away in any case. A QVGA
 * exposure is tens of milliseconds and its transfer about fifty, so a node
 * that has not answered in 900 ms is not slow, it is absent.
 *
 * In the header because viewfinder_hold()'s timeout has to be derived from
 * them; see VF_HOLD_MS.
 */
#define VF_CAPTURE_TIMEOUT_MS 900
#define VF_READ_TIMEOUT_MS 600

/*
 * What a capture must give viewfinder_hold(), derived rather than picked.
 *
 * One pump is a capture plus the reads that follow it: a preview JPEG is
 * capped at 24 KB and a chunk is 8192 B, so at most three reads, and the
 * hardware decode runs after them. 900 + 4 x 600 = 3300 ms — the fourth read's
 * worth of budget is what covers that decode.
 *
 * It was a flat 1500 ms, which is shorter than the 2.7 s a pump can spend
 * before the decode even starts. The hold then timed out with a pump still on
 * the wire and the capture went ahead anyway - which is the mid-transfer
 * BAD_ID that viewfinder_hold() exists to prevent, logged as "vf hold TIMED
 * OUT ... capturing anyway".
 */
#define VF_HOLD_MS (VF_CAPTURE_TIMEOUT_MS + 4 * VF_READ_TIMEOUT_MS)

typedef enum {
  VF_NO_LINK = 0, /* the node never answered - unwired, unpowered, or absent */
  VF_LIVE,        /* a frame decoded within the staleness window */
  VF_STALLED,     /* answered once, nothing recent */
  VF_ERROR,       /* answered, but the frame did not decode */
} vf_state_t;

/*
 * Why a preview frame did not become a picture.
 *
 * Every one of these used to be a silent `return false` in pump_camera(): the
 * pane went to VF_ERROR or VF_NO_LINK, the pump backed off, and nothing was
 * written down. From the outside that is indistinguishable from a camera that
 * is merely slow, which is the ambiguity that made "the preview is freezing"
 * take an hour at the bench. The answer turned out to be bench traffic
 * contending for the same UART, and no counter in this firmware could have
 * said so.
 *
 * Five reasons rather than the one oversize case that was reported, because
 * they are the same defect: a short read and a refused decode were equally
 * silent, and telling them apart is the whole diagnostic value. VF_ERROR alone
 * cannot - it is the state for three of them.
 *
 * Counted per camera, always. Logged rate-limited, and only for the reasons
 * where the node ANSWERED and the frame still failed - see vf_drop() in
 * viewfinder.c for why VF_DROP_NO_LINK is counted silently.
 */
typedef enum {
  VF_DROP_NO_LINK = 0, /* the capture request never came back */
  VF_DROP_EMPTY,       /* answered, with a zero-byte frame */
  VF_DROP_OVERSIZE,    /* bigger than the JPEG buffer - nowhere to put it */
  VF_DROP_SHORT_READ,  /* the chunked read stopped before the declared size */
  VF_DROP_DECODE,      /* the bytes arrived; the JPEG engine refused them */
  VF_DROP_REASONS,
} vf_drop_t;

/**
 * Short label for a drop reason.
 *
 * camelCase and no spaces so the same string serves as a klog word and as a
 * JSON key under `viewfinder.drops` in CAMERA_STATUS - one vocabulary, so a
 * line in the ring and a field on the wire cannot drift apart. "?" for an
 * out-of-range reason rather than an out-of-bounds read.
 */
const char *vf_drop_str(vf_drop_t reason);

typedef struct {
  vf_state_t state;
  uint32_t frames;    /* frames decoded since boot */
  uint32_t last_ms;   /* age of the newest frame */
  uint32_t bytes;     /* size of the newest JPEG */
  uint32_t fps_x10;   /* measured, times ten - a viewfinder's rate is the
                       * headline number for whether this is usable at all */
  /* Frames that never became a picture, per reason, since boot. Indexed by
   * vf_drop_t.
   *
   * Cumulative and never reset: a reader wants a RATE, and two readings of a
   * monotonic counter give one, where a counter that clears itself on read
   * loses whatever happened between two polls - which on a 17 Hz path is most
   * of it. */
  uint32_t drops[VF_DROP_REASONS];
} vf_status_t;

/** Start the preview loop. Safe without any node wired. */
esp_err_t viewfinder_init(void);

/** True once the tiles exist. */
bool viewfinder_ready(void);

/**
 * How many times the finder has written this camera's JPEG-quality register.
 *
 * The finder is the SECOND writer of that register. It has no NL_CMD_SENSOR of
 * its own: every preview frame is an NL_CMD_CAPTURE carrying `quality`, and the
 * node applies it before it exposes. So a preview between two photographs
 * leaves the preview's quality (30, 45 or 18) standing in the sensor while
 * capture.c's change-only cache still believes the look's value is in there -
 * and the second capture came out at preview quality with META reporting the
 * look's. It never self-healed, because the cache only re-sends what changed.
 *
 * A count rather than a flag: capture.c compares it against what it saw at its
 * last apply, so a write that lands between two captures is noticed exactly
 * once and nothing has to be cleared by the reader. Monotonic, wraps at 2^32
 * (about 3 fps for 45 years), and 0 for an out-of-range camera.
 */
uint32_t viewfinder_quality_writes(int cam);

/** Begin or end asking the nodes for frames. Off by default: a viewfinder
 *  that runs when nobody is looking is four sensors and four UARTs burning
 *  battery for a dark screen.
 *
 *  The off->on edge re-reads shoot.previewQuality, so a change made in Studio
 *  applies the next time the SHOOT screen comes up rather than at the next
 *  reboot. Safe to call every UI pass; only the edge does any work. */
void viewfinder_run(bool on);

/**
 * Take the cameras away from the viewfinder for a capture.
 *
 * The node holds ONE frame: `handle_capture` releases whatever it was holding
 * and bumps the frame id, so a viewfinder frame taken during a transfer
 * invalidates the frame being transferred and the next chunk read comes back
 * BAD_ID. That is not theoretical - it failed four captures out of five on the
 * bench, at 0% and at 57%, while the link itself reported zero CRC errors.
 *
 * viewfinder_run(false) is not enough on its own: it stops the next pump but
 * does not wait for one already running. This clears the flag and then waits
 * for the in-flight pumps to finish, up to `timeout_ms`.
 *
 * Returns whether the viewfinder was running, to hand back to
 * viewfinder_release(). Always pair them.
 */
bool viewfinder_hold(uint32_t timeout_ms);

/** Give the cameras back. Pass what viewfinder_hold() returned. */
void viewfinder_release(bool was_running);

/**
 * Freeze the tiles for `ms` after a capture, then return to live by itself.
 *
 * A camera reviews the shot it just took rather than snapping straight back to
 * a live finder, and the tiles already hold the last frame before the shutter,
 * which is the closest thing to the captured moment that costs nothing.
 */
void viewfinder_review(uint32_t ms);

/**
 * The newest decoded frame for one camera, RGB565, VF_W x VF_H.
 *
 * Returns NULL when that camera has produced nothing - the caller draws the
 * reason from viewfinder_status() rather than an empty rectangle.
 */
const uint16_t *viewfinder_tile(int cam);

void viewfinder_status(int cam, vf_status_t *out);

/** Smoothed frames per second times ten, 0 when the finder has never run. */
uint32_t viewfinder_fps_x10(int cam);

#endif
