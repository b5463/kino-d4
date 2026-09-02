/**
 * The pictures on the card, as the camera itself can show them.
 *
 * Everything else that reads a capture reads it over USB. This is the one
 * consumer standing next to the card, and the only one a person uses without
 * a laptop — which makes it the only check that a capture is actually there
 * and actually an image, rather than a folder of the right size.
 *
 * Scanning and decoding happen on a task of their own. A page of six tiles is
 * six JPEG decodes and six card reads; doing that inside a draw call would
 * stall the screen for most of a second every time someone scrolled, and the
 * screen is what tells them the camera has not hung.
 */
#ifndef KINO_GALLERY_H
#define KINO_GALLERY_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#define GALLERY_COLS 3
#define GALLERY_ROWS 2
#define GALLERY_PAGE (GALLERY_COLS * GALLERY_ROWS)

/*
 * 4:3, and 3x2 of them fills the body of an 800x480 screen.
 *
 * The aspect ratio is not a layout preference. Every sensor on this camera is
 * 4:3, thumb_load mats whatever does not fit, and a tile of any other shape
 * therefore puts a black border down the side of every photograph the camera
 * will ever take.
 */
#define GALLERY_TILE_W 208
#define GALLERY_TILE_H 156

typedef enum {
  TILE_EMPTY = 0, /* no capture in this slot */
  TILE_PENDING,   /* on the queue, nothing decoded yet */
  TILE_READY,     /* `pixels` is a picture */
  TILE_NO_IMAGE,  /* the capture is there but nothing in it would decode */
} tile_state_t;

typedef struct {
  char id[40];      /* the capture UUID, which is its folder name */
  char label[16];   /* "CAP_000042" from META.JSON, or the id's first bytes */
  char mode[12];    /* wiggle | quad | single */
  int frames;
  bool partial;     /* fewer frames than cameras that were asked */
  /* META.JSON's `favorite`, the same flag MEDIA_FAVORITE writes. Here so a
   * tile can be marked without a second read of the same file - read_meta()
   * already has the parsed document in front of it. */
  bool favorite;
  tile_state_t state;
  const uint16_t *pixels; /* GALLERY_TILE_W * GALLERY_TILE_H, valid when READY */
} gallery_item_t;

esp_err_t gallery_init(void);

/**
 * Redraw the current page, and check cheaply that the card still holds what
 * the list says it does.
 *
 * Cheap to call on entering the screen or after a capture, and now that is
 * true rather than aspirational. It used to walk the whole captures directory
 * and read one META.JSON per capture folder to recover the newest-first order:
 * 5-15 ms each, so 2.5-7.5 s of card time on a card with ~500 captures, on
 * every gallery open, abandoned and restarted whenever a shutter press wanted
 * the card back.
 *
 * The order is written down instead (gallery_index.h) and maintained
 * incrementally, so what this does is: load the index if there is no list yet,
 * mark the page for decoding, and queue one readdir count pass to catch what
 * nothing told us about. A full rebuild happens only when the count disagrees,
 * the index is unreadable, or a tile turns out not to be on the card.
 */
void gallery_refresh(void);

/**
 * A capture was committed, or removed. Call from any task.
 *
 * These are what keeps gallery_refresh() cheap: they are the only two events
 * that change the order, so they say so exactly instead of everyone asking for
 * a rescan and hoping. Both are non-blocking - they hand a note to the gallery
 * task, which owns the arrays and the card discipline - so they are safe from
 * the capture task immediately after a commit and from the KDP server task
 * inside MEDIA_DELETE.
 *
 * `captured_at_ms` is the capture's own timestamp, the same value META.JSON
 * carries as `capturedAtMs`; it is what the gallery sorts on. Passing 0 sorts
 * the capture last rather than dropping it.
 *
 * MEDIA_FAVORITE deliberately does NOT call either of these: a favourite is a
 * flag inside META.JSON and changes nothing about the order. The star appears
 * because the page is redrawn, which the existing refresh call already does.
 */
void gallery_note_added(const char *id, uint64_t captured_at_ms);
void gallery_note_removed(const char *id);

int gallery_total(void);
int gallery_page(void);
int gallery_pages(void);
/** Moves by whole pages and stops at the ends rather than wrapping: wrapping
 * from the last page to the first reads as a crash when someone is looking
 * for the shot they just took. */
void gallery_turn(int delta);

/** The six slots of the current page. Always returns GALLERY_PAGE entries;
 * slots past the end of the card are TILE_EMPTY. */
const gallery_item_t *gallery_slots(void);

/** True while tiles are still being decoded, so a screen can say so. */
bool gallery_loading(void);

/**
 * Capture folders a full rebuild has collected so far, or 0 when none is
 * running.
 *
 * One number, because the footer has room for one and because it is the only
 * one that answers the question a person actually has in front of a screen
 * that says READING CARD: is it getting anywhere. It rises across passes - a
 * rebuild that yields the card to a capture keeps what it collected - so a
 * number that stops moving means the card is busy, not that the walk restarted.
 */
int gallery_scan_progress(void);

/* ------------------------------------------------------------------ */
/* DELETE ALL PHOTOS                                                   */
/* ------------------------------------------------------------------ */

/**
 * Remove every capture folder on the card. Captures only.
 *
 * Returns immediately; the work runs on the gallery task, which is the only
 * task that may hold the card for long stretches and the only one that knows
 * how to give it back. It takes the card as STORAGE_USER_UI in bursts and
 * yields per folder, so a shutter press mid-wipe wins and the wipe carries on
 * afterwards.
 *
 * Each folder goes through storage_capture_delete(), which unlinks only the
 * names in STORAGE_CAPTURE_FILES and then rmdir()s - so a folder holding
 * anything this firmware did not write is left standing rather than forced.
 * Sounds, recipes, the config and the upload queue's records are outside the
 * captures directory and are never touched.
 *
 * Calling it while a wipe is running does nothing.
 */
void gallery_delete_all(void);

/** True while a wipe is running, so a screen can keep repainting. */
bool gallery_deleting(void);

/** How far the wipe has got. `total` is 0 until the folders have been counted. */
void gallery_delete_progress(int *done, int *total);

/* ------------------------------------------------------------------ */
/* A capture's own frames, for the wigglegram player                   */
/* ------------------------------------------------------------------ */

/** Four lenses, so four frames: C1..C4.JPG. */
#define GALLERY_FRAME_MAX 4

/**
 * Decode a capture's C1..C4 into four buffers this module owns, in the
 * background.
 *
 * ## Why this lives here and not on the photograph screen
 *
 * Four full decodes is tens of milliseconds each off the card, and the task
 * that would otherwise do it is the one holding the canvas and the compositor
 * on an 8 KB stack. The gallery task already exists, already owns the only
 * polite card discipline in the firmware - a bounded acquire, a yield to a
 * capture, a retry on the next turn - and is idle for the whole time a
 * photograph is open. Adding a second worker would be a second copy of that
 * discipline for a job this one is asleep through.
 *
 * The frames are decoded one per turn, and only on turns where the gallery has
 * no page work of its own. A shutter press wins: the acquire times out, the
 * frame is retried on a later turn, and the screen keeps showing its still.
 *
 * ## What it costs
 *
 * The four buffers are allocated on the first call and never freed:
 * 4 x THUMB_TILE_BYTES(w, h), which at the photograph screen's 464x348 is
 * 1,291,776 bytes - 1.23 MiB of the P4's 32 MB PSRAM. Held rather than freed
 * per photograph because the alternative is a 1.23 MiB allocation on every
 * open, which fails precisely when the camera is busiest, and because a buffer
 * that cannot be freed cannot be freed underneath a decode that is still
 * writing into it. That last point is the whole lifetime rule: nothing here
 * ever dangles, so cancelling is a flag rather than a wait.
 *
 * `w`/`h` are fixed by the first call for the life of the boot; a later call
 * asking for a larger frame is refused with ESP_ERR_INVALID_SIZE rather than
 * writing past the buffers. There is one caller and it has one size.
 *
 * Returns ESP_OK with `*gen` set to the job's generation - the token every
 * later call carries, so an answer about a photograph the user has left cannot
 * be mistaken for one about the photograph they are looking at now.
 * ESP_ERR_NO_MEM when the buffers could not be had, which is not an error the
 * caller has to show: a photograph that cannot play is a photograph.
 */
esp_err_t gallery_frames_begin(const char *id, int w, int h, uint16_t pad, uint32_t *gen);

/** Forget the outstanding job. Never blocks and never waits for a decode in
 * flight: a decode that is already running finishes into a buffer nobody is
 * reading and its result is dropped for being of the wrong generation. */
void gallery_frames_cancel(void);

/**
 * Where `gen`'s job has got to. False when `gen` is not the current job, in
 * which case the outputs are untouched.
 *
 * `have` is a bit mask, bit i for C(i+1) - the frames that decoded, which is
 * not what META's frameCount says: a partial capture may be missing any one of
 * the four, and presence is discovered by trying rather than by trusting the
 * document. `done` means all four were TRIED, which is when the mask stops
 * changing and playback may start.
 */
bool gallery_frames_state(uint32_t gen, uint32_t *have, bool *done);

/**
 * Frame `index`'s pixels, `w` x `h` as begun.
 *
 * Only valid for a bit set in the `have` of the CURRENT generation: a buffer
 * outside that set is either being written or holds a previous photograph.
 * The pointer itself never moves and is never freed, so holding it across a
 * draw is safe; what changes is whether it means anything.
 */
const uint16_t *gallery_frame_pixels(int index);

#endif
