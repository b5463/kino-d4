#include "icons.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "icons_xp.h"

static const char *TAG = "icons";

#define RGB(r, g, b) ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))

/* Device pixels per source pixel. 168 / 48 = 3.5, so a source pixel is three
 * and a half device pixels wide and the phase of the grid shifts by half a
 * pixel every other row. That is closer to a CRT than a clean integer
 * multiple would be, and it is why the expansion is resampled rather than
 * block-copied. */
#define SCALE ((float)ICON_PX / (float)XP_ICON_N)

/* Width, in device pixels, of the ramp between one source pixel and the next.
 * 1.0 is sharp-bilinear: square pixels with a single anti-aliased pixel at
 * the edge, which on this panel reads as a screenshot blown up in Paint.
 * Wider than about 2.5 and the pixel grid dissolves and it is just a blurry
 * icon. 1.8 keeps the grid legible with a soft phosphor edge on it. */
#define SOFT 1.8f

/* Scanline depth. The beam is brightest down the middle of a source row and
 * darkest between rows; at 3.5 device pixels per row the dark line is about
 * one pixel wide. Past ~0.25 the icons start reading as damaged rather than
 * as displayed. */
#define SCAN 0.16f

/* Aperture-grille depth, on a three-device-pixel triad. This is the part that
 * carries most of the "CRT" impression at arm's length, because it tints the
 * flat areas that scanlines alone leave clean. */
#define MASK 0.10f

/* Bloom. A CRT's bright areas spill into their neighbours; without this the
 * white of a dialog or the yellow of a warning triangle sits behind the mask
 * looking grey and dirty instead of glowing through it. */
#define BLOOM 0.22f
#define BLOOM_R 2

/* Scanlines and the mask both remove light: the average scanline gain is
 * 1 - SCAN/2 and the average mask gain is 1 - 2*MASK/3. Without putting that
 * back the whole set comes out a stop under the rest of the screen. */
#define GAIN (1.0f / ((1.0f - SCAN * 0.5f) * (1.0f - MASK * 2.0f / 3.0f)))

/* Everything below the setup runs in Q8: a weight of 256 is 1.0. The first
 * version did the same arithmetic in floats, per pixel, against two 84 KB
 * PSRAM planes, and measured 1669 ms for six icons on the bench - slower than
 * the polygon drawing it replaced. Integer maths and precomputed tables took
 * it to 918 ms; streaming it a row at a time, so the working set is 5 KB of
 * internal RAM instead of 168 KB of PSRAM, took it to 575 ms. The output is
 * bit-identical between the last two. */
#define Q 8
#define ONE (1 << Q)

static uint16_t *s_rgb[XP_ICON_COUNT];
static uint8_t *s_alpha[XP_ICON_COUNT];
static bool s_ready;

bool icons_ready(void) { return s_ready; }

static uint16_t mix565(uint16_t a, uint16_t b, int k) {
  const int ar = (a >> 11) & 0x1F, ag = (a >> 5) & 0x3F, ab = a & 0x1F;
  const int br = (b >> 11) & 0x1F, bg = (b >> 5) & 0x3F, bb = b & 0x1F;
  const int r = ar + (((br - ar) * k) >> 8);
  const int g = ag + (((bg - ag) * k) >> 8);
  const int bl = ab + (((bb - ab) * k) >> 8);
  return (uint16_t)((r << 11) | (g << 5) | bl);
}

static inline int clamp255(int v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

/* ------------------------------------------------------------------ */
/* Tables. Built once; the same for every icon and for both axes.      */
/* ------------------------------------------------------------------ */

/**
 * One output coordinate's two source samples and the weight between them.
 *
 * Plain bilinear across a 3.5x expansion is a smear; nearest-neighbour is a
 * staircase. This is the middle: the weight is pinned at 0 or 1 across the
 * body of a source pixel and only moves within SOFT device pixels of the
 * boundary, so the pixel stays square and its edge stays soft.
 *
 * The mapping depends only on the coordinate, so it is 168 entries computed
 * once rather than two transcendental-free but still float-heavy evaluations
 * per pixel per icon - which was 28224 of them, six times over.
 */
typedef struct {
  uint8_t i0, i1; /* source columns (or rows) either side */
  uint16_t w;     /* Q8 weight towards i1 */
} tap_t;

static tap_t s_tap[ICON_PX];
static uint16_t s_scan[ICON_PX]; /* Q8 scanline gain, per device row */
/* Q8 gain for a channel that owns this device column's phosphor stripe, and
 * for one that does not. Two numbers, not three: which channel is lit varies,
 * how much it is lit by does not. */
static uint16_t s_lit_on, s_lit_off;
static bool s_tables;

static void build_tables(void) {
  if (s_tables) return;

  for (int o = 0; o < ICON_PX; o++) {
    const float u = ((float)o + 0.5f) / SCALE - 0.5f;
    int i = (int)floorf(u);
    float f = u - (float)i;

    /* Compress the fraction about its midpoint so the transition occupies
     * SOFT device pixels rather than a whole source pixel. */
    f = (f - 0.5f) * (SCALE / SOFT) + 0.5f;
    f = f < 0.0f ? 0.0f : f > 1.0f ? 1.0f : f;
    f = f * f * (3.0f - 2.0f * f); /* smoothstep: a phosphor edge, not a wedge */

    if (i < 0) i = 0;
    int j = i + 1;
    if (i > XP_ICON_N - 1) i = XP_ICON_N - 1;
    if (j > XP_ICON_N - 1) j = XP_ICON_N - 1;
    s_tap[o].i0 = (uint8_t)i;
    s_tap[o].i1 = (uint8_t)j;
    s_tap[o].w = (uint16_t)(f * (float)ONE + 0.5f);

    /* Where this device row falls within its source row. 0 and 1 are the
     * gaps between scan lines, 0.5 is the centre of the beam. */
    const float ph = ((float)o + 0.5f) / SCALE;
    const float beam = 0.5f - 0.5f * cosf(6.2831853f * (ph - floorf(ph)));
    s_scan[o] = (uint16_t)(((1.0f - SCAN) + SCAN * beam) * (float)ONE + 0.5f);
  }

  s_lit_on = (uint16_t)(GAIN * (float)ONE + 0.5f);
  s_lit_off = (uint16_t)(GAIN * (1.0f - MASK) * (float)ONE + 0.5f);
  s_tables = true;
}

/* ------------------------------------------------------------------ */

/* The blur kernel, and the ring depth that follows from it: an output row
 * reads two rows either side of itself, so five rows have to be in hand. */
static const int KW[2 * BLOOM_R + 1] = {1, 4, 6, 4, 1};
#define KSUM 16
#define RING (2 * BLOOM_R + 1)
#define ROWB (ICON_PX * 3)

/** One row of scratch, kept RING deep. See expand(). */
typedef struct {
  uint8_t base[RING][ROWB]; /* straight resampled colour */
  uint8_t blur[RING][ROWB]; /* premultiplied, blurred along x */
} rows_t;

/** Resample one device row of colour into base, and its coverage into alpha. */
static void row_resample(const xp_icon_t *ic, int y, uint8_t *brow, uint8_t *arow) {
  const tap_t ty = s_tap[y];
  const int r0 = ty.i0 * XP_ICON_N, r1 = ty.i1 * XP_ICON_N;
  const int wy = ty.w, iy = ONE - ty.w;

  for (int x = 0; x < ICON_PX; x++) {
    const tap_t tx = s_tap[x];
    const int wx = tx.w, ix = ONE - tx.w;

    /* Q8 x Q8 back down to Q8, so the products below stay inside 32 bits:
     * 255 (colour) * 255 (alpha) * 256 (weight) * 4 taps is 66M. */
    const int p[4] = {r0 + tx.i0, r0 + tx.i1, r1 + tx.i0, r1 + tx.i1};
    const int k[4] = {(ix * iy) >> Q, (wx * iy) >> Q, (ix * wy) >> Q, (wx * wy) >> Q};

    int r = 0, g = 0, b = 0, a = 0;
    for (int t = 0; t < 4; t++) {
      const int av = ic->alpha[p[t]] * k[t];
      if (!av) continue;
      const uint16_t c = ic->rgb[p[t]];
      /* Weighting colour by alpha as well as by the tap keeps the transparent
       * side of an edge - which carries whatever colour the exporter left
       * behind it - out of the visible rim. */
      r += (((c >> 11) & 0x1F) << 3) * av;
      g += (((c >> 5) & 0x3F) << 2) * av;
      b += ((c & 0x1F) << 3) * av;
      a += av;
    }

    arow[x] = (uint8_t)clamp255(a >> Q);
    if (a > 0) {
      brow[x * 3 + 0] = (uint8_t)clamp255(r / a);
      brow[x * 3 + 1] = (uint8_t)clamp255(g / a);
      brow[x * 3 + 2] = (uint8_t)clamp255(b / a);
    } else {
      brow[x * 3 + 0] = brow[x * 3 + 1] = brow[x * 3 + 2] = 0;
    }
  }
}

/**
 * Premultiply one row by its coverage and blur it along x.
 *
 * Premultiplied, so the bloom fades out at the sprite's edge instead of
 * dragging a black box in from beyond it. Premultiplied once per pixel rather
 * than once per tap: five taps times three channels was fifteen
 * multiply-shifts a pixel to produce five copies of the same five numbers.
 */
static void row_blur_x(const uint8_t *brow, const uint8_t *arow, uint8_t *out) {
  uint8_t pre[ROWB];
  for (int x = 0; x < ICON_PX; x++) {
    const int a = arow[x];
    pre[x * 3 + 0] = (uint8_t)((brow[x * 3 + 0] * a + 128) >> 8);
    pre[x * 3 + 1] = (uint8_t)((brow[x * 3 + 1] * a + 128) >> 8);
    pre[x * 3 + 2] = (uint8_t)((brow[x * 3 + 2] * a + 128) >> 8);
  }
  for (int x = 0; x < ICON_PX; x++) {
    int acc[3] = {0, 0, 0};
    for (int d = -BLOOM_R; d <= BLOOM_R; d++) {
      int sx = x + d;
      if (sx < 0) sx = 0;
      if (sx > ICON_PX - 1) sx = ICON_PX - 1;
      const int w = KW[d + BLOOM_R];
      acc[0] += pre[sx * 3 + 0] * w;
      acc[1] += pre[sx * 3 + 1] * w;
      acc[2] += pre[sx * 3 + 2] * w;
    }
    out[x * 3 + 0] = (uint8_t)(acc[0] / KSUM);
    out[x * 3 + 1] = (uint8_t)(acc[1] / KSUM);
    out[x * 3 + 2] = (uint8_t)(acc[2] / KSUM);
  }
}

/**
 * Expand one 48 px icon to ICON_PX with the artefacts of the display it was
 * drawn for.
 *
 * Streamed a row at a time. The obvious shape is three full-frame passes -
 * resample, blur x, blur y and shade - which needs two 84 KB scratch planes;
 * they do not fit in internal RAM during boot, so they land in PSRAM, and
 * the blur reads each of them five times per output pixel. That access
 * pattern, not the arithmetic, was most of the original 1669 ms.
 *
 * Nothing here needs a whole frame. An output row reads its own resampled
 * colour and five rows of the x-blurred buffer, so five rows of each is the
 * entire working set: 5 KB, small enough to be internal RAM whatever else is
 * going on, and hot in cache for the whole run.
 */
static void expand(int idx, const xp_icon_t *ic, rows_t *w) {
  const int bloom_q = (int)(BLOOM * (float)ONE + 0.5f);
  uint8_t *al = s_alpha[idx];

  /* Produced rows run BLOOM_R ahead of emitted ones, so that by the time row
   * y is shaded, rows y-2..y+2 exist. */
  for (int r = 0; r < ICON_PX + BLOOM_R; r++) {
    if (r < ICON_PX) {
      uint8_t *brow = w->base[r % RING];
      row_resample(ic, r, brow, al + (size_t)r * ICON_PX);
      row_blur_x(brow, al + (size_t)r * ICON_PX, w->blur[r % RING]);
    }

    const int y = r - BLOOM_R;
    if (y < 0) continue;

    /* The five rows this one blurs over, clamped at the edges and resolved
     * once instead of inside the pixel loop. Every one of them is still in
     * the ring: the furthest look-back is BLOOM_R, and the ring is deeper. */
    const uint8_t *src[RING];
    for (int d = -BLOOM_R; d <= BLOOM_R; d++) {
      int sy = y + d;
      if (sy < 0) sy = 0;
      if (sy > ICON_PX - 1) sy = ICON_PX - 1;
      src[d + BLOOM_R] = w->blur[sy % RING];
    }

    const int scan = s_scan[y];
    const uint8_t *brow = w->base[y % RING];
    uint16_t *out = s_rgb[idx] + (size_t)y * ICON_PX;

    for (int x = 0; x < ICON_PX; x++) {
      int bl[3] = {0, 0, 0};
      for (int t = 0; t < RING; t++) {
        const uint8_t *p = src[t] + x * 3;
        const int k = KW[t];
        bl[0] += p[0] * k;
        bl[1] += p[1] * k;
        bl[2] += p[2] * k;
      }

      /* One phosphor stripe per device pixel, repeating R, G, B. */
      const int stripe = x % 3;
      int v[3];
      for (int c = 0; c < 3; c++) {
        const int g = (c == stripe) ? s_lit_on : s_lit_off;
        const int lit = (((brow[x * 3 + c] * scan) >> Q) * g) >> Q;
        v[c] = clamp255(lit + (((bl[c] / KSUM) * bloom_q) >> Q));
      }
      out[x] = RGB(v[0], v[1], v[2]);
    }
  }
}

esp_err_t icons_build(void) {
  if (s_ready) return ESP_OK;
  build_tables();

  const size_t plane = (size_t)ICON_PX * ICON_PX;

  /* Internal RAM, explicitly. The whole point of streaming by rows is that
   * the working set is 5 KB rather than 168 KB, which is small enough to ask
   * for internal during boot and get it. Too big for the 4 KB icon task's
   * stack, hence the heap. */
  rows_t *work = heap_caps_malloc(sizeof(rows_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (work == NULL) {
    ESP_LOGE(TAG, "no room for %u bytes of row scratch", (unsigned)sizeof(rows_t));
    return ESP_ERR_NO_MEM;
  }

  for (int i = 0; i < XP_ICON_COUNT; i++) {
    s_rgb[i] = heap_caps_malloc(plane * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    s_alpha[i] = heap_caps_calloc(1, plane, MALLOC_CAP_SPIRAM);
    if (s_rgb[i] == NULL || s_alpha[i] == NULL) {
      free(work);
      ESP_LOGE(TAG, "no room for icon sprites");
      return ESP_ERR_NO_MEM;
    }
    expand(i, &XP_ICONS[i], work);
  }

  free(work);
  s_ready = true;
  ESP_LOGI(TAG, "%d XP icons expanded from %d px to %d px", XP_ICON_COUNT, XP_ICON_N, ICON_PX);
  return ESP_OK;
}

void icons_blit(uint16_t *canvas, int cw, int chh, int i, int x, int y) {
  if (!s_ready || i < 0 || i >= XP_ICON_COUNT) return;
  for (int row = 0; row < ICON_PX; row++) {
    const int gy = y + row;
    if (gy < 0 || gy >= chh) continue;
    const uint16_t *src = s_rgb[i] + (size_t)row * ICON_PX;
    const uint8_t *al = s_alpha[i] + (size_t)row * ICON_PX;
    uint16_t *dst = canvas + (size_t)gy * cw;
    for (int col = 0; col < ICON_PX; col++) {
      const int gx = x + col;
      if (gx < 0 || gx >= cw) continue;
      if (al[col]) dst[gx] = mix565(dst[gx], src[col], al[col]);
    }
  }
}
