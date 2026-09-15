// The interface type: anti-aliased BIZ UDPGothic at the sizes ui_font_ui.h
// bakes, blended into the canvas per pixel, and the transformed version of it
// for words that are thrown rather than placed.
//
// Included by ui.c after ui_text_jp.h: this file calls mix(), reads s_cv, and
// falls back to jglyph() - the Shinonome pixel face - for any code point the
// baked set does not carry, so a look named in Studio in kanji the interface
// never uses still shows, visibly coarser, instead of as a hole in the word.
//
// Coordinates: `top` is the top of the em box; the baseline is `top + asc`.
// Every face is drawn on that rule so a line of S beside a line of M shares
// a box top, and the height a layout reserves is simply the em.
//
// Two ways to set a string (a column - 縦書き - is ut_fx one glyph at a time,
// which is how the reaction that runs down the side staggers them):
//
//   ut_draw / ut_right / ut_mid    a run at a point, opaque or at an alpha
//   ut_fx                          centred, scaled by any factor, rotated,
//                                  through an 8-bit mask sampled bilinearly -
//                                  the display type for reactions, notices,
//                                  identifiers and the mode's name in motion
#pragma once

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "ui_font_ui.h"

static const ut_glyph_t *ut_find(const ut_face_t *f, uint32_t cp) {
  if (cp > 0xffff) return NULL;
  int lo = 0, hi = f->n - 1;
  while (lo <= hi) {
    const int mid = (lo + hi) >> 1;
    const uint32_t c = f->g[mid].cp;
    if (c == cp) return &f->g[mid];
    if (c < cp) lo = mid + 1;
    else hi = mid - 1;
  }
  return NULL;
}

/* The fallback face's whole-number scale for this em: 22 -> 1, 34 -> 2. */
static int ut_fb_scale(const ut_face_t *f) { return f->em >= 32 ? 2 : 1; }

static int ut_cp_adv(const ut_face_t *f, uint32_t cp) {
  const ut_glyph_t *g = ut_find(f, cp);
  if (g) return g->adv;
  return jglyph(cp).w * ut_fb_scale(f);
}

/** Glyphs in `s`. */
static int ut_len(const char *s) {
  int n = 0;
  while (*s) { utf8_next(&s); n++; }
  return n;
}

/** Width of `s` in pixels. */
static int ut_w(const ut_face_t *f, const char *s) {
  int w = 0;
  while (*s) w += ut_cp_adv(f, utf8_next(&s));
  return w;
}

/** One baked glyph with its origin (pen x, baseline y), clipped, at `alpha` 0..255. */
static void ut_blit(const ut_glyph_t *g, const uint8_t *px, int x, int base, uint16_t ink, int alpha) {
  const int gx = x + g->bx, gy = base + g->by;
  int c0 = 0, r0 = 0, c1 = g->w, r1 = g->h;
  if (gx < s_clip_x0) c0 = s_clip_x0 - gx;
  if (gy < s_clip_y0) r0 = s_clip_y0 - gy;
  if (gx + c1 > s_clip_x1) c1 = s_clip_x1 - gx;
  if (gy + r1 > s_clip_y1) r1 = s_clip_y1 - gy;
  if (c0 >= c1 || r0 >= r1) return;
  for (int r = r0; r < r1; r++) {
    uint16_t *row = s_cv + (size_t)(gy + r) * UI_W + gx;
    const int base_i = r * g->w;
    for (int c = c0; c < c1; c++) {
      const int i = base_i + c;
      const uint8_t b = px[g->off + (i >> 1)];
      const int a4 = (i & 1) ? (b & 15) : (b >> 4);
      if (a4 == 0) continue;
      /* 4-bit coverage to 0..255, then the run's own alpha. */
      const int a = (a4 * 17 * alpha) >> 8;
      if (a >= 255) row[c] = ink;
      else if (a > 0) row[c] = mix(row[c], ink, a);
    }
  }
}

/** Draw `s` with the em box's top-left at (x, top). Returns the pen x after it. */
static int ut_draw_a(const ut_face_t *f, int x, int top, const char *s, uint16_t ink, int alpha) {
  if (alpha <= 0) return x + ut_w(f, s);
  if (alpha > 255) alpha = 255;
  const int base = top + f->asc;
  const int fb = ut_fb_scale(f);
  while (*s) {
    const uint32_t cp = utf8_next(&s);
    const ut_glyph_t *g = ut_find(f, cp);
    if (g) {
      if (g->w) ut_blit(g, f->px, x, base, ink, alpha);
      x += g->adv;
    } else {
      /* The pixel face, sat on the same baseline. Its cell is 16 with the
       * baseline JP16_DESCENT up from the bottom. Alpha is ignored below
       * full: a fallback glyph is a plain stamp, which is fine for what it is. */
      const jglyph_t j = jglyph(cp);
      const int y = base - (JP16_CELL - JP16_DESCENT) * fb;
      draw_bits(j.bits, j.w, JP16_CELL, j.stride, x, y, fb, ink);
      x += j.w * fb;
    }
  }
  return x;
}
static int ut_draw(const ut_face_t *f, int x, int top, const char *s, uint16_t ink) {
  return ut_draw_a(f, x, top, s, ink, 255);
}
static void ut_mid(const ut_face_t *f, int cx, int top, const char *s, uint16_t ink) {
  ut_draw(f, cx - ut_w(f, s) / 2, top, s, ink);
}

/* ------------------------------------------------------------------ */
/* Transformed type.                                                   */

/* One string at its face's natural size, as 8-bit coverage. 1024 px is 30
 * full-width glyphs of M, more than any reaction, notice or title will ever
 * be; a longer string is cut, not overrun. Allocated on first use so a build
 * that never throws a word never pays for it. */
#define UT_MASK_W 1024
#define UT_MASK_H 40
static uint8_t *s_ut_mask;
/* The same mask grown by a pixel, for type that has to be read over a
 * photograph. See ut_halo(). */
static uint8_t *s_ut_halo;
static int s_ut_mask_w, s_ut_mask_h;

static void ut_mask_put(int x, int y, int a) {
  if ((unsigned)x >= UT_MASK_W || (unsigned)y >= UT_MASK_H) return;
  uint8_t *p = &s_ut_mask[y * UT_MASK_W + x];
  if (a > *p) *p = (uint8_t)a;
}

/** Rasterise `s` into the mask. Sets s_ut_mask_w/h; returns false when there is nothing to draw. */
static bool ut_raster(const ut_face_t *f, const char *s) {
  if (s_ut_mask == NULL) {
    s_ut_mask = heap_caps_malloc(UT_MASK_W * UT_MASK_H, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_ut_mask == NULL) s_ut_mask = malloc(UT_MASK_W * UT_MASK_H);
    if (s_ut_mask == NULL) return false;
  }
  const int h = f->asc + f->desc;
  memset(s_ut_mask, 0, (size_t)UT_MASK_W * (size_t)(h < UT_MASK_H ? h : UT_MASK_H));
  s_ut_mask_h = h < UT_MASK_H ? h : UT_MASK_H;
  const int fb = ut_fb_scale(f);
  int x = 0;
  while (*s) {
    const uint32_t cp = utf8_next(&s);
    const ut_glyph_t *g = ut_find(f, cp);
    if (g) {
      if (x + g->adv > UT_MASK_W) break;
      for (int r = 0; r < g->h; r++)
        for (int c = 0; c < g->w; c++) {
          const int i = r * g->w + c;
          const uint8_t b = f->px[g->off + (i >> 1)];
          const int a4 = (i & 1) ? (b & 15) : (b >> 4);
          if (a4) ut_mask_put(x + g->bx + c, f->asc + g->by + r, a4 * 17);
        }
      x += g->adv;
    } else {
      const jglyph_t j = jglyph(cp);
      if (x + j.w * fb > UT_MASK_W) break;
      const int y0 = f->asc - (JP16_CELL - JP16_DESCENT) * fb;
      for (int r = 0; r < JP16_CELL; r++)
        for (int c = 0; c < j.w; c++)
          if (j.bits[r * j.stride + (c >> 3)] & (0x80 >> (c & 7)))
            for (int dy = 0; dy < fb; dy++)
              for (int dx = 0; dx < fb; dx++) ut_mask_put(x + c * fb + dx, y0 + r * fb + dy, 255);
      x += j.w * fb;
    }
  }
  s_ut_mask_w = x;
  return x > 0;
}

/**
 * Grow the rasterised mask by one pixel in every direction.
 *
 * A drop shadow is a legibility device for type on a dark ground: it puts
 * dark under the glyph, down and to the right. Over a photograph it does
 * nothing at all where the picture is already bright - white type on a blown
 * window, or on a crowd, has no edge and simply disappears, which the harness
 * now films in `hard_bright_shoot` and `hard_busy_shoot`. What survives any
 * ground is a contour: dark all the way round the letter, so the glyph's own
 * edge is drawn rather than left to whatever is behind it.
 *
 * Grown once per string into its own buffer rather than as extra taps per
 * output pixel, because the mask is smaller than the area it is drawn over
 * whenever the type is scaled up - and the words that need this most are the
 * large ones. Separable: a max across, then a max down, is the same as the
 * square kernel for a fraction of the reads.
 *
 * Two pixels, not one. The white pass that follows is antialiased, and its
 * own soft edge covers about a pixel of whatever is under it: a one pixel
 * contour is drawn and then painted over, which is what the first attempt at
 * this did - visible only as a slightly different white on white.
 */
#define UT_HALO 2

static bool ut_halo(void) {
  if (s_ut_halo == NULL) {
    s_ut_halo = heap_caps_malloc(UT_MASK_W * UT_MASK_H, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_ut_halo == NULL) s_ut_halo = malloc(UT_MASK_W * UT_MASK_H);
    if (s_ut_halo == NULL) return false;
  }
  const int w = s_ut_mask_w, h = s_ut_mask_h;
  for (int y = 0; y < h; y++) {
    const uint8_t *m = &s_ut_mask[y * UT_MASK_W];
    uint8_t *o = &s_ut_halo[y * UT_MASK_W];
    for (int x = 0; x < w; x++) {
      uint8_t v = 0;
      const int lo = x - UT_HALO < 0 ? 0 : x - UT_HALO, hi = x + UT_HALO >= w ? w - 1 : x + UT_HALO;
      for (int k = lo; k <= hi; k++)
        if (m[k] > v) v = m[k];
      o[x] = v;
    }
  }
  /* Down the same buffer, so the column is read into a window first. */
  uint8_t col[UT_MASK_H];
  for (int x = 0; x < w; x++) {
    for (int y = 0; y < h; y++) col[y] = s_ut_halo[y * UT_MASK_W + x];
    for (int y = 0; y < h; y++) {
      uint8_t v = 0;
      const int lo = y - UT_HALO < 0 ? 0 : y - UT_HALO, hi = y + UT_HALO >= h ? h - 1 : y + UT_HALO;
      for (int k = lo; k <= hi; k++)
        if (col[k] > v) v = col[k];
      s_ut_halo[y * UT_MASK_W + x] = v;
    }
  }
  return true;
}

/** Bilinear sample of `buf` at (ux, uy) in mask pixels; 0 outside. */
static inline int ut_sample_of(const uint8_t *buf, float ux, float uy) {
  const float fx = ux - 0.5f, fy = uy - 0.5f;
  const int x0 = (int)floorf(fx), y0 = (int)floorf(fy);
  const float tx = fx - (float)x0, ty = fy - (float)y0;
  int a00 = 0, a10 = 0, a01 = 0, a11 = 0;
  const int w = s_ut_mask_w, h = s_ut_mask_h;
  if ((unsigned)x0 < (unsigned)w && (unsigned)y0 < (unsigned)h) a00 = buf[y0 * UT_MASK_W + x0];
  if ((unsigned)(x0 + 1) < (unsigned)w && (unsigned)y0 < (unsigned)h) a10 = buf[y0 * UT_MASK_W + x0 + 1];
  if ((unsigned)x0 < (unsigned)w && (unsigned)(y0 + 1) < (unsigned)h) a01 = buf[(y0 + 1) * UT_MASK_W + x0];
  if ((unsigned)(x0 + 1) < (unsigned)w && (unsigned)(y0 + 1) < (unsigned)h) a11 = buf[(y0 + 1) * UT_MASK_W + x0 + 1];
  const float top = a00 + (a10 - a00) * tx, bot = a01 + (a11 - a01) * tx;
  return (int)(top + (bot - top) * ty + 0.5f);
}

/** Bilinear sample of the mask at (ux, uy) in mask pixels; 0 outside. */
static inline int ut_sample(float ux, float uy) {
  const float fx = ux - 0.5f, fy = uy - 0.5f;
  const int x0 = (int)floorf(fx), y0 = (int)floorf(fy);
  const float tx = fx - (float)x0, ty = fy - (float)y0;
  int a00 = 0, a10 = 0, a01 = 0, a11 = 0;
  const int w = s_ut_mask_w, h = s_ut_mask_h;
  if ((unsigned)x0 < (unsigned)w && (unsigned)y0 < (unsigned)h) a00 = s_ut_mask[y0 * UT_MASK_W + x0];
  if ((unsigned)(x0 + 1) < (unsigned)w && (unsigned)y0 < (unsigned)h) a10 = s_ut_mask[y0 * UT_MASK_W + x0 + 1];
  if ((unsigned)x0 < (unsigned)w && (unsigned)(y0 + 1) < (unsigned)h) a01 = s_ut_mask[(y0 + 1) * UT_MASK_W + x0];
  if ((unsigned)(x0 + 1) < (unsigned)w && (unsigned)(y0 + 1) < (unsigned)h) a11 = s_ut_mask[(y0 + 1) * UT_MASK_W + x0 + 1];
  const float top = a00 + (a10 - a00) * tx, bot = a01 + (a11 - a01) * tx;
  return (int)(top + (bot - top) * ty + 0.5f);
}

/**
 * Draw `s` centred on (cx, cy) through a full 2D transform: scaled `sx` by
 * `sy`, rotated `rot_deg` (positive = clockwise on screen), sheared
 * `skew_deg`, in `ink` at `alpha` 0..255, with the red and blue channels
 * displaced `rgb` px either side when non-zero. `shadow` lays a soft dark
 * copy under it first, for legibility over a picture. Honours the clip rect.
 */
static void ut_fx2(const ut_face_t *f, float cx, float cy, const char *s, float sx, float sy, float rot_deg,
                   float skew_deg, uint16_t ink, int alpha, bool shadow, int rgb) {
  if (alpha <= 0 || sx <= 0.f || sy <= 0.f) return;
  if (alpha > 255) alpha = 255;
  if (!ut_raster(f, s)) return;
  /* `shadow` means "this is over a picture". What it gets is a contour, which
   * is the only thing that survives a ground that might be black in one place
   * and blown out in the next. */
  const bool halo = shadow && ut_halo();
  const int mw = s_ut_mask_w, mh = s_ut_mask_h;

  const float rad = rot_deg * 3.14159265f / 180.f;
  const float cs = cosf(rad), sn = sinf(rad);
  const float sk = tanf(skew_deg * 3.14159265f / 180.f);
  const float hw = mw * sx * 0.5f, hh = mh * sy * 0.5f;
  const float ex = fabsf(hw * cs) + fabsf(hh * sn) + fabsf(sk) * hh + 2.f * sx + (float)(rgb < 0 ? -rgb : rgb);
  const float ey = fabsf(hw * sn) + fabsf(hh * cs) + 2.f * sy;
  int x0 = (int)floorf(cx - ex) - 1, x1 = (int)ceilf(cx + ex) + 1;
  int y0 = (int)floorf(cy - ey) - 1, y1 = (int)ceilf(cy + ey) + 1;
  if (x0 < s_clip_x0) x0 = s_clip_x0;
  if (y0 < s_clip_y0) y0 = s_clip_y0;
  if (x1 > s_clip_x1) x1 = s_clip_x1;
  if (y1 > s_clip_y1) y1 = s_clip_y1;
  if (x0 >= x1 || y0 >= y1) return;

  /*
   * Upright, unscaled, unrotated text sits on the mask one for one, and the
   * general path's per-pixel rotation and bilinear sample are pure waste
   * there - waste that showed up as text being four fifths of the cost of
   * drawing the whole finder once the contour sent it down this path. Type at
   * rest is redrawn every pass forever, so it is worth its own loop. Anything
   * in motion, or scaled, or on a fraction of a pixel, takes the general one:
   * that is transient and wants to be right rather than quick.
   */
  if (fabsf(sx - 1.f) < 0.002f && fabsf(sy - 1.f) < 0.002f && fabsf(rot_deg) < 0.01f &&
      fabsf(skew_deg) < 0.01f && rgb == 0) {
    const float lx = cx - (float)mw * 0.5f, ly = cy - (float)mh * 0.5f;
    const int ox = (int)lroundf(lx), oy = (int)lroundf(ly);
    if (fabsf(lx - (float)ox) < 0.06f && fabsf(ly - (float)oy) < 0.06f) {
      for (int pass = 0; pass < (shadow ? 2 : 1); pass++) {
        const bool is_shadow = shadow && pass == 0;
        const uint8_t *src = (is_shadow && halo) ? s_ut_halo : s_ut_mask;
        const uint16_t col = is_shadow ? (uint16_t)0x0841 : ink;
        const int a_run = is_shadow ? (alpha * 4) / 5 : alpha;
        const int sx0 = ox + (is_shadow ? 1 : 0), sy0 = oy + (is_shadow ? 1 : 0);
        int mx0 = s_clip_x0 - sx0, mx1 = s_clip_x1 - sx0;
        int my0 = s_clip_y0 - sy0, my1 = s_clip_y1 - sy0;
        if (mx0 < 0) mx0 = 0;
        if (my0 < 0) my0 = 0;
        if (mx1 > mw) mx1 = mw;
        if (my1 > mh) my1 = mh;
        for (int my = my0; my < my1; my++) {
          const uint8_t *m = &src[my * UT_MASK_W];
          uint16_t *row = s_cv + (size_t)(sy0 + my) * UI_W + sx0;
          for (int mx = mx0; mx < mx1; mx++) {
            const int cov = m[mx];
            if (cov == 0) continue;
            const int a = (cov * a_run) >> 8;
            if (a >= 255) row[mx] = col;
            else if (a > 0) row[mx] = mix(row[mx], col, a);
          }
        }
      }
      return;
    }
  }

  const float ix = 1.f / sx, iy = 1.f / sy;
  const int passes = shadow ? 2 : 1;
  for (int pass = 0; pass < passes; pass++) {
    const bool is_shadow = shadow && pass == 0;
    /* Still offset a little, so it reads as a letter with weight under it
     * rather than as a sticker cut out of the picture. */
    const float ox = is_shadow ? 0.7f * sx : 0.f, oy = is_shadow ? 0.7f * sy : 0.f;
    const uint16_t col = is_shadow ? (uint16_t)0x0841 : ink;
    const int a_run = is_shadow ? (alpha * 4) / 5 : alpha;
    const uint8_t *src = (is_shadow && halo) ? s_ut_halo : s_ut_mask;
    for (int y = y0; y < y1; y++) {
      uint16_t *row = s_cv + (size_t)y * UI_W;
      const float dy = (float)y + 0.5f - cy - oy;
      for (int x = x0; x < x1; x++) {
        const float dx = (float)x + 0.5f - cx - ox;
        float bx = dx * cs + dy * sn, by = -dx * sn + dy * cs;
        bx -= by * sk;
        const float uy = by * iy + mh * 0.5f;
        if (uy < -1.f || uy > mh + 1.f) continue;
        if (rgb == 0 || is_shadow) {
          const float ux = bx * ix + mw * 0.5f;
          if (ux < -1.f || ux > mw + 1.f) continue;
          const int cov = ut_sample_of(src, ux, uy);
          if (cov == 0) continue;
          const int a = (cov * a_run) >> 8;
          if (a >= 255) row[x] = col;
          else if (a > 0) row[x] = mix(row[x], col, a);
        } else {
          /* Three samples, one per channel, the ink split by the same amount. */
          const float uxr = (bx - (float)rgb) * ix + mw * 0.5f, uxg = bx * ix + mw * 0.5f, uxb = (bx + (float)rgb) * ix + mw * 0.5f;
          const int cr = ut_sample_of(src, uxr, uy), cg = ut_sample_of(src, uxg, uy), cb = ut_sample_of(src, uxb, uy);
          if (cr == 0 && cg == 0 && cb == 0) continue;
          const uint16_t d = row[x];
          const uint16_t mr = mix(d, col, (cr * a_run) >> 8), mg = mix(d, col, (cg * a_run) >> 8), mb = mix(d, col, (cb * a_run) >> 8);
          row[x] = (uint16_t)((mr & 0xF800) | (mg & 0x07E0) | (mb & 0x001F));
        }
      }
    }
  }
}

