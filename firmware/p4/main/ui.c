#include "ui.h"

#include <stdlib.h>
#include <string.h>

#include "cam_link.h"
#include "display.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "storage.h"
#include "touch.h"

static const char *TAG = "ui";

/* RGB565. Light ground, per the reference camera rather than the dark
 * instrument palette Studio and the guest Roll use — this screen is the
 * product's own face, not a service tool. */
#define C_GROUND 0xEF7D  /* near-white, very slightly warm */
#define C_EDGE 0xC618    /* tile border */
#define C_RING 0x6B4D    /* camera indicator outline, unlit */
#define C_RING_ON 0x0640 /* camera present */
#define C_PRESS 0x9CF3   /* pressed tile wash */

/* Six tiles, in the reference's 2x3 arrangement. Colours stand in for icons
 * that do not exist yet; the point of this pass is geometry and touch. */
static const uint16_t TILE_COLOUR[6] = {0x1C9F, 0xFD20, 0x07FF, 0xFB2C, 0xFFE0, 0xF800};

static uint16_t *s_fb;
static int s_pressed = -1;

/* Layout, logical landscape. The indicator strip takes the top; the grid
 * fills the rest with margins wide enough that a tile edge is never the
 * thing a thumb lands on. */
#define STRIP_H 92
#define MARGIN 20
#define GAP 16
#define COLS 3
#define ROWS 2
#define TILE_W ((UI_W - 2 * MARGIN - (COLS - 1) * GAP) / COLS)
#define TILE_H ((UI_H - STRIP_H - 2 * MARGIN - (ROWS - 1) * GAP) / ROWS)

static void tile_rect(int i, int *x, int *y, int *w, int *h) {
  const int col = i % COLS, row = i / COLS;
  *x = MARGIN + col * (TILE_W + GAP);
  *y = STRIP_H + MARGIN + row * (TILE_H + GAP);
  *w = TILE_W;
  *h = TILE_H;
}

/**
 * Fill a logical-landscape rectangle.
 *
 * The panel is portrait, so this writes the transposed rectangle, with the
 * logical y axis mirrored:
 *
 *     panel_x = (DISPLAY_H_RES - 1) - logical_y
 *     panel_y = logical_x
 *
 * The mirror is measured, not assumed. Without it the grid rendered with its
 * rows swapped top-to-bottom and the camera indicator strip along the bottom
 * edge, while left-to-right stayed correct — a vertical mirror rather than a
 * 180 degree rotation, which is why only one axis is flipped here.
 *
 * Deriving it from touch alone was not possible: sweeping a finger across
 * the screen showed which axis moved, not which end it counted from. That
 * took drawing something asymmetric and looking at it.
 *
 * A transpose still maps rectangles to rectangles, so there is no full-frame
 * rotation pass — the cost of landscape is swapped arguments and one
 * subtraction.
 */
static void fill(int lx, int ly, int lw, int lh, uint16_t colour) {
  if (lx < 0) { lw += lx; lx = 0; }
  if (ly < 0) { lh += ly; ly = 0; }
  if (lx + lw > UI_W) lw = UI_W - lx;
  if (ly + lh > UI_H) lh = UI_H - ly;
  if (lw <= 0 || lh <= 0) return;

  for (int y = ly; y < ly + lh; y++) {
    const int px = DISPLAY_H_RES - 1 - y;
    uint16_t *row = s_fb + (size_t)lx * DISPLAY_H_RES + px;
    for (int i = 0; i < lw; i++) row[(size_t)i * DISPLAY_H_RES] = colour;
  }
}

static void frame(int lx, int ly, int lw, int lh, int t, uint16_t colour) {
  fill(lx, ly, lw, t, colour);
  fill(lx, ly + lh - t, lw, t, colour);
  fill(lx, ly, t, lh, colour);
  fill(lx + lw - t, ly, t, lh, colour);
}

/* Filled circle, logical coordinates. Only used for the camera indicators,
 * so a per-row span is plenty — no need for anything cleverer. */
static void disc(int cx, int cy, int r, uint16_t colour) {
  for (int dy = -r; dy <= r; dy++) {
    const int dx = (int)(0.5f + __builtin_sqrtf((float)(r * r - dy * dy)));
    fill(cx - dx, cy + dy, 2 * dx + 1, 1, colour);
  }
}

static void ring(int cx, int cy, int r, int t, uint16_t colour) {
  disc(cx, cy, r, colour);
  disc(cx, cy, r - t, C_GROUND);
}

static void render(void) {
  fill(0, 0, UI_W, UI_H, C_GROUND);

  /* Four camera indicators, evenly spaced across the strip. Four because the
   * product is four sensors — the one element worth taking verbatim from the
   * reference. Lit means the node answered; on this board none do yet, and
   * showing them unlit is the honest state rather than a decorative row. */
  camlink_info_t cam;
  camlink_get_info(&cam);
  const int r = 22, cy = STRIP_H / 2 + 6;
  for (int i = 0; i < 4; i++) {
    const int cx = UI_W / 2 + (i - 2) * 78 + 39;
    const bool online = (i == 0) ? cam.online : false; /* only CAM1 has a link driver */
    if (online) disc(cx, cy, r, C_RING_ON);
    else ring(cx, cy, r, 4, C_RING);
  }

  for (int i = 0; i < 6; i++) {
    int x, y, w, h;
    tile_rect(i, &x, &y, &w, &h);
    fill(x, y, w, h, TILE_COLOUR[i]);
    if (i == s_pressed) fill(x, y, w, h, C_PRESS);
    frame(x, y, w, h, 3, C_EDGE);
  }
}

static void flush(void) {
  esp_lcd_panel_handle_t panel = display_panel();
  if (panel == NULL) return;
  esp_err_t err =
      esp_lcd_panel_draw_bitmap(panel, 0, 0, DISPLAY_H_RES, DISPLAY_V_RES, s_fb);
  if (err != ESP_OK) ESP_LOGE(TAG, "flush failed: %s", esp_err_to_name(err));
}

static int hit_test(int lx, int ly) {
  for (int i = 0; i < 6; i++) {
    int x, y, w, h;
    tile_rect(i, &x, &y, &w, &h);
    if (lx >= x && lx < x + w && ly >= y && ly < y + h) return i;
  }
  return -1;
}

static void ui_task(void *arg) {
  (void)arg;
  render();
  flush();

  for (;;) {
    uint16_t tx = 0, ty = 0;
    int pressed = -1;
    if (touch_ready() && touch_get(&tx, &ty)) {
      /* Touch reports in panel space, so the same transpose applies in
       * reverse — including the y mirror, or a press would light the tile
       * vertically opposite the one under the finger. Measured: sweeping
       * left to right moved touch y across its full range while x held
       * constant, which makes touch y the logical x. */
      const int lx = ty;
      const int ly = DISPLAY_H_RES - 1 - tx;
      pressed = hit_test(lx, ly);
      if (pressed >= 0 && pressed != s_pressed) {
        ESP_LOGI(TAG, "tile %d pressed (touch %u,%u -> logical %d,%d)", pressed, tx, ty, lx, ly);
      }
    }
    if (pressed != s_pressed) {
      s_pressed = pressed;
      render();
      flush();
    }
    vTaskDelay(pdMS_TO_TICKS(30));
  }
}

esp_err_t ui_start(void) {
  if (!display_ready()) return ESP_ERR_INVALID_STATE;

  /* One framebuffer, panel-shaped. Landscape is a coordinate convention
   * here, not a second buffer. */
  s_fb = heap_caps_malloc((size_t)DISPLAY_H_RES * DISPLAY_V_RES * sizeof(uint16_t),
                          MALLOC_CAP_SPIRAM);
  if (s_fb == NULL) {
    ESP_LOGE(TAG, "no room for a %dx%d framebuffer", DISPLAY_H_RES, DISPLAY_V_RES);
    return ESP_ERR_NO_MEM;
  }

  ESP_LOGI(TAG, "UI_READY %dx%d logical landscape, tiles %dx%d", UI_W, UI_H, TILE_W, TILE_H);
  xTaskCreate(ui_task, "ui", 4096, NULL, 4, NULL);
  return ESP_OK;
}
