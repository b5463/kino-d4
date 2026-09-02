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
#include "capture.h"
#include "gallery.h"
#include "gfx.h"
#include "icons.h"
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

esp_err_t gallery_frames_begin(const char *id, int w, int h, uint16_t pad, uint32_t *gen) {
  (void)id;
  (void)pad;
  for (int i = 0; i < GALLERY_FRAME_MAX; i++) {
    free(g_frame[i]);
    g_frame[i] = calloc((size_t)w * (size_t)h, sizeof(uint16_t));
    if (g_frame[i] == NULL) return ESP_ERR_NO_MEM;
    /* The background is the same in all four - it is the distance - and only
     * the near object moves, which is what parallax is and what makes one
     * frame of the swing tell you which frame it is. */
    const int bar = w / 4 + i * 34;
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        const int r = (x * 31) / w;
        const int g = (y * 63) / h;
        const int b = 31 - ((x + y) * 31) / (w + h);
        uint16_t px = (uint16_t)((r << 11) | (g << 5) | b);
        if (x >= bar && x < bar + 44 && y > h / 5 && y < h - h / 5) px = 0xffff;
        g_frame[i][y * w + x] = px;
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
esp_err_t upload_queue_enqueue(const char *uuid, int frames, bool thumb) {
  (void)uuid; (void)frames; (void)thumb; return ESP_OK;
}
void upload_queue_status(upload_queue_report_t *out) {
  if (out != NULL) *out = g_queue;
}
int upload_queue_retry_all(void) { return 0; }

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

int main(int argc, char **argv) {
  snprintf(g_out, sizeof g_out, "%s", argc > 1 ? argv[1] : ".");

  g_canvas = calloc((size_t)UI_W * UI_H, sizeof(uint16_t));
  s_cv = g_canvas;

  if (icons_build() != ESP_OK) {
    fprintf(stderr, "icons_build failed\n");
    return 1;
  }

  /* One helper, so every state below is "set the state, draw, name it" and
   * the list reads as the screen inventory it is meant to be. */
#define SHOT(scr, name)      \
  do {                       \
    s_screen = (scr);        \
    draw_screen();           \
    shot(name);              \
  } while (0)

  fake_gallery();

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

  s_pressed = 4;
  SHOT(SCR_MENU, "menu_pressed");
  s_pressed = -1;
  s_focus[SCR_MENU] = 0;

  /* Every icon on one sheet, at the size it is actually drawn, so the set can
   * be judged against itself rather than one at a time. */
  fill(0, 0, UI_W, UI_H, C_CANVAS);
  for (int i = 0; i < W98_COUNT; i++) {
    icons_blit_centred(s_cv, UI_W, UI_H, i, 84 + i * 106, UI_H / 2);
  }
  shot("iconsheet");

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

  /* ---- Roll: all four states, because they are what the screen is for ----
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

  /* Online and idle: everything that was taken has landed. */
  g_net_state = NET_IP_READY;
  g_net_routed = true;
  memset(&g_queue, 0, sizeof g_queue);
  g_queue.uploaded = 12;
  SHOT(SCR_ROLL, "roll_active");

  /* Online and working: one in flight, three behind it. */
  g_queue.uploading = 1;
  g_queue.pending = 3;
  g_queue.draining = true;
  SHOT(SCR_ROLL, "roll_uploading");

  /* The state this body is actually in: a real Roll, a real backlog, and no
   * radio link to drain it through. */
  g_net_state = NET_C6_NOT_ROUTED;
  g_net_routed = false;
  memset(&g_queue, 0, sizeof g_queue);
  g_queue.pending = 8;
  SHOT(SCR_ROLL, "roll_offline");

  /* Stopped on a credential fault, which is not the same as failed. */
  memset(&g_queue, 0, sizeof g_queue);
  g_queue.halted = true;
  g_queue.pending = 8;
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
  }

  /* ---- a toast, which every screen can raise ---- */
  /* On the menu it is the status bar's message. It used to float 44 px off the
   * bottom, which put it across the SETTINGS tile's label - a tooltip covering
   * the control that raised it, and this shot is the one that showed it. */
  s_screen = SCR_MENU;
  toast("Mode: Quad");
  draw_screen();
  shot("toast");

  /* The same band on the gallery, where the footer's two buttons sit. Every
   * message this screen raises is "Card busy", and the point of the shot is
   * that it lands between PREV and NEXT rather than on either. */
  s_screen = SCR_GALLERY;
  toast("Card busy");
  draw_screen();
  shot("toast_gallery");

  if (g_write_failed) {
    fprintf(stderr, "one or more screens were not written\n");
    return 1;
  }
  return 0;
}
