#include "gfx.h"

#include <string.h>

#include "display.h"
#include "driver/ppa.h"
#include "esp_heap_caps.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ui.h"

static const char *TAG = "gfx";

#define FB_COUNT 2
#define PANEL_PX ((size_t)DISPLAY_H_RES * DISPLAY_V_RES)
#define PANEL_BYTES (PANEL_PX * sizeof(uint16_t))
#define CANVAS_PX ((size_t)UI_W * UI_H)
#define CANVAS_BYTES (CANVAS_PX * sizeof(uint16_t))

/* The panel is 90 degrees clockwise from the UI.
 *
 * Measured, not assumed: the mapping the software renderer used was
 * panel_x = (DISPLAY_H_RES - 1) - logical_y, panel_y = logical_x, which is a
 * clockwise quarter turn. The PPA rotates counter-clockwise, so a clockwise
 * quarter turn is asked for as 270. Getting this backwards produces a picture
 * that is upside down rather than one that is obviously wrong, which is worth
 * knowing before spending a flash cycle on it. */
#define PANEL_ROTATION PPA_SRM_ROTATION_ANGLE_270

static ppa_client_handle_t s_srm;
static ppa_client_handle_t s_blend;
static uint16_t *s_canvas;   /* landscape, what the UI draws into */
static uint16_t *s_from;     /* portrait, the dissolve's starting frame */
static uint16_t *s_to;       /* portrait, the dissolve's ending frame */
static void *s_fb[FB_COUNT]; /* the panel driver's own framebuffers */
static int s_back = 0;
static bool s_ready;
static uint32_t s_frames;
static uint32_t s_last_ms;

bool gfx_ready(void) { return s_ready; }
uint16_t *gfx_canvas(void) { return s_canvas; }

void gfx_stats(uint32_t *frames, uint32_t *last_ms) {
  if (frames) *frames = s_frames;
  if (last_ms) *last_ms = s_last_ms;
}

esp_err_t gfx_init(void) {
  if (s_ready) return ESP_OK;

  esp_lcd_panel_handle_t panel = display_panel();
  if (panel == NULL) return ESP_ERR_INVALID_STATE;

  /* The driver allocated these when the panel was created; they are already
   * aligned for DMA and for the PPA's output requirements, which is a good
   * reason to use them rather than allocating our own and copying. */
  esp_err_t err = esp_lcd_dpi_panel_get_frame_buffer(panel, FB_COUNT, &s_fb[0], &s_fb[1]);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "no framebuffers (num_fbs must be %d): %s", FB_COUNT, esp_err_to_name(err));
    return err;
  }

  ppa_client_config_t srm_cfg = {
      .oper_type = PPA_OPERATION_SRM,
      .max_pending_trans_num = 1,
      .data_burst_length = PPA_DATA_BURST_LENGTH_128,
  };
  err = ppa_register_client(&srm_cfg, &s_srm);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "PPA SRM client failed: %s", esp_err_to_name(err));
    return err;
  }
  ppa_client_config_t blend_cfg = {
      .oper_type = PPA_OPERATION_BLEND,
      .max_pending_trans_num = 1,
      .data_burst_length = PPA_DATA_BURST_LENGTH_128,
  };
  err = ppa_register_client(&blend_cfg, &s_blend);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "PPA blend client failed: %s", esp_err_to_name(err));
    return err;
  }

  s_canvas = heap_caps_aligned_calloc(64, 1, CANVAS_BYTES, MALLOC_CAP_SPIRAM);
  s_from = heap_caps_aligned_calloc(64, 1, PANEL_BYTES, MALLOC_CAP_SPIRAM);
  s_to = heap_caps_aligned_calloc(64, 1, PANEL_BYTES, MALLOC_CAP_SPIRAM);
  if (s_canvas == NULL || s_from == NULL || s_to == NULL) {
    ESP_LOGE(TAG, "no room for canvas + dissolve buffers");
    return ESP_ERR_NO_MEM;
  }

  s_ready = true;
  ESP_LOGI(TAG, "GFX_READY canvas %dx%d -> panel %dx%d, PPA rotate + blend, %d framebuffers", UI_W,
           UI_H, DISPLAY_H_RES, DISPLAY_V_RES, FB_COUNT);
  return ESP_OK;
}

/** Rotate the landscape canvas into a portrait destination. */
static esp_err_t rotate_to(void *dst) {
  ppa_srm_oper_config_t cfg = {
      .in =
          {
              .buffer = s_canvas,
              .pic_w = UI_W,
              .pic_h = UI_H,
              .block_w = UI_W,
              .block_h = UI_H,
              .block_offset_x = 0,
              .block_offset_y = 0,
              .srm_cm = PPA_SRM_COLOR_MODE_RGB565,
          },
      .out =
          {
              .buffer = dst,
              .buffer_size = PANEL_BYTES,
              .pic_w = DISPLAY_H_RES,
              .pic_h = DISPLAY_V_RES,
              .block_offset_x = 0,
              .block_offset_y = 0,
              .srm_cm = PPA_SRM_COLOR_MODE_RGB565,
          },
      .rotation_angle = PANEL_ROTATION,
      .scale_x = 1.0f,
      .scale_y = 1.0f,
      .mode = PPA_TRANS_MODE_BLOCKING,
  };
  return ppa_do_scale_rotate_mirror(s_srm, &cfg);
}

/** Hand a framebuffer to the panel. The driver recognises its own buffer and
 *  only writes the cache back and switches the scan source - no copy. */
static void show(void *fb) {
  esp_lcd_panel_handle_t panel = display_panel();
  if (panel == NULL) return;
  esp_err_t err = esp_lcd_panel_draw_bitmap(panel, 0, 0, DISPLAY_H_RES, DISPLAY_V_RES, fb);
  if (err != ESP_OK) ESP_LOGE(TAG, "present failed: %s", esp_err_to_name(err));
}

void gfx_present(void) {
  if (!s_ready) return;
  const int64_t t0 = esp_timer_get_time();

  void *fb = s_fb[s_back];
  if (rotate_to(fb) != ESP_OK) return;
  show(fb);
  s_back ^= 1; /* draw into the other one next time, so the panel keeps
                * scanning the frame it was given until the next is complete */

  s_frames++;
  s_last_ms = (uint32_t)((esp_timer_get_time() - t0) / 1000);
}

void gfx_snapshot(void) {
  if (!s_ready) return;
  rotate_to(s_from);
}

void gfx_dissolve(int duration_ms) {
  if (!s_ready) return;
  if (duration_ms <= 0) {
    gfx_present();
    return;
  }

  /* Both endpoints are rotated once, here, rather than once per frame. Each
   * frame of the dissolve is then a single blend straight into the
   * framebuffer - one pass over the pixels instead of a blend pass plus a
   * rotate pass, which roughly halves the memory bandwidth the transition
   * needs. On this board that is the difference between a smooth fade and the
   * DPI underrunning, because the panel is already reading 46 MB/s out of the
   * same PSRAM. */
  if (rotate_to(s_to) != ESP_OK) {
    gfx_present();
    return;
  }

  const int64_t start = esp_timer_get_time();
  const int64_t span = (int64_t)duration_ms * 1000;

  for (;;) {
    const int64_t now = esp_timer_get_time();
    float t = (float)(now - start) / (float)span;
    if (t >= 1.0f) break;

    /* Smootherstep. The usual smoothstep still has a visible velocity step at
     * each end; this one has zero first and second derivative there, which is
     * what stops a dissolve reading as "it started" and "it stopped". */
    const float e = t * t * t * (t * (t * 6.0f - 15.0f) + 10.0f);
    int k = (int)(e * 255.0f);
    if (k < 0) k = 0;
    if (k > 255) k = 255;

    void *fb = s_fb[s_back];
    ppa_blend_oper_config_t cfg = {
        .in_bg =
            {
                .buffer = s_from,
                .pic_w = DISPLAY_H_RES,
                .pic_h = DISPLAY_V_RES,
                .block_w = DISPLAY_H_RES,
                .block_h = DISPLAY_V_RES,
                .blend_cm = PPA_BLEND_COLOR_MODE_RGB565,
            },
        .in_fg =
            {
                .buffer = s_to,
                .pic_w = DISPLAY_H_RES,
                .pic_h = DISPLAY_V_RES,
                .block_w = DISPLAY_H_RES,
                .block_h = DISPLAY_V_RES,
                .blend_cm = PPA_BLEND_COLOR_MODE_RGB565,
            },
        .out =
            {
                .buffer = fb,
                .buffer_size = PANEL_BYTES,
                .pic_w = DISPLAY_H_RES,
                .pic_h = DISPLAY_V_RES,
                .blend_cm = PPA_BLEND_COLOR_MODE_RGB565,
            },
        /* Background fully opaque, foreground at the eased fraction, so the
         * hardware computes out = to*k + from*(1-k) for every pixel. */
        .bg_alpha_update_mode = PPA_ALPHA_FIX_VALUE,
        .bg_alpha_fix_val = 255,
        .fg_alpha_update_mode = PPA_ALPHA_FIX_VALUE,
        .fg_alpha_fix_val = (uint32_t)k,
        .mode = PPA_TRANS_MODE_BLOCKING,
    };
    if (ppa_do_blend(s_blend, &cfg) != ESP_OK) break;
    show(fb);
    s_back ^= 1;
    s_frames++;
  }

  /* Land exactly on the destination rather than on whatever the last blend
   * step happened to be. */
  gfx_present();
  s_last_ms = (uint32_t)((esp_timer_get_time() - start) / 1000);
}
