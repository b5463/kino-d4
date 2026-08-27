#include "icons.h"

#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"

static const char *TAG = "icons";

#define RGB(r, g, b) ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))

/* Display emulation, all deliberately gentler than the pass the smooth-scaled
 * XP set needed. These icons arrive with hard edges and hand-placed dither;
 * the job here is a hint of phosphor, not a filter. Push SCAN past ~0.14 or
 * MASK past ~0.10 and the dither starts beating against the mask and the
 * icons read as noisy rather than as displayed. */
#define SCAN 0.09f
#define MASK 0.06f
#define BLOOM 0.14f
#define BLOOM_R 2

/* Scanlines and the mask both remove light; put the average of each back. */
#define GAIN (1.0f / ((1.0f - SCAN * 0.5f) * (1.0f - MASK * 2.0f / 3.0f)))

#define Q 8
#define ONE (1 << Q)

static const int KW[2 * BLOOM_R + 1] = {1, 4, 6, 4, 1};
#define KSUM 16
#define RING (2 * BLOOM_R + 1)
#define ROWB (ICON_BOX * 3)

static uint16_t *s_rgb[W98_COUNT];
static uint8_t *s_alpha[W98_COUNT];
static uint8_t s_edge[W98_COUNT];
static bool s_ready;

bool icons_ready(void) { return s_ready; }

int icons_edge(int i) { return (i < 0 || i >= W98_COUNT) ? 0 : s_edge[i]; }

static uint16_t mix565(uint16_t a, uint16_t b, int k) {
  const int ar = (a >> 11) & 0x1F, ag = (a >> 5) & 0x3F, ab = a & 0x1F;
  const int br = (b >> 11) & 0x1F, bg = (b >> 5) & 0x3F, bb = b & 0x1F;
  const int r = ar + (((br - ar) * k) >> 8);
  const int g = ag + (((bg - ag) * k) >> 8);
  const int bl = ab + (((bb - ab) * k) >> 8);
  return (uint16_t)((r << 11) | (g << 5) | bl);
}

static inline int clamp255(int v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

/* Per-row scanline gain and the two mask gains, built once. The scanline
 * pitch is the SOURCE pixel, so at 3x one device row in three is the dark
 * one - the grid of the original art and the grid of the display agree,
 * which is what stops the two beating against each other. */
static uint16_t s_scan[ICON_BOX];
static uint16_t s_lit_on, s_lit_off;
static uint8_t s_scan_scale;

static void build_scan(int scale) {
  if (s_scan_scale == scale) return;
  for (int y = 0; y < ICON_BOX; y++) {
    const int phase = y % scale;
    /* Darkest on the last device row of each source pixel, brightest in the
     * middle. A triangle rather than a cosine: no libm, and at three or four
     * rows per pixel the shape past "which row is dark" is invisible. */
    const int mid = scale / 2;
    const int d = phase > mid ? phase - mid : mid - phase;
    const float k = scale > 1 ? (float)d / (float)((scale + 1) / 2) : 0.0f;
    s_scan[y] = (uint16_t)(((1.0f - SCAN * k)) * (float)ONE + 0.5f);
  }
  s_scan_scale = (uint8_t)scale;
}

/**
 * Scale one icon by an integer factor and lay the display over it.
 *
 * Streamed a row at a time through a five-row ring: an output row needs its
 * own colour plus two blurred rows either side, so five rows of each is the
 * entire working set. 4 KB, internal RAM, cache-hot for the whole run -
 * against 124 KB of PSRAM planes for the obvious three-pass shape.
 */
typedef struct {
  uint8_t base[RING][ROWB];
  uint8_t blur[RING][ROWB];
} rows_t;

static void expand(int idx, const w98_icon_t *ic, rows_t *w) {
  const int n = ic->n, k = ic->scale, edge = n * k;
  const int bloom_q = (int)(BLOOM * (float)ONE + 0.5f);
  uint8_t *al = s_alpha[idx];
  build_scan(k);

  for (int r = 0; r < edge + BLOOM_R; r++) {
    if (r < edge) {
      /* ---- nearest-neighbour row, and its premultiplied blur along x ---- */
      const int sy = r / k;
      const uint16_t *srow = ic->rgb + (size_t)sy * n;
      const uint8_t *arow = ic->alpha + (size_t)sy * n;
      uint8_t *brow = w->base[r % RING];
      uint8_t *dal = al + (size_t)r * ICON_BOX;
      uint8_t pre[ROWB];

      for (int x = 0; x < edge; x++) {
        const int sx = x / k;
        const uint16_t c = srow[sx];
        const int a = arow[sx];
        const int cr = ((c >> 11) & 0x1F) << 3;
        const int cg = ((c >> 5) & 0x3F) << 2;
        const int cb = (c & 0x1F) << 3;
        brow[x * 3 + 0] = (uint8_t)cr;
        brow[x * 3 + 1] = (uint8_t)cg;
        brow[x * 3 + 2] = (uint8_t)cb;
        dal[x] = (uint8_t)a;
        pre[x * 3 + 0] = (uint8_t)((cr * a + 128) >> 8);
        pre[x * 3 + 1] = (uint8_t)((cg * a + 128) >> 8);
        pre[x * 3 + 2] = (uint8_t)((cb * a + 128) >> 8);
      }

      uint8_t *trow = w->blur[r % RING];
      for (int x = 0; x < edge; x++) {
        int acc[3] = {0, 0, 0};
        for (int d = -BLOOM_R; d <= BLOOM_R; d++) {
          int sx = x + d;
          if (sx < 0) sx = 0;
          if (sx > edge - 1) sx = edge - 1;
          const int kw = KW[d + BLOOM_R];
          acc[0] += pre[sx * 3 + 0] * kw;
          acc[1] += pre[sx * 3 + 1] * kw;
          acc[2] += pre[sx * 3 + 2] * kw;
        }
        trow[x * 3 + 0] = (uint8_t)(acc[0] / KSUM);
        trow[x * 3 + 1] = (uint8_t)(acc[1] / KSUM);
        trow[x * 3 + 2] = (uint8_t)(acc[2] / KSUM);
      }
    }

    const int y = r - BLOOM_R;
    if (y < 0) continue;

    const uint8_t *src[RING];
    for (int d = -BLOOM_R; d <= BLOOM_R; d++) {
      int sy = y + d;
      if (sy < 0) sy = 0;
      if (sy > edge - 1) sy = edge - 1;
      src[d + BLOOM_R] = w->blur[sy % RING];
    }

    const int scan = s_scan[y];
    const uint8_t *brow = w->base[y % RING];
    uint16_t *out = s_rgb[idx] + (size_t)y * ICON_BOX;

    for (int x = 0; x < edge; x++) {
      int bl[3] = {0, 0, 0};
      for (int t = 0; t < RING; t++) {
        const uint8_t *p = src[t] + x * 3;
        bl[0] += p[0] * KW[t];
        bl[1] += p[1] * KW[t];
        bl[2] += p[2] * KW[t];
      }
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

  s_lit_on = (uint16_t)(GAIN * (float)ONE + 0.5f);
  s_lit_off = (uint16_t)(GAIN * (1.0f - MASK) * (float)ONE + 0.5f);

  rows_t *work = heap_caps_malloc(sizeof(rows_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (work == NULL) {
    ESP_LOGE(TAG, "no room for %u bytes of row scratch", (unsigned)sizeof(rows_t));
    return ESP_ERR_NO_MEM;
  }

  for (int i = 0; i < W98_COUNT; i++) {
    const w98_icon_t *ic = &W98_ICONS[i];
    const int edge = ic->n * ic->scale;
    s_edge[i] = (uint8_t)edge;
    /* Allocated at the box stride so one row index works for every icon,
     * whatever its edge. The slack is never read. */
    s_rgb[i] = heap_caps_calloc(1, (size_t)ICON_BOX * ICON_BOX * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    s_alpha[i] = heap_caps_calloc(1, (size_t)ICON_BOX * ICON_BOX, MALLOC_CAP_SPIRAM);
    if (s_rgb[i] == NULL || s_alpha[i] == NULL) {
      free(work);
      ESP_LOGE(TAG, "no room for icon sprites");
      return ESP_ERR_NO_MEM;
    }
    expand(i, ic, work);
  }

  free(work);
  s_ready = true;
  ESP_LOGI(TAG, "%d w98 icons scaled to %d px max", W98_COUNT, ICON_BOX);
  return ESP_OK;
}

void icons_blit(uint16_t *canvas, int cw, int ch, int i, int x, int y) {
  if (!s_ready || i < 0 || i >= W98_COUNT) return;
  const int edge = s_edge[i];
  for (int row = 0; row < edge; row++) {
    const int gy = y + row;
    if (gy < 0 || gy >= ch) continue;
    const uint16_t *src = s_rgb[i] + (size_t)row * ICON_BOX;
    const uint8_t *al = s_alpha[i] + (size_t)row * ICON_BOX;
    uint16_t *dst = canvas + (size_t)gy * cw;
    for (int col = 0; col < edge; col++) {
      const int gx = x + col;
      if (gx < 0 || gx >= cw) continue;
      if (al[col]) dst[gx] = mix565(dst[gx], src[col], al[col]);
    }
  }
}

void icons_blit_centred(uint16_t *canvas, int cw, int ch, int i, int cx, int cy) {
  const int edge = icons_edge(i);
  icons_blit(canvas, cw, ch, i, cx - edge / 2, cy - edge / 2);
}
