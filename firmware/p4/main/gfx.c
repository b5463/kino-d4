#include "gfx.h"

#include <math.h>
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
/*
 * The push needs both frames in LANDSCAPE, which the dissolve does not.
 *
 * A dissolve is a per-pixel blend and can work on the rotated pair, so it
 * rotates once and blends straight into the framebuffer. A push is a shift
 * along the UI's x axis, and after a quarter turn that axis is the panel's y -
 * which is a correct but unverifiable piece of arithmetic on a board nobody
 * can put a picture on today. So the push composites in the space the UI
 * actually draws in, where "left" means left, and pays one rotate per frame
 * for it. Two more canvases of PSRAM against getting the direction wrong on
 * hardware that does not exist yet.
 */
static uint16_t *s_prev;     /* landscape, the frame being pushed out */
static uint16_t *s_mix;      /* landscape, the two of them side by side */
/*
 * A second retained layer, for the parts of a transition that only move.
 *
 * The menu's open move redrew six cards with their type and their icons on
 * every frame, while all any of them did was translate. Measured, that made
 * the first frame of the move cost 2.07 screens of memory traffic and the
 * last 1.00 - so the frames at the start of the move took twice as long as
 * the frames at the end, and the motion lurched in its first third. Which is
 * what "choppy" turned out to mean here: not a low frame rate, an UNEVEN one.
 *
 * Draw it once, keep it, then blit the pieces where they belong. 768 KB of
 * the 32 MB of PSRAM for a transition whose per-frame cost stops depending on
 * what it is drawing.
 */
static uint16_t *s_layer;
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

  s_prev = heap_caps_aligned_calloc(64, 1, CANVAS_BYTES, MALLOC_CAP_SPIRAM);
  s_mix = heap_caps_aligned_calloc(64, 1, CANVAS_BYTES, MALLOC_CAP_SPIRAM);
  s_layer = heap_caps_aligned_calloc(64, 1, CANVAS_BYTES, MALLOC_CAP_SPIRAM);
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
  /* And a landscape copy, for the push. Taken here rather than at the top of
   * gfx_slide() because by then the caller has already drawn the new frame
   * over the old one - the snapshot has to happen before draw_screen(), which
   * is exactly where the dissolve already takes its own. */
  if (s_prev != NULL) memcpy(s_prev, s_canvas, CANVAS_BYTES);
}

/* Accelerating away: nothing that leaves a screen should leave at full speed
 * from a standing start. The list's rows use this and the opening card does
 * not, which is the whole difference between something being pushed aside and
 * something being lifted. */
static inline float ease_in(float t) { return t * t; }

/*
 * Smootherstep: no speed and no acceleration at either end.
 *
 * The curve before this one left at full speed and spent the rest of the
 * move slowing down, which is right for something thrown and wrong for
 * something a person is meant to read. At 200 ms it was over before the eye
 * found it; at 400 ms it was a jump followed by a crawl. What makes a move
 * legible is that it starts from rest, which this does - the object appears
 * to gather itself, travel, and settle, and every part of that is on screen
 * long enough to see.
 *
 * Every motion a person is meant to follow uses it, so the product moves one
 * way rather than three.
 */
static inline float ease_settle(float t) {
  return t * t * t * (t * (t * 6.0f - 15.0f) + 10.0f);
}

static inline float clamp01(float v) { return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v); }

/* Put s_mix on the panel. rotate_to() reads s_canvas, so the composite is
 * pointed at from there for the length of one rotate and put back. */
static bool mix_show(void) {
  void *fb = s_fb[s_back];
  uint16_t *keep = s_canvas;
  s_canvas = s_mix;
  const esp_err_t err = rotate_to(fb);
  s_canvas = keep;
  if (err != ESP_OK) return false;
  show(fb);
  s_back ^= 1;
  s_frames++;
  return true;
}

/* Paint `h` whole rows of a landscape buffer one colour. */
static inline void fill_landscape(uint16_t *buf, int y, int h, uint16_t colour) {
  uint16_t *p = buf + (size_t)y * UI_W;
  const uint32_t pair = ((uint32_t)colour << 16) | colour;
  uint32_t *q = (uint32_t *)(void *)p;
  for (size_t i = (size_t)h * UI_W / 2; i != 0; i--) *q++ = pair;
}

/**
 * One screen pushing the other off.
 *
 * The outgoing and incoming frames travel together, so the eye follows a
 * single moving object rather than watching one thing vanish and another
 * appear. `from_right` is the direction the NEW frame comes from: going into
 * something pushes it in from the right, coming back brings it in from the
 * left, and that is the whole of the spatial model - deeper is rightward.
 *
 * Composited row by row in landscape and rotated per frame. That costs a
 * rotate the dissolve avoids; a push is six or seven frames and the panel is
 * reading 46 MB/s out of the same PSRAM, so the budget is real but it fits.
 */
void gfx_slide(int duration_ms, bool from_right) {
  if (!s_ready || s_prev == NULL || s_mix == NULL || duration_ms <= 0) {
    gfx_present();
    return;
  }
  const int64_t start = esp_timer_get_time();
  const int64_t span = (int64_t)duration_ms * 1000;

  for (;;) {
    const float t = (float)(esp_timer_get_time() - start) / (float)span;
    if (t >= 1.0f) break;
    int o = (int)(ease_settle(t) * (float)UI_W);
    if (o < 0) o = 0;
    if (o > UI_W) o = UI_W;

    /* The frame being left behind travels a third as far as the one arriving.
     * Two sheets locked together read as one sheet; a parallax says the
     * arriving screen is in front and the one behind it is being left, which
     * is the sentence the move is trying to make. */
    int b = (o * 3) / 8;

    for (int y = 0; y < UI_H; y++) {
      uint16_t *dst = s_mix + (size_t)y * UI_W;
      const uint16_t *old = s_prev + (size_t)y * UI_W;
      const uint16_t *fresh = s_canvas + (size_t)y * UI_W;
      if (from_right) {
        memcpy(dst, old + b, (size_t)(UI_W - o) * sizeof(uint16_t));
        memcpy(dst + (UI_W - o), fresh, (size_t)o * sizeof(uint16_t));
      } else {
        memcpy(dst, fresh + (UI_W - o), (size_t)o * sizeof(uint16_t));
        memcpy(dst + o, old + (UI_W - o) - b, (size_t)(UI_W - o) * sizeof(uint16_t));
      }
    }
    if (!mix_show()) break;
  }
  gfx_present();
  s_last_ms = (uint32_t)((esp_timer_get_time() - start) / 1000);
}

/**
 * Keep the frame that has just been drawn, and hand pieces of it back.
 *
 * This is what lets a transition be DRAWN rather than composited. The old
 * gfx_open() moved two finished frames around each other, which is all a
 * compositor can do - and it is why the word on the card stopped following
 * the card: a rectangle of pixels cut out of a 50 px row cannot become a
 * 40 px title, because by the time it is a picture the letters are already
 * the size they are.
 *
 * So the destination is stashed here, ui.c draws every frame of the move with
 * the real fonts and the real shapes, and asks for the part of the
 * destination that has arrived. The renderer keeps the one thing it is good
 * at - holding a whole frame - and the drawing stays where the drawing is.
 */
void gfx_stash(void) {
  if (!s_ready || s_mix == NULL) return;
  memcpy(s_mix, s_canvas, CANVAS_BYTES);
}

/* One blit, from whichever retained buffer, with both ends clipped. */
static void layer_blit(const uint16_t *src, int dx, int dy, int sx, int sy, int w, int h) {
  if (dx < 0) { w += dx; sx -= dx; dx = 0; }
  if (dy < 0) { h += dy; sy -= dy; dy = 0; }
  if (sx < 0) { w += sx; dx -= sx; sx = 0; }
  if (sy < 0) { h += sy; dy -= sy; sy = 0; }
  if (dx + w > UI_W) w = UI_W - dx;
  if (sx + w > UI_W) w = UI_W - sx;
  if (dy + h > UI_H) h = UI_H - dy;
  if (sy + h > UI_H) h = UI_H - sy;
  if (w <= 0 || h <= 0) return;
  for (int r = 0; r < h; r++) {
    memcpy(s_canvas + (size_t)(dy + r) * UI_W + dx, src + (size_t)(sy + r) * UI_W + sx,
           (size_t)w * sizeof(uint16_t));
  }
}

void gfx_layer_keep(void) {
  if (!s_ready || s_layer == NULL) return;
  memcpy(s_layer, s_canvas, CANVAS_BYTES);
}

void gfx_layer_blit(int dx, int dy, int sx, int sy, int w, int h) {
  if (!s_ready || s_layer == NULL) return;
  layer_blit(s_layer, dx, dy, sx, sy, w, h);
}

void gfx_stash_blit(int dx, int dy, int sx, int sy, int w, int h) {
  if (!s_ready || s_mix == NULL) return;
  if (dx < 0) { w += dx; sx -= dx; dx = 0; }
  if (dy < 0) { h += dy; sy -= dy; dy = 0; }
  if (sx < 0) { w += sx; dx -= sx; sx = 0; }
  if (sy < 0) { h += sy; dy -= sy; sy = 0; }
  if (dx + w > UI_W) w = UI_W - dx;
  if (sx + w > UI_W) w = UI_W - sx;
  if (dy + h > UI_H) h = UI_H - dy;
  if (sy + h > UI_H) h = UI_H - sy;
  if (w <= 0 || h <= 0) return;
  for (int r = 0; r < h; r++) {
    memcpy(s_canvas + (size_t)(dy + r) * UI_W + dx, s_mix + (size_t)(sy + r) * UI_W + sx,
           (size_t)w * sizeof(uint16_t));
  }
}

/**
 * A list arriving, one row at a time.
 *
 * Every row travels the same distance at the same speed; they simply start at
 * different moments. That is the whole trick, and it is why a list that
 * cascades reads as a set of separate objects while the same list fading in
 * reads as a picture of a list.
 *
 * The rows arrive over the finished frame, so the ground and anything that is
 * not a row is already in place when the first row lands - the page does not
 * assemble, it receives its contents.
 */
void gfx_cascade(int duration_ms, const gfx_band_t *bands, int n, uint16_t ground) {
  if (!s_ready || s_mix == NULL || duration_ms <= 0 || bands == NULL || n <= 0) {
    gfx_present();
    return;
  }
  /* Each row moves for half the total and the starts are spread over the
   * other half, so the last row lands exactly on time however many there
   * are. */
  const float travel = 0.5f;
  const float step = n > 1 ? (1.0f - travel) / (float)(n - 1) : 0.0f;

  const int64_t start = esp_timer_get_time();
  const int64_t span = (int64_t)duration_ms * 1000;

  for (;;) {
    const float t = (float)(esp_timer_get_time() - start) / (float)span;
    if (t >= 1.0f) break;
    memcpy(s_mix, s_canvas, CANVAS_BYTES);

    for (int i = 0; i < n; i++) {
      float local = (t - step * (float)i) / travel;
      if (local >= 1.0f) continue; /* landed; the copy above is already right */
      if (local < 0.0f) local = 0.0f;
      const int x = bands[i].x, w = bands[i].w;
      int o = (int)((1.0f - ease_settle(local)) * (float)(UI_W - x));
      if (o < 0) o = 0;
      if (o > w) o = w;
      for (int y = bands[i].y; y < bands[i].y + bands[i].h && y < UI_H; y++) {
        uint16_t *dst = s_mix + (size_t)y * UI_W + x;
        const uint16_t *src = s_canvas + (size_t)y * UI_W + x;
        for (int k = 0; k < o; k++) dst[k] = ground;
        memcpy(dst + o, src, (size_t)(w - o) * sizeof(uint16_t));
      }
    }
    if (!mix_show()) break;
  }
  gfx_present();
  s_last_ms = (uint32_t)((esp_timer_get_time() - start) / 1000);
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
