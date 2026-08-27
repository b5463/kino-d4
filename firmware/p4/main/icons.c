#include "icons.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "mesh3d.h"

static const char *TAG = "icons";

#define RGB(r, g, b) ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))
#define C_WELL RGB(0xff, 0xff, 0xff)

/* Supersample factor. Everything is drawn at SS times size and boxed down,
 * which is where the smooth edges come from - both the drawn icons and the
 * rendered ones, since a rasteriser with a depth buffer has no anti-aliasing
 * of its own. 3 is the point where the stair-stepping stops being visible at
 * this size; 2 still shows on a near-vertical edge. */
#define SS 3
#define BIG (ICON_PX * SS)

/* A colour nothing in the set produces, so "was anything drawn here" is an
 * exact test rather than a threshold. */
#define KEY RGB(255, 0, 255)

static uint16_t *s_rgb[6];
static uint8_t *s_alpha[6];
static uint8_t *s_shadow[6];
static bool s_ready;

bool icons_ready(void) { return s_ready; }

/* ------------------------------------------------------------------ */
/* A small 2D painter, working at supersampled resolution              */
/* ------------------------------------------------------------------ */

typedef struct {
  float x, y;
} pt2;

static uint16_t mix565(uint16_t a, uint16_t b, int k) {
  const int ar = (a >> 11) & 0x1F, ag = (a >> 5) & 0x3F, ab = a & 0x1F;
  const int br = (b >> 11) & 0x1F, bg = (b >> 5) & 0x3F, bb = b & 0x1F;
  const int r = ar + (((br - ar) * k) >> 8);
  const int g = ag + (((bg - ag) * k) >> 8);
  const int bl = ab + (((bb - ab) * k) >> 8);
  return (uint16_t)((r << 11) | (g << 5) | bl);
}

/**
 * Scanline-fill a closed polygon with a vertical gradient.
 *
 * Even-odd crossings rather than a convex assumption, because the shape that
 * most needs this is a lightning bolt and a bolt is not convex.
 */
static void poly(uint16_t *buf, const pt2 *p, int n, uint16_t top, uint16_t bot) {
  float ymin = 1e9f, ymax = -1e9f;
  for (int i = 0; i < n; i++) {
    if (p[i].y < ymin) ymin = p[i].y;
    if (p[i].y > ymax) ymax = p[i].y;
  }
  int y0 = (int)floorf(ymin), y1 = (int)ceilf(ymax);
  if (y0 < 0) y0 = 0;
  if (y1 > BIG - 1) y1 = BIG - 1;
  const float span = (ymax - ymin) > 1e-3f ? (ymax - ymin) : 1.0f;

  /* One entry per edge the scanline can cross. The gear is a 32-vertex star
   * and a line near its tips crosses many of them at once; at 16 the extra
   * crossings were dropped, which does not fail loudly - it fills the wrong
   * spans and leaves a shape that looks almost right. */
  float xs[64];
  const int max_x = (int)(sizeof xs / sizeof xs[0]);
  for (int y = y0; y <= y1; y++) {
    const float fy = (float)y + 0.5f;
    int cnt = 0;
    for (int i = 0; i < n && cnt < max_x; i++) {
      const int j = (i + 1) % n;
      const float ay = p[i].y, by = p[j].y;
      if ((fy < ay && fy < by) || (fy >= ay && fy >= by)) continue;
      const float t = (fy - ay) / (by - ay);
      xs[cnt++] = p[i].x + t * (p[j].x - p[i].x);
    }
    for (int a = 1; a < cnt; a++) { /* insertion sort; cnt is tiny */
      const float v = xs[a];
      int b = a - 1;
      while (b >= 0 && xs[b] > v) {
        xs[b + 1] = xs[b];
        b--;
      }
      xs[b + 1] = v;
    }
    const uint16_t c = mix565(top, bot, (int)((fy - ymin) / span * 255.0f));
    for (int k = 0; k + 1 < cnt; k += 2) {
      int xa = (int)ceilf(xs[k] - 0.5f), xb = (int)floorf(xs[k + 1] - 0.5f);
      if (xa < 0) xa = 0;
      if (xb > BIG - 1) xb = BIG - 1;
      uint16_t *row = buf + (size_t)y * BIG;
      for (int x = xa; x <= xb; x++) row[x] = c;
    }
  }
}

/* Scale a polygon about its centroid, which is how the outline is drawn: the
 * dark shape slightly larger, the coloured shape on top of it. */
static void poly_grow(pt2 *out, const pt2 *in, int n, float px) {
  float cx = 0, cy = 0;
  for (int i = 0; i < n; i++) {
    cx += in[i].x;
    cy += in[i].y;
  }
  cx /= (float)n;
  cy /= (float)n;
  for (int i = 0; i < n; i++) {
    const float dx = in[i].x - cx, dy = in[i].y - cy;
    const float d = sqrtf(dx * dx + dy * dy);
    const float k = d > 1e-3f ? (d + px) / d : 1.0f;
    out[i].x = cx + dx * k;
    out[i].y = cy + dy * k;
  }
}

/* A polygon with an outline: the whole XP recipe in one call. */
static void poly_outlined(uint16_t *buf, const pt2 *p, int n, uint16_t top, uint16_t bot,
                          uint16_t line, float width) {
  pt2 big[32];
  if (n > 32) n = 32;
  poly_grow(big, p, n, width);
  poly(buf, big, n, line, line);
  poly(buf, p, n, top, bot);
}

static void disc(uint16_t *buf, float cx, float cy, float r, uint16_t top, uint16_t bot) {
  int y0 = (int)(cy - r), y1 = (int)(cy + r);
  if (y0 < 0) y0 = 0;
  if (y1 > BIG - 1) y1 = BIG - 1;
  for (int y = y0; y <= y1; y++) {
    const float dy = (float)y + 0.5f - cy;
    const float hw = r * r - dy * dy;
    if (hw <= 0) continue;
    const float w = sqrtf(hw);
    int xa = (int)(cx - w), xb = (int)(cx + w);
    if (xa < 0) xa = 0;
    if (xb > BIG - 1) xb = BIG - 1;
    const uint16_t c = mix565(top, bot, (int)((dy + r) / (2.0f * r) * 255.0f));
    uint16_t *row = buf + (size_t)y * BIG;
    for (int x = xa; x <= xb; x++) row[x] = c;
  }
}

/* ------------------------------------------------------------------ */
/* The drawn icons                                                     */
/*                                                                     */
/* Desktop icons of the period had a look the first attempt at these    */
/* missed entirely: a hard near-black keyline round the whole           */
/* silhouette, flat tones rather than gradients, and a small scene      */
/* inside the object instead of a bare shape. A photograph icon has a   */
/* sun and hills on it; a film cassette has sprocket holes; settings is */
/* a wrench crossed with a screwdriver, not an abstract cog. That is    */
/* where the character lives - smooth shapes in tasteful colours read   */
/* as placeholder art, which is exactly what they were.                 */
/* ------------------------------------------------------------------ */

/* Model space for the painters is 0..100 in both axes, so the shapes below
 * read as proportions rather than as pixel counts. */
static float U(float v) { return v * (float)BIG / 100.0f; }

#define OUTLINE RGB(0x14, 0x18, 0x1e)
#define LINE_W U(2.2f)

/* Flat fill: one tone, no ramp. */
static void flat(uint16_t *buf, const pt2 *p, int n, uint16_t c) { poly(buf, p, n, c, c); }

/* Flat fill inside a keyline - the shape every one of these is built from. */
static void flat_keyed(uint16_t *buf, const pt2 *p, int n, uint16_t c) {
  poly_outlined(buf, p, n, c, c, OUTLINE, LINE_W);
}

/* A rectangle, optionally leaning. Photographs and film strips are all
 * rotated rectangles and doing the trigonometry once keeps them honest. */
static void rect4(pt2 *out, float cx, float cy, float hw, float hh, float ang) {
  const float sn = sinf(ang), cs = cosf(ang);
  const float ox[4] = {-hw, hw, hw, -hw};
  const float oy[4] = {-hh, -hh, hh, hh};
  for (int i = 0; i < 4; i++) {
    out[i].x = cx + ox[i] * cs - oy[i] * sn;
    out[i].y = cy + ox[i] * sn + oy[i] * cs;
  }
}

static void bolt(uint16_t *buf) {
  /* One closed silhouette with a keyline, a flat body, a shadow down the
   * trailing side and a hard white nick on the leading edge. No ramp. */
  const pt2 p[6] = {
      {U(60), U(4)},  {U(20), U(54)}, {U(45), U(54)},
      {U(37), U(96)}, {U(82), U(42)}, {U(55), U(42)},
  };
  flat_keyed(buf, p, 6, RGB(0xff, 0xd2, 0x3c));
  const pt2 shade[4] = {{U(55), U(42)}, {U(82), U(42)}, {U(37), U(96)}, {U(46), U(60)}};
  flat(buf, shade, 4, RGB(0xe0, 0x92, 0x18));
  const pt2 hi[4] = {{U(56), U(12)}, {U(28), U(48)}, {U(36), U(48)}, {U(60), U(15)}};
  flat(buf, hi, 4, RGB(0xff, 0xf4, 0xc0));
}

static void photos(uint16_t *buf) {
  /* A photograph with a picture actually on it: sky, a sun and two hills.
   * The version that read as placeholder art was three white cards with
   * coloured rectangles inside them. */
  pt2 q[4];
  rect4(q, U(44), U(44), U(30), U(24), -0.16f);
  flat_keyed(buf, q, 4, RGB(0xff, 0xff, 0xff));
  rect4(q, U(56), U(58), U(31), U(25), 0.09f);
  flat_keyed(buf, q, 4, RGB(0xff, 0xff, 0xff));

  /* The picture inside the front card, in its own leaning frame. */
  const float cx = U(56), cy = U(56), a = 0.09f;
  const float sn = sinf(a), cs = cosf(a);
  const float iw = U(25), ih = U(19);
  pt2 pic[4];
  const float ox[4] = {-iw, iw, iw, -iw};
  const float oy[4] = {-ih, -ih, ih, ih};
  for (int i = 0; i < 4; i++) {
    pic[i].x = cx + ox[i] * cs - oy[i] * sn;
    pic[i].y = cy + ox[i] * sn + oy[i] * cs;
  }
  flat_keyed(buf, pic, 4, RGB(0x8f, 0xc8, 0xf0)); /* sky */

  /* Sun, up in the left of the frame. */
  disc(buf, cx - iw * 0.52f, cy - ih * 0.42f, U(5.5f), RGB(0xff, 0xd8, 0x40),
       RGB(0xff, 0xd8, 0x40));

  /* Two hills along the bottom of the frame, clipped by drawing them inside
   * the frame's own corners. */
  const pt2 hill1[3] = {
      {cx - iw * 0.95f + U(1), cy + ih * 0.92f},
      {cx - iw * 0.10f, cy - ih * 0.05f},
      {cx + iw * 0.55f, cy + ih * 0.92f},
  };
  flat(buf, hill1, 3, RGB(0x4f, 0xa8, 0x54));
  const pt2 hill2[3] = {
      {cx - iw * 0.10f, cy + ih * 0.92f},
      {cx + iw * 0.55f, cy + ih * 0.18f},
      {cx + iw * 0.95f - U(1), cy + ih * 0.92f},
  };
  flat(buf, hill2, 3, RGB(0x2f, 0x7a, 0x38));
}

static void canister(uint16_t *buf) {
  /* A 35 mm cassette with the film pulled out of it - and the film has
   * sprocket holes, which is the entire reason this reads as film rather
   * than as an orange box. */
  const float sx = U(62), sy = U(58);
  pt2 strip[4];
  rect4(strip, sx, sy, U(26), U(13), -0.30f);
  flat_keyed(buf, strip, 4, RGB(0x3a, 0x42, 0x50));
  for (int i = 0; i < 4; i++) {
    const float t = -0.62f + (float)i * 0.40f;
    const float hx = sx + t * U(21) * cosf(-0.30f);
    const float hy = sy + t * U(21) * sinf(-0.30f);
    pt2 hole[4];
    rect4(hole, hx - U(3.2f), hy - U(8.4f), U(2.6f), U(2.2f), -0.30f);
    flat(buf, hole, 4, RGB(0xe8, 0xec, 0xf2));
    rect4(hole, hx + U(3.2f), hy + U(8.4f), U(2.6f), U(2.2f), -0.30f);
    flat(buf, hole, 4, RGB(0xe8, 0xec, 0xf2));
  }

  /* Spool stub, then the body over the top of the strip's left end. */
  const float cx = U(34), top = U(26), bot = U(84), hw = U(20);
  const pt2 spool[4] = {{cx - U(6), U(12)}, {cx + U(6), U(12)}, {cx + U(6), top + U(3)},
                        {cx - U(6), top + U(3)}};
  flat_keyed(buf, spool, 4, RGB(0xa8, 0xb4, 0xc2));

  const pt2 body[4] = {{cx - hw, top}, {cx + hw, top}, {cx + hw, bot}, {cx - hw, bot}};
  flat_keyed(buf, body, 4, RGB(0xf2, 0x8a, 0x2e));
  const pt2 band[4] = {{cx - hw, U(48)}, {cx + hw, U(48)}, {cx + hw, U(64)}, {cx - hw, U(64)}};
  flat(buf, band, 4, RGB(0x3a, 0x42, 0x50));
  const pt2 hi[4] = {{cx - hw + U(4), top + U(4)}, {cx - hw + U(9), top + U(4)},
                     {cx - hw + U(9), bot - U(4)}, {cx - hw + U(4), bot - U(4)}};
  flat(buf, hi, 4, RGB(0xff, 0xc4, 0x84));
}

static void tools(uint16_t *buf) {
  /* A wrench crossed with a screwdriver. A cog is what a settings icon
   * defaults to; a pair of tools is what one with any character does, and
   * the two shapes crossing gives the tile a diagonal nothing else has. */
  const float cx = U(50), cy = U(52);

  /* Screwdriver, running lower-left to upper-right. */
  const float a1 = -0.72f;
  pt2 q[4];
  rect4(q, cx + U(9), cy - U(9), U(26), U(4.5f), a1);
  flat_keyed(buf, q, 4, RGB(0xc8, 0xd2, 0xdd)); /* shaft */
  rect4(q, cx - U(17), cy + U(17), U(15), U(8.0f), a1);
  flat_keyed(buf, q, 4, RGB(0x2f, 0x70, 0xc9)); /* handle */
  rect4(q, cx + U(30), cy - U(30), U(5), U(3.0f), a1);
  flat_keyed(buf, q, 4, RGB(0x8a, 0x97, 0xa8)); /* tip */

  /* Wrench, running lower-right to upper-left, over the top. */
  const float a2 = 0.72f;
  rect4(q, cx - U(4), cy - U(4), U(28), U(5.5f), a2);
  flat_keyed(buf, q, 4, RGB(0xd5, 0xde, 0xe9));
  /* Open jaws at each end: a small square with a notch bitten out, which at
   * this size is two blocks with a gap. */
  for (int e = 0; e < 2; e++) {
    const float d = e ? -1.0f : 1.0f;
    const float jx = cx - U(4) + d * U(27) * cosf(a2);
    const float jy = cy - U(4) + d * U(27) * sinf(a2);
    rect4(q, jx, jy, U(9), U(9), a2);
    flat_keyed(buf, q, 4, RGB(0xd5, 0xde, 0xe9));
    rect4(q, jx + d * U(5) * cosf(a2), jy + d * U(5) * sinf(a2), U(5), U(3.4f), a2);
    flat(buf, q, 4, OUTLINE);
  }
}

static void meter(uint16_t *buf) {
  /* A chunky analogue meter: heavy black bezel, white face, four fat ticks
   * and a red needle. The thin steel dial it replaces had no weight. */
  const float cx = U(50), cy = U(52), r = U(38);
  disc(buf, cx, cy, r + LINE_W, OUTLINE, OUTLINE);
  disc(buf, cx, cy, r, RGB(0x8a, 0x97, 0xa8), RGB(0x8a, 0x97, 0xa8));
  disc(buf, cx, cy, r * 0.82f, OUTLINE, OUTLINE);
  disc(buf, cx, cy, r * 0.76f, RGB(0xff, 0xff, 0xff), RGB(0xff, 0xff, 0xff));

  for (int i = 0; i < 4; i++) {
    const float a = 3.4907f - (float)i * 1.0472f; /* 200 deg round to 20 */
    pt2 q[4];
    rect4(q, cx + r * 0.56f * cosf(a), cy - r * 0.56f * sinf(a), U(5.0f), U(2.6f), -a);
    flat(buf, q, 4, OUTLINE);
  }

  const float na = 0.95f;
  const pt2 needle[3] = {
      {cx - U(4.0f) * sinf(na), cy - U(4.0f) * cosf(na)},
      {cx + U(4.0f) * sinf(na), cy + U(4.0f) * cosf(na)},
      {cx + r * 0.62f * cosf(na), cy - r * 0.62f * sinf(na)},
  };
  flat_keyed(buf, needle, 3, RGB(0xd2, 0x3a, 0x30));
  disc(buf, cx, cy, U(7.5f), OUTLINE, OUTLINE);
  disc(buf, cx, cy, U(4.5f), RGB(0xd5, 0xde, 0xe9), RGB(0xd5, 0xde, 0xe9));
}

/* ------------------------------------------------------------------ */
/* Sprite assembly                                                     */
/* ------------------------------------------------------------------ */

/* Which of the six are rendered, and how they are framed when they are. */
typedef struct {
  bool rendered;
  m3_model_t model;
  float yaw, pitch, zoom;
  void (*paint)(uint16_t *);
} icon_spec_t;

/* The zooms run well above 1 to match the drawn icons' weight.
 *
 * A drawn icon uses the whole 0..100 field by construction, while a rendered
 * one is framed by a bounding sphere - and a sphere around a wide, shallow
 * object is mostly empty air. Left at parity the three rendered icons came
 * out visibly smaller than the three drawn ones, which read as a mistake
 * rather than as a mix. */
static const icon_spec_t SPEC[6] = {
    /* SHOOT is the only rendered tile. It is the camera itself - four lenses
     * on a rigid bar at the real 22 mm pitch - and a shaded solid is the
     * honest way to show a thing that physically exists.
     *
     * The other five are symbols. A bolt, a stack of prints, a cassette, a
     * gear and a dial are ideas, not objects on the bench, and drawn flat
     * with a hard keyline they read harder at 168 px than a shaded solid of
     * the same silhouette ever did. */
    {true, M3_CAMERA, -0.64f, 0.26f, 1.24f, NULL},
    {false, 0, 0, 0, 0, bolt},
    {false, 0, 0, 0, 0, photos},
    {false, 0, 0, 0, 0, canister},
    {false, 0, 0, 0, 0, tools},
    {false, 0, 0, 0, 0, meter},
};

/* Box-filter the supersampled buffer down into the sprite, turning partial
 * coverage into alpha. */
static void resolve(const uint16_t *big, int i) {
  for (int y = 0; y < ICON_PX; y++) {
    uint16_t *rgb = s_rgb[i] + (size_t)y * ICON_PX;
    uint8_t *al = s_alpha[i] + (size_t)y * ICON_PX;
    for (int x = 0; x < ICON_PX; x++) {
      int r = 0, g = 0, b = 0, hit = 0;
      for (int dy = 0; dy < SS; dy++) {
        const uint16_t *row = big + (size_t)(y * SS + dy) * BIG + x * SS;
        for (int dx = 0; dx < SS; dx++) {
          const uint16_t p = row[dx];
          if (p == KEY) continue;
          r += (p >> 11) & 0x1F;
          g += (p >> 5) & 0x3F;
          b += p & 0x1F;
          hit++;
        }
      }
      if (!hit) {
        rgb[x] = 0;
        al[x] = 0;
        continue;
      }
      rgb[x] = (uint16_t)(((r / hit) << 11) | ((g / hit) << 5) | (b / hit));
      al[x] = (uint8_t)(hit * 255 / (SS * SS));
    }
  }
}

/* An elliptical contact shadow under the object's own footprint, sized from
 * the silhouette so a wide object gets a wide shadow. */
static void shadow(int i) {
  int minx = ICON_PX, maxx = -1, maxy = -1;
  for (int y = 0; y < ICON_PX; y++) {
    const uint8_t *al = s_alpha[i] + (size_t)y * ICON_PX;
    for (int x = 0; x < ICON_PX; x++) {
      if (al[x] < 96) continue;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
    }
  }
  if (maxx < 0) return;
  const float cx = (float)(minx + maxx) * 0.5f;
  const float cy = (float)maxy - (float)ICON_PX * 0.010f;
  const float rx = (float)(maxx - minx) * 0.50f;
  const float ry = rx * 0.22f;
  if (rx <= 1.0f || ry <= 0.5f) return;
  for (int y = 0; y < ICON_PX; y++) {
    uint8_t *sh = s_shadow[i] + (size_t)y * ICON_PX;
    const float dy = ((float)y - cy) / ry;
    for (int x = 0; x < ICON_PX; x++) {
      const float dx = ((float)x - cx) / rx;
      const float d2 = dx * dx + dy * dy;
      if (d2 >= 1.0f) continue;
      /* Squared falloff; a linear one has a visible hard rim. */
      const float a = (1.0f - d2) * (1.0f - d2);
      sh[x] = (uint8_t)(a * 96.0f);
    }
  }
}

esp_err_t icons_build(void) {
  if (s_ready) return ESP_OK;

  uint16_t *big = heap_caps_malloc((size_t)BIG * BIG * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
  if (big == NULL) {
    ESP_LOGE(TAG, "no room for the %dx%d supersample buffer", BIG, BIG);
    return ESP_ERR_NO_MEM;
  }

  for (int i = 0; i < 6; i++) {
    s_rgb[i] = heap_caps_malloc((size_t)ICON_PX * ICON_PX * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    s_alpha[i] = heap_caps_calloc(1, (size_t)ICON_PX * ICON_PX, MALLOC_CAP_SPIRAM);
    s_shadow[i] = heap_caps_calloc(1, (size_t)ICON_PX * ICON_PX, MALLOC_CAP_SPIRAM);
    if (s_rgb[i] == NULL || s_alpha[i] == NULL || s_shadow[i] == NULL) {
      free(big);
      ESP_LOGE(TAG, "no room for icon sprites");
      return ESP_ERR_NO_MEM;
    }

    for (size_t k = 0; k < (size_t)BIG * BIG; k++) big[k] = KEY;
    if (SPEC[i].rendered) {
      mesh3d_draw(big, BIG, BIG, 0, 0, BIG, BIG, SPEC[i].model, SPEC[i].yaw, SPEC[i].pitch,
                  SPEC[i].zoom, KEY);
    } else if (SPEC[i].paint) {
      SPEC[i].paint(big);
    }
    resolve(big, i);
    shadow(i);
  }

  free(big);
  s_ready = true;
  ESP_LOGI(TAG, "6 icons built at %dx%d, resolved to %d px", BIG, BIG, ICON_PX);
  return ESP_OK;
}

void icons_blit(uint16_t *canvas, int cw, int chh, int i, int x, int y) {
  if (!s_ready || i < 0 || i >= 6) return;
  for (int row = 0; row < ICON_PX; row++) {
    const int gy = y + row;
    if (gy < 0 || gy >= chh) continue;
    const uint16_t *src = s_rgb[i] + (size_t)row * ICON_PX;
    const uint8_t *al = s_alpha[i] + (size_t)row * ICON_PX;
    const uint8_t *sh = s_shadow[i] + (size_t)row * ICON_PX;
    uint16_t *dst = canvas + (size_t)gy * cw;
    for (int col = 0; col < ICON_PX; col++) {
      const int gx = x + col;
      if (gx < 0 || gx >= cw) continue;
      uint16_t under = dst[gx];
      if (sh[col]) under = mix565(under, RGB(40, 42, 52), sh[col]);
      dst[gx] = al[col] ? mix565(under, src[col], al[col]) : under;
    }
  }
}
