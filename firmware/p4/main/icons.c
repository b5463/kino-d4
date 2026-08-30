#include "icons.h"

#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"

static const char *TAG = "icons";

/* Sprites are the source pixels, scaled by an integer factor and nothing
 * else. No filtering of any kind happens here.
 *
 * The display emulation used to be baked into each icon. It has moved to the
 * screen (ui.c, crt_pass), which is both more honest and better looking: a
 * CRT filters everything in front of it, not each object separately, and
 * running the pass over the whole menu means the type, the chrome and the
 * artwork all sit behind the same glass instead of the icons alone looking
 * treated. */

static uint16_t *s_rgb[W98_COUNT];
static uint8_t *s_alpha[W98_COUNT];
static uint8_t s_edge[W98_COUNT];
static bool s_ready;

bool icons_ready(void) { return s_ready; }

int icons_edge(int i) { return (i < 0 || i >= W98_COUNT) ? 0 : s_edge[i]; }

esp_err_t icons_build(void) {
  if (s_ready) return ESP_OK;

  for (int i = 0; i < W98_COUNT; i++) {
    const w98_icon_t *ic = &W98_ICONS[i];
    const int n = ic->n, k = ic->scale, edge = n * k;
    s_edge[i] = (uint8_t)edge;

    /* Allocated at the box stride so one row index works for every icon,
     * whatever its edge. The slack is never read. */
    s_rgb[i] = heap_caps_calloc(1, (size_t)ICON_BOX * ICON_BOX * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    s_alpha[i] = heap_caps_calloc(1, (size_t)ICON_BOX * ICON_BOX, MALLOC_CAP_SPIRAM);
    if (s_rgb[i] == NULL || s_alpha[i] == NULL) {
      ESP_LOGE(TAG, "no room for icon sprites");
      goto fail;
    }

    for (int y = 0; y < edge; y++) {
      const int sy = y / k;
      const uint16_t *srow = ic->rgb + (size_t)sy * n;
      const uint8_t *arow = ic->alpha + (size_t)sy * n;
      uint16_t *drow = s_rgb[i] + (size_t)y * ICON_BOX;
      uint8_t *dal = s_alpha[i] + (size_t)y * ICON_BOX;
      for (int x = 0; x < edge; x++) {
        const int sx = x / k;
        drow[x] = srow[sx];
        dal[x] = arow[sx];
      }
    }
  }

  s_ready = true;
  ESP_LOGI(TAG, "%d icons scaled to %d px max", W98_COUNT, ICON_BOX);
  return ESP_OK;

  /* Give back whatever was allocated before the one that failed. Roughly
   * 8 KB of PSRAM per icon, and the old return left every earlier sprite
   * held for the life of the device on the one path where memory was already
   * short - the worst possible moment to leak. s_ready stays false, so
   * icons_blit() draws nothing and the menu shows labels only. */
fail:
  for (int i = 0; i < W98_COUNT; i++) {
    free(s_rgb[i]);
    free(s_alpha[i]);
    s_rgb[i] = NULL;
    s_alpha[i] = NULL;
    s_edge[i] = 0;
  }
  return ESP_ERR_NO_MEM;
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
      /* Coverage is one bit by construction (see the baker), so this is a
       * copy or nothing - no blending, no soft edge, no halo against either
       * a light menu or a dark viewfinder. */
      if (al[col]) dst[gx] = src[col];
    }
  }
}

void icons_blit_centred(uint16_t *canvas, int cw, int ch, int i, int cx, int cy) {
  const int edge = icons_edge(i);
  icons_blit(canvas, cw, ch, i, cx - edge / 2, cy - edge / 2);
}
