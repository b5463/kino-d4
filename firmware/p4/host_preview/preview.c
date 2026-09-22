/**
 * Render the camera's screens on a workstation, using the firmware's own
 * drawing code.
 *
 * Looking at the UI used to mean a build, a flash and a serial capture -
 * about two minutes to see one pixel change, at a resolution low enough to
 * hide the thing being judged. Every visual bug so far (a vertical mirror, a
 * collapsed depth buffer that hid four lens barrels behind the camera body)
 * survived precisely because looking was expensive.
 *
 * ui.c is included as a translation unit rather than linked, so the static
 * drawing functions and the module state are reachable from here. That keeps
 * the firmware free of test hooks: nothing in ui.c knows this exists.
 *
 *   make -C firmware/p4/host_preview && firmware/p4/host_preview/preview out/
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define KINO_FW_VERSION "host-preview"

#include "buttons.h"
#include "cam_link.h"
#include "clock.h"
#include "capture.h"
#include "gallery.h"
#include "gfx.h"
/* For recipe_capture_t: the LOOK screen's detail strip needs a capture block
 * per look, and the stub below has to match the real signature exactly. */
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

/* ---- stand-ins for the parts of the camera a preview has no use for ---- */

static uint16_t *g_canvas;

bool display_ready(void) { return true; }
void *display_panel(void) { return NULL; }

esp_err_t gfx_init(void) { return ESP_OK; }
bool gfx_ready(void) { return true; }
uint16_t *gfx_canvas(void) { return g_canvas; }
/* The whole canvas, always: the renderer draws whole frames. */
static gfx_target_t g_target;
static const gfx_target_t *g_view;
const gfx_target_t *gfx_target(void) {
  if (g_view != NULL) return g_view;
  if (g_target.px != g_canvas) g_target = (gfx_target_t){g_canvas, 0, 0, UI_W, UI_H, UI_W};
  return &g_target;
}
void gfx_target_view(const gfx_target_t *view) { g_view = view; }
static void write_ppm(const char *path, const uint16_t *px, int w, int h);
extern char g_out[512];

/*
 * The renderer's frame sink.
 *
 * Normally nothing: a still is written by shot() when the caller asks for it.
 * While an animation is being rendered this is where its frames come out, one
 * numbered PPM each, and it is what steps the virtual clock - so the loop in
 * ui.c that draws until its duration is up terminates after a known number of
 * frames instead of running as fast as the host will let it.
 */
int64_t prev_vclock_us;
int64_t prev_vclock_step_us = 16000;
static const char *g_anim;
static int g_anim_n;

void gfx_present(void) {
  if (g_anim != NULL) {
    char path[600];
    snprintf(path, sizeof path, "%s/%s_%02d.ppm", g_out, g_anim, g_anim_n++);
    write_ppm(path, g_canvas, UI_W, UI_H);
  }
  if (prev_vclock_us != 0) prev_vclock_us += prev_vclock_step_us;
}
void gfx_snapshot(void) {}
void gfx_dissolve(int ms) { (void)ms; }
/* The renderer writes stills, so a transition is its end state. */
void gfx_slide_prepare(void) {}
void gfx_slide_show(int o, int b, bool from_right) { (void)o; (void)b; (void)from_right; }
/* Drawing passes begun; see gfx_pass_id(). Declared here because the stash
 * render below is the first pass-counting stub in the file. */
static uint32_t s_pass;
static uint16_t *g_stash;
void gfx_stash(void) {
  if (g_stash == NULL) g_stash = calloc((size_t)UI_W * UI_H, sizeof(uint16_t));
  if (g_stash != NULL) memcpy(g_stash, g_canvas, (size_t)UI_W * UI_H * sizeof(uint16_t));
}
void gfx_render_stash(gfx_draw_fn draw, void *ctx) {
  if (g_stash == NULL) g_stash = calloc((size_t)UI_W * UI_H, sizeof(uint16_t));
  if (g_stash == NULL) return;
  s_pass++;
  /* Through a view: gfx_target() snaps g_target back to the canvas whenever
   * it points anywhere else, so the stash has to be a view for the draw. */
  const gfx_target_t v = {g_stash, 0, 0, UI_W, UI_H, UI_W};
  g_view = &v;
  draw(ctx);
  g_view = NULL;
}
const uint16_t *gfx_stash_px(void) { return g_stash; }
/* A frame is one call of its drawing on the whole canvas, then the frame
 * goes out as every other frame does. */
uint32_t gfx_pass_id(void) { return s_pass; }
uint32_t gfx_measure_draw_us(gfx_draw_fn draw, void *ctx) { s_pass++; draw(ctx); return 0; }
void gfx_render_canvas(gfx_draw_fn draw, void *ctx) { s_pass++; draw(ctx); }
void gfx_render(gfx_draw_fn draw, void *ctx) {
  s_pass++;
  draw(ctx);
  gfx_present();
}
void gfx_stash_blit(int dx, int dy, int sx, int sy, int w, int h) {
  if (g_stash == NULL) return;
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
    memcpy(g_canvas + (size_t)(dy + r) * UI_W + dx, g_stash + (size_t)(sy + r) * UI_W + sx,
           (size_t)w * sizeof(uint16_t));
  }
}
/* The retained layer, same as the device's: a picture that only translates,
 * drawn once and blitted per frame. */
static uint16_t *g_layer;
void gfx_layer_keep(void) {
  if (g_layer == NULL) g_layer = calloc((size_t)UI_W * UI_H, sizeof(uint16_t));
  if (g_layer != NULL) memcpy(g_layer, g_canvas, (size_t)UI_W * UI_H * sizeof(uint16_t));
}
void gfx_layer_blit(int dx, int dy, int sx, int sy, int w, int h) {
  if (g_layer == NULL) return;
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
    memcpy(g_canvas + (size_t)(dy + r) * UI_W + dx, g_layer + (size_t)(sy + r) * UI_W + sx,
           (size_t)w * sizeof(uint16_t));
  }
}
void gfx_stats(uint32_t *f, uint32_t *ms) {
  if (f) *f = 0;
  if (ms) *ms = 0;
}
uint64_t gfx_present_us_total(void) { return 0; }
void gfx_pass_split(uint64_t *d, uint64_t *x, uint64_t *v) {
  if (d) *d = 0;
  if (x) *x = 0;
  if (v) *v = 0;
}

/* ui.c registers its tasks so GET_RUNTIME_STATS can report their stack
 * headroom. There are no tasks here - ui.c's are never created - so this
 * records nothing. It exists because the alternative is that adding one
 * taskmon_register() line anywhere in ui.c silently breaks the preview
 * build, which is how it arrived. */
void taskmon_register(const char *name, void *handle) {
  (void)name;
  (void)handle;
}

esp_err_t audio_init(void) { return ESP_OK; }
/* Driven from main(): the SOUND screen now consults this, and it had returned a
 * flat false - which would have made every screenshot of that screen the
 * amplifier-did-not-start branch and hidden the normal one entirely. */
static bool g_audio_ready = true;
bool audio_ready(void) { return g_audio_ready; }
void audio_shutter(void) {}
void audio_tick(void) {}
void audio_warning(void) {}

esp_err_t touch_init(void) { return ESP_OK; }
bool touch_ready(void) { return false; }
bool touch_get(uint16_t *x, uint16_t *y) {
  (void)x;
  (void)y;
  return false;
}
uint32_t touch_count(void) { return 0; }

/* Settings the preview draws against. These are the firmware's own defaults,
 * so a screenshot shows what an unconfigured camera shows. */
/* Driven from main() so the DISPLAY screen can be photographed with the two
 * new rows on their default segments and on the ones that only exist because
 * of issue #144 - HOLD and NEVER, which are the two nobody has ever seen. */
static int g_after_shot_s = 2;
static int g_cam_idle_s = 300;

int config_int(const char *path, int fallback) {
  if (strcmp(path, "body.autoDimS") == 0) return 30;
  if (strcmp(path, "body.sleepS") == 0) return 120;
  if (strcmp(path, "body.camIdleTimeoutS") == 0) return g_cam_idle_s;
  if (strcmp(path, "shoot.displayAfterShotS") == 0) return g_after_shot_s;
  if (strcmp(path, "shoot.volume") == 0) return 6;
  return fallback;
}
bool config_bool(const char *path, bool fallback) { return fallback; }
/* Driven from main() so one run can photograph a setting in each of its
 * states. The device reads these back through config_str after writing them;
 * here main() sets them directly, which is the same thing from the drawing
 * code's point of view. */
static const char *g_mode = "wiggle";
static const char *g_flash_mode = "auto";
static bool g_mono = false;
static const char *g_look = "party-neg";
/* Drives the QUAD/ALL disagreement the LOOK screen calls MIXED. */
static bool g_mixed_slots = false;
static const char *g_shutter_sound = "click";
/* body.name: empty is the default and the state the About screen has always
 * shown, so both get a picture. */
static const char *g_body_name = "";

const char *config_str(const char *path, const char *fallback) {
  if (strcmp(path, "body.name") == 0) return g_body_name;
  if (strcmp(path, "mode") == 0) return g_mode;
  if (strcmp(path, "shoot.flashMode") == 0) return g_flash_mode;
  if (strcmp(path, "shoot.shutterSound") == 0) return g_shutter_sound;
  if (strcmp(path, "wiggle.recipeId") == 0) return g_look;
  if (strncmp(path, "quad.slots.", 11) == 0 && strstr(path, "colorMode"))
    return g_mono ? "mono" : "recipe";
  /* All four slots answer the same look, so the LOOK screen's ALL target
   * renders its normal state rather than MIXED. The mixed case gets its own
   * shot below, driven by g_look. */
  if (strncmp(path, "quad.slots.", 11) == 0 && strstr(path, "recipeId")) {
    /* One slot answering something else is what makes look_current_id() give
     * up, which is the MIXED state - and now also the detail strip's "the four
     * cameras are on different looks" branch, which has no other way to be
     * looked at. */
    if (g_mixed_slots && strstr(path, "cam3") != NULL) return "mono";
    return g_look;
  }
  /* `device` used to be faked here, and that fake is why the About screen's
   * Device row looked correct in every screenshot ever taken while being blank
   * on hardware - nothing in the firmware writes that key. Removed with the row
   * that read it; the serial now comes from kdp_device_serial() below. */
  return fallback;
}

/* The serial GET_DEVICE_INFO answers. On a camera it is derived from the
 * factory MAC in app_main(); there is no efuse here, so this is a fixed string
 * in the shape that derivation produces ("KD4-" and six upper-case hex). */
const char *kdp_device_serial(void) { return "KD4-3A2B1C"; }

size_t config_str_copy(const char *path, char *out, size_t cap) {
  const char *v = config_str(path, "");
  snprintf(out, cap, "%s", v);
  return strlen(v);
}

/* ---- looks and sounds -------------------------------------------------
 *
 * kdp_recipes.c parses an embedded JSON blob with the real cJSON and
 * kdp_sounds.c opens the card; neither exists here. The LOOK and SOUND
 * screens are pickers over these two lists, so the lists have to be real
 * enough to render - the names below are the factory looks the firmware
 * actually ships, and two invented clips, so a screenshot shows the row at
 * the width it will really have. */
static const struct {
  const char *id;
  const char *name;
} FAKE_LOOKS[] = {
    {"party-neg", "Party Neg"}, {"chrome", "Chrome"},         {"superia", "Superia"},
    {"vivid", "Vivid"},         {"mono", "Mono"},             {"motion", "Motion"},
    {"flash-digi", "Flash Digi"}, {"warm-2007", "Warm 2007"}, {"cold-flash", "Cold Flash"},
    {"disposable", "Disposable"}, {"raw-digi", "Raw Digi"},
};

int kdp_recipes_count(void) { return (int)(sizeof FAKE_LOOKS / sizeof FAKE_LOOKS[0]); }

bool kdp_recipes_name(int index, char *id, size_t id_cap, char *name, size_t name_cap) {
  if (index < 0 || index >= kdp_recipes_count()) return false;
  if (id && id_cap) snprintf(id, id_cap, "%s", FAKE_LOOKS[index].id);
  if (name && name_cap) snprintf(name, name_cap, "%s", FAKE_LOOKS[index].name);
  return true;
}

/*
 * A capture block per look, for the LOOK screen's detail strip.
 *
 * kdp_recipes.c parses the embedded factory JSON with the real cJSON and reads
 * custom looks off the card; neither exists here. These numbers are in the
 * shape and the ranges the contract gives (D19: exposureBias -2..+2 EV, quality
 * 60..95, gainLimit an x-factor the factory looks write as 12 or 16) so the
 * strip is photographed at the width it will really have.
 *
 * `flash-digi` deliberately sets only three of the five. The NOT SET column is
 * the one distinction on this screen that cannot be checked by arithmetic - an
 * absent field is not a zero, and it has to be visibly different from one -
 * so there has to be a screenshot with both kinds of column side by side.
 */
bool kdp_recipes_capture_block(const char *id, recipe_capture_t *out) {
  if (out == NULL || id == NULL) return false;
  memset(out, 0, sizeof *out);

  /* A look with no capture block at all, so that branch gets a picture too. */
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

  if (strcmp(id, "flash-digi") == 0) {
    out->exposure_bias = 1.5;
    out->has_gain_limit = false;
    out->has_denoise = false;
  }
  return true;
}

static const struct {
  const char *id;
  const char *name;
} FAKE_CLIPS[] = {{"snd-air-horn", "Air horn"}, {"snd-polaroid", "Polaroid"}};

int kdp_sounds_count(void) { return (int)(sizeof FAKE_CLIPS / sizeof FAKE_CLIPS[0]); }

bool kdp_sounds_info(int index, char *id, size_t id_cap, char *name, size_t name_cap) {
  if (index < 0 || index >= kdp_sounds_count()) return false;
  if (id && id_cap) snprintf(id, id_cap, "%s", FAKE_CLIPS[index].id);
  if (name && name_cap) snprintf(name, name_cap, "%s", FAKE_CLIPS[index].name);
  return true;
}

/* Writes land nowhere: the preview is a renderer, and a screenshot run that
 * mutated a config file would be a surprising side effect of looking. The
 * cJSON stubs exist so ui.c's real write path compiles; main() drives the
 * globals above directly, so none of this is reached. */
esp_err_t config_merge(const cJSON *patch) { (void)patch; return ESP_OK; }
esp_err_t config_save(void) { return ESP_OK; }

/* meta.c is not linked here - it needs the real cJSON, which lives in
 * ESP-IDF. Stubbed rather than left to the linker's dead-code elimination:
 * it resolved only because nothing in main() reaches the write path, so the
 * first screenshot that exercised a setting would have broken the build. */
void *meta_patch_path(const char *dotted, void *leaf);
void *meta_patch_path(const char *dotted, void *leaf) {
  (void)dotted;
  return leaf;
}

static struct cJSON { int unused; } g_json_stub;
cJSON *cJSON_CreateObject(void) { return &g_json_stub; }
cJSON *cJSON_CreateString(const char *s) { (void)s; return &g_json_stub; }
cJSON *cJSON_CreateNumber(double v) { (void)v; return &g_json_stub; }
cJSON *cJSON_CreateBool(bool v) { (void)v; return &g_json_stub; }
void cJSON_AddItemToObject(cJSON *obj, const char *key, cJSON *item) {
  (void)obj; (void)key; (void)item;
}
void cJSON_Delete(cJSON *item) { (void)item; }

void esp_restart(void) { fprintf(stderr, "esp_restart() in a preview - ignored\n"); }

/*
 * Four preview streams, invented here and only here.
 *
 * There are no nodes on a workstation, and returning NULL for every tile
 * meant SHOOT - the screen the camera spends most of its life on - was four
 * empty panes in every screenshot ever taken. sh_blit(), the crop, the 5:3
 * fit and the pane boundaries were all unreviewable as a result.
 *
 * Gradients, like fake_gallery(), so no screenshot from this tool can be
 * mistaken for a frame off a sensor. Each camera gets a different hue ramp
 * and a marked border row so a pane swapped left for right, or a crop taking
 * from the wrong end, is visible at a glance rather than plausible.
 */
static uint16_t g_vf[4][VF_W * VF_H];
static bool g_vf_filled;

static void fake_viewfinder(void) {
  for (int c = 0; c < 4; c++) {
    for (int y = 0; y < VF_H; y++) {
      for (int x = 0; x < VF_W; x++) {
        /* The full 240 rows, including the 24 at each end that SH_CROP
         * throws away - the point is to be able to see that it does. */
        /* Each camera gets a different share of the red ramp. Scaled, not
         * offset and masked: an offset wraps 31 back to 0 partway across the
         * pane and puts a hard vertical seam in the middle of the picture,
         * which is exactly what a torn blit would look like. */
        const int r = (x * (31 - c * 6)) / VF_W;
        const int g = (y * 63) / VF_H;
        const int b = 31 - ((x + y) * 31) / (VF_W + VF_H);
        uint16_t p = (uint16_t)(((r & 31) << 11) | ((g & 63) << 5) | (b & 31));
        /* A one-pixel white frame round the source. Cropped top and bottom
         * by design, so a pane that shows all four edges is a blit that is
         * not cropping. */
        if (x == 0 || y == 0 || x == VF_W - 1 || y == VF_H - 1) p = 0xFFFF;
        g_vf[c][y * VF_W + x] = p;
      }
    }
  }
  g_vf_filled = true;
}

/* Cameras that are not answering, one bit each. Zero is the four-camera body
 * every other shot is taken on. */
static unsigned g_vf_dead;

esp_err_t viewfinder_init(void) { return ESP_OK; }
bool viewfinder_ready(void) { return true; }
void viewfinder_run(bool on) { (void)on; }
const uint16_t *viewfinder_tile(int cam) {
  if (cam < 0 || cam >= 4) return NULL;
  if (g_vf_dead & (1u << cam)) return NULL;
  if (!g_vf_filled) fake_viewfinder();
  return g_vf[cam];
}
/*
 * The status now agrees with the pixels.
 *
 * It reported VF_NO_LINK for all four while viewfinder_tile() handed out a
 * frame for all four, which is a state the camera cannot be in: a node that
 * never answered has no picture to show. It went unnoticed because draw_shoot()
 * only read the status on the panes with no tile, and there were none. The
 * SHOOT strip counts live cameras, so a harness that lies here photographs a
 * bar reading 0/4 LIVE over four pictures.
 */
void viewfinder_status(int cam, vf_status_t *out) {
  if (out == NULL) return;
  const bool dead = cam < 0 || cam >= 4 || (g_vf_dead & (1u << cam));
  out->state = dead ? VF_NO_LINK : VF_LIVE;
  out->frames = dead ? 0 : 120;
  out->last_ms = dead ? 0 : 60;
  out->bytes = dead ? 0 : 9200;
  out->fps_x10 = dead ? 0 : 165;
}

/* No physical controls on a workstation, and nothing to log to. */
void buttons_on_press(button_handler_t handler) { (void)handler; }
esp_err_t buttons_init(void) { return ESP_OK; }
bool buttons_fitted(void) { return false; }
bool button_held(button_id_t id) {
  (void)id;
  return false;
}

/* No cameras and no card, so nothing here takes a picture. The shutter still
 * has to resolve, because ui.c calls it. */
bool capture_request(const char *source) {
  (void)source;
  return false;
}
/* Driven by the preview so the result banner can be looked at. */
static capture_stage_t g_stage = CAPTURE_IDLE;
static capture_report_t g_report;
/* Which of the four have landed, as the capture task reports it. The guest
 * half fills its bands off this and not off the stage, because four sensors
 * on four mounts do not answer together. */
static uint32_t g_frames_in = 0xF;
uint32_t capture_frames_in(void) { return g_frames_in; }
uint32_t capture_asked_cams(void) { return 0xF; }

capture_stage_t capture_stage(void) { return g_stage; }
void capture_ack(void) { g_stage = CAPTURE_IDLE; }
bool capture_busy(void) { return false; }
void capture_last(capture_report_t *out) {
  if (out) *out = g_report;
}
uint32_t capture_count(void) { return 0; }

/*
 * A gallery with pictures in it, invented here and only here.
 *
 * The point of the preview is to judge the layout, and an empty grid judges
 * nothing - the tile proportions, the label baseline and the gap between rows
 * are only visible against something. These are gradients, not photographs,
 * so no screenshot from this tool can be mistaken for a frame off a sensor.
 */
static uint16_t g_tile[GALLERY_PAGE][GALLERY_TILE_W * GALLERY_TILE_H];
static gallery_item_t g_slot[GALLERY_PAGE];
static int g_fake_total = 14;

static void fake_gallery(void) {
  static const char *MODES[] = {"wiggle", "wiggle", "quad", "wiggle", "quad", "wiggle"};
  for (int i = 0; i < GALLERY_PAGE; i++) {
    for (int y = 0; y < GALLERY_TILE_H; y++) {
      for (int x = 0; x < GALLERY_TILE_W; x++) {
        const int r = (x * 31) / GALLERY_TILE_W;
        const int g = (y * 63) / GALLERY_TILE_H;
        const int b = 31 - ((x + y) * 31) / (GALLERY_TILE_W + GALLERY_TILE_H);
        g_tile[i][y * GALLERY_TILE_W + x] =
            (uint16_t)((((r + i * 3) & 31) << 11) | ((g & 63) << 5) | (b & 31));
      }
    }
    snprintf(g_slot[i].id, sizeof g_slot[i].id, "preview-%d", i);
    snprintf(g_slot[i].label, sizeof g_slot[i].label, "CAP_%06d", 37 + i);
    snprintf(g_slot[i].mode, sizeof g_slot[i].mode, "%s", MODES[i]);
    g_slot[i].frames = i == 3 ? 2 : 4;
    g_slot[i].partial = i == 3;
    /* Two of six marked, and one of them the partial capture: the star has to
     * be legible over a picture and next to the frame mark, not only on its
     * own. */
    g_slot[i].favorite = i == 1 || i == 3;
    g_slot[i].state = i == 5 ? TILE_PENDING : TILE_READY;
    g_slot[i].pixels = i == 5 ? NULL : g_tile[i];
  }
}

esp_err_t gallery_init(void) { return ESP_OK; }
void gallery_refresh(void) {}
int gallery_total(void) { return g_fake_total; }
int gallery_media_count(void) { return g_fake_total; }
int gallery_capture_files(const char *id, bool *has_thumb, uint8_t *slots, int cap) {
  (void)id;
  if (has_thumb != NULL) *has_thumb = true;
  int n = 0;
  for (int i = 0; i < 4 && n < cap; i++) slots[n++] = (uint8_t)(i + 1);
  return n;
}
int gallery_page(void) { return 1; }
int gallery_pages(void) { return 3; }
void gallery_turn(int delta) { (void)delta; }
const gallery_item_t *gallery_slots(void) { return g_slot; }
bool gallery_loading(void) { return false; }
void gallery_note_added(const char *id, uint64_t when) {
  (void)id;
  (void)when;
}
void gallery_note_removed(const char *id) { (void)id; }
/* 0 rather than a number: the previewed screens are the steady states, and a
 * rebuild in progress is not one of them. The READING CARD branch is rendered
 * by gallery_loading() above, which is what the preview varies. */
int gallery_scan_progress(void) { return 0; }
void gallery_delete_all(void) {}

/* #188: the consumer pass's new doors, none of which a picture needs. */
esp_err_t storage_format(void) { return ESP_OK; }
void factory_reset_erase(void) {}
void viewfinder_throttle(bool on) { (void)on; }
bool kdp_p4_temp_c(float *out) { (void)out; return false; }
bool safe_mode_active(void) { return false; }
int safe_mode_crashes(void) { return 0; }
#include "storage_watch.h"
bool storage_watch_take(storage_event_t *out) { (void)out; return false; }
bool safe_mode_brownout(void) { return false; }
#include "lid.h"
void lid_get(lid_state_t *out) { memset(out, 0, sizeof *out); out->mean[0] = out->mean[1] = out->mean[2] = out->mean[3] = -1; }
int clock_offset_min(void) { return 120; }
bool clock_offset_known(void) { return true; }
void clock_set_offset(int m) { (void)m; }
esp_err_t storage_capture_trash(const char *id) { (void)id; return ESP_OK; }
esp_err_t storage_capture_untrash(const char *id) { (void)id; return ESP_OK; }
void storage_trash_purge(void) {}
bool roll_http_api_base(char *out, size_t cap) { if (cap) out[0] = ' '; return true; }
int64_t clock_now_ms(void) { return 1790006498000LL; } /* 2026-09-21T16:01Z */
bool gallery_deleting(void) { return false; }
void gallery_delete_progress(int *done, int *total) {
  if (done != NULL) *done = 0;
  if (total != NULL) *total = 0;
}

/*
 * The wigglegram's four frames, invented here like the tiles above.
 *
 * On the camera these are four JPEGs off the card, decoded on the gallery
 * task. There is no card here, so the harness IS the decode: it fills four
 * buffers and reports them ready immediately. The synthetic frames carry a
 * bar that moves 18 px per lens, which is a caricature of the ~19 mm baseline
 * the real bodies have - the point is that a render of frame three is
 * unmistakably not a render of frame one, which is the whole claim the
 * photo_wiggle_playing shot exists to check.
 *
 * `g_frame_have` is driven by main() so the complete capture and the partial
 * one both get a picture. It is the mask the device discovers by trying each
 * file, so a 0 bit here is a frame that is not on the card at all.
 */
static uint16_t *g_frame[GALLERY_FRAME_MAX];
static uint32_t g_frame_gen;
static uint32_t g_frame_have = 0xf;

/*
 * One synthetic "sensor" pixel of frame `i`.
 *
 * Procedural rather than a filled buffer because the aligned path has to
 * RESAMPLE it, the way the device's PPA resamples a real frame through a source
 * crop. The background is the same in all four - it is the distance - and only
 * the near bar moves, which is what parallax is and what makes one frame of the
 * swing tell you which frame it is.
 */
static uint16_t synth_px(int x, int y, int i, int w, int h) {
  const int r = (x * 31) / w;
  const int g = (y * 63) / h;
  const int b = 31 - ((x + y) * 31) / (w + h);
  uint16_t px = (uint16_t)((r << 11) | (g << 5) | b);
  const int bar = w / 4 + i * 34;
  if (x >= bar && x < bar + 44 && y > h / 5 && y < h - h / 5) px = 0xffff;
  return px;
}

esp_err_t gallery_frames_begin(const char *id, int w, int h, uint16_t pad,
                               const pure_cam_offset_t *offsets, uint32_t *gen) {
  (void)id;
  (void)pad;
  /*
   * The device applies a calibration as a PPA source crop and shift
   * (thumb_load_aligned). There is no PPA and no card here, so the harness
   * resamples the synthetic frame through the SAME pure_align_plan() numbers -
   * nearest neighbour instead of the PPA's filter - so an aligned render shows
   * the geometry the device would produce rather than a picture of this stub.
   *
   * With no offsets this is pixel-for-pixel the frame the harness has always
   * produced (sx == x, sy == y), which is what keeps every existing render
   * unchanged.
   */
  const bool align = pure_align_has_offset(offsets, PURE_WIGGLE_FRAMES_MAX);
  pure_frame_xform_t xf[PURE_WIGGLE_FRAMES_MAX];
  pure_crop_t crop = {0, 0, w, h};
  if (align) crop = pure_align_plan(w, h, offsets, PURE_WIGGLE_FRAMES_MAX, xf);

  for (int i = 0; i < GALLERY_FRAME_MAX; i++) {
    free(g_frame[i]);
    g_frame[i] = calloc((size_t)w * (size_t)h, sizeof(uint16_t));
    if (g_frame[i] == NULL) return ESP_ERR_NO_MEM;
    /* This camera's window into the source: the common crop, moved back by the
     * camera's own correction, which is what makes the subject sit still. */
    int sx0 = 0, sy0 = 0;
    if (align) {
      sx0 = crop.x - (int)(xf[i].dx >= 0 ? xf[i].dx + 0.5 : xf[i].dx - 0.5);
      sy0 = crop.y - (int)(xf[i].dy >= 0 ? xf[i].dy + 0.5 : xf[i].dy - 0.5);
    }
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        int sx = x, sy = y;
        if (align) {
          sx = sx0 + (x * crop.w) / w;
          sy = sy0 + (y * crop.h) / h;
          if (sx < 0) sx = 0;
          if (sy < 0) sy = 0;
          if (sx >= w) sx = w - 1;
          if (sy >= h) sy = h - 1;
        }
        g_frame[i][y * w + x] = synth_px(sx, sy, i, w, h);
      }
    }
  }
  g_frame_gen++;
  if (gen != NULL) *gen = g_frame_gen;
  return ESP_OK;
}

void gallery_frames_cancel(void) { g_frame_gen++; }

bool gallery_frames_state(uint32_t gen, uint32_t *have, bool *done) {
  if (gen != g_frame_gen || g_frame_gen == 0) return false;
  if (have != NULL) *have = g_frame_have;
  /* Always finished. The still-loading state is not a separate picture: it is
   * exactly the existing "photo" shot, which is the requirement. */
  if (done != NULL) *done = true;
  return true;
}

const uint16_t *gallery_frame_pixels(int index) {
  if (index < 0 || index >= GALLERY_FRAME_MAX) return NULL;
  return g_frame[index];
}

void klog(const char *src, const char *fmt, ...) {
  (void)src;
  (void)fmt;
}

/* No card on a workstation, so every decode fails and the photograph view
 * renders its own "no image" state - which is a state worth photographing. */
esp_err_t thumb_load(const char *path, uint16_t *tile, int tile_w, int tile_h, uint16_t pad) {
  (void)path; (void)tile; (void)tile_w; (void)tile_h; (void)pad;
  return ESP_FAIL;
}
void storage_capture_delete(const char *dir) { (void)dir; }

/* The card arbiter. There is no card and there are no other users, so the
 * grant is unconditional - but the calls have to resolve, because ui.c now
 * takes the card round the photograph decode and the delete like every other
 * reader does. */
bool storage_acquire(storage_user_t user, int timeout_ms) {
  (void)user;
  (void)timeout_ms;
  return true;
}
void storage_release(storage_user_t user) { (void)user; }

/* The favourite flag lives in a META.JSON on a card, and there is neither. The
 * photograph screen's own s_photo_fav is what the renders show, seeded from
 * the fake gallery item and flipped by main() - so the button gets a picture
 * in both states without a filesystem. */
esp_err_t media_favorite_set(const char *id, bool fav) {
  (void)id;
  (void)fav;
  return ESP_OK;
}
bool media_favorite_get(const char *id) {
  (void)id;
  return false;
}

void power_activity(void) {}
void power_wake(void) {}
bool power_sleep_pending(void) { return false; }
void power_sleep_shown(void) {}
void power_get(power_state_t *out) {
  if (out == NULL) return;
  out->stage = POWER_AWAKE;
  out->idle_s = 12;
  out->display_on = true;
  out->cam_bank_on = true;
  out->usb_attached = true;
}

/* Plausible readings, so the screens show the layout they will really have.
 * Invented numbers are fine here and only here: this is a picture of the UI,
 * never a report about the hardware. */
void camlink_get_info(camlink_info_t *out) {
  memset(out, 0, sizeof *out);
  out->online = true;
  snprintf(out->sensor, sizeof out->sensor, "OV3660");
  snprintf(out->firmware, sizeof out->firmware, "0.9.0");
  out->temp_c = 31;
  out->latency_ms = 4;
}

/* Per-camera, for the About screen's CAMERAS column.
 *
 * CAM1 and CAM3 answer and CAM2 and CAM4 do not, deliberately: this body has
 * one camera fitted today, and a screenshot in which all four rows look the
 * same would not show whether the online and offline rows are distinguishable
 * at a glance. CAM3 carries a different node version because nodes are
 * reflashed one at a time, which is exactly why this is four rows. */
void camlink_get_info_ch(int cam, camlink_info_t *out) {
  memset(out, 0, sizeof *out);
  if (cam != 0 && cam != 2) return;
  out->online = true;
  snprintf(out->sensor, sizeof out->sensor, "OV3660");
  snprintf(out->firmware, sizeof out->firmware, cam == 0 ? "0.9.0" : "0.8.4");
  out->temp_c = 31;
  out->latency_ms = 4;
}

/* Driven from main() so the STORAGE screen's two states both get a picture:
 * the new band under the list is a capacity bar when the card is mounted and
 * the mount failure when it is not, and those are different layouts. */
static bool g_card_mounted = true;

/* The preview stands in for a body that has been plugged into Studio, so its
 * clock has a source and the screens that report one have something to
 * report. `g_clock_source` is here so a shot can ask for the other state -
 * the one a camera out of the box is in, where the date is honestly unknown
 * and every capture is dated from power on. */
static clock_source_t g_clock_source = CLOCK_HOST;
clock_source_t clock_source(void) { return g_clock_source; }
void clock_iso8601(char *out, size_t cap) { snprintf(out, cap, "2026-09-16T18:42:11+02:00"); }

void storage_get_status(storage_status_t *out) {
  memset(out, 0, sizeof *out);
  if (!g_card_mounted) {
    out->present = true;
    out->mounted = false;
    out->mount_attempts = 3;
    out->last_error = "MOUNT_FAILED";
    out->write_test = "none";
    return;
  }
  out->present = true;
  out->mounted = true;
  out->filesystem = "FAT";
  out->capacity_bytes = 31914983424ULL;
  out->free_bytes = 30648041472ULL;
  out->write_test = "pass";
}

/* ---- networking and Roll ----------------------------------------------
 *
 * Stubbed like every other subsystem here, but with one difference worth
 * naming: these fakes are the ONLY way the RADIO and ROLL screens can be
 * looked at. The C6 has no transport on this carrier
 * (firmware/C6_HARDWARE_MAP.md), so no board can render an online state, and
 * no board has ever rendered a Roll. The PPMs this produces are the review.
 *
 * `g_net_state` and the Roll fields are drivers, set by the shot list below,
 * so each state gets its own picture instead of one screen standing in for
 * four. Invented numbers are fine here and only here: this is a picture of the
 * UI, never a report about the hardware.
 */
static net_state_t g_net_state = NET_C6_NOT_ROUTED;
static net_reason_t g_net_reason = NET_REASON_TRANSPORT_UNKNOWN;
static bool g_net_routed = false;
static size_t g_saved_networks = 0;

void net_link_init(int64_t now_ms) { (void)now_ms; }

void net_link_status(net_status_t *out, int64_t now_ms) {
  (void)now_ms;
  if (out == NULL) return;
  memset(out, 0, sizeof *out);
  out->state = g_net_state;
  out->reason = g_net_reason;
  out->radio_fitted = true;
  out->radio_routed = g_net_routed;
  if (g_net_state == NET_IP_READY) {
    snprintf(out->ssid, sizeof out->ssid, "KINO-PARTY");
    snprintf(out->ip, sizeof out->ip, "192.168.1.74");
    out->rssi = -57;
    out->channel = 6;
    snprintf(out->c6_version, sizeof out->c6_version, "0.4.0");
  }
  if (g_net_state == NET_C6_NOT_ROUTED) {
    snprintf(out->detail, sizeof out->detail,
             "no P4-C6 transport routing recorded; see firmware/C6_HARDWARE_MAP.md");
  }
}

bool net_link_can_upload(const net_status_t *status) {
  return status != NULL && status->state == NET_IP_READY;
}
bool net_link_scan_start(int64_t now_ms) { (void)now_ms; return false; }
size_t net_link_scan_results(net_scan_entry_t *out, size_t cap) {
  (void)out; (void)cap; return 0;
}
bool net_link_connect(const char *ssid, int64_t now_ms) {
  (void)ssid; (void)now_ms; return false;
}
bool net_link_disconnect(int64_t now_ms) { (void)now_ms; return false; }

esp_err_t wifi_creds_init(void) { return ESP_OK; }
size_t wifi_creds_count(void) { return g_saved_networks; }
size_t wifi_creds_list(wifi_cred_view_t *out, size_t cap) { (void)out; (void)cap; return 0; }
bool wifi_creds_has_password(const char *ssid) { (void)ssid; return false; }

/* The Roll the ROLL screen shows. `g_roll_active` off is the no-roll state. */
static bool g_roll_active = false;
static roll_state_t g_roll;

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
const char *roll_role_name(roll_role_t role) {
  return role == ROLL_ROLE_HOST ? "host" : "guest";
}
bool roll_state_has_credential(void) { return g_roll_active; }

static upload_queue_report_t g_queue;

esp_err_t upload_queue_start(void) { return ESP_OK; }
esp_err_t upload_queue_enqueue(const char *uuid, bool thumb) {
  (void)uuid; (void)thumb; return ESP_OK;
}
esp_err_t upload_queue_enqueue_slots(const char *uuid, const char *roll_id, const uint8_t *slots,
                                     int count, bool thumb) {
  (void)uuid; (void)roll_id; (void)slots; (void)count; (void)thumb;
  return ESP_OK;
}
void upload_queue_forget(const char *capture_uuid) { (void)capture_uuid; }
void upload_queue_status(upload_queue_report_t *out) {
  if (out != NULL) *out = g_queue;
}
int upload_queue_retry_all(void) { return 0; }

#include "ui.c"

/* Every scene here goes through ui_render(): recorded into the display list
 * and replayed, exactly as the camera draws a frame. So the byte-compare of
 * these pictures against the baseline tests the recorder, and a scene is a
 * pass, which keeps the once-per-pass caches in ui.c honest. */
#define draw_screen() ui_render(render_screen, NULL)

/* ---- the text-overflow audit ----
 *
 * ui.c calls this from text() when a string is set outside the safe area.
 * Every hit is a line that the panel clips: on a screenshot it looks like a
 * shorter sentence, which is why the About note sat over the bezel for a week
 * after the type changed and nobody caught it by looking.
 *
 * Deduped on the string, because a row template that overflows overflows once
 * per row and the interesting number is how many distinct strings are wrong,
 * not how many times the loop ran. Reported with the screen that was being
 * drawn when it happened - the whole point is to know where to look. */
#define AUDIT_MAX 64
static struct {
  char s[80];
  int x, y, w, h;
  char screen[32];
} g_audit[AUDIT_MAX];
static int g_audit_n;

void ui_audit_text(int x, int y, int w, int h, const char *s) {
  /* Not during a transition. A screen sliding in from the right is *supposed*
   * to have half its type off the canvas, and the first run of this audit
   * reported eleven of those and one real fault - which is how a check that
   * cries wolf gets switched off. Stills only, where the bound is a promise. */
  if (g_anim != NULL) return;
  for (int i = 0; i < g_audit_n; i++) {
    if (strcmp(g_audit[i].s, s) == 0) return;
  }
  if (g_audit_n >= AUDIT_MAX) return;
  snprintf(g_audit[g_audit_n].s, sizeof g_audit[0].s, "%s", s);
  g_audit[g_audit_n].screen[0] = '\0'; /* shot() names it, once it knows */
  g_audit[g_audit_n].x = x;
  g_audit[g_audit_n].y = y;
  g_audit[g_audit_n].w = w;
  g_audit[g_audit_n].h = h;
  g_audit_n++;
}

/* The drawing happens before the file is named, so the name is stamped on
 * afterwards: anything reported since the last shot belongs to this one. */
static void audit_name(const char *name) {
  for (int i = 0; i < g_audit_n; i++) {
    if (g_audit[i].screen[0] == '\0') {
      snprintf(g_audit[i].screen, sizeof g_audit[0].screen, "%s", name);
    }
  }
}

/* Non-zero when anything overflowed, so main() can fail the run. A render
 * that silently ships clipped type is the failure this was built to stop. */
static int audit_report(void) {
  if (g_audit_n == 0) return 0;
  fprintf(stderr, "\n%d string%s set outside the safe area:\n", g_audit_n,
          g_audit_n == 1 ? "" : "s");
  for (int i = 0; i < g_audit_n; i++) {
    fprintf(stderr, "  %-24s x=%d..%d y=%d..%d  \"%s\"\n",
            g_audit[i].screen[0] != '\0' ? g_audit[i].screen : "?",
            g_audit[i].x, g_audit[i].x + g_audit[i].w, g_audit[i].y,
            g_audit[i].y + g_audit[i].h, g_audit[i].s);
  }
  return g_audit_n;
}

/* ---- the frame-cost bench ----
 *
 * Reports how much of the canvas each kind of frame touches, in units of
 * full screens (800 x 480). On this board that is the frame time: the canvas
 * is in PSRAM at roughly 160 MB/s, so one opaque full-screen pass is ~4.8 ms
 * and one blended pass ~9.6, before the PPA reads the whole thing again to
 * rotate it onto the panel. Anything over about 2.0 screens of traffic cannot
 * hold 60 Hz on this chip, and anything whose cost CHANGES across a
 * transition will stutter no matter what the average is - which is the thing
 * the numbers below were written to find.
 */
extern uint64_t g_px_write, g_px_blend;

static void bench_reset(void) { g_px_write = g_px_blend = 0; }

/* Blended pixels count double: read-modify-write on PSRAM is two passes. */
static double bench_screens(void) {
  const double per = (double)UI_W * UI_H;
  return ((double)g_px_write + 2.0 * (double)g_px_blend) / per;
}

static void bench_line(const char *what, double screens) {
  printf("  %-28s %6.2f screens  %6.2f ms @160MB/s\n", what, screens, screens * 4.8);
}

/* ---- output ---- */

/* Set by any failed write. CI counts .ppm files and requires at least ten, so
 * a run that could not write half its screens - a full disk, a bad output
 * path, a directory that does not exist - could still satisfy the gate with
 * the ones that did land. A partial artifact is a failure, and this is what
 * makes main() say so. */
static bool g_write_failed;

void write_ppm_impl_marker(void);
static void write_ppm(const char *path, const uint16_t *px, int w, int h) {
  FILE *f = fopen(path, "wb");
  if (!f) {
    fprintf(stderr, "cannot write %s\n", path);
    g_write_failed = true;
    return;
  }
  fprintf(f, "P6\n%d %d\n255\n", w, h);
  for (int i = 0; i < w * h; i++) {
    const uint16_t p = px[i];
    const unsigned char rgb[3] = {
        (unsigned char)((((p >> 11) & 0x1F) * 255) / 31),
        (unsigned char)((((p >> 5) & 0x3F) * 255) / 63),
        (unsigned char)(((p & 0x1F) * 255) / 31),
    };
    if (fwrite(rgb, 1, 3, f) != 3) {
      /* A short write means a truncated PPM, which opens as a broken image
       * rather than not opening at all - the worse of the two failures. */
      fprintf(stderr, "short write on %s\n", path);
      g_write_failed = true;
      fclose(f);
      return;
    }
  }
  if (fclose(f) != 0) {
    /* Buffered data is flushed here, so this is where a full disk usually
     * shows up rather than at any of the fwrites above. */
    fprintf(stderr, "cannot close %s\n", path);
    g_write_failed = true;
    return;
  }
  printf("wrote %s (%dx%d)\n", path, w, h);
}

char g_out[512];
static void shot(const char *name) {
  char path[600];
  snprintf(path, sizeof path, "%s/%s.ppm", g_out, name);
  audit_name(name);
  write_ppm(path, g_canvas, UI_W, UI_H);
}

/* The conditions, before a screen is drawn. On the camera this runs on the UI
 * loop's own two-second schedule; here there is no loop, so every shot takes
 * its own reading and the pictures agree with the device state they were
 * rendered from. Without it the cache is empty and every screenshot claims a
 * camera with nothing wrong - which, with two nodes offline and two node
 * versions apart in the stubs above, would be the one thing these pictures
 * exist to catch. */
static void scan_conditions(void) { conditions_scan(about_cameras()); }

/*
 * A transition, as a sequence of pictures.
 *
 * The menu's open animation could only be judged by watching it in a browser,
 * which meant it could only be judged carelessly: a browser shows it once, at
 * whatever rate the tab felt like, with no way to look at the fourth frame.
 * Here it is `anim_open_00.ppm` onward, one per presented frame, on a clock
 * the renderer owns - so every frame of it is a still that can be held up
 * against the one before it.
 */
static void shot_anim(const char *name, screen_t from, screen_t to, int pressed) {
  s_screen = from;
  s_pressed = pressed;
  scan_conditions();
  draw_screen();

  g_anim = name;
  g_anim_n = 0;
  prev_vclock_us = 1000000; /* the renderer owns the clock from here */
  go(to, NAV_OPEN_MS);
  /* go() starts the move now rather than running it, so the renderer drives
   * it the way the UI loop does - one frame per tick, on the clock it owns. */
  for (int guard = 0; anim_active() && guard < 4000; guard++) {
    const uint32_t wait = anim_tick();
    if (wait > 0) prev_vclock_us += (int64_t)wait * 1000;
  }
  prev_vclock_us = 0;
  g_anim = NULL;
  printf("wrote %s_00..%02d (%d frames)\n", name, g_anim_n - 1, g_anim_n);
}


int main(int argc, char **argv) {
  snprintf(g_out, sizeof g_out, "%s", argc > 1 ? argv[1] : ".");

  g_canvas = calloc((size_t)UI_W * UI_H, sizeof(uint16_t));

  /* One helper, so every state below is "set the state, draw, name it" and
   * the list reads as the screen inventory it is meant to be. */
#define SHOT(scr, name)      \
  do {                       \
    s_screen = (scr);        \
    scan_conditions();       \
    draw_screen();           \
    shot(name);              \
  } while (0)

  fake_gallery();

  /* A format, mid-way. The calibration used to own this banner; it runs on
   * its own task now and puts up nothing. The format is the one operation
   * left that holds the UI task, and this is what it shows while it does. */
  s_screen = SCR_STORAGE;
  draw_screen(); /* what is underneath: the banner does not clear the canvas */
  s_formatting = true;
  draw_screen();
  shot("formatting");
  s_formatting = false;

  /* ---- the menu, which is the home screen ---- */
  s_pressed = -1;
  s_focus[SCR_MENU] = 0;
  SHOT(SCR_MENU, "menu");

  /*
   * The focus ring, which no screenshot has ever contained.
   *
   * s_focus_shown is false until a physical key is used, and this harness has
   * never set it - so "menu_settings_focus" was a picture of the menu with
   * nothing focused, and every dotted rectangle in the firmware was unreviewed
   * on every screen. It is set for the shots that are about focus and cleared
   * again afterwards, so the plain shots stay plain.
   */
  s_focus_shown = true;
  s_focus[SCR_MENU] = 4;
  SHOT(SCR_MENU, "menu_settings_focus");
  s_focus_shown = false;

  /* The boot rings, frame by frame. */
  {
    g_anim = "anim_boot";
    g_anim_n = 0;
    /* The real sequence, through the real driver, on the renderer's clock -
     * so the frames reviewed here are the frames the camera presents. The
     * step is coarse (16 ms of virtual time per present) to keep the dump to
     * a readable number of pictures. */
    prev_vclock_us = 1000000;
    prev_vclock_step_us = 60000;
    s_screen = SCR_MENU;
    splash();
    /* The clock here only advances when a frame is presented, so a hold - a
     * phase that returns a delay and draws nothing - has to move it by hand.
     * On the camera and in the Twin the clock is real and this is free. */
    for (int guard = 0; anim_active() && guard < 4000; guard++) {
      const uint32_t wait = anim_tick();
      if (wait > 0) prev_vclock_us += (int64_t)wait * 1000;
    }
    prev_vclock_step_us = 16000;
    prev_vclock_us = 0;
    g_anim = NULL;
    /* The first-start note the cascade raises stays up until dismissed; the
     * scenes after this one are of a body that has seen it. */
    s_dialog = DLG_NONE;
  }

  /* The menu's two moves, frame by frame. */
  shot_anim("anim_open", SCR_MENU, SCR_GALLERY, 2);
  shot_anim("anim_back", SCR_GALLERY, SCR_MENU, -1);
  s_pressed = -1;

  s_pressed = 4;
  SHOT(SCR_MENU, "menu_pressed");
  s_pressed = -1;
  s_focus[SCR_MENU] = 0;

  /*
   * ---- shoot: the four panes, the way out, and the status bar ----
   *
   * These three shots rendered IDENTICALLY until 0.4.17. The harness set the
   * flash and then the mode, and the screen drew neither - it had four panes
   * and the word MENU - so three files with three names were three copies of
   * one picture, and the fact that SHOOT told nobody how it would shoot was
   * invisible in exactly the artifact that exists to make it visible. The
   * status bar is what makes them different; if any two of them ever match
   * again, the bar has stopped reading something.
   */
  s_focus[SCR_SHOOT] = 3; /* the shutter, where focus lands on entry */
  SHOT(SCR_SHOOT, "shoot");
  g_flash_mode = "on";
  SHOT(SCR_SHOOT, "shoot_flash_on");
  /* QUAD, flash off, and CAM3 not answering: the strip's count on something
   * other than 4/4, and draw_shoot()'s no-picture branch - the pane that says
   * NO CAMERA - which no screenshot has ever contained either. */
  g_flash_mode = "off";
  g_mode = "quad";
  g_vf_dead = 1u << 2;
  SHOT(SCR_SHOOT, "shoot_quad_flash_off");
  g_vf_dead = 0;
  g_flash_mode = "auto";
  g_mode = "wiggle";

  /* The back button held down, over a bright scene. It is the only control on
   * the screen and its press was an ink change on a fade until 0.4.17. */
  s_pressed = SH_IT_BACK;
  SHOT(SCR_SHOOT, "shoot_back_pressed");
  s_pressed = -1;

  /* ---- capture feedback, over the viewfinder it will most often cover ---- */
  s_screen = SCR_SHOOT;
  g_stage = CAPTURE_READING;
  scan_conditions();
  draw_screen();
  shot("capture_running");

  g_stage = CAPTURE_DONE;
  memset(&g_report, 0, sizeof g_report);
  g_report.ok = true;
  snprintf(g_report.id, sizeof g_report.id, "CAP_000042");
  g_report.stored = 4;
  g_report.online = 4;
  g_report.bytes = 1043 * 1024;
  g_report.total_ms = 3120;
  scan_conditions();
  draw_screen();
  shot("capture_saved");

  g_report.stored = 3;
  scan_conditions();
  draw_screen();
  shot("capture_partial");

  g_report.ok = false;
  snprintf(g_report.err_code, sizeof g_report.err_code, "CARD FULL");
  scan_conditions();
  draw_screen();
  shot("capture_failed");
  g_stage = CAPTURE_IDLE;

  /* ---- the destinations ---- */
  SHOT(SCR_LOOK, "look_colour");
  g_mono = true;
  SHOT(SCR_LOOK, "look_bw");
  g_mono = false;

  /* The look picker on a custom-named look, and the QUAD variant with its
   * TARGET row - the only two states the screen has that the default one does
   * not show. QUAD is the taller of the two and the one whose footnotes come
   * closest to the bottom edge. */
  /* A look that sets only three of the five sensor knobs, so the detail strip
   * is photographed with NOT SET columns beside real numbers. */
  g_look = "flash-digi";
  SHOT(SCR_LOOK, "look_picked");
  /* And a look with no capture block at all - the strip's other branch. */
  g_look = "raw-digi";
  SHOT(SCR_LOOK, "look_no_capture");
  g_look = "flash-digi";
  g_mode = "quad";
  s_look_target = 2; /* CAM2, so the row is not drawn on its first segment */
  SHOT(SCR_LOOK, "look_quad_target");

  /* QUAD with target ALL and one camera on a different look: the picker says
   * MIXED and the detail strip has no single set of numbers to show. */
  s_look_target = 0;
  g_mixed_slots = true;
  SHOT(SCR_LOOK, "look_quad_mixed");
  g_mixed_slots = false;

  g_mode = "wiggle";
  g_look = "party-neg";

  /* The LOOK screen's own focus and press, which is where the segmented bands,
   * the picker buttons and a group box's top edge all meet: the dotted
   * rectangle has to read inside a 40 px button that is itself inside an etched
   * frame, and at 1 px that is only judgeable as a picture. */
  s_focus_shown = true;
  s_focus[SCR_LOOK] = LK_IT_NEXT;
  s_pressed = LK_IT_FLASH + 1; /* FLASH / ON, held */
  SHOT(SCR_LOOK, "look_focus_pressed");
  s_pressed = -1;
  s_focus_shown = false;

  s_focus[SCR_GALLERY] = 0;
  SHOT(SCR_GALLERY, "gallery");

  /* A tile focused and a different tile held. The press used to be a dotted
   * rectangle over the photograph and is now the selection plate and a shifted
   * caption, so the two states have to be distinguishable side by side. */
  s_focus_shown = true;
  s_focus[SCR_GALLERY] = 1;
  s_pressed = 4;
  SHOT(SCR_GALLERY, "gallery_focus_pressed");
  s_pressed = -1;
  s_focus_shown = false;
  s_focus[SCR_GALLERY] = 0;

  g_fake_total = 0;
  SHOT(SCR_GALLERY, "gallery_empty");
  g_fake_total = 14;

  /* ---- Roll: every state it has, because they are what the screen is for ----
   *
   * These are the only pictures of the Roll screen that exist. No board has
   * ever had a Roll assigned, and the QR in particular has never been on a
   * panel — so `roll_active` is where the symbol, its quiet zone and its
   * pitch get reviewed at all. */
  SHOT(SCR_ROLL, "roll");

  g_roll_active = true;
  snprintf(g_roll.roll_id, sizeof g_roll.roll_id, "rol_8Fk2QmZ1pTx9vB3nLr4wYs");
  snprintf(g_roll.slug, sizeof g_roll.slug, "K7M2QP");
  snprintf(g_roll.guest_url, sizeof g_roll.guest_url, "https://kino.acronym.sk/r/K7M2QP");
  snprintf(g_roll.name, sizeof g_roll.name, "FRIDAY PARTY");
  g_roll.role = ROLL_ROLE_HOST;
  g_roll.joined_at_ms = 1787000000000LL;

  /* Online and caught up: everything that was taken has landed, 8 s ago. */
  g_net_state = NET_IP_READY;
  g_net_routed = true;
  memset(&g_queue, 0, sizeof g_queue);
  g_queue.uploaded = 12;
  g_queue.scan_complete = true;
  g_queue.server_state = UPLOAD_SERVER_REACHABLE;
  g_queue.last_upload_ms = esp_timer_get_time() / 1000 - 8000;
  SHOT(SCR_ROLL, "roll_active");

  /* Online and working: five landed in this burst, one in flight, three
   * behind it - a bar with something to say. */
  g_queue.uploading = 1;
  g_queue.pending = 3;
  g_queue.burst_done = 5;
  g_queue.draining = true;
  g_queue.last_upload_ms = esp_timer_get_time() / 1000 - 2000;
  SHOT(SCR_ROLL, "roll_uploading");

  /* Wi-Fi gone, three waiting: saved safely on the camera, not failed. */
  g_net_state = NET_WIFI_IDLE;
  g_net_routed = true;
  memset(&g_queue, 0, sizeof g_queue);
  g_queue.pending = 3;
  g_queue.scan_complete = true;
  SHOT(SCR_ROLL, "roll_offline");

  /* Just booted: the card has not been counted yet and nothing is known to
   * be waiting. The line lasts seconds and then disappears. */
  g_net_state = NET_IP_READY;
  memset(&g_queue, 0, sizeof g_queue);
  g_queue.server_state = UPLOAD_SERVER_UNKNOWN;
  SHOT(SCR_ROLL, "roll_counting");

  /* Wi-Fi up, the server not answering: a different word from OFFLINE, and
   * still nothing a guest should read as a failed photograph. */
  memset(&g_queue, 0, sizeof g_queue);
  g_queue.pending = 2;
  g_queue.scan_complete = true;
  g_queue.server_state = UPLOAD_SERVER_UNREACHABLE;
  SHOT(SCR_ROLL, "roll_server_quiet");

  /* Stopped on a credential fault, which is not the same as failed. */
  memset(&g_queue, 0, sizeof g_queue);
  g_queue.halted = true;
  g_queue.pending = 8;
  g_queue.scan_complete = true;
  snprintf(g_queue.last_error, sizeof g_queue.last_error, "INVALID_DEVICE_TOKEN");
  SHOT(SCR_ROLL, "roll_paused");

  /* A guest URL too long to encode: the code is shown as text instead of a
   * QR-shaped block no phone can read. */
  memset(&g_queue, 0, sizeof g_queue);
  memset(g_roll.guest_url, 'x', sizeof g_roll.guest_url - 1);
  g_roll.guest_url[sizeof g_roll.guest_url - 1] = '\0';
  SHOT(SCR_ROLL, "roll_qr_failed");

  g_roll_active = false;
  memset(&g_queue, 0, sizeof g_queue);

  /* ---- settings and its children ---- */
  SHOT(SCR_SETTINGS, "settings");

  /* A list row focused and a list row held. Rows had no press state at all
   * until now - pressing "Connection" put nothing on screen between the finger
   * landing and the next screen arriving - and the focus rectangle inside a
   * navy row is drawn in white, which is a case no other control has. */
  s_focus_shown = true;
  s_focus[SCR_SETTINGS] = 1;
  s_pressed = 3;
  SHOT(SCR_SETTINGS, "settings_focus_pressed");
  s_pressed = -1;
  s_focus_shown = false;
  s_focus[SCR_SETTINGS] = 0;

  /* The header's back button held. It is the one control every detail screen
   * shares, and the only picture of it pressed. */
  s_pressed = IT_BACK;
  SHOT(SCR_SETTINGS, "settings_back_pressed");
  s_pressed = -1;

  SHOT(SCR_DISPLAY, "settings_display");
  /* The two rows issue #144 added, on the two segments that had no way of
   * being selected before it: HOLD and NEVER. Both are drawn pushed in, so
   * this is also the check that a five-segment band and a three-segment band
   * line up down the same left edge. */
  g_after_shot_s = -1;
  g_cam_idle_s = 0;
  SHOT(SCR_DISPLAY, "settings_display_hold_never");
  g_after_shot_s = 2;
  g_cam_idle_s = 300;
  SHOT(SCR_SOUND, "settings_sound");
  /* A custom clip in the picker: the longest name the row has to fit, and the
   * only proof the card's clips reach the built-ins' list at all. */
  g_shutter_sound = "snd-polaroid";
  SHOT(SCR_SOUND, "settings_sound_custom_clip");
  g_shutter_sound = "click";
  /* The body whose I2S never started. The controls are still drawn - the
   * settings are stored either way - and the footer is what says so. */
  g_audio_ready = false;
  SHOT(SCR_SOUND, "settings_sound_no_audio");
  g_audio_ready = true;

  /* Connection in the three states that matter. The first is this body:
   * the radio is fitted and there is no route to it, which is exactly the
   * distinction the old "Not fitted" screen destroyed. */
  g_saved_networks = 2;
  SHOT(SCR_CONNECTION, "settings_connection");

  g_net_state = NET_WIFI_IDLE;
  g_net_routed = true;
  SHOT(SCR_CONNECTION, "settings_connection_disconnected");

  g_net_state = NET_IP_READY;
  SHOT(SCR_CONNECTION, "settings_connection_online");

  g_net_state = NET_C6_NOT_ROUTED;
  g_net_routed = false;
  g_saved_networks = 0;
  SHOT(SCR_STORAGE, "settings_storage");
  /* The destructive row held, which is the state a finger is in for the moment
   * before the confirmation appears. Also the only shot in which the capacity
   * gauge and a lit row are on screen together. */
  s_focus_shown = true;
  s_focus[SCR_STORAGE] = ST_IT_DELETE_ALL;
  s_pressed = ST_IT_DELETE_ALL;
  SHOT(SCR_STORAGE, "settings_storage_pressed");
  s_pressed = -1;
  s_focus_shown = false;
  s_focus[SCR_STORAGE] = 0;
  /* A card the driver has tried and failed to mount, which is a different
   * screen from an empty slot and used to show the same "None" as one. */
  g_card_mounted = false;
  SHOT(SCR_STORAGE, "settings_storage_unmounted");
  g_card_mounted = true;
  SHOT(SCR_STATUS, "settings_status");
  SHOT(SCR_ABOUT, "settings_about");
  /* With a name set: a fourth row appears above Device and the list frame
   * grows by one. The longest name SET_CONFIG accepts, so the row is
   * photographed at the width it will really have to hold. */
  g_body_name = "ALEX BACK-ROOM CAMERA 02";
  SHOT(SCR_ABOUT, "settings_about_named");
  g_body_name = "";

  /* ---- power, and both confirmations ---- */
  SHOT(SCR_POWER, "power");
  /* The rows moved 12 px down into the list well to meet the hit rectangles
   * that were always there, so this is the shot that proves the three rows and
   * the well line up - and the disabled row's grey against a focused row's
   * navy in one frame. */
  s_focus_shown = true;
  s_focus[SCR_POWER] = 1;
  SHOT(SCR_POWER, "power_focus");
  s_focus_shown = false;
  s_focus[SCR_POWER] = 0;
  s_screen = SCR_POWER;
  s_dialog = DLG_RESTART;
  s_dlg_focus = 0;
  scan_conditions();
  draw_screen();
  shot("power_restart_confirm");
  s_dialog = DLG_NONE;
  /* The two erasures behind a confirm: the camera's own factory reset and
   * the card format, both with focus on CANCEL. */
  s_dialog = DLG_FACTORY;
  s_dlg_focus = 0;
  draw_screen();
  shot("power_factory_confirm");
  s_dialog = DLG_NONE;
  s_screen = SCR_STORAGE;
  s_dialog = DLG_FORMAT;
  s_dlg_focus = 0;
  draw_screen();
  shot("settings_storage_format_confirm");
  s_dialog = DLG_NONE;

  /* ---- a single photograph, and the delete confirmation over it ---- */
  {
    const gallery_item_t *slots = gallery_slots();
    photo_open(&slots[0]);
    /* The preview has no card, so the decode fails and the view renders its
     * own empty state - which is itself a state worth having a picture of. */
    s_focus[SCR_PHOTO] = P_IT_DELETE;
    SHOT(SCR_PHOTO, "photo");
    /* The favourite control in both states. Set directly rather than through
     * photo_toggle_favourite(), which would take the card and raise a toast -
     * this is a picture of the button, not of the write path. */
    s_photo_fav = true;
    s_focus[SCR_PHOTO] = P_IT_FAV;
    SHOT(SCR_PHOTO, "photo_favourite");
    s_photo_fav = false;
    s_focus[SCR_PHOTO] = P_IT_DELETE;
    s_dialog = DLG_DELETE;
    s_dlg_focus = 0;
    scan_conditions();
  draw_screen();
    shot("photo_delete_confirm");
    s_dialog = DLG_NONE;
    photo_release();
  }

  /* ---- the same photograph, playing (#160) ----
   *
   * Two shots, because the two things worth looking at are different: that a
   * frame of the swing is a different picture from the still, and that a
   * capture missing a frame says so without moving anything else.
   *
   * The chrome around the well - the sunken bevel, the caption, the three
   * buttons, the focus ring - is drawn by exactly the code the static shots
   * use, and the diff against them is the check that an animating picture
   * changed nothing but the picture.
   */
  {
    const gallery_item_t *slots = gallery_slots();
    g_stage = CAPTURE_IDLE; /* wiggle_tick() pauses for a capture, as it must */

    /* slots[0] is a wiggle of four frames. */
    g_frame_have = 0xf;
    photo_open(&slots[0]);
    /* One tick starts playback: ui_task calls this every pass, and the fake
     * card above answers the whole job in the first one. */
    wiggle_tick();
    /* Mid-cycle, set directly rather than by waiting out three frame periods -
     * this is a picture of a frame of the swing, not of the clock. Position 2
     * of the default bounce order 0,1,2,3,2,1 is C3, so a diff against the
     * static "photo" shot is the near object having moved. */
    s_wig_pos = 2;
    s_focus[SCR_PHOTO] = P_IT_DELETE;
    SHOT(SCR_PHOTO, "photo_wiggle_playing");
    photo_release();

    /* Three frames of four: C2 never reached the card. The swing is
     * C1 -> C3 -> C4 -> C3, and position 2 is C4 - the far end of a swing that
     * is short one lens, which is the frame this shot is about. */
    g_frame_have = 0xd;
    photo_open(&slots[0]);
    wiggle_tick();
    s_wig_pos = 2;
    SHOT(SCR_PHOTO, "photo_partial");
    photo_release();
    g_frame_have = 0xf;

    /* ---- a quad, opened: all four looks at once ----
     *
     * slots[2] is a quad of four frames. The one tick completes the job and
     * the grid replaces the still: four half-size frames in reading order,
     * C1 top-left to C4 bottom-right. The chrome is the photograph screen's
     * own, so a diff against "photo" is the well and nothing else. The partial
     * shot has C3 missing and shows the hole where C3 belongs, named, with the
     * other three exactly where they were. */
    photo_open(&slots[2]);
    wiggle_tick();
    s_focus[SCR_PHOTO] = P_IT_DELETE;
    SHOT(SCR_PHOTO, "photo_quad");
    photo_release();

    g_frame_have = 0xb;
    photo_open(&slots[2]);
    wiggle_tick();
    SHOT(SCR_PHOTO, "photo_quad_partial");
    photo_release();
    g_frame_have = 0xf;
  }

  /* ---- the crossfade and the alignment (#161) ----
   *
   * The two mechanisms that stop the swing reading as images jumping, and the
   * two things a render can actually settle. Both are diffed against
   * photo_wiggle_playing above, which is the same photograph at the same
   * position with neither applied - so the difference in each file IS the
   * mechanism, and every pixel of chrome outside the well must be identical.
   */
  {
    const gallery_item_t *slots = gallery_slots();
    g_stage = CAPTURE_IDLE;
    g_frame_have = 0xf;

    /*
     * An aligned frame, from a calibration this harness invents.
     *
     * A real calibration is a few sensor pixels and would move this picture by
     * well under a pixel - a truthful render, and a useless one. So these
     * offsets are sized to cancel the harness's own exaggerated 34 px-per-lens
     * bar exactly, which makes the render answer the one question worth asking:
     * does the subject stop lurching between the four lens positions. dx is
     * offset.x scaled by PH_W/1600, so -34 px per lens needs about -117 sensor
     * px per lens. The visible crop-and-zoom is the overlap crop doing its job
     * at that caricature's scale, not a defect.
     *
     * Position 2 is C3, the same frame photo_wiggle_playing shows unaligned, so
     * the bar has moved back to where C1 put it while the background gradient
     * has been cropped and rescaled.
     */
    for (int c = 0; c < PURE_WIGGLE_FRAMES_MAX; c++) {
      g_slot[0].cal[c].x = -34.0 * c / ((double)PH_W / (double)PURE_ALIGN_SENSOR_BASE_W);
      g_slot[0].cal[c].y = 0.0;
      g_slot[0].cal[c].rot = 0.0;
    }
    g_slot[0].cal_present = true;
    photo_open(&slots[0]);
    wiggle_tick();
    s_wig_pos = 2;
    SHOT(SCR_PHOTO, "photo_wiggle_aligned");
    photo_release();
    /* Off again: no capture on any card carries a calibration block, so every
     * other render must show the un-aligned path. */
    g_slot[0].cal_present = false;
  }

  /* The boot field at full reach, in the two states that matter: every camera
   * answered, and two of them not. The second is the whole reason the field
   * is drawn from the cameras rather than from a clock - a body with a dead
   * node says so on the screen it shows first. */
  {
    for (int q = 0; q < 4; q++) s_bf_cam[q] = 1.0f;
    fill(0, 0, UI_W, UI_H, MZ_GROUND);
    boot_field(BF_REACH, 900, 0, 1.0f);
    shot("boot_field_all_four");

    s_bf_cam[1] = s_bf_cam[3] = BF_DARK;
    fill(0, 0, UI_W, UI_H, MZ_GROUND);
    boot_field(BF_REACH, 900, 0, 1.0f);
    shot("boot_field_two_silent");
    for (int q = 0; q < 4; q++) s_bf_cam[q] = 1.0f;
  }

  /* What the camera shows while it is going away: its own mark, centred,
   * and then the screen letting go of it. Same picture for a restart. */
  {
    fill(0, 0, UI_W, UI_H, MZ_GROUND);
    boot_mark();
    shot("power_down");
    fill(0, 0, UI_W, UI_H, MZ_GROUND);
    boot_mark();
    scrim(0, 0, UI_W, UI_H, RGB(0x00, 0x00, 0x00), 4 * 255 / 7);
    shot("power_down_fading");
  }

  /* ---- a toast, which every screen can raise ---- */
  /* On the menu it is the status bar's message. It used to float 44 px off the
   * bottom, which put it across the SETTINGS tile's label - a tooltip covering
   * the control that raised it, and this shot is the one that showed it. */
  s_screen = SCR_MENU;
  toast("Mode: Quad");
  scan_conditions();
  draw_screen();
  shot("toast");

  /* The same band on the gallery, where the footer's two buttons sit. Every
   * message this screen raises is "Card busy", and the point of the shot is
   * that it lands between PREV and NEXT rather than on either. */
  s_screen = SCR_GALLERY;
  toast("Card busy");
  scan_conditions();
  draw_screen();
  shot("toast_gallery");

  if (g_write_failed) {
    fprintf(stderr, "one or more screens were not written\n");
    return 1;
  }
  /* ---- what a frame costs ---- */
  printf("\nframe cost (1.00 screen = 800x480 opaque; blends count double)\n");
  {
    static const struct { screen_t sc; const char *name; } S[] = {
        {SCR_MENU, "MENU"},      {SCR_SHOOT, "SHOOT"},   {SCR_GALLERY, "GALLERY"},
        {SCR_LOOK, "LOOK"},      {SCR_ROLL, "ROLL"},     {SCR_PHOTO, "PHOTO"},
        {SCR_SETTINGS, "SETTINGS"}, {SCR_ABOUT, "ABOUT"},
    };
    printf("\n  a still frame, by screen\n");
    for (size_t i = 0; i < sizeof S / sizeof S[0]; i++) {
      s_screen = S[i].sc;
      scan_conditions();
      bench_reset();
      draw_screen();
      bench_line(S[i].name, bench_screens());
    }
  }

  /* Across a transition, frame by frame: the average is not the problem, the
   * SHAPE is. A move whose last frame costs four times its first stutters at
   * the end however good the average looks. */
  {
    printf("\n  the menu opening, frame by frame\n");
    double lo = 1e9, hi = 0, sum = 0;
    s_screen = SCR_MENU;
    s_pressed = 2;
    scan_conditions();
    draw_screen();
    g_anim = "bench";  /* suppress the audit; frames leave the safe area */
    g_anim_n = 0;
    prev_vclock_us = 1000000;
    bench_reset();
    double prev = 0;
    for (int f = 0; f < 24; f++) {
      const float t = (float)f / 24.0f;
      bench_reset();
      open_frame(2, t);
      const double c = bench_screens();
      if (f == 0 || f == 8 || f == 16 || f == 23) {
        char lbl[32];
        snprintf(lbl, sizeof lbl, "t=%.2f", (double)t);
        bench_line(lbl, c);
      }
      if (c < lo) lo = c;
      if (c > hi) hi = c;
      sum += c;
      prev = c;
    }
    (void)prev;
    prev_vclock_us = 0;
    g_anim = NULL;
    printf("    -> min %.2f  max %.2f  mean %.2f  spread %.1fx\n", lo, hi, sum / 24.0,
           hi / (lo > 0.01 ? lo : 0.01));
  }

  /* The splash, which is the one the eye judges first and the one whose cost
   * grows fastest: each ring out adds a whole ring of cells. */
  {
    printf("\n  the boot field, frame by frame\n");
    double lo = 1e9, hi = 0, sum = 0;
    for (int f = 0; f <= 16; f++) {
      const float reach = ease_ui((float)f / 16.0f) * BF_REACH;
      bench_reset();
      fill(0, 0, UI_W, UI_H, MZ_GROUND);
      for (int q = 0; q < 4; q++) s_bf_cam[q] = 1.0f;
      boot_field(reach, 0, 0, 1.0f);
      const double c = bench_screens();
      if (f == 0 || f == 8 || f == 16) {
        char lbl[32];
        snprintf(lbl, sizeof lbl, "reach %.0f px", (double)reach);
        bench_line(lbl, c);
      }
      if (c < lo) lo = c;
      if (c > hi) hi = c;
      sum += c;
    }
    printf("    -> min %.2f  max %.2f  mean %.2f  spread %.1fx\n", lo, hi, sum / 17.0,
           hi / (lo > 0.01 ? lo : 0.01));
  }

  if (audit_report() > 0) return 1;
  return 0;
}
