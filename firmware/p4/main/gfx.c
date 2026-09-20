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
#include "klog.h"
#include "ui.h"

static const char *TAG = "gfx";

static void measure_rotate(void);

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
/* Time spent inside gfx_present() since boot: the rotate and the hand-over,
 * which is the part of a frame the drawing code cannot see. A move's report
 * (ui.c, anim_report) subtracts it from the move's wall time to say how much
 * of each frame was drawing and how much was presenting. */
static uint64_t s_present_us;
static uint16_t *s_canvas;   /* landscape, what the UI draws into */
/*
 * Not pipelined, and measured not to be worth it (0.4.58, #177).
 *
 * A second canvas with the PPA rotating one frame while the CPU drew the next
 * was built and run on the panel. It hid the 15 ms of presenting behind the
 * drawing and the drawing grew by the same 10 ms: the splash went from 35 to
 * 36 fps. The PPA and the CPU share one PSRAM bus and at its practical
 * ~90 MB/s - with the panel scanning 46 of them - a full frame is 1.5 MB of
 * rotate plus about 1 MB of drawing, 27 ms, in whatever order the two run.
 * The pipeline bought one frame of latency on every tap and nothing else, so
 * it is not here. Fewer bytes per frame is the lever that works.
 */
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

  measure_rotate();

  s_ready = true;
  ESP_LOGI(TAG, "GFX_READY canvas %dx%d -> panel %dx%d, PPA rotate + blend, %d framebuffers", UI_W,
           UI_H, DISPLAY_H_RES, DISPLAY_V_RES, FB_COUNT);
  return ESP_OK;
}

/*
 * What the rotate costs, measured on the panel (0.4.58, #177).
 *
 * One PPA call turning the whole 800x480 canvas took 30 ms with the PSRAM at
 * 80 MHz - 1.5 MB moved at 50 MB/s, on a bus rated for six times that - and
 * the CPU's own drawing ran at the same 45 MB/s. Rotating in vertical strips
 * (so the destination is written as whole rows) was tried at five widths
 * against a byte-identical check and gained 4 percent, so the write pattern
 * was never the limit; the PSRAM clock was. At 200 MHz the same call takes
 * 16 ms, the drawing halves with it, and the strips still gain 4 percent, so
 * they are not here. The clock lives in sdkconfig.defaults, with the numbers.
 *
 * Every present is timed (s_present_us), and a move reports its frames,
 * presenting time and drawing time to the log ring (ui.c, anim_report), so
 * the next change to this path is measured the same way.
 */

/**
 * Rotate one block of a landscape buffer into a portrait destination.
 *
 * The block is read at (sx, sy) in `src` and lands where logical (dx, dy)
 * lands on the panel. PANEL_ROTATION maps logical (x, y) to panel
 * (H_RES - 1 - y, x), so the destination block is (H_RES - dy - h, dx, h, w).
 * Checked at init against the whole-frame rotate (measure_rotate), because a
 * block that lands one row off looks right and is not. Source and
 * destination differ for exactly one caller: the card of an open move, which
 * shows the arriving screen hung from the card's top edge - stash row 0 at
 * canvas row dy.
 */
static esp_err_t rotate_block(const uint16_t *src, void *dst, int sx, int sy, int w, int h, int dx,
                              int dy) {
  if (w <= 0 || h <= 0) return ESP_OK;
  ppa_srm_oper_config_t cfg = {
      .in =
          {
              .buffer = src,
              .pic_w = UI_W,
              .pic_h = UI_H,
              .block_w = (uint32_t)w,
              .block_h = (uint32_t)h,
              .block_offset_x = (uint32_t)sx,
              .block_offset_y = (uint32_t)sy,
              .srm_cm = PPA_SRM_COLOR_MODE_RGB565,
          },
      .out =
          {
              .buffer = dst,
              .buffer_size = PANEL_BYTES,
              .pic_w = DISPLAY_H_RES,
              .pic_h = DISPLAY_V_RES,
              .block_offset_x = (uint32_t)(DISPLAY_H_RES - dy - h),
              .block_offset_y = (uint32_t)dx,
              .srm_cm = PPA_SRM_COLOR_MODE_RGB565,
          },
      .rotation_angle = PANEL_ROTATION,
      .scale_x = 1.0f,
      .scale_y = 1.0f,
      .mode = PPA_TRANS_MODE_BLOCKING,
  };
  return ppa_do_scale_rotate_mirror(s_srm, &cfg);
}

/** Rotate a whole landscape buffer into a portrait destination. */
static esp_err_t rotate(const uint16_t *src, void *dst) {
  return rotate_block(src, dst, 0, 0, UI_W, UI_H, 0, 0);
}

/** Rotate the canvas into a portrait destination. */
static esp_err_t rotate_to(void *dst) { return rotate(s_canvas, dst); }

/* Whether block rotates land where rotate_block() says they do, on this
 * board, checked once at init. False means gfx_present_with_stash() copies
 * through the canvas instead - slower and right. */
static bool s_blocks_ok;

/*
 * The region a frame takes from the stash rather than from the canvas.
 * Rotated in five blocks: four bands of the canvas round it and the region
 * itself out of the stash, read from stash row `sy` and landing at canvas
 * row y. Returns false if any block failed.
 */
static bool rotate_round(void *fb, int x, int y, int w, int h, int sy) {
  if (rotate_block(s_canvas, fb, 0, 0, UI_W, y, 0, 0) != ESP_OK) return false;
  if (rotate_block(s_canvas, fb, 0, y + h, UI_W, UI_H - y - h, 0, y + h) != ESP_OK) return false;
  if (rotate_block(s_canvas, fb, 0, y, x, h, 0, y) != ESP_OK) return false;
  if (rotate_block(s_canvas, fb, x + w, y, UI_W - x - w, h, x + w, y) != ESP_OK) return false;
  return rotate_block(s_mix, fb, x, sy, w, h, x, y) == ESP_OK;
}

/*
 * One rotate of a test pattern at init, timed into the log ring: the number
 * the frame budget is built on, read back from the camera with GET_LOGS rather
 * than assumed from a datasheet. Then the same pattern through five blocks,
 * compared byte for byte, which is what licenses gfx_present_with_stash() to
 * rotate a stash region straight into the framebuffer.
 */
static void measure_rotate(void) {
  for (int y = 0; y < UI_H; y++) {
    uint16_t *row = s_canvas + (size_t)y * UI_W;
    for (int x = 0; x < UI_W; x++) row[x] = (uint16_t)((x * 7) ^ (y * 13) ^ (x >> 3));
  }
  const int64_t t0 = esp_timer_get_time();
  const esp_err_t err = rotate_to(s_from);
  const int us = (int)(esp_timer_get_time() - t0);
  klog("GFX", "rotate %dx%d -> panel: %d us%s", UI_W, UI_H, us, err == ESP_OK ? "" : " (FAILED)");

  /* The stash holds the same pattern, so a correct block mapping reproduces
   * the reference exactly whichever buffer each block came from. */
  memcpy(s_mix, s_canvas, CANVAS_BYTES);
  memset(s_to, 0, PANEL_BYTES);
  const int64_t t1 = esp_timer_get_time();
  const bool ran = err == ESP_OK && rotate_round(s_to, 96, 64, 512, 288, 64);
  const int us2 = (int)(esp_timer_get_time() - t1);
  s_blocks_ok = ran && memcmp(s_from, s_to, PANEL_BYTES) == 0;
  klog("GFX", "rotate in five blocks: %d us, %s", us2,
       !ran ? "a block failed" : s_blocks_ok ? "identical" : "MISMATCH - not used");
  memset(s_canvas, 0, CANVAS_BYTES);
  memset(s_mix, 0, CANVAS_BYTES);
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
  const int64_t dt = esp_timer_get_time() - t0;
  s_last_ms = (uint32_t)(dt / 1000);
  s_present_us += (uint64_t)dt;
}

/* Every present is synchronous, so a flush has nothing to wait for. Kept so
 * a caller that presents and then sleeps says so at the call site. */
void gfx_flush(void) {}

bool gfx_blocks_ok(void) { return s_ready && s_blocks_ok && s_mix != NULL; }

void gfx_present_with_stash(int x, int y, int w, int h, int sy) {
  if (!s_ready) return;
  /* Even edges: the engine takes RGB565 blocks at pixel offsets, but two
   * pixels to the word is the one alignment worth not arguing with. The
   * source row moves with the destination row so the picture does not. */
  if (x & 1) { x--; w++; }
  if (y & 1) { y--; h++; sy--; }
  if (w & 1) w++;
  if (h & 1) h++;
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; sy -= y; y = 0; }
  if (sy < 0) { h += sy; y -= sy; sy = 0; }
  if (x + w > UI_W) w = UI_W - x;
  if (y + h > UI_H) h = UI_H - y;
  if (sy + h > UI_H) h = UI_H - sy;
  if (w <= 0 || h <= 0) {
    gfx_present();
    return;
  }

  const int64_t t0 = esp_timer_get_time();
  void *fb = s_fb[s_back];
  bool done = false;
  if (s_blocks_ok && s_mix != NULL) done = rotate_round(fb, x, y, w, h, sy);
  if (!done) {
    /* The right picture the slow way: the region through the canvas. */
    gfx_stash_blit(x, y, x, sy, w, h);
    if (rotate_to(fb) != ESP_OK) return;
  }
  show(fb);
  s_back ^= 1;

  s_frames++;
  const int64_t dt = esp_timer_get_time() - t0;
  s_last_ms = (uint32_t)(dt / 1000);
  s_present_us += (uint64_t)dt;
}

uint64_t gfx_present_us_total(void) { return s_present_us; }

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
  const esp_err_t err = rotate(s_mix, fb);
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

/* One canvas: the frame on the panel is the frame last drawn. */
void gfx_stash_shown(void) { gfx_stash(); }

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

void gfx_layer_keep_shown(void) { gfx_layer_keep(); }

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

  /*
   * The finished frame once, then only the rows that are still moving.
   *
   * This copied the whole canvas into the composite on every frame - 768 KB
   * read and written before a single row moved - and then rewrote every
   * travelling band on top. Measured on the panel (0.4.58, #177) the boot
   * cascade ran at 27 fps with the rotate taking 16 of each frame's 37 ms:
   * the copy was most of the rest. A row that has landed is already right
   * from the frame it landed in; a row that has not started is ground the
   * first copy put there. Only the bands in motion are written, each once
   * more when it lands, so the composite's cost per frame is the rows moving
   * and not the screen.
   */
  memcpy(s_mix, s_canvas, CANVAS_BYTES);
  bool landed[16];
  const int nb = n < 16 ? n : 16;
  for (int i = 0; i < nb; i++) {
    landed[i] = false;
    /* Start every band fully out: ground where it will arrive. */
    for (int y = bands[i].y; y < bands[i].y + bands[i].h && y < UI_H; y++) {
      uint16_t *dst = s_mix + (size_t)y * UI_W + bands[i].x;
      for (int k = 0; k < bands[i].w; k++) dst[k] = ground;
    }
  }

  for (;;) {
    const float t = (float)(esp_timer_get_time() - start) / (float)span;
    if (t >= 1.0f) break;

    for (int i = 0; i < nb; i++) {
      if (landed[i]) continue;
      float local = (t - step * (float)i) / travel;
      if (local < 0.0f) continue; /* not started: still ground */
      if (local >= 1.0f) {
        local = 1.0f;
        landed[i] = true; /* this write is its last */
      }
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
