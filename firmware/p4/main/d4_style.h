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

/*
 * Vermilion, and why it is not the red above.
 *
 * A seal is a mark, not a warning. It says a thing was made, approved, sent -
 * it never says something is wrong, and it is always the same shape in the
 * same place, which is what stops it reading as an alarm. The error red is
 * darker and duller and only ever appears on words. Shu-iro as a printed ink,
 * so it sits on the paper rather than glowing off it.
 */
#define D_VERMILION RGB(0xC9, 0x4A, 0x2C)

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

/*
 * Type over a photograph: the ground underneath is unknown - it may be a
 * blown-out window - so it is contoured. Everywhere else the ground is flat
 * and it is not.
 *
 * The contour is one pixel at caption sizes and two at display sizes. Two
 * pixels under a 16 px face is a fifth of the cap height: the word stops
 * reading as contoured and starts reading as outlined, which is the loudest
 * thing on a screen whose whole argument is that it is quiet.
 */
static void d_text_over(const ut_face_t *f, int x, int y, const char *s, uint16_t ink) {
  ut_halo_radius(f->em >= 30 ? 2 : 1);
  ut_fx2(f, (float)x + ut_w(f, s) * 0.5f, (float)y + (f->asc + f->desc) * 0.5f, s, 1.f, 1.f, 0.f, 0.f, ink, 255,
         true, 0);
  ut_halo_radius(2);
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
/* The module                                                          */
/*
 * 40 px, and the panel is exactly 20 x 12 of them. Every structural edge in
 * this interface - the margin, the field, a rule, a row, the frame of a
 * photograph - is a whole number of modules, and everything that sits inside
 * one is centred in it by arithmetic rather than by eye:
 *
 *   UT_S / UT_SB   22 px   (40 - 22) / 2 =  9
 *   UT_XS          16 px   (40 - 16) / 2 = 12
 *   the drawn face 14 px   (40 - 14) / 2 = 13
 *
 * All three are integers, which is why these are the sizes the interface
 * uses. Half a pixel of rounding in a row that repeats eight times is a list
 * that visibly leans, and on a 217 ppi panel it is visible.
 */
#define D_MOD 40
#define D_M2 (D_MOD / 2)
#define D_M4 (D_MOD / 4)

/* The field: one module in from each edge. 18 x 10 modules. Everything on a
 * machine screen is inside it; a photograph is the one thing allowed past. */
#define D_FX D_MOD
#define D_FY D_MOD
#define D_FW (UI_W - 2 * D_FX) /* 720 */
#define D_FH (UI_H - 2 * D_FY) /* 400 */
#define D_FR (D_FX + D_FW)     /* 760 - the right edge everything hangs from */
#define D_FB (D_FY + D_FH)     /* 440 */

/* The optical insets above. Named, so a screen never computes one inline and
 * gets it a pixel out. */
#define D_IN_S 9
#define D_IN_XS 12
#define D_IN_DF 13

/* The value column on a machine screen: 6 modules wide, hung off the right
 * edge of the field, with the rule that separates it 240 px in. */
#define D_VX (D_FR - 6 * D_MOD) /* 520 */

/*
 * The join is the detail.
 *
 * Where two rules would meet, they do not: the vertical stops a quarter
 * module short of the horizontal at each end. That gap is the whole
 * difference between a drawn table and a made object, and it is why there
 * are no boxes in this interface - a closed rectangle has four of those
 * joins and gets all four of them wrong.
 */
#define D_REVEAL D_M4

static void d_rule_h(int x, int y, int w, uint16_t ink) { fill(x, y, w, 1, ink); }
static void d_rule_v(int x, int y, int h, uint16_t ink) {
  if (h > 2 * D_REVEAL) fill(x, y + D_REVEAL, 1, h - 2 * D_REVEAL, ink);
}

/*
 * Selection is a mark, not a bar.
 *
 * A filled rectangle with the type knocked out of it is loud, it destroys the
 * ground it sits on, and on a list of eight rows it is the only thing anyone
 * sees. An 8 px square in the margin beside the row says the same thing at a
 * hundredth of the volume; the row itself goes from dim to ink, which is the
 * other half of the same sentence.
 */
#define D_PIP 8
static void d_pip(int x, int row_y, uint16_t ink) {
  fill(x, row_y + (D_MOD - D_PIP) / 2, D_PIP, D_PIP, ink);
}
/** The same over a photograph, which needs an edge to sit against. */
static void d_pip_over(int x, int row_y, uint16_t ink) {
  const int y = row_y + (D_MOD - D_PIP) / 2;
  fill(x - 1, y - 1, D_PIP + 2, D_PIP + 2, RGB(0x08, 0x08, 0x0A));
  fill(x, y, D_PIP, D_PIP, ink);
}

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

/*
 * A small caps label: tracked out, because a label is not a word.
 *
 * Two tracking steps and no more. A caption sits at 2, which is the smallest
 * gap that still reads as deliberate at 16 px; a screen's name sits at 6,
 * which at five or six letters is about a module of extra width and is what
 * makes a title a title without setting it any larger. Nothing in this
 * interface is set large for effect, so this is where the emphasis comes
 * from.
 */
#define D_TRACK 2
#define D_TRACK_TITLE 6

static int d_label_t(int x, int y, const char *s, uint16_t ink, int track) {
  char one[2] = {0, 0};
  for (const char *p = s; *p; p++) {
    one[0] = *p;
    ut_draw(&UT_XS, x, y, one, ink);
    x += ut_w(&UT_XS, one) + track;
  }
  return x > 0 ? x - track : x;
}
static int d_label_tw(const char *s, int track) {
  int w = 0;
  char one[2] = {0, 0};
  for (const char *p = s; *p; p++) {
    one[0] = *p;
    w += ut_w(&UT_XS, one) + track;
  }
  return w > 0 ? w - track : 0;
}
static int d_label(int x, int y, const char *s, uint16_t ink) {
  return d_label_t(x, y, s, ink, D_TRACK) + D_TRACK;
}
static int d_label_w(const char *s) { return d_label_tw(s, D_TRACK); }

/** Tracked small caps over a photograph, contoured like the rest of it. */
static int d_label_over(int x, int y, const char *s, uint16_t ink) {
  char one[2] = {0, 0};
  for (const char *p = s; *p; p++) {
    one[0] = *p;
    d_text_over(&UT_XS, x, y, one, ink);
    x += ut_w(&UT_XS, one) + D_TRACK;
  }
  return x;
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
/* On the module: a block is 30 and the gap is 10, so the pitch is exactly one
 * module and ten of them are ten modules less a gap. A progress indicator
 * that does not land on the same grid as everything else is the one object on
 * the screen that looks pasted in. */
#define D_BLOCK_W 30
#define D_BLOCK_H 12
#define D_BLOCK_GAP 10
#define D_BLOCKS 10
#define D_BLOCKS_W (D_BLOCKS * D_BLOCK_W + (D_BLOCKS - 1) * D_BLOCK_GAP)
/* The inset that centres a block row in a module-tall row. */
#define D_BLOCKS_IN ((D_MOD - D_BLOCK_H) / 2)

static void d_blocks(int x, int y, int done, int total, uint16_t ink) {
  const int lit = total > 0 ? (done * D_BLOCKS + total / 2) / total : 0;
  for (int i = 0; i < D_BLOCKS; i++) {
    const int bx = x + i * (D_BLOCK_W + D_BLOCK_GAP);
    if (i < lit) fill(bx, y, D_BLOCK_W, D_BLOCK_H, ink);
    else d_box(bx, y, D_BLOCK_W, D_BLOCK_H, d_toward(ink, d_bg, 130));
  }
}

/* ------------------------------------------------------------------ */
/* The seal                                                            */
/*
 * A hanko: a vermilion square with a mark carved out of it, stamped on a
 * photograph the camera has done something with. It is the one ornamental
 * object in this interface and it earns its place by not being ornamental -
 * what is carved into it is the four, so the mark that says "this is one of
 * mine" is the same sentence the rest of the camera speaks.
 *
 * Stamped, never drawn precisely: a seal is pressed by hand and the edge of
 * the ink is not a rectangle. The nicks are deterministic per photograph, so
 * one file's seal is always the same seal.
 */
static void d_seal(int x, int y, int side, uint32_t seed) {
  fill(x, y, side, side, D_VERMILION);
  /* The ink does not reach every corner. */
  for (int i = 0; i < 4; i++) {
    const uint32_t h = (seed * 2654435761u + i * 40503u);
    const int n = 2 + (int)((h >> 5) & 3);
    const int cx = (i & 1) ? x + side - n : x;
    const int cy = (i & 2) ? y + side - n : y;
    fill(cx, cy, n, n, d_bg);
  }
  /* The four, knocked out: two over two, the way a small seal is carved. */
  const int m = side / 5, g = side / 9;
  const int x0 = x + (side - 2 * m - g) / 2, y0 = y + (side - 2 * m - g) / 2;
  for (int i = 0; i < 4; i++)
    fill(x0 + (i % 2) * (m + g), y0 + (i / 2) * (m + g), m, m, d_bg);
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
/* ------------------------------------------------------------------ */
/* The four, on the top edge of a photograph                           */
/*
 * One tick per lens, each centred over the quarter of the picture its camera
 * made. So the chrome is not a caption about the four cameras - it is them,
 * standing in the place they are.
 *
 * The one on screen is twice the length of the others, and because the live
 * view is already a wigglegram that length steps across the top edge in time
 * with the parallax. It is the only moving chrome in the product and it
 * costs sixteen pixels of picture at the very top of the frame, where a
 * photographer has already left room.
 *
 * Two pixels wide with a one pixel dark surround, because it lives over a
 * photograph and the photograph may be a blown-out window.
 */
/* Four lengths, each visibly different from the next at arm's length: the one
 * on screen, one that has answered, one still warming, and one that has not.
 * The first cut had answered at 8 and not-answered at 3, which is the
 * difference this row exists to show and it could not be seen across a
 * room. */
#define D_TICK_W 2
#define D_TICK_LIVE 16
#define D_TICK_ON 12
#define D_TICK_HALF 7
#define D_TICK_OFF 4

static void d_ticks(int live, const d_mark_t *m) {
  for (int i = 0; i < 4; i++) {
    const int cx = UI_W / 8 + i * (UI_W / 4);
    int len = D_TICK_OFF;
    uint16_t ink = d_toward(D_PAPER, D_GRAPH, 120);
    if (i == live) { len = D_TICK_LIVE; ink = D_PAPER; }
    else if (m[i] == D_MARK_ON) len = D_TICK_ON;
    else if (m[i] == D_MARK_HALF || m[i] == D_MARK_BUSY) len = D_TICK_HALF;
    else if (m[i] == D_MARK_FAIL) { len = D_TICK_ON; ink = D_RED; }
    fill(cx - D_TICK_W / 2 - 1, 0, D_TICK_W + 2, len + 1, RGB(0x08, 0x08, 0x0A));
    fill(cx - D_TICK_W / 2, 0, D_TICK_W, len, ink);
  }
}

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
