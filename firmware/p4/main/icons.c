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

static inline int clamp255(float v) { return v < 0.0f ? 0 : v > 255.0f ? 255 : (int)(v + 0.5f); }

/**
 * Map a device coordinate to a source coordinate and a blend weight.
 *
 * Plain bilinear across a 3.5x expansion is a smear; nearest-neighbour is a
 * staircase. This is the middle: the weight is pinned at 0 or 1 across the
 * body of a source pixel and only moves within SOFT device pixels of the
 * boundary, so the pixel stays square and its edge stays soft.
 */
static inline void tap(int out, int *i0, int *i1, float *w) {
  const float u = ((float)out + 0.5f) / SCALE - 0.5f;
  int i = (int)floorf(u);
  float f = u - (float)i;

  /* Compress the fraction about its midpoint so the transition occupies SOFT
   * device pixels rather than a whole source pixel. */
  f = (f - 0.5f) * (SCALE / SOFT) + 0.5f;
  f = f < 0.0f ? 0.0f : f > 1.0f ? 1.0f : f;
  f = f * f * (3.0f - 2.0f * f); /* smoothstep: a phosphor edge, not a wedge */

  if (i < 0) i = 0;
  int j = i + 1;
  if (i > XP_ICON_N - 1) i = XP_ICON_N - 1;
  if (j > XP_ICON_N - 1) j = XP_ICON_N - 1;
  *i0 = i;
  *i1 = j;
  *w = f;
}

/**
 * Expand one 48 px icon to ICON_PX with the artefacts of the display it was
 * drawn for.
 *
 * base and tmp are ICON_PX * ICON_PX * 3 byte scratch buffers, reused across
 * the set: base holds the straight resampled colour, tmp one axis of the
 * bloom blur. Both are the caller's, because six of each would be 1 MB of
 * PSRAM held for the length of one function.
 */
static void expand(int idx, const xp_icon_t *ic, uint8_t *base, uint8_t *tmp) {
  uint8_t *al = s_alpha[idx];

  /* ---- resample, colour weighted by alpha ---------------------------- */
  for (int y = 0; y < ICON_PX; y++) {
    int y0, y1;
    float wy;
    tap(y, &y0, &y1, &wy);
    for (int x = 0; x < ICON_PX; x++) {
      int x0, x1;
      float wx;
      tap(x, &x0, &x1, &wx);

      const int p[4] = {y0 * XP_ICON_N + x0, y0 * XP_ICON_N + x1, y1 * XP_ICON_N + x0,
                        y1 * XP_ICON_N + x1};
      const float k[4] = {(1.0f - wx) * (1.0f - wy), wx * (1.0f - wy), (1.0f - wx) * wy, wx * wy};

      float r = 0, g = 0, b = 0, a = 0;
      for (int t = 0; t < 4; t++) {
        const float av = (float)ic->alpha[p[t]] * k[t];
        const uint16_t c = ic->rgb[p[t]];
        /* Weighting colour by alpha as well as by the tap keeps the
         * transparent side of an edge - which carries whatever colour the
         * exporter left behind it - out of the visible rim. */
        r += (float)(((c >> 11) & 0x1F) << 3) * av;
        g += (float)(((c >> 5) & 0x3F) << 2) * av;
        b += (float)((c & 0x1F) << 3) * av;
        a += av;
      }

      const size_t o = ((size_t)y * ICON_PX + x);
      al[o] = (uint8_t)clamp255(a);
      if (a > 0.5f) {
        base[o * 3 + 0] = (uint8_t)clamp255(r / a);
        base[o * 3 + 1] = (uint8_t)clamp255(g / a);
        base[o * 3 + 2] = (uint8_t)clamp255(b / a);
      } else {
        base[o * 3 + 0] = base[o * 3 + 1] = base[o * 3 + 2] = 0;
      }
    }
  }

  /* ---- bloom, horizontal half ---------------------------------------- */
  /* Blurred premultiplied by alpha, so the glow fades out at the sprite's
   * edge instead of dragging a black box in from beyond it. */
  static const int KW[2 * BLOOM_R + 1] = {1, 4, 6, 4, 1};
  const int KSUM = 16;
  for (int y = 0; y < ICON_PX; y++) {
    for (int x = 0; x < ICON_PX; x++) {
      int acc[3] = {0, 0, 0};
      for (int d = -BLOOM_R; d <= BLOOM_R; d++) {
        int sx = x + d;
        if (sx < 0) sx = 0;
        if (sx > ICON_PX - 1) sx = ICON_PX - 1;
        const size_t s = (size_t)y * ICON_PX + sx;
        const int w = KW[d + BLOOM_R];
        const int a = s_alpha[idx][s];
        for (int c = 0; c < 3; c++) acc[c] += base[s * 3 + c] * a / 255 * w;
      }
      const size_t o = (size_t)y * ICON_PX + x;
      for (int c = 0; c < 3; c++) tmp[o * 3 + c] = (uint8_t)(acc[c] / KSUM);
    }
  }

  /* ---- vertical half, and the display itself ------------------------- */
  for (int y = 0; y < ICON_PX; y++) {
    /* Where this device row falls within its source row. 0 and 1 are the
     * gaps between scan lines, 0.5 is the centre of the beam. */
    const float ph = ((float)y + 0.5f) / SCALE;
    const float beam = 0.5f - 0.5f * cosf(6.2831853f * (ph - floorf(ph)));
    const float scan = (1.0f - SCAN) + SCAN * beam;

    uint16_t *out = s_rgb[idx] + (size_t)y * ICON_PX;
    for (int x = 0; x < ICON_PX; x++) {
      int bl[3] = {0, 0, 0};
      for (int d = -BLOOM_R; d <= BLOOM_R; d++) {
        int sy = y + d;
        if (sy < 0) sy = 0;
        if (sy > ICON_PX - 1) sy = ICON_PX - 1;
        const size_t s = (size_t)sy * ICON_PX + x;
        const int w = KW[d + BLOOM_R];
        for (int c = 0; c < 3; c++) bl[c] += tmp[s * 3 + c] * w;
      }

      /* One phosphor stripe per device pixel, repeating R, G, B. */
      const int stripe = x % 3;
      const size_t o = (size_t)y * ICON_PX + x;
      int v[3];
      for (int c = 0; c < 3; c++) {
        const float m = (c == stripe) ? 1.0f : (1.0f - MASK);
        const float lit = (float)base[o * 3 + c] * scan * m * GAIN;
        v[c] = clamp255(lit + BLOOM * (float)(bl[c] / KSUM));
      }
      out[x] = RGB(v[0], v[1], v[2]);
    }
  }
}

esp_err_t icons_build(void) {
  if (s_ready) return ESP_OK;

  const size_t plane = (size_t)ICON_PX * ICON_PX;
  uint8_t *base = heap_caps_malloc(plane * 3, MALLOC_CAP_SPIRAM);
  uint8_t *tmp = heap_caps_malloc(plane * 3, MALLOC_CAP_SPIRAM);
  if (base == NULL || tmp == NULL) {
    free(base);
    free(tmp);
    ESP_LOGE(TAG, "no room for the %dx%d expansion buffers", ICON_PX, ICON_PX);
    return ESP_ERR_NO_MEM;
  }

  for (int i = 0; i < XP_ICON_COUNT; i++) {
    s_rgb[i] = heap_caps_malloc(plane * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    s_alpha[i] = heap_caps_calloc(1, plane, MALLOC_CAP_SPIRAM);
    if (s_rgb[i] == NULL || s_alpha[i] == NULL) {
      free(base);
      free(tmp);
      ESP_LOGE(TAG, "no room for icon sprites");
      return ESP_ERR_NO_MEM;
    }
    expand(i, &XP_ICONS[i], base, tmp);
  }

  free(base);
  free(tmp);
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
