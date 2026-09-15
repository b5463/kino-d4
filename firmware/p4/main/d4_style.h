// KINO D4 — the interface's materials: colour, grid, type, and the small
// drawn things everything else is made of. See firmware/D4_UI.md.
//
// Immediate mode on purpose. The motion this interface has is stepped and
// short - appear, invert, blink, wipe, advance - and a retained graph with a
// spring per channel is the wrong machine for that. A screen is a function
// that draws itself from the camera's state, every pass, and nothing is
// remembered between passes except the camera's state itself.
//
// Included by ui.c after the drawing primitives and the type rasteriser.
#pragma once

/* ------------------------------------------------------------------ */
/* Colour                                                              */
/*
 * Two grounds. Graphite is the camera - live view, capture, playback, ROLL,
 * LOOK, LINK - where the photograph has to be the brightest thing on the
 * panel. Paper is the machine - SETUP, diagnostics, calibration, errors,
 * confirmations - where there is no photograph and no reason to be dark.
 * Crossing between them is a hard cut, and that cut is how the user always
 * knows which half of the product they are in.
 */
/*
 * Printed colour, not screen colour.
 *
 * The first cut of this used digital primaries - a full-chroma blue, a full
 * yellow, a pillarbox red - and that is most of what made it read as
 * software. Ink on uncoated paper does not do that: it is warm, it is a
 * little dirty, and it never reaches the corners of the gamut. These are
 * mixed as if they had been printed.
 *
 * The black is warm too. A neutral graphite next to a cream ground looks
 * like a bug; a warm near-black looks like ink.
 */
#define D_PAPER RGB(0xEF, 0xEA, 0xDE) /* uncoated cream */
#define D_GRAPH RGB(0x1C, 0x1A, 0x18) /* warm near-black */

/* Events, not palette. Most screens show none of these, and none of them is
 * at full chroma. */
#define D_COBALT RGB(0x2E, 0x4C, 0x8A) /* ink blue: connection, an operation */
#define D_YELLOW RGB(0xD8, 0xA5, 0x2B) /* ochre: capture, a photographic event */
#define D_RED RGB(0xA8, 0x3A, 0x2E)    /* faded red: a real error, a destruction */

/* Secondary type and rules, as blends toward whichever ground is under them.
 * Computed rather than tabulated so the same call works on both grounds. */
static inline uint16_t d_toward(uint16_t ink, uint16_t ground, int k256) {
  const int ir = (ink >> 11) & 31, ig = (ink >> 5) & 63, ib = ink & 31;
  const int gr = (ground >> 11) & 31, gg = (ground >> 5) & 63, gb = ground & 31;
  const int r = ir + ((gr - ir) * k256 >> 8), g = ig + ((gg - ig) * k256 >> 8), b = ib + ((gb - ib) * k256 >> 8);
  return (uint16_t)((r << 11) | (g << 5) | b);
}

/* The ground this screen is on, and the ink that goes with it. Set once at
 * the top of a screen by d_ground(); everything below reads them. */
static uint16_t d_bg = D_GRAPH, d_fg = D_PAPER;
static inline void d_ground(uint16_t bg) {
  d_bg = bg;
  d_fg = (bg == D_PAPER) ? D_GRAPH : D_PAPER;
  fill(0, 0, UI_W, UI_H, bg);
}
/*
 * Secondary ink, as a blend toward whichever ground is under it - and the
 * amount is nowhere near the same on both. Dark ink on paper loses
 * legibility much faster than pale ink on graphite does, and small type
 * loses it faster still: a 16px glyph is mostly antialiased edge, so grey on
 * off-white at the blend that reads on the camera all but vanishes on the
 * machine. These are the two pairs that read alike on the panel.
 */
#define D_DIM d_toward(d_fg, d_bg, d_bg == D_PAPER ? 70 : 150)
#define D_FAINT d_toward(d_fg, d_bg, d_bg == D_PAPER ? 120 : 190)

/* ------------------------------------------------------------------ */
/* Grid                                                                */
/*
 * Four columns, because the camera has four lenses and the interface speaks
 * in fours. The same measure is the ROLL page, the four feeds, the
 * diagnostics columns and the value column in a settings list.
 */
#define D_MARGIN 16
#define D_COLS 4
#define D_GUT 8
#define D_COL_W ((UI_W - 2 * D_MARGIN - (D_COLS - 1) * D_GUT) / D_COLS) /* 186 */
#define D_ROW 24                                                        /* vertical rhythm */
#define D_HEAD 34                                                       /* a screen's name strip */
#define D_FOOT 30                                                       /* the mundane facts */

static inline int d_col_x(int i) { return D_MARGIN + i * (D_COL_W + D_GUT); }
static inline int d_col_cx(int i) { return d_col_x(i) + D_COL_W / 2; }

/* ------------------------------------------------------------------ */
/* Type                                                                */
/*
 * Five sizes and nothing above 34. Hierarchy is size, weight and position;
 * nothing is set large for effect. `d_text` returns the pen so a row can be
 * built left to right without measuring twice.
 */
static int d_text(const ut_face_t *f, int x, int y, const char *s, uint16_t ink) {
  return ut_draw(f, x, y, s, ink);
}
static void d_text_r(const ut_face_t *f, int right, int y, const char *s, uint16_t ink) {
  ut_draw(f, right - ut_w(f, s), y, s, ink);
}
static void d_text_c(const ut_face_t *f, int cx, int y, const char *s, uint16_t ink) {
  ut_draw(f, cx - ut_w(f, s) / 2, y, s, ink);
}

/** Type over a photograph: the ground underneath is unknown, so it is
 *  contoured. Everywhere else the ground is flat and it is not. */
static void d_text_over(const ut_face_t *f, int x, int y, const char *s, uint16_t ink) {
  ut_fx2(f, (float)x + ut_w(f, s) * 0.5f, (float)y + (f->asc + f->desc) * 0.5f, s, 1.f, 1.f, 0.f, 0.f, ink, 255,
         true, 0);
}
static void d_text_over_r(const ut_face_t *f, int right, int y, const char *s, uint16_t ink) {
  d_text_over(f, right - ut_w(f, s), y, s, ink);
}

#include "d4_font.h"

/* ------------------------------------------------------------------ */
/* Rules, boxes and selection                                          */

static inline void d_rule(int x, int y, int w) { fill(x, y, w, 1, D_FAINT); }

/** A hollow rectangle, one pixel, for a box that holds something. */
static void d_box(int x, int y, int w, int h, uint16_t ink) {
  fill(x, y, w, 1, ink);
  fill(x, y + h - 1, w, 1, ink);
  fill(x, y, 1, h, ink);
  fill(x + w - 1, y, 1, h, ink);
}

/** Selection is a filled rectangle with the type knocked out of it. Not a
 *  highlight, not a glow, not a rounded pill: a block of ink. */
static void d_select(int x, int y, int w, int h, uint16_t ink) { fill(x, y, w, h, ink); }

/* ------------------------------------------------------------------ */
/* The band                                                            */
/*
 * KINO's screens are built from full-width solid bands with the type knocked
 * out of them, not from hairlines with grey text between them. A band is a
 * structural fact: it says where the picture stops and the machine starts,
 * and it says it at full contrast on a panel that will be looked at in a dark
 * room and in direct sun on the same evening.
 *
 * Every screen has a top band and most have a bottom one. The top band on the
 * camera is divided into four cells, one over each feed, so the chrome is the
 * four rather than a caption about them.
 */
#define D_BAND_T 40 /* the top band: a name, or the four */
#define D_BAND_B 44 /* the bottom band: the mundane facts */

static uint16_t d_band_ink, d_band_fg;

/** Lay the top band. Returns the y below it. */
static int d_band_top(uint16_t ink) {
  d_band_ink = ink;
  d_band_fg = (ink == D_PAPER || ink == D_YELLOW) ? D_GRAPH : D_PAPER;
  fill(0, 0, UI_W, D_BAND_T, ink);
  return D_BAND_T;
}

/** Lay the bottom band. Returns its y. */
static int d_band_bottom(uint16_t ink) {
  fill(0, UI_H - D_BAND_B, UI_W, D_BAND_B, ink);
  return UI_H - D_BAND_B;
}

/* ------------------------------------------------------------------ */
/* Furniture                                                           */
/*
 * The drawn parts that make a panel a panel. None of these is decoration:
 * a bracket says where the frame is, a tick rule says a scale is divided,
 * a cell says a value is a value and not a word.
 */

/** Framing brackets: four corners of an L, the way a camera marks a frame. */
static void d_corners(int x, int y, int w, int h, int len, int wt, uint16_t ink) {
  fill(x, y, len, wt, ink);
  fill(x, y, wt, len, ink);
  fill(x + w - len, y, len, wt, ink);
  fill(x + w - wt, y, wt, len, ink);
  fill(x, y + h - wt, len, wt, ink);
  fill(x, y + h - len, wt, len, ink);
  fill(x + w - len, y + h - wt, len, wt, ink);
  fill(x + w - wt, y + h - len, wt, len, ink);
}

/** A rule with a tick every `every` pixels: a scale, not a line. */
static void d_tick_rule(int x, int y, int w, int every, int tick, uint16_t ink) {
  fill(x, y, w, 1, ink);
  for (int i = 0; i <= w; i += every) fill(x + i, y, 1, tick, ink);
}

/** A boxed cell for a value, with the value's own baseline inside it. */
static void d_cell(int x, int y, int w, int h, uint16_t ink) { d_box(x, y, w, h, ink); }

/** A small caps label: tracked out, because a label is not a word. */
static int d_label(int x, int y, const char *s, uint16_t ink) {
  char one[2] = {0, 0};
  for (const char *p = s; *p; p++) {
    one[0] = *p;
    ut_draw(&UT_XS, x, y, one, ink);
    x += ut_w(&UT_XS, one) + 2;
  }
  return x;
}
static int d_label_w(const char *s) {
  int w = 0;
  char one[2] = {0, 0};
  for (const char *p = s; *p; p++) {
    one[0] = *p;
    w += ut_w(&UT_XS, one) + 2;
  }
  return w > 0 ? w - 2 : 0;
}
static void d_label_r(int right, int y, const char *s, uint16_t ink) { d_label(right - d_label_w(s), y, s, ink); }
static void d_label_c(int cx, int y, const char *s, uint16_t ink) { d_label(cx - d_label_w(s) / 2, y, s, ink); }

/* ------------------------------------------------------------------ */
/* Progress: blocks, never a bar and never a spinner                   */
/*
 * Ten blocks, filling left to right, and the count has to be real - frames
 * written, files sent, cameras answered. A process that cannot report its own
 * progress does not get blocks; it gets a word.
 */
#define D_BLOCK_W 22
#define D_BLOCK_H 16
#define D_BLOCK_GAP 6
#define D_BLOCKS 10
#define D_BLOCKS_W (D_BLOCKS * D_BLOCK_W + (D_BLOCKS - 1) * D_BLOCK_GAP)

static void d_blocks(int x, int y, int done, int total, uint16_t ink) {
  const int lit = total > 0 ? (done * D_BLOCKS + total / 2) / total : 0;
  for (int i = 0; i < D_BLOCKS; i++) {
    const int bx = x + i * (D_BLOCK_W + D_BLOCK_GAP);
    if (i < lit) fill(bx, y, D_BLOCK_W, D_BLOCK_H, ink);
    else d_box(bx, y, D_BLOCK_W, D_BLOCK_H, d_toward(ink, d_bg, 130));
  }
}

/* ------------------------------------------------------------------ */
/* The four marks                                                      */
/*
 * KINO's signature and its native sentence. One mark per lens, always in
 * hardware order, always meaning the same thing. Five states and no more:
 * nothing else in the interface may use these shapes.
 */
typedef enum {
  D_MARK_EMPTY = 0, /* ○  waiting, not yet, an empty slot */
  D_MARK_ON,        /* ●  ready, answered, captured, ok */
  D_MARK_HALF,      /* ◐  warming, syncing, part way */
  D_MARK_BUSY,      /* ■  calibrating, writing, charging */
  D_MARK_FAIL,      /* ✕  not answering, failed */
} d_mark_t;

static void d_mark(int cx, int cy, int r, d_mark_t m, uint16_t ink) {
  switch (m) {
    case D_MARK_ON: disc((float)cx, (float)cy, (float)r, ink, 255); break;
    case D_MARK_EMPTY:
      disc((float)cx, (float)cy, (float)r, ink, 255);
      disc((float)cx, (float)cy, (float)r - 2.f, d_bg, 255);
      break;
    case D_MARK_HALF:
      disc((float)cx, (float)cy, (float)r, ink, 255);
      disc((float)cx, (float)cy, (float)r - 2.f, d_bg, 255);
      /* The filled half is the left one, so a row part way through reads as
       * filling from the same side the row itself fills from. */
      for (int y = -r; y <= r; y++) {
        const int half = (int)(sqrtf((float)(r * r - y * y)) + 0.5f);
        if (half > 0) fill(cx - half, cy + y, half, 1, ink);
      }
      break;
    case D_MARK_BUSY: fill(cx - r + 1, cy - r + 1, 2 * r - 2, 2 * r - 2, ink); break;
    case D_MARK_FAIL:
      for (int i = -r; i <= r; i++) {
        px_set(cx + i, cy + i, ink);
        px_set(cx + i, cy - i, ink);
        px_set(cx + i + 1, cy + i, ink);
        px_set(cx + i + 1, cy - i, ink);
      }
      break;
  }
}

/**
 * The row: four numerals and four marks under them.
 *
 * `cx` is the centre of the row, `pitch` the distance between marks. With
 * `numbers` false it is just the marks - the live view wants the row without
 * the labels, because by then the user knows what they are.
 */
static void d_four(int cx, int y, int pitch, int r, const d_mark_t *m, bool numbers, const uint16_t *ink) {
  static const char *const N[4] = {"1", "2", "3", "4"};
  const int x0 = cx - (pitch * 3) / 2;
  for (int i = 0; i < 4; i++) {
    const int mx = x0 + i * pitch;
    const uint16_t c = ink ? ink[i] : d_fg;
    if (numbers) d_text_c(&UT_XS, mx, y - UT_XS.asc - UT_XS.desc - 6, N[i], D_DIM);
    d_mark(mx, y + r, r, m[i], c);
  }
}

/* ------------------------------------------------------------------ */
/* Icons: 16x16, one bit per pixel, drawn for this panel and no other   */
/*
 * Not from a library, and they do not scale. Each is two bytes a row, high
 * bit leftmost, and there are only as many as the camera actually needs.
 */
#define D_ICON 16
typedef struct {
  uint8_t b[D_ICON * 2];
} d_icon_t;

static const d_icon_t D_IC_FLASH = {{
    0x00, 0x00, 0x03, 0x80, 0x07, 0x00, 0x0E, 0x00, 0x1C, 0x00, 0x3F, 0xC0, 0x7F, 0xC0, 0x00, 0xE0,
    0x01, 0xC0, 0x03, 0x80, 0x07, 0x00, 0x0E, 0x00, 0x1C, 0x00, 0x18, 0x00, 0x00, 0x00, 0x00, 0x00,
}};
static const d_icon_t D_IC_FLASH_OFF = {{
    0x40, 0x00, 0x23, 0x80, 0x17, 0x00, 0x0E, 0x00, 0x1C, 0x00, 0x3F, 0xC0, 0x7F, 0xE0, 0x00, 0xF0,
    0x01, 0xD8, 0x03, 0x8C, 0x07, 0x06, 0x0E, 0x02, 0x1C, 0x00, 0x18, 0x00, 0x00, 0x00, 0x00, 0x00,
}};
static const d_icon_t D_IC_CARD = {{
    0x00, 0x00, 0x1F, 0xE0, 0x3F, 0xF0, 0x60, 0x18, 0x60, 0x18, 0x7F, 0xF8, 0x7F, 0xF8, 0x60, 0x18,
    0x60, 0x18, 0x60, 0x18, 0x7F, 0xF8, 0x7F, 0xF8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
}};
static const d_icon_t D_IC_LINK = {{
    0x00, 0x00, 0x00, 0x00, 0x0C, 0x30, 0x1E, 0x78, 0x33, 0xCC, 0x21, 0x84, 0x00, 0x00, 0x03, 0xC0,
    0x07, 0xE0, 0x0C, 0x30, 0x08, 0x10, 0x00, 0x00, 0x01, 0x80, 0x01, 0x80, 0x00, 0x00, 0x00, 0x00,
}};
static const d_icon_t D_IC_WARN = {{
    0x00, 0x00, 0x01, 0x80, 0x01, 0x80, 0x03, 0xC0, 0x03, 0xC0, 0x07, 0x60, 0x06, 0x60, 0x0E, 0x30,
    0x0D, 0xB0, 0x1C, 0x18, 0x18, 0x18, 0x38, 0x0C, 0x3F, 0xFC, 0x7F, 0xFE, 0x00, 0x00, 0x00, 0x00,
}};
static const d_icon_t D_IC_LOCK = {{
    0x00, 0x00, 0x07, 0xC0, 0x0C, 0x60, 0x18, 0x30, 0x18, 0x30, 0x18, 0x30, 0x3F, 0xF8, 0x3F, 0xF8,
    0x3C, 0x78, 0x3C, 0x78, 0x3F, 0xF8, 0x3F, 0xF8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
}};

static void d_icon(const d_icon_t *ic, int x, int y, uint16_t ink) {
  for (int r = 0; r < D_ICON; r++) {
    const int bits = (ic->b[r * 2] << 8) | ic->b[r * 2 + 1];
    for (int c = 0; c < D_ICON; c++)
      if (bits & (0x8000 >> c)) px_set(x + c, y + r, ink);
  }
}

/**
 * The battery: a box, a tip, and up to four bars inside it. Four bars,
 * because four is what this camera counts in - and a quarter is the
 * resolution a user can act on anyway.
 */
static void d_battery(int x, int y, int pct, uint16_t ink) {
  const int w = 26, h = 14;
  d_box(x, y, w, h, ink);
  fill(x + w, y + 4, 2, h - 8, ink);
  const int bars = pct >= 88 ? 4 : pct >= 63 ? 3 : pct >= 38 ? 2 : pct >= 13 ? 1 : 0;
  for (int i = 0; i < bars; i++) fill(x + 3 + i * 5, y + 3, 4, h - 6, ink);
}

/** An icon at an integer scale: a 16 x 16 bitmap drawn 2 x 2 per bit when a
 *  screen needs the symbol to be the subject rather than an aside. */
static void d_icon_s(const d_icon_t *ic, int x, int y, int scale, uint16_t ink) {
  for (int r = 0; r < D_ICON; r++) {
    const int bits = (ic->b[r * 2] << 8) | ic->b[r * 2 + 1];
    for (int c = 0; c < D_ICON; c++)
      if (bits & (0x8000 >> c)) fill(x + c * scale, y + r * scale, scale, scale, ink);
  }
}

/** A three pixel triangle. `dir` 0 right, 1 down, 2 left. */
static void d_arrow(int x, int y, int dir, uint16_t ink) {
  for (int i = 0; i < 5; i++) {
    const int n = 5 - i;
    if (dir == 0) fill(x + i, y + i, 1, 2 * n - 1, ink);
    else if (dir == 2) fill(x + 4 - i, y + i, 1, 2 * n - 1, ink);
    else fill(x + i, y + i, 2 * n - 1, 1, ink);
  }
}

/* ------------------------------------------------------------------ */
/* Motion: six moves, stepped, none of them eased                      */
/*
 * Everything here takes a millisecond count since the move began and returns
 * a step, not a fraction. Nothing interpolates. A move that runs longer than
 * 200 ms is a mistake, and most of these run for 60.
 */
#define D_BLINK_MS 110 /* on, then off, for a state that must be refused */
static inline bool d_blink(int64_t now_us) { return ((now_us / 1000) / D_BLINK_MS) & 1; }

/** A reveal in four steps, left to right. Returns how many columns are in. */
static inline int d_wipe(int ms, int step_ms) {
  const int n = step_ms > 0 ? ms / step_ms : 4;
  return n < 0 ? 0 : n > 4 ? 4 : n;
}
