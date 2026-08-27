#include "ui.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "audio.h"
#include "buttons.h"
#include "cam_link.h"
#include "capture.h"
#include "gallery.h"
#include "config_store.h"
#include "display.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "gfx.h"
#include "klog.h"
#include "icons.h"
#include "logo_kino_d4.h"
#include "mesh3d.h"
#include "power.h"
#include "storage.h"
#include "touch.h"
#include "viewfinder.h"
#include "ui_font.h"
#include "ui_labels.h"

static const char *TAG = "ui";

/* Written as real RGB and packed, rather than as opaque hex literals: a
 * palette nobody can read is a palette nobody will adjust. */
#define RGB(r, g, b) ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))

/* The palette is packages/design-system/tokens.css, not an invention.
 *
 * That file is the single Studio + Roll design system and states the language
 * outright: "early/mid-2000s desktop-utility - silver-blue chrome, one-pixel
 * bevels, short glossy gradients local to controls, compact density. Original
 * palette in that era's spirit - not a Windows XP clone."
 *
 * The first pass at this screen ignored all of it: a warm off-white ground
 * with pastel tiles, 14 px corners and soft full-height gradients. It read as
 * a different product from the software that drives it. Every value below is
 * the token of the same name, packed to RGB565. */
#define C_CANVAS RGB(0xf7, 0xf8, 0xfa)     /* --canvas */
#define C_PANEL RGB(0xe9, 0xee, 0xf5)      /* --panel */
#define C_PANEL_IN RGB(0xd7, 0xe0, 0xea)   /* --panel-inset */
#define C_CHROME_TOP RGB(0xf7, 0xfa, 0xfd) /* --chrome-top */
#define C_CHROME_BOT RGB(0xcc, 0xd8, 0xe6) /* --chrome-bot */
#define C_BORDER_DARK RGB(0x73, 0x83, 0x99)
#define C_BORDER_MID RGB(0xaa, 0xb7, 0xc7)
#define C_BORDER_LIGHT RGB(0xd5, 0xde, 0xe9)
#define C_LINE RGB(0xcb, 0xd6, 0xe3)
#define C_HILITE RGB(0xff, 0xff, 0xff)
#define C_INK RGB(0x18, 0x23, 0x31)   /* --text */
#define C_MUTED RGB(0x4c, 0x5a, 0x6b) /* --text-mut */
#define C_INV RGB(0xff, 0xff, 0xff)   /* --text-inv */
#define C_BLUE RGB(0x2f, 0x70, 0xc9)
#define C_BLUE_DARK RGB(0x17, 0x4e, 0x98)
#define C_GREEN RGB(0x48, 0xa8, 0x3e)
#define C_ORANGE RGB(0xf2, 0x8a, 0x2e)
#define C_RED RGB(0xc8, 0x3a, 0x3a)
#define C_SEL_TOP RGB(0x2f, 0x70, 0xc9) /* --sel-top */
#define C_SEL_BOT RGB(0x1b, 0x51, 0x99) /* --sel-bot */
#define C_SHUTTER RGB(0, 0, 0)
#define C_OK C_GREEN
#define C_BAD C_RED

/* Kept as the accent for each destination's header, drawn from the token
 * palette so the six screens are still distinguishable at a glance without
 * inventing six new hues. */
static const uint16_t TILE_COLOUR[6] = {
    C_BLUE,                  /* MODE */
    RGB(0xf4, 0xc5, 0x42),   /* FLASH    - --yellow */
    C_GREEN,                 /* GALLERY */
    C_ORANGE,                /* ROLL */
    RGB(0x73, 0x83, 0x99),   /* SETTINGS - --border-dark, a steel */
    RGB(0x6e, 0xa3, 0xe8),   /* STATUS   - --blue-hi */
};

#define MARGIN 20
#define GAP 12
#define COLS 3
#define ROWS 2
#define TILE_W ((UI_W - 2 * MARGIN - (COLS - 1) * GAP) / COLS)
#define TILE_H ((UI_H - 2 * MARGIN - (ROWS - 1) * GAP) / ROWS)
/* --r is 3px. Fourteen was a phone's corner radius on a desktop-utility
 * surface, and it is most of why the grid looked like a different product. */
#define RADIUS 3

/* Detail screens: a header carrying the title and the way back, then a body. */
#define HEAD_H 72
#define BACK_W 86

typedef enum {
  /* The viewfinder is what the camera shows when it is being used as a
   * camera. The six-tile launcher moved behind the MENU key rather than
   * being the front page: a four-lens body whose screen cannot show four
   * lenses is a body you have to frame by guesswork. */
  SCREEN_VIEWFINDER = -2,
  SCREEN_HOME = -1,
  SCREEN_MODE = 0,
  SCREEN_FLASH,
  SCREEN_GALLERY,
  SCREEN_ROLL,
  SCREEN_SETTINGS,
  SCREEN_STATUS,
} screen_t;

static uint16_t *s_cv;               /* the landscape canvas, from gfx */
static screen_t s_screen = SCREEN_VIEWFINDER;
/* When the result banner first went up, so it can come down on time. */
static int64_t s_shot_seen_us;
static int s_pressed = -1;           /* which hit region is held, -1 for none */
static int s_mode = 0;               /* WIGGLE / BURST / SINGLE */
static int s_flash = 1;              /* OFF / AUTO / ON */
static float s_spin;                 /* STATUS screen model angle */

/* ------------------------------------------------------------------ */
/* Primitives. Landscape and linear, so a horizontal run is a run of   */
/* memory - the rotation to the portrait panel is the PPA's job.       */
/* ------------------------------------------------------------------ */

static inline void px_set(int x, int y, uint16_t c) {
  if ((unsigned)x < UI_W && (unsigned)y < UI_H) s_cv[(size_t)y * UI_W + x] = c;
}

static void fill(int x, int y, int w, int h, uint16_t colour) {
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > UI_W) w = UI_W - x;
  if (y + h > UI_H) h = UI_H - y;
  if (w <= 0 || h <= 0) return;
  for (int r = 0; r < h; r++) {
    uint16_t *row = s_cv + (size_t)(y + r) * UI_W + x;
    for (int i = 0; i < w; i++) row[i] = colour;
  }
}

/* Two RGB565 colours, k of 0..256 toward b. */
static uint16_t mix(uint16_t a, uint16_t b, int k) {
  const int ar = (a >> 11) & 0x1F, ag = (a >> 5) & 0x3F, ab = a & 0x1F;
  const int br = (b >> 11) & 0x1F, bg = (b >> 5) & 0x3F, bb = b & 0x1F;
  const int r = ar + (((br - ar) * k) >> 8);
  const int g = ag + (((bg - ag) * k) >> 8);
  const int bl = ab + (((bb - ab) * k) >> 8);
  return (uint16_t)((r << 11) | (g << 5) | bl);
}

/* Rounded rectangle with a vertical gradient. The corner is a quarter circle
 * tested per row, which is exact rather than the stepped approximation a few
 * stacked rectangles give - at this size the stepping is the difference
 * between a product and a prototype.
 *
 * The gradient is not decoration: a flat fill reads as paint, a gradient
 * reads as a lit surface, and the whole point of this look is that everything
 * on screen appears to be under the same key light as the objects. */
static void fill_round_grad(int x, int y, int w, int h, int r, uint16_t top, uint16_t bot) {
  if (r * 2 > w) r = w / 2;
  if (r * 2 > h) r = h / 2;
  if (h <= 0) return;
  for (int row = 0; row < h; row++) {
    int inset = 0;
    if (row < r) {
      const int dy = r - row - 1;
      inset = r - (int)__builtin_sqrtf((float)(r * r - dy * dy));
    } else if (row >= h - r) {
      const int dy = row - (h - r);
      inset = r - (int)__builtin_sqrtf((float)(r * r - dy * dy));
    }
    fill(x + inset, y + row, w - 2 * inset, 1, mix(top, bot, row * 256 / h));
  }
}

/* A vertical gradient across a plain rectangle. */
static void fill_grad(int x, int y, int w, int h, uint16_t top, uint16_t bot) {
  if (h <= 0) return;
  for (int r = 0; r < h; r++) fill(x, y + r, w, 1, mix(top, bot, r * 256 / h));
}

/* A one-pixel outline. */
static void outline(int x, int y, int w, int h, uint16_t c) {
  fill(x, y, w, 1, c);
  fill(x, y + h - 1, w, 1, c);
  fill(x, y, 1, h, c);
  fill(x + w - 1, y, 1, h, c);
}

/**
 * The four-stop control gradient from tokens.css.
 *
 * --grad-btn is white at 0%, #f0f4f9 at 45%, #dde6f0 at 50% and #cfdae7 at
 * 100%. That hard step at the midpoint is the whole character of the era's
 * controls: a smooth two-stop ramp reads as a modern button, this reads as a
 * 2003 one. Reproducing it needs the stops, not an approximation.
 */
static void fill_stops4(int x, int y, int w, int h, uint16_t c0, uint16_t c45, uint16_t c50,
                        uint16_t c100) {
  if (h <= 0) return;
  const int m45 = h * 45 / 100, m50 = h * 50 / 100;
  for (int row = 0; row < h; row++) {
    uint16_t c;
    if (row < m45) c = mix(c0, c45, m45 ? row * 256 / m45 : 0);
    else if (row < m50) c = mix(c45, c50, (m50 - m45) ? (row - m45) * 256 / (m50 - m45) : 0);
    else c = mix(c50, c100, (h - m50) ? (row - m50) * 256 / (h - m50) : 0);
    fill(x, y + row, w, 1, c);
  }
}

/* A raised control: the button gradient, a dark keyline, and a white inner
 * bevel along the top and left. One pixel each, per the design system. */
static void control(int x, int y, int w, int h, bool primary, bool down) {
  if (primary) {
    if (down)
      fill_stops4(x, y, w, h, RGB(0x1d, 0x4c, 0x94), RGB(0x26, 0x61, 0x9f), RGB(0x2f, 0x70, 0xc9),
                  RGB(0x35, 0x76, 0xcc));
    else
      fill_stops4(x, y, w, h, RGB(0x35, 0x76, 0xcc), RGB(0x2f, 0x70, 0xc9), RGB(0x26, 0x61, 0x9f),
                  RGB(0x1d, 0x4c, 0x94));
    outline(x, y, w, h, C_BLUE_DARK);
    return;
  }
  if (down)
    fill_stops4(x, y, w, h, RGB(0xc8, 0xd4, 0xe2), RGB(0xd8, 0xe1, 0xec), RGB(0xdc, 0xe4, 0xee),
                RGB(0xe4, 0xeb, 0xf3));
  else
    fill_stops4(x, y, w, h, C_HILITE, RGB(0xf0, 0xf4, 0xf9), RGB(0xdd, 0xe6, 0xf0),
                RGB(0xcf, 0xda, 0xe7));
  outline(x, y, w, h, C_BORDER_DARK);
  if (!down) {
    fill(x + 1, y + 1, w - 2, 1, C_HILITE);
    fill(x + 1, y + 1, 1, h - 2, C_HILITE);
  }
}

/* One 1bpp bitmap at an integer scale. Scale exists so the six chrome labels
 * can also serve as screen titles without a second, larger rendering of every
 * word sitting in flash. */
static void draw_bits(const uint8_t *bits, int w, int h, int stride, int x, int y, int scale,
                      uint16_t ink) {
  for (int row = 0; row < h; row++) {
    const uint8_t *src = bits + (size_t)row * stride;
    for (int col = 0; col < w; col++) {
      if (!(src[col >> 3] & (0x80 >> (col & 7)))) continue;
      if (scale == 1) {
        px_set(x + col, y + row, ink);
      } else {
        fill(x + col * scale, y + row * scale, scale, scale, ink);
      }
    }
  }
}

/* Same blit, but only over pixels that are currently the ground colour.
 *
 * This is how the boot iris masks the wordmark without a second buffer or a
 * point-in-polygon test per pixel: the aperture has already been painted in
 * ground, so "is this pixel ground" is exactly "is this pixel inside the
 * aperture". */
static void draw_bits_clipped(const uint8_t *bits, int w, int h, int stride, int x, int y,
                              uint16_t ink) {
  for (int row = 0; row < h; row++) {
    const int gy = y + row;
    if ((unsigned)gy >= UI_H) continue;
    const uint8_t *src = bits + (size_t)row * stride;
    for (int col = 0; col < w; col++) {
      if (!(src[col >> 3] & (0x80 >> (col & 7)))) continue;
      const int gx = x + col;
      if ((unsigned)gx >= UI_W) continue;
      if (s_cv[(size_t)gy * UI_W + gx] != C_CANVAS) continue;
      s_cv[(size_t)gy * UI_W + gx] = ink;
    }
  }
}

static int text_w(const ui_font_t *f, const char *s) {
  int w = 0;
  for (; *s; s++) {
    const int i = (unsigned char)*s - f->first;
    if (i < 0 || i >= f->count) continue;
    w += f->glyphs[i].adv;
  }
  return w;
}

/* Draw a string with its top-left at (x, y). */
static void text(const ui_font_t *f, int x, int y, const char *s, uint16_t ink) {
  for (; *s; s++) {
    const int i = (unsigned char)*s - f->first;
    if (i < 0 || i >= f->count) continue;
    const ui_glyph_t *g = &f->glyphs[i];
    draw_bits(g->bits, g->w, f->line_h, g->stride, x, y, 1, ink);
    x += g->adv;
  }
}

static void text_right(const ui_font_t *f, int x, int y, const char *s, uint16_t ink) {
  text(f, x - text_w(f, s), y, s, ink);
}

/* ------------------------------------------------------------------ */
/* Boot splash                                                         */
/* ------------------------------------------------------------------ */

/**
 * Fill a convex polygon aperture with the ground colour, everything outside
 * it staying as it was.
 *
 * Scanline spans rather than a per-pixel inside test: for a convex polygon
 * each row is one contiguous run, so a frame costs a walk of the edges per
 * row instead of 384000 point-in-polygon tests.
 */
static void aperture(int cx, int cy, float radius, float rot, int sides, uint16_t colour) {
  if (radius <= 0.5f) return;
  float vx[12], vy[12];
  if (sides > 12) sides = 12;
  for (int i = 0; i < sides; i++) {
    const float a = rot + (float)i * 6.2831853f / (float)sides;
    vx[i] = cx + radius * __builtin_cosf(a);
    vy[i] = cy + radius * __builtin_sinf(a);
  }
  int y0 = UI_H, y1 = -1;
  for (int i = 0; i < sides; i++) {
    if ((int)vy[i] < y0) y0 = (int)vy[i];
    if ((int)vy[i] > y1) y1 = (int)vy[i];
  }
  if (y0 < 0) y0 = 0;
  if (y1 >= UI_H) y1 = UI_H - 1;

  for (int y = y0; y <= y1; y++) {
    float xmin = 1e9f, xmax = -1e9f;
    const float fy = (float)y + 0.5f;
    for (int i = 0; i < sides; i++) {
      const int j = (i + 1) % sides;
      const float ay = vy[i], by = vy[j];
      if ((fy < ay && fy < by) || (fy > ay && fy > by)) continue;
      if (ay == by) continue;
      const float t = (fy - ay) / (by - ay);
      const float x = vx[i] + t * (vx[j] - vx[i]);
      if (x < xmin) xmin = x;
      if (x > xmax) xmax = x;
    }
    if (xmax < xmin) continue;
    fill((int)xmin, y, (int)(xmax - xmin) + 1, 1, colour);
  }
}

/**
 * Boot splash: a camera iris opening onto the wordmark.
 *
 * Six blades, and the aperture rotates slightly as it grows, because a real
 * iris does — the blades sweep rather than simply scaling.
 *
 * Driven by the clock, not by a frame count. The previous version slept a
 * fixed interval per frame, so whenever a frame ran long the blades fell
 * behind and the open read as stuttering; now each frame asks the clock where
 * the blades should be, and a slow frame costs smoothness rather than timing.
 */
static void splash(void) {
  const int cx = UI_W / 2, cy = UI_H / 2;
  const int lx = cx - KINO_D4_LOGO_W / 2, ly = cy - KINO_D4_LOGO_H / 2;
  const float r_max = 1.05f * __builtin_sqrtf((float)(cx * cx + cy * cy));

  const int SHUT_MS = 240; /* held closed, so the open has something to leave */
  const int OPEN_MS = 1250;
  const int HOLD_MS = 420;
  const float SWEEP = 0.95f; /* blade travel; too little and it reads as a wipe */

  fill(0, 0, UI_W, UI_H, C_SHUTTER);
  gfx_present();
  vTaskDelay(pdMS_TO_TICKS(SHUT_MS));

  /* The click lands as the blades break, not before: sound leading the
   * picture reads as a glitch, sound with it reads as a mechanism. */
  if (config_bool("body.sounds.startup", true)) audio_shutter();

  const int64_t start = esp_timer_get_time();
  for (;;) {
    const float t = (float)(esp_timer_get_time() - start) / (float)(OPEN_MS * 1000);
    if (t >= 1.0f) break;
    /* Cubic ease-out: the blades break away quickly and slow as they reach
     * the edges, which is how a sprung iris actually behaves. */
    const float inv = 1.0f - t;
    const float e = 1.0f - inv * inv * inv;
    fill(0, 0, UI_W, UI_H, C_SHUTTER);
    aperture(cx, cy, e * r_max, e * SWEEP, 6, C_CANVAS);
    draw_bits_clipped(KINO_D4_LOGO, KINO_D4_LOGO_W, KINO_D4_LOGO_H, KINO_D4_LOGO_STRIDE, lx, ly,
                      C_INK);
    gfx_present();
  }

  fill(0, 0, UI_W, UI_H, C_CANVAS);
  draw_bits(KINO_D4_LOGO, KINO_D4_LOGO_W, KINO_D4_LOGO_H, KINO_D4_LOGO_STRIDE, lx, ly, 1, C_INK);
  gfx_present();
  vTaskDelay(pdMS_TO_TICKS(HOLD_MS));
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

static void tile_rect(int i, int *x, int *y, int *w, int *h) {
  const int col = i % COLS, row = i / COLS;
  *x = MARGIN + col * (TILE_W + GAP);
  *y = MARGIN + row * (TILE_H + GAP);
  *w = TILE_W;
  *h = TILE_H;
}

/**
 * Home: six objects on a light ground, and nothing else.
 *
 * No captions. The reference camera has none - the objects carry the meaning
 * on their own, and a word under each one both admits the icon failed and
 * halves the size it can be drawn at. Losing them bought 36 px of icon.
 *
 * No coloured blocks either. Blocks the size of these tiles dominate the
 * screen and say nothing about what they do; the colour has moved to where it
 * means something - the press state, and the header of the screen the tile
 * opens.
 */
static void draw_home(void) {
  fill(0, 0, UI_W, UI_H, C_CANVAS);
  for (int i = 0; i < 6; i++) {
    int x, y, w, h;
    tile_rect(i, &x, &y, &w, &h);

    if (i == s_pressed) {
      /* Studio's selection: --grad-sel, top to bottom, inside a one-pixel
       * --blue-dark keyline. The same treatment a selected row gets in the
       * desktop app, at thumb size. */
      fill_round_grad(x, y, w, h, RADIUS, C_SEL_TOP, C_SEL_BOT);
      outline(x, y, w, h, C_BLUE_DARK);
    }
    icons_blit(s_cv, UI_W, UI_H, i, x + (w - ICON_PX) / 2, y + (h - ICON_PX) / 2);
  }
}


/* Header: the way back, and the title. The chevron is drawn rather than
 * rendered as a glyph so it stays crisp at any size and needs no font. */
static void draw_header(screen_t s) {
  /* --grad-head with a --border-mid hairline, and the destination's colour as
   * a three-pixel accent under it. Flooding the whole bar with the accent
   * made six differently coloured screens; the chrome should be the same
   * chrome everywhere, with identity carried by a stripe. */
  fill_grad(0, 0, UI_W, HEAD_H, RGB(0xf4, 0xf8, 0xfc), RGB(0xdf, 0xe7, 0xf1));
  fill(0, HEAD_H - 3, UI_W, 3, TILE_COLOUR[s]);
  fill(0, HEAD_H, UI_W, 1, C_BORDER_MID);

  /* Two strokes meeting at a point on the left, which is a chevron and reads
   * as "back". Drawn rather than set as a glyph so it stays crisp and needs
   * no font, and because a font would have to carry a character for it. */
  const int cxp = 30, cyp = HEAD_H / 2;
  const uint16_t ink = s_pressed == 100 ? C_BLUE : C_INK;
  /* The apex is at i = 0, so it must sit at the LEFT and the arms open to the
   * right. Putting the apex on the right draws a perfectly tidy ">", which is
   * the arrow for going forward. */
  for (int i = 0; i <= 15; i++) {
    fill(cxp + i, cyp - i - 2, 4, 4, ink);
    fill(cxp + i, cyp + i - 2, 4, 4, ink);
  }

  if (s < UI_LABEL_COUNT) {
    const ui_label_t *l = &UI_LABELS[s];
    draw_bits(l->bits, l->w, l->h, l->stride, BACK_W, (HEAD_H - l->h) / 2, 1, C_INK);
  }
}

/* A labelled row of values, which is most of what these screens are. */
static void row(int y, const char *key, const char *value, uint16_t value_ink) {
  text(&UI_FONT_S, MARGIN + 12, y, key, C_MUTED);
  text_right(&UI_FONT_M, UI_W - MARGIN - 12, y - 4, value, value_ink);
}

/* A horizontal set of choices. Returns nothing; hit testing uses the same
 * geometry through option_rect() so the two cannot drift apart. */
static void option_rect(int i, int count, int y, int *x, int *w) {
  const int total = UI_W - 2 * (MARGIN + 12);
  const int gap = 14;
  *w = (total - (count - 1) * gap) / count;
  *x = MARGIN + 12 + i * (*w + gap);
  (void)y;
}

static void draw_options(int y, const char *const *names, int count, int selected, uint16_t tint,
                         int press_base) {
  for (int i = 0; i < count; i++) {
    int x, w;
    option_rect(i, count, y, &x, &w);
    const bool on = i == selected;
    const bool down = s_pressed == press_base + i;
    control(x, y, w, 84, on, down);
    const int tw = text_w(&UI_FONT_M, names[i]);
    text(&UI_FONT_M, x + (w - tw) / 2, y + (84 - UI_FONT_M.line_h) / 2, names[i],
         on ? C_INV : C_INK);
    (void)tint;
  }
}

static const char *const MODE_NAMES[3] = {"WIGGLE", "BURST", "SINGLE"};
static const char *const FLASH_NAMES[3] = {"OFF", "AUTO", "ON"};

static void human_bytes(char *out, size_t n, uint64_t bytes) {
  if (bytes >= (1ULL << 30)) snprintf(out, n, "%.1f GB", (double)bytes / (double)(1ULL << 30));
  else if (bytes >= (1ULL << 20)) snprintf(out, n, "%.0f MB", (double)bytes / (double)(1ULL << 20));
  else snprintf(out, n, "%llu B", (unsigned long long)bytes);
}

static void draw_status_body(void) {
  /* The camera, as it actually is: four lenses in a row at 22 mm pitch. */
  const int VW = 320, VH = 300;
  const int vx = MARGIN + 12, vy = HEAD_H + 40;
  if (mesh3d_ready()) {
    mesh3d_draw(s_cv, UI_W, UI_H, vx, vy, VW, VH, M3_CAMERA, s_spin, 0.26f, 1.28f, C_CANVAS);
  }

  camlink_info_t info;
  camlink_get_info(&info);

  int y = HEAD_H + 44;
  const int rx = vx + VW + 30;
  char buf[48];

  text(&UI_FONT_S, rx, y, "CAM1", C_MUTED);
  text(&UI_FONT_M, rx + 70, y - 4, info.online ? "ONLINE" : "OFFLINE", info.online ? C_OK : C_BAD);
  y += 44;

  if (info.sensor[0]) {
    text(&UI_FONT_S, rx, y, "SENSOR", C_MUTED);
    text(&UI_FONT_M, rx + 70, y - 4, info.sensor, C_INK);
    y += 44;
  }
  if (info.temp_c != CAMLINK_TEMP_UNKNOWN) {
    snprintf(buf, sizeof buf, "%ld C", (long)info.temp_c);
    text(&UI_FONT_S, rx, y, "TEMP", C_MUTED);
    text(&UI_FONT_M, rx + 70, y - 4, buf, C_INK);
    y += 44;
  }
  snprintf(buf, sizeof buf, "%lu ms", (unsigned long)info.latency_ms);
  text(&UI_FONT_S, rx, y, "LINK", C_MUTED);
  text(&UI_FONT_M, rx + 70, y - 4, buf, C_INK);
  y += 44;

  /* The other three bays are real hardware that this firmware cannot yet
   * address, and saying so is better than leaving three blanks that look like
   * a rendering fault. */
  text(&UI_FONT_S, rx, y, "CAM2-4", C_MUTED);
  text(&UI_FONT_S, rx + 70, y, "not wired yet", C_MUTED);
}

/* ------------------------------------------------------------------ */
/* Gallery                                                             */
/* ------------------------------------------------------------------ */

#define GAL_GAP 12
#define GAL_LABEL_H 20

/** One tile's top-left, laid out 3x2 under the header. */
static void gal_origin(int slot, int *x, int *y) {
  const int grid_w = GALLERY_COLS * GALLERY_TILE_W + (GALLERY_COLS - 1) * GAL_GAP;
  const int cell_h = GALLERY_TILE_H + GAL_LABEL_H;
  const int grid_h = GALLERY_ROWS * cell_h + (GALLERY_ROWS - 1) * GAL_GAP;
  const int x0 = (UI_W - grid_w) / 2;
  /* Centred in what is left between the header and the footer line, so the
   * grid does not sit hard against either. */
  const int y0 = HEAD_H + (UI_H - HEAD_H - 28 - grid_h) / 2;
  *x = x0 + (slot % GALLERY_COLS) * (GALLERY_TILE_W + GAL_GAP);
  *y = y0 + (slot / GALLERY_COLS) * (cell_h + GAL_GAP);
}

static void gal_blit(const uint16_t *px, int x, int y) {
  for (int row_y = 0; row_y < GALLERY_TILE_H; row_y++) {
    memcpy(s_cv + (size_t)(y + row_y) * UI_W + x, px + (size_t)row_y * GALLERY_TILE_W,
           (size_t)GALLERY_TILE_W * sizeof(uint16_t));
  }
}

static void draw_gallery(void) {
  const gallery_item_t *slots = gallery_slots();
  const int total = gallery_total();

  if (total == 0) {
    /* Three different nothings, and a person needs to know which: no card at
     * all, a card with no pictures on it, or a card the camera could not
     * read. Showing one empty grid for all three is how a broken card gets
     * mistaken for an empty one. */
    storage_status_t sd;
    storage_get_status(&sd);
    const char *line = !sd.present  ? "NO CARD"
                       : !sd.mounted ? "CARD NOT READABLE"
                                     : "NO CAPTURES YET";
    const char *hint = !sd.present  ? "Insert a microSD card."
                       : !sd.mounted ? "The card is there but would not mount."
                                     : "Press SHOOT. Frames land in /KINO/CAPTURES.";
    const int lw = text_w(&UI_FONT_M, line);
    text(&UI_FONT_M, (UI_W - lw) / 2, UI_H / 2 - 24, line, sd.mounted ? C_MUTED : C_BAD);
    const int hw = text_w(&UI_FONT_S, hint);
    text(&UI_FONT_S, (UI_W - hw) / 2, UI_H / 2 + 6, hint, C_MUTED);
    return;
  }

  for (int i = 0; i < GALLERY_PAGE; i++) {
    int x, y;
    gal_origin(i, &x, &y);
    const gallery_item_t *it = &slots[i];
    if (it->state == TILE_EMPTY) continue;

    /* A one-pixel well around every tile, lit or not, so the grid keeps its
     * shape while the pictures are still arriving. */
    fill(x - 1, y - 1, GALLERY_TILE_W + 2, GALLERY_TILE_H + 2, C_MUTED);
    if (it->state == TILE_READY && it->pixels != NULL) {
      gal_blit(it->pixels, x, y);
    } else {
      fill(x, y, GALLERY_TILE_W, GALLERY_TILE_H, RGB(0x22, 0x26, 0x2c));
      const char *why = it->state == TILE_PENDING ? "LOADING" : "NO IMAGE";
      const int ww = text_w(&UI_FONT_S, why);
      text(&UI_FONT_S, x + (GALLERY_TILE_W - ww) / 2, y + GALLERY_TILE_H / 2 - 8, why,
           RGB(0x6a, 0x74, 0x82));
    }

    text(&UI_FONT_S, x, y + GALLERY_TILE_H + 5, it->label, C_INK);
    /* The count is the part that can be bad news, so the count is the part
     * that changes colour - "wiggle" in red says the mode went wrong. */
    char count[12];
    snprintf(count, sizeof count, "%d/%d", it->frames, CAPTURE_CAMS);
    const int cw = text_w(&UI_FONT_S, count);
    text_right(&UI_FONT_S, x + GALLERY_TILE_W, y + GALLERY_TILE_H + 5, count,
               it->partial ? C_BAD : C_MUTED);
    text_right(&UI_FONT_S, x + GALLERY_TILE_W - cw - 8, y + GALLERY_TILE_H + 5, it->mode,
               C_MUTED);
  }

  /* Arrows in the margins, which is exactly where the page-turn taps are.
   * A footer that says "tap an edge" is an instruction; an arrow sitting on
   * the edge is the control itself. Drawn only in the direction that has a
   * page, so a dead end looks like one. Same two strokes as the header's back
   * chevron, for the same reason: no font carries this character. */
  const int mid = HEAD_H + (UI_H - HEAD_H) / 2;
  if (gallery_page() > 0) {
    for (int i = 0; i <= 13; i++) {
      fill(24 + i, mid - i - 2, 4, 4, C_MUTED);
      fill(24 + i, mid + i - 2, 4, 4, C_MUTED);
    }
  }
  if (gallery_page() + 1 < gallery_pages()) {
    /* Apex on the right this time - the arms open to the left. */
    for (int i = 0; i <= 13; i++) {
      fill(UI_W - 28 - i, mid - i - 2, 4, 4, C_MUTED);
      fill(UI_W - 28 - i, mid + i - 2, 4, 4, C_MUTED);
    }
  }

  char foot[64];
  snprintf(foot, sizeof foot, "%d capture%s - page %d of %d", total, total == 1 ? "" : "s",
           gallery_page() + 1, gallery_pages());
  text(&UI_FONT_S, MARGIN + 12, UI_H - 24, foot, C_MUTED);
  if (gallery_loading()) {
    text_right(&UI_FONT_S, UI_W - MARGIN - 12, UI_H - 24, "READING CARD", C_MUTED);
  }
}

/**
 * Rolls, and what this build can honestly say about them.
 *
 * Starting a roll from the camera needs a network, and this body has none:
 * the ESP32-C6 co-processor that carries the radio is not brought up, so
 * there is no SDIO link to it, no Wi-Fi, and nothing that could reach the
 * Roll API. `NETWORK_*` and `ROLL_*` are in the protocol and unimplemented
 * here, and `GET_CAPABILITIES` says so.
 *
 * A screen offering CREATE ROLL over that would be a button that cannot work
 * - the same failure as a shutter that logged instead of capturing. What the
 * camera can truthfully offer today is the folder every capture already goes
 * into, and the count of them waiting to be collected.
 */
static void draw_roll(void) {
  const int body = HEAD_H + 40;
  storage_status_t st;
  storage_get_status(&st);

  char buf[48];
  if (!st.mounted) {
    row(body, "CARD", st.present ? "PRESENT, NOT MOUNTED" : "NO CARD", C_BAD);
    if (st.last_error) row(body + 46, "ERROR", st.last_error, C_BAD);
  } else {
    snprintf(buf, sizeof buf, "%d", gallery_total());
    row(body, "CAPTURES", buf, C_INK);
    row(body + 46, "FOLDER", "/KINO/CAPTURES", C_INK);
    human_bytes(buf, sizeof buf, st.free_bytes);
    /* Free space, not capacity: how many more photographs fit is the question
     * someone standing at a party is actually asking. */
    row(body + 92, "FREE", buf, C_INK);
    snprintf(buf, sizeof buf, "%s  write %s", st.filesystem ? st.filesystem : "-",
             st.write_test ? st.write_test : "untested");
    row(body + 138, "CARD", buf, C_INK);
  }
  row(body + 184, "NETWORK", "NONE", C_BAD);
  row(body + 230, "UPLOAD", "OVER USB, FROM STUDIO", C_INK);

  text(&UI_FONT_S, MARGIN + 12, UI_H - MARGIN - 46,
       "Starting a roll on the camera needs the C6 radio, which this build does not",
       C_MUTED);
  text(&UI_FONT_S, MARGIN + 12, UI_H - MARGIN - 24,
       "bring up. Connect Studio over USB-C and create the roll there.", C_MUTED);
}

static void draw_detail(screen_t s) {
  fill(0, 0, UI_W, UI_H, C_CANVAS);
  draw_header(s);

  const int body = HEAD_H + 40;
  char buf[48];

  switch (s) {
    case SCREEN_MODE:
      text(&UI_FONT_S, MARGIN + 12, body - 26, "CAPTURE MODE", C_MUTED);
      draw_options(body, MODE_NAMES, 3, s_mode, TILE_COLOUR[SCREEN_MODE], 200);
      text(&UI_FONT_S, MARGIN + 12, body + 116,
           s_mode == 0   ? "Four lenses fire together. One wiggle per press."
           : s_mode == 1 ? "Repeats while the shutter is held."
                         : "One frame from CAM2, the metering lens.",
           C_MUTED);
      break;

    case SCREEN_FLASH:
      text(&UI_FONT_S, MARGIN + 12, body - 26, "FLASH", C_MUTED);
      draw_options(body, FLASH_NAMES, 3, s_flash, TILE_COLOUR[SCREEN_FLASH], 200);
      text(&UI_FONT_S, MARGIN + 12, body + 116, "350-500 mA while lit. Recharge gates the shutter.",
           C_MUTED);
      break;

    case SCREEN_GALLERY:
      draw_gallery();
      break;

    case SCREEN_ROLL:
      draw_roll();
      break;

    case SCREEN_SETTINGS: {
      row(body, "FIRMWARE", KINO_FW_VERSION, C_INK);
      snprintf(buf, sizeof buf, "%lu s", (unsigned long)(esp_timer_get_time() / 1000000));
      row(body + 46, "UPTIME", buf, C_INK);

      /* The power settings, and what they are currently doing. Shown together
       * on purpose: a timeout you cannot see counting is a timeout nobody
       * trusts, and this is the screen someone opens when the camera went
       * dark sooner than they expected. */
      power_state_t pw;
      power_get(&pw);
      snprintf(buf, sizeof buf, "%s  %lus idle",
               pw.stage == POWER_AWAKE ? "AWAKE" : pw.stage == POWER_DIM ? "DIM" : "ASLEEP",
               (unsigned long)pw.idle_s);
      row(body + 92, "DISPLAY", buf, pw.stage == POWER_AWAKE ? C_OK : C_MUTED);

      snprintf(buf, sizeof buf, "%d s / %d s", config_int("body.autoDimS", 30),
               config_int("body.sleepS", 120));
      row(body + 138, "DIM / SLEEP", buf, C_INK);

      snprintf(buf, sizeof buf, "%s  after %d s", pw.cam_bank_on ? "ON" : "OFF",
               config_int("body.camIdleTimeoutS", 300));
      row(body + 184, "CAMERA BANK", buf, pw.cam_bank_on ? C_OK : C_MUTED);

      row(body + 230, "STUDIO", pw.usb_attached ? "CONNECTED" : "NOT CONNECTED",
          pw.usb_attached ? C_OK : C_MUTED);
      text(&UI_FONT_S, MARGIN + 12, UI_H - MARGIN - 22,
           "Battery is not measured on this body - no sense divider to the P4.", C_MUTED);
      break;
    }

    case SCREEN_STATUS:
      draw_status_body();
      break;

    default:
      break;
  }
}

/* Defined below, next to the layout constants it needs. */
#define VF_PANE_W 300
#define VF_PANE_H 225
#define VF_GAP 8
#define VF_X0 14
#define VF_Y0 12
#define VF_SIDE_X (VF_X0 + 2 * VF_PANE_W + VF_GAP + 16)

static void draw_viewfinder(void);

/**
 * What the camera is doing about the shutter, over whatever screen is up.
 *
 * Three seconds pass between the click and the frames being on the card, and
 * for those three seconds a camera that shows nothing is a camera that looks
 * broken. It is drawn over every screen rather than only the viewfinder
 * because the physical shutter fires from anywhere, and the answer to "did
 * that work" should not depend on which menu was open.
 */
static void draw_capture_banner(void) {
  const capture_stage_t cs = capture_stage();
  if (cs == CAPTURE_IDLE) return;

  capture_report_t r;
  capture_last(&r);

  char line[64];
  uint16_t accent = C_BLUE;
  switch (cs) {
    case CAPTURE_TRIGGERING:
      snprintf(line, sizeof line, "CAPTURING");
      break;
    case CAPTURE_READING:
      snprintf(line, sizeof line, "READING FRAMES");
      break;
    case CAPTURE_WRITING:
      snprintf(line, sizeof line, "WRITING TO CARD");
      break;
    default:
      if (!r.ok) {
        /* The code, not a shrug. "CAPTURE FAILED" tells someone standing at
         * a bench nothing they can act on; SD_NOT_MOUNTED tells them to
         * check the card. */
        snprintf(line, sizeof line, "%s", r.err_code[0] != '\0' ? r.err_code : "CAPTURE FAILED");
        accent = C_BAD;
      } else {
        snprintf(line, sizeof line, "%s - %d of %d frames", r.id, r.stored, r.online);
        accent = r.stored == r.online ? C_OK : C_BAD;
      }
      break;
  }

  /* Stops short of the viewfinder's right-hand rail, because SHOOT lives
   * there and covering the shutter with a report about the shutter is the
   * one place this banner must not reach. Every other screen has nothing to
   * protect down there, so it runs the full width. */
  const int h = 44;
  const int y = UI_H - h;
  const int w = s_screen == SCREEN_VIEWFINDER ? VF_SIDE_X - 12 : UI_W;
  fill(0, y, w, h, RGB(0x12, 0x16, 0x1c));
  fill(0, y, w, 1, accent);
  fill(0, y + 1, 5, h - 1, accent);
  text(&UI_FONT_S, 18, y + (h - 18) / 2, line, RGB(0xe4, 0xe9, 0xee));

  if (cs == CAPTURE_DONE && r.ok) {
    char right[40];
    snprintf(right, sizeof right, "%lu KB - %lu ms", (unsigned long)(r.bytes / 1024),
             (unsigned long)r.total_ms);
    text_right(&UI_FONT_S, w - 18, y + (h - 18) / 2, right, RGB(0x8a, 0x95, 0xa2));
  }
}

static void draw_screen(void) {
  if (s_screen == SCREEN_VIEWFINDER) draw_viewfinder();
  else if (s_screen == SCREEN_HOME) draw_home();
  else draw_detail(s_screen);
  draw_capture_banner();
}

/* ------------------------------------------------------------------ */
/* Bench: send the composed frame back over the console                */
/* ------------------------------------------------------------------ */
#if KINO_UI_FRAME_DUMP
/**
 * Emit the canvas, downscaled, as base64 RGB565 so it can be decoded into a
 * picture on the bench.
 *
 * Every visual defect this UI has had - a vertical mirror, a wrong init
 * table, an upside-down rotation - looked identical from the serial log,
 * which said everything was fine. This is the cheapest way to actually look
 * at what was drawn without standing over the board, and at 160x96 it is
 * about three seconds of console.
 */
static void dump_frame(const char *tag, int DW, int DH) {
  static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  /* Scaled per sample rather than by a truncated integer step: UI_W / DW is
   * 2 for a 320-wide dump, which quietly cropped the picture to 638x382 and
   * made the right-hand column of icons look like it was missing. */
  printf("\nFRAME_BEGIN %s %d %d\n", tag, DW, DH);
  for (int y = 0; y < DH; y++) {
    char line[320 * 4 + 8];
    int n = 0;
    uint8_t raw[320 * 2];
    for (int x = 0; x < DW; x++) {
      /* Point sample. The question this answers is "what is on the screen",
       * and averaging would hide a one-pixel seam that matters. */
      const uint16_t p = s_cv[(size_t)(y * UI_H / DH) * UI_W + (x * UI_W / DW)];
      raw[x * 2] = (uint8_t)(p & 0xFF);
      raw[x * 2 + 1] = (uint8_t)(p >> 8);
    }
    for (int i = 0; i < DW * 2; i += 3) {
      const uint32_t v = ((uint32_t)raw[i] << 16) | ((uint32_t)(i + 1 < DW * 2 ? raw[i + 1] : 0) << 8) |
                         (uint32_t)(i + 2 < DW * 2 ? raw[i + 2] : 0);
      line[n++] = B64[(v >> 18) & 63];
      line[n++] = B64[(v >> 12) & 63];
      line[n++] = B64[(v >> 6) & 63];
      line[n++] = B64[v & 63];
    }
    line[n] = 0;
    printf("FR %s\n", line);
    /* The console FIFO is smaller than a frame; without this the tail of
     * every row is dropped and the picture arrives shredded. */
    vTaskDelay(pdMS_TO_TICKS(14));
  }
  printf("FRAME_END\n");
}
#endif

/* ------------------------------------------------------------------ */
/* Viewfinder                                                          */
/* ------------------------------------------------------------------ */

/* Four panes in the order the lenses sit on the bar - CAM1 leftmost - laid
 * out 2x2 rather than in a row. A row of four 4:3 panes across 800 px leaves
 * each 195 px wide and 146 tall, which is too small to judge a face in; 2x2
 * gives 300x225 each, and the top row still reads left-to-right as CAM1 CAM2.
 * The strip down the right carries what the panes cannot say. */

static void vf_pane_rect(int cam, int *x, int *y) {
  *x = VF_X0 + (cam % 2) * (VF_PANE_W + VF_GAP);
  *y = VF_Y0 + (cam / 2) * (VF_PANE_H + VF_GAP);
}

/* Nearest-neighbour blit of a VF_W x VF_H tile into a pane. The tile is
 * 320x240 and the pane 300x225, so this is a slight downscale - close enough
 * to 1:1 that resampling would cost more than it returns. */
static void vf_blit(const uint16_t *tile, int px, int py) {
  for (int y = 0; y < VF_PANE_H; y++) {
    const uint16_t *src = tile + (size_t)(y * VF_H / VF_PANE_H) * VF_W;
    uint16_t *dst = s_cv + (size_t)(py + y) * UI_W + px;
    for (int x = 0; x < VF_PANE_W; x++) dst[x] = src[x * VF_W / VF_PANE_W];
  }
}

static void draw_viewfinder(void) {
  fill(0, 0, UI_W, UI_H, RGB(0x18, 0x1b, 0x20));

  static const char *NAMES[4] = {"CAM1", "CAM2", "CAM3", "CAM4"};
  for (int i = 0; i < 4; i++) {
    int px, py;
    vf_pane_rect(i, &px, &py);

    const uint16_t *tile = viewfinder_ready() ? viewfinder_tile(i) : NULL;
    vf_status_t st = {0};
    if (viewfinder_ready()) viewfinder_status(i, &st);

    if (tile != NULL) {
      vf_blit(tile, px, py);
    } else {
      /* No pixels: say which of the several reasons it is, rather than
       * showing a black rectangle that could mean any of them. */
      fill(px, py, VF_PANE_W, VF_PANE_H, RGB(0x22, 0x26, 0x2c));
      const char *why = st.state == VF_ERROR    ? "FRAME DID NOT DECODE"
                        : st.state == VF_STALLED ? "NO RECENT FRAME"
                                                 : "NO LINK";
      const int tw = text_w(&UI_FONT_S, why);
      text(&UI_FONT_S, px + (VF_PANE_W - tw) / 2, py + VF_PANE_H / 2 - 8, why,
           RGB(0x6a, 0x74, 0x82));
    }

    /* Label and rate over the bottom-left of the pane, on a scrim so it stays
     * readable over a bright frame. */
    fill(px, py + VF_PANE_H - 22, VF_PANE_W, 22, RGB(0x10, 0x12, 0x16));
    text(&UI_FONT_S, px + 8, py + VF_PANE_H - 21, NAMES[i],
         st.state == VF_LIVE ? RGB(0xd7, 0xdd, 0xe2) : RGB(0x6a, 0x74, 0x82));
    if (st.state == VF_LIVE) {
      char rate[24];
      snprintf(rate, sizeof rate, "%lu.%lu fps", (unsigned long)(st.fps_x10 / 10),
               (unsigned long)(st.fps_x10 % 10));
      text_right(&UI_FONT_S, px + VF_PANE_W - 8, py + VF_PANE_H - 21, rate,
                 RGB(0x6a, 0x74, 0x82));
    }
    outline(px, py, VF_PANE_W, VF_PANE_H, RGB(0x3a, 0x42, 0x4c));
  }

  /* Right-hand strip: the MENU key, and the state a pane cannot carry. */
  const int mx = VF_SIDE_X, mw = UI_W - VF_SIDE_X - 14;
  control(mx, VF_Y0, mw, 62, false, s_pressed == 300);
  const int tw = text_w(&UI_FONT_M, "MENU");
  text(&UI_FONT_M, mx + (mw - tw) / 2, VF_Y0 + (62 - UI_FONT_M.line_h) / 2, "MENU", C_INK);

  storage_status_t sd;
  storage_get_status(&sd);
  char buf[32];
  text(&UI_FONT_S, mx, VF_Y0 + 84, "CARD", RGB(0x6a, 0x74, 0x82));
  text(&UI_FONT_S, mx, VF_Y0 + 104, sd.mounted ? "READY" : "NONE",
       sd.mounted ? C_OK : C_BAD);
  if (sd.mounted) {
    snprintf(buf, sizeof buf, "%llu GB free",
             (unsigned long long)(sd.free_bytes / (1024ULL * 1024 * 1024)));
    text(&UI_FONT_S, mx, VF_Y0 + 124, buf, RGB(0x6a, 0x74, 0x82));
  }

  text(&UI_FONT_S, mx, VF_Y0 + 160, "MODE", RGB(0x6a, 0x74, 0x82));
  text(&UI_FONT_S, mx, VF_Y0 + 180, config_str("mode", "wiggle"), RGB(0xd7, 0xdd, 0xe2));

  /* The shutter, at the bottom of the strip where a thumb reaches it. */
  const int sy = UI_H - 14 - 84;
  control(mx, sy, mw, 84, true, s_pressed == 301);
  const int stw = text_w(&UI_FONT_M, "SHOOT");
  text(&UI_FONT_M, mx + (mw - stw) / 2, sy + (84 - UI_FONT_M.line_h) / 2, "SHOOT", C_INV);
}

/* ------------------------------------------------------------------ */
/* The shutter                                                         */
/* ------------------------------------------------------------------ */

/**
 * One shutter, whichever thing pressed it.
 *
 * The on-screen key and the physical button both land here. Two ways to fire
 * one shutter must not become two implementations of firing it - that is how
 * the button ends up saving to a different place, or skipping the sound, or
 * not waking the screen.
 */
static void fire_shutter(bool long_press) {
  /* The sound plays on the press, not on the result. A shutter that waits to
   * confirm before it clicks feels broken even when it worked: the click is
   * feedback for the finger, and the finger has already moved on by the time
   * four frames are on the card. */
  if (config_bool("body.sounds.save", true)) audio_shutter();

  if (!capture_request(long_press ? "shutter-hold" : "shutter")) {
    /* Already shooting. Dropping the press is the right answer - queueing it
     * would give someone a second photograph of whatever the room looked
     * like three seconds after they asked for one. */
    klog("P4", "shutter ignored - a capture is already running");
  }
}

/* Called from the button task, not the UI task. Only ever posts work the UI
 * picks up, so a press cannot block on a redraw. */
static void on_button(button_id_t id, bool long_press) {
  if (id != BTN_SHUTTER) return;
  fire_shutter(long_press);
}

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

/* Hit regions. Tiles are 0..5, the back chevron is 100, options are 200+i —
 * one namespace so the pressed state is a single integer. */
static int hit_test(int x, int y) {
  if (s_screen == SCREEN_VIEWFINDER) {
    const int mx = VF_SIDE_X, mw = UI_W - VF_SIDE_X - 14;
    if (x >= mx && x < mx + mw) {
      if (y >= VF_Y0 && y < VF_Y0 + 62) return 300;              /* MENU */
      if (y >= UI_H - 14 - 84 && y < UI_H - 14) return 301;      /* SHOOT */
    }
    return -1;
  }
  if (s_screen == SCREEN_HOME) {
    for (int i = 0; i < 6; i++) {
      int tx, ty, tw, th;
      tile_rect(i, &tx, &ty, &tw, &th);
      if (x >= tx && x < tx + tw && y >= ty && y < ty + th) return i;
    }
    return -1;
  }

  if (y < HEAD_H) return 100; /* the whole header goes back; a 30 px chevron
                               * is a smaller target than a thumb is wide */

  if (s_screen == SCREEN_GALLERY && y > HEAD_H && gallery_total() > 0) {
    /* The outer eighth of each side turns the page. Wide enough for a thumb,
     * and outside the grid, which is centred and narrower than the screen. */
    const int margin = (UI_W - (GALLERY_COLS * GALLERY_TILE_W + (GALLERY_COLS - 1) * 12)) / 2;
    if (x < margin) return 400;
    if (x >= UI_W - margin) return 401;
  }

  if (s_screen == SCREEN_MODE || s_screen == SCREEN_FLASH) {
    const int oy = HEAD_H + 40;
    if (y >= oy && y < oy + 84) {
      for (int i = 0; i < 3; i++) {
        int ox, ow;
        option_rect(i, 3, oy, &ox, &ow);
        if (x >= ox && x < ox + ow) return 200 + i;
      }
    }
  }
  return -1;
}

static void activate(int region) {
  if (s_screen == SCREEN_VIEWFINDER) {
    if (region == 300) {
      s_screen = SCREEN_HOME;
      gfx_snapshot();
      s_pressed = -1;
      draw_screen();
      gfx_dissolve(220);
    } else if (region == 301) {
      fire_shutter(false);
      s_pressed = -1;
      draw_screen();
      gfx_present();
    }
    return;
  }
  if (s_screen == SCREEN_HOME) {
    if (region >= 0 && region < 6) {
      s_screen = (screen_t)region;
      /* Rescan on the way in rather than on a timer. The card can be pulled,
       * written to on a laptop and put back, and no watcher on this device
       * would know - so the moment someone asks to look is the only honest
       * time to go and look. */
      if (s_screen == SCREEN_GALLERY) gallery_refresh();
      gfx_snapshot();
      s_pressed = -1;
      draw_screen();
      gfx_dissolve(260);
    }
    return;
  }
  if (region == 100) {
    s_screen = SCREEN_HOME;
    gfx_snapshot();
    s_pressed = -1;
    draw_screen();
    gfx_dissolve(260);
    return;
  }
  if (region == 400 || region == 401) {
    gallery_turn(region == 400 ? -1 : 1);
    s_pressed = -1;
    draw_screen();
    gfx_present();
    return;
  }
  if (region >= 200 && region < 203) {
    const int i = region - 200;
    if (s_screen == SCREEN_MODE) s_mode = i;
    if (s_screen == SCREEN_FLASH) s_flash = i;
    s_pressed = -1;
    draw_screen();
    gfx_present();
  }
}

static void icons_task(void *arg) {
  (void)arg;
  const int64_t t0 = esp_timer_get_time();
  if (icons_build() != ESP_OK) {
    ESP_LOGW(TAG, "icons unavailable - the grid will be empty");
  } else {
    ESP_LOGI(TAG, "icons ready in %lu ms",
             (unsigned long)((esp_timer_get_time() - t0) / 1000));
  }
  vTaskDelete(NULL);
}

static void ui_task(void *arg) {
  (void)arg;
  splash();

  /* The splash is over; the grid needs its objects. In practice this has
   * always already finished, but a bounded wait beats drawing six holes. */
  for (int i = 0; i < 200 && !icons_ready(); i++) vTaskDelay(pdMS_TO_TICKS(10));

  /* The first grid arrives as a dissolve rather than a cut. A full-screen
   * change with no transition reads as a fault, not as progress. */
  gfx_snapshot();
  draw_screen();
  uint32_t f0 = 0, f1 = 0, ms = 0;
  gfx_stats(&f0, NULL);
  gfx_dissolve(420);
  gfx_stats(&f1, &ms);
  /* Reported because "is the transition smooth" is a measurable question and
   * was previously answered by looking at it. */
  ESP_LOGI(TAG, "boot dissolve: %lu frames in %lu ms (%lu fps)", (unsigned long)(f1 - f0),
           (unsigned long)ms, (unsigned long)(ms ? (f1 - f0) * 1000 / ms : 0));

#if KINO_UI_FRAME_DUMP
  /* Home at full detail - it is the screen whose icons have to be judged.
   * The rest only need their layout checking, which reads at a quarter. */
  dump_frame("home", 320, 192);
  s_pressed = 4;
  draw_screen();
  dump_frame("press", 160, 96);
  s_pressed = -1;
  s_screen = SCREEN_STATUS;
  draw_screen();
  dump_frame("status", 320, 192);
  s_screen = SCREEN_MODE;
  draw_screen();
  dump_frame("mode", 160, 96);
  s_screen = SCREEN_HOME;
  draw_screen();
  gfx_present();
#endif

  int held = -1;
  int64_t last_spin = esp_timer_get_time();

  for (;;) {
    uint16_t tx = 0, ty = 0;
    int region = -1;
    const bool down = touch_ready() && touch_get(&tx, &ty);

    /* The touch that wakes a sleeping screen wakes it and nothing else.
     *
     * Reaching into a bag for a camera whose backlight has timed out and
     * having it fire whatever tile your thumb happened to land on is the
     * worst possible answer, and it is what the naive version does: the
     * backlight is off but the UI is still running and still hit-testing.
     * The whole press is swallowed until the finger lifts. */
    if (!down) power_end_wake_gesture();
    if (power_wake_gesture()) {
      /* The touch task already turned the panel back on; this press exists
       * only to have done that. Swallow it until the finger lifts. */
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }

    if (down) {
      /* Touch reports in panel space, so the same quarter turn applies in
       * reverse. Measured: sweeping left to right moved touch y across its
       * full range while x held constant, which makes touch y the logical x. */
      const int lx = ty;
      const int ly = DISPLAY_H_RES - 1 - tx;
      region = hit_test(lx, ly);
    }

    if (down && region != s_pressed) {
      /* Press feedback is immediate; activation waits for the release, so a
       * finger that lands on the wrong tile can be slid off it. */
      s_pressed = region;
      held = region;
      /* body.sounds.ui is a real setting, not decoration: someone who turns
       * UI sounds off in Studio expects silence from the glass. */
      if (region >= 0 && config_bool("body.sounds.ui", true)) audio_tick();
      draw_screen();
      gfx_present();
    } else if (!down && held >= 0) {
      const int fired = (s_pressed == held) ? held : -1;
      s_pressed = -1;
      held = -1;
      if (fired >= 0) {
        activate(fired);
      } else {
        draw_screen();
        gfx_present();
      }
    }

    /* The nodes are only asked for frames while the viewfinder is the screen
     * being looked at. Left running behind a menu it would be four sensors
     * and four UARTs burning battery to fill a buffer nobody reads. */
    viewfinder_run(s_screen == SCREEN_VIEWFINDER);

    /* The viewfinder and the STATUS model both animate, so they redraw on
     * their own clock rather than only on input. Everything else is static
     * and costs nothing. */
    /* Retire the result banner once it has been up for as long as the
     * settings say. `displayAfterShotS` is in the envelope and had nothing
     * implementing it; this is what it was for. Zero means do not linger,
     * which is a real preference for anyone shooting quickly. */
    const capture_stage_t cstage = capture_stage();
    if (cstage == CAPTURE_DONE) {
      if (s_shot_seen_us == 0) s_shot_seen_us = esp_timer_get_time();
      const int hold_s = config_int("shoot.displayAfterShotS", 2);
      if (esp_timer_get_time() - s_shot_seen_us > (int64_t)hold_s * 1000000) {
        capture_ack();
        s_shot_seen_us = 0;
        draw_screen();
        gfx_present();
      }
    } else if (cstage == CAPTURE_IDLE) {
      s_shot_seen_us = 0;
    }

    /* A capture in progress and a gallery still decoding both change what is
     * on screen without anyone touching anything, so both have to drive the
     * repaint themselves. */
    if (held < 0 && s_screen != SCREEN_VIEWFINDER &&
        (cstage != CAPTURE_IDLE || (s_screen == SCREEN_GALLERY && gallery_loading()))) {
      draw_screen();
      gfx_present();
      vTaskDelay(pdMS_TO_TICKS(90));
      continue;
    }

    if (s_screen == SCREEN_VIEWFINDER && held < 0) {
      draw_screen();
      gfx_present();
      /* Paced against the link, not the panel: new frames arrive a few times
       * a second at best, and repainting faster only burns bandwidth the
       * PPA could be spending on something else. */
      vTaskDelay(pdMS_TO_TICKS(60));
    } else if (s_screen == SCREEN_STATUS && held < 0) {
      const int64_t now = esp_timer_get_time();
      s_spin += (float)(now - last_spin) / 1000000.0f * 0.55f;
      last_spin = now;
      if (s_spin > 6.2831853f) s_spin -= 6.2831853f;
      draw_screen();
      gfx_present();
    } else {
      last_spin = esp_timer_get_time();
      vTaskDelay(pdMS_TO_TICKS(20));
    }
  }
}

esp_err_t ui_start(void) {
  if (!display_ready()) return ESP_ERR_INVALID_STATE;

  esp_err_t err = gfx_init();
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "compositor unavailable: %s", esp_err_to_name(err));
    return err;
  }
  s_cv = gfx_canvas();

  /* The 3D viewport is smaller than the screen, so the depth buffer is sized
   * to it rather than to the frame. */
  err = mesh3d_init(320, 300);
  if (err != ESP_OK) ESP_LOGW(TAG, "3D unavailable: %s - the viewfinder loses its body",
                              esp_err_to_name(err));

  /* The physical shutter runs the same path as the on-screen key. */
  buttons_on_press(on_button);

  ESP_LOGI(TAG, "UI_READY %dx%d landscape via PPA, tiles %dx%d", UI_W, UI_H, TILE_W, TILE_H);
  xTaskCreate(ui_task, "ui", 6144, NULL, 4, NULL);

  /* The icon builder starts AFTER the UI, and the order is the whole point.
   *
   * Expanding six icons is tens of milliseconds rather than the best part of
   * a second it cost while they were supersampled polygons, but the ordering
   * still matters: started first it simply ran to completion before the
   * splash existed, because it outranks the task calling ui_start() and "on
   * its own task" bought nothing at all. Created second, the UI task is
   * already animating and blocking on frame timing, and the builder fills
   * exactly those gaps.
   *
   * Not gated on mesh3d. It used to be, because one of the six icons was a
   * render of the camera mesh; all six are raster now, and leaving the gate
   * in place would have let a 3D failure - which costs the viewfinder its
   * body and nothing else - take the whole home screen down with it. */
  xTaskCreate(icons_task, "icons", 4096, NULL, 3, NULL);
  return ESP_OK;
}
