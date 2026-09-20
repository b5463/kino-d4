/**
 * KINO Twin's device screen: the P4 firmware's own ui.c, running in a browser.
 *
 * The Twin used to draw a sketch of the rear display in TypeScript. It was
 * written against firmware 0.4.0 and the camera moved on without it - a
 * launcher, SHOOT, LOOK, GALLERY, PHOTO, ROLL, SETTINGS and POWER, all drawn
 * by ui.c - so a Twin next to a camera showed a different product. A sketch
 * can be brought up to date; it cannot be kept there.
 *
 * So this is not a sketch. Like ../host_preview/preview.c it #includes ui.c
 * as a translation unit, which reaches its static drawing functions and its
 * module state without adding a single hook to the firmware. Around that it
 * provides what the browser can and the camera cannot:
 *
 *   - a virtual clock, because a module cannot sleep. kui_pass() takes the
 *     host's time, steps ui_pass() - the real loop body - once, and every
 *     frame the pass presents is recorded with the virtual time it was
 *     presented at. The page plays them back on that schedule, so the splash,
 *     a dissolve and a held button look the way they do on the panel;
 *   - a touch point, in logical landscape coordinates, converted to the panel
 *     space ui.c expects the controller to report;
 *   - the camera's state, pushed by the page from the simulated device: the
 *     config store, the gallery page and its tiles, the viewfinder frames,
 *     power, the card, the radio, the Roll and its queue, capture progress;
 *   - the way back: what the screens DO reaches the simulator through host
 *     imports - a shutter press, a setting written, a photograph deleted or
 *     starred, a restart. Nothing here fakes an outcome; the page reports the
 *     simulator's answer back through the setters and the screen redraws.
 *
 * Every stub below that is a "stand-in" in preview.c is a "surface" here:
 * the same signature, but the value comes from a setter with a sensible
 * default rather than a constant. The defaults are preview.c's, so a module
 * the page has not fed yet still draws a camera.
 *
 * Built by the Makefile beside this file into kino-ui.wasm; loaded by
 * apps/twin/src/display/firmwareUi.ts.
 */
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>

#include "buttons.h"
#include "cam_link.h"
#include "capture.h"
#include "clock.h"
#include "display.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "gallery.h"
#include "gfx.h"
#include "kdp_recipes.h"
#include "config_store.h"
#include "net_link.h"
#include "power.h"
#include "qr.h"
#include "roll_state.h"
#include "storage.h"
#include "touch.h"
#include "ui.h"
#include "upload_queue.h"
#include "viewfinder.h"
#include "wifi_creds.h"

/* ---- the host ---------------------------------------------------------- */

#define KUI_IMPORT(name) __attribute__((import_module("env"), import_name(name)))
#define KUI_EXPORT(name) __attribute__((export_name(name)))

/* level: 'E' 'W' 'I' from ESP_LOG*, 'K' from klog(). */
KUI_IMPORT("js_log") void js_log(int level, const char *s, int len);
/* The shutter. Returns 1 when the simulator accepted the request; capture
 * progress then arrives through kui_set_capture_*(). */
KUI_IMPORT("js_capture_request") int js_capture_request(const char *source);
/* A setting the screens wrote. kind: 0 string, 1 number, 2 bool. */
KUI_IMPORT("js_config_write") void js_config_write(const char *path, int kind, double num, const char *str);
KUI_IMPORT("js_config_save") void js_config_save(void);
KUI_IMPORT("js_restart") void js_restart(void);
KUI_IMPORT("js_delete_all") void js_delete_all(void);
KUI_IMPORT("js_capture_delete") void js_capture_delete(const char *id);
KUI_IMPORT("js_favorite_set") void js_favorite_set(const char *id, int fav);
/* The photograph screen wants the frames of `id` at w x h. The page decodes
 * them, writes each into kui_photo_frame_ptr(i) and calls
 * kui_photo_frames_done(gen, have_mask). */
KUI_IMPORT("js_frames_request") void js_frames_request(const char *id, int w, int h, unsigned gen);
/* The gallery asked for another page; the page refills the six slots. */
KUI_IMPORT("js_gallery_turn") void js_gallery_turn(int delta);
KUI_IMPORT("js_gallery_refresh") void js_gallery_refresh(void);
/* op: 0 scan, 1 connect(ssid), 2 disconnect. Returns what net_link returns. */
KUI_IMPORT("js_net") int js_net(int op, const char *arg);
KUI_IMPORT("js_queue_retry_all") int js_queue_retry_all(void);
/* kind: 0 ui tick, 1 shutter, 2 warning. */
KUI_IMPORT("js_audio") void js_audio(int kind);

/* ---- strings in and out ------------------------------------------------- */

/* The page writes UTF-8 into one of these before a call that takes a string,
 * so no allocation crosses the boundary. Eight, because one call (a gallery
 * slot) takes three strings and a queue report takes one more. */
#define KUI_SCRATCH_N 8
#define KUI_SCRATCH_CAP 512
static char s_scratch[KUI_SCRATCH_N][KUI_SCRATCH_CAP];

KUI_EXPORT("kui_scratch") char *kui_scratch(int i) {
  if (i < 0 || i >= KUI_SCRATCH_N) return s_scratch[0];
  return s_scratch[i];
}
KUI_EXPORT("kui_scratch_cap") int kui_scratch_cap(void) { return KUI_SCRATCH_CAP; }

#define COPY(dst, src) snprintf((dst), sizeof(dst), "%s", (src) ? (src) : "")

/* ---- logging ------------------------------------------------------------ */

void kui_log(char level, const char *tag, const char *fmt, ...) {
  char line[256];
  int n = snprintf(line, sizeof line, "%s: ", tag ? tag : "");
  va_list ap;
  va_start(ap, fmt);
  if (n < 0) n = 0;
  if ((size_t)n < sizeof line) n += vsnprintf(line + n, sizeof line - (size_t)n, fmt, ap);
  va_end(ap);
  if ((size_t)n > sizeof line - 1) n = (int)sizeof line - 1;
  js_log(level, line, n);
}

void klog(const char *src, const char *fmt, ...) {
  char line[256];
  int n = snprintf(line, sizeof line, "%s: ", src ? src : "");
  va_list ap;
  va_start(ap, fmt);
  if (n < 0) n = 0;
  if ((size_t)n < sizeof line) n += vsnprintf(line + n, sizeof line - (size_t)n, fmt, ap);
  va_end(ap);
  if ((size_t)n > sizeof line - 1) n = (int)sizeof line - 1;
  js_log('K', line, n);
}

/* ---- the clock and the frames ------------------------------------------- */

/* Read by the esp_timer shim. Set from the host at the start of each pass;
 * moved by delays and presents inside it. */
int64_t kui_now_us;
static int64_t s_pass_start_us;

/* What a present costs on the camera: a PPA rotate and a DPI handoff, in the
 * order of a panel refresh. It has to cost something here too, or a loop that
 * presents until the clock says stop (the splash bloom) would never stop. */
#define KUI_PRESENT_US 12000

#define KUI_FRAME_MAX 40
typedef struct {
  uint16_t *px; /* UI_W * UI_H, allocated on first use */
  int32_t at_ms; /* virtual time since the pass began */
} kui_frame_t;
static kui_frame_t s_frames[KUI_FRAME_MAX];
static int s_frame_count;
static uint32_t s_frames_presented;
static uint32_t s_last_present_ms;

static uint16_t *g_canvas;
static uint16_t *g_snapshot;
static uint16_t *g_blend;

static void push_frame(const uint16_t *px) {
  /* Full: keep the newest, drop the one before it. An animation longer than
   * the ring loses interior frames rather than its ending. */
  const int i = s_frame_count < KUI_FRAME_MAX ? s_frame_count++ : KUI_FRAME_MAX - 1;
  if (s_frames[i].px == NULL) s_frames[i].px = malloc((size_t)UI_W * UI_H * sizeof(uint16_t));
  if (s_frames[i].px == NULL) return;
  memcpy(s_frames[i].px, px, (size_t)UI_W * UI_H * sizeof(uint16_t));
  s_frames[i].at_ms = (int32_t)((kui_now_us - s_pass_start_us) / 1000);
}

void kui_delay_ms(uint32_t ms) { kui_now_us += (int64_t)ms * 1000; }

bool display_ready(void) { return true; }
void *display_panel(void) { return NULL; }

esp_err_t gfx_init(void) { return ESP_OK; }
bool gfx_ready(void) { return true; }
uint16_t *gfx_canvas(void) { return g_canvas; }
/* The whole canvas, always: the Twin presents whole frames in virtual time. */
static gfx_target_t g_target;
const gfx_target_t *gfx_target(void) {
  if (g_target.px != g_canvas) g_target = (gfx_target_t){g_canvas, 0, 0, UI_W, UI_H, UI_W};
  return &g_target;
}
void gfx_present(void) {
  push_frame(g_canvas);
  s_frames_presented++;
  s_last_present_ms = (uint32_t)KUI_PRESENT_US / 1000;
  kui_now_us += KUI_PRESENT_US;
}
void gfx_snapshot(void) { memcpy(g_snapshot, g_canvas, (size_t)UI_W * UI_H * sizeof(uint16_t)); }

/* How many frames a transition of `ms` is worth here.
 *
 * One per display refresh. The device runs its transitions off the clock and
 * emits as many frames as the compositor can manage; the Twin runs on a
 * virtual clock, so the number has to be chosen - and choosing anything other
 * than the refresh interval guarantees judder, because a frame that lasts
 * 1.4 refreshes is shown for one refresh and then two. */
static int tw_steps(int ms) {
  int n = (ms + 8) / 16;
  if (n < 4) n = 4;
  if (n > KUI_FRAME_MAX - 2) n = KUI_FRAME_MAX - 2;
  return n;
}

static inline uint16_t blend565(uint16_t a, uint16_t b, int t, int n) {
  const int ar = (a >> 11) & 31, ag = (a >> 5) & 63, ab = a & 31;
  const int br = (b >> 11) & 31, bg = (b >> 5) & 63, bb = b & 31;
  const int r = ar + ((br - ar) * t) / n;
  const int g = ag + ((bg - ag) * t) / n;
  const int bl = ab + ((bb - ab) * t) / n;
  return (uint16_t)((r << 11) | (g << 5) | bl);
}

/* The PPA eases between the snapshot and the canvas over `duration_ms`; here
 * a handful of blended frames on the virtual clock do the same. */
void gfx_dissolve(int duration_ms) {
  if (duration_ms <= 0) {
    gfx_present();
    return;
  }
  const int steps = duration_ms >= 200 ? 6 : 3;
  for (int k = 1; k < steps; k++) {
    for (int i = 0; i < UI_W * UI_H; i++) g_blend[i] = blend565(g_snapshot[i], g_canvas[i], k, steps);
    push_frame(g_blend);
    s_frames_presented++;
    kui_now_us += (int64_t)duration_ms * 1000 / steps;
  }
  gfx_present();
}
/*
 * The push. On the device the two frames are composited in landscape and
 * rotated per frame by the PPA; here there is no panel and no rotation, so it
 * is the same row-wise composite straight into the blend buffer.
 *
 * Kept frame-stepped like the dissolve above rather than time-stepped: the
 * Twin runs on a virtual clock, so "elapsed" is whatever this function says
 * it is, and a fixed step is the honest version of that.
 */
void gfx_slide(int duration_ms, bool from_right) {
  if (duration_ms <= 0) {
    gfx_present();
    return;
  }
  const int steps = tw_steps(duration_ms);
  for (int k = 1; k < steps; k++) {
    const float t = (float)k / (float)steps;
    const float u = 1.0f - t;
    const float e = 1.0f - u * u * u; /* out-cubic, as on the device */
    int o = (int)(e * (float)UI_W);
    if (o < 0) o = 0;
    if (o > UI_W) o = UI_W;
    for (int y = 0; y < UI_H; y++) {
      uint16_t *dst = g_blend + (size_t)y * UI_W;
      const uint16_t *old = g_snapshot + (size_t)y * UI_W;
      const uint16_t *new_ = g_canvas + (size_t)y * UI_W;
      if (from_right) {
        memcpy(dst, old + o, (size_t)(UI_W - o) * sizeof(uint16_t));
        memcpy(dst + (UI_W - o), new_, (size_t)o * sizeof(uint16_t));
      } else {
        memcpy(dst, new_ + (UI_W - o), (size_t)o * sizeof(uint16_t));
        memcpy(dst + o, old, (size_t)(UI_W - o) * sizeof(uint16_t));
      }
    }
    push_frame(g_blend);
    s_frames_presented++;
    kui_now_us += (int64_t)duration_ms * 1000 / steps;
  }
  gfx_present();
}

static inline float tw_settle(float t) {
  return t * t * t * (t * (t * 6.0f - 15.0f) + 10.0f);
}
static inline float tw_in(float t) { return t * t; }
static inline float tw_clamp01(float v) { return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v); }

static inline void tw_fill_rows(uint16_t *buf, int y, int h, uint16_t c) {
  uint16_t *p = buf + (size_t)y * UI_W;
  for (size_t i = (size_t)h * UI_W; i != 0; i--) *p++ = c;
}

/* The stash: the destination frame, kept while ui.c draws the move over it.
 * Same as the device's, into the blend buffer. */
void gfx_stash(void) { memcpy(g_blend, g_canvas, (size_t)UI_W * UI_H * sizeof(uint16_t)); }
/* A frame is one call of its drawing on the whole canvas, then the frame
 * goes out in virtual time as every other frame does. */
void gfx_render_canvas(gfx_draw_fn draw, void *ctx) { draw(ctx); }
void gfx_render(gfx_draw_fn draw, void *ctx) {
  draw(ctx);
  gfx_present();
}

void gfx_stash_blit(int dx, int dy, int sx, int sy, int w, int h) {
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
    memcpy(g_canvas + (size_t)(dy + r) * UI_W + dx, g_blend + (size_t)(sy + r) * UI_W + sx,
           (size_t)w * sizeof(uint16_t));
  }
}

/* The retained layer, same as the device's. Its own buffer: the blend buffer
 * is the stash and a transition uses both at once. */
static uint16_t g_layer_buf[UI_W * UI_H];
void gfx_layer_keep(void) {
  memcpy(g_layer_buf, g_canvas, (size_t)UI_W * UI_H * sizeof(uint16_t));
}
void gfx_layer_blit(int dx, int dy, int sx, int sy, int w, int h) {
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
    memcpy(g_canvas + (size_t)(dy + r) * UI_W + dx, g_layer_buf + (size_t)(sy + r) * UI_W + sx,
           (size_t)w * sizeof(uint16_t));
  }
}

/* The cascade. Same stagger as the device's gfx_cascade(). */
void gfx_cascade(int duration_ms, const gfx_band_t *bands, int n, uint16_t ground) {
  if (duration_ms <= 0 || bands == NULL || n <= 0) {
    gfx_present();
    return;
  }
  const float travel = 0.5f;
  const float step = n > 1 ? (1.0f - travel) / (float)(n - 1) : 0.0f;
  const int steps = tw_steps(duration_ms);

  for (int k = 0; k < steps; k++) {
    const float t = (float)k / (float)steps;
    memcpy(g_blend, g_canvas, (size_t)UI_W * UI_H * sizeof(uint16_t));
    for (int i = 0; i < n; i++) {
      float local = (t - step * (float)i) / travel;
      if (local >= 1.0f) continue;
      if (local < 0.0f) local = 0.0f;
      const int x = bands[i].x, w = bands[i].w;
      int o = (int)((1.0f - tw_settle(local)) * (float)(UI_W - x));
      if (o < 0) o = 0;
      if (o > w) o = w;
      for (int y = bands[i].y; y < bands[i].y + bands[i].h && y < UI_H; y++) {
        uint16_t *dst = g_blend + (size_t)y * UI_W + x;
        const uint16_t *src = g_canvas + (size_t)y * UI_W + x;
        for (int j = 0; j < o; j++) dst[j] = ground;
        memcpy(dst + o, src, (size_t)(w - o) * sizeof(uint16_t));
      }
    }
    push_frame(g_blend);
    s_frames_presented++;
    kui_now_us += (int64_t)duration_ms * 1000 / steps;
  }
  gfx_present();
}

void gfx_stats(uint32_t *f, uint32_t *ms) {
  if (f) *f = s_frames_presented;
  if (ms) *ms = s_last_present_ms;
}
/* The Twin presents in zero virtual time; a move's report attributes it all
 * to drawing, which is the honest reading of a harness with no panel. */
uint64_t gfx_present_us_total(void) { return 0; }
void gfx_pass_split(uint64_t *d, uint64_t *x, uint64_t *v) {
  if (d) *d = 0;
  if (x) *x = 0;
  if (v) *v = 0;
}

void taskmon_register(const char *name, void *handle) {
  (void)name;
  (void)handle;
}

/* ---- a real queue for the physical keys --------------------------------- */

struct kui_queue {
  uint32_t len, item, head, count;
  uint8_t buf[8 * 16];
};
static struct kui_queue s_queue;

QueueHandle_t kui_queue_create(uint32_t len, uint32_t item_size) {
  if (len > 8) len = 8;
  if (item_size > 16) return NULL;
  s_queue.len = len;
  s_queue.item = item_size;
  s_queue.head = s_queue.count = 0;
  return &s_queue;
}
BaseType_t kui_queue_send(QueueHandle_t q, const void *item) {
  if (q == NULL || q->count >= q->len) return pdFALSE;
  const uint32_t tail = (q->head + q->count) % q->len;
  memcpy(q->buf + tail * q->item, item, q->item);
  q->count++;
  return pdTRUE;
}
BaseType_t kui_queue_receive(QueueHandle_t q, void *out) {
  if (q == NULL || q->count == 0) return pdFALSE;
  memcpy(out, q->buf + q->head * q->item, q->item);
  q->head = (q->head + 1) % q->len;
  q->count--;
  return pdTRUE;
}
uint32_t kui_queue_waiting(QueueHandle_t q) { return q == NULL ? 0 : q->count; }

/* ---- audio --------------------------------------------------------------- */

static bool g_audio_ready = true;
esp_err_t audio_init(void) { return ESP_OK; }
bool audio_ready(void) { return g_audio_ready; }
void audio_shutter(void) { js_audio(1); }
void audio_tick(void) { js_audio(0); }
void audio_warning(void) { js_audio(2); }
void audio_sync(void) { js_audio(3); }
void audio_done(void) { js_audio(4); }
KUI_EXPORT("kui_set_audio_ready") void kui_set_audio_ready(int ready) { g_audio_ready = ready != 0; }

/* ---- touch --------------------------------------------------------------- */

static bool s_touch_down;
static int s_touch_lx, s_touch_ly;
static uint32_t s_touch_count;

esp_err_t touch_init(void) { return ESP_OK; }
bool touch_ready(void) { return true; }
/* ui.c undoes the panel's quarter turn: lx = ty, ly = DISPLAY_H_RES - 1 - tx.
 * So a logical point goes in the other way round. */
bool touch_get(uint16_t *x, uint16_t *y) {
  if (!s_touch_down) return false;
  if (x) *x = (uint16_t)(DISPLAY_H_RES - 1 - s_touch_ly);
  if (y) *y = (uint16_t)s_touch_lx;
  return true;
}
uint32_t touch_count(void) { return s_touch_count; }

/* ---- the config store ---------------------------------------------------- */

/* Dotted paths to strings, as the page flattens the simulator's config
 * document. Numbers and booleans are parsed on the way out, which is how
 * config_int()/config_bool() read the real store's JSON too. */
typedef struct {
  char key[64];
  char val[96];
} kv_t;
#define KV_MAX 192
static kv_t s_kv[KV_MAX];
static int s_kv_n;

static const char *kv_get(const char *k) {
  for (int i = 0; i < s_kv_n; i++)
    if (strcmp(s_kv[i].key, k) == 0) return s_kv[i].val;
  return NULL;
}
static void kv_set(const char *k, const char *v) {
  for (int i = 0; i < s_kv_n; i++) {
    if (strcmp(s_kv[i].key, k) == 0) {
      COPY(s_kv[i].val, v);
      return;
    }
  }
  if (s_kv_n >= KV_MAX) return;
  COPY(s_kv[s_kv_n].key, k);
  COPY(s_kv[s_kv_n].val, v);
  s_kv_n++;
}

KUI_EXPORT("kui_cfg_clear") void kui_cfg_clear(void) { s_kv_n = 0; }
KUI_EXPORT("kui_cfg_set") void kui_cfg_set(const char *key, const char *val) { kv_set(key, val); }

int config_int(const char *path, int fallback) {
  const char *v = kv_get(path);
  if (v == NULL || *v == '\0') return fallback;
  if (strcmp(v, "true") == 0) return 1;
  if (strcmp(v, "false") == 0) return 0;
  return atoi(v);
}
bool config_bool(const char *path, bool fallback) {
  const char *v = kv_get(path);
  if (v == NULL || *v == '\0') return fallback;
  return strcmp(v, "true") == 0 || strcmp(v, "1") == 0;
}
const char *config_str(const char *path, const char *fallback) {
  const char *v = kv_get(path);
  return v ? v : fallback;
}
size_t config_str_copy(const char *path, char *out, size_t cap) {
  const char *v = config_str(path, "");
  snprintf(out, cap, "%s", v);
  return strlen(v);
}

/*
 * The write path. ui.c builds a one-leaf patch with cJSON, hangs it under its
 * dotted path with meta_patch_path(), merges and saves. Neither cJSON nor
 * meta.c is here, so the leaf is a record of what was created and
 * meta_patch_path() is where the value and its path meet - that is the
 * moment to hand it to the simulator, and to update the local store so the
 * screen that wrote it reads it back on its next draw without a round trip.
 */
struct cJSON {
  int kind; /* 0 string, 1 number, 2 bool */
  double num;
  char str[96];
};
static cJSON s_json_pool[8];
static int s_json_next;

static cJSON *json_slot(void) {
  cJSON *j = &s_json_pool[s_json_next++ % 8];
  memset(j, 0, sizeof *j);
  return j;
}
cJSON *cJSON_CreateObject(void) { return json_slot(); }
cJSON *cJSON_CreateString(const char *s) {
  cJSON *j = json_slot();
  j->kind = 0;
  COPY(j->str, s);
  return j;
}
cJSON *cJSON_CreateNumber(double v) {
  cJSON *j = json_slot();
  j->kind = 1;
  j->num = v;
  return j;
}
cJSON *cJSON_CreateBool(bool v) {
  cJSON *j = json_slot();
  j->kind = 2;
  j->num = v ? 1 : 0;
  return j;
}
void cJSON_AddItemToObject(cJSON *obj, const char *key, cJSON *item) {
  (void)obj;
  (void)key;
  (void)item;
}
void cJSON_Delete(cJSON *item) { (void)item; }

void *meta_patch_path(const char *dotted, void *leaf);
void *meta_patch_path(const char *dotted, void *leaf) {
  const cJSON *j = leaf;
  if (dotted != NULL && j != NULL) {
    char text[96];
    if (j->kind == 0) snprintf(text, sizeof text, "%s", j->str);
    else if (j->kind == 2) snprintf(text, sizeof text, "%s", j->num != 0 ? "true" : "false");
    else if (j->num == (double)(long)j->num) snprintf(text, sizeof text, "%ld", (long)j->num);
    else snprintf(text, sizeof text, "%g", j->num);
    kv_set(dotted, text);
    js_config_write(dotted, j->kind, j->num, j->kind == 0 ? j->str : "");
  }
  return leaf;
}
esp_err_t config_merge(const cJSON *patch) {
  (void)patch;
  return ESP_OK;
}
esp_err_t config_save(void) {
  js_config_save();
  return ESP_OK;
}

void esp_restart(void) { js_restart(); }

/* ---- identity ------------------------------------------------------------ */

static char s_serial[24] = "KD4-SIM-0001";
const char *kdp_device_serial(void) { return s_serial; }
KUI_EXPORT("kui_set_serial") void kui_set_serial(const char *s) { COPY(s_serial, s); }

/* ---- looks and sounds ---------------------------------------------------- */

typedef struct {
  char id[49];
  char name[48];
} named_t;
#define LOOKS_MAX 32
static named_t s_looks[LOOKS_MAX] = {
    {"party-neg", "Party Neg"}, {"chrome", "Chrome"},       {"superia", "Superia"},
    {"vivid", "Vivid"},         {"mono", "Mono"},           {"motion", "Motion"},
    {"flash-digi", "Flash Digi"}, {"warm-2007", "Warm 2007"}, {"cold-flash", "Cold Flash"},
    {"disposable", "Disposable"}, {"raw-digi", "Raw Digi"},
};
static int s_looks_n = 11;

KUI_EXPORT("kui_looks_clear") void kui_looks_clear(void) { s_looks_n = 0; }
KUI_EXPORT("kui_look_add") void kui_look_add(const char *id, const char *name) {
  if (s_looks_n >= LOOKS_MAX) return;
  COPY(s_looks[s_looks_n].id, id);
  COPY(s_looks[s_looks_n].name, name);
  s_looks_n++;
}

int kdp_recipes_count(void) { return s_looks_n; }
bool kdp_recipes_name(int index, char *id, size_t id_cap, char *name, size_t name_cap) {
  if (index < 0 || index >= s_looks_n) return false;
  if (id && id_cap) snprintf(id, id_cap, "%s", s_looks[index].id);
  if (name && name_cap) snprintf(name, name_cap, "%s", s_looks[index].name);
  return true;
}
/* The detail strip's numbers. The simulator's recipes carry the same block;
 * until the page pushes it per look this is preview.c's plausible set, and
 * the strip is labelled by the look it belongs to either way. */
bool kdp_recipes_capture_block(const char *id, recipe_capture_t *out) {
  if (out == NULL || id == NULL) return false;
  memset(out, 0, sizeof *out);
  if (strcmp(id, "raw-digi") == 0) return false;
  snprintf(out->resolution, sizeof out->resolution, "2048x1536");
  out->has_resolution = true;
  out->jpeg_quality_percent = 88;
  out->has_jpeg_quality = true;
  out->exposure_bias = -0.7;
  out->has_exposure_bias = true;
  out->gain_limit = 16;
  out->has_gain_limit = true;
  out->denoise = 2;
  out->has_denoise = true;
  out->sharpness = 3;
  out->has_sharpness = true;
  return true;
}

static named_t s_clips[8] = {{"snd-air-horn", "Air horn"}, {"snd-polaroid", "Polaroid"}};
static int s_clips_n = 2;
KUI_EXPORT("kui_sounds_clear") void kui_sounds_clear(void) { s_clips_n = 0; }
KUI_EXPORT("kui_sound_add") void kui_sound_add(const char *id, const char *name) {
  if (s_clips_n >= 8) return;
  COPY(s_clips[s_clips_n].id, id);
  COPY(s_clips[s_clips_n].name, name);
  s_clips_n++;
}
int kdp_sounds_count(void) { return s_clips_n; }
bool kdp_sounds_info(int index, char *id, size_t id_cap, char *name, size_t name_cap) {
  if (index < 0 || index >= s_clips_n) return false;
  if (id && id_cap) snprintf(id, id_cap, "%s", s_clips[index].id);
  if (name && name_cap) snprintf(name, name_cap, "%s", s_clips[index].name);
  return true;
}

/* ---- viewfinder ---------------------------------------------------------- */

/* Four RGB565 tiles the page fills from the virtual sensors. A tile the page
 * has never written is not a picture, so the pane says NO CAMERA until the
 * first frame lands - the same thing a node that has not answered shows.
 *
 * And a tile the page STOPPED writing is not a picture either. The real
 * driver ages its frames (viewfinder.c, VF_STALE_MS): a pane whose newest
 * frame is older than two seconds reads NO RECENT FRAME and drops out of the
 * strip's live count. This shim marked a pane live for ever once its pointer
 * had been asked for, which is how the Twin showed four black panes under a
 * 4/4 - the preview timer stops with a hidden tab, and nothing here noticed.
 * The page now says when a frame has landed (kui_vf_landed), and the same
 * two-second rule applies on the virtual clock. */
static uint16_t g_vf[4][VF_W * VF_H];
static int64_t g_vf_at_us[4]; /* when the newest frame landed; 0 = never */
static unsigned g_vf_dead;
static bool g_vf_wanted;
#define TWIN_VF_STALE_MS 2000

KUI_EXPORT("kui_vf_ptr") uint16_t *kui_vf_ptr(int cam) {
  if (cam < 0 || cam >= 4) return NULL;
  return g_vf[cam];
}
/* The page has written the tiles in `mask`. Stamps them on the virtual clock. */
KUI_EXPORT("kui_vf_landed") void kui_vf_landed(unsigned mask) {
  for (int cam = 0; cam < 4; cam++) {
    if (mask & (1u << cam)) g_vf_at_us[cam] = kui_now_us > 0 ? kui_now_us : 1;
  }
}
KUI_EXPORT("kui_set_vf_dead") void kui_set_vf_dead(unsigned mask) { g_vf_dead = mask & 0xf; }
/* True while the SHOOT screen is up, so the page renders previews only then -
 * the nodes on the camera are asked for frames only then too. */
KUI_EXPORT("kui_vf_wanted") int kui_vf_wanted(void) { return g_vf_wanted; }

static uint32_t vf_age_ms(int cam) {
  if (g_vf_at_us[cam] == 0) return UINT32_MAX;
  const int64_t age = kui_now_us - g_vf_at_us[cam];
  return age < 0 ? 0 : (uint32_t)(age / 1000);
}

esp_err_t viewfinder_init(void) { return ESP_OK; }
bool viewfinder_ready(void) { return true; }
void viewfinder_run(bool on) { g_vf_wanted = on; }
const uint16_t *viewfinder_tile(int cam) {
  if (cam < 0 || cam >= 4) return NULL;
  if (g_vf_dead & (1u << cam)) return NULL;
  if (vf_age_ms(cam) > TWIN_VF_STALE_MS) return NULL;
  return g_vf[cam];
}
void viewfinder_status(int cam, vf_status_t *out) {
  if (out == NULL) return;
  memset(out, 0, sizeof *out);
  if (cam < 0 || cam >= 4 || (g_vf_dead & (1u << cam)) || g_vf_at_us[cam] == 0) {
    out->state = VF_NO_LINK;
    return;
  }
  const uint32_t age = vf_age_ms(cam);
  const bool live = age <= TWIN_VF_STALE_MS;
  out->state = live ? VF_LIVE : VF_STALLED;
  out->frames = 120;
  out->last_ms = age;
  out->bytes = live ? 9200 : 0;
  out->fps_x10 = live ? 165 : 0;
}

/* ---- physical keys ------------------------------------------------------- */

static button_handler_t s_button_handler;
void buttons_on_press(button_handler_t handler) { s_button_handler = handler; }
esp_err_t buttons_init(void) { return ESP_OK; }
bool buttons_fitted(void) { return true; }
static bool s_shutter_held;
bool button_held(button_id_t id) { return id == BTN_SHUTTER && s_shutter_held; }
/* The panel's SHUTTER button, through the same queue the buttons task feeds. */
KUI_EXPORT("kui_button") void kui_button(int id, int long_press) {
  if (s_button_handler) s_button_handler((button_id_t)id, long_press != 0);
}
KUI_EXPORT("kui_set_shutter_held") void kui_set_shutter_held(int held) { s_shutter_held = held != 0; }

/* ---- capture ------------------------------------------------------------- */

static capture_stage_t g_stage = CAPTURE_IDLE;
static capture_report_t g_report;
static uint32_t g_capture_count;

bool capture_request(const char *source) { return js_capture_request(source ? source : "shutter") != 0; }
/* The wall clock's hour, as the page knows it; -1 is an unset clock. */
static int g_local_hour = -1;
int clock_local_hour(void) { return g_local_hour; }
KUI_EXPORT("kui_set_local_hour") void kui_set_local_hour(int hour) { g_local_hour = hour; }
/* Nothing has told this body what day it is. The page knows the hour and
 * passes it in for the behaviours that care about evening, but there is no
 * host clock behind the Twin, so the camera reports exactly that - which is
 * the state a body is in until Studio sets it. */
clock_source_t clock_source(void) { return CLOCK_UNSET; }
void clock_iso8601(char *out, size_t cap) { snprintf(out, cap, "1970-01-01T00:00:00+00:00"); }

static uint32_t g_asked_mask, g_frames_in;
uint32_t capture_asked_cams(void) { return g_asked_mask; }
uint32_t capture_frames_in(void) { return g_frames_in; }
/** Which cameras the running capture asked and which have delivered so far, bit 0 = CAM1. */
KUI_EXPORT("kui_set_capture_frames") void kui_set_capture_frames(unsigned asked, unsigned in) {
  g_asked_mask = asked;
  g_frames_in = in;
}
capture_stage_t capture_stage(void) { return g_stage; }
void capture_ack(void) { g_stage = CAPTURE_IDLE; }
bool capture_busy(void) { return g_stage != CAPTURE_IDLE && g_stage != CAPTURE_DONE; }
void capture_last(capture_report_t *out) {
  if (out) *out = g_report;
}
uint32_t capture_count(void) { return g_capture_count; }

KUI_EXPORT("kui_set_capture_stage") void kui_set_capture_stage(int stage) { g_stage = (capture_stage_t)stage; }
KUI_EXPORT("kui_set_capture_count") void kui_set_capture_count(unsigned n) { g_capture_count = n; }
KUI_EXPORT("kui_set_capture_report")
void kui_set_capture_report(int ok, const char *id, int stored, int online, unsigned bytes, unsigned total_ms,
                            const char *err_code) {
  memset(&g_report, 0, sizeof g_report);
  g_report.ok = ok != 0;
  COPY(g_report.id, id);
  g_report.stored = stored;
  g_report.online = online;
  g_report.bytes = bytes;
  g_report.total_ms = total_ms;
  COPY(g_report.err_code, err_code);
}

/* ---- gallery ------------------------------------------------------------- */

static uint16_t g_tile[GALLERY_PAGE][GALLERY_TILE_W * GALLERY_TILE_H];
static gallery_item_t g_slot[GALLERY_PAGE];
static int g_total, g_page = 1, g_pages = 1;
static bool g_loading, g_deleting;
static int g_delete_done, g_delete_total;

esp_err_t gallery_init(void) { return ESP_OK; }
void gallery_refresh(void) { js_gallery_refresh(); }
int gallery_total(void) { return g_total; }
int gallery_media_count(void) { return g_total; }
int gallery_page(void) { return g_page; }
int gallery_pages(void) { return g_pages; }
void gallery_turn(int delta) { js_gallery_turn(delta); }
const gallery_item_t *gallery_slots(void) { return g_slot; }
bool gallery_loading(void) { return g_loading; }
void gallery_note_added(const char *id, uint64_t when) {
  (void)id;
  (void)when;
}
void gallery_note_removed(const char *id) { js_capture_delete(id); }
int gallery_scan_progress(void) { return 0; }
void gallery_delete_all(void) { js_delete_all(); }
bool gallery_deleting(void) { return g_deleting; }
void gallery_delete_progress(int *done, int *total) {
  if (done) *done = g_delete_done;
  if (total) *total = g_delete_total;
}

KUI_EXPORT("kui_gallery_set") void kui_gallery_set(int total, int page, int pages, int loading) {
  g_total = total;
  g_page = page;
  g_pages = pages;
  g_loading = loading != 0;
}
KUI_EXPORT("kui_gallery_deleting") void kui_gallery_deleting(int deleting, int done, int total) {
  g_deleting = deleting != 0;
  g_delete_done = done;
  g_delete_total = total;
}
/* state: 0 empty, 1 pending, 2 ready (pixels are in kui_gallery_tile_ptr(i)),
 * 3 no image. */
KUI_EXPORT("kui_gallery_slot")
void kui_gallery_slot(int i, const char *id, const char *label, const char *mode, int frames, int partial,
                      int favorite, int state) {
  if (i < 0 || i >= GALLERY_PAGE) return;
  gallery_item_t *it = &g_slot[i];
  memset(it, 0, sizeof *it);
  COPY(it->id, id);
  COPY(it->label, label);
  COPY(it->mode, mode);
  it->frames = frames;
  it->partial = partial != 0;
  it->favorite = favorite != 0;
  it->state = (tile_state_t)state;
  it->pixels = state == TILE_READY ? g_tile[i] : NULL;
}
KUI_EXPORT("kui_gallery_tile_ptr") uint16_t *kui_gallery_tile_ptr(int i) {
  if (i < 0 || i >= GALLERY_PAGE) return NULL;
  return g_tile[i];
}

/* The photograph's frames: asked of the page, answered when decoded. The
 * calibration offsets the device applies as a PPA crop are not applied here;
 * the Twin's calibration is neutral and the page hands over the frame it
 * has. */
static uint16_t *g_frame[GALLERY_FRAME_MAX];
static int g_frame_w, g_frame_h;
static uint32_t g_frame_gen;
static uint32_t g_frame_have;
static bool g_frame_done;

esp_err_t gallery_frames_begin(const char *id, int w, int h, uint16_t pad, const pure_cam_offset_t *offsets,
                               uint32_t *gen) {
  (void)offsets;
  if (w <= 0 || h <= 0 || w > GALLERY_FRAME_MAX_W || h > GALLERY_FRAME_MAX_H) return ESP_ERR_INVALID_ARG;
  for (int i = 0; i < GALLERY_FRAME_MAX; i++) {
    if (g_frame[i] == NULL || g_frame_w != w || g_frame_h != h) {
      free(g_frame[i]);
      g_frame[i] = malloc((size_t)w * (size_t)h * sizeof(uint16_t));
      if (g_frame[i] == NULL) return ESP_ERR_NO_MEM;
    }
    for (int p = 0; p < w * h; p++) g_frame[i][p] = pad;
  }
  g_frame_w = w;
  g_frame_h = h;
  g_frame_gen++;
  g_frame_have = 0;
  g_frame_done = false;
  if (gen) *gen = g_frame_gen;
  js_frames_request(id, w, h, g_frame_gen);
  return ESP_OK;
}
void gallery_frames_cancel(void) { g_frame_gen++; }
bool gallery_frames_state(uint32_t gen, uint32_t *have, bool *done) {
  if (gen != g_frame_gen || g_frame_gen == 0) return false;
  if (have) *have = g_frame_have;
  if (done) *done = g_frame_done;
  return true;
}
const uint16_t *gallery_frame_pixels(int index) {
  if (index < 0 || index >= GALLERY_FRAME_MAX) return NULL;
  return g_frame[index];
}
KUI_EXPORT("kui_photo_frame_ptr") uint16_t *kui_photo_frame_ptr(int i, unsigned gen) {
  if (gen != g_frame_gen || i < 0 || i >= GALLERY_FRAME_MAX) return NULL;
  return g_frame[i];
}
KUI_EXPORT("kui_photo_frames_done") void kui_photo_frames_done(unsigned gen, unsigned have) {
  if (gen != g_frame_gen) return;
  g_frame_have = have & 0xf;
  g_frame_done = true;
}

/* No card to decode from: the still comes from the frames above, which is
 * also how the photograph plays. */
esp_err_t thumb_load(const char *path, uint16_t *tile, int tile_w, int tile_h, uint16_t pad) {
  (void)path;
  (void)tile;
  (void)tile_w;
  (void)tile_h;
  (void)pad;
  return ESP_FAIL;
}
/* Handled by id in gallery_note_removed(), which ui.c calls next. */
void storage_capture_delete(const char *dir) { (void)dir; }

bool storage_acquire(storage_user_t user, int timeout_ms) {
  (void)user;
  (void)timeout_ms;
  return true;
}
void storage_release(storage_user_t user) { (void)user; }

esp_err_t media_favorite_set(const char *id, bool fav) {
  js_favorite_set(id, fav ? 1 : 0);
  for (int i = 0; i < GALLERY_PAGE; i++)
    if (strcmp(g_slot[i].id, id) == 0) g_slot[i].favorite = fav;
  return ESP_OK;
}
bool media_favorite_get(const char *id) {
  for (int i = 0; i < GALLERY_PAGE; i++)
    if (strcmp(g_slot[i].id, id) == 0) return g_slot[i].favorite;
  return false;
}

/* ---- power --------------------------------------------------------------- */

static power_state_t g_power = {.stage = POWER_AWAKE, .idle_s = 0, .display_on = true, .cam_bank_on = true,
                                .usb_attached = false};
void power_activity(void) {}
void power_wake(void) {}
bool power_wake_gesture(void) { return false; }
void power_end_wake_gesture(void) {}
/* The Twin's power model sleeps without the hand-over; the mark is a device
 * behaviour to add to the shim when the stage machine is modelled here. */
bool power_sleep_pending(void) { return false; }
void power_sleep_shown(void) {}
void power_get(power_state_t *out) {
  if (out) *out = g_power;
}
KUI_EXPORT("kui_set_power") void kui_set_power(int stage, unsigned idle_s, int display_on, int cam_bank_on, int usb) {
  g_power.stage = (power_stage_t)stage;
  g_power.idle_s = idle_s;
  g_power.display_on = display_on != 0;
  g_power.cam_bank_on = cam_bank_on != 0;
  g_power.usb_attached = usb != 0;
}

/* ---- the camera nodes ---------------------------------------------------- */

static camlink_info_t g_cam[4];
static bool g_cam_set;

static void cam_defaults(void) {
  for (int i = 0; i < 4; i++) {
    memset(&g_cam[i], 0, sizeof g_cam[i]);
    g_cam[i].temp_c = CAMLINK_TEMP_UNKNOWN;
    g_cam[i].chip_revision = -1;
    g_cam[i].heap_kb = g_cam[i].psram_kb = -1;
  }
}
void camlink_get_info(camlink_info_t *out) {
  if (out == NULL) return;
  for (int i = 0; i < 4; i++) {
    if (g_cam[i].online) {
      *out = g_cam[i];
      return;
    }
  }
  *out = g_cam[0];
}
void camlink_get_info_ch(int cam, camlink_info_t *out) {
  if (out == NULL) return;
  if (cam < 0 || cam >= 4) {
    memset(out, 0, sizeof *out);
    return;
  }
  *out = g_cam[cam];
}
KUI_EXPORT("kui_set_cam")
void kui_set_cam(int cam, int online, const char *fw, const char *sensor, int temp_c, unsigned latency_ms) {
  if (cam < 0 || cam >= 4) return;
  g_cam_set = true;
  camlink_info_t *c = &g_cam[cam];
  c->online = online != 0;
  COPY(c->firmware, fw);
  COPY(c->sensor, sensor);
  c->sensor_detected = c->sensor[0] != '\0';
  c->temp_c = temp_c;
  c->latency_ms = latency_ms;
}

/* ---- the card ------------------------------------------------------------ */

static storage_status_t g_storage = {.present = true, .mounted = true, .filesystem = "FAT",
                                     .capacity_bytes = 31914983424ULL, .free_bytes = 30648041472ULL,
                                     .write_test = "pass"};
static char g_storage_error[32];
void storage_get_status(storage_status_t *out) {
  if (out) *out = g_storage;
}
KUI_EXPORT("kui_set_storage")
void kui_set_storage(int present, int mounted, double capacity_bytes, double free_bytes, const char *last_error) {
  memset(&g_storage, 0, sizeof g_storage);
  g_storage.present = present != 0;
  g_storage.mounted = mounted != 0;
  g_storage.filesystem = g_storage.mounted ? "FAT" : NULL;
  g_storage.capacity_bytes = capacity_bytes > 0 ? (uint64_t)capacity_bytes : 0;
  g_storage.free_bytes = free_bytes > 0 ? (uint64_t)free_bytes : 0;
  COPY(g_storage_error, last_error);
  g_storage.last_error = g_storage_error[0] ? g_storage_error : NULL;
  g_storage.mount_attempts = g_storage.mounted ? 1 : 3;
  g_storage.write_test = g_storage.mounted ? "pass" : "none";
}

/* ---- the radio ----------------------------------------------------------- */

static net_status_t g_net = {.state = NET_C6_NOT_ROUTED, .reason = NET_REASON_TRANSPORT_UNKNOWN,
                             .radio_fitted = true, .radio_routed = false};
static size_t g_saved_networks;

void net_link_init(int64_t now_ms) { (void)now_ms; }
void net_link_status(net_status_t *out, int64_t now_ms) {
  (void)now_ms;
  if (out) *out = g_net;
}
bool net_link_can_upload(const net_status_t *status) { return status != NULL && status->state == NET_IP_READY; }
bool net_link_scan_start(int64_t now_ms) {
  (void)now_ms;
  return js_net(0, "") != 0;
}
size_t net_link_scan_results(net_scan_entry_t *out, size_t cap) {
  (void)out;
  (void)cap;
  return 0;
}
bool net_link_connect(const char *ssid, int64_t now_ms) {
  (void)now_ms;
  return js_net(1, ssid ? ssid : "") != 0;
}
bool net_link_disconnect(int64_t now_ms) {
  (void)now_ms;
  return js_net(2, "") != 0;
}
KUI_EXPORT("kui_set_net")
void kui_set_net(int state, int reason, int routed, const char *ssid, const char *ip, int rssi, int channel,
                 int saved_networks) {
  memset(&g_net, 0, sizeof g_net);
  g_net.state = (net_state_t)state;
  g_net.reason = (net_reason_t)reason;
  g_net.radio_fitted = true;
  g_net.radio_routed = routed != 0;
  g_net.c6_present = routed != 0;
  COPY(g_net.ssid, ssid);
  COPY(g_net.ip, ip);
  g_net.rssi = rssi;
  g_net.channel = channel;
  if (state == NET_C6_NOT_ROUTED)
    snprintf(g_net.detail, sizeof g_net.detail, "no P4-C6 transport routing recorded; see firmware/C6_HARDWARE_MAP.md");
  g_saved_networks = saved_networks < 0 ? 0 : (size_t)saved_networks;
}

esp_err_t wifi_creds_init(void) { return ESP_OK; }
size_t wifi_creds_count(void) { return g_saved_networks; }
size_t wifi_creds_list(wifi_cred_view_t *out, size_t cap) {
  (void)out;
  (void)cap;
  return 0;
}
bool wifi_creds_has_password(const char *ssid) {
  (void)ssid;
  return false;
}

/* ---- the Roll and its queue ---------------------------------------------- */

static bool g_roll_active;
static roll_state_t g_roll;
static upload_queue_report_t g_queue;

esp_err_t roll_state_init(void) { return ESP_OK; }
bool roll_state_active(void) { return g_roll_active; }
bool roll_state_get(roll_state_t *out) {
  if (out == NULL) return g_roll_active;
  if (!g_roll_active) {
    memset(out, 0, sizeof *out);
    return false;
  }
  *out = g_roll;
  return true;
}
const char *roll_role_name(roll_role_t role) { return role == ROLL_ROLE_HOST ? "host" : "guest"; }
bool roll_state_has_credential(void) { return g_roll_active; }

KUI_EXPORT("kui_set_roll")
void kui_set_roll(int active, const char *roll_id, const char *slug, const char *guest_url, const char *name, int role,
                  double joined_at_ms) {
  g_roll_active = active != 0;
  memset(&g_roll, 0, sizeof g_roll);
  COPY(g_roll.roll_id, roll_id);
  COPY(g_roll.slug, slug);
  COPY(g_roll.guest_url, guest_url);
  COPY(g_roll.name, name);
  g_roll.role = role == 1 ? ROLL_ROLE_GUEST : ROLL_ROLE_HOST;
  g_roll.joined_at_ms = (int64_t)joined_at_ms;
}

esp_err_t upload_queue_start(void) { return ESP_OK; }
esp_err_t upload_queue_enqueue(const char *uuid, bool thumb) {
  (void)uuid;
  (void)thumb;
  return ESP_OK;
}
void upload_queue_forget(const char *capture_uuid) { (void)capture_uuid; }
void upload_queue_status(upload_queue_report_t *out) {
  if (out) *out = g_queue;
}
int upload_queue_retry_all(void) { return js_queue_retry_all(); }

/* server_state: 0 unknown, 1 reachable, 2 unreachable. last_upload_ms is on
 * the virtual clock's scale (esp_timer ms), which the page derives from the
 * age it knows. */
KUI_EXPORT("kui_set_queue")
void kui_set_queue(int pending, int uploading, int failed, int uploaded, int scan_complete, int draining, int halted,
                   int server_state, double last_upload_ms, int burst_done, const char *last_error) {
  memset(&g_queue, 0, sizeof g_queue);
  g_queue.pending = pending;
  g_queue.uploading = uploading;
  g_queue.failed = failed;
  g_queue.uploaded = uploaded;
  g_queue.scan_complete = scan_complete != 0;
  g_queue.draining = draining != 0;
  g_queue.halted = halted != 0;
  g_queue.server_state = (upload_server_state_t)server_state;
  g_queue.last_upload_ms = (int64_t)last_upload_ms;
  g_queue.burst_done = burst_done;
  COPY(g_queue.last_error, last_error);
}

/* ---- the firmware itself -------------------------------------------------- */

#include "ui.c"

/* ---- the harness ----------------------------------------------------------- */

static bool s_ready;
static uint8_t *g_rgba;

/** Allocate the canvas and point ui.c at it. */
KUI_EXPORT("kui_init") int kui_init(void) {
  if (!s_ready) {
    g_canvas = calloc((size_t)UI_W * UI_H, sizeof(uint16_t));
    g_snapshot = calloc((size_t)UI_W * UI_H, sizeof(uint16_t));
    g_blend = calloc((size_t)UI_W * UI_H, sizeof(uint16_t));
    g_rgba = calloc((size_t)UI_W * UI_H, 4);
    if (!g_canvas || !g_snapshot || !g_blend || !g_rgba) return -1;
    cam_defaults();
    s_ready = true;
  }
  /* What ui_start() does before it creates the task. */
  s_btn_q = xQueueCreate(4, sizeof(btn_event_t));
  buttons_on_press(on_button);
  return 0;
}

/** The boot: splash, then the menu dissolving in. Frames are in the ring. */
KUI_EXPORT("kui_boot") void kui_boot(double now_ms) {
  kui_now_us = (int64_t)(now_ms * 1000.0);
  s_pass_start_us = kui_now_us;
  s_frame_count = 0;
  ui_boot();
}

/**
 * One pass of the UI loop with this touch state. Returns how long ui.c would
 * have slept before the next pass, in ms; the page schedules the next call
 * that long after the last frame's virtual time.
 */
KUI_EXPORT("kui_pass") int kui_pass(double now_ms, int down, int lx, int ly) {
  kui_now_us = (int64_t)(now_ms * 1000.0);
  s_pass_start_us = kui_now_us;
  s_frame_count = 0;
  if (down && !s_touch_down) s_touch_count++;
  s_touch_down = down != 0;
  s_touch_lx = lx < 0 ? 0 : lx >= UI_W ? UI_W - 1 : lx;
  s_touch_ly = ly < 0 ? 0 : ly >= UI_H ? UI_H - 1 : ly;
  return (int)ui_pass();
}

/** The elapsed virtual time of the pass, ms - where the returned delay counts from. */
KUI_EXPORT("kui_pass_elapsed_ms") int kui_pass_elapsed_ms(void) {
  return (int)((kui_now_us - s_pass_start_us) / 1000);
}

KUI_EXPORT("kui_canvas") uint16_t *kui_canvas(void) { return g_canvas; }
KUI_EXPORT("kui_frame_count") int kui_frame_count(void) { return s_frame_count; }
KUI_EXPORT("kui_frame_ptr") uint16_t *kui_frame_ptr(int i) {
  return (i >= 0 && i < s_frame_count) ? s_frames[i].px : NULL;
}
KUI_EXPORT("kui_frame_at_ms") int kui_frame_at_ms(int i) { return (i >= 0 && i < s_frame_count) ? s_frames[i].at_ms : 0; }

/** RGB565 -> RGBA8888 into a shared buffer, for putImageData. */
KUI_EXPORT("kui_rgba") uint8_t *kui_rgba(const uint16_t *src) {
  if (src == NULL) src = g_canvas;
  uint8_t *o = g_rgba;
  for (int i = 0; i < UI_W * UI_H; i++) {
    const uint16_t p = src[i];
    const int r = (p >> 11) & 31, g = (p >> 5) & 63, b = p & 31;
    o[0] = (uint8_t)((r << 3) | (r >> 2));
    o[1] = (uint8_t)((g << 2) | (g >> 4));
    o[2] = (uint8_t)((b << 3) | (b >> 2));
    o[3] = 255;
    o += 4;
  }
  return g_rgba;
}

KUI_EXPORT("kui_screen") int kui_screen(void) { return (int)s_screen; }
KUI_EXPORT("kui_width") int kui_width(void) { return UI_W; }
KUI_EXPORT("kui_height") int kui_height(void) { return UI_H; }
KUI_EXPORT("kui_version") const char *kui_version(void) { return KINO_FW_VERSION; }
