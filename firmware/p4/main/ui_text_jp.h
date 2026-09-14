// UTF-8 text in the Shinonome faces, and the transformed type for reactions.
//
// Included by ui.c after its drawing primitives: this file calls draw_bits(),
// px_set(), mix() and reads s_cv, and exists as a header so the host preview
// and the Twin build see exactly the code the camera runs, the way the rest
// of the UI is built.
//
// Two faces, one baseline: JIS X 0208 glyphs are 16 wide, the half-width set
// is 8, both 16 rows with the baseline JP16_DESCENT rows up. A string may mix
// them freely - "C02 白黒" is one call - and advances 16 or 8 cells times the
// scale. Scale is a whole number: these are pixel glyphs and a fraction of one
// is a smudge.
//
// jtext_fx() is the display type: the string is rasterised once into a
// 1-bit mask at cell size, then every destination pixel inside the rotated,
// scaled box is mapped back into the mask by nearest neighbour. Rotation is
// what makes a reaction read as thrown rather than placed; a fractional
// scale is allowed HERE because the whole word is transformed as one shape
// and the nearest-neighbour edge is part of the look. Opacity mixes into the
// canvas per pixel, which is affordable because a reaction is a few tens of
// thousands of pixels for a few hundred milliseconds.
#pragma once

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "ui_font_jp.h"

/** Decode one UTF-8 code point; advances *s. Malformed bytes yield U+FFFD and advance one byte. */
static uint32_t utf8_next(const char **s) {
  const unsigned char *p = (const unsigned char *)*s;
  uint32_t cp;
  int n;
  if (p[0] < 0x80) { cp = p[0]; n = 1; }
  else if ((p[0] & 0xe0) == 0xc0 && (p[1] & 0xc0) == 0x80) { cp = ((p[0] & 0x1f) << 6) | (p[1] & 0x3f); n = 2; }
  else if ((p[0] & 0xf0) == 0xe0 && (p[1] & 0xc0) == 0x80 && (p[2] & 0xc0) == 0x80) {
    cp = ((p[0] & 0x0f) << 12) | ((p[1] & 0x3f) << 6) | (p[2] & 0x3f); n = 3;
  } else if ((p[0] & 0xf8) == 0xf0 && (p[1] & 0xc0) == 0x80 && (p[2] & 0xc0) == 0x80 && (p[3] & 0xc0) == 0x80) {
    cp = ((p[0] & 0x07) << 18) | ((p[1] & 0x3f) << 12) | ((p[2] & 0x3f) << 6) | (p[3] & 0x3f); n = 4;
  } else { cp = 0xfffd; n = 1; }
  *s += n;
  return cp;
}

static int cp_find(const uint16_t *table, int count, uint32_t cp) {
  if (cp > 0xffff) return -1;
  int lo = 0, hi = count - 1;
  while (lo <= hi) {
    const int mid = (lo + hi) >> 1;
    if (table[mid] == cp) return mid;
    if (table[mid] < cp) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/* One glyph, resolved: its bitmap, stride and cell width. Half-width first
 * for anything it has (ASCII, Latin-1, half katakana), the 0208 set for the
 * rest. A code point neither has draws as a 0208 tofu box so a missing glyph
 * is visible on the bench instead of silently shortening a word. */
typedef struct {
  const uint8_t *bits;
  int w;      /* 8 or 16 */
  int stride; /* 1 or 2 */
} jglyph_t;

static const uint8_t JP_TOFU[32] = {
    0x7f, 0xfe, 0x40, 0x02, 0x40, 0x02, 0x40, 0x02, 0x40, 0x02, 0x40, 0x02, 0x40, 0x02, 0x40, 0x02,
    0x40, 0x02, 0x40, 0x02, 0x40, 0x02, 0x40, 0x02, 0x40, 0x02, 0x7f, 0xfe, 0x00, 0x00, 0x00, 0x00,
};

static jglyph_t jglyph(uint32_t cp) {
  int i = cp_find(HW16_CP, HW16_COUNT, cp);
  if (i >= 0) return (jglyph_t){HW16_BITS[i], 8, 1};
  i = cp_find(JP16_CP, JP16_COUNT, cp);
  if (i >= 0) return (jglyph_t){JP16_BITS[i], 16, 2};
  return (jglyph_t){JP_TOFU, 16, 2};
}

/** Width of `s` in pixels at an integer scale, `tracking` extra px per glyph (already scaled). */
static int jtext_w_tr(const char *s, int scale, int tracking) {
  int w = 0;
  while (*s) w += jglyph(utf8_next(&s)).w * scale + tracking;
  return w > 0 ? w - tracking : 0;
}
static int jtext_w(const char *s, int scale) { return jtext_w_tr(s, scale, 0); }

/** Draw `s` with its cell top-left at (x, y). Returns the x after the last glyph. */
static int jtext_tr(int x, int y, const char *s, int scale, int tracking, uint16_t ink) {
  while (*s) {
    const jglyph_t g = jglyph(utf8_next(&s));
    draw_bits(g.bits, g.w, JP16_CELL, g.stride, x, y, scale, ink);
    x += g.w * scale + tracking;
  }
  return x;
}

/** Bold: the same glyphs struck twice, the second a cell pixel to the right -
 * synthetic bold the way every bitmap system of the era made it. One extra
 * pixel of advance per glyph keeps the counters open. */
static int jtext_bold(int x, int y, const char *s, int scale, uint16_t ink) {
  while (*s) {
    const jglyph_t g = jglyph(utf8_next(&s));
    draw_bits(g.bits, g.w, JP16_CELL, g.stride, x, y, scale, ink);
    draw_bits(g.bits, g.w, JP16_CELL, g.stride, x + scale, y, scale, ink);
    x += g.w * scale + scale;
  }
  return x;
}
static int jtext_bold_w(const char *s, int scale) {
  int w = 0;
  while (*s) w += jglyph(utf8_next(&s)).w * scale + scale;
  return w;
}
static int jtext(int x, int y, const char *s, int scale, uint16_t ink) { return jtext_tr(x, y, s, scale, 0, ink); }
static void jtext_right(int right, int y, const char *s, int scale, uint16_t ink) {
  jtext(right - jtext_w(s, scale), y, s, scale, ink);
}

/* ------------------------------------------------------------------ */
/* Transformed type.                                                   */

/* The mask: one string at cell size. 50 full-width glyphs is more than any
 * reaction or title will ever be; a longer string is cut, not overrun. */
#define JFX_MASK_W 800
#define JFX_MASK_STRIDE (JFX_MASK_W / 8)
static uint8_t s_jfx_mask[JP16_CELL * JFX_MASK_STRIDE];

/** Rasterise `s` into the mask at scale 1. Returns the mask's used width. */
static int jfx_raster(const char *s, bool bold) {
  memset(s_jfx_mask, 0, sizeof s_jfx_mask);
  int x = 0;
  const int extra = bold ? 1 : 0;
  while (*s) {
    const jglyph_t g = jglyph(utf8_next(&s));
    if (x + g.w + extra > JFX_MASK_W) break;
    for (int row = 0; row < JP16_CELL; row++) {
      const uint8_t *src = g.bits + row * g.stride;
      uint8_t *dst = s_jfx_mask + row * JFX_MASK_STRIDE;
      for (int col = 0; col < g.w; col++) {
        if (!(src[col >> 3] & (0x80 >> (col & 7)))) continue;
        dst[(x + col) >> 3] |= (uint8_t)(0x80 >> ((x + col) & 7));
        if (bold) dst[(x + col + 1) >> 3] |= (uint8_t)(0x80 >> ((x + col + 1) & 7));
      }
    }
    x += g.w + extra;
  }
  return x;
}

/**
 * Draw `s` centred on (cx, cy), scaled by `scale` (any positive value),
 * rotated `rot_deg` (positive = clockwise on screen), in `ink` at `alpha`
 * 0..255. `shadow` adds a one-cell-pixel offset copy in near-black under the
 * type first, for legibility over a picture; on a flat ground pass false.
 */
static void jtext_fx(float cx, float cy, const char *s, float scale, float rot_deg, uint16_t ink, int alpha,
                     bool shadow, bool bold) {
  if (alpha <= 0 || scale <= 0.f) return;
  if (alpha > 255) alpha = 255;
  const int mw = jfx_raster(s, bold);
  const int mh = JP16_CELL;
  if (mw <= 0) return;

  const float rad = rot_deg * 3.14159265f / 180.f;
  const float cs = cosf(rad), sn = sinf(rad);
  const float hw = mw * scale * 0.5f, hh = mh * scale * 0.5f;
  /* The bounding box of the rotated rectangle, in screen pixels. */
  const float ex = fabsf(hw * cs) + fabsf(hh * sn);
  const float ey = fabsf(hw * sn) + fabsf(hh * cs);
  int x0 = (int)floorf(cx - ex) - 1, x1 = (int)ceilf(cx + ex) + 1;
  int y0 = (int)floorf(cy - ey) - 1, y1 = (int)ceilf(cy + ey) + 1;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > UI_W) x1 = UI_W;
  if (y1 > UI_H) y1 = UI_H;
  if (x0 >= x1 || y0 >= y1) return;

  const float inv = 1.f / scale;
  /* Two passes when shadowed: the shadow is the same shape a cell-pixel down
   * and right, drawn darker and never brighter than the ink it sits under. */
  const int passes = shadow ? 2 : 1;
  for (int pass = 0; pass < passes; pass++) {
    const bool is_shadow = shadow && pass == 0;
    const float ox = is_shadow ? scale : 0.f, oy = is_shadow ? scale : 0.f;
    const uint16_t col = is_shadow ? (uint16_t)0x0841 : ink;
    const int a = is_shadow ? (alpha * 3) / 4 : alpha;
    for (int y = y0; y < y1; y++) {
      uint16_t *row = s_cv + (size_t)y * UI_W;
      const float dy = (float)y + 0.5f - cy - oy;
      for (int x = x0; x < x1; x++) {
        const float dx = (float)x + 0.5f - cx - ox;
        /* Inverse rotate into the unrotated box, then scale into mask cells. */
        const float ux = (dx * cs + dy * sn) * inv + mw * 0.5f;
        const float uy = (-dx * sn + dy * cs) * inv + mh * 0.5f;
        if (ux < 0.f || uy < 0.f) continue;
        const int mx = (int)ux, my = (int)uy;
        if (mx >= mw || my >= mh) continue;
        if (!(s_jfx_mask[my * JFX_MASK_STRIDE + (mx >> 3)] & (0x80 >> (mx & 7)))) continue;
        row[x] = a >= 255 ? col : mix(row[x], col, a);
      }
    }
  }
}
