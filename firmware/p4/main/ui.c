#include "ui.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "audio.h"
#include "buttons.h"
#include "cam_link.h"
#include "capture.h"
#include "cJSON.h"
#include "gallery.h"
#include "config_store.h"
#include "display.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "gfx.h"
#include "klog.h"
#include "taskmon.h"
#include "icons.h"
#include "logo_kino_d4.h"
#include "meta.h"
#include "mesh3d.h"
#include "power.h"
#include "storage.h"
#include "thumb.h"
#include "touch.h"
#include "viewfinder.h"
#include "ui_font.h"
#include "ui_labels.h"

static const char *TAG = "ui";

#define CAPTURES_DIR "/sdcard/KINO/CAPTURES"

/* Written as real RGB and packed, rather than as opaque hex literals: a
 * palette nobody can read is a palette nobody will adjust. */
#define RGB(r, g, b) ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))

/* The palette is packages/design-system/tokens.css, not an invention. That
 * file is the single Studio + Roll design system and states the language
 * outright: early/mid-2000s desktop-utility, silver-blue chrome, one-pixel
 * bevels, short glossy gradients local to controls, compact density. */
#define C_CANVAS RGB(0xf7, 0xf8, 0xfa)
#define C_PANEL RGB(0xe9, 0xee, 0xf5)
#define C_PANEL_IN RGB(0xd7, 0xe0, 0xea)
#define C_CHROME_TOP RGB(0xf7, 0xfa, 0xfd)
#define C_CHROME_BOT RGB(0xcc, 0xd8, 0xe6)
#define C_BORDER_DARK RGB(0x73, 0x83, 0x99)
#define C_BORDER_MID RGB(0xaa, 0xb7, 0xc7)
#define C_LINE RGB(0xcb, 0xd6, 0xe3)
#define C_HILITE RGB(0xff, 0xff, 0xff)
#define C_INK RGB(0x18, 0x23, 0x31)
#define C_MUTED RGB(0x4c, 0x5a, 0x6b)
#define C_FAINT RGB(0x5a, 0x6a, 0x7d)
#define C_INV RGB(0xff, 0xff, 0xff)
#define C_BLUE RGB(0x2f, 0x70, 0xc9)
#define C_BLUE_DARK RGB(0x17, 0x4e, 0x98)
#define C_BLUE_WASH RGB(0xdc, 0xe9, 0xfb)
#define C_GREEN RGB(0x48, 0xa8, 0x3e)
#define C_YELLOW RGB(0xf4, 0xc5, 0x42)
#define C_RED RGB(0xc8, 0x3a, 0x3a)
#define C_SEL_TOP RGB(0x2f, 0x70, 0xc9)
#define C_SEL_BOT RGB(0x1b, 0x51, 0x99)
#define C_WELL RGB(0x26, 0x2e, 0x38)
#define C_OK C_GREEN
#define C_BAD C_RED

/* Dark chrome, for the viewfinder and the photograph views. */
#define D_GROUND RGB(0x14, 0x18, 0x1e)
#define D_PANE RGB(0x22, 0x26, 0x2c)
#define D_EDGE RGB(0x3a, 0x42, 0x4c)
#define D_TEXT RGB(0xd7, 0xdd, 0xe2)
#define D_DIM RGB(0x6a, 0x74, 0x82)

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

/* Main menu. No status bar: passive information does not get a permanent
 * strip on a camera. What is glanceable lives where it is useful - battery in
 * the viewfinder, storage only when it is running out. */
#define M_MARGIN 24
#define M_GAP 16
#define M_COLS 3
#define M_ROWS 2
#define M_TILE_W ((UI_W - 2 * M_MARGIN - (M_COLS - 1) * M_GAP) / M_COLS)  /* 240 */
#define M_TILE_H ((UI_H - 2 * M_MARGIN - (M_ROWS - 1) * M_GAP) / M_ROWS)  /* 208 */
#define M_LABEL_H 24
#define M_STACK (ICON_BOX + 10 + M_LABEL_H)  /* icon, air, label */

#define RADIUS 3

/* Detail screens. */
#define HEAD_H 62
#define BACK_W 84
#define ROW_H 52
#define BODY_Y (HEAD_H + 1)

/* Viewfinder.
 *
 * Four 4:3 previews in a 2x2 on a 5:3 panel leaves a column of dead space
 * down each side no matter what - the block is 4:3 and the screen is not. So
 * the panes take the full height and the three controls live in the columns
 * that were going to be empty anyway. Putting them in strips above and below
 * instead costs 27 px of pane height each, which is 49% of the picture area,
 * to fill margins that stay dark either way. */
#define VF_MARGIN 6
#define VF_GAP 6
#define VF_PANE_H ((UI_H - 2 * VF_MARGIN - VF_GAP) / 2)            /* 231 */
#define VF_PANE_W (VF_PANE_H * 4 / 3)                              /* 308 */
#define VF_BLOCK_W (2 * VF_PANE_W + VF_GAP)                        /* 622 */
#define VF_X0 ((UI_W - VF_BLOCK_W) / 2)                            /* 89 */
#define VF_Y0 VF_MARGIN
#define VF_COL_R (VF_X0 + VF_BLOCK_W)                              /* 711 */
#define VF_COL_W (UI_W - VF_COL_R)                                 /* 89 */

/* The single-photograph view decodes at this size rather than scaling the
 * gallery thumbnail: thumb_load takes any target, so there is no reason to
 * show someone a 208 px thumbnail blown up to half the screen. */
#define PH_W 520
#define PH_H 390

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

typedef enum {
  SCR_MENU = 0,
  SCR_VIEWFINDER,
  SCR_MODE,
  SCR_LOOK,
  SCR_GALLERY,
  SCR_PHOTO,
  SCR_ROLL,
  SCR_SETTINGS,
  SCR_DISPLAY,
  SCR_SOUND,
  SCR_CONNECTION,
  SCR_STORAGE,
  SCR_ABOUT,
  SCR_POWER,
  SCR_COUNT,
} screen_t;

/* Index into UI_LABELS, whose order is fixed by tools/mktext.mjs. */
typedef enum {
  T_MODE = 0, T_LOOK, T_GALLERY, T_ROLL, T_SETTINGS, T_POWER,
  T_PHOTO, T_DISPLAY, T_SOUND, T_CONNECTION, T_STORAGE, T_ABOUT,
} title_t;

static const int SCREEN_TITLE[SCR_COUNT] = {
    [SCR_MENU] = -1, [SCR_VIEWFINDER] = -1,
    [SCR_MODE] = T_MODE, [SCR_LOOK] = T_LOOK, [SCR_GALLERY] = T_GALLERY,
    [SCR_PHOTO] = T_PHOTO, [SCR_ROLL] = T_ROLL, [SCR_SETTINGS] = T_SETTINGS,
    [SCR_DISPLAY] = T_DISPLAY, [SCR_SOUND] = T_SOUND, [SCR_CONNECTION] = T_CONNECTION,
    [SCR_STORAGE] = T_STORAGE, [SCR_ABOUT] = T_ABOUT, [SCR_POWER] = T_POWER,
};

/* Where Back goes. One level, always, and never to a remembered screen. */
static const screen_t SCREEN_PARENT[SCR_COUNT] = {
    [SCR_MENU] = SCR_MENU, [SCR_VIEWFINDER] = SCR_MENU,
    [SCR_MODE] = SCR_MENU, [SCR_LOOK] = SCR_MENU, [SCR_GALLERY] = SCR_MENU,
    [SCR_PHOTO] = SCR_GALLERY, [SCR_ROLL] = SCR_MENU, [SCR_SETTINGS] = SCR_MENU,
    [SCR_DISPLAY] = SCR_SETTINGS, [SCR_SOUND] = SCR_SETTINGS,
    [SCR_CONNECTION] = SCR_SETTINGS, [SCR_STORAGE] = SCR_SETTINGS,
    [SCR_ABOUT] = SCR_SETTINGS, [SCR_POWER] = SCR_MENU,
};

/* The six menu tiles, in grid order, and where each one goes. */
static const screen_t MENU_DEST[6] = {
    SCR_MODE, SCR_LOOK, SCR_GALLERY, SCR_ROLL, SCR_SETTINGS, SCR_POWER,
};
static const char *const MENU_LABEL[6] = {
    "MODE", "LOOK", "GALLERY", "ROLL", "SETTINGS", "POWER",
};

typedef enum { DLG_NONE = 0, DLG_SHUTDOWN, DLG_RESTART, DLG_DELETE, DLG_FORMAT } dialog_t;

static uint16_t *s_cv;
static screen_t s_screen = SCR_MENU;
static int s_focus[SCR_COUNT];
static int s_pressed = -1;      /* held item index, -1 for none */
static dialog_t s_dialog = DLG_NONE;
static int s_dlg_focus;          /* 0 = safe action, 1 = the other one */
static int64_t s_shot_seen_us;
static char s_toast[48];
static int64_t s_toast_us;
static uint16_t *s_photo;        /* PH_W * PH_H, decoded on entering SCR_PHOTO */
static bool s_photo_ok;
static char s_photo_id[40];
static char s_photo_label[16];
static char s_photo_mode[12];
static int s_photo_frames;

/* Item index reserved for the header's Back target on every detail screen.
 * Kept out of the 0..N-1 range so a screen's own items can be plain indices. */
#define IT_BACK 200

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
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

static uint16_t mix(uint16_t a, uint16_t b, int k) {
  const int ar = (a >> 11) & 0x1F, ag = (a >> 5) & 0x3F, ab = a & 0x1F;
  const int br = (b >> 11) & 0x1F, bg = (b >> 5) & 0x3F, bb = b & 0x1F;
  const int r = ar + (((br - ar) * k) >> 8);
  const int g = ag + (((bg - ag) * k) >> 8);
  const int bl = ab + (((bb - ab) * k) >> 8);
  return (uint16_t)((r << 11) | (g << 5) | bl);
}

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

static void fill_grad(int x, int y, int w, int h, uint16_t top, uint16_t bot) {
  if (h <= 0) return;
  for (int r = 0; r < h; r++) fill(x, y + r, w, 1, mix(top, bot, r * 256 / h));
}

static void outline(int x, int y, int w, int h, uint16_t c) {
  fill(x, y, w, 1, c);
  fill(x, y + h - 1, w, 1, c);
  fill(x, y, 1, h, c);
  fill(x + w - 1, y, 1, h, c);
}

/* The four-stop control gradient from tokens.css. That hard step at the
 * midpoint is the whole character of the era's controls: a smooth two-stop
 * ramp reads as a modern button, this reads as a 2003 one. */
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

static void draw_bits(const uint8_t *bits, int w, int h, int stride, int x, int y, int scale,
                      uint16_t ink) {
  for (int row = 0; row < h; row++) {
    const uint8_t *src = bits + (size_t)row * stride;
    for (int col = 0; col < w; col++) {
      if (!(src[col >> 3] & (0x80 >> (col & 7)))) continue;
      if (scale == 1) px_set(x + col, y + row, ink);
      else fill(x + col * scale, y + row * scale, scale, scale, ink);
    }
  }
}

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

static void text_mid(const ui_font_t *f, int cx, int y, const char *s, uint16_t ink) {
  text(f, cx - text_w(f, s) / 2, y, s, ink);
}

/**
 * A lightning bolt, as row spans.
 *
 * The one glyph in the whole interface that had to be drawn rather than
 * sourced: the font is ASCII 32..126 and has no such character, and the
 * Windows 98 archive - which every other icon comes from - has no flash or
 * lightning asset at all. Everything else on screen is either type or an
 * original 1998 icon.
 */
static void bolt(int x, int y, int scale, uint16_t c) {
  static const uint8_t SPAN[14][2] = {
      {4, 4}, {3, 4}, {3, 4}, {2, 4}, {2, 4}, {1, 5}, {1, 7},
      {0, 6}, {0, 4}, {3, 3}, {2, 3}, {2, 2}, {1, 2}, {1, 1},
  };
  for (int r = 0; r < 14; r++)
    fill(x + SPAN[r][0] * scale, y + r * scale, SPAN[r][1] * scale, scale, c);
}

/* A left-pointing chevron, drawn rather than set as a glyph: the font is ASCII
 * 32..126 and carries no such character. */
static void chevron(int x, int cy, uint16_t ink) {
  for (int i = 0; i <= 12; i++) {
    fill(x + i, cy - i - 2, 3, 3, ink);
    fill(x + i, cy + i - 2, 3, 3, ink);
  }
}

/* ------------------------------------------------------------------ */
/* Configuration writes                                                */
/*                                                                     */
/* Every control on every screen goes through one of these. The old UI */
/* had MODE and FLASH mutating statics and never touching the store,   */
/* so the screens did not change what the camera did - and the         */
/* viewfinder, which read the config, visibly disagreed with the       */
/* screen you had just used.                                           */
/* ------------------------------------------------------------------ */

/**
 * Build {"a":{"b":{"c":leaf}}} from "a.b.c" and merge it.
 *
 * config_merge takes a bare config object and deep-merges it, so a patch is
 * exactly the path spelled out as nested objects with the new value at the
 * bottom. Everything the config store does not see stays as it was.
 */
static bool cfg_patch(const char *path, cJSON *leaf) {
  /* The nesting is meta.c's, so it can be host-tested against the real cJSON
   * rather than only exercised by pressing buttons on a bench. */
  cJSON *root = meta_patch_path(path, leaf);
  if (root == NULL) return false;

  const esp_err_t err = config_merge(root);
  cJSON_Delete(root);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "config merge failed for %s: %s", path, esp_err_to_name(err));
    return false;
  }
  config_save();
  return true;
}

static bool cfg_set_str(const char *path, const char *v) {
  return cfg_patch(path, cJSON_CreateString(v));
}
static bool cfg_set_int(const char *path, int v) {
  return cfg_patch(path, cJSON_CreateNumber(v));
}
static bool cfg_set_bool(const char *path, bool v) {
  return cfg_patch(path, cJSON_CreateBool(v));
}

/* power.c reports USB through a snapshot struct rather than a getter. */
static bool usb_attached(void) {
  power_state_t p;
  power_get(&p);
  return p.usb_attached;
}

static void toast(const char *s) {
  snprintf(s_toast, sizeof s_toast, "%s", s);
  s_toast_us = esp_timer_get_time();
}

/* ------------------------------------------------------------------ */
/* Flash and mode, the two controls that live on the viewfinder        */
/* ------------------------------------------------------------------ */

static const char *const FLASH_ORDER[3] = {"auto", "on", "off"};

static int flash_index(void) {
  const char *v = config_str("shoot.flashMode", "auto");
  for (int i = 0; i < 3; i++) if (strcmp(v, FLASH_ORDER[i]) == 0) return i;
  return 0;
}

static void flash_cycle(void) {
  const int next = (flash_index() + 1) % 3;
  cfg_set_str("shoot.flashMode", FLASH_ORDER[next]);
}

static bool mode_is_quad(void) { return strcmp(config_str("mode", "wiggle"), "quad") == 0; }

/* ------------------------------------------------------------------ */
/* Boot splash                                                         */
/* ------------------------------------------------------------------ */

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

static void splash(void) {
  const int lx = (UI_W - KINO_D4_LOGO_W) / 2;
  const int ly = (UI_H - KINO_D4_LOGO_H) / 2;
  const int OPEN_MS = 620, HOLD_MS = 320;
  const float rmax = 1.06f * __builtin_sqrtf((float)(UI_W * UI_W + UI_H * UI_H)) * 0.5f;

  const int64_t t0 = esp_timer_get_time();
  for (;;) {
    const int64_t el = (esp_timer_get_time() - t0) / 1000;
    if (el >= OPEN_MS) break;
    const float t = (float)el / (float)OPEN_MS;
    const float e = 1.0f - (1.0f - t) * (1.0f - t);
    fill(0, 0, UI_W, UI_H, RGB(0x0b, 0x0d, 0x10));
    aperture(UI_W / 2, UI_H / 2, e * rmax, e * 0.5f, 6, C_CANVAS);
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
/* Shared chrome                                                       */
/* ------------------------------------------------------------------ */

static void draw_header(screen_t s) {
  fill_grad(0, 0, UI_W, HEAD_H, RGB(0xf4, 0xf8, 0xfc), RGB(0xdf, 0xe7, 0xf1));
  fill(0, HEAD_H, UI_W, 1, C_BORDER_MID);
  const uint16_t ink = (s_pressed == IT_BACK) ? C_BLUE : C_INK;
  chevron(26, HEAD_H / 2, ink);
  const int t = SCREEN_TITLE[s];
  if (t >= 0 && t < UI_LABEL_COUNT) {
    const ui_label_t *l = &UI_LABELS[t];
    draw_bits(l->bits, l->w, l->h, l->stride, BACK_W, (HEAD_H - l->h) / 2, 1, C_INK);
  }
}

/* One list row. `value` may be NULL; `arrow` adds the "opens a screen" mark,
 * which a row that acts in place must never have. */
static void draw_row(int y, bool focused, bool enabled, const char *title, const char *value,
                     bool arrow, uint16_t value_ink) {
  if (focused) fill_grad(0, y, UI_W, ROW_H, C_SEL_TOP, C_SEL_BOT);
  fill(0, y + ROW_H - 1, UI_W, 1, focused ? C_BLUE_DARK : C_LINE);

  const uint16_t ti = focused ? C_INV : (enabled ? C_INK : C_FAINT);
  const uint16_t vi = focused ? RGB(0xdc, 0xe9, 0xfb) : (enabled ? value_ink : C_FAINT);
  text(&UI_FONT_M, 24, y + (ROW_H - UI_FONT_M.line_h) / 2, title, ti);

  int right = UI_W - 24;
  if (arrow) {
    const int cy = y + ROW_H / 2;
    for (int i = 0; i < 7; i++) fill(right - 8 + i, cy - 6 + i, 2, 2, ti);
    for (int i = 0; i < 7; i++) fill(right - 8 + i, cy + 6 - i, 2, 2, ti);
    right -= 22;
  }
  if (value) text_right(&UI_FONT_M, right, y + (ROW_H - UI_FONT_M.line_h) / 2, value, vi);
}

/* An on/off pill, the era's answer to a toggle: a recessed well with the live
 * state written in it, not a sliding lozenge. */
static void draw_toggle(int x, int y, bool on, bool focused) {
  const int w = 62, h = 28;
  if (on) {
    control(x, y, w, h, true, false);
    text_mid(&UI_FONT_S, x + w / 2, y + (h - UI_FONT_S.line_h) / 2, "ON", C_INV);
  } else {
    fill(x, y, w, h, C_PANEL_IN);
    outline(x, y, w, h, C_BORDER_DARK);
    text_mid(&UI_FONT_S, x + w / 2, y + (h - UI_FONT_S.line_h) / 2, "OFF", C_MUTED);
  }
  if (focused) outline(x - 2, y - 2, w + 4, h + 4, C_INV);
}

/* A segmented selector: every option visible, the live one filled. */
static void draw_segments(int x, int y, int w, int h, const char *const *names, int count,
                          int selected, int pressed_idx, int focus_idx) {
  const int cw = w / count;
  for (int i = 0; i < count; i++) {
    const int cx = x + i * cw;
    const bool on = i == selected;
    control(cx, y, cw, h, on, pressed_idx == i);
    text_mid(&UI_FONT_M, cx + cw / 2, y + (h - UI_FONT_M.line_h) / 2, names[i],
             on ? C_INV : C_INK);
    if (focus_idx == i) outline(cx - 2, y - 2, cw + 4, h + 4, C_BLUE);
  }
}

static void human_bytes(char *out, size_t n, uint64_t bytes) {
  if (bytes >= (1024ULL * 1024 * 1024))
    snprintf(out, n, "%llu.%llu GB", bytes / (1024ULL * 1024 * 1024),
             (bytes % (1024ULL * 1024 * 1024)) / (107374182ULL));
  else snprintf(out, n, "%llu MB", bytes / (1024ULL * 1024));
}

/* ------------------------------------------------------------------ */
/* Main menu                                                           */
/* ------------------------------------------------------------------ */

static void tile_rect(int i, int *x, int *y) {
  *x = M_MARGIN + (i % M_COLS) * (M_TILE_W + M_GAP);
  *y = M_MARGIN + (i / M_COLS) * (M_TILE_H + M_GAP);
}

/**
 * Six objects on a light screen, and nothing else.
 *
 * No status bar: a permanent strip of SD/WIFI/ROLL across the top is what a
 * miniature PC looks like. Passive state lives where it is useful instead -
 * battery in the viewfinder, storage only once it is nearly gone.
 *
 * Selection is deliberately quiet. The tile does not become a button; it gets
 * a pale plate and its label goes into a cobalt chip, which is how a selected
 * desktop icon read in 1998 and keeps the artwork the loudest thing on screen.
 */
static void draw_menu(void) {
  fill(0, 0, UI_W, UI_H, C_CANVAS);

  for (int i = 0; i < 6; i++) {
    int tx, ty;
    tile_rect(i, &tx, &ty);
    const bool sel = (s_focus[SCR_MENU] == i);
    const bool down = (s_pressed == i);

    const int top = ty + (M_TILE_H - M_STACK) / 2;
    const int icx = tx + M_TILE_W / 2;
    const int icy = top + ICON_BOX / 2;

    if (sel || down) {
      fill_round_grad(tx + 4, ty + 4, M_TILE_W - 8, M_TILE_H - 8, RADIUS,
                      down ? C_PANEL_IN : C_BLUE_WASH, down ? C_PANEL : C_BLUE_WASH);
      outline(tx + 4, ty + 4, M_TILE_W - 8, M_TILE_H - 8, C_BLUE);
    }

    icons_blit_centred(s_cv, UI_W, UI_H, i, icx, icy + (down ? 1 : 0));

    const int lw = text_w(&UI_FONT_M, MENU_LABEL[i]);
    const int ly = top + ICON_BOX + 10;
    if (sel) {
      fill_round_grad(icx - lw / 2 - 10, ly - 3, lw + 20, M_LABEL_H + 4, 2, C_SEL_TOP, C_SEL_BOT);
      text(&UI_FONT_M, icx - lw / 2, ly + (M_LABEL_H - UI_FONT_M.line_h) / 2, MENU_LABEL[i], C_INV);
    } else {
      text(&UI_FONT_M, icx - lw / 2, ly + (M_LABEL_H - UI_FONT_M.line_h) / 2, MENU_LABEL[i], C_INK);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Viewfinder                                                          */
/* ------------------------------------------------------------------ */

/* Items: 0 back, 1 flash. The shutter is not on this screen - it is a key on
 * the body, and a camera whose shutter is a picture of a shutter is a camera
 * you have to look at to use. */
#define VF_IT_BACK 0
#define VF_IT_FLASH 1

static void vf_pane_rect(int cam, int *x, int *y) {
  *x = VF_X0 + (cam % 2) * (VF_PANE_W + VF_GAP);
  *y = VF_Y0 + (cam / 2) * (VF_PANE_H + VF_GAP);
}

static void vf_blit(const uint16_t *tile, int px, int py) {
  for (int y = 0; y < VF_PANE_H; y++) {
    const uint16_t *src = tile + (size_t)(y * VF_H / VF_PANE_H) * VF_W;
    uint16_t *dst = s_cv + (size_t)(py + y) * UI_W + px;
    for (int x = 0; x < VF_PANE_W; x++) dst[x] = src[x * VF_W / VF_PANE_W];
  }
}

/**
 * Four previews, Back, Flash, Battery. Nothing else.
 *
 * Everything the previous viewfinder carried - frame rates, card capacity,
 * link diagnostics, a mode readout, an on-screen shutter - was engineering
 * information competing with the photograph. What is left is the two things
 * you change while shooting and the one thing you need to know.
 */
static void draw_viewfinder(void) {
  fill(0, 0, UI_W, UI_H, D_GROUND);

  static const char *const NAMES[4] = {"CAM1", "CAM2", "CAM3", "CAM4"};
  for (int i = 0; i < 4; i++) {
    int px, py;
    vf_pane_rect(i, &px, &py);

    const uint16_t *tile = viewfinder_ready() ? viewfinder_tile(i) : NULL;
    vf_status_t st = {0};
    if (viewfinder_ready()) viewfinder_status(i, &st);

    if (tile != NULL) {
      vf_blit(tile, px, py);
    } else {
      fill(px, py, VF_PANE_W, VF_PANE_H, D_PANE);
      /* Which of the several reasons it is, rather than a black rectangle
       * that could mean any of them. */
      const char *why = st.state == VF_ERROR     ? "NO PICTURE"
                        : st.state == VF_STALLED ? "NO RECENT FRAME"
                                                 : "NO CAMERA";
      text_mid(&UI_FONT_S, px + VF_PANE_W / 2, py + VF_PANE_H / 2 - 14, why, D_DIM);
      text_mid(&UI_FONT_S, px + VF_PANE_W / 2, py + VF_PANE_H / 2 + 6, NAMES[i],
               RGB(0x4a, 0x52, 0x5e));
    }
    outline(px, py, VF_PANE_W, VF_PANE_H, D_EDGE);
  }

  /* Back, top left, in the column the 4:3 block leaves empty. Small and
   * subordinate: it is the way out, not a feature. */
  const uint16_t bink = (s_pressed == VF_IT_BACK) ? C_BLUE
                        : (s_focus[SCR_VIEWFINDER] == VF_IT_BACK ? C_INV : D_TEXT);
  chevron(10, 22, bink);
  text(&UI_FONT_S, 26, 13, "BACK", bink);

  /* Battery, top right. The w98 cell at 1:1, and no percentage: this body has
   * no sense divider, so a number would be invented. */
  const int bi = W98_BATTERY_IDX;
  const int be = icons_edge(bi);
  icons_blit(s_cv, UI_W, UI_H, bi, VF_COL_R + (VF_COL_W - be) / 2, 10);
  text_mid(&UI_FONT_S, VF_COL_R + VF_COL_W / 2, 10 + be + 4, usb_attached() ? "USB" : "BATT",
           D_DIM);

  /* Flash, bottom of the same column. One press advances it, and the order
   * never reorders by recency: overshooting costs two more presses, which is
   * faster than reading a menu. */
  const int fi = flash_index();
  static const char *const FLASH_WORD[3] = {"AUTO", "ON", "OFF"};
  const int fw = VF_COL_W - 12, fh = 74;
  const int fx = VF_COL_R + 6, fy = UI_H - VF_MARGIN - fh;
  const bool fdown = (s_pressed == VF_IT_FLASH);

  uint16_t bolt_ink = D_TEXT, word_ink = D_TEXT;
  if (fi == 1) {
    fill_round_grad(fx, fy, fw, fh, 3, C_YELLOW, RGB(0xd9, 0xa8, 0x22));
    outline(fx, fy, fw, fh, RGB(0x9a, 0x76, 0x10));
    bolt_ink = word_ink = RGB(0x2a, 0x22, 0x05);
  } else {
    fill_round_grad(fx, fy, fw, fh, 3, fdown ? RGB(0x3a, 0x42, 0x4c) : RGB(0x28, 0x2e, 0x37),
                    RGB(0x1a, 0x1f, 0x26));
    outline(fx, fy, fw, fh, D_EDGE);
    if (fi == 2) { bolt_ink = RGB(0x4a, 0x52, 0x5e); word_ink = D_DIM; }
    else { bolt_ink = C_YELLOW; }
  }
  bolt(fx + fw / 2 - 8, fy + 10, 2, bolt_ink);
  text_mid(&UI_FONT_S, fx + fw / 2, fy + fh - 24, FLASH_WORD[fi], word_ink);
  if (s_focus[SCR_VIEWFINDER] == VF_IT_FLASH) outline(fx - 2, fy - 2, fw + 4, fh + 4, C_BLUE);
}

/* ------------------------------------------------------------------ */
/* Mode                                                                */
/* ------------------------------------------------------------------ */

/* Two modes, because two is what the firmware has. SET_MODE accepts wiggle
 * and quad and NACKs anything else; the BURST and SINGLE the old screen
 * offered were never implemented anywhere. */
static void draw_mode(void) {
  fill(0, 0, UI_W, UI_H, C_CANVAS);
  draw_header(SCR_MODE);

  const bool quad = mode_is_quad();
  const int cw = 348, ch = 232, cy = BODY_Y + 34;
  const int cx[2] = {(UI_W / 2 - cw) - 12, UI_W / 2 + 12};

  for (int i = 0; i < 2; i++) {
    const bool on = (i == 1) == quad;
    const bool foc = s_focus[SCR_MODE] == i;
    const bool down = s_pressed == i;

    if (on) {
      fill_round_grad(cx[i], cy, cw, ch, RADIUS, C_BLUE_WASH, RGB(0xc9, 0xdd, 0xf7));
      outline(cx[i], cy, cw, ch, C_BLUE);
    } else {
      fill_round_grad(cx[i], cy, cw, ch, RADIUS, C_HILITE, C_PANEL);
      outline(cx[i], cy, cw, ch, C_BORDER_MID);
    }
    if (down) outline(cx[i] + 1, cy + 1, cw - 2, ch - 2, C_BLUE);
    if (foc) outline(cx[i] - 3, cy - 3, cw + 6, ch + 6, C_BLUE);

    /* A diagram of what the four frames become, which says more than a
     * paragraph would at this size. */
    const int dx = cx[i] + 30, dy = cy + 34;
    if (i == 0) {
      /* Wiggle: four frames stacked along a motion axis. */
      for (int f = 0; f < 4; f++) {
        const int ox = dx + f * 16, oy = dy + f * 6;
        fill(ox, oy, 76, 58, f == 3 ? C_BLUE : C_PANEL_IN);
        outline(ox, oy, 76, 58, C_BORDER_DARK);
      }
    } else {
      /* Quad: a two-by-two contact sheet. */
      for (int f = 0; f < 4; f++) {
        const int ox = dx + (f % 2) * 62, oy = dy + (f / 2) * 46;
        fill(ox, oy, 56, 40, C_BLUE);
        outline(ox, oy, 56, 40, C_BORDER_DARK);
      }
    }

    text(&UI_FONT_M, cx[i] + 30, cy + 140, i == 0 ? "WIGGLE" : "QUAD", C_INK);
    text(&UI_FONT_S, cx[i] + 30, cy + 170,
         i == 0 ? "Four frames, played as a loop." : "Four frames, side by side.", C_MUTED);
    if (on) text(&UI_FONT_S, cx[i] + 30, cy + 194, "IN USE", C_BLUE_DARK);
  }

  /* Both modes fire all four cameras and write identical files; the
   * difference is entirely in how the host presents them. Someone who expects
   * different pictures and gets the same ones assumes the camera is broken. */
  text_mid(&UI_FONT_S, UI_W / 2, UI_H - 34,
           "Both capture four frames. The difference is how they play back.", C_FAINT);
}

/* ------------------------------------------------------------------ */
/* Look                                                                */
/* ------------------------------------------------------------------ */

/* COLOUR and B&W are real: SlotColorMode is 'recipe' | 'mono' in the wire
 * contract, the value persists, and it is stamped into META.JSON. What the
 * camera does NOT do is apply it - there is no grading anywhere in the
 * firmware - so the screen says where it is applied instead of implying the
 * preview will change. */
static bool look_is_mono(void) {
  return strcmp(config_str("quad.slots.cam1.colorMode", "recipe"), "mono") == 0;
}

static void look_set_mono(bool mono) {
  static const char *const CAMS[4] = {"cam1", "cam2", "cam3", "cam4"};
  char path[64];
  for (int i = 0; i < 4; i++) {
    snprintf(path, sizeof path, "quad.slots.%s.colorMode", CAMS[i]);
    cfg_set_str(path, mono ? "mono" : "recipe");
  }
}

static void draw_look(void) {
  fill(0, 0, UI_W, UI_H, C_CANVAS);
  draw_header(SCR_LOOK);

  const bool mono = look_is_mono();
  static const char *const NAMES[2] = {"COLOUR", "B&W"};
  const int y = BODY_Y + 40, h = 76, w = 300;
  const int xs[2] = {UI_W / 2 - w - 10, UI_W / 2 + 10};

  for (int i = 0; i < 2; i++) {
    const bool on = (i == 1) == mono;
    control(xs[i], y, w, h, on, s_pressed == i);
    text_mid(&UI_FONT_M, xs[i] + w / 2, y + (h - UI_FONT_M.line_h) / 2, NAMES[i],
             on ? C_INV : C_INK);
    if (s_focus[SCR_LOOK] == i) outline(xs[i] - 3, y - 3, w + 6, h + 6, C_BLUE);
  }

  /* Named looks are recipes, and recipes arrive from Studio. With none
   * loaded, saying so beats an empty list. */
  text(&UI_FONT_S, 40, y + h + 46, "LOADED LOOKS", C_FAINT);
  fill(40, y + h + 70, UI_W - 80, 1, C_LINE);
  const char *rid = config_str("wiggle.recipeId", "");
  if (rid[0] == '\0') {
    text(&UI_FONT_M, 40, y + h + 88, "None yet", C_MUTED);
    text(&UI_FONT_S, 40, y + h + 118, "Add looks from Studio over USB-C.", C_FAINT);
  } else {
    text(&UI_FONT_M, 40, y + h + 88, rid, C_INK);
  }

  text_mid(&UI_FONT_S, UI_W / 2, UI_H - 34,
           "Looks are applied when you import. The camera preview does not change.", C_FAINT);
}

/* ------------------------------------------------------------------ */
/* Gallery                                                             */
/* ------------------------------------------------------------------ */

#define G_COLS GALLERY_COLS
#define G_TILE_W GALLERY_TILE_W
#define G_TILE_H GALLERY_TILE_H
#define G_GAP 14
#define G_CAP 20   /* the one-line caption under each tile */
#define G_X0 ((UI_W - (G_COLS * G_TILE_W + (G_COLS - 1) * G_GAP)) / 2)
#define G_Y0 (BODY_Y + 8)
#define G_PITCH (G_TILE_H + G_CAP + 12)
#define G_FOOT 40

/* Items 0..5 are tiles, 6 is page-back, 7 is page-forward. */
#define G_IT_PREV 6
#define G_IT_NEXT 7

static void gal_origin(int slot, int *x, int *y) {
  *x = G_X0 + (slot % G_COLS) * (G_TILE_W + G_GAP);
  *y = G_Y0 + (slot / G_COLS) * G_PITCH;
}

static void gal_blit(const uint16_t *px, int x, int y) {
  for (int r = 0; r < G_TILE_H; r++)
    memcpy(s_cv + (size_t)(y + r) * UI_W + x, px + (size_t)r * G_TILE_W,
           (size_t)G_TILE_W * sizeof(uint16_t));
}

static void draw_gallery(void) {
  fill(0, 0, UI_W, UI_H, C_CANVAS);
  draw_header(SCR_GALLERY);

  storage_status_t sd;
  storage_get_status(&sd);
  const int total = gallery_total();

  if (total == 0) {
    const char *h1 = sd.mounted ? "NO PHOTOS YET" : "NO CARD";
    const char *h2 = sd.mounted ? "Press the shutter to take one."
                                : "Insert a microSD card to store photos.";
    text_mid(&UI_FONT_M, UI_W / 2, UI_H / 2 - 26, h1, C_INK);
    text_mid(&UI_FONT_S, UI_W / 2, UI_H / 2 + 8, h2, C_MUTED);
    return;
  }

  const gallery_item_t *slots = gallery_slots();
  for (int i = 0; i < GALLERY_PAGE; i++) {
    if (slots[i].state == TILE_EMPTY) continue;
    int x, y;
    gal_origin(i, &x, &y);
    const bool foc = s_focus[SCR_GALLERY] == i;

    fill(x - 2, y - 2, G_TILE_W + 4, G_TILE_H + 4, foc ? C_BLUE : C_BORDER_MID);
    if (slots[i].state == TILE_READY && slots[i].pixels) {
      gal_blit(slots[i].pixels, x, y);
    } else {
      fill(x, y, G_TILE_W, G_TILE_H, C_WELL);
      text_mid(&UI_FONT_S, x + G_TILE_W / 2, y + G_TILE_H / 2 - 9,
               slots[i].state == TILE_PENDING ? "LOADING" : "NO IMAGE", D_DIM);
    }
    if (s_pressed == i) outline(x, y, G_TILE_W, G_TILE_H, C_INV);

    /* One short caption. No filename, no size, no path: the picture is the
     * content and the rest is file management. */
    char cap[32];
    if (slots[i].partial) snprintf(cap, sizeof cap, "%d of 4", slots[i].frames);
    else snprintf(cap, sizeof cap, "%s", slots[i].mode);
    text(&UI_FONT_S, x + 2, y + G_TILE_H + 5, cap, slots[i].partial ? C_RED : C_MUTED);
  }

  /* Page controls, only when there is more than one page. */
  const int pages = gallery_pages();
  const int fy = UI_H - G_FOOT;
  if (pages > 1) {
    char pg[32];
    snprintf(pg, sizeof pg, "%d of %d", gallery_page() + 1, pages);
    text_mid(&UI_FONT_S, UI_W / 2, fy + (G_FOOT - UI_FONT_S.line_h) / 2, pg, C_MUTED);

    const int bw = 74, bh = 32, by = fy + (G_FOOT - bh) / 2;
    control(24, by, bw, bh, false, s_pressed == G_IT_PREV);
    text_mid(&UI_FONT_S, 24 + bw / 2, by + (bh - UI_FONT_S.line_h) / 2, "PREV", C_INK);
    control(UI_W - 24 - bw, by, bw, bh, false, s_pressed == G_IT_NEXT);
    text_mid(&UI_FONT_S, UI_W - 24 - bw / 2, by + (bh - UI_FONT_S.line_h) / 2, "NEXT", C_INK);
    if (s_focus[SCR_GALLERY] == G_IT_PREV) outline(22, by - 2, bw + 4, bh + 4, C_BLUE);
    if (s_focus[SCR_GALLERY] == G_IT_NEXT) outline(UI_W - 26 - bw, by - 2, bw + 4, bh + 4, C_BLUE);
  }
  if (gallery_loading())
    text(&UI_FONT_S, 24, fy + (G_FOOT - UI_FONT_S.line_h) / 2, "READING CARD", C_FAINT);
}

/* ------------------------------------------------------------------ */
/* One photograph                                                      */
/* ------------------------------------------------------------------ */

#define P_IT_DELETE 0
#define P_IT_ROLL 1

static void photo_release(void) {
  if (s_photo) { free(s_photo); s_photo = NULL; }
  s_photo_ok = false;
}

/* Decoded at PH_W x PH_H rather than by scaling the 208 px gallery tile:
 * thumb_load takes any target size, so there is no reason to show a
 * thumbnail blown up to half the screen. */
static void photo_open(const gallery_item_t *it) {
  photo_release();
  snprintf(s_photo_id, sizeof s_photo_id, "%s", it->id);
  snprintf(s_photo_label, sizeof s_photo_label, "%s", it->label);
  snprintf(s_photo_mode, sizeof s_photo_mode, "%s", it->mode);
  s_photo_frames = it->frames;

  s_photo = heap_caps_malloc((size_t)PH_W * PH_H * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
  if (s_photo == NULL) return;

  static const char *const TRY[3] = {"C1.JPG", "THUMB.JPG", "C2.JPG"};
  for (int i = 0; i < 3; i++) {
    char path[128];
    snprintf(path, sizeof path, "%s/%s/%s", CAPTURES_DIR, it->id, TRY[i]);
    if (thumb_load(path, s_photo, PH_W, PH_H, C_WELL) == ESP_OK) {
      s_photo_ok = true;
      return;
    }
  }
}

static void draw_photo(void) {
  fill(0, 0, UI_W, UI_H, D_GROUND);

  const int px = (UI_W - PH_W) / 2, py = 22;
  if (s_photo_ok && s_photo) {
    for (int r = 0; r < PH_H; r++)
      memcpy(s_cv + (size_t)(py + r) * UI_W + px, s_photo + (size_t)r * PH_W,
             (size_t)PH_W * sizeof(uint16_t));
  } else {
    fill(px, py, PH_W, PH_H, D_PANE);
    text_mid(&UI_FONT_M, UI_W / 2, py + PH_H / 2 - 12, "NO IMAGE", D_DIM);
  }
  outline(px - 1, py - 1, PH_W + 2, PH_H + 2, D_EDGE);

  /* Back, top left, matching the viewfinder so the gesture is the same. */
  const uint16_t bink = (s_pressed == IT_BACK) ? C_BLUE : D_TEXT;
  chevron(14, 14, bink);
  text(&UI_FONT_S, 32, 14 - UI_FONT_S.line_h / 2, "BACK", bink);

  char info[72];
  snprintf(info, sizeof info, "%s   %s   %d frames", s_photo_label, s_photo_mode, s_photo_frames);
  text(&UI_FONT_S, px, py + PH_H + 10, info, D_DIM);

  const int bh = 34, by = UI_H - bh - 12;
  const int bw = 150;
  control(px, by, bw, bh, false, s_pressed == P_IT_DELETE);
  text_mid(&UI_FONT_S, px + bw / 2, by + (bh - UI_FONT_S.line_h) / 2, "DELETE", C_INK);
  if (s_focus[SCR_PHOTO] == P_IT_DELETE) outline(px - 2, by - 2, bw + 4, bh + 4, C_BLUE);

  /* No radio on this body, so Roll cannot take it. Dimmed with the reason
   * rather than hidden - a control that vanishes teaches nothing. */
  const int rx = px + PH_W - bw;
  fill(rx, by, bw, bh, RGB(0x24, 0x2a, 0x32));
  outline(rx, by, bw, bh, D_EDGE);
  text_mid(&UI_FONT_S, rx + bw / 2, by + (bh - UI_FONT_S.line_h) / 2, "SEND TO ROLL",
           RGB(0x54, 0x5d, 0x6a));
}

/* ------------------------------------------------------------------ */
/* Roll                                                                */
/* ------------------------------------------------------------------ */

/* Only about Roll. The card statistics the old screen carried moved to
 * Settings > Storage, where they belong. */
static void draw_roll(void) {
  fill(0, 0, UI_W, UI_H, C_CANVAS);
  draw_header(SCR_ROLL);

  const int cy = BODY_Y + 60;
  text_mid(&UI_FONT_M, UI_W / 2, cy, "NOT CONNECTED", C_INK);
  text_mid(&UI_FONT_S, UI_W / 2, cy + 40, "This body has no radio fitted.", C_MUTED);
  text_mid(&UI_FONT_S, UI_W / 2, cy + 66, "Connect Studio over USB-C to make a roll", C_MUTED);
  text_mid(&UI_FONT_S, UI_W / 2, cy + 88, "and upload from there.", C_MUTED);

  const int n = gallery_total();
  if (n > 0) {
    char line[48];
    snprintf(line, sizeof line, "%d photo%s waiting on the card", n, n == 1 ? "" : "s");
    text_mid(&UI_FONT_S, UI_W / 2, cy + 134, line, C_FAINT);
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

static const char *const SET_ROWS[5] = {"Display", "Sound", "Connection", "Storage", "About"};
static const screen_t SET_DEST[5] = {SCR_DISPLAY, SCR_SOUND, SCR_CONNECTION, SCR_STORAGE,
                                     SCR_ABOUT};

static void draw_settings(void) {
  fill(0, 0, UI_W, UI_H, C_CANVAS);
  draw_header(SCR_SETTINGS);
  for (int i = 0; i < 5; i++)
    draw_row(BODY_Y + i * ROW_H, s_focus[SCR_SETTINGS] == i, true, SET_ROWS[i], NULL, true, C_MUTED);
}

/* --- Display ------------------------------------------------------ */

static const int DIM_S[3] = {15, 30, 60};
static const int SLEEP_S[3] = {60, 120, 300};
static const char *const SECS_15[3] = {"15 s", "30 s", "60 s"};
static const char *const SECS_60[3] = {"1 min", "2 min", "5 min"};

static int nearest_idx(int v, const int *opts) {
  int best = 0, bd = 1 << 30;
  for (int i = 0; i < 3; i++) {
    const int d = v > opts[i] ? v - opts[i] : opts[i] - v;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

static void draw_display(void) {
  fill(0, 0, UI_W, UI_H, C_CANVAS);
  draw_header(SCR_DISPLAY);

  const int y0 = BODY_Y + 18;
  text(&UI_FONT_S, 24, y0, "DIM AFTER", C_FAINT);
  draw_segments(24, y0 + 24, UI_W - 48, 44, SECS_15, 3,
                nearest_idx(config_int("body.autoDimS", 30), DIM_S),
                s_pressed >= 0 && s_pressed < 3 ? s_pressed : -1,
                s_focus[SCR_DISPLAY] < 3 ? s_focus[SCR_DISPLAY] : -1);

  text(&UI_FONT_S, 24, y0 + 92, "SLEEP AFTER", C_FAINT);
  draw_segments(24, y0 + 116, UI_W - 48, 44, SECS_60, 3,
                nearest_idx(config_int("body.sleepS", 120), SLEEP_S),
                s_pressed >= 3 && s_pressed < 6 ? s_pressed - 3 : -1,
                s_focus[SCR_DISPLAY] >= 3 && s_focus[SCR_DISPLAY] < 6
                    ? s_focus[SCR_DISPLAY] - 3 : -1);

  /* The backlight is a plain GPIO, on or off. A brightness control here would
   * be a slider that moves and changes nothing. */
  draw_row(y0 + 186, false, false, "Brightness", "Not adjustable", false, C_FAINT);
  text(&UI_FONT_S, 24, y0 + 246, "The backlight on this body is on or off.", C_FAINT);
}

/* --- Sound -------------------------------------------------------- */

static void draw_sound(void) {
  fill(0, 0, UI_W, UI_H, C_CANVAS);
  draw_header(SCR_SOUND);

  const bool shut = config_bool("body.sounds.save", true);
  const bool ui = config_bool("body.sounds.ui", true);

  draw_row(BODY_Y, s_focus[SCR_SOUND] == 0, true, "Shutter sound", NULL, false, C_MUTED);
  draw_toggle(UI_W - 24 - 62, BODY_Y + (ROW_H - 28) / 2, shut, false);
  draw_row(BODY_Y + ROW_H, s_focus[SCR_SOUND] == 1, true, "Button sound", NULL, false, C_MUTED);
  draw_toggle(UI_W - 24 - 62, BODY_Y + ROW_H + (ROW_H - 28) / 2, ui, false);

  const int y = BODY_Y + 2 * ROW_H + 26;
  text(&UI_FONT_S, 24, y, "VOLUME", C_FAINT);
  static const char *const VOL[3] = {"LOW", "MEDIUM", "HIGH"};
  static const int VOLV[3] = {3, 6, 9};
  draw_segments(24, y + 24, UI_W - 48, 44, VOL, 3, nearest_idx(config_int("shoot.volume", 6), VOLV),
                s_pressed >= 2 && s_pressed < 5 ? s_pressed - 2 : -1,
                s_focus[SCR_SOUND] >= 2 && s_focus[SCR_SOUND] < 5 ? s_focus[SCR_SOUND] - 2 : -1);
}

/* --- Connection --------------------------------------------------- */

static void draw_connection(void) {
  fill(0, 0, UI_W, UI_H, C_CANVAS);
  draw_header(SCR_CONNECTION);
  draw_row(BODY_Y, false, false, "Wi-Fi", "Not fitted", false, C_FAINT);
  draw_row(BODY_Y + ROW_H, false, false, "Auto upload", "Not fitted", false, C_FAINT);
  draw_row(BODY_Y + 2 * ROW_H, false, true, "USB", usb_attached() ? "Connected" : "Not connected",
           false, usb_attached() ? C_GREEN : C_MUTED);
  text(&UI_FONT_S, 24, BODY_Y + 3 * ROW_H + 28,
       "The radio is not brought up on this body. Photos leave over USB-C.", C_FAINT);
}

/* --- Storage ------------------------------------------------------ */

static void draw_storage(void) {
  fill(0, 0, UI_W, UI_H, C_CANVAS);
  draw_header(SCR_STORAGE);

  storage_status_t sd;
  storage_get_status(&sd);
  char freeb[24], capb[24], cnt[16];
  human_bytes(freeb, sizeof freeb, sd.free_bytes);
  human_bytes(capb, sizeof capb, sd.capacity_bytes);
  snprintf(cnt, sizeof cnt, "%d", gallery_total());

  draw_row(BODY_Y, false, true, "Card", sd.mounted ? capb : "None", false,
           sd.mounted ? C_MUTED : C_RED);
  draw_row(BODY_Y + ROW_H, false, true, "Free space", sd.mounted ? freeb : "-", false, C_MUTED);
  draw_row(BODY_Y + 2 * ROW_H, false, true, "Photos", cnt, false, C_MUTED);
  draw_row(BODY_Y + 3 * ROW_H, s_focus[SCR_STORAGE] == 0, sd.mounted, "Format card", NULL, true,
           C_MUTED);
}

/* --- About -------------------------------------------------------- */

static void draw_about(void) {
  fill(0, 0, UI_W, UI_H, C_CANVAS);
  draw_header(SCR_ABOUT);
  draw_row(BODY_Y, false, true, "KINO D4", "", false, C_MUTED);
  draw_row(BODY_Y + ROW_H, false, true, "Firmware", KINO_FW_VERSION, false, C_MUTED);
  draw_row(BODY_Y + 2 * ROW_H, false, true, "Device", config_str("device", "-"), false, C_MUTED);
}

/* ------------------------------------------------------------------ */
/* Power                                                               */
/* ------------------------------------------------------------------ */

static void draw_power(void) {
  fill(0, 0, UI_W, UI_H, C_CANVAS);
  draw_header(SCR_POWER);
  /* Shut down is drawn disabled: power.c controls the backlight and the
   * camera bank and has no power-off at all, and there is no soft latch in
   * the pin map for one. Restart is real. */
  draw_row(BODY_Y, s_focus[SCR_POWER] == 0, false, "Shut down", "Hold the power slide", false,
           C_FAINT);
  draw_row(BODY_Y + ROW_H, s_focus[SCR_POWER] == 1, true, "Restart", NULL, true, C_MUTED);
  draw_row(BODY_Y + 2 * ROW_H, s_focus[SCR_POWER] == 2, true, "Cancel", NULL, false, C_MUTED);
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

typedef struct {
  const char *title;
  const char *body;
  const char *sub;
  const char *go;
  bool destructive;
} dlg_spec_t;

static void dialog_spec(dlg_spec_t *d) {
  static char sub[64];
  switch (s_dialog) {
    case DLG_RESTART:
      *d = (dlg_spec_t){"RESTART", "Restart KINO D4?", NULL, "RESTART", false};
      break;
    case DLG_DELETE:
      snprintf(sub, sizeof sub, "%d frames. This cannot be undone.", s_photo_frames);
      *d = (dlg_spec_t){"DELETE", "Delete this photo?", sub, "DELETE", true};
      break;
    case DLG_FORMAT:
      snprintf(sub, sizeof sub, "All %d photos will be deleted.", gallery_total());
      *d = (dlg_spec_t){"FORMAT CARD", "Erase the card?", sub, "FORMAT", true};
      break;
    default:
      *d = (dlg_spec_t){"SHUT DOWN", "Shut down KINO D4?", NULL, "SHUT DOWN", false};
      break;
  }
}

#define DLG_W 430
#define DLG_X ((UI_W - DLG_W) / 2)
#define DLG_Y 132
#define DLG_BTN_W 148
#define DLG_BTN_H 44

static void draw_dialog(void) {
  /* Scrim over whatever is behind, so the decision is the only live thing.
   * Heavy enough that the screen underneath reads as unavailable rather than
   * as merely tinted - a half-lit list still invites a press. */
  for (int y = 0; y < UI_H; y++) {
    uint16_t *row = s_cv + (size_t)y * UI_W;
    for (int x = 0; x < UI_W; x++) row[x] = mix(row[x], RGB(0x10, 0x16, 0x1e), 190);
  }

  dlg_spec_t d;
  dialog_spec(&d);
  const int h = d.sub ? 196 : 168;

  fill(DLG_X, DLG_Y, DLG_W, h, C_CANVAS);
  outline(DLG_X, DLG_Y, DLG_W, h, C_BORDER_DARK);
  if (d.destructive)
    fill_stops4(DLG_X + 1, DLG_Y + 1, DLG_W - 2, 36, RGB(0xc8, 0x3a, 0x3a), RGB(0xb9, 0x32, 0x32),
                RGB(0xa0, 0x25, 0x25), RGB(0x8f, 0x1f, 0x1f));
  else
    fill_stops4(DLG_X + 1, DLG_Y + 1, DLG_W - 2, 36, RGB(0x35, 0x76, 0xcc), RGB(0x2f, 0x70, 0xc9),
                RGB(0x26, 0x61, 0x9f), RGB(0x1d, 0x4c, 0x94));
  text(&UI_FONT_S, DLG_X + 14, DLG_Y + 1 + (36 - UI_FONT_S.line_h) / 2, d.title, C_INV);

  text(&UI_FONT_M, DLG_X + 22, DLG_Y + 60, d.body, C_INK);
  if (d.sub) text(&UI_FONT_S, DLG_X + 22, DLG_Y + 94, d.sub, C_MUTED);

  const int by = DLG_Y + h - DLG_BTN_H - 18;
  const int bx2 = DLG_X + DLG_W - 18 - DLG_BTN_W;
  const int bx1 = bx2 - 10 - DLG_BTN_W;

  control(bx1, by, DLG_BTN_W, DLG_BTN_H, false, s_pressed == 0);
  text_mid(&UI_FONT_M, bx1 + DLG_BTN_W / 2, by + (DLG_BTN_H - UI_FONT_M.line_h) / 2, "CANCEL",
           C_INK);
  if (s_dlg_focus == 0) outline(bx1 - 3, by - 3, DLG_BTN_W + 6, DLG_BTN_H + 6, C_BLUE);

  if (d.destructive) {
    fill_stops4(bx2, by, DLG_BTN_W, DLG_BTN_H, RGB(0xc8, 0x3a, 0x3a), RGB(0xb9, 0x32, 0x32),
                RGB(0xa0, 0x25, 0x25), RGB(0x8f, 0x1f, 0x1f));
    outline(bx2, by, DLG_BTN_W, DLG_BTN_H, RGB(0x8f, 0x1f, 0x1f));
  } else {
    control(bx2, by, DLG_BTN_W, DLG_BTN_H, true, s_pressed == 1);
  }
  text_mid(&UI_FONT_M, bx2 + DLG_BTN_W / 2, by + (DLG_BTN_H - UI_FONT_M.line_h) / 2, d.go, C_INV);
  if (s_dlg_focus == 1) outline(bx2 - 3, by - 3, DLG_BTN_W + 6, DLG_BTN_H + 6, C_INV);
}

/* ------------------------------------------------------------------ */
/* Capture feedback and toast                                          */
/* ------------------------------------------------------------------ */

/**
 * What the shutter is doing, over whatever screen is up.
 *
 * Deliberately a strip and not a screen: the camera must be ready for the
 * next photograph immediately, and a full review application after every
 * press is what stops that.
 */
static void draw_capture_banner(void) {
  const capture_stage_t cs = capture_stage();
  if (cs == CAPTURE_IDLE) return;

  capture_report_t r;
  capture_last(&r);

  char line[64];
  uint16_t accent = C_BLUE;
  switch (cs) {
    case CAPTURE_TRIGGERING: snprintf(line, sizeof line, "TAKING PHOTO"); break;
    case CAPTURE_READING: snprintf(line, sizeof line, "READING FRAMES"); break;
    case CAPTURE_WRITING: snprintf(line, sizeof line, "SAVING"); break;
    default:
      if (!r.ok) {
        snprintf(line, sizeof line, "%s", r.err_code[0] ? r.err_code : "PHOTO FAILED");
        accent = C_BAD;
      } else if (r.stored == r.online) {
        snprintf(line, sizeof line, "SAVED - %d frames", r.stored);
        accent = C_OK;
      } else {
        snprintf(line, sizeof line, "%d/%d SAVED - a camera missed", r.stored, r.online);
        accent = C_BAD;
      }
      break;
  }

  const int h = 40, y = UI_H - h;
  fill(0, y, UI_W, h, RGB(0x12, 0x16, 0x1c));
  fill(0, y, UI_W, 1, accent);
  fill(0, y + 1, 5, h - 1, accent);
  text(&UI_FONT_S, 18, y + (h - UI_FONT_S.line_h) / 2, line, RGB(0xe4, 0xe9, 0xee));
}

static void draw_toast(void) {
  if (s_toast[0] == '\0') return;
  if (esp_timer_get_time() - s_toast_us > 2200000) { s_toast[0] = '\0'; return; }
  const int w = text_w(&UI_FONT_S, s_toast) + 40, h = 38;
  const int x = (UI_W - w) / 2, y = UI_H - h - 26;
  fill_round_grad(x, y, w, h, 3, RGB(0x1e, 0x26, 0x30), RGB(0x14, 0x1a, 0x22));
  outline(x, y, w, h, RGB(0x44, 0x50, 0x5e));
  text_mid(&UI_FONT_S, UI_W / 2, y + (h - UI_FONT_S.line_h) / 2, s_toast, RGB(0xe4, 0xe9, 0xee));
}

static void draw_screen(void) {
  switch (s_screen) {
    case SCR_MENU: draw_menu(); break;
    case SCR_VIEWFINDER: draw_viewfinder(); break;
    case SCR_MODE: draw_mode(); break;
    case SCR_LOOK: draw_look(); break;
    case SCR_GALLERY: draw_gallery(); break;
    case SCR_PHOTO: draw_photo(); break;
    case SCR_ROLL: draw_roll(); break;
    case SCR_SETTINGS: draw_settings(); break;
    case SCR_DISPLAY: draw_display(); break;
    case SCR_SOUND: draw_sound(); break;
    case SCR_CONNECTION: draw_connection(); break;
    case SCR_STORAGE: draw_storage(); break;
    case SCR_ABOUT: draw_about(); break;
    case SCR_POWER: draw_power(); break;
    default: break;
  }
  draw_capture_banner();
  draw_toast();
  if (s_dialog != DLG_NONE) draw_dialog();
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

static void go(screen_t s, int dissolve_ms) {
  if (s == SCR_GALLERY) gallery_refresh();
  if (s_screen == SCR_PHOTO && s != SCR_PHOTO) photo_release();
  s_screen = s;
  s_pressed = -1;
  gfx_snapshot();
  draw_screen();
  gfx_dissolve(dissolve_ms);
}

static void go_back(void) {
  /* One level up, deterministically. Back on the viewfinder and back on the
   * menu both land on the menu, which is the camera's home. */
  go(SCREEN_PARENT[s_screen], 180);
}

/* Number of focusable items on a screen. */
static int item_count(screen_t s) {
  switch (s) {
    case SCR_MENU: return 6;
    case SCR_VIEWFINDER: return 2;
    case SCR_MODE: return 2;
    case SCR_LOOK: return 2;
    case SCR_GALLERY: return gallery_pages() > 1 ? 8 : GALLERY_PAGE;
    case SCR_PHOTO: return 1; /* Send to Roll is not fitted, so not focusable */
    case SCR_SETTINGS: return 5;
    case SCR_DISPLAY: return 6;
    case SCR_SOUND: return 5;
    case SCR_STORAGE: return 1;
    case SCR_POWER: return 3;
    default: return 0;
  }
}

/* ------------------------------------------------------------------ */
/* Hit testing                                                         */
/* ------------------------------------------------------------------ */

static bool in(int x, int y, int rx, int ry, int rw, int rh) {
  return x >= rx && x < rx + rw && y >= ry && y < ry + rh;
}

static int hit_dialog(int x, int y) {
  dlg_spec_t d;
  dialog_spec(&d);
  const int h = d.sub ? 196 : 168;
  const int by = DLG_Y + h - DLG_BTN_H - 18;
  const int bx2 = DLG_X + DLG_W - 18 - DLG_BTN_W;
  const int bx1 = bx2 - 10 - DLG_BTN_W;
  if (in(x, y, bx1, by, DLG_BTN_W, DLG_BTN_H)) return 0;
  if (in(x, y, bx2, by, DLG_BTN_W, DLG_BTN_H)) return 1;
  return -1;
}

static int hit_test(int x, int y) {
  if (s_dialog != DLG_NONE) return hit_dialog(x, y);

  switch (s_screen) {
    case SCR_MENU:
      for (int i = 0; i < 6; i++) {
        int tx, ty;
        tile_rect(i, &tx, &ty);
        if (in(x, y, tx, ty, M_TILE_W, M_TILE_H)) return i;
      }
      return -1;

    case SCR_VIEWFINDER:
      /* The whole of each empty column end is the target, not just the
       * painted control: 89 px is already narrower than a thumb. */
      if (in(x, y, 0, 0, VF_X0, 64)) return VF_IT_BACK;
      if (in(x, y, VF_COL_R, UI_H - 96, VF_COL_W, 96)) return VF_IT_FLASH;
      return -1;

    case SCR_PHOTO: {
      if (in(x, y, 0, 0, 150, 40)) return IT_BACK;
      const int px = (UI_W - PH_W) / 2, bh = 34, by = UI_H - bh - 12;
      if (in(x, y, px, by, 150, bh)) return P_IT_DELETE;
      return -1;
    }

    default: break;
  }

  /* Every other screen has the standard header, and the whole of it goes
   * back: a 26 px chevron is a smaller target than a thumb is wide. */
  if (y < HEAD_H) return IT_BACK;

  switch (s_screen) {
    case SCR_MODE: {
      const int cw = 348, ch = 232, cy = BODY_Y + 34;
      if (in(x, y, UI_W / 2 - cw - 12, cy, cw, ch)) return 0;
      if (in(x, y, UI_W / 2 + 12, cy, cw, ch)) return 1;
      return -1;
    }
    case SCR_LOOK: {
      const int y0 = BODY_Y + 40, h = 76, w = 300;
      if (in(x, y, UI_W / 2 - w - 10, y0, w, h)) return 0;
      if (in(x, y, UI_W / 2 + 10, y0, w, h)) return 1;
      return -1;
    }
    case SCR_GALLERY: {
      if (gallery_total() == 0) return -1;
      for (int i = 0; i < GALLERY_PAGE; i++) {
        int gx, gy;
        gal_origin(i, &gx, &gy);
        if (in(x, y, gx, gy, G_TILE_W, G_TILE_H + 22)) return i;
      }
      if (gallery_pages() > 1) {
        const int fy = UI_H - G_FOOT, bw = 74, bh = 32, by = fy + (G_FOOT - bh) / 2;
        if (in(x, y, 24, by, bw, bh)) return G_IT_PREV;
        if (in(x, y, UI_W - 24 - bw, by, bw, bh)) return G_IT_NEXT;
      }
      return -1;
    }
    case SCR_SETTINGS:
      for (int i = 0; i < 5; i++)
        if (in(x, y, 0, BODY_Y + i * ROW_H, UI_W, ROW_H)) return i;
      return -1;

    case SCR_DISPLAY: {
      const int y0 = BODY_Y + 18, sw = (UI_W - 48) / 3;
      for (int i = 0; i < 3; i++) {
        if (in(x, y, 24 + i * sw, y0 + 24, sw, 44)) return i;
        if (in(x, y, 24 + i * sw, y0 + 116, sw, 44)) return 3 + i;
      }
      return -1;
    }
    case SCR_SOUND: {
      if (in(x, y, 0, BODY_Y, UI_W, ROW_H)) return 0;
      if (in(x, y, 0, BODY_Y + ROW_H, UI_W, ROW_H)) return 1;
      const int y0 = BODY_Y + 2 * ROW_H + 26, sw = (UI_W - 48) / 3;
      for (int i = 0; i < 3; i++)
        if (in(x, y, 24 + i * sw, y0 + 24, sw, 44)) return 2 + i;
      return -1;
    }
    case SCR_STORAGE:
      if (in(x, y, 0, BODY_Y + 3 * ROW_H, UI_W, ROW_H)) return 0;
      return -1;

    case SCR_POWER:
      for (int i = 0; i < 3; i++)
        if (in(x, y, 0, BODY_Y + i * ROW_H, UI_W, ROW_H)) return i;
      return -1;

    default: return -1;
  }
}

/* ------------------------------------------------------------------ */
/* Activation                                                          */
/* ------------------------------------------------------------------ */

static void dialog_commit(void) {
  const dialog_t d = s_dialog;
  s_dialog = DLG_NONE;
  switch (d) {
    case DLG_RESTART:
      toast("Restarting");
      draw_screen();
      gfx_present();
      config_save();
      vTaskDelay(pdMS_TO_TICKS(600));
      esp_restart();
      break;
    case DLG_DELETE: {
      char dir[128];
      snprintf(dir, sizeof dir, "%s/%s", CAPTURES_DIR, s_photo_id);
      storage_capture_delete(dir);
      photo_release();
      gallery_refresh();
      toast("Deleted");
      go(SCR_GALLERY, 180);
      return;
    }
    case DLG_FORMAT:
      /* Not wired: there is no format entry point in storage.c, and calling
       * a delete loop over user captures under the name "format" would be a
       * different operation wearing the label. */
      toast("Format is not available yet");
      break;
    default:
      toast("Hold the power slide to switch off");
      break;
  }
  draw_screen();
  gfx_present();
}

static void activate(int item) {
  if (s_dialog != DLG_NONE) {
    if (item == 1) dialog_commit();
    else {
      s_dialog = DLG_NONE;
      draw_screen();
      gfx_present();
    }
    return;
  }

  if (item == IT_BACK) { go_back(); return; }

  switch (s_screen) {
    case SCR_MENU:
      if (item >= 0 && item < 6) {
        s_focus[SCR_MENU] = item;
        go(MENU_DEST[item], 220);
      }
      return;

    case SCR_VIEWFINDER:
      if (item == VF_IT_BACK) go_back();
      else if (item == VF_IT_FLASH) {
        flash_cycle();
        draw_screen();
        gfx_present();
      }
      return;

    case SCR_MODE:
      cfg_set_str("mode", item == 1 ? "quad" : "wiggle");
      toast(item == 1 ? "Mode: Quad" : "Mode: Wiggle");
      break;

    case SCR_LOOK:
      look_set_mono(item == 1);
      toast(item == 1 ? "Look: B&W" : "Look: Colour");
      break;

    case SCR_GALLERY:
      if (item == G_IT_PREV) { gallery_turn(-1); break; }
      if (item == G_IT_NEXT) { gallery_turn(1); break; }
      if (item >= 0 && item < GALLERY_PAGE) {
        const gallery_item_t *slots = gallery_slots();
        if (slots[item].state == TILE_EMPTY) break;
        photo_open(&slots[item]);
        s_focus[SCR_PHOTO] = P_IT_DELETE;
        go(SCR_PHOTO, 200);
        return;
      }
      break;

    case SCR_PHOTO:
      if (item == P_IT_DELETE) {
        s_dialog = DLG_DELETE;
        s_dlg_focus = 0;
      }
      break;

    case SCR_SETTINGS:
      if (item >= 0 && item < 5) { go(SET_DEST[item], 200); return; }
      break;

    case SCR_DISPLAY:
      if (item >= 0 && item < 3) cfg_set_int("body.autoDimS", DIM_S[item]);
      else if (item >= 3 && item < 6) cfg_set_int("body.sleepS", SLEEP_S[item - 3]);
      break;

    case SCR_SOUND:
      if (item == 0) cfg_set_bool("body.sounds.save", !config_bool("body.sounds.save", true));
      else if (item == 1) cfg_set_bool("body.sounds.ui", !config_bool("body.sounds.ui", true));
      else if (item >= 2 && item < 5) {
        static const int VOLV[3] = {3, 6, 9};
        cfg_set_int("shoot.volume", VOLV[item - 2]);
      }
      break;

    case SCR_STORAGE:
      if (item == 0) { s_dialog = DLG_FORMAT; s_dlg_focus = 0; }
      break;

    case SCR_POWER:
      if (item == 0) { toast("Hold the power slide to switch off"); break; }
      if (item == 1) { s_dialog = DLG_RESTART; s_dlg_focus = 0; break; }
      go_back();
      return;

    default: break;
  }

  s_pressed = -1;
  draw_screen();
  gfx_present();
}

/* ------------------------------------------------------------------ */
/* The shutter                                                         */
/* ------------------------------------------------------------------ */

/**
 * One shutter, whichever thing pressed it.
 *
 * The physical key fires from any screen. That is not a convenience: it is
 * what makes this a camera rather than an appliance with a camera mode. The
 * capture runs, the strip reports it over whatever was on screen, and the
 * screen does not change underneath you.
 */
static void fire_shutter(bool long_press) {
  if (config_bool("body.sounds.save", true)) audio_shutter();
  if (!capture_request(long_press ? "shutter-hold" : "shutter")) {
    klog("P4", "shutter ignored - a capture is already running");
  }
}

/* From the menu, the shutter opens the viewfinder rather than taking a
 * photograph of the inside of a bag. From the viewfinder it captures. That is
 * the safest camera-like reading of a single-stage button. */
static void on_button(button_id_t id, bool long_press) {
  if (id == BTN_FN) {
    flash_cycle();
    return;
  }
  if (id != BTN_SHUTTER) return;
  if (s_screen != SCR_VIEWFINDER) {
    go(SCR_VIEWFINDER, 160);
    gfx_present();
    return;
  }
  fire_shutter(long_press);
}

/* ------------------------------------------------------------------ */
/* Task                                                                */
/* ------------------------------------------------------------------ */

static void icons_task(void *arg) {
  (void)arg;
  const int64_t t0 = esp_timer_get_time();
  if (icons_build() != ESP_OK) ESP_LOGW(TAG, "icons unavailable - the menu will be empty");
  else ESP_LOGI(TAG, "icons ready in %lu ms",
                (unsigned long)((esp_timer_get_time() - t0) / 1000));
  vTaskDelete(NULL);
}

static void ui_task(void *arg) {
  (void)arg;
  splash();

  for (int i = 0; i < 200 && !icons_ready(); i++) vTaskDelay(pdMS_TO_TICKS(10));

  gfx_snapshot();
  draw_screen();
  uint32_t f0 = 0, f1 = 0, ms = 0;
  gfx_stats(&f0, NULL);
  gfx_dissolve(420);
  gfx_stats(&f1, &ms);
  ESP_LOGI(TAG, "boot dissolve: %lu frames in %lu ms (%lu fps)", (unsigned long)(f1 - f0),
           (unsigned long)ms, (unsigned long)(ms ? (f1 - f0) * 1000 / ms : 0));

  int held = -1;

  for (;;) {
    uint16_t tx = 0, ty = 0;
    int region = -1;
    const bool down = touch_ready() && touch_get(&tx, &ty);

    /* A touch that wakes a sleeping screen wakes it and does nothing else.
     * Reaching into a bag for a camera whose backlight has timed out and
     * having it fire whatever tile the thumb landed on is the worst possible
     * answer, and it is what the naive version does. */
    if (!down) power_end_wake_gesture();
    if (power_wake_gesture()) {
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }

    if (down) {
      /* Touch reports in panel space, so the same quarter turn applies in
       * reverse: touch y is the logical x. */
      const int lx = ty;
      const int ly = DISPLAY_H_RES - 1 - tx;
      region = hit_test(lx, ly);
    }

    if (down && region != s_pressed) {
      /* Press paints; activation waits for the release, so a finger that
       * lands on the wrong thing can be slid off it. */
      s_pressed = region;
      held = region;
      if (region >= 0 && config_bool("body.sounds.ui", true)) audio_tick();
      draw_screen();
      gfx_present();
    } else if (!down && held != -1) {
      const int fired = (s_pressed == held) ? held : -1;
      s_pressed = -1;
      held = -1;
      if (fired != -1) {
        /* Touch sets focus as well as acting, so the two input models never
         * disagree about what is selected. */
        if (s_dialog != DLG_NONE) s_dlg_focus = fired;
        else if (fired != IT_BACK && fired < item_count(s_screen)) s_focus[s_screen] = fired;
        activate(fired);
      } else {
        draw_screen();
        gfx_present();
      }
    }

    /* The nodes are only asked for frames while the viewfinder is up. Left
     * running behind a menu it would be four sensors and four UARTs burning
     * battery to fill a buffer nobody reads. */
    viewfinder_run(s_screen == SCR_VIEWFINDER);

    const capture_stage_t cstage = capture_stage();
    if (cstage == CAPTURE_DONE) {
      if (s_shot_seen_us == 0) s_shot_seen_us = esp_timer_get_time();
      const int hold_s = config_int("shoot.displayAfterShotS", 2);
      if (esp_timer_get_time() - s_shot_seen_us > (int64_t)hold_s * 1000000) {
        capture_ack();
        s_shot_seen_us = 0;
        if (s_screen == SCR_GALLERY) gallery_refresh();
        draw_screen();
        gfx_present();
      }
    } else if (cstage == CAPTURE_IDLE) {
      s_shot_seen_us = 0;
    }

    /* A capture in progress, a gallery still decoding, and a toast on its way
     * out all change the screen without anyone touching anything. */
    const bool busy = cstage != CAPTURE_IDLE ||
                      (s_screen == SCR_GALLERY && gallery_loading()) || s_toast[0] != '\0';
    if (held == -1 && s_screen != SCR_VIEWFINDER && busy) {
      draw_screen();
      gfx_present();
      vTaskDelay(pdMS_TO_TICKS(90));
      continue;
    }

    if (s_screen == SCR_VIEWFINDER && held == -1) {
      draw_screen();
      gfx_present();
      /* Paced against the link, not the panel: new frames arrive a few times
       * a second at best. */
      vTaskDelay(pdMS_TO_TICKS(60));
    } else {
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

  buttons_on_press(on_button);

  ESP_LOGI(TAG, "UI_READY %dx%d landscape via PPA, tiles %dx%d", UI_W, UI_H, M_TILE_W, M_TILE_H);
  TaskHandle_t ui_h = NULL;
  xTaskCreate(ui_task, "ui", 6144, NULL, 4, &ui_h);
  taskmon_register("ui", ui_h);

  /* The icon builder starts AFTER the UI. Created first it would simply run
   * to completion before the splash existed, because it outranks the task
   * calling ui_start(); created second, the UI task is already animating and
   * blocking on frame timing and the builder fills exactly those gaps. */
  TaskHandle_t ic_h = NULL;
  xTaskCreate(icons_task, "icons", 4096, NULL, 3, &ic_h);
  taskmon_register("icons", ic_h);
  return ESP_OK;
}
