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
#include "config_store.h"
#include "power.h"
#include "viewfinder.h"
#include "storage.h"
#include "touch.h"
#include "ui.h"

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
bool audio_ready(void) { return false; }
void audio_shutter(void) {}
void audio_tick(void) {}

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
int config_int(const char *path, int fallback) {
  if (strcmp(path, "body.autoDimS") == 0) return 30;
  if (strcmp(path, "body.sleepS") == 0) return 120;
  if (strcmp(path, "body.camIdleTimeoutS") == 0) return 300;
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

const char *config_str(const char *path, const char *fallback) {
  if (strcmp(path, "mode") == 0) return g_mode;
  if (strcmp(path, "shoot.flashMode") == 0) return g_flash_mode;
  if (strncmp(path, "quad.slots.", 11) == 0 && strstr(path, "colorMode"))
    return g_mono ? "mono" : "recipe";
  if (strcmp(path, "device") == 0) return "KD4-D121BC";
  return fallback;
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

/* No nodes on a workstation: the preview shows the honest "no link" state,
 * which is exactly what the bench shows until the harness is jumpered. */
esp_err_t viewfinder_init(void) { return ESP_OK; }
bool viewfinder_ready(void) { return true; }
void viewfinder_run(bool on) { (void)on; }
const uint16_t *viewfinder_tile(int cam) { (void)cam; return NULL; }
void viewfinder_status(int cam, vf_status_t *out) {
  (void)cam;
  if (out) { out->state = VF_NO_LINK; out->frames = 0; out->last_ms = 0; out->bytes = 0; out->fps_x10 = 0; }
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

void storage_get_status(storage_status_t *out) {
  memset(out, 0, sizeof *out);
  out->present = true;
  out->mounted = true;
  out->filesystem = "FAT";
  out->capacity_bytes = 31914983424ULL;
  out->free_bytes = 30648041472ULL;
  out->write_test = "pass";
}

#include "ui.c"

/* ---- output ---- */

static void write_ppm(const char *path, const uint16_t *px, int w, int h) {
  FILE *f = fopen(path, "wb");
  if (!f) {
    fprintf(stderr, "cannot write %s\n", path);
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
    fwrite(rgb, 1, 3, f);
  }
  fclose(f);
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

  s_focus[SCR_MENU] = 4;
  SHOT(SCR_MENU, "menu_settings_focus");

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

  /* ---- shoot: previews, mode, flash and the shutter on one screen ---- */
  s_focus[SCR_SHOOT] = 3; /* the shutter, where focus lands on entry */
  SHOT(SCR_SHOOT, "shoot");
  g_flash_mode = "on";
  SHOT(SCR_SHOOT, "shoot_flash_on");
  g_flash_mode = "off";
  g_mode = "quad";
  SHOT(SCR_SHOOT, "shoot_quad_flash_off");
  g_flash_mode = "auto";
  g_mode = "wiggle";

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

  s_focus[SCR_GALLERY] = 0;
  SHOT(SCR_GALLERY, "gallery");
  g_fake_total = 0;
  SHOT(SCR_GALLERY, "gallery_empty");
  g_fake_total = 14;

  SHOT(SCR_ROLL, "roll");

  /* ---- settings and its children ---- */
  SHOT(SCR_SETTINGS, "settings");
  SHOT(SCR_DISPLAY, "settings_display");
  SHOT(SCR_SOUND, "settings_sound");
  SHOT(SCR_CONNECTION, "settings_connection");
  SHOT(SCR_STORAGE, "settings_storage");
  SHOT(SCR_ABOUT, "settings_about");

  /* ---- power, and both confirmations ---- */
  SHOT(SCR_POWER, "power");
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
    s_dialog = DLG_DELETE;
    s_dlg_focus = 0;
    draw_screen();
    shot("photo_delete_confirm");
    s_dialog = DLG_NONE;
    photo_release();
  }

  /* ---- a toast, which every screen can raise ---- */
  s_screen = SCR_MENU;
  toast("Mode: Quad");
  draw_screen();
  shot("toast");

  return 0;
}
