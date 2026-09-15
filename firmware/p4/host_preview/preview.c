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
void gfx_present(void) {}
void gfx_snapshot(void) {}
void gfx_dissolve(int ms) { (void)ms; }
void gfx_stats(uint32_t *f, uint32_t *ms) {
  if (f) *f = 0;
  if (ms) *ms = 0;
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
void audio_sync(void) {}
void audio_done(void) {}

esp_err_t touch_init(void) { return ESP_OK; }
/* The clock (see shim/esp_timer.h) and a finger. Touch reports in panel space,
 * the way touch.c does, so ui_pass()'s own transposition is exercised. */
int64_t g_preview_clock_us = 1000000;
int g_mute_words;
static bool g_touch_down;
static int g_touch_lx, g_touch_ly;
/* ui_pass() is now driven by the film scenes, so the parts of the loop that
 * only it calls need stand-ins: no wake gesture on a preview. */
bool power_wake_gesture(void) { return false; }
void power_end_wake_gesture(void) {}
bool touch_ready(void) { return true; }
bool touch_get(uint16_t *x, uint16_t *y) {
  if (!g_touch_down) return false;
  if (x) *x = (uint16_t)(UI_H - 1 - g_touch_ly); /* the panel is UI_H wide */
  if (y) *y = (uint16_t)g_touch_lx;
  return true;
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
bool config_bool(const char *path, bool fallback) {
  (void)path;
  return fallback;
}
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
    {"normal", "NORMAL"},   {"flash", "FLASH"},       {"cheap", "CHEAP"},
    {"blue", "BLUE"},       {"night-bus", "NIGHT BUS"}, {"morning", "MORNING"},
    {"bad-ccd", "BAD CCD"}, {"2003", "2003"},         {"bw", "B/W"},
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
static char g_leaf_str[64];
static double g_leaf_num;
static bool g_leaf_bool;
static enum { LEAF_NONE, LEAF_STR, LEAF_NUM, LEAF_BOOL } g_leaf_kind;
static char g_patch_path[64];
static char g_look_buf[KDP_RECIPE_ID_MAX];
static char g_mode_buf[12], g_flash_buf[8];
esp_err_t config_merge(const cJSON *patch) {
  (void)patch;
  if (g_leaf_kind == LEAF_STR) {
    if (strcmp(g_patch_path, "wiggle.recipeId") == 0 || (strncmp(g_patch_path, "quad.slots.", 11) == 0 && strstr(g_patch_path, "recipeId"))) {
      snprintf(g_look_buf, sizeof g_look_buf, "%s", g_leaf_str);
      g_look = g_look_buf;
    } else if (strcmp(g_patch_path, "mode") == 0) {
      snprintf(g_mode_buf, sizeof g_mode_buf, "%s", g_leaf_str);
      g_mode = g_mode_buf;
    } else if (strcmp(g_patch_path, "shoot.flashMode") == 0) {
      snprintf(g_flash_buf, sizeof g_flash_buf, "%s", g_leaf_str);
      g_flash_mode = g_flash_buf;
    } else if (strncmp(g_patch_path, "quad.slots.", 11) == 0 && strstr(g_patch_path, "colorMode")) {
      g_mono = strcmp(g_leaf_str, "mono") == 0;
    }
  }
  g_leaf_kind = LEAF_NONE;
  return ESP_OK;
}
esp_err_t config_save(void) { return ESP_OK; }

/* meta.c is not linked here - it needs the real cJSON, which lives in
 * ESP-IDF. Stubbed rather than left to the linker's dead-code elimination:
 * it resolved only because nothing in main() reaches the write path, so the
 * first screenshot that exercised a setting would have broken the build. */
/* Config writes, remembered rather than dropped.
 *
 * The screens write through cfg_set_*() -> meta_patch_path -> config_merge,
 * and the film scenes press controls that write: a preset step has to show
 * the next preset. So the leaf and the path of the last patch are kept, and
 * config_merge() applies the handful the stand-in config_str() answers from.
 * Anything else is still discarded, as before. */
void *meta_patch_path(const char *dotted, void *leaf);
void *meta_patch_path(const char *dotted, void *leaf) {
  snprintf(g_patch_path, sizeof g_patch_path, "%s", dotted);
  return leaf;
}
static struct cJSON { int unused; } g_json_stub;
cJSON *cJSON_CreateObject(void) { return &g_json_stub; }
cJSON *cJSON_CreateString(const char *s) {
  snprintf(g_leaf_str, sizeof g_leaf_str, "%s", s);
  g_leaf_kind = LEAF_STR;
  return &g_json_stub;
}
cJSON *cJSON_CreateNumber(double v) { g_leaf_num = v; g_leaf_kind = LEAF_NUM; return &g_json_stub; }
cJSON *cJSON_CreateBool(bool v) { g_leaf_bool = v; g_leaf_kind = LEAF_BOOL; return &g_json_stub; }
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
  /*
   * A scene with depth in it, because the whole product is parallax and a
   * frame with none cannot be used to judge anything the interface does with
   * it. Three planes: a far wall that does not move between the cameras, a
   * mid object that shifts a little, and a near object that shifts a lot -
   * which is exactly what four lenses 12 mm apart see.
   *
   * Still obviously synthetic. No screenshot from this tool should be
   * mistakable for a frame off a sensor.
   */
  for (int c = 0; c < 4; c++) {
    const int near_dx = (c - 2) * 11, mid_dx = (c - 2) * 4;
    for (int y = 0; y < VF_H; y++) {
      for (int x = 0; x < VF_W; x++) {
        /* Far: a flat wall with a slow vertical ramp and a seam of its own. */
        int r = 5 + (y * 9) / VF_H, g = 9 + (y * 16) / VF_H, b = 13 + (y * 10) / VF_H;
        /* Mid: a band across the middle distance. */
        const int mx = x + mid_dx;
        if (mx > 40 && mx < 150 && y > 60 && y < 200) { r = 22; g = 30; b = 12; }
        /* Near: a bar that moves a lot between the four. */
        const int nx = x + near_dx;
        if (nx > 175 && nx < 240 && y > 30 && y < 230) { r = 30; g = 48; b = 26; }
        /* And a small near mark, so the shift is countable rather than felt. */
        if (nx > 196 && nx < 214 && y > 108 && y < 130) { r = 2; g = 4; b = 3; }
        uint16_t p = (uint16_t)(((r & 31) << 11) | ((g & 63) << 5) | (b & 31));
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

static int g_local_hour = 21;
int clock_local_hour(void) { return g_local_hour; }
/* The preview stands in for a body that has been plugged into Studio, so its
 * clock has a source and the machine page can show a date. `g_clock_source`
 * is here so a shot can ask for the other state - the one a camera out of the
 * box is in, where the rows say NOT SET rather than a plausible number. */
static clock_source_t g_clock_source = CLOCK_HOST;
clock_source_t clock_source(void) { return g_clock_source; }
void clock_iso8601(char *out, size_t cap) { snprintf(out, cap, "2026-09-15T18:42:11+02:00"); }
static uint32_t g_asked_mask = 0xf, g_frames_in;
uint32_t capture_asked_cams(void) { return g_asked_mask; }
uint32_t capture_frames_in(void) { return g_frames_in; }
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

/* ---- difficult photography ---------------------------------------------
 *
 * The gradients everything else is shot on are pleasant, evenly exposed and
 * full of contrast, which is exactly the photography an interface never has
 * to survive. These are the frames that break things: a room with nothing in
 * it, a window that has blown out, a beige wall, a face lit from behind, a
 * crowd. They are synthetic - no screenshot from this tool should ever be
 * mistakable for a sensor frame - but their statistics are the ones that
 * matter: where the luminance sits, how much range there is, how much the
 * four cameras disagree, and whether white text on a shadow can still be read
 * over the top of it.
 *
 * Each camera gets a slightly different exposure and framing of the same
 * scene, because four sensors on four mounts never agree, and that
 * disagreement is a signal ksense.h reads.
 */
enum { HARD_DARK, HARD_BRIGHT, HARD_FLAT, HARD_SATURATED, HARD_BACKLIT, HARD_BUSY, HARD_COUNT };
static const char *const HARD_NAME[HARD_COUNT] = {
    "dark", "bright", "flat", "saturated", "backlit", "busy"};

static inline uint16_t rgb565(int r, int g, int b) {
  if (r < 0) r = 0; if (r > 31) r = 31;
  if (g < 0) g = 0; if (g > 63) g = 63;
  if (b < 0) b = 0; if (b > 31) b = 31;
  return (uint16_t)((r << 11) | (g << 5) | b);
}

/** Deterministic value noise, so every run of the harness is the same run. */
static inline int hard_noise(int x, int y, int salt) {
  unsigned h = (unsigned)(x * 374761393 + y * 668265263 + salt * 2246822519u);
  h = (h ^ (h >> 13)) * 1274126177u;
  return (int)((h ^ (h >> 16)) & 0xff);
}

static uint16_t hard_px(int kind, int x, int y, int w, int h, int cam) {
  const int n = hard_noise(x, y, kind * 7 + 1);
  const int fx = (x * 256) / w, fy = (y * 256) / h;
  /* Each camera a third of a stop apart, and a few pixels off. */
  const int ev = cam - 1;
  switch (kind) {
    case HARD_DARK: {
      /* A room with the lights off: everything inside two levels of black,
       * one dim shape in it. Nothing here should make the interface shout. */
      const int d = (fx - 150) * (fx - 150) + (fy - 120) * (fy - 120);
      const int glow = d < 3000 ? (3000 - d) / 600 : 0;
      return rgb565(1 + glow + ev + (n >> 7), 2 + glow * 2 + (n >> 6), 2 + glow + (n >> 7));
    }
    case HARD_BRIGHT: {
      /* Blown out and clipped: no headroom left anywhere, so anything drawn
       * in white over this has nothing to sit against. */
      const int k = 28 + (n >> 6) + ev;
      return rgb565(k + 3, (k + 3) * 2, k + 2);
    }
    case HARD_FLAT: {
      /* A beige wall, which is the worst case for anything that reads
       * contrast: the range is two levels and the four cameras agree. */
      return rgb565(21 + (n >> 7) + ev, 40 + (n >> 6), 15 + (n >> 7));
    }
    case HARD_SATURATED: {
      /* A red-lit room. The channels are nowhere near each other, which is
       * where a colour-separation effect stops reading as an effect. */
      return rgb565(29 + (n >> 7), (fy >> 4) + (n >> 6), 6 + (fx >> 5) + ev);
    }
    case HARD_BACKLIT: {
      /* A face against a window: most of the frame is near black and a third
       * of it is clipped white, with nothing in between. */
      if (fx > 170) return rgb565(30, 60, 29);
      const int k = 2 + (fx >> 6) + (n >> 7) + ev;
      return rgb565(k, k * 2, k + 1);
    }
    default: {
      /* A crowded room: high frequency everywhere, no large flat area, which
       * is what makes a thin line or small type disappear. */
      const int m = hard_noise(x >> 1, y >> 1, 99);
      return rgb565((n >> 3) + (m >> 5), (m >> 2), (hard_noise(x, y, 5) >> 3) + ev);
    }
  }
}

static void fake_viewfinder_hard(int kind) {
  for (int c = 0; c < 4; c++) {
    for (int y = 0; y < VF_H; y++)
      for (int x = 0; x < VF_W; x++) {
        uint16_t p = hard_px(kind, x + c * 3, y + c * 2, VF_W, VF_H, c);
        /* The harness's own mark. NOT the white border the gradient frames
         * carry: ksense.h reads contrast as the range between the darkest and
         * the brightest sample it takes, and a single white pixel in the grid
         * pins that at full range whatever the room is actually like. The
         * mark is the frame's own value lifted by a third instead - plainly a
         * drawn line, and inside the range it is measuring. */
        if (x == 0 || y == 0 || x == VF_W - 1 || y == VF_H - 1)
          p = rgb565(((p >> 11) & 31) + 2, ((p >> 5) & 63) + 4, (p & 31) + 2);
        g_vf[c][y * VF_W + x] = p;
      }
  }
  g_vf_filled = true;
}

static void fake_gallery_hard(int kind) {
  for (int i = 0; i < GALLERY_PAGE; i++)
    for (int y = 0; y < GALLERY_TILE_H; y++)
      for (int x = 0; x < GALLERY_TILE_W; x++)
        g_tile[i][y * GALLERY_TILE_W + x] =
            hard_px(kind, x + i * 11, y + i * 7, GALLERY_TILE_W, GALLERY_TILE_H, i & 3);
}

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

#include <stdarg.h>
/* The device log, to stderr: the film scenes drive ui_pass() and its touch and
 * gesture lines are how a frame that shows nothing gets explained. */
void klog(const char *src, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "K %s: ", src);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
  va_end(ap);
}

/* No card on a workstation, so every decode fails and the photograph view
 * renders its own "no image" state - which is a state worth photographing. */
/**
 * The still a photograph screen shows, painted rather than decoded.
 *
 * This used to fail unconditionally, which meant every photograph in every
 * film went down the four-up quad branch and the single-image screen was
 * never once rendered by the harness. The path matters now: a photograph is
 * one scene object from the roll into the full screen, and there is no way to
 * see that without a picture in it. The gradient is the fake gallery's, so
 * the still and the thumbnail of the same capture look like the same photo.
 */
esp_err_t thumb_load(const char *path, uint16_t *tile, int tile_w, int tile_h, uint16_t pad) {
  (void)pad;
  if (!tile || tile_w <= 0 || tile_h <= 0) return ESP_FAIL;
  /* The capture's index, so each photograph is its own picture. */
  int seed = 0;
  for (const char *p = path ? path : ""; *p; p++) seed = seed * 31 + (unsigned char)*p;
  seed = (seed & 7);
  for (int y = 0; y < tile_h; y++) {
    for (int x = 0; x < tile_w; x++) {
      const int r = (x * 31) / tile_w;
      const int g = (y * 63) / tile_h;
      const int b = 31 - ((x + y) * 31) / (tile_w + tile_h);
      tile[y * tile_w + x] = (uint16_t)((((r + seed * 3) & 31) << 11) | ((g & 63) << 5) | (b & 31));
    }
  }
  return ESP_OK;
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

static uint64_t g_card_free = 30648041472ULL;
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
  out->free_bytes = g_card_free;
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
void upload_queue_forget(const char *capture_uuid) { (void)capture_uuid; }
void upload_queue_status(upload_queue_report_t *out) {
  if (out != NULL) *out = g_queue;
}
int upload_queue_retry_all(void) { return 0; }

#define KINO_PLAYGROUND 1
#include "ui.c"

/* ---- output ---- */

/* Set by any failed write. CI counts .ppm files and requires at least ten, so
 * a run that could not write half its screens - a full disk, a bad output
 * path, a directory that does not exist - could still satisfy the gate with
 * the ones that did land. A partial artifact is a failure, and this is what
 * makes main() say so. */
static bool g_write_failed;

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

static char g_out[512];
static void shot(const char *name) {
  char path[600];
  snprintf(path, sizeof path, "%s/%s.ppm", g_out, name);
  write_ppm(path, g_canvas, UI_W, UI_H);
}

/** Empty a label node and forget where it was: between film scenes only. */
static void scene_clear_word(const char *id) {
  ks_node_t *n = ks_peek(id);
  if (!n) return;
  n->text = "";
  n->w = 0.f;
  n->char_clip = -1;
  ks_pose(n, KC_ALPHA, 0.f);
  ks_snap(n);
}

int main(int argc, char **argv) {
  snprintf(g_out, sizeof g_out, "%s", argc > 1 ? argv[1] : ".");

  g_canvas = calloc((size_t)UI_W * UI_H, sizeof(uint16_t));
  s_cv = g_canvas;
  ks_init();
  s_kmo_sound = kmo_sound_cb;
  kb_seed(7);

  /* One helper, so every state below is "set the state, draw, name it" and
   * the list reads as the screen inventory it is meant to be. */
#define SHOT(scr, name)      \
  do {                       \
    s_screen = (scr);        \
    draw_screen();           \
    shot(name);              \
  } while (0)

/**
 * A shot of the state at rest.
 *
 * Plain SHOT renders one frame with no time passing, so whatever the previous
 * shot left in flight is still in flight: a row that has just been told to
 * move sits at its old place, a clip that has just started has not started
 * moving. That is the right picture of a transition and the wrong picture of
 * a layout. This one lets the scene settle first, which is what the screen
 * looks like in the hand a second later.
 */
#define SHOT_REST(scr, name)                          \
  do {                                                \
    s_screen = (scr);                                 \
    for (int rest_i = 0; rest_i < 30; rest_i++) {     \
      g_preview_clock_us += 33000;                    \
      draw_screen();                                  \
    }                                                 \
    shot(name);                                       \
  } while (0)

  fake_gallery();

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
  sh_reveal(); /* as on entering the mode: the words are showing */
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
  s_pressed = SH_IT_MODE;
  SHOT(SCR_SHOOT, "shoot_back_pressed");
  s_pressed = -1;

  /* ---- capture feedback, over the viewfinder it will most often cover ---- */
  s_screen = SCR_SHOOT;
  g_stage = CAPTURE_READING;
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
  draw_screen();
  shot("capture_saved");

  g_report.stored = 3;
  draw_screen();
  shot("capture_partial");

  g_report.ok = false;
  snprintf(g_report.err_code, sizeof g_report.err_code, "CARD FULL");
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
  s_focus[SCR_LOOK] = FL_IT_NEXT;
  s_pressed = FL_IT_MONO + 1; /* FLASH / ON, held */
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
  SHOT_REST(SCR_ROLL, "roll");

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
  SHOT_REST(SCR_ROLL, "roll_active");

  /* Online and working: five landed in this burst, one in flight, three
   * behind it - a bar with something to say. */
  g_queue.uploading = 1;
  g_queue.pending = 3;
  g_queue.burst_done = 5;
  g_queue.draining = true;
  g_queue.last_upload_ms = esp_timer_get_time() / 1000 - 2000;
  SHOT_REST(SCR_ROLL, "roll_uploading");

  /* Wi-Fi gone, three waiting: saved safely on the camera, not failed. */
  g_net_state = NET_WIFI_IDLE;
  g_net_routed = true;
  memset(&g_queue, 0, sizeof g_queue);
  g_queue.pending = 3;
  g_queue.scan_complete = true;
  SHOT_REST(SCR_ROLL, "roll_offline");

  /* Just booted: the card has not been counted yet and nothing is known to
   * be waiting. The line lasts seconds and then disappears. */
  g_net_state = NET_IP_READY;
  memset(&g_queue, 0, sizeof g_queue);
  g_queue.server_state = UPLOAD_SERVER_UNKNOWN;
  SHOT_REST(SCR_ROLL, "roll_counting");

  /* Wi-Fi up, the server not answering: a different word from OFFLINE, and
   * still nothing a guest should read as a failed photograph. */
  memset(&g_queue, 0, sizeof g_queue);
  g_queue.pending = 2;
  g_queue.scan_complete = true;
  g_queue.server_state = UPLOAD_SERVER_UNREACHABLE;
  SHOT_REST(SCR_ROLL, "roll_server_quiet");

  /* Stopped on a credential fault, which is not the same as failed. */
  memset(&g_queue, 0, sizeof g_queue);
  g_queue.halted = true;
  g_queue.pending = 8;
  g_queue.scan_complete = true;
  snprintf(g_queue.last_error, sizeof g_queue.last_error, "INVALID_DEVICE_TOKEN");
  SHOT_REST(SCR_ROLL, "roll_paused");

  /* A guest URL too long to encode: the code is shown as text instead of a
   * QR-shaped block no phone can read. */
  memset(&g_queue, 0, sizeof g_queue);
  memset(g_roll.guest_url, 'x', sizeof g_roll.guest_url - 1);
  g_roll.guest_url[sizeof g_roll.guest_url - 1] = '\0';
  SHOT_REST(SCR_ROLL, "roll_qr_failed");

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
  s_focus[SCR_STORAGE] = ST_IT_FORMAT;
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
  draw_screen();
  shot("power_restart_confirm");
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

  /* ---- film: the interface in motion ----
   *
   * ui_pass() driven by hand with a fake clock. Each frame is the canvas
   * after the pass that ran at that instant, named by its time, so a
   * behaviour reads as a strip and a regression in its timing is a diff. */
#define FILM(name, at_ms)                                          \
  do {                                                             \
    g_preview_clock_us = film_t0 + (int64_t)(at_ms) * 1000;        \
    (void)ui_pass();                                               \
    char fn[80];                                                   \
    snprintf(fn, sizeof fn, "film_%s_%04d", name, (int)(at_ms));   \
    shot(fn);                                                      \
  } while (0)
#define STEP(at_ms)                                                \
  do {                                                             \
    g_preview_clock_us = film_t0 + (int64_t)(at_ms) * 1000;        \
    (void)ui_pass();                                               \
  } while (0)
#define SCENE()                                                    \
  do {                                                             \
    g_preview_clock_us += 1500000;                                 \
    film_t0 = g_preview_clock_us;                                  \
    s_pressed = -1;                                                \
    if (s_dialog != DLG_NONE) dialog_close();                      \
    g_stage = CAPTURE_IDLE;                                        \
    g_frames_in = 0;                                               \
    /* The tail of the last scene is not this scene's material: stop what it  \
     * started and snap the words it left mid-flight. */            \
    ks_stop_tag("cap");                                            \
    ks_stop_tag("capture_success");                                \
    ks_stop_tag("capture_fail");                                   \
    ks_stop_tag("note");                                           \
    scene_clear_word("cap.label");                                 \
    scene_clear_word("cap.sub");                                   \
    scene_clear_word("cap.big");                                   \
    scene_clear_word("note");                                      \
  } while (0)

  s_pressed = -1;
  s_dialog = DLG_NONE;
  g_stage = CAPTURE_IDLE;
  int64_t film_t0 = g_preview_clock_us;

  /* -- navigation: one swipe, then three faster than the motion finishes -- */
  SCENE();
  go(SCR_SHOOT, 0);
  STEP(0);
  mode_swipe_vel(1, 0.f);
  FILM("swipe", 0); FILM("swipe", 16); FILM("swipe", 40); FILM("swipe", 70); FILM("swipe", 100); FILM("swipe", 140);
  FILM("swipe", 190); FILM("swipe", 250); FILM("swipe", 320); FILM("swipe", 420); FILM("swipe", 560);
  SCENE();
  mode_swipe_vel(1, 0.f);
  FILM("rapid", 0); FILM("rapid", 40); FILM("rapid", 80);
  mode_swipe_vel(1, 0.f);
  FILM("rapid", 90); FILM("rapid", 120); FILM("rapid", 160);
  mode_swipe_vel(-1, 0.f);
  FILM("rapid", 170); FILM("rapid", 200); FILM("rapid", 240); FILM("rapid", 300); FILM("rapid", 400); FILM("rapid", 560); FILM("rapid", 800);

  /* -- world_shoot_look: the four cameras become the photograph --
   *
   * The hero transformation, and the whole point of the world model. The same
   * four pane objects are the quad in SHOOT and the single image in LOOK; the
   * screen only changes what shape they are in, and continuity does the rest.
   * Nothing is unloaded, so the user can follow the picture across. */
  SCENE();
  go(SCR_SHOOT, 0);
  s_sh_words_up = false;
  STEP(0);
  STEP(300);
  film_t0 = g_preview_clock_us;
  go(SCR_LOOK, 0);
  FILM("world_shoot_look", 0); FILM("world_shoot_look", 30); FILM("world_shoot_look", 60);
  FILM("world_shoot_look", 100); FILM("world_shoot_look", 150); FILM("world_shoot_look", 210);
  FILM("world_shoot_look", 290); FILM("world_shoot_look", 380); FILM("world_shoot_look", 500);
  FILM("world_shoot_look", 700);
  /* ...and back, which must be the same object shrinking into its quarter. */
  film_t0 = g_preview_clock_us;
  go(SCR_SHOOT, 0);
  FILM("world_look_shoot", 0); FILM("world_look_shoot", 40); FILM("world_look_shoot", 90);
  FILM("world_look_shoot", 160); FILM("world_look_shoot", 260); FILM("world_look_shoot", 400);
  FILM("world_look_shoot", 600);

  /* -- world_drag: the finger carries the world, and the release finishes it --
   *
   * Three gestures on the same screen. A slow drag most of the way across,
   * which commits. A drag a third of the way that is let go, which comes back.
   * And a short fast flick, which commits on speed rather than distance.
   * The point of the films is the frames DURING the gesture: the world should
   * already be part of the way into the next state, in proportion to the
   * finger. */
#define FINGER(fx, at_ms)                                          \
  do {                                                             \
    g_touch_down = true;                                           \
    g_touch_lx = (fx);                                             \
    g_touch_ly = UI_H / 2;                                         \
    FILM(dragname, at_ms);                                         \
  } while (0)
#define LIFT(at_ms)                                                \
  do {                                                             \
    g_touch_down = false;                                          \
    FILM(dragname, at_ms);                                         \
  } while (0)

  {
    const char *dragname = "world_drag_slow";
    SCENE();
    go(SCR_SHOOT, 0);
    s_sh_words_up = false;
    STEP(0);
    FINGER(600, 0); FINGER(560, 60); FINGER(500, 120); FINGER(440, 180);
    FINGER(380, 240); FINGER(330, 300); FINGER(300, 360);
    LIFT(400);
    FILM(dragname, 460); FILM(dragname, 540); FILM(dragname, 660); FILM(dragname, 820);
  }
  {
    const char *dragname = "world_drag_return";
    SCENE();
    go(SCR_SHOOT, 0);
    s_sh_words_up = false;
    STEP(0);
    FINGER(600, 0); FINGER(560, 60); FINGER(530, 120); FINGER(520, 200); FINGER(518, 300);
    LIFT(360);
    FILM(dragname, 420); FILM(dragname, 500); FILM(dragname, 620); FILM(dragname, 780);
  }
  {
    /* Eighty pixels, short of the ninety that commit on distance alone,
     * thrown at 2 px/ms, which is well over the speed that commits. The world
     * has barely moved when the finger leaves and still lands on the next
     * state, carrying the throw into the settle. */
    const char *dragname = "world_drag_flick";
    SCENE();
    go(SCR_SHOOT, 0);
    s_sh_words_up = false;
    STEP(0);
    FINGER(600, 0); FINGER(565, 16); FINGER(520, 32);
    LIFT(40);
    FILM(dragname, 70); FILM(dragname, 110); FILM(dragname, 170); FILM(dragname, 260); FILM(dragname, 400);
    FILM(dragname, 600);
  }
  g_touch_down = false;
  STEP(0);
#undef FINGER
#undef LIFT

  /* -- world_roll_link: the roll opens itself to KINO ROLL --
   *
   * The grid is not cleared and the code is not drawn onto an empty page.
   * The same photograph objects compress into a column, the facts move right
   * to leave them the edge, and the code grows into the space they made. */
  SCENE();
  g_roll_active = true;
  /* An earlier scene deliberately leaves an unencodable URL behind to film
   * the fallback; this one wants the code itself. */
  snprintf(g_roll.guest_url, sizeof g_roll.guest_url, "https://kino.acronym.sk/r/K7M2QP");
  snprintf(g_roll.slug, sizeof g_roll.slug, "K7M2QP");
  snprintf(g_roll.name, sizeof g_roll.name, "FRIDAY PARTY");
  go(SCR_GALLERY, 0);
  STEP(0);
  STEP(600);
  film_t0 = g_preview_clock_us;
  go(SCR_CONNECTION, 0);
  FILM("world_roll_link", 0); FILM("world_roll_link", 30); FILM("world_roll_link", 60);
  FILM("world_roll_link", 100); FILM("world_roll_link", 150); FILM("world_roll_link", 220);
  FILM("world_roll_link", 320); FILM("world_roll_link", 460); FILM("world_roll_link", 650);
  /* ...and straight back, which must re-form the grid rather than rebuild it. */
  film_t0 = g_preview_clock_us;
  go(SCR_GALLERY, 0);
  FILM("world_link_roll", 0); FILM("world_link_roll", 40); FILM("world_link_roll", 90);
  FILM("world_link_roll", 160); FILM("world_link_roll", 260); FILM("world_link_roll", 420);
  FILM("world_link_roll", 620);

  /* -- world_capture: the whole thing, decided by the camera --
   *
   * Every other capture film names the clip it wants, which is useful for
   * reviewing one behaviour and useless for reviewing the path. Here nothing
   * is named: the stage changes, cap_watch arms the choreography, each source
   * frame opens its own gate as it lands, the report goes to the behaviour
   * controller at the end and the controller decides what - if anything - the
   * camera says about it. A clean four-way sync on a scene held still, which
   * is the shot the camera should be most pleased with.
   *
   * What this films against is a path that only works when a test drives it. */
  SCENE();
  go(SCR_SHOOT, 0);
  s_sh_words_up = false;
  for (int t = 0; t <= 600; t += 30) STEP(t);  /* held still: framing_ms earns its band */
  film_t0 = g_preview_clock_us;
  g_stage = CAPTURE_READING;
  g_frames_in = 0;
  FILM("world_capture", 0); FILM("world_capture", 30); FILM("world_capture", 60);
  g_frames_in = 1;              FILM("world_capture", 110);
  g_frames_in = 1 | 2;          FILM("world_capture", 150);
  g_frames_in = 1 | 2 | 4;      FILM("world_capture", 190);
  g_frames_in = 15;             FILM("world_capture", 230);
  FILM("world_capture", 300); FILM("world_capture", 400);
  memset(&g_report, 0, sizeof g_report);
  g_report.ok = true; g_report.stored = 4; g_report.online = 4;
  snprintf(g_report.id, sizeof g_report.id, "CAP_000037");
  for (int c = 0; c < 4; c++) {
    g_report.cam[c].attempted = true; g_report.cam[c].ok = true;
    g_report.cam[c].sync_class = PURE_SYNC_OK;
  }
  g_stage = CAPTURE_DONE;       /* cap_watch reports; the controller chooses */
  FILM("world_capture", 460); FILM("world_capture", 560); FILM("world_capture", 700);
  FILM("world_capture", 900); FILM("world_capture", 1200); FILM("world_capture", 1700);
  g_stage = CAPTURE_IDLE;
  STEP(2000);

  /* -- world_capture_roll: the photograph that was just made --
   *
   * The four views become one object, that object shrinks into the corner
   * rather than being thrown away, and opening the roll while it is still in
   * the hand carries the same object into the first tile. Nothing is drawn
   * twice: there is one photograph, and the roll is where it ends up.
   *
   * `CAP_000037` is the preview roll's first slot, so the object born at the
   * shutter and the tile it becomes are the same photograph, which is the
   * whole point of the scene. */
  SCENE();
  go(SCR_SHOOT, 0);
  s_sh_words_up = false;
  STEP(0);
  g_stage = CAPTURE_READING;
  g_frames_in = 0;
  FILM("world_capture_roll", 0);
  g_frames_in = 15;
  STEP(120);
  s_capw.reported = false;
  memset(&g_report, 0, sizeof g_report);
  g_report.ok = true; g_report.stored = 4; g_report.online = 4;
  snprintf(g_report.id, sizeof g_report.id, "CAP_000037");
  snprintf(g_report.uuid, sizeof g_report.uuid, "preview-0");
  for (int c = 0; c < 4; c++) { g_report.cam[c].attempted = true; g_report.cam[c].ok = true; }
  g_stage = CAPTURE_DONE;
  film_t0 = g_preview_clock_us;
  FILM("world_capture_roll", 0); FILM("world_capture_roll", 40);
  FILM("world_capture_roll", 90); FILM("world_capture_roll", 170);
  FILM("world_capture_roll", 300); FILM("world_capture_roll", 500);
  g_stage = CAPTURE_IDLE;
  /* ...and the roll is opened while it is still settling. */
  STEP(700);
  film_t0 = g_preview_clock_us;
  go(SCR_GALLERY, 0);
  FILM("world_capture_roll", 750); FILM("world_capture_roll", 790);
  FILM("world_capture_roll", 850); FILM("world_capture_roll", 950);
  FILM("world_capture_roll", 1100); FILM("world_capture_roll", 1350);

  /* -- world_transfer: the queue drains, and the photographs say so --
   *
   * No bar and no fraction: the queue cannot name the capture in flight or
   * say how far through it is, so anything continuous would be a shape rather
   * than a fact. What is real is that the worker is working - the pile is
   * unsettled - and that at a particular instant one landed, which the pile
   * acknowledges once. The number is the count still owed, and it only ever
   * goes down. Then the radio goes and everything stops moving, because
   * nothing is moving. */
  SCENE();
  g_roll_active = true;
  snprintf(g_roll.guest_url, sizeof g_roll.guest_url, "https://kino.acronym.sk/r/K7M2QP");
  snprintf(g_roll.slug, sizeof g_roll.slug, "K7M2QP");
  snprintf(g_roll.name, sizeof g_roll.name, "FRIDAY PARTY");
  g_net_state = NET_IP_READY;
  g_net_routed = true;
  memset(&g_queue, 0, sizeof g_queue);
  g_queue.scan_complete = true;
  g_queue.server_state = UPLOAD_SERVER_REACHABLE;
  g_queue.draining = true;
  g_queue.uploading = 1;
  g_queue.pending = 4;
  g_queue.burst_done = 0;
  go(SCR_CONNECTION, 0);
  STEP(0);
  film_t0 = g_preview_clock_us;
  FILM("world_transfer", 0); FILM("world_transfer", 180);
  /* One lands. */
  g_queue.uploaded = 1; g_queue.burst_done = 1; g_queue.pending = 3;
  g_queue.last_upload_ms = g_preview_clock_us / 1000;
  FILM("world_transfer", 360); FILM("world_transfer", 430); FILM("world_transfer", 560);
  /* And another. */
  g_queue.uploaded = 2; g_queue.burst_done = 2; g_queue.pending = 2;
  g_queue.last_upload_ms = g_preview_clock_us / 1000 + 200;
  FILM("world_transfer", 760); FILM("world_transfer", 830); FILM("world_transfer", 980);
  /* Working, and nothing landing: the pile is restless and says nothing else. */
  FILM("world_transfer", 1400); FILM("world_transfer", 1900); FILM("world_transfer", 2400);
  /* The radio goes mid-queue: nothing is moving, so nothing moves. */
  g_net_state = NET_WIFI_SCANNING;
  g_queue.draining = false;
  g_queue.uploading = 0;
  FILM("world_transfer", 2700); FILM("world_transfer", 2900); FILM("world_transfer", 3200);

  /* -- world_wake: the world comes back in the order the hardware does --
   *
   * Waking is not a title card and not a fade. The panel goes dark, so the
   * cameras stop, so every one of them is news again when the camera is
   * picked up - and each surface springs into its quarter on the frame its
   * own sensor sends, tens of milliseconds apart. Nothing waits for the
   * slowest and nothing pretends the fast ones were late. */
  SCENE();
  go(SCR_SHOOT, 0);
  s_sh_words_up = false;
  STEP(0);
  g_vf_dead = 0xF; /* asleep: nothing is answering */
  STEP(40);
  film_t0 = g_preview_clock_us;
  FILM("world_wake", 0);
  g_vf_dead = 0xE; FILM("world_wake", 40); FILM("world_wake", 70);
  g_vf_dead = 0xA; FILM("world_wake", 110); FILM("world_wake", 150);
  g_vf_dead = 0x8; FILM("world_wake", 200);
  g_vf_dead = 0x0; FILM("world_wake", 260); FILM("world_wake", 320);
  FILM("world_wake", 420); FILM("world_wake", 600);

  /* -- world_interrupt: the world changes its mind, twice, mid-transformation --
   *
   * The hero transformation is the four surfaces converging into one image.
   * Here it is reversed a third of the way in, and reversed again before THAT
   * has finished. Nothing restarts, nothing snaps and no state is rebuilt:
   * each reversal begins from the shape the surface had actually reached, so
   * the second one starts from a quad that was never a resting quad. The user
   * always wins, and the world is always somewhere real.
   *
   * The failure this films against is the one that looks fine in a still: a
   * transformation that plays from its authored start pose every time, so an
   * interrupted world jumps back to a shape it had already left. */
  SCENE();
  go(SCR_SHOOT, 0);
  s_sh_words_up = false;
  STEP(0);
  STEP(300);
  film_t0 = g_preview_clock_us;
  go(SCR_LOOK, 0);
  FILM("world_interrupt", 0); FILM("world_interrupt", 60); FILM("world_interrupt", 120);
  go(SCR_SHOOT, 0);                       /* a third of the way in, back */
  FILM("world_interrupt", 160); FILM("world_interrupt", 200); FILM("world_interrupt", 250);
  go(SCR_LOOK, 0);                        /* and again, before that has landed */
  FILM("world_interrupt", 300); FILM("world_interrupt", 360); FILM("world_interrupt", 440);
  FILM("world_interrupt", 560); FILM("world_interrupt", 760);

  /* -- world_setup: the photographic world flattens into the rule --
   *
   * SETUP is the one state allowed to break the world, and it does not do
   * that by throwing it away. The four live surfaces flatten into a line a
   * few pixels tall above the first row - the pictures leave, and what
   * organises the settings is made of them and is the colour of the room the
   * camera is standing in. Coming back out, the same four open up again. */
  SCENE();
  go(SCR_SHOOT, 0);
  s_sh_words_up = false;
  STEP(0);
  STEP(300);
  film_t0 = g_preview_clock_us;
  go(SCR_SETTINGS, 0);
  FILM("world_setup", 0); FILM("world_setup", 40); FILM("world_setup", 90);
  FILM("world_setup", 150); FILM("world_setup", 230); FILM("world_setup", 340);
  FILM("world_setup", 500); FILM("world_setup", 720);
  film_t0 = g_preview_clock_us;
  go(SCR_SHOOT, 0);
  FILM("world_setup_out", 0); FILM("world_setup_out", 50); FILM("world_setup_out", 110);
  FILM("world_setup_out", 190); FILM("world_setup_out", 300); FILM("world_setup_out", 460);
  FILM("world_setup_out", 700);

  /* -- world_camera_lost: the fundamental object loses a quarter --
   *
   * Camera 3 stops answering. The picture falls out of its quarter rather
   * than fading politely, its mark drops, and the word says which one - once,
   * and not again for a minute however many times the link flaps. The other
   * three do not rearrange: the photograph is still a four-up, and one of the
   * four is missing. Then it comes back, and the quarter filling in is the
   * whole of the message. */
  SCENE();
  go(SCR_SHOOT, 0);
  s_sh_words_up = false;
  STEP(0);
  STEP(400);
  film_t0 = g_preview_clock_us;
  FILM("world_camera_lost", 0);
  g_vf_dead = 0x4;
  events_watch();
  FILM("world_camera_lost", 40); FILM("world_camera_lost", 80); FILM("world_camera_lost", 140);
  FILM("world_camera_lost", 220); FILM("world_camera_lost", 340); FILM("world_camera_lost", 520);
  g_vf_dead = 0x0;
  events_watch();
  FILM("world_camera_lost", 600); FILM("world_camera_lost", 660); FILM("world_camera_lost", 760);
  FILM("world_camera_lost", 920);

  /* ---- the same interface, over photography that fights it ----
   *
   * Six rooms an interface never gets shown in a portfolio. For each one the
   * finder, a capture, the roll, the sharing screen and the settings rule, so
   * that white type on a shadow, a three pixel line made of the picture, and
   * a stack of photographs can all be looked at over content that gives them
   * nothing to sit against. The numbers underneath say what the camera made
   * of the room, which is the other half of the test: a behaviour that only
   * ever fires on a pleasant gradient is not a behaviour.
   */
  for (int hk = 0; hk < HARD_COUNT; hk++) {
    char nm[64];
    fake_viewfinder_hard(hk);
    fake_gallery_hard(hk);
    ksense_reset();
    SCENE();
    /* Each room is walked into fresh. Without this the shot taken in the last
     * room is still inside the burst window of the one before it - six
     * captures inside twenty seconds of clock is a burst, and the mood would
     * be reporting the harness rather than the photography. */
    g_preview_clock_us += 180ll * 1000000;
    film_t0 = g_preview_clock_us;
    memset(&s_kmood, 0, sizeof s_kmood);
    go(SCR_SHOOT, 0);
    /* Long enough for the sparse sweep to have run several times. */
    for (int t = 0; t <= 900; t += 90) STEP(t);
    snprintf(nm, sizeof nm, "hard_%s_shoot", HARD_NAME[hk]);
    shot(nm);
    fprintf(stderr, "[hard] %-10s lum %3d  contrast %3d  spread %3d  motion %3d  -> energy %3d calm %3d\n",
            HARD_NAME[hk], (int)(s_ksense.lum_mean * 100.f), (int)(s_ksense.contrast * 100.f),
            (int)(s_ksense.spread * 100.f), (int)(s_ksense.motion_mean * 100.f),
            (int)(s_kmood.energy * 100.f), (int)(s_kmood.calm * 100.f));

    /* A capture, taken in that room, with the word it earns. */
    g_stage = CAPTURE_READING;
    g_frames_in = 0;
    STEP(950);
    g_frames_in = 15;
    STEP(1010);
    memset(&g_report, 0, sizeof g_report);
    g_report.ok = true; g_report.stored = 4; g_report.online = 4;
    snprintf(g_report.id, sizeof g_report.id, "CAP_000037");
    for (int c = 0; c < 4; c++) { g_report.cam[c].attempted = true; g_report.cam[c].ok = true; }
    s_capw.reported = true;
    g_stage = CAPTURE_DONE;
    STEP(1080);
    ui_run_clip(KEV_CAPTURE_SUCCESS, KCLIP_CAP_FOUR_MERGE, "GOT IT.");
    STEP(1140);
    snprintf(nm, sizeof nm, "hard_%s_capture", HARD_NAME[hk]);
    shot(nm);
    STEP(1600);
    g_stage = CAPTURE_IDLE;

    go(SCR_GALLERY, 0);
    for (int t = 1700; t <= 2300; t += 150) STEP(t);
    snprintf(nm, sizeof nm, "hard_%s_roll", HARD_NAME[hk]);
    shot(nm);

    g_roll_active = true;
    snprintf(g_roll.guest_url, sizeof g_roll.guest_url, "https://kino.acronym.sk/r/K7M2QP");
    snprintf(g_roll.slug, sizeof g_roll.slug, "K7M2QP");
    snprintf(g_roll.name, sizeof g_roll.name, "FRIDAY PARTY");
    go(SCR_CONNECTION, 0);
    for (int t = 2400; t <= 3100; t += 150) STEP(t);
    snprintf(nm, sizeof nm, "hard_%s_link", HARD_NAME[hk]);
    shot(nm);
    g_roll_active = false;

    go(SCR_SETTINGS, 0);
    for (int t = 3200; t <= 3900; t += 150) STEP(t);
    snprintf(nm, sizeof nm, "hard_%s_setup", HARD_NAME[hk]);
    shot(nm);
  }
  fake_viewfinder();  /* back to the frames every other shot is taken on */
  fake_gallery();
  ksense_reset();

  /* -- the mode strip -- */
  SCENE();
  go(SCR_GALLERY, 0);
  STEP(0);
  row_open(g_preview_clock_us);
  FILM("strip", 0); FILM("strip", 30); FILM("strip", 60); FILM("strip", 100); FILM("strip", 150); FILM("strip", 220); FILM("strip", 320); FILM("strip", 500);
  row_close();
  FILM("strip", 520); FILM("strip", 580); FILM("strip", 700);

  /* -- ROLL: a page turn, then a photograph opening from its tile -- */
  SCENE();
  go(SCR_GALLERY, 0);
  STEP(0);
  gal_turn(1);
  FILM("page", 0); FILM("page", 30); FILM("page", 60); FILM("page", 100); FILM("page", 150); FILM("page", 220); FILM("page", 320); FILM("page", 480);
  SCENE();
  gal_turn(-1);
  STEP(0);
  STEP(700);
  {
    const gallery_item_t *slots = gallery_slots();
    /* A wiggle capture, so this is the single-image path - a four-up quad is
     * its own composition and has no one object to follow across. */
    if (photo_open(&slots[1])) {
      film_t0 = g_preview_clock_us;
      go(SCR_PHOTO, 0);
      /* world_roll_look: the picture the user touched grows out of the grid.
       * It is the same scene object throughout - no clip, no copy - and its
       * neighbours are pushed outward and let go rather than cut. */
      FILM("world_roll_look", 0); FILM("world_roll_look", 30); FILM("world_roll_look", 60);
      FILM("world_roll_look", 100); FILM("world_roll_look", 150); FILM("world_roll_look", 220);
      FILM("world_roll_look", 320); FILM("world_roll_look", 500);
      /* ...and back into the grid it came from. */
      film_t0 = g_preview_clock_us;
      go(SCR_GALLERY, 0);
      FILM("world_look_roll", 0); FILM("world_look_roll", 40); FILM("world_look_roll", 90);
      FILM("world_look_roll", 160); FILM("world_look_roll", 260); FILM("world_look_roll", 420);
      go(SCR_PHOTO, 0);
      STEP(700);
      dialog_open(DLG_DELETE);
      FILM("dialog", 0); FILM("dialog", 40); FILM("dialog", 90); FILM("dialog", 150); FILM("dialog", 260); FILM("dialog", 400);
      dialog_close();
    }
  }

  /* -- the finder's words showing and letting go -- */
  SCENE();
  s_sh_show_ms = 600;
  go(SCR_SHOOT, 0);
  film_t0 = g_preview_clock_us;
  FILM("words", 0); FILM("words", 40); FILM("words", 90); FILM("words", 160); FILM("words", 300); FILM("words", 640); FILM("words", 720); FILM("words", 820); FILM("words", 960);

  /* -- capture: the shutter response, then each behaviour by name -- */
  {
    struct { const char *name; int clip; const char *text; } CAP[] = {
        {"cap_none", KCLIP_CAP_NONE, NULL},           {"cap_quiet", KCLIP_CAP_QUIET, NULL},
        {"cap_merge", KCLIP_CAP_FOUR_MERGE, "GOT IT."}, {"cap_text", KCLIP_CAP_TEXT_HIT, "NICE."},
        {"cap_cut", KCLIP_CAP_HARD_CUT, "OK."},       {"cap_energy", KCLIP_CAP_ENERGY, "YES."},
        {"cap_hundred", KCLIP_CAP_HUNDRED, "A HUNDRED."}, {"cap_fail", KCLIP_CAP_FAIL, "NO FRAME."},
    };
    for (size_t i = 0; i < sizeof CAP / sizeof CAP[0]; i++) {
      SCENE();
      go(SCR_SHOOT, 0);
      s_sh_words_up = false;
      STEP(0);
      g_stage = CAPTURE_READING;
      g_frames_in = 0;
      FILM(CAP[i].name, 0); FILM(CAP[i].name, 16); FILM(CAP[i].name, 36); FILM(CAP[i].name, 60); FILM(CAP[i].name, 96);
      FILM(CAP[i].name, 110); FILM(CAP[i].name, 124); FILM(CAP[i].name, 140);
      g_frames_in = 1; STEP(180); g_frames_in = 3; STEP(215); g_frames_in = 7; STEP(250); g_frames_in = 15;
      FILM(CAP[i].name, 280);
      /* The report: the film chooses the behaviour instead of the draw. */
      memset(&g_report, 0, sizeof g_report);
      g_report.ok = CAP[i].clip != KCLIP_CAP_FAIL;
      g_report.stored = g_report.ok ? 4 : 0;
      g_report.online = 4;
      for (int c = 0; c < 4; c++) { g_report.cam[c].attempted = true; g_report.cam[c].ok = g_report.ok; }
      s_capw.reported = true;
      g_stage = CAPTURE_DONE;
      STEP(360);
      if (CAP[i].clip == KCLIP_CAP_FAIL) snprintf(s_cap_fail_why, sizeof s_cap_fail_why, "%s", "NOTHING CAME BACK");
      ui_run_clip(g_report.ok ? KEV_CAPTURE_SUCCESS : KEV_CAPTURE_FAIL, CAP[i].clip, CAP[i].text);
      film_t0 = g_preview_clock_us;
      FILM(CAP[i].name, 0); FILM(CAP[i].name, 40); FILM(CAP[i].name, 80); FILM(CAP[i].name, 120); FILM(CAP[i].name, 160);
      FILM(CAP[i].name, 200); FILM(CAP[i].name, 240); FILM(CAP[i].name, 280); FILM(CAP[i].name, 300); FILM(CAP[i].name, 330);
      FILM(CAP[i].name, 380); FILM(CAP[i].name, 450); 
      FILM(CAP[i].name, 550); FILM(CAP[i].name, 700); FILM(CAP[i].name, 900);
      FILM(CAP[i].name, 1100); FILM(CAP[i].name, 1300); FILM(CAP[i].name, 1500);
      g_stage = CAPTURE_IDLE;
      STEP(1600);
    }
  }

  /* -- world_delayed_data: the pipeline is slow, and the choreography waits --
   *
   * The same capture, with the four source frames arriving hundreds of
   * milliseconds late and out of order. Each pane holds at its gate until its
   * own frame lands; the authored motion is frozen there and the procedural
   * layer is not, so the wait reads as tension. Nothing loops and nothing
   * lies about progress. */
  SCENE();
  go(SCR_SHOOT, 0);
  s_sh_words_up = false;
  STEP(0);
  g_stage = CAPTURE_READING;
  g_frames_in = 0;
  FILM("world_delayed_data", 0); FILM("world_delayed_data", 40); FILM("world_delayed_data", 96);
  FILM("world_delayed_data", 200); FILM("world_delayed_data", 400);
  g_frames_in = 1;                       /* the first, 500 ms late */
  FILM("world_delayed_data", 500); FILM("world_delayed_data", 560);
  g_frames_in = 1 | 4;                   /* the third next, out of order */
  FILM("world_delayed_data", 760); FILM("world_delayed_data", 820);
  g_frames_in = 1 | 2 | 4;
  FILM("world_delayed_data", 1050);
  g_frames_in = 15;                      /* and the last, a second and a half in */
  FILM("world_delayed_data", 1500); FILM("world_delayed_data", 1560); FILM("world_delayed_data", 1650);
  s_capw.reported = true;
  memset(&g_report, 0, sizeof g_report);
  g_report.ok = true; g_report.stored = 4; g_report.online = 4;
  for (int c = 0; c < 4; c++) { g_report.cam[c].attempted = true; g_report.cam[c].ok = true; }
  g_stage = CAPTURE_DONE;
  STEP(1700);
  ui_run_clip(KEV_CAPTURE_SUCCESS, KCLIP_CAP_FOUR_MERGE, "GOT IT.");
  film_t0 = g_preview_clock_us;
  FILM("world_delayed_data", 1800); FILM("world_delayed_data", 1900); FILM("world_delayed_data", 2000);
  FILM("world_delayed_data", 2100); FILM("world_delayed_data", 2300);
  g_stage = CAPTURE_IDLE;

  /* -- stress: a second shutter while the first is still being celebrated -- */
  SCENE();
  go(SCR_SHOOT, 0);
  s_sh_words_up = false;
  STEP(0);
  g_stage = CAPTURE_READING; STEP(0); g_frames_in = 15; s_capw.reported = true; g_stage = CAPTURE_DONE; STEP(300);
  ui_run_clip(KEV_CAPTURE_SUCCESS, KCLIP_CAP_FOUR_MERGE, "GOT IT.");
  film_t0 = g_preview_clock_us;
  FILM("capcap", 0); FILM("capcap", 100); FILM("capcap", 200); FILM("capcap", 300);
  g_stage = CAPTURE_IDLE; STEP(340); g_stage = CAPTURE_READING; g_frames_in = 0; s_capw.reported = false;
  FILM("capcap", 350); FILM("capcap", 370); FILM("capcap", 400); FILM("capcap", 450); FILM("capcap", 500);
  g_frames_in = 15; s_capw.reported = true; g_stage = CAPTURE_DONE; STEP(600);
  ui_run_clip(KEV_CAPTURE_SUCCESS, KCLIP_CAP_TEXT_HIT, "AGAIN?");
  FILM("capcap", 620); FILM("capcap", 700); FILM("capcap", 800); FILM("capcap", 1000); FILM("capcap", 1300);
  g_stage = CAPTURE_IDLE;

  /* -- stress: leaving the finder while the result is still landing -- */
  SCENE();
  go(SCR_SHOOT, 0);
  STEP(0);
  g_stage = CAPTURE_READING; STEP(0); g_frames_in = 15; s_capw.reported = true; g_stage = CAPTURE_DONE; STEP(300);
  ui_run_clip(KEV_CAPTURE_SUCCESS, KCLIP_CAP_ENERGY, "YES.");
  film_t0 = g_preview_clock_us;
  FILM("capleave", 0); FILM("capleave", 120);
  mode_swipe_vel(1, 0.f);
  FILM("capleave", 130); FILM("capleave", 170); FILM("capleave", 240); FILM("capleave", 340); FILM("capleave", 500);
  g_stage = CAPTURE_IDLE;

  /* -- stress: a context event lands during a mode change -- */
  SCENE();
  go(SCR_SHOOT, 0);
  STEP(0);
  mode_swipe_vel(1, 0.f);
  FILM("ctx", 0); FILM("ctx", 80);
  ui_run_clip(KEV_LINK_CONNECTED, KCLIP_LINK_CONNECTED, "CONNECTED");
  FILM("ctx", 100); FILM("ctx", 140); FILM("ctx", 200); FILM("ctx", 280); FILM("ctx", 400); FILM("ctx", 600); FILM("ctx", 900); FILM("ctx", 1400); FILM("ctx", 1750);

  /* -- the rest of what the camera says -- */
  SCENE();
  go(SCR_SHOOT, 0);
  s_sh_words_up = false;
  STEP(0);
  ui_run_clip(KEV_SYNC_GOOD, KCLIP_SYNC_GOOD, "SYNC OK");
  FILM("sync", 0); FILM("sync", 60); FILM("sync", 130); FILM("sync", 200); FILM("sync", 240); FILM("sync", 260); FILM("sync", 300); FILM("sync", 400); FILM("sync", 700); FILM("sync", 1300);
  SCENE();
  go(SCR_CONNECTION, 0);
  STEP(0);
  ui_run_clip(KEV_TRANSFER_COMPLETE, KCLIP_TRANSFER_DONE, "SENT");
  FILM("sent", 0); FILM("sent", 80); FILM("sent", 160); FILM("sent", 240); FILM("sent", 260); FILM("sent", 300); FILM("sent", 400); FILM("sent", 700); FILM("sent", 1400);
  SCENE();
  go(SCR_SHOOT, 0);
  s_sh_words_up = false;
  STEP(0);
  ui_run_clip(KEV_WAKE_LONG_IDLE, KCLIP_WAKE_LONG, "BACK.");
  FILM("back", 0); FILM("back", 150); FILM("back", 400); FILM("back", 1500); FILM("back", 1700);
  SCENE();
  go(SCR_SETTINGS, 0);
  STEP(0);
  ui_note("CARD");
  FILM("note", 0); FILM("note", 40); FILM("note", 90); FILM("note", 160); FILM("note", 300); FILM("note", 1300); FILM("note", 1450);

  /* -- LOOK: the identifier, and every transition -- */
  {
    struct { const char *name; int clip; } LK[] = {
        {"look_snap", KCLIP_LOOK_SNAP}, {"look_rgb", KCLIP_LOOK_RGB}, {"look_smear", KCLIP_LOOK_SMEAR},
        {"look_wipe", KCLIP_LOOK_WIPE}, {"look_pulse", KCLIP_LOOK_PULSE}, {"look_cut", KCLIP_LOOK_CUT},
        {"look_late", KCLIP_LOOK_LATE_COLOR},
    };
    for (size_t i = 0; i < sizeof LK / sizeof LK[0]; i++) {
      SCENE();
      go(SCR_LOOK, 0);
      STEP(0);
      STEP(1500);
      film_t0 = g_preview_clock_us;
      look_step(1);
      ui_run_clip(KEV_LOOK_CHANGE, LK[i].clip, NULL);
      look_show_id();
      FILM(LK[i].name, 0); FILM(LK[i].name, 16); FILM(LK[i].name, 40); FILM(LK[i].name, 80); FILM(LK[i].name, 130);
      FILM(LK[i].name, 200); FILM(LK[i].name, 300); FILM(LK[i].name, 500); FILM(LK[i].name, 900); FILM(LK[i].name, 1300);
    }
  }

  /* -- boot: a cold boot, and the first ever -- */
  for (int first = 0; first < 2; first++) {
    SCENE();
    ks_node_t *b = ks_get("brand", KS_TEXT);
    ks_text(b, "KINO D4", &UT_MB, C_INK);
    ks_place(b, UI_W * 0.5f, UI_H * 0.5f, 0.5f, 0.5f);
    ks_pose(b, KC_SX, 2.f); ks_pose(b, KC_SY, 2.f);
    b->z = 95;
    ks_snap(b);
    if (first) { ks_text_stagger(b, KCLIP_BOOT_CHAR, 55, g_preview_clock_us); ks_play1(KCLIP_BOOT_FIRST, "boot", b, "title", NULL); }
    else ks_play1(KCLIP_BOOT_COLD, "boot", b, "title", NULL);
    const char *nm = first ? "boot_first" : "boot_cold";
    static const int T[] = {0, 60, 120, 160, 200, 260, 330, 420, 560, 760, 1000, 1300, 1800};
    for (size_t k = 0; k < sizeof T / sizeof T[0]; k++) {
      g_preview_clock_us = film_t0 + (int64_t)T[k] * 1000;
      s_kmo_live = 0;
      ks_begin(g_preview_clock_us);
      fill(0, 0, UI_W, UI_H, RGB(0x00, 0x00, 0x00));
      ks_get("brand", KS_TEXT);
      ks_render();
      char fn[80];
      snprintf(fn, sizeof fn, "film_%s_%04d", nm, T[k]);
      shot(fn);
    }
    ks_stop_tag("boot");
    /* ...and the finder under it, the name letting go. */
    s_screen = SCR_SHOOT;
    s_sh_show_ms = SH_SHOW_FIRST_MS;
    sh_reveal();
    film_t0 = g_preview_clock_us;
    FILM(nm, 1900); FILM(nm, 1950); FILM(nm, 2020); FILM(nm, 2150); FILM(nm, 2400);
  }

  /* -- the complex scene: everything at once, and what it costs -- */
  SCENE();
  go(SCR_SHOOT, 0);
  STEP(0);
  mode_swipe_vel(1, 0.f);
  mode_swipe_vel(-1, 0.f);
  row_open(g_preview_clock_us);
  g_stage = CAPTURE_READING; STEP(10); g_frames_in = 15; s_capw.reported = true; g_stage = CAPTURE_DONE; STEP(20);
  ui_run_clip(KEV_CAPTURE_SUCCESS, KCLIP_CAP_FOUR_MERGE, "GOT IT.");
  ui_run_clip(KEV_LINK_CONNECTED, KCLIP_LINK_CONNECTED, "CONNECTED");
  film_t0 = g_preview_clock_us;
  {
    uint32_t worst = 0, sum = 0, n = 0;
    for (int ms = 0; ms <= 900; ms += 16) {
      STEP(ms);
      const uint32_t cost = s_ks_perf.render_us + s_ks_perf.step_us;
      sum += cost; n++;
      if (cost > worst) worst = cost;
      if (ms % 160 == 0) { char fn[80]; snprintf(fn, sizeof fn, "film_complex_%04d", ms); shot(fn); }
    }
    fprintf(stderr, "[perf] complex scene: %u frames, mean %u us, worst %u us, nodes %u, clips %u, pixels %u\n",
            (unsigned)n, (unsigned)(sum / (n ? n : 1)), (unsigned)worst, (unsigned)s_ks_perf.nodes_drawn,
            (unsigned)s_ks_perf.clips_active, (unsigned)s_ks_perf.pixels_tf);
  }
  g_stage = CAPTURE_IDLE;
  row_close();

  /* ---- stress: more photographs than the scene has slots ----
   *
   * Every photograph is its own object, named after its capture, so a card
   * with four hundred pictures on it wants four hundred node ids over the
   * course of a session. The pool is 160. It has to reclaim what nobody is
   * asking for any more, and it must never hand out a slot something else is
   * still pointing at - the visible failure of that would be one photograph
   * quietly wearing another's place. */
  {
    SCENE();
    go(SCR_SHOOT, 0);
    s_sh_words_up = false;
    int ms = 0;
    for (int i = 0; i < 400; i++) {
      char id[16], uuid[40];
      snprintf(id, sizeof id, "CAP_%06d", 1000 + i);
      snprintf(uuid, sizeof uuid, "stress-%d", i);
      latest_build(id, uuid, 4, 1);
      /* Past the hold, so each one is finished with before the next arrives. */
      for (int k = 0; k < 3; k++) { ms += 120; STEP(ms); }
      s_latest_id[0] = 0;
    }
    /* The last one asked for has to be a node of its own. Without reclamation
     * a full pool hands back slot 0, which is some fixed part of the
     * interface: the photograph would be drawn as the finder, and looking it
     * up by its own name would find nothing. */
    char last[16];
    snprintf(last, sizeof last, "CAP_%06d", 1399);
    latest_build(last, "stress-last", 4, 1);
    STEP(ms += 120);
    char want[KS_ID_MAX];
    photo_node_id(want, sizeof want, last, "stress-last");
    const ks_node_t *got = ks_peek(want);
    fprintf(stderr, "[scene] 400 photographs through a %d slot pool: %d in use, slot 0 is \"%s\", "
                    "the last photograph %s\n",
            KS_MAX_NODES, s_ks_count, s_ks[0].id,
            got != NULL ? "has its own node" : "-- LOST, the pool handed back a fixed node");
    s_latest_id[0] = 0;
  }

  /* ---- what each state costs to draw ----
   *
   * Not a prediction of the P4: this is a desktop, and the numbers here are
   * only good for comparing one state of the interface with another and for
   * catching a change that made the work several times bigger. The clock is
   * the wall (KS_PERF_NOW), because the rest of the runtime runs on a clock
   * the harness winds by hand.
   *
   * The frame is drawn repeatedly with the clock held still, so every pass
   * has the same thing on it and the figure is the cost of that picture
   * rather than of a moment in a transition.
   */
  {
    struct { const char *what; screen_t scr; bool words; bool capturing; } COST[] = {
        {"shoot, at rest", SCR_SHOOT, false, false},
        {"shoot, words up", SCR_SHOOT, true, false},
        {"shoot, mid capture", SCR_SHOOT, false, true},
        {"look", SCR_LOOK, false, false},
        {"roll", SCR_GALLERY, false, false},
        {"photo", SCR_PHOTO, false, false},
        {"link", SCR_CONNECTION, false, false},
        {"setup", SCR_SETTINGS, false, false},
        {"info", SCR_ABOUT, false, false},
    };
    for (size_t i = 0; i < sizeof COST / sizeof COST[0]; i++) {
      SCENE();
      g_roll_active = COST[i].what[0] == 'l' && COST[i].scr == SCR_CONNECTION;
      go(COST[i].scr, 0);
      s_sh_words_up = COST[i].words;
      if (COST[i].words) sh_reveal();
      if (COST[i].capturing) {
        g_stage = CAPTURE_READING;
        g_frames_in = 15;
        STEP(0);
        STEP(160); /* into the arrival, where the strips and the tilt are on */
      } else {
        /* In steps a frame apart, not one jump: ks_begin clamps a pass to 50
         * ms, so a single 400 ms step settles the springs by 50 ms and the
         * bench would be measuring a screen still in motion. */
        for (int t = 0; t <= 600; t += 30) STEP(t);
      }
      uint32_t worst = 0, sum = 0;
      const int n = 40;
      for (int k = 0; k < n; k++) {
        draw_screen();
        const uint32_t c = s_ks_perf.render_us + s_ks_perf.step_us;
        sum += c;
        if (c > worst) worst = c;
      }
      fprintf(stderr, "[cost] %-20s mean %5u us  worst %5u us  nodes %2u  px %6u (%u on the slow path)\n",
              COST[i].what, (unsigned)(sum / n), (unsigned)worst,
              (unsigned)s_ks_perf.nodes_drawn, (unsigned)s_ks_perf.pixels_tf, (unsigned)s_kd_slow);
      g_stage = CAPTURE_IDLE;
      g_frames_in = 0;
      g_roll_active = false;
    }
  }

  /* ---- the same interface with every word taken out of it ----
   *
   * WORLD.md's last acceptance test, and the one the STARBOY research adds:
   * with the words removed the product should still feel alive. A state that
   * is nothing but a list of labels fails it, and a state whose shape, motion
   * and photographs carry the meaning passes.
   *
   * These are not pictures of a bug. They are the question asked plainly, and
   * the answer is meant to be looked at rather than asserted.
   */
  {
    g_mute_words = 1;
    struct { const char *name; screen_t scr; bool roll; } MUTE[] = {
        {"shoot", SCR_SHOOT, false},   {"look", SCR_LOOK, false},
        {"roll", SCR_GALLERY, false},  {"photo", SCR_PHOTO, false},
        {"link", SCR_CONNECTION, true}, {"setup", SCR_SETTINGS, false},
        {"info", SCR_ABOUT, false},
    };
    for (size_t i = 0; i < sizeof MUTE / sizeof MUTE[0]; i++) {
      SCENE();
      g_roll_active = MUTE[i].roll;
      if (g_roll_active) {
        snprintf(g_roll.guest_url, sizeof g_roll.guest_url, "https://kino.acronym.sk/r/K7M2QP");
        snprintf(g_roll.slug, sizeof g_roll.slug, "K7M2QP");
        snprintf(g_roll.name, sizeof g_roll.name, "FRIDAY PARTY");
      }
      /* A photograph screen with no photograph open is a picture of nothing,
       * which would answer a different question than the one being asked. */
      if (MUTE[i].scr == SCR_PHOTO) {
        const gallery_item_t *slots = gallery_slots();
        for (int k = 0; k < GALLERY_PAGE; k++)
          if (slots[k].state == TILE_READY && slots[k].pixels) { photo_open(&slots[k]); break; }
      }
      go(MUTE[i].scr, 0);
      for (int t = 0; t <= 600; t += 30) STEP(t);
      char fn[64];
      snprintf(fn, sizeof fn, "mute_%s", MUTE[i].name);
      shot(fn);
      g_roll_active = false;
    }
    /* And the moment that has to work hardest without words: a capture. */
    SCENE();
    go(SCR_SHOOT, 0);
    STEP(0);
    g_stage = CAPTURE_READING;
    g_frames_in = 15;
    STEP(120);
    STEP(200);
    shot("mute_capture");
    g_stage = CAPTURE_IDLE;
    g_mute_words = 0;
  }

  /* ---- KINO D4: the interface, screen by screen ----
   *
   * The redesign (firmware/D4_UI.md). Drawn by the same functions the camera
   * will call, from the same device state, at the panel's own size - these
   * are the interface rather than pictures of it. */
  {
    memset(&d4, 0, sizeof d4);
    g_preview_clock_us += 2000000;

    /* A specimen of the drawn face, before anything is set in it. */
    d_ground(D_PAPER);
    dw_draw(40, 40, 3, d_fg);
    df_draw(40, 150, "0123456789", 3, d_fg);
    df_draw(40, 210, "0123456789", 2, d_fg);
    df_draw(40, 250, "0123456789", 1, d_fg);
    df_draw(360, 210, "4/4", 2, d_fg);
    df_draw(460, 210, "68%", 2, d_fg);
    df_draw(560, 210, "31^C", 2, d_fg);
    df_draw(360, 250, "18:42", 1, d_fg);
    df_draw(460, 250, "09.15", 1, d_fg);
    df_draw(560, 250, "-1+2", 1, d_fg);
    df_draw(40, 300, "1234", 6, d_fg);
    shot("d4_00_specimen");

    /* 1 boot: the four coming up, then READY. */
    d4.boot_us = g_preview_clock_us;
    g_vf_dead = 0xF;
    d4.screen = D4_BOOT;
    d4_draw(); shot("d4_01_boot_cold");
    g_preview_clock_us += 300000;
    g_vf_dead = 0x6;
    d4_draw(); shot("d4_02_boot_half");
    g_preview_clock_us += 400000;
    g_vf_dead = 0x0;
    d4_draw(); shot("d4_03_boot_ready");

    /* 2 live view - three ways, each as a run of frames so the motion that
     * separates them is visible in a still contact sheet. */
    d4.screen = D4_LIVE;
    static const char *const HOME[3] = {"wiggle", "parallax", "stack"};
    for (int hs = 0; hs < 3; hs++) {
      d4_home_style = (d4_home_t)hs;
      for (int f = 0; f < 4; f++) {
        g_preview_clock_us += 110000;
        char n[40];
        snprintf(n, sizeof n, "d4_home_%s_%d", HOME[hs], f + 1);
        d4_draw();
        shot(n);
      }
    }
    d4_home_style = D4_HOME_WIGGLE;
    d4_draw(); shot("d4_04_live");

    /* 3-6 the capture, phase by phase. */
    d4.cap = D4_CAP_SHUTTER;
    d4_draw(); shot("d4_05_shutter");
    d4.cap = D4_CAP_CATCH;
    g_stage = CAPTURE_READING;
    g_frames_in = 1;
    d4_draw(); shot("d4_06_catch_1");
    g_frames_in = 1 | 4;
    d4_draw(); shot("d4_07_catch_3");
    g_frames_in = 15;
    d4_draw(); shot("d4_08_catch_4");
    memset(&g_report, 0, sizeof g_report);
    g_report.ok = true; g_report.stored = 2; g_report.online = 4;
    d4.cap = D4_CAP_MAKE;
    d4_draw(); shot("d4_09_making");
    d4.cap = D4_CAP_PLAY;
    for (int f = 0; f < 4; f++) { d4.wiggle = f; d4_draw(); char n[32]; snprintf(n, sizeof n, "d4_10_play_%d", f + 1); shot(n); }
    d4.cap = D4_CAP_NONE;
    g_stage = CAPTURE_IDLE;

    /* the one dry word, and the menu. */
    d4.word = "GOOD.";
    d4.word_us = g_preview_clock_us;
    d4_draw(); shot("d4_11_word");
    d4.word = NULL;
    d4.screen = D4_MENU;
    d4.sel = 1;
    d4_draw(); shot("d4_12_menu");
    /* 7-8 the roll, and one out of it. The four frames of the selected file
     * are decoded when the cursor lands on it, which is what makes that one
     * play and the rest sit still. */
    d4.screen = D4_ROLL;
    d4.sel = 2; /* slot 5 is the pending one the stub keeps for that state */
    {
      uint32_t gen = 0;
      gallery_frames_begin("preview-2", GALLERY_TILE_W, GALLERY_TILE_H, 0, NULL, &gen);
    }
    for (int f = 0; f < 2; f++) {
      g_preview_clock_us += 220000;
      char n[32];
      snprintf(n, sizeof n, "d4_13_roll%s", f ? "_b" : "");
      d4_draw();
      shot(n);
    }
    d4.screen = D4_ITEM;
    d4.sel = 2;
    for (int f = 0; f < 2; f++) {
      g_preview_clock_us += 220000;
      char n[32];
      snprintf(n, sizeof n, "d4_14_item%s", f ? "_b" : "");
      d4_draw();
      shot(n);
    }

    /* 9 looks. */
    d4.screen = D4_LOOK;
    d4.sel = 4;
    d4_draw(); shot("d4_15_look");

    /* 10-11 link, then a transfer running. */
    g_roll_active = true;
    snprintf(g_roll.guest_url, sizeof g_roll.guest_url, "https://kino.acronym.sk/r/K7M2QP");
    snprintf(g_roll.slug, sizeof g_roll.slug, "K7M2QP");
    snprintf(g_roll.name, sizeof g_roll.name, "FRIDAY PARTY");
    g_net_state = NET_IP_READY;
    g_net_routed = true;
    memset(&g_queue, 0, sizeof g_queue);
    g_queue.scan_complete = true;
    g_queue.server_state = UPLOAD_SERVER_REACHABLE;
    g_queue.uploaded = 12;
    d4.screen = D4_LINK;
    d4_draw(); shot("d4_16_link");
    g_queue.draining = true;
    g_queue.uploading = 1;
    g_queue.pending = 9;
    g_queue.burst_done = 12;
    d4.screen = D4_TRANSFER;
    d4_draw(); shot("d4_17_transfer");
    g_roll_active = false;

    /* 12 setup, both pages. */
    d4.screen = D4_SETUP;
    d4.page = 0;
    d4.sel = 3;
    d4_draw(); shot("d4_18_setup");
    d4.page = 1;
    d4.sel = 0;
    d4_draw(); shot("d4_19_setup_b");

    /* 13-14 the cameras, and bringing them into line. */
    d4.page = 0;
    d4.screen = D4_CAMERAS;
    d4_draw(); shot("d4_20_cameras");
    g_vf_dead = 0x2;
    d4_draw(); shot("d4_21_cameras_warming");
    g_vf_dead = 0x0;
    d4.screen = D4_CAL;
    d4.sel = 2;
    d4_draw(); shot("d4_22_calibrate");

    /* 15-17 the states that interrupt. */
    d4.screen = D4_LIVE;
    d4.flash_pct = 62;
    d4_draw(); shot("d4_23_flash_charging");
    d4.flash_pct = 0;
    g_card_free = 380ull * 1024 * 1024;
    d4.screen = D4_CARD;
    d4_draw(); shot("d4_24_card_low");
    g_card_free = 30648041472ULL;
    g_vf_dead = 0x4;
    d4.screen = D4_FAULT;
    d4_draw(); shot("d4_25_camera_failure");
    g_vf_dead = 0x0;

    /* 18 the destructive one. */
    d4.screen = D4_CONFIRM;
    d4.confirm_n = 27;
    d4.confirm_noun = "FILES";
    d4.confirm_yes = "DELETE";
    d4.sel = 0;
    d4_draw(); shot("d4_26_confirm");
    d4.sel = 1;
    d4_draw(); shot("d4_27_confirm_yes");
    d4.confirm_n = 0;
    d4.confirm_noun = NULL;
    d4.screen = D4_LIVE;
  }

  /* ---- the playground: every capability, filmed ---- */
  static const int PGT[] = {0, 16, 40, 80, 130, 200, 300, 420, 560, 720, 900, 1100, 1400};
  /* The world scenes loop on four seconds and are sampled across the whole
   * period, either side of each state change, rather than over the first
   * second and a half of a single shape test. */
  static const int PGW[] = {0, 60, 160, 340, 700, 1400, 1960, 2040, 2140, 2320, 2700, 3400, 3960};
  for (int which = 0; which < PG_COUNT; which++) {
    const bool world = which >= PG_WORLD0;
    const int *T = world ? PGW : PGT;
    const size_t nT = world ? sizeof PGW / sizeof PGW[0] : sizeof PGT / sizeof PGT[0];
    g_preview_clock_us += 2000000;
    /* The sharing state is only itself with a roll on it. */
    g_roll_active = which == PG_W_LINK;
    if (g_roll_active) {
      snprintf(g_roll.guest_url, sizeof g_roll.guest_url, "https://kino.acronym.sk/r/K7M2QP");
      snprintf(g_roll.slug, sizeof g_roll.slug, "K7M2QP");
      snprintf(g_roll.name, sizeof g_roll.name, "FRIDAY PARTY");
    }
    const int64_t t0 = g_preview_clock_us;
    pg_frame(which, t0);
    if (!world) pg_start(which, t0);
    for (size_t k = 0; k < nT; k++) {
      g_preview_clock_us = t0 + (int64_t)T[k] * 1000;
      if (which == PG_INTERRUPT && T[k] == 300) pg_interrupt();
      pg_frame(which, g_preview_clock_us);
      char fn[80];
      snprintf(fn, sizeof fn, "pg_%s_%04d", PG_NAME[which], T[k]);
      shot(fn);
    }
    ks_stop_tag("pg");
    ks_stop_tag("cap");
    g_roll_active = false;
    ks_node_t *a = ks_peek("pg.a");
    if (a) { ks_mod_clear(a); a->char_clip = -1; }
  }

  /* ---- what the behaviour controller does with context ----
   *
   * The brief's requirement is that context chooses the family and weight
   * only chooses inside it. This is the proof: the same event, drawn a
   * thousand times under each of several worlds, printed as a distribution.
   * A burst must be almost all silence; a clean sync must reach the
   * convergence; a dark room must never reach the loud one. */
  {
    struct { const char *name; kb_ctx_t c; } W[] = {
        {"at rest, ordinary room", {.shots_session = 4, .flash_on = 0, .sync_ok = 1, .quad = 0, .idle_s = 3,
                                    .hour = 14, .first_boot = 0, .energy = 20, .calm = 70, .confidence = 50,
                                    .strain = 0, .burst = 1, .lum = 55, .motion = 8, .framing_ms = 400,
                                    .sync_spread_ms = 40}},
        {"mid burst",              {.shots_session = 12, .flash_on = 0, .sync_ok = 1, .quad = 0, .idle_s = 0,
                                    .hour = 22, .first_boot = 0, .energy = 90, .calm = 5, .confidence = 60,
                                    .strain = 0, .burst = 5, .lum = 50, .motion = 60, .framing_ms = 0,
                                    .sync_spread_ms = 50}},
        {"clean four-way sync",    {.shots_session = 6, .flash_on = 0, .sync_ok = 1, .quad = 1, .idle_s = 5,
                                    .hour = 14, .first_boot = 0, .energy = 30, .calm = 60, .confidence = 70,
                                    .strain = 0, .burst = 1, .lum = 60, .motion = 10, .framing_ms = 900,
                                    .sync_spread_ms = 8}},
        {"flash fired",            {.shots_session = 8, .flash_on = 1, .sync_ok = 1, .quad = 0, .idle_s = 4,
                                    .hour = 23, .first_boot = 0, .energy = 45, .calm = 40, .confidence = 55,
                                    .strain = 0, .burst = 1, .lum = 35, .motion = 20, .framing_ms = 600,
                                    .sync_spread_ms = 45}},
        {"held a long time",       {.shots_session = 3, .flash_on = 0, .sync_ok = 1, .quad = 0, .idle_s = 9,
                                    .hour = 11, .first_boot = 0, .energy = 10, .calm = 95, .confidence = 55,
                                    .strain = 0, .burst = 1, .lum = 65, .motion = 2, .framing_ms = 4200,
                                    .sync_spread_ms = 44}},
        {"dark room",              {.shots_session = 5, .flash_on = 0, .sync_ok = 1, .quad = 0, .idle_s = 6,
                                    .hour = 1, .first_boot = 0, .energy = 25, .calm = 60, .confidence = 50,
                                    .strain = 0, .burst = 1, .lum = 12, .motion = 9, .framing_ms = 700,
                                    .sync_spread_ms = 46}},
    };
    fprintf(stderr, "\n[behaviour] capture_success, 1000 draws per world\n");
    for (size_t w = 0; w < sizeof W / sizeof W[0]; w++) {
      int count[KMO_CLIP_COUNT];
      memset(count, 0, sizeof count);
      int none = 0;
      /* A fresh history per world, so one world's rules do not shape the next. */
      memset(s_kb_hist, 0, sizeof s_kb_hist);
      s_kb_hist_n = 0;
      memset(s_kb_fired_boot, 0, sizeof s_kb_fired_boot);
      memset(s_kb_fired_session, 0, sizeof s_kb_fired_session);
      memset(s_kb_last_us, 0, sizeof s_kb_last_us);
      kb_seed(1234u + (uint32_t)w);
      for (int i = 0; i < 1000; i++) {
        /* Far enough apart that a minimum interval is never the reason. */
        const kb_pick_t p = kb_event(KEV_CAPTURE_SUCCESS, &W[w].c, (int64_t)i * 60000000LL);
        if (p.variant < 0) none++;
        else count[p.clip]++;
      }
      fprintf(stderr, "  %-24s", W[w].name);
      for (int c = 0; c < KMO_CLIP_COUNT; c++)
        if (count[c]) fprintf(stderr, " %s=%d", KMO_CLIPS[c].name, count[c]);
      if (none) fprintf(stderr, " (nothing=%d)", none);
      fprintf(stderr, "\n");
    }
    fprintf(stderr, "\n");
  }

  if (g_write_failed) {
    fprintf(stderr, "preview: one or more screens could not be written\n");
    return 1;
  }
  return 0;
}
