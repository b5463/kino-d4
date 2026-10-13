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
 *
 * Every scene is rendered twice, once per hand (body.hand): the PPMs in out/
 * are the right-handed body and the ones in out/left/ the left. Each hand
 * runs in its own forked process from the same starting state, so the second
 * pass cannot inherit a toast, a dialog or a stub value from the first.
 *
 *   preview <out>               render, audit, exit non-zero on a failure
 *   preview --ppms              print how many PPMs a run writes (both hands)
 */
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

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
/* Canvas pixels a picture was blitted into this frame (ui_audit_image): the
 * contrast audit does not judge type set on a photograph or the finder. */
static uint8_t g_img_mask[UI_W * UI_H];

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
/* The idle clock (shim/esp_timer.h): a body that has been up 2 h 14 min. */
int64_t prev_idle_clock_us = 8040LL * 1000000;
static const char *g_anim;
static int g_anim_n;

/* Called on every presented frame and every stash render while set:
 * check_wake_into_move() reads the scrim each frame was drawn under. */
static void (*g_frame_hook)(bool stash);

void gfx_present(void) {
  if (g_frame_hook != NULL) g_frame_hook(false);
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
/* One slide frame is one panel frame on the camera, so it moves the
 * renderer's clock like a present; without it a slide driven on that clock
 * never ends. */
void gfx_slide_show(int o, int b, bool from_right) {
  (void)o;
  (void)b;
  (void)from_right;
  if (prev_vclock_us != 0) prev_vclock_us += prev_vclock_step_us;
}
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
  if (g_frame_hook != NULL) g_frame_hook(true);
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
  memset(g_img_mask, 0, sizeof g_img_mask);
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
/* Counted, so check_shutter_sound() can say which sound a press made. */
static int g_shutter_n, g_warning_n;
void audio_shutter(void) { g_shutter_n++; }
void audio_tick(void) {}
void audio_warning(void) { g_warning_n++; }
/* ui_pass() calls these; check_wake_into_move() drives ui_pass. */
void audio_done(void) {}
void audio_sync(void) {}

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
/* body.hand, set once per forked pass by main(). ui.c reads it at the top of
 * every render_screen(), so every scene is drawn for the hand of its pass. */
static const char *g_hand = "right";

const char *config_str(const char *path, const char *fallback) {
  if (strcmp(path, "body.name") == 0) return g_body_name;
  if (strcmp(path, "body.hand") == 0) return g_hand;
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
 * has to resolve, because ui.c calls it. check_shutter_sound() drives both
 * answers, and the pipeline that did not start. */
static bool g_capture_accept;
static bool g_capture_ready = true;
bool capture_request(const char *source) {
  (void)source;
  return g_capture_accept;
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
/* Ready here: the renderer has no pipeline to fail, and a screen that only
 * appears when one did is driven by its own scene. check_shutter_sound()
 * clears it for the refused press. */
bool capture_ready(void) { return g_capture_ready; }
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
/*
 * Whether this body has a Roll server to upload to.
 *
 * The stub used to write an empty string and return true, which is a state no
 * camera can be in: the real one returns false when there is no compiled
 * default and Studio has set no `network.apiBase`. Returning true meant the
 * condition behind it - "Uploads have no server", the row 0.4.59 added after a
 * soak parked 34 uploads for exactly this reason (#198) - could never draw
 * here, even once the radio flag was on.
 */
static bool g_roll_server = true;
bool roll_http_api_base(char *out, size_t cap) {
  if (!g_roll_server) return false;
  snprintf(out, cap, "https://kino.acronym.sk/api");
  return true;
}
int64_t clock_now_ms(void) { return 1790006498000LL; } /* 2026-09-21T16:01Z */
/* DELETE ALL in progress, for the one scene that shows the Photos row
 * counting down. Off everywhere else. */
static bool g_deleting;
static int g_delete_done, g_delete_total;
bool gallery_deleting(void) { return g_deleting; }
void gallery_delete_progress(int *done, int *total) {
  if (done != NULL) *done = g_delete_done;
  if (total != NULL) *total = g_delete_total;
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

/* The stage power_get() reports. AWAKE for every scene; the move checks set
 * DIM to hold a dim that is still arriving. */
static power_stage_t g_power_stage = POWER_AWAKE;
void power_activity(void) {}
void power_wake(void) {}
bool power_sleep_pending(void) { return false; }
void power_sleep_shown(void) {}
void power_cam_bank_cycle(void) {}
bool power_wake_gesture(void) { return false; }
void power_end_wake_gesture(void) {}
void power_get(power_state_t *out) {
  if (out == NULL) return;
  out->stage = g_power_stage;
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

/* Per-camera, for the About screen's CAMERAS column and the menu card's
 * four-mark.
 *
 * CAM1 and CAM3 answer and CAM2 and CAM4 do not, deliberately: this body has
 * one camera fitted today, and a screenshot in which all four rows look the
 * same would not show whether the online and offline rows are distinguishable
 * at a glance. CAM3 carries a different node version because nodes are
 * reflashed one at a time, which is exactly why this is four rows.
 * g_cam_online is the set that answers, bit i for CAM(i+1); a scene that
 * needs another set changes it and puts it back. */
static unsigned g_cam_online = 0x5u;
void camlink_get_info_ch(int cam, camlink_info_t *out) {
  memset(out, 0, sizeof *out);
  if (cam < 0 || cam > 3 || !(g_cam_online & (1u << cam))) return;
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
/* With g_card_mounted false: true is a card the driver failed to mount, false
 * is an empty slot or a pulled card. storage.c reports the second as not
 * present with CARD_REMOVED (or a mount error from boot) set. */
static bool g_card_present = true;

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
    out->present = g_card_present;
    out->mounted = false;
    out->mount_attempts = 3;
    out->last_error = g_card_present ? "MOUNT_FAILED" : "CARD_REMOVED";
    out->removed = !g_card_present;
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
 * pass, which keeps the once-per-pass caches in ui.c honest.
 *
 * It also marks the canvas as a screen with a hit map, so shot() sweeps the
 * touch targets of exactly the scenes that have them (not the boot field or
 * the power-down mark, which are drawn directly). */
static bool g_screen_drawn;
#define draw_screen() (ui_render(render_screen, NULL), g_screen_drawn = true)

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

/* ---- the contrast audit (#176, C7 folded into UI-01) ----
 *
 * text() hands every string it draws to ui_audit_ink() just before its glyphs
 * land, so the canvas under them is the ground the string is actually set on:
 * a plate, a row, a pressed face, a scrim - whatever the frame put there, and
 * not what the drawing code believed it put there. The ink is the colour
 * text() was asked for.
 *
 * The ground is read under the glyphs' solid pixels (coverage >= 128), and
 * the string is judged against the worst colour that makes up at least a
 * tenth of them - a row edge under one letter is not the ground, a plate
 * under half the word is. Contrast is WCAG on the RGB565 value, through ui.c's
 * own rel_lum(), so the numbers here are the numbers the palette work uses.
 *
 * The floor is 4.5:1, and 3:1 for large type. "Large" is WCAG's 18 pt, which
 * is 6.35 mm, and at this panel's 8.5 px/mm that is 54 px of type: only XL
 * (75 px line) is that big. The 24-32 px faces are 2.8-3.8 mm tall on the
 * glass, which is small print, so they carry the small-print floor.
 *
 * A string whose ground is a picture - a blit of a photograph or a finder
 * pane (ui_audit_image) that is not flat under the string - is counted and
 * skipped: its contrast is the scene's, not the palette's.
 */
#define AUDIT_LARGE_LINE_H 64 /* XL's 75 px line; L is 41 */
#define AUDIT_FLOOR 4.5f
#define AUDIT_FLOOR_LARGE 3.0f
static bool g_audit_off; /* the frame-cost bench redraws scenes already judged */

void ui_audit_image(int x, int y, int w, int h) {
  const gfx_target_t *t = TG;
  for (int r = y; r < y + h; r++) {
    if (r < t->y0 || r >= CV_Y1(t)) continue;
    for (int c = x; c < x + w; c++) {
      if (c < t->x0 || c >= CV_X1(t)) continue;
      const uint16_t *p = cv_ptr(t, c, r);
      if (p < g_canvas || p >= g_canvas + (size_t)UI_W * UI_H) return; /* a stash, not the frame */
      g_img_mask[p - g_canvas] = 1;
    }
  }
}

#define CONTRAST_MAX 160
static struct {
  char s[64];
  uint16_t ink, ground;
  float ratio, floor;
  char screen[32];
} g_contrast[CONTRAST_MAX];
static int g_contrast_n;
static int g_judged_n;     /* string draws measured */
static int g_over_image_n; /* string draws skipped: set on a picture */

/* ---- the type-role audit (F2) ----
 *
 * Caps belong to the display face and sentences to the reading face: Oxanium
 * sets T, R, L and XL, Inter sets S and M (ui_theme.h). A word set in
 * capitals in Inter is the one mix the roles forbid, and it is what the menu
 * labels, the segments and every caps value on a row used to be.
 *
 * A string counts as capitals when it has no lowercase letter, at least two
 * letters, and the letters are at least half of what is not a space. That
 * keeps a reading like "29.7 GB" or "0.9.0  OV3660", a number with a unit,
 * in the reading face beside the numbers it sits with. ui.c decides the same
 * way (is_caps), so a value that arrives as data lands in the right face. */
#define CAPS_MAX 64
static struct {
  char s[64];
  char face;
  char screen[32];
} g_caps[CAPS_MAX];
static int g_caps_n;

static void caps_audit(const ui_font_t *f, const char *s) {
  if (f != &UI_FONT_S && f != &UI_FONT_M) return;
  if (!is_caps(s)) return;
  for (int i = 0; i < g_caps_n; i++) {
    if (strncmp(g_caps[i].s, s, sizeof g_caps[0].s - 1) == 0) return;
  }
  if (g_caps_n >= CAPS_MAX) return;
  snprintf(g_caps[g_caps_n].s, sizeof g_caps[0].s, "%s", s);
  g_caps[g_caps_n].face = f == &UI_FONT_S ? 'S' : 'M';
  g_caps[g_caps_n].screen[0] = '\0';
  g_caps_n++;
}

static int caps_report(void) {
  if (g_caps_n == 0) return 0;
  fprintf(stderr, "\n%d string%s in capitals set in an Inter face (caps in Inter):\n", g_caps_n,
          g_caps_n == 1 ? "" : "s");
  for (int i = 0; i < g_caps_n; i++) {
    fprintf(stderr, "  %-30s %c  \"%s\"\n", g_caps[i].screen[0] != '\0' ? g_caps[i].screen : "?",
            g_caps[i].face, g_caps[i].s);
  }
  return g_caps_n;
}

/* ---- the dropped-glyph audit (F1) ----
 *
 * tools/subset-font.mjs cuts a face down to the letters the interface sets in
 * it: XL keeps " HOST", for SHOOT on the menu card, and every other glyph is
 * NULL with its advance kept. A string that later sets another letter in XL
 * draws a gap the width of that letter, which on a screenshot reads as a
 * typo and on the glass as a broken camera. Every string text() draws comes
 * through here, moves included: a character that is not a space and has no
 * coverage in its face fails the run, named with the face and the string. */
#define NULLG_MAX 32
static struct {
  char s[64];
  char ch;
  const char *face;
  char screen[32];
} g_nullg[NULLG_MAX];
static int g_nullg_n;

static const char *face_name(const ui_font_t *f) {
  if (f == &UI_FONT_T) return "T";
  if (f == &UI_FONT_S) return "S";
  if (f == &UI_FONT_R) return "R";
  if (f == &UI_FONT_M) return "M";
  if (f == &UI_FONT_L) return "L";
  if (f == &UI_FONT_XL) return "XL";
  return "?";
}

static void null_glyph_audit(const ui_font_t *f, const char *s) {
  for (const char *q = s; *q; q++) {
    if (*q == ' ') continue;
    const int gi = (unsigned char)*q - f->first;
    if (gi >= 0 && gi < f->count && f->glyphs[gi].cov != NULL) continue;
    for (int i = 0; i < g_nullg_n; i++) {
      if (g_nullg[i].face == face_name(f) && strncmp(g_nullg[i].s, s, sizeof g_nullg[0].s - 1) == 0)
        return;
    }
    if (g_nullg_n >= NULLG_MAX) return;
    snprintf(g_nullg[g_nullg_n].s, sizeof g_nullg[0].s, "%s", s);
    g_nullg[g_nullg_n].ch = *q;
    g_nullg[g_nullg_n].face = face_name(f);
    g_nullg[g_nullg_n].screen[0] = '\0';
    g_nullg_n++;
    return;
  }
}

static int null_glyph_report(void) {
  if (g_nullg_n == 0) return 0;
  fprintf(stderr, "\n%d string%s set a letter its face does not carry (NULL GLYPH):\n", g_nullg_n,
          g_nullg_n == 1 ? "" : "s");
  for (int i = 0; i < g_nullg_n; i++) {
    fprintf(stderr, "  %-30s %-2s '%c'  \"%s\"\n",
            g_nullg[i].screen[0] != '\0' ? g_nullg[i].screen : "?", g_nullg[i].face, g_nullg[i].ch,
            g_nullg[i].s);
  }
  return g_nullg_n;
}

void ui_audit_ink(const ui_font_t *f, int x, int y, const char *s, uint16_t ink) {
  null_glyph_audit(f, s);
  if (g_anim != NULL || g_audit_off) return;
  caps_audit(f, s);
  const gfx_target_t *t = TG;
  struct { uint16_t c; int n; } hist[24];
  int nh = 0, total = 0, on_image = 0;
  bool many = false;
  const int baseline = y + f->ascent;
  int pen = x;
  for (const char *q = s; *q; q++) {
    const int gi = (unsigned char)*q - f->first;
    if (gi < 0 || gi >= f->count) continue;
    const ui_glyph_t *g = &f->glyphs[gi];
    const int gx = pen + g->bx, gy = baseline - g->by;
    pen += g->adv;
    if (g->cov == NULL) continue;
    for (int r = 0; r < g->h; r++) {
      const int py = gy + r;
      if (py < t->y0 || py >= CV_Y1(t)) continue;
      for (int c = 0; c < g->w; c++) {
        const int px = gx + c;
        if (px < t->x0 || px >= CV_X1(t) || g->cov[r * g->w + c] < 128) continue;
        const uint16_t *p = cv_ptr(t, px, py);
        if (p < g_canvas || p >= g_canvas + (size_t)UI_W * UI_H) return; /* not the frame */
        total++;
        if (g_img_mask[p - g_canvas]) on_image++;
        int k = 0;
        while (k < nh && hist[k].c != *p) k++;
        if (k == nh) {
          if (nh == (int)(sizeof hist / sizeof hist[0])) { many = true; continue; }
          hist[nh].c = *p;
          hist[nh].n = 0;
          nh++;
        }
        hist[k].n++;
      }
    }
  }
  if (total == 0) return;
  int top = 0;
  for (int k = 1; k < nh; k++) if (hist[k].n > hist[top].n) top = k;
  const bool flat = !many && hist[top].n * 10 >= total * 9;
  if (on_image > 0 && !flat) {
    g_over_image_n++;
    return;
  }
  g_judged_n++;
  /* The worst ground that is a real share of the string's footprint. */
  float worst = 1e9f;
  uint16_t ground = hist[top].c;
  for (int k = 0; k < nh; k++) {
    if (hist[k].n * 10 < total) continue;
    const float cr = contrast(ink, hist[k].c);
    if (cr < worst) { worst = cr; ground = hist[k].c; }
  }
  const float floor = f->line_h >= AUDIT_LARGE_LINE_H ? AUDIT_FLOOR_LARGE : AUDIT_FLOOR;
  if (worst >= floor) return;
  for (int i = 0; i < g_contrast_n; i++) {
    if (g_contrast[i].ink == ink && g_contrast[i].ground == ground &&
        strncmp(g_contrast[i].s, s, sizeof g_contrast[0].s - 1) == 0) return;
  }
  if (g_contrast_n >= CONTRAST_MAX) return;
  snprintf(g_contrast[g_contrast_n].s, sizeof g_contrast[0].s, "%s", s);
  g_contrast[g_contrast_n].ink = ink;
  g_contrast[g_contrast_n].ground = ground;
  g_contrast[g_contrast_n].ratio = worst;
  g_contrast[g_contrast_n].floor = floor;
  g_contrast[g_contrast_n].screen[0] = '\0';
  g_contrast_n++;
}

/* RGB565 as the 8-bit hex the palette tables use, expanded the way rel_lum()
 * expands it (x*255/31, x*255/63) so a reported colour is the measured one. */
static void hex565(uint16_t c, char out[7]) {
  snprintf(out, 7, "%02x%02x%02x", ((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63,
           (c & 31) * 255 / 31);
}

static int contrast_report(void) {
  if (g_contrast_n == 0) return 0;
  fprintf(stderr, "\n%d string%s under the contrast floor (ink on ground, measured):\n",
          g_contrast_n, g_contrast_n == 1 ? "" : "s");
  for (int i = 0; i < g_contrast_n; i++) {
    char ink[7], gr[7];
    hex565(g_contrast[i].ink, ink);
    hex565(g_contrast[i].ground, gr);
    fprintf(stderr, "  %-30s %5.2f < %.1f  %s on %s  \"%s\"\n",
            g_contrast[i].screen[0] != '\0' ? g_contrast[i].screen : "?",
            (double)g_contrast[i].ratio, (double)g_contrast[i].floor, ink, gr, g_contrast[i].s);
  }
  return g_contrast_n;
}

/* ---- the touch-target sweep and the hand invariant ----
 *
 * After every scene that is a screen, hit_test() - with undo_hit() in front of
 * it, the order the touch handler uses - is asked about every pixel of the
 * glass. Each answer is a target, and its extent is the box of the pixels that
 * give it. A target whose box is under 52 px either way is too small for a
 * thumb on this glass (8.5 px/mm, 6.1 mm; D-U15), unless the allow-list below
 * says why it is not one.
 *
 * The same map checks the hand: a target that is chrome on the hand's side
 * (from_hand() in ui.c) must have its centre on that half of the panel, for
 * both hands. A layout that hard-codes a side passes for one hand and fails
 * here for the other.
 */
#define TARGET_MIN 52

typedef struct {
  screen_t sc;
  int dialog; /* -1: any; otherwise this dialog must be up */
  int item;
  const char *why;
} target_allow_t;

/* Targets allowed under 52 px: the screen, the item, and why a thumb is not
 * the point. None today - the SHOOT bar's 34 px band and the time-zone pair's
 * 40 px are #176 defects to fix, not exceptions. The sentinel keeps the
 * array non-empty. */
static const target_allow_t TARGET_ALLOW[] = {
    {SCR_COUNT, -1, -1, NULL},
};

/* Chrome that from_hand() puts on the hand's side. */
static const struct {
  screen_t sc;
  int item;
  const char *what;
} HAND_SIDE[] = {
    {SCR_MENU, 0, "menu card"},
    {SCR_SHOOT, SH_IT_BACK, "SHOOT back"},
    {SCR_PHOTO, IT_BACK, "PHOTO back"},
    {SCR_PHOTO, P_IT_DELETE, "PHOTO delete"},
    {SCR_PHOTO, P_IT_FAV, "PHOTO favourite"},
    {SCR_PHOTO, P_IT_ROLL, "PHOTO send"},
    {SCR_PHOTO, P_IT_PREV, "PHOTO previous"},
    {SCR_PHOTO, P_IT_NEXT, "PHOTO next"},
    {SCR_GALLERY, G_IT_PREV, "GALLERY page back"},
    {SCR_GALLERY, G_IT_NEXT, "GALLERY page on"},
    {SCR_LOOK, LK_IT_PREV, "LOOK previous"},
    {SCR_LOOK, LK_IT_NEXT, "LOOK next"},
};

#define FINDING_MAX 96
typedef struct {
  char screen[32];
  char text[96];
} finding_t;
static finding_t g_small[FINDING_MAX], g_hand_bad[FINDING_MAX];
static int g_small_n, g_hand_bad_n;

/* Deduped on the message, which names the screen, the item and its box: the
 * same short target on six scenes of one screen is one finding. */
static void finding(finding_t *list, int *n, const char *name, const char *msg) {
  for (int i = 0; i < *n; i++) {
    if (strcmp(list[i].text, msg) == 0) return;
  }
  if (*n >= FINDING_MAX) return;
  snprintf(list[*n].screen, sizeof list[0].screen, "%s", name);
  snprintf(list[*n].text, sizeof list[0].text, "%s", msg);
  (*n)++;
}

static const char *const AUDIT_SCREEN[SCR_COUNT] = {
    [SCR_MENU] = "MENU",         [SCR_SHOOT] = "SHOOT",     [SCR_GALLERY] = "GALLERY",
    [SCR_LOOK] = "LOOK",         [SCR_ROLL] = "ROLL",       [SCR_PHOTO] = "PHOTO",
    [SCR_SETTINGS] = "SETTINGS", [SCR_DISPLAY] = "DISPLAY", [SCR_SOUND] = "SOUND",
    [SCR_CONNECTION] = "CONNECTION", [SCR_STORAGE] = "STORAGE", [SCR_STATUS] = "STATUS",
    [SCR_ABOUT] = "ABOUT",       [SCR_POWER] = "POWER",
};

static void sweep_targets(const char *name) {
  struct { int id; int x0, y0, x1, y1; } reg[64];
  int nr = 0;
  /* undo_hit() reads the clock, and a sweep is 384,000 reads: hold the idle
   * clock still for it, or every scene after this one would be drawn hours
   * later than the one before it. */
  const int64_t keep = prev_idle_clock_us;
  prev_vclock_us = keep;
  for (int y = 0; y < UI_H; y++) {
    for (int x = 0; x < UI_W; x++) {
      const int id = undo_hit(x, y) ? IT_UNDO : hit_test(x, y);
      if (id < 0) continue;
      int k = 0;
      while (k < nr && reg[k].id != id) k++;
      if (k == nr) {
        if (nr == (int)(sizeof reg / sizeof reg[0])) continue;
        reg[nr].id = id;
        reg[nr].x0 = reg[nr].x1 = x;
        reg[nr].y0 = reg[nr].y1 = y;
        nr++;
      }
      if (x < reg[k].x0) reg[k].x0 = x;
      if (x > reg[k].x1) reg[k].x1 = x;
      if (y < reg[k].y0) reg[k].y0 = y;
      if (y > reg[k].y1) reg[k].y1 = y;
    }
  }
  prev_vclock_us = 0;
  prev_idle_clock_us = keep;

  const char *scr = s_screen < SCR_COUNT && AUDIT_SCREEN[s_screen] ? AUDIT_SCREEN[s_screen] : "?";
  for (int k = 0; k < nr; k++) {
    const int w = reg[k].x1 - reg[k].x0 + 1, h = reg[k].y1 - reg[k].y0 + 1;
    if (w >= TARGET_MIN && h >= TARGET_MIN) continue;
    bool allowed = false;
    for (size_t a = 0; a < sizeof TARGET_ALLOW / sizeof TARGET_ALLOW[0]; a++) {
      const target_allow_t *al = &TARGET_ALLOW[a];
      if (al->why != NULL && al->sc == s_screen && al->item == reg[k].id &&
          (al->dialog < 0 || al->dialog == (int)s_dialog)) {
        allowed = true;
      }
    }
    if (allowed) continue;
    char msg[96];
    snprintf(msg, sizeof msg, "%s%s item %d: %d x %d px at x %d..%d y %d..%d", scr,
             s_dialog != DLG_NONE ? " dialog" : "", reg[k].id, w, h, reg[k].x0, reg[k].x1,
             reg[k].y0, reg[k].y1);
    finding(g_small, &g_small_n, name, msg);
  }

  if (s_dialog != DLG_NONE) return;
  for (size_t i = 0; i < sizeof HAND_SIDE / sizeof HAND_SIDE[0]; i++) {
    if (HAND_SIDE[i].sc != s_screen) continue;
    for (int k = 0; k < nr; k++) {
      if (reg[k].id != HAND_SIDE[i].item) continue;
      const int cx = (reg[k].x0 + reg[k].x1 + 1) / 2;
      /* hit_hand_button() stretches a button's hit area out to the hand's
       * edge. A back button drawn on the wrong side therefore spans the whole
       * panel, and its centre lands on the left half. A target that reaches
       * the far margin fails, wherever its centre is. */
      const bool far = s_right_hand ? reg[k].x0 < PAGE_M : reg[k].x1 >= UI_W - PAGE_M;
      if ((cx >= UI_W / 2) == s_right_hand && !far) continue;
      char msg[96];
      if (far) {
        snprintf(msg, sizeof msg, "%s spans x %d..%d, across to the far edge for a %s hand",
                 HAND_SIDE[i].what, reg[k].x0, reg[k].x1, s_right_hand ? "right" : "left");
      } else {
        snprintf(msg, sizeof msg, "%s centre x %d is on the %s half for a %s hand",
                 HAND_SIDE[i].what, cx, cx >= UI_W / 2 ? "right" : "left",
                 s_right_hand ? "right" : "left");
      }
      finding(g_hand_bad, &g_hand_bad_n, name, msg);
    }
  }
}

static int list_report(const char *title, const finding_t *list, int n) {
  if (n == 0) return 0;
  fprintf(stderr, "\n%d %s:\n", n, title);
  for (int i = 0; i < n; i++) fprintf(stderr, "  %-30s %s\n", list[i].screen, list[i].text);
  return n;
}

/* The header's height is fixed (FW-25): every hit map and every screen's body
 * offset is built on it. */
_Static_assert(HEAD_H == 62, "HEAD_H is 62 px: the header band, BODY_Y and every hit map use it");

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

/* Set by any failed write. A run that could not write half its screens - a
 * full disk, a bad output path, a directory that does not exist - must not
 * pass on the ones that did land. A partial artifact is a failure, and this
 * is what makes main() say so. */
static bool g_write_failed;
/* PPMs written by this hand's pass, stills and animation frames. */
static int g_ppm_n;
/*
 * How many PPMs one hand's pass writes. A scene added or dropped changes it,
 * and the run fails until this number says so - the count is part of what a
 * reviewer approves, the way the golden hashes are (make check). CI checks
 * the files on disk against `preview --ppms`, which is twice this.
 */
#define PPMS_PER_HAND 237
/* Set when the capture landing under the review move is not in the shade
 * when it should be (scenes(), capture_review_stash). Fails the run. */
static bool g_land_failed;
/* Set when a shutter press makes the wrong sound (check_shutter_sound), or a
 * fade or lift steps backwards or ends anywhere but its end (scenes(), the
 * power-down and the lifts). Each fails the run. */
static bool g_sound_failed;
static bool g_motion_failed;

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
  g_ppm_n++;
  printf("wrote %s (%dx%d)\n", path, w, h);
}

/* Findings carry the scene they were drawn in, stamped once it has a name. */
/* ---- left edges (UI-14) ----
 *
 * Every left-set string's x on the scene being drawn (text() reports it,
 * centred and right-set strings excluded). A screen whose type starts at
 * more than EDGES_MAX different x is a column of type that wobbles: the
 * grid says a page margin, a card's text inset and at most one more. */
#define EDGES_MAX 3
static int g_edge[48];
static int g_edge_n;
static finding_t g_edges[FINDING_MAX];
static int g_edges_n;

void ui_audit_edge(int x) {
  if (g_anim != NULL || g_audit_off) return;
  for (int i = 0; i < g_edge_n; i++) {
    if (g_edge[i] == x) return;
  }
  if (g_edge_n < (int)(sizeof g_edge / sizeof g_edge[0])) g_edge[g_edge_n++] = x;
}

/* Screens allowed more, each with the reason. A column of controls starts
 * its own edge; that is a grid, not a wobble. */
static const struct {
  screen_t sc;
  int max;
  const char *why;
} EDGE_ALLOW[] = {
    {SCR_LOOK, 5, "the title, the card's type, and three control columns, each with a caption"},
};

static void edges_judge(const char *name) {
  int max = EDGES_MAX;
  for (size_t i = 0; i < sizeof EDGE_ALLOW / sizeof EDGE_ALLOW[0]; i++) {
    if (EDGE_ALLOW[i].sc == s_screen) max = EDGE_ALLOW[i].max;
  }
  if (g_edge_n > max && s_dialog == DLG_NONE) {
    char msg[96];
    int n = snprintf(msg, sizeof msg, "%d left edges:", g_edge_n);
    for (int i = 0; i < g_edge_n && n < (int)sizeof msg - 6; i++) {
      n += snprintf(msg + n, sizeof msg - (size_t)n, " %d", g_edge[i]);
    }
    finding(g_edges, &g_edges_n, name, msg);
  }
  g_edge_n = 0;
}

static void audit_stamp(const char *name) {
  audit_name(name);
  for (int i = 0; i < g_contrast_n; i++) {
    if (g_contrast[i].screen[0] == '\0') {
      snprintf(g_contrast[i].screen, sizeof g_contrast[0].screen, "%s", name);
    }
  }
  for (int i = 0; i < g_caps_n; i++) {
    if (g_caps[i].screen[0] == '\0') {
      snprintf(g_caps[i].screen, sizeof g_caps[0].screen, "%s", name);
    }
  }
  for (int i = 0; i < g_nullg_n; i++) {
    if (g_nullg[i].screen[0] == '\0') {
      snprintf(g_nullg[i].screen, sizeof g_nullg[0].screen, "%s", name);
    }
  }
}

char g_out[512];
static void shot(const char *name) {
  char path[600];
  snprintf(path, sizeof path, "%s/%s.ppm", g_out, name);
  audit_stamp(name);
  edges_judge(name);
  if (g_screen_drawn) sweep_targets(name);
  g_screen_drawn = false;
  write_ppm(path, g_canvas, UI_W, UI_H);
  memset(g_img_mask, 0, sizeof g_img_mask);
}

/* The conditions, before a screen is drawn. On the camera this runs on the UI
 * loop's own two-second schedule; here there is no loop, so every shot takes
 * its own reading and the pictures agree with the device state they were
 * rendered from. Without it the cache is empty and every screenshot claims a
 * camera with nothing wrong - which, with two nodes offline and two node
 * versions apart in the stubs above, would be the one thing these pictures
 * exist to catch. */
static void scan_conditions(void) {
  cams_refresh();
  conditions_scan(s_cams);
}

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
  /* The still the move starts from is judged like any still; name what it
   * found after the move, not after whichever shot comes next. */
  audit_stamp(name);
  edges_judge(name);

  g_anim = name;
  g_anim_n = 0;
  prev_vclock_us = 1000000; /* the renderer owns the clock from here */
  go(to, MOTION_OPEN_MS);
  /* go() starts the move now rather than running it, so the renderer drives
   * it the way the UI loop does - one frame per tick, on the clock it owns. */
  for (int guard = 0; anim_active() && guard < 4000; guard++) {
    const uint32_t wait = anim_tick();
    if (wait > 0) prev_vclock_us += (int64_t)wait * 1000;
  }
  prev_vclock_us = 0;
  g_anim = NULL;
  /* The frames are a move, not a still: nothing to sweep. */
  g_screen_drawn = false;
  printf("wrote %s_00..%02d (%d frames)\n", name, g_anim_n - 1, g_anim_n);
}

/* One helper, so every state below is "set the state, draw, name it" and
 * the list reads as the screen inventory it is meant to be. */
#define SHOT(scr, name)      \
  do {                       \
    s_screen = (scr);        \
    scan_conditions();       \
    draw_screen();           \
    shot(name);              \
  } while (0)

/*
 * The shutter sound belongs to the capture (UI-04, ui_motion.h LAND).
 *
 * Four presses through fire_shutter(), the function every shutter goes
 * through: refused by a pipeline that did not start (the warning, no
 * shutter), accepted (one shutter), two taken while a capture saves and then
 * the queued one firing as ui_pass fires it (one shutter, for one picture),
 * and ignored (nothing). Writes no picture; restores what it touched.
 */
static void sound_expect(const char *what, int shutters, int warnings) {
  if (g_shutter_n != shutters || g_warning_n != warnings) {
    fprintf(stderr, "shutter sound: %s gave %d shutter and %d warning, expected %d and %d\n", what,
            g_shutter_n, g_warning_n, shutters, warnings);
    g_sound_failed = true;
  }
  g_shutter_n = g_warning_n = 0;
}

/* ---- the marks through the tiles (M2b) ----
 *
 * The camera never draws a frame whole. gfx_render() replays the display list
 * once per 48 x 96 tile, each tile its own small target, and a mask clipped
 * wrong at a tile's edge leaves a seam every 48 px that the whole-canvas
 * render here would never show. So each mark is recorded at 48 x offsets -
 * every phase of the tile grid across, and twice that down - replayed tile by
 * tile into a tile-sized buffer the way gfx.c does it, and compared with the
 * same list replayed over the whole canvas. Any pixel that differs fails. */
static bool g_tiles_failed;

typedef struct {
  const uint8_t *cov;
  int w, h, x, y;
} tile_mark_t;

static void tile_mark_frame(void *ctx) {
  const tile_mark_t *m = ctx;
  fill(0, 0, UI_W, UI_H, K_GROUND);
  mask_blit(m->cov, m->w, m->h, m->w, m->x, m->y, K_INK);
}

static void check_mask_tiles(const char *what, const uint8_t *cov, int w, int h) {
  enum { TW = 48, TH = 96 };
  static uint16_t whole[UI_W * UI_H], tiled[UI_W * UI_H], tile[TW * TH];
  uint16_t *const canvas = g_canvas;
  for (int d = 0; d < TW; d++) {
    tile_mark_t m = {cov, w, h, 120 + d, 140 + 2 * d};
    dl_begin();
    tile_mark_frame(&m);
    if (!dl_end()) {
      fprintf(stderr, "tiles: %s did not fit the display list\n", what);
      g_tiles_failed = true;
      return;
    }
    g_canvas = whole;
    g_target = (gfx_target_t){whole, 0, 0, UI_W, UI_H, UI_W};
    dl_replay(NULL);
    g_canvas = tile;
    for (int ty = 0; ty < UI_H; ty += TH) {
      const int th = UI_H - ty < TH ? UI_H - ty : TH;
      for (int tx = 0; tx < UI_W; tx += TW) {
        const int tw = UI_W - tx < TW ? UI_W - tx : TW;
        g_target = (gfx_target_t){tile, tx, ty, tw, th, tw};
        dl_replay(NULL);
        for (int r = 0; r < th; r++) {
          memcpy(&tiled[(ty + r) * UI_W + tx], &tile[r * tw], (size_t)tw * sizeof(uint16_t));
        }
      }
    }
    g_canvas = canvas;
    g_target = (gfx_target_t){0};
    int inked = 0;
    for (int i = 0; i < UI_W * UI_H; i++) inked += whole[i] == K_INK;
    if (inked < w * h / 8) {
      fprintf(stderr, "tiles: %s at +%d drew %d solid pixels; the check saw nothing\n", what, d, inked);
      g_tiles_failed = true;
      return;
    }
    for (int i = 0; i < UI_W * UI_H; i++) {
      if (whole[i] != tiled[i]) {
        fprintf(stderr, "tiles: %s at +%d differs at x=%d y=%d (%04x whole, %04x tiled)\n", what, d,
                i % UI_W, i / UI_W, whole[i], tiled[i]);
        g_tiles_failed = true;
        return;
      }
    }
  }
}

static void check_shutter_sound(void) {
  const screen_t scr0 = s_screen;
  const capture_stage_t stage0 = g_stage;
  char toast0[sizeof s_toast];
  memcpy(toast0, s_toast, sizeof toast0);
  const int64_t toast_us0 = s_toast_us;
  const bool toast_long0 = s_toast_long;
  g_audit_off = true; /* the refusal raises a toast; it is not a scene */
  s_screen = SCR_SHOOT;
  g_shutter_n = g_warning_n = 0;

  g_capture_ready = false;
  g_capture_accept = false;
  g_stage = CAPTURE_IDLE;
  fire_shutter(false);
  sound_expect("a press the pipeline refused", 0, 1);
  g_capture_ready = true;

  g_capture_accept = true;
  fire_shutter(false);
  sound_expect("an accepted press", 1, 0);

  g_capture_accept = false;
  g_stage = CAPTURE_READING;
  s_shot_queued = false;
  fire_shutter(false);
  fire_shutter(false);
  sound_expect("two presses while saving", 0, 0);
  if (!s_shot_queued) {
    fprintf(stderr, "shutter sound: a press while saving was not queued\n");
    g_sound_failed = true;
  }
  /* The report lands: ui_pass acknowledges it and fires the queued press. */
  g_capture_accept = true;
  s_shot_queued = false;
  capture_ack();
  fire_shutter(false);
  sound_expect("the queued press firing", 1, 0);

  g_capture_accept = false;
  g_stage = CAPTURE_IDLE;
  fire_shutter(false);
  sound_expect("an ignored press", 0, 0);

  memcpy(s_toast, toast0, sizeof toast0);
  s_toast_us = toast_us0;
  s_toast_long = toast_long0;
  s_shot_queued = false;
  g_stage = stage0;
  s_screen = scr0;
  g_screen_drawn = false;
  g_audit_off = false;
}

/*
 * One frame of a lift or a fade, as a still: the screen under scrim `k`
 * with the sleep mark at `mark`. Not judged for contrast or targets - type
 * under a scrim is meant to be faint, and the screen is judged in its own
 * still.
 */
static void lift_frame(screen_t sc, int k, int mark, const char *name) {
  g_audit_off = true;
  s_screen = sc;
  s_dim_k = k;
  s_lift_mark = mark;
  scan_conditions();
  draw_screen();
  g_screen_drawn = false;
  shot(name);
  s_dim_k = 0;
  s_lift_mark = 0;
  g_audit_off = false;
}

/* The canvas's mean green, 0..63: how much light a frame gives off. */
static double canvas_mean_g6(void) {
  double sum = 0.0;
  for (int i = 0; i < UI_W * UI_H; i++) sum += (double)((g_canvas[i] >> 5) & 0x3F);
  return sum / (double)(UI_W * UI_H);
}

/*
 * A move started part-way through a lift takes the rest of it. The pass skips
 * lift_step while a move runs, so a lift left going would land after the move
 * as one step. SETTINGS -> DISPLAY is the slide (no row behind it); the menu
 * -> SETTINGS is the row move. After go() the lift is over, the slide's
 * arriving screen is clear and the row move carries the scrim. A dim still
 * arriving (stage DIM) keeps its scrim through a move.
 *
 * Then the row move's first frame against the last frame before it: the
 * pressed menu under the lift's scrim. The two must give off the same light
 * as they do with no scrim at all - the move may not drop the scrim in one
 * frame - and the carried scrim only goes down and is gone before the land.
 */
static void check_move_takes_lift(void) {
  const screen_t scr0 = s_screen;
  g_audit_off = true;
  static const screen_t FROM[2] = {SCR_SETTINGS, SCR_MENU};
  static const screen_t TO[2] = {SCR_DISPLAY, SCR_SETTINGS};
  for (int i = 0; i < 2; i++) {
    s_screen = FROM[i];
    lift_start(DIM_SCRIM_K / 3, 0, MOTION_UNDIM_MS);
    go(TO[i], MOTION_OPEN_MS);
    const int carried = s_anim.kind == ANIM_OPEN ? s_anim.scrim0 : 0;
    s_anim.kind = ANIM_NONE;
    s_anim.scrim0 = s_anim.scrim_k = 0;
    if (s_lift_us != 0 || s_dim_k != 0 || s_lift_mark != 0) {
      fprintf(stderr, "a move from screen %d left the lift running (scrim %d)\n", (int)FROM[i], s_dim_k);
      g_motion_failed = true;
    }
    if (FROM[i] == SCR_MENU && carried != DIM_SCRIM_K / 3) {
      fprintf(stderr, "the row move carried scrim %d of the lift's %d\n", carried, DIM_SCRIM_K / 3);
      g_motion_failed = true;
    }
  }
  s_screen = SCR_SETTINGS;
  s_lift_us = 0;
  s_dim_k = DIM_SCRIM_K / 2; /* a dim on its way in: no lift running */
  g_power_stage = POWER_DIM;
  go(SCR_DISPLAY, MOTION_OPEN_MS);
  s_anim.kind = ANIM_NONE;
  g_power_stage = POWER_AWAKE;
  if (s_dim_k != DIM_SCRIM_K / 2) {
    fprintf(stderr, "a move cut a dim on its way in (scrim %d)\n", s_dim_k);
    g_motion_failed = true;
  }

  /* The row move's first frame, with and without a lift under it. */
  const int row = menu_item_of(SCR_SETTINGS);
  double before[2], first[2];
  for (int pass = 0; pass < 2; pass++) {
    const int k = pass == 0 ? 0 : DIM_SCRIM_K / 3;
    s_screen = SCR_MENU;
    s_pressed = row;
    s_lift_us = 0;
    s_dim_k = 0;
    if (k > 0) lift_start(k, 0, MOTION_UNDIM_MS);
    scan_conditions();
    draw_screen();
    before[pass] = canvas_mean_g6();
    prev_vclock_us = 1000000;
    go(SCR_SETTINGS, MOTION_OPEN_MS);
    int prev_k = s_anim.scrim0, frames = 0;
    bool first_seen = false;
    for (int guard = 0; anim_active() && guard < 400; guard++) {
      const uint32_t wait = anim_tick();
      if (!first_seen) {
        first[pass] = canvas_mean_g6();
        first_seen = true;
        if (s_anim.scrim_k != k) {
          fprintf(stderr, "the row move's first frame is at scrim %d, the glass was at %d\n", s_anim.scrim_k, k);
          g_motion_failed = true;
        }
      }
      if (s_anim.scrim_k > prev_k) {
        fprintf(stderr, "the row move's scrim goes back up at frame %d (%d -> %d)\n", frames, prev_k, s_anim.scrim_k);
        g_motion_failed = true;
      }
      prev_k = s_anim.scrim_k;
      frames++;
      if (wait > 0) prev_vclock_us += (int64_t)wait * 1000;
    }
    prev_vclock_us = 0;
    if (prev_k != 0 || s_dim_k != 0) {
      fprintf(stderr, "the row move lands under scrim %d (dim %d)\n", prev_k, s_dim_k);
      g_motion_failed = true;
    }
  }
  /* The scrim takes the same light off both frames: they differ only as much
   * as the two frames do with no scrim. Without the carry the first frame is
   * the whole scrim brighter. */
  const double drift = (first[1] - before[1]) - (first[0] - before[0]);
  if (drift > 0.10 || drift < -0.10) {
    fprintf(stderr, "the row move's first frame is %.2f G6 off the scrimmed menu before it\n", drift);
    g_motion_failed = true;
  }
  printf("row move under a lift: first frame %.2f G6 off the menu before it (%.2f with no lift)\n",
         first[1] - before[1], first[0] - before[0]);
  s_anim.kind = ANIM_NONE;
  s_anim.scrim0 = s_anim.scrim_k = 0;
  s_dim_k = 0;
  s_lift_us = 0;
  s_lift_mark = 0;
  s_pressed = -1;
  s_screen = scr0;
  g_screen_drawn = false;
  g_audit_off = false;
}

/*
 * The shutter key on a dimmed or a sleeping screen, through ui_pass().
 *
 * The key wakes the screen and starts the move to SHOOT on the same pass, and
 * the pass would then start the undim or the wake lift under the pending
 * move. The pass skips lift_step while a move runs, so the landed frame was
 * drawn dark and cut to full on the next. Every frame from the first one on
 * is recorded with the scrim it was drawn under; it must only go down, by no
 * more than one frame of the faster lift at a time, and end at 0. A slide's
 * arriving screen is drawn clear.
 */
#define WAKE_SEQ_MAX 512
static int g_wake_seq[WAKE_SEQ_MAX];
static int g_wake_seq_n;
static int g_wake_stash_k;

static void wake_hook(bool stash) {
  if (stash) {
    g_wake_stash_k = s_dim_k;
    return;
  }
  const int k = s_dim_k + (s_anim.kind == ANIM_OPEN ? s_anim.scrim_k : 0);
  if (g_wake_seq_n < WAKE_SEQ_MAX) g_wake_seq[g_wake_seq_n++] = k;
}

/* `lift_ms` > 0: a plain pass starts the undim first and the key comes that
 * far into it - the release in the middle of a lift. */
static void wake_into_move(const char *what, screen_t from, int k0, bool asleep, int lift_ms, int expect_first) {
  s_screen = from;
  s_pressed = -1;
  s_anim.kind = ANIM_NONE;
  s_dim_k = k0;
  s_lift_us = 0;
  s_lift_mark = 0;
  s_sleep_mark = asleep;
  s_sleep_stage = -1;
  was_asleep = asleep;
  s_dim_since_us = 0;
  g_power_stage = POWER_AWAKE; /* power_activity() ran on the buttons task */
  s_btn_q = xQueueCreate(4, sizeof(btn_event_t));
  prev_vclock_us = 1000000;
  g_wake_seq_n = 0;
  g_wake_stash_k = -1;
  g_frame_hook = wake_hook;

  bool pressed = false, moved = false;
  int after = 0;
  const int64_t t0 = prev_vclock_us;
  for (int guard = 0; guard < 2000; guard++) {
    if (!pressed && prev_vclock_us - t0 >= (int64_t)lift_ms * 1000) {
      on_button(BTN_SHUTTER, false);
      pressed = true;
    }
    const int n0 = g_wake_seq_n;
    const uint32_t wait = ui_pass();
    if (anim_active()) moved = true;
    /* A frame moves the clock itself. A pass that drew nothing and asks for
     * no wait comes straight back on the camera; it is given a millisecond
     * here only when no move is pending, so the idle passes before the key
     * still let time pass. */
    if (wait > 0) prev_vclock_us += (int64_t)wait * 1000;
    else if (g_wake_seq_n == n0 && !anim_active()) prev_vclock_us += 1000;
    if (moved && !anim_active() && ++after > 8) break;
  }
  g_frame_hook = NULL;
  prev_vclock_us = 0;

  if (!moved || s_screen != SCR_SHOOT) {
    fprintf(stderr, "%s: the shutter did not move to SHOOT (screen %d)\n", what, (int)s_screen);
    g_motion_failed = true;
  }
  if (g_wake_seq_n == 0) {
    fprintf(stderr, "%s: nothing was drawn\n", what);
    g_motion_failed = true;
  } else {
    if (expect_first >= 0 && g_wake_seq[0] != expect_first) {
      fprintf(stderr, "%s: the first frame is under scrim %d, expected %d\n", what, g_wake_seq[0], expect_first);
      g_motion_failed = true;
    }
    /* The steepest frame either lift has: the first 16 ms of motion_ease_out
     * from the ground over MOTION_WAKE_MS is 48 of 255. */
    for (int i = 1; i < g_wake_seq_n; i++) {
      const int d = g_wake_seq[i - 1] - g_wake_seq[i];
      if (d < 0 || d > 64) {
        fprintf(stderr, "%s: frame %d steps the scrim %d -> %d\n", what, i, g_wake_seq[i - 1], g_wake_seq[i]);
        g_motion_failed = true;
        break;
      }
    }
    if (g_wake_seq[g_wake_seq_n - 1] != 0) {
      fprintf(stderr, "%s: ends under scrim %d\n", what, g_wake_seq[g_wake_seq_n - 1]);
      g_motion_failed = true;
    }
  }
  if (g_wake_stash_k > 0) {
    fprintf(stderr, "%s: the arriving screen was drawn under scrim %d\n", what, g_wake_stash_k);
    g_motion_failed = true;
  }
  printf("%s: %d frames, scrim %d first\n", what, g_wake_seq_n, g_wake_seq_n ? g_wake_seq[0] : -1);
}

static void check_wake_into_move(void) {
  const screen_t scr0 = s_screen;
  g_audit_off = true;
  wake_into_move("shutter on the dimmed menu", SCR_MENU, DIM_SCRIM_K, false, 0, DIM_SCRIM_K);
  wake_into_move("shutter on the sleeping menu", SCR_MENU, SLEEP_DARK_K, true, 0, 255);
  wake_into_move("shutter 60 ms into the undim", SCR_MENU, DIM_SCRIM_K, false, 60, -1);
  wake_into_move("shutter on the dimmed SETTINGS", SCR_SETTINGS, DIM_SCRIM_K, false, 0, -1);
  wake_into_move("shutter on the sleeping SETTINGS", SCR_SETTINGS, SLEEP_DARK_K, true, 0, -1);
  s_btn_q = NULL;
  s_anim.kind = ANIM_NONE;
  s_anim.scrim0 = s_anim.scrim_k = 0;
  s_dim_k = 0;
  s_lift_us = 0;
  s_lift_mark = 0;
  s_sleep_mark = false;
  was_asleep = false;
  s_pressed = -1;
  s_screen = scr0;
  g_screen_drawn = false;
  g_audit_off = false;
}

/* Every millisecond of a lift: the scrim and the mark only ever go down,
 * and both end at zero. */
static void lift_monotone(const char *what, int32_t span_ms, int k0, int mark0) {
  int pk = k0, pm = mark0;
  for (int32_t ms = 0; ms <= span_ms; ms++) {
    int k, m;
    lift_at((int64_t)ms * 1000, span_ms, k0, mark0, &k, &m);
    if (k > pk || m > pm || k < 0 || m < 0) {
      fprintf(stderr, "%s: steps back at %d ms (scrim %d -> %d, mark %d -> %d)\n", what, (int)ms, pk, k, pm, m);
      g_motion_failed = true;
      return;
    }
    pk = k;
    pm = m;
  }
  if (pk != 0 || pm != 0) {
    fprintf(stderr, "%s: ends at scrim %d, mark %d, not 0\n", what, pk, pm);
    g_motion_failed = true;
  }
}

/* Every scene, in the order they have always been drawn. Run once per hand,
 * each time in a fresh forked process (main). */
static void scenes(void) {
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

  /* The card's four-mark with three cameras answering: CAM3's cell is an
   * outline. The snapshot is refilled by hand, because cams_refresh() keeps
   * its own two-second clock. */
  g_cam_online = 0xBu;
  for (int i = 0; i < 4; i++) camlink_get_info_ch(i, &s_cams[i]);
  conditions_scan(s_cams);
  s_screen = SCR_MENU;
  draw_screen();
  shot("menu_cams_3of4");
  g_cam_online = 0x5u;
  for (int i = 0; i < 4; i++) camlink_get_info_ch(i, &s_cams[i]);
  conditions_scan(s_cams);

  /* The launch shades: the menu in each of the eight a start can wear, for
   * the review strip. main.c picks boot_count % 8; every other picture here
   * is row 0, the MAO pink itself. */
  for (uint32_t i = 0; i < K_LAUNCH_N; i++) {
    char name[32];
    snprintf(name, sizeof name, "launch_shade_%u", (unsigned)i);
    ui_set_launch_index(i);
    SHOT(SCR_MENU, name);
  }
  ui_set_launch_index(0);

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

  /* The lens hint, the red pill over the finder. lens_hint_poll() raises it
   * from the lid readings on the UI loop, which does not run here, so the
   * string is set the way the poll sets it. One of #176's contrast pairs. */
  snprintf(s_lens_hint, sizeof s_lens_hint, "CHECK THE SECOND LENS");
  SHOT(SCR_SHOOT, "shoot_lens_hint");
  s_lens_hint[0] = '\0';

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

  /* The landing, at three moments of its 300 ms: held in the launch shade,
   * and two points on the smootherstep back to ink. capture_saved above is
   * where it ends. land_ink() is the function ui_pass steps it with. */
  {
    static const int LAND_AT_MS[3] = {0, 180, 240};
    for (int i = 0; i < 3; i++) {
      char name[32];
      snprintf(name, sizeof name, "capture_landing_%03d", LAND_AT_MS[i]);
      s_land_ink = land_ink((int64_t)LAND_AT_MS[i] * 1000);
      draw_screen();
      shot(name);
    }
    s_land_ink = K_INK;
  }

  /*
   * The landing under the default AFTER SHOT (2 s). ui_pass sees the report
   * and opens the review on the same pass; the move stashes PHOTO at once and
   * owns the panel for 420 ms, with ui_pass returning before land_step(). The
   * stash has to carry the landed bar in the shade, and the 300 ms have to
   * start once the move has landed. Driven through the calls ui_pass makes -
   * land_start(), first_review_open(), land_step() - on the renderer's clock.
   * The stash is written as capture_review_stash.
   */
  {
    prev_vclock_us = 1000000;
    land_start();
    first_review_open(&g_report);
    const uint16_t *stash = gfx_stash_px();
    const int bx = PAGE_M + 2, by = SH_PN_Y + SH_PN_H / 2;
    if (s_screen != SCR_PHOTO || stash == NULL) {
      fprintf(stderr, "landing: the review did not open on a DONE report\n");
      g_land_failed = true;
    } else {
      if (stash[by * UI_W + bx] != K_ACCENT) {
        fprintf(stderr, "landing: review stash bar is %04x, not the shade %04x\n",
                stash[by * UI_W + bx], K_ACCENT);
        g_land_failed = true;
      }
      char path[600];
      snprintf(path, sizeof path, "%s/capture_review_stash.ppm", g_out);
      audit_stamp("capture_review_stash");
      write_ppm(path, stash, UI_W, UI_H);
    }
    const int64_t move_from_us = prev_vclock_us;
    for (int guard = 0; anim_active() && guard < 4000; guard++) {
      const uint32_t wait = anim_tick();
      if (wait > 0) prev_vclock_us += (int64_t)wait * 1000;
    }
    if (anim_active() || prev_vclock_us - move_from_us < (int64_t)MOTION_OPEN_MS * 1000) {
      fprintf(stderr, "landing: the review move did not run its %d ms\n", MOTION_OPEN_MS);
      g_land_failed = true;
    }
    g_screen_drawn = false;
    /* The first pass after the move: the hold starts here. */
    const bool moving0 = land_step();
    const uint16_t ink0 = s_land_ink;
    prev_vclock_us += 210 * 1000;
    land_step();
    const uint16_t ink210 = s_land_ink;
    prev_vclock_us += 140 * 1000;
    const bool moving350 = land_step();
    if (!moving0 || ink0 != K_ACCENT || ink210 == K_ACCENT || ink210 == K_INK || moving350 ||
        s_land_ink != K_INK) {
      fprintf(stderr, "landing: after the move %04x/%d, +210 ms %04x, +350 ms %04x/%d\n", ink0,
              moving0, ink210, s_land_ink, moving350);
      g_land_failed = true;
    }
    prev_vclock_us = 0;
    s_shot_seen_us = 0;
    land_step();
    s_first_review_us = 0;
    photo_release();
    s_screen = SCR_SHOOT;
  }

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

  /* A 24-character name: too wide for TITLE in the right column, so it
   * drops to LABEL - Oxanium both - and is cut there if it must be (F2). */
  snprintf(g_roll.name, sizeof g_roll.name, "ALEX AND MAYA WEDDING 26");
  SHOT(SCR_ROLL, "roll_long_name");
  snprintf(g_roll.name, sizeof g_roll.name, "FRIDAY PARTY");

  /*
   * A Roll with nowhere to send it (#198).
   *
   * The body has joined a Roll and has no server to upload to, so every
   * upload parks FAILED while ROLL says Online. It is the one screen state
   * that only exists in the radio build, which is why this renderer compiles
   * as one; before #203 it could not be drawn here at all.
   */
  {
    g_roll_server = false;
    upload_queue_report_t saved = g_queue;
    g_queue.failed = 34;
    g_queue.pending = 0;
    g_queue.uploading = 0;
    SHOT(SCR_STATUS, "status_roll_no_server");
    SHOT(SCR_ROLL, "roll_no_server");
    g_queue = saved;
    g_roll_server = true;
  }

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
   * landing and the next screen arriving - and the focus rectangle on a row
   * under a finger is drawn in the dark ink, which no other control has. */
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
  /* The slot empty, or the card pulled: the two states a body is most often
   * in without a card, and the ones that must not say "take the card out". */
  g_card_present = false;
  SHOT(SCR_STORAGE, "settings_storage_empty");
  g_card_present = true;
  g_card_mounted = true;
  /* DELETE ALL running: the Photos row counts down and both destructive rows
   * go dark until it ends. */
  g_deleting = true;
  g_delete_done = 120;
  g_delete_total = 500;
  SHOT(SCR_STORAGE, "settings_storage_deleting");
  g_delete_done = 1433;
  g_delete_total = 1434;
  SHOT(SCR_STORAGE, "settings_storage_deleting_long");
  g_deleting = false;
  g_delete_done = g_delete_total = 0;
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
   * the well line up - and the disabled row's dimmed words against a focused
   * row in one frame. */
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
    /* DELETE held: the pressed destructive face, one of #176's pairs. */
    s_pressed = P_IT_DELETE;
    SHOT(SCR_PHOTO, "photo_delete_pressed");
    s_pressed = -1;
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
    /* The same, dated: the tallest the facts well gets - number, mode, date,
     * MISSING, CAMERAS and the mark - which no other shot has, because the
     * preview's photographs carry no time. The well must hold all of it. */
    s_photo_ms = 1787000000000LL;
    SHOT(SCR_PHOTO, "photo_partial_dated");
    s_photo_ms = 0;
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
    fill(0, 0, UI_W, UI_H, K_GROUND);
    boot_field(BF_REACH, 900, 0, 1.0f);
    shot("boot_field_all_four");

    s_bf_cam[1] = s_bf_cam[3] = BF_DARK;
    fill(0, 0, UI_W, UI_H, K_GROUND);
    boot_field(BF_REACH, 900, 0, 1.0f);
    shot("boot_field_two_silent");
    for (int q = 0; q < 4; q++) s_bf_cam[q] = 1.0f;
  }

  /* What the camera shows while it is going away: its own mark, centred,
   * and then the screen letting go of it. Same picture for a restart. The
   * fade at four of its MOTION_POWER_FADE_FRAMES frames, drawn from
   * power_fade_k() the way power_down_anim() draws them, and every frame's
   * scrim checked to only ever darken, from the mark to black. */
  {
    fill(0, 0, UI_W, UI_H, K_GROUND);
    boot_mark();
    shot("power_down");
    int prev = 0;
    for (int i = 0; i <= MOTION_POWER_FADE_FRAMES; i++) {
      int k = power_fade_k((float)i / (float)MOTION_POWER_FADE_FRAMES);
      if (k < prev || (i == 0 && k != 0) || (i == MOTION_POWER_FADE_FRAMES && k != 255)) {
        fprintf(stderr, "power-down: frame %d scrim %d after %d - not a fade from 0 to 255\n", i, k, prev);
        g_motion_failed = true;
      }
      prev = k;
      if (i > 0 && i < MOTION_POWER_FADE_FRAMES && i % 4 == 0) {
        char name[32];
        snprintf(name, sizeof name, "power_down_fade_%02d", i);
        ui_render(render_mark_fade, &k);
        shot(name);
      }
    }
  }

  /*
   * The lifts: the scrim coming off the screen rather than cutting away
   * (UI-09). The wake from sleep at three moments of its MOTION_WAKE_MS; a
   * sleep called off with its mark up, the mark leaving and then the picture
   * arriving; the undim half way. Every millisecond of each is checked to go
   * one way and end clear.
   */
  {
    lift_monotone("wake", MOTION_WAKE_MS, 255, 0);
    lift_monotone("sleep called off, mark up", MOTION_WAKE_MS, 255, 255);
    lift_monotone("sleep called off, darkening", MOTION_WAKE_MS, 200, 0);
    lift_monotone("undim", MOTION_UNDIM_MS, DIM_SCRIM_K, 0);
    s_focus[SCR_MENU] = 0;
    static const int WAKE_AT_MS[3] = {60, 120, 180};
    for (int i = 0; i < 3; i++) {
      int k, m;
      char name[32];
      lift_at((int64_t)WAKE_AT_MS[i] * 1000, MOTION_WAKE_MS, 255, 0, &k, &m);
      snprintf(name, sizeof name, "wake_%03d", WAKE_AT_MS[i]);
      lift_frame(SCR_MENU, k, m, name);
    }
    static const int CANCEL_AT_MS[2] = {40, 160};
    for (int i = 0; i < 2; i++) {
      int k, m;
      char name[32];
      lift_at((int64_t)CANCEL_AT_MS[i] * 1000, MOTION_WAKE_MS, 255, 255, &k, &m);
      snprintf(name, sizeof name, "sleep_cancel_%03d", CANCEL_AT_MS[i]);
      lift_frame(SCR_MENU, k, m, name);
    }
    {
      int k, m;
      lift_at((int64_t)(MOTION_UNDIM_MS / 2) * 1000, MOTION_UNDIM_MS, DIM_SCRIM_K, 0, &k, &m);
      lift_frame(SCR_MENU, k, m, "undim_080");
    }
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

  /* Last, so nothing it touches reaches a picture. */
  check_shutter_sound();
  check_move_takes_lift();
  check_wake_into_move();
}

/* ---- what a frame costs ---- */
static void bench(void) {
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
      fill(0, 0, UI_W, UI_H, K_GROUND);
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
}

/*
 * Every check fails the run: the structural ones (a string outside the safe
 * area, hand-side chrome off the hand's side, a write that did not land, a
 * PPM count that moved) and the two judgement ones, contrast and touch
 * targets. The judgement checks only reported until the colour pass closed
 * #176's list (#234); a string under its floor or a target under 52 px on
 * either hand is now a failed build like any other.
 */

/* Exit codes of one hand's pass, to the parent. */
#define PASS_CLEAN 0
#define PASS_HARD 1   /* a structural failure */
#define PASS_SOFT 2   /* contrast or targets only */

static int run_hand(bool right, const char *out) {
  g_hand = right ? "right" : "left";
  if (right) {
    snprintf(g_out, sizeof g_out, "%s", out);
  } else {
    snprintf(g_out, sizeof g_out, "%s/left", out);
    if (mkdir(g_out, 0777) != 0 && errno != EEXIST) {
      fprintf(stderr, "cannot create %s\n", g_out);
      return PASS_HARD;
    }
  }
  g_canvas = calloc((size_t)UI_W * UI_H, sizeof(uint16_t));
  if (g_canvas == NULL) return PASS_HARD;

  /* Row 0, the MAO pink: the camera's pick is boot_count % 8, and a picture
   * that depended on a counter would be a different picture every run. */
  ui_set_launch_index(0);
  scenes();
  /* The frame-cost figures are the same for both hands; print them once. */
  if (right) {
    g_audit_off = true;
    bench();
    check_mask_tiles("the wordmark", KINO_D4_LOGO, KINO_D4_LOGO_W, KINO_D4_LOGO_H);
    check_mask_tiles("the ODD JOBS mark", UI_MARK_ODD_JOBS_40, UI_MARK_ODD_JOBS_40_W,
                     UI_MARK_ODD_JOBS_40_H);
    check_mask_tiles("the ODD JOBS mark at 128", UI_MARK_ODD_JOBS_128, UI_MARK_ODD_JOBS_128_W,
                     UI_MARK_ODD_JOBS_128_H);
    g_audit_off = false;
  }

  fprintf(stderr, "\n==== %s hand: %d PPMs in %s ====\n", g_hand, g_ppm_n, g_out);
  bool hard = false;
  if (g_write_failed) {
    fprintf(stderr, "one or more screens were not written\n");
    hard = true;
  }
  if (g_ppm_n != PPMS_PER_HAND) {
    fprintf(stderr,
            "wrote %d PPMs, expected %d: a scene was added or dropped. Set PPMS_PER_HAND in "
            "preview.c and re-approve the golden hashes (make approve).\n",
            g_ppm_n, PPMS_PER_HAND);
    hard = true;
  }
  if (g_land_failed) {
    fprintf(stderr, "the capture landing is not in the shade under the review move\n");
    hard = true;
  }
  if (g_tiles_failed) {
    fprintf(stderr, "a mark drawn tile by tile is not the mark drawn whole\n");
    hard = true;
  }
  if (g_sound_failed) {
    fprintf(stderr, "a shutter press made the wrong sound\n");
    hard = true;
  }
  if (g_motion_failed) {
    fprintf(stderr, "a fade or a lift steps back or does not end where it should\n");
    hard = true;
  }
  if (audit_report() > 0) hard = true;
  if (caps_report() > 0) hard = true;
  if (null_glyph_report() > 0) hard = true;
  if (list_report("hand-side controls off the hand's side", g_hand_bad, g_hand_bad_n) > 0) hard = true;
  const int soft = contrast_report() +
                   list_report("touch targets under 52 px", g_small, g_small_n) +
                   list_report("screens whose type starts at more than 3 left edges", g_edges, g_edges_n);
  fprintf(stderr, "\ncontrast: %d string draws judged, %d set on a picture and skipped\n",
          g_judged_n, g_over_image_n);
  if (hard) return PASS_HARD;
  return soft > 0 ? PASS_SOFT : PASS_CLEAN;
}

int main(int argc, char **argv) {
  const char *out = ".";
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--ppms") == 0) {
      printf("%d\n", 2 * PPMS_PER_HAND);
      return 0;
    }
    out = argv[i];
  }

  /* One process per hand, both from this untouched state: the scene list
   * mutates the stubs and ui.c's statics as it goes, and a second pass in the
   * same process would start from wherever the first one left them. */
  int worst = PASS_CLEAN;
  for (int h = 0; h < 2; h++) {
    fflush(stdout);
    fflush(stderr);
    const pid_t pid = fork();
    if (pid < 0) {
      perror("fork");
      return 1;
    }
    if (pid == 0) {
      const int rc = run_hand(h == 0, out);
      fflush(stdout);
      fflush(stderr);
      _exit(rc);
    }
    int status = 0;
    if (waitpid(pid, &status, 0) < 0 || !WIFEXITED(status)) {
      fprintf(stderr, "the %s-hand pass did not finish\n", h == 0 ? "right" : "left");
      return 1;
    }
    const int rc = WEXITSTATUS(status);
    if (rc == PASS_HARD) worst = PASS_HARD;
    else if (rc == PASS_SOFT && worst == PASS_CLEAN) worst = PASS_SOFT;
    else if (rc != PASS_CLEAN && rc != PASS_SOFT) worst = PASS_HARD;
  }
  if (worst != PASS_CLEAN) {
    fprintf(stderr, "\naudit: %s\n",
            worst == PASS_HARD ? "failed" : "failed on contrast or touch targets");
    return 1;
  }
  return 0;
}
