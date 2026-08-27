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
  tile_state_t state;
  const uint16_t *pixels; /* GALLERY_TILE_W * GALLERY_TILE_H, valid when READY */
} gallery_item_t;

esp_err_t gallery_init(void);

/** Re-read the card and start decoding the current page. Cheap to call on
 * entering the screen or after a capture. */
void gallery_refresh(void);

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

#endif
