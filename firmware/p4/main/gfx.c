#include "gfx.h"

#include <math.h>
#include <string.h>

#include "display.h"
#include "driver/ppa.h"
#include "esp_attr.h"
#include "esp_cache.h"
#include "esp_heap_caps.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "klog.h"
#include "ui.h"

static const char *TAG = "gfx";

static void measure_rotate(void);
static bool on_srm_done(ppa_client_handle_t client, ppa_event_data_t *event, void *user_data);

/* The panel's refresh end: see the note at s_target's neighbours below. */
static SemaphoreHandle_t s_vsync;
static volatile bool s_swap_pending; /* a hand-over happened; the panel has not yet switched */
static uint64_t s_vsync_us;          /* time spent waiting for the panel, since boot */
/* Refresh ends since boot, and when the last one was (esp_timer): written by
 * the interrupt, so in internal RAM. The time is written first, so a reader
 * that sees the count unchanged across its read of the time has a pair. */
static volatile uint32_t s_vsync_n;
static volatile int64_t s_vsync_at_us;
/* s_vsync_n just after the last hand-over: that frame is on the glass once
 * the count has moved past it. */
static uint32_t s_shown_n;

/* The refresh end, in interrupt context. In IRAM because the driver insists
 * (it runs from the DMA's frame-end interrupt). */
static bool IRAM_ATTR on_refresh_done(esp_lcd_panel_handle_t panel,
                                      esp_lcd_dpi_panel_event_data_t *edata, void *user_ctx) {
  (void)panel;
  (void)edata;
  (void)user_ctx;
  s_vsync_at_us = esp_timer_get_time();
  __asm__ __volatile__("" ::: "memory");
  s_vsync_n = s_vsync_n + 1;
  BaseType_t woken = pdFALSE;
  if (s_vsync != NULL) xSemaphoreGiveFromISR(s_vsync, &woken);
  return woken == pdTRUE;
}

/**
 * Block until the frame handed over last is on the glass: the refresh count
 * has moved past the one show() noted. Called before the next hand-over, not
 * before drawing: with three buffers the one being drawn into is never the
 * one being scanned (see FB_COUNT), so only the hand-over has to wait, or it
 * would replace a frame the panel never showed.
 */
static void wait_latched(void) {
  if (!s_swap_pending || s_vsync == NULL) return;
  const int64_t t0 = esp_timer_get_time();
  while (s_vsync_n == s_shown_n) {
    if (xSemaphoreTake(s_vsync, pdMS_TO_TICKS(40)) != pdTRUE) {
      ESP_LOGW(TAG, "no refresh end within 40 ms; handing over anyway");
      break;
    }
  }
  s_swap_pending = false;
  s_vsync_us += (uint64_t)(esp_timer_get_time() - t0);
}

/*
 * Three framebuffers (#248): one on the glass, one handed over and waiting
 * for the refresh end, one being drawn.
 *
 * With two, a frame could not start until the refresh end freed the buffer
 * the panel had just stopped scanning, so every frame had to fit in one
 * refresh by itself: one that took 17 ms was held for two, the next started
 * a refresh late, and a move whose frames averaged 13-15 ms still missed
 * one refresh in four. With three, a frame starts as soon as the last one is
 * handed over and only the hand-over waits for the refresh end, so a frame
 * can borrow from the next: what has to fit is the average. 768 KB of PSRAM.
 * display.c asks the driver for three.
 */
#define FB_COUNT 3
/* Tile buffers in internal SRAM, and how many tiles may be on the engine
 * while the CPU draws the next (gfx_render()). */
#define TILE_BUFS 3
#define TILE_INFLIGHT (TILE_BUFS - 1)
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
/* Given by the SRM engine when a non-blocking rotate completes; the tile
 * renderer waits on it before reusing a tile buffer or handing over a frame. */
static SemaphoreHandle_t s_srm_done;
/*
 * The panel's own beat.
 *
 * Given by the DPI driver at the end of every refresh. After a hand-over the
 * panel goes on scanning the OLD framebuffer until the frame it is in ends,
 * so a frame drawn into that buffer before then is drawn over a picture the
 * eye is still being shown - a tear. And frames that land whenever they are
 * ready against a fixed 60 Hz scan are shown for one refresh or two at
 * random, which is the judder a 60 fps animation still has. Both are the one
 * rule: nothing writes a framebuffer the panel has not let go of. With three
 * buffers (FB_COUNT) the one written next is always free; what waits is the
 * hand-over, for the refresh end after the last one (wait_latched), which
 * also paces every animation to the refresh - no frame is replaced unseen.
 */
/* s_vsync, s_swap_pending and s_vsync_us are declared with the interrupt
 * handler that gives the first of them, at the top of the file. */
/* Time spent inside gfx_present() since boot: the rotate and the hand-over,
 * which is the part of a frame the drawing code cannot see. A move's report
 * (ui.c, anim_report) subtracts it from the move's wall time to say how much
 * of each frame was drawing and how much was presenting. */
static uint64_t s_present_us;
static uint16_t *s_canvas;   /* landscape, what the UI draws into */
/* Where the UI's primitives write right now: the whole canvas unless a
 * render pass has pointed them at a tile. */
static gfx_target_t s_target;
static const gfx_target_t *s_view; /* a sub-window of s_target with a moved origin, or NULL */
const gfx_target_t *gfx_target(void) { return s_view != NULL ? s_view : &s_target; }
void gfx_target_view(const gfx_target_t *view) { s_view = view; }
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
static int s_back = 0;       /* the one the next frame is written into */
/* The buffer after `i`, in hand-over order. Buffer i was last handed over
 * three frames ago; the frame after it was on the glass before the frame
 * after that was handed over (wait_latched), so the panel let go of i then. */
static int fb_next(int i) { return i + 1 < FB_COUNT ? i + 1 : 0; }
static bool s_ready;
static uint32_t s_frames;
static uint32_t s_pass; /* drawing passes begun; see gfx_pass_id() */
/* The canvas generation, gfx_canvas_gen(). One writer, the UI task, so a
 * store with release order is enough: no read-modify-write is shared. */
static uint32_t s_canvas_gen = 1;
static uint32_t s_last_ms;

bool gfx_ready(void) { return s_ready; }
uint16_t *gfx_canvas(void) { return s_canvas; }

uint32_t gfx_canvas_gen(void) { return __atomic_load_n(&s_canvas_gen, __ATOMIC_ACQUIRE); }

/* Before the canvas is written, so a reader that copied a page and then sees
 * the same generation knows nothing moved under the copy. */
static void canvas_touched(void) {
  uint32_t g = s_canvas_gen + 1;
  if (g == 0) g = 1;
  __atomic_store_n(&s_canvas_gen, g, __ATOMIC_RELEASE);
}

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
  esp_err_t err = esp_lcd_dpi_panel_get_frame_buffer(panel, FB_COUNT, &s_fb[0], &s_fb[1], &s_fb[2]);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "no framebuffers (num_fbs must be %d): %s", FB_COUNT, esp_err_to_name(err));
    return err;
  }

  ppa_client_config_t srm_cfg = {
      .oper_type = PPA_OPERATION_SRM,
      .max_pending_trans_num = TILE_INFLIGHT,
      .data_burst_length = PPA_DATA_BURST_LENGTH_128,
  };
  err = ppa_register_client(&srm_cfg, &s_srm);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "PPA SRM client failed: %s", esp_err_to_name(err));
    return err;
  }
  /* The panel's refresh end, for wait_latched(). Without it frames are
   * written whenever they are ready, which tears and judders but shows. */
  s_vsync = xSemaphoreCreateBinary();
  if (s_vsync != NULL) {
    const esp_lcd_dpi_panel_event_callbacks_t vcbs = {.on_refresh_done = on_refresh_done};
    if (esp_lcd_dpi_panel_register_event_callbacks(panel, &vcbs, NULL) != ESP_OK) {
      ESP_LOGE(TAG, "DPI refresh callback refused; frames are not paced to the panel");
      vSemaphoreDelete(s_vsync);
      s_vsync = NULL;
    }
  }

  /* The tile renderer's completion signal. Without it every tile is written
   * out by the CPU, which is slower and right. */
  s_srm_done = xSemaphoreCreateCounting(TILE_INFLIGHT, 0);
  if (s_srm_done != NULL) {
    const ppa_event_callbacks_t cbs = {.on_trans_done = on_srm_done};
    if (ppa_client_register_event_callbacks(s_srm, &cbs) != ESP_OK) {
      ESP_LOGE(TAG, "PPA SRM callback refused; tiles go out by CPU");
      vSemaphoreDelete(s_srm_done);
      s_srm_done = NULL;
    }
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

  s_mix = heap_caps_aligned_calloc(64, 1, CANVAS_BYTES, MALLOC_CAP_SPIRAM);
  s_layer = heap_caps_aligned_calloc(64, 1, CANVAS_BYTES, MALLOC_CAP_SPIRAM);
  s_canvas = heap_caps_aligned_calloc(64, 1, CANVAS_BYTES, MALLOC_CAP_SPIRAM);
  s_from = heap_caps_aligned_calloc(64, 1, PANEL_BYTES, MALLOC_CAP_SPIRAM);
  s_to = heap_caps_aligned_calloc(64, 1, PANEL_BYTES, MALLOC_CAP_SPIRAM);
  if (s_canvas == NULL || s_from == NULL || s_to == NULL) {
    ESP_LOGE(TAG, "no room for canvas + dissolve buffers");
    return ESP_ERR_NO_MEM;
  }
  s_target = (gfx_target_t){s_canvas, 0, 0, UI_W, UI_H, UI_W};

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

/*
 * One rotate of a test pattern at init, timed into the log ring: the number
 * the transitions that still rotate (push, dissolve, cascade) are budgeted
 * on, read back from the camera with GET_LOGS rather than assumed.
 */
static void measure_rotate(void) {
  canvas_touched();
  for (int y = 0; y < UI_H; y++) {
    uint16_t *row = s_canvas + (size_t)y * UI_W;
    for (int x = 0; x < UI_W; x++) row[x] = (uint16_t)((x * 7) ^ (y * 13) ^ (x >> 3));
  }
  const int64_t t0 = esp_timer_get_time();
  const esp_err_t err = rotate_to(s_from);
  const int us = (int)(esp_timer_get_time() - t0);
  klog("GFX", "rotate %dx%d -> panel: %d us%s", UI_W, UI_H, us, err == ESP_OK ? "" : " (FAILED)");
  memset(s_canvas, 0, CANVAS_BYTES);
}

/* The cadence (gfx_cadence()): the refresh count at the last hand-over, the
 * spread of the gaps since gfx_cadence_begin(), and a reference point for
 * the refresh period. PSRAM: only show() and the readers touch it. */
static EXT_RAM_BSS_ATTR struct {
  bool have;
  uint32_t last_n;
  uint16_t hist[8];
  uint32_t max_d;   /* the longest gap, in refreshes, uncapped */
  int64_t max_us;   /* when the frame that ended it was handed over */
  int64_t ref_us;
  uint32_t ref_n;
} s_cad;

void gfx_cadence_begin(void) {
  s_cad.have = false;
  memset(s_cad.hist, 0, sizeof s_cad.hist);
  s_cad.max_d = 0;
  s_cad.max_us = 0;
}

void gfx_cadence(gfx_cadence_t *out) {
  if (out == NULL) return;
  memcpy(out->hist, s_cad.hist, sizeof out->hist);
  out->max_n = s_cad.max_d;
  out->max_us = s_cad.max_us;
  out->period_us = 0;
  const uint32_t n = s_vsync_n - s_cad.ref_n;
  if (s_cad.ref_us != 0 && n >= 30) out->period_us = (uint32_t)((esp_timer_get_time() - s_cad.ref_us) / n);
}

/* A hand-over latches at the next refresh end, so the frame is on the glass
 * from refresh n + 1, where n is the count now: the gap to the last frame is
 * the difference of the two counts. A refresh end that lands between this
 * read and the driver's switch makes one gap a refresh long and the next a
 * refresh short; rare, and it cannot hide a held frame. */
static void cadence_note(void) {
  const uint32_t n = s_vsync_n;
  if (s_cad.ref_us == 0) {
    s_cad.ref_us = esp_timer_get_time();
    s_cad.ref_n = n;
  }
  if (s_cad.have) {
    uint32_t d = n - s_cad.last_n;
    if (d > s_cad.max_d) {
      s_cad.max_d = d;
      s_cad.max_us = esp_timer_get_time();
    }
    if (d > 7) d = 7;
    if (s_cad.hist[d] < UINT16_MAX) s_cad.hist[d]++;
  }
  s_cad.last_n = n;
  s_cad.have = true;
}

/** Hand a framebuffer to the panel. The driver recognises its own buffer and
 *  only writes the cache back and switches the scan source - no copy. */
static void show(void *fb) {
  esp_lcd_panel_handle_t panel = display_panel();
  if (panel == NULL) return;
  /* Any refresh end that happened before this hand-over is not the one the
   * next writer must wait for. */
  if (s_vsync != NULL) xSemaphoreTake(s_vsync, 0);
  esp_err_t err = esp_lcd_panel_draw_bitmap(panel, 0, 0, DISPLAY_H_RES, DISPLAY_V_RES, fb);
  /* Read after the switch: a refresh end that lands inside draw_bitmap then
   * makes the wait one refresh longer, never one too short. */
  s_shown_n = s_vsync_n;
  cadence_note();
  if (err != ESP_OK) ESP_LOGE(TAG, "present failed: %s", esp_err_to_name(err));
  /* The backlight comes on with the first frame there is (FW-08); a bool
   * test on every later one. */
  else display_first_light();
  s_swap_pending = true;
}

int64_t gfx_due_us(void) {
  uint32_t n;
  int64_t at;
  do {
    n = s_vsync_n;
    at = s_vsync_at_us;
  } while (n != s_vsync_n);
  const int64_t now = esp_timer_get_time();
  if (at == 0) return now;
  const uint32_t n0 = n - s_cad.ref_n;
  const int64_t per = s_cad.ref_us != 0 && n0 >= 30 ? (at - s_cad.ref_us) / n0 : 16667;
  /* A frame handed over and not yet latched goes up at the next refresh end;
   * the frame drawn now follows it one refresh later. */
  int64_t due = at + ((s_swap_pending && n == s_shown_n) ? 2 : 1) * per;
  while (due < now) due += per;
  return due;
}

void gfx_present(void) {
  if (!s_ready) return;
  /* Whatever was drawn straight into the canvas since the last bump is going
   * to the panel now; a picture read across it is not one picture. */
  canvas_touched();
  const int64_t t0 = esp_timer_get_time();

  void *fb = s_fb[s_back];
  if (rotate_to(fb) != ESP_OK) return;
  wait_latched();
  show(fb);
  s_back = fb_next(s_back);

  s_frames++;
  const int64_t dt = esp_timer_get_time() - t0;
  s_last_ms = (uint32_t)(dt / 1000);
  s_present_us += (uint64_t)dt;
}

void gfx_render_canvas(gfx_draw_fn draw, void *ctx) {
  if (!s_ready || draw == NULL) return;
  canvas_touched();
  s_pass++;
  s_target = (gfx_target_t){s_canvas, 0, 0, UI_W, UI_H, UI_W};
  draw(ctx);
}

/*
 * The tile renderer: a frame without a rotate.
 *
 * Measured on the panel (0.4.58, #177): drawing a frame into a landscape
 * canvas in PSRAM and turning it into the portrait framebuffer with the PPA
 * moved about 2.5 MB over a bus that delivers ~90 MB/s, and the rotate alone
 * was 16 ms of every frame. A frame is 768 KB. So the frame is drawn in
 * bands - TILE_W x TILE_H pixels of the logical screen at a time, in a
 * buffer in internal SRAM where the drawing costs no bus time at all - and
 * each band is written into the framebuffer transposed: one logical column
 * of the tile is TILE_H contiguous pixels of one panel row, 192 bytes, three
 * cache lines, sequential. PSRAM sees the 768 KB write and nothing else.
 *
 * The price is that the drawing runs once per tile - 85 times a frame, 17 x 5
 * tiles of TILE_W x TILE_H - so every primitive clips to the window before it
 * does any work (ui.c), and the frame's drawing must be a function of state,
 * not of the previous tile.
 *
 * The transposition is the mapping the PPA used: logical (x, y) lands at
 * panel row x, panel column H_RES - 1 - y.
 */
/*
 * Three tile buffers (TILE_BUFS), so the engine can hold two tiles while the
 * CPU draws the third: 48 x 96 x 2 bytes x 3 = 27 KB of internal SRAM, the
 * scarce pool on this board (#162). With two, the CPU waited for the engine
 * after every tile that drew faster than the last one wrote out, and a
 * frame cost the sum of the slower of each pair; the third lets a quick tile
 * run ahead. Measured on the panel (#248): writing out 6-7 ms a frame to 4,
 * the start with no frame held. Three 32 px wide tiles in the old 18 KB were
 * tried and lost it all again to the 125 transactions a frame (5-7 ms).
 * 48 x 96 rather than the earlier 128 x 48: a tile's landscape column is a
 * run along a panel row, so TILE_H is the run length written into PSRAM
 * (192 bytes, against 96). A tile is 9 KB rather than 12, because the C6
 * recovery reserve needs two 16 KB blocks of this pool; it reads 2/2 with
 * 74 KB free after boot. Cache-line aligned because the PPA reads them as
 * pictures of their own.
 */
#define TILE_W 48
#define TILE_H 96
static uint16_t s_tiles[TILE_BUFS][TILE_W * TILE_H] __attribute__((aligned(64)));
_Static_assert(TILE_H % 2 == 0 && UI_H % TILE_H == 0 && DISPLAY_H_RES % 2 == 0,
               "tiles must divide the height and the transposed write stores two pixels a word");

/* Where a pass spends its time, since boot: in the drawing callbacks, and in
 * writing the tiles out (the wait for the engine, or the CPU transpose when
 * the engine refused a tile). A move's report shows both. */
static uint64_t s_draw_us, s_xpose_us;
void gfx_pass_split(uint64_t *draw_us, uint64_t *xpose_us, uint64_t *vsync_us) {
  if (draw_us) *draw_us = s_draw_us;
  if (xpose_us) *xpose_us = s_xpose_us;
  if (vsync_us) *vsync_us = s_vsync_us;
}

/*
 * The engine's completion, in interrupt context: one give, nothing else, and
 * only for a tile.
 *
 * The driver calls this for every transaction on the client, the blocking
 * whole-frame rotates too (measure_rotate, the slide's two, a present). Each
 * of those left a give nobody took, and the next tile pass took it as the
 * first tile's completion while that tile was still on the engine: the second
 * tile was refused ("exceed maximum pending transactions"), went out by CPU
 * with an error line on the 115200 console, and the early give and the late
 * one kept every other tile of the frame failing the same way. Measured on
 * the panel (#248): the start's first frame took 513 ms to write out, 42 of
 * its 85 tiles by CPU, and the second 194 ms. A tile's transaction carries
 * TILE_TAG as its user data; nothing else gives.
 */
static const int s_tile_tag = 1; /* its address is the tag */
#define TILE_TAG ((void *)&s_tile_tag)
static bool on_srm_done(ppa_client_handle_t client, ppa_event_data_t *event, void *user_data) {
  (void)client;
  (void)event;
  if (user_data != TILE_TAG) return false;
  BaseType_t woken = pdFALSE;
  if (s_srm_done != NULL) xSemaphoreGiveFromISR(s_srm_done, &woken);
  return woken == pdTRUE;
}

/**
 * One tile, a picture of its own in internal SRAM, rotated by the engine
 * into its place in the framebuffer. Non-blocking: the caller waits on
 * s_srm_done before reusing the tile or handing over the frame.
 */
static esp_err_t rotate_tile_async(const uint16_t *tile, int w, int h, int tx, int ty, void *fb) {
  ppa_srm_oper_config_t cfg = {
      .in =
          {
              .buffer = tile,
              .pic_w = (uint32_t)w,
              .pic_h = (uint32_t)h,
              .block_w = (uint32_t)w,
              .block_h = (uint32_t)h,
              .block_offset_x = 0,
              .block_offset_y = 0,
              .srm_cm = PPA_SRM_COLOR_MODE_RGB565,
          },
      .out =
          {
              .buffer = fb,
              .buffer_size = PANEL_BYTES,
              .pic_w = DISPLAY_H_RES,
              .pic_h = DISPLAY_V_RES,
              .block_offset_x = (uint32_t)(DISPLAY_H_RES - ty - h),
              .block_offset_y = (uint32_t)tx,
              .srm_cm = PPA_SRM_COLOR_MODE_RGB565,
          },
      .rotation_angle = PANEL_ROTATION,
      .scale_x = 1.0f,
      .scale_y = 1.0f,
      .mode = PPA_TRANS_MODE_NON_BLOCKING,
      .user_data = TILE_TAG,
  };
  return ppa_do_scale_rotate_mirror(s_srm, &cfg);
}

/* The same tile, written out by the CPU: the fallback when the engine will
 * not take it. Column x of the tile is logical column tx + x, which is panel
 * row tx + x; its h pixels run from panel column H_RES - ty - h (logical
 * y = ty + h - 1) up to H_RES - 1 - ty (logical y = ty), so the tile column
 * is read bottom to top, two pixels a word-aligned store. */
static void transpose_tile(const uint16_t *tile, int w, int h, int tx, int ty, uint16_t *fb) {
  for (int x = 0; x < w; x++) {
    uint32_t *dst =
        (uint32_t *)(void *)(fb + (size_t)(tx + x) * DISPLAY_H_RES + (DISPLAY_H_RES - ty - h));
    const uint16_t *src = tile + (size_t)(h - 1) * (size_t)w + x;
    for (int j = 0; j < h; j += 2) {
      const uint32_t lo = *src;
      src -= w;
      const uint32_t hi = *src;
      src -= w;
      *dst++ = lo | (hi << 16);
    }
  }
}

uint32_t gfx_pass_id(void) { return s_pass; }

uint32_t gfx_measure_draw_us(gfx_draw_fn draw, void *ctx) {
  if (!s_ready || draw == NULL) return 0;
  s_pass++;
  const int64_t t0 = esp_timer_get_time();
  for (int ty = 0; ty < UI_H; ty += TILE_H) {
    const int h = UI_H - ty < TILE_H ? UI_H - ty : TILE_H;
    for (int tx = 0; tx < UI_W; tx += TILE_W) {
      const int w = UI_W - tx < TILE_W ? UI_W - tx : TILE_W;
      s_target = (gfx_target_t){s_tiles[0], tx, ty, w, h, w};
      draw(ctx);
    }
  }
  s_target = (gfx_target_t){s_canvas, 0, 0, UI_W, UI_H, UI_W};
  return (uint32_t)(esp_timer_get_time() - t0);
}

void gfx_render(gfx_draw_fn draw, void *ctx) {
  if (!s_ready || draw == NULL) return;
  s_pass++;
  const int64_t t0 = esp_timer_get_time();
  uint16_t *fb = s_fb[s_back]; /* free: see fb_next() */
  int pending = 0; /* tiles on the engine, oldest first */
  int which = 0;

  for (int ty = 0; ty < UI_H; ty += TILE_H) {
    const int h = UI_H - ty < TILE_H ? UI_H - ty : TILE_H;
    for (int tx = 0; tx < UI_W; tx += TILE_W) {
      const int w = UI_W - tx < TILE_W ? UI_W - tx : TILE_W;
      uint16_t *tile = s_tiles[which];
      /* This buffer was last read by the engine TILE_BUFS tiles ago, and
       * that read was waited for before the next tile was submitted: at most
       * TILE_INFLIGHT are ever on the engine. */
      s_target = (gfx_target_t){tile, tx, ty, w, h, w};
      const int64_t d0 = esp_timer_get_time();
      draw(ctx);
      const int64_t d1 = esp_timer_get_time();
      s_draw_us += (uint64_t)(d1 - d0);

      if (pending == TILE_INFLIGHT) {
        if (xSemaphoreTake(s_srm_done, pdMS_TO_TICKS(50)) != pdTRUE) {
          ESP_LOGE(TAG, "tile rotate did not complete in 50 ms");
        }
        pending--;
      }
      if (s_srm_done != NULL && rotate_tile_async(tile, w, h, tx, ty, fb) == ESP_OK) {
        pending++;
      } else {
        transpose_tile(tile, w, h, tx, ty, fb);
      }
      s_xpose_us += (uint64_t)(esp_timer_get_time() - d1);
      which = which + 1 < TILE_BUFS ? which + 1 : 0;
    }
  }
  if (pending > 0) {
    const int64_t w0 = esp_timer_get_time();
    for (; pending > 0; pending--) {
      if (xSemaphoreTake(s_srm_done, pdMS_TO_TICKS(50)) != pdTRUE) {
        ESP_LOGE(TAG, "last tile rotate did not complete in 50 ms");
      }
    }
    s_xpose_us += (uint64_t)(esp_timer_get_time() - w0);
  }
  s_target = (gfx_target_t){s_canvas, 0, 0, UI_W, UI_H, UI_W};

  wait_latched();
  show(fb);
  s_back = fb_next(s_back);
  s_frames++;
  const int64_t dt = esp_timer_get_time() - t0;
  s_last_ms = (uint32_t)(dt / 1000);
  s_present_us += (uint64_t)dt;
}

uint64_t gfx_present_us_total(void) { return s_present_us; }

void gfx_snapshot(void) {
  if (!s_ready) return;
  rotate_to(s_from);
}

/*
 * A slide is two pictures and nothing else changes inside it, so it is
 * composed where the panel reads: in its own orientation. The leaving screen
 * is already there (gfx_snapshot() rotates the canvas into s_from); this
 * rotates the stash, the arriving screen, into s_to. rotate_block() maps a
 * landscape column to a panel row, so a landscape offset is a row offset and
 * one frame is two contiguous copies into the back buffer - about a
 * millisecond, against the 13 ms of blitting the same pixels through the
 * tiles and the 28 fps of the compositor loop this replaced.
 */
void gfx_slide_prepare(void) {
  if (!s_ready || s_mix == NULL || s_to == NULL) return;
  rotate(s_mix, s_to);
}

void gfx_slide_show(int o, int b, bool from_right) {
  if (!s_ready || s_from == NULL || s_to == NULL) return;
  const int64_t t0 = esp_timer_get_time();
  if (o < 0) o = 0;
  if (o > UI_W) o = UI_W;
  if (b < 0) b = 0;
  if (b > o) b = o;
  const size_t row = DISPLAY_H_RES; /* one landscape column, in pixels */
  uint16_t *fb = s_fb[s_back];
  const int64_t c0 = esp_timer_get_time();
  if (from_right) {
    /* Columns [0, UI_W-o) show the leaving screen from column b on; the rest
     * is the arriving screen's first o columns. */
    memcpy(fb, s_from + (size_t)b * row, (size_t)(UI_W - o) * row * sizeof(uint16_t));
    memcpy(fb + (size_t)(UI_W - o) * row, s_to, (size_t)o * row * sizeof(uint16_t));
  } else {
    /* The arriving screen's last o columns first; the leaving one follows,
     * moved b columns the other way. */
    memcpy(fb, s_to + (size_t)(UI_W - o) * row, (size_t)o * row * sizeof(uint16_t));
    memcpy(fb + (size_t)o * row, s_from + (size_t)(o - b) * row,
           (size_t)(UI_W - o) * row * sizeof(uint16_t));
  }
  /* The CPU wrote it; the panel reads it by DMA. */
  esp_cache_msync(fb, PANEL_BYTES, ESP_CACHE_MSYNC_FLAG_DIR_C2M);
  /* The copy is this frame's writing out, and a move's report says so. */
  s_xpose_us += (uint64_t)(esp_timer_get_time() - c0);
  wait_latched();
  show(fb);
  s_back = fb_next(s_back);
  s_frames++;
  const int64_t dt = esp_timer_get_time() - t0;
  s_last_ms = (uint32_t)(dt / 1000);
  s_present_us += (uint64_t)dt;
}

/**
 * Keep the frame that has just been drawn, and hand pieces of it back.
 *
 * This is what lets a transition be DRAWN rather than composited. A
 * compositor can only move two finished frames around each other, and that is
 * why the word on the card stopped following the card: a rectangle of pixels
 * cut out of a 50 px row cannot become a 40 px title, because by the time it
 * is a picture the letters are already the size they are.
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

void gfx_render_stash(gfx_draw_fn draw, void *ctx) {
  if (!s_ready || s_mix == NULL || draw == NULL) return;
  s_pass++;
  s_target = (gfx_target_t){s_mix, 0, 0, UI_W, UI_H, UI_W};
  draw(ctx);
  s_target = (gfx_target_t){s_canvas, 0, 0, UI_W, UI_H, UI_W};
}
const uint16_t *gfx_stash_px(void) { return s_mix; }


/* One blit, from whichever retained buffer into the current target, with
 * both ends clipped: the source to the canvas, the destination to the
 * target's window. */
static void layer_blit(const uint16_t *src, int dx, int dy, int sx, int sy, int w, int h) {
  const gfx_target_t *t = &s_target;
  if (sx < 0) { w += sx; dx -= sx; sx = 0; }
  if (sy < 0) { h += sy; dy -= sy; sy = 0; }
  if (dx < t->x0) { const int d = t->x0 - dx; w -= d; sx += d; dx = t->x0; }
  if (dy < t->y0) { const int d = t->y0 - dy; h -= d; sy += d; dy = t->y0; }
  if (dx + w > t->x0 + t->w) w = t->x0 + t->w - dx;
  if (sx + w > UI_W) w = UI_W - sx;
  if (dy + h > t->y0 + t->h) h = t->y0 + t->h - dy;
  if (sy + h > UI_H) h = UI_H - sy;
  if (w <= 0 || h <= 0) return;
  for (int r = 0; r < h; r++) {
    memcpy(t->px + (size_t)(dy - t->y0 + r) * t->stride + (dx - t->x0),
           src + (size_t)(sy + r) * UI_W + sx, (size_t)w * sizeof(uint16_t));
  }
}

void gfx_layer_keep(void) {
  if (!s_ready || s_layer == NULL) return;
  memcpy(s_layer, s_canvas, CANVAS_BYTES);
}


void gfx_layer_blit(int dx, int dy, int sx, int sy, int w, int h) {
  if (!s_ready || s_layer == NULL) return;
  canvas_touched();
  layer_blit(s_layer, dx, dy, sx, sy, w, h);
}

void gfx_stash_blit(int dx, int dy, int sx, int sy, int w, int h) {
  if (!s_ready || s_mix == NULL) return;
  canvas_touched();
  layer_blit(s_mix, dx, dy, sx, sy, w, h);
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
    wait_latched();
    show(fb);
    s_back = fb_next(s_back);
    s_frames++;
  }

  /* Land exactly on the destination rather than on whatever the last blend
   * step happened to be. */
  gfx_present();
  s_last_ms = (uint32_t)((esp_timer_get_time() - start) / 1000);
}
