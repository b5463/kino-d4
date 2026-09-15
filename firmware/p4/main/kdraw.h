// The drawing the scene needs beyond type and a disc: an image through a
// full 2D transform, an anti-aliased line of any width, an alpha fill. All
// honour the clip rect (s_clip_*), so a mask on a node is a clip here.
//
// Everything is inverse-mapped: for each destination pixel inside the
// transformed box's bounding rectangle, find where it came from. That is the
// one shape of loop the whole renderer uses, which keeps the cost predictable
// - a 400x240 image at rest costs a row copy, in motion about a hundred
// thousand samples, and the strip deformation, skew and colour separation
// are three more terms in the same mapping rather than three more passes.
#pragma once

static uint32_t s_kd_pixels; /* image pixels written this pass, for the perf counters */
/* Of those, the ones that went through the inverse mapping rather than the
 * row copy: rotation, shear, a strip tear or a colour split. Several times
 * the cost each, so it is the number that says why a frame is slow. */
static uint32_t s_kd_slow;

/**
 * Shift every channel by `lift` (in 5-bit units, -31..31) and pull toward grey
 * by `d256`, the desaturation in 1/256ths.
 *
 * Integer, and the desaturation is converted once by the caller rather than
 * per pixel. This runs on every pixel of a full screen photograph on LOOK,
 * for as long as the user sits there deciding: it was the single most
 * expensive thing the resting interface did, and none of it needed a float.
 * The luma weights are Rec.601 in 8.8, with green's extra bit shifted out
 * first so all three channels are in the same 5-bit space.
 */
static inline uint16_t px_grade(uint16_t c, int lift, int d256) {
  int r = (c >> 11) & 0x1F, g = (c >> 5) & 0x3F, b = c & 0x1F;
  if (d256 > 0) {
    const int l5 = (77 * r + 150 * (g >> 1) + 29 * b) >> 8;
    r += ((l5 - r) * d256) >> 8;
    g += ((l5 * 2 - g) * d256) >> 8;
    b += ((l5 - b) * d256) >> 8;
  }
  if (lift) { r += lift; g += lift * 2; b += lift; }
  if (r < 0) r = 0;
  if (r > 31) r = 31;
  if (g < 0) g = 0;
  if (g > 63) g = 63;
  if (b < 0) b = 0;
  if (b > 31) b = 31;
  return (uint16_t)((r << 11) | (g << 5) | b);
}

static inline void fill_a(int x, int y, int w, int h, uint16_t ink, int alpha) {
  if (alpha <= 0) return;
  if (x < s_clip_x0) { w -= s_clip_x0 - x; x = s_clip_x0; }
  if (y < s_clip_y0) { h -= s_clip_y0 - y; y = s_clip_y0; }
  if (x + w > s_clip_x1) w = s_clip_x1 - x;
  if (y + h > s_clip_y1) h = s_clip_y1 - y;
  if (w <= 0 || h <= 0) return;
  if (alpha >= 255) { fill(x, y, w, h, ink); return; }
  for (int r = 0; r < h; r++) {
    uint16_t *row = s_cv + (size_t)(y + r) * UI_W + x;
    for (int i = 0; i < w; i++) row[i] = mix(row[i], ink, alpha);
  }
}

/** A capsule from (x0,y0) to (x1,y1), `w` px wide, coverage at the edges. */
static void line_aa(float x0, float y0, float x1, float y1, float w, uint16_t ink, int alpha) {
  if (alpha <= 0 || w <= 0.f) return;
  const float hw = w * 0.5f;
  int bx0 = (int)floorf(fminf(x0, x1) - hw - 1.f), bx1 = (int)ceilf(fmaxf(x0, x1) + hw + 1.f);
  int by0 = (int)floorf(fminf(y0, y1) - hw - 1.f), by1 = (int)ceilf(fmaxf(y0, y1) + hw + 1.f);
  if (bx0 < s_clip_x0) bx0 = s_clip_x0;
  if (by0 < s_clip_y0) by0 = s_clip_y0;
  if (bx1 > s_clip_x1) bx1 = s_clip_x1;
  if (by1 > s_clip_y1) by1 = s_clip_y1;
  const float dx = x1 - x0, dy = y1 - y0;
  const float len2 = dx * dx + dy * dy;
  for (int y = by0; y < by1; y++) {
    uint16_t *row = s_cv + (size_t)y * UI_W;
    const float py = (float)y + 0.5f;
    for (int x = bx0; x < bx1; x++) {
      const float px = (float)x + 0.5f;
      float t = len2 > 0.f ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0.f;
      if (t < 0.f) t = 0.f;
      if (t > 1.f) t = 1.f;
      const float qx = x0 + dx * t - px, qy = y0 + dy * t - py;
      float k = hw + 0.5f - sqrtf(qx * qx + qy * qy);
      if (k <= 0.f) continue;
      if (k > 1.f) k = 1.f;
      const int a = (int)(k * (float)alpha);
      row[x] = a >= 255 ? ink : mix(row[x], ink, a);
    }
  }
}

/**
 * Draw `src` (w x h), cropped to the fractions [c0x,c1x] x [c0y,c1y], into a
 * box of `bw` x `bh` px centred on (cx, cy), rotated `rot_deg`, sheared by
 * `skew_deg`, each row displaced sideways by strip_amp*sin(row*strip_freq +
 * strip_ph) (in box px), with the red and blue channels sampled `rgb` px
 * either side, at `alpha`. Nearest sampling: the panes are already at the
 * screen's scale and a transformed image is on screen for a few hundred ms.
 *
 * At rest - no rotation, no skew, no strip, no separation, full alpha - it is
 * a row-wise scaled copy through two small tables.
 */
static void img_blit_tf(const uint16_t *src, int sw, int sh, float c0x, float c0y, float c1x, float c1y, float cx,
                        float cy, float bw, float bh, float rot_deg, float skew_deg, float strip_amp,
                        float strip_freq, float strip_ph, int rgb, int alpha, int lift, float desat) {
  if (alpha <= 0 || bw < 1.f || bh < 1.f || src == NULL) return;
  if (alpha > 255) alpha = 255;
  const float sx0 = c0x * (float)sw, sy0 = c0y * (float)sh;
  const float sxs = (c1x - c0x) * (float)sw, sys = (c1y - c0y) * (float)sh; /* source span */
  const bool graded = lift != 0 || desat > 0.005f;
  const int d256 = desat > 0.f ? (int)(desat * 256.f + 0.5f) : 0;
  /*
   * The row copy, or the inverse mapping, and the test between them is
   * whether the deformation would move a pixel.
   *
   * These limits used to be set at "not quite zero", which sounds safe and is
   * not: a transition's spring settles toward zero without arriving, so a
   * strip of three quarters of a pixel - which nothing can see - kept a full
   * screen photograph on the mapping path for as long as anyone looked at it,
   * at four times the cost of copying it. They are set at the limit of what
   * can be seen instead. Half a pixel of tear is sub-pixel by definition, and
   * a twentieth of a degree across the whole panel moves a corner by a third
   * of a pixel.
   *
   * A grade is not a deformation at all. It is a function of the colour, not
   * of where the pixel came from, and only needed the mapping because it was
   * lumped in with the rest.
   */
  const bool plain = fabsf(rot_deg) < 0.05f && fabsf(skew_deg) < 0.05f && fabsf(strip_amp) < 0.5f && rgb == 0;
  if (plain) {
    const int x0 = (int)lroundf(cx - bw * 0.5f), y0 = (int)lroundf(cy - bh * 0.5f);
    const int W = (int)lroundf(bw), H = (int)lroundf(bh);
    static uint16_t xmap[UI_W];
    int dx0 = x0 < s_clip_x0 ? s_clip_x0 : x0, dx1 = x0 + W > s_clip_x1 ? s_clip_x1 : x0 + W;
    int dy0 = y0 < s_clip_y0 ? s_clip_y0 : y0, dy1 = y0 + H > s_clip_y1 ? s_clip_y1 : y0 + H;
    if (dx0 >= dx1 || dy0 >= dy1) return;
    for (int x = dx0; x < dx1; x++) {
      int u = (int)(sx0 + ((float)(x - x0) + 0.5f) * sxs / (float)W);
      if (u < 0) u = 0;
      if (u >= sw) u = sw - 1;
      xmap[x - dx0] = (uint16_t)u;
    }
    for (int y = dy0; y < dy1; y++) {
      int v = (int)(sy0 + ((float)(y - y0) + 0.5f) * sys / (float)H);
      if (v < 0) v = 0;
      if (v >= sh) v = sh - 1;
      const uint16_t *srow = src + (size_t)v * sw;
      uint16_t *drow = s_cv + (size_t)y * UI_W;
      if (graded) {
        for (int x = dx0; x < dx1; x++) {
          const uint16_t c = px_grade(srow[xmap[x - dx0]], lift, d256);
          drow[x] = alpha >= 255 ? c : mix(drow[x], c, alpha);
        }
      } else if (alpha >= 255) {
        for (int x = dx0; x < dx1; x++) drow[x] = srow[xmap[x - dx0]];
      } else {
        for (int x = dx0; x < dx1; x++) drow[x] = mix(drow[x], srow[xmap[x - dx0]], alpha);
      }
    }
    s_kd_pixels += (uint32_t)((dx1 - dx0) * (dy1 - dy0));
    return;
  }
  const float r = rot_deg * 3.14159265f / 180.f, cs = cosf(r), sn = sinf(r);
  const float sk = tanf(skew_deg * 3.14159265f / 180.f);
  const float hw = bw * 0.5f, hh = bh * 0.5f;
  const float ex = fabsf(hw * cs) + fabsf(hh * sn) + fabsf(sk) * hh + fabsf(strip_amp) + 2.f;
  const float ey = fabsf(hw * sn) + fabsf(hh * cs) + 2.f;
  int x0 = (int)floorf(cx - ex), x1 = (int)ceilf(cx + ex);
  int y0 = (int)floorf(cy - ey), y1 = (int)ceilf(cy + ey);
  if (x0 < s_clip_x0) x0 = s_clip_x0;
  if (y0 < s_clip_y0) y0 = s_clip_y0;
  if (x1 > s_clip_x1) x1 = s_clip_x1;
  if (y1 > s_clip_y1) y1 = s_clip_y1;
  if (x0 >= x1 || y0 >= y1) return;
  const float kx = sxs / bw, ky = sys / bh;
  for (int y = y0; y < y1; y++) {
    uint16_t *row = s_cv + (size_t)y * UI_W;
    const float dy = (float)y + 0.5f - cy;
    for (int x = x0; x < x1; x++) {
      const float dx = (float)x + 0.5f - cx;
      /* Into the unrotated box: rotate back, then un-shear (x by y). */
      float bx = dx * cs + dy * sn, by = -dx * sn + dy * cs;
      bx -= by * sk;
      if (by < -hh || by >= hh) continue;
      if (strip_amp != 0.f) bx -= strip_amp * sinf((by + hh) * strip_freq + strip_ph);
      if (bx < -hw || bx >= hw) continue;
      const float u = sx0 + (bx + hw) * kx, v = sy0 + (by + hh) * ky;
      int iu = (int)u, iv = (int)v;
      if (iu < 0) iu = 0;
      if (iu >= sw) iu = sw - 1;
      if (iv < 0) iv = 0;
      if (iv >= sh) iv = sh - 1;
      uint16_t c = src[(size_t)iv * sw + iu];
      if (rgb) {
        int ur = iu + rgb, ub = iu - rgb;
        if (ur < 0) ur = 0;
        if (ur >= sw) ur = sw - 1;
        if (ub < 0) ub = 0;
        if (ub >= sw) ub = sw - 1;
        const uint16_t cr = src[(size_t)iv * sw + ur], cb = src[(size_t)iv * sw + ub];
        c = (uint16_t)((cr & 0xF800) | (c & 0x07E0) | (cb & 0x001F));
      }
      if (graded) c = px_grade(c, lift, d256);
      row[x] = alpha >= 255 ? c : mix(row[x], c, alpha);
    }
  }
  s_kd_pixels += (uint32_t)((x1 - x0) * (y1 - y0));
  s_kd_slow += (uint32_t)((x1 - x0) * (y1 - y0));
}
