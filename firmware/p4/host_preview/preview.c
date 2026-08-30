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
static const char *g_look = "party-neg";
static const char *g_shutter_sound = "click";

const char *config_str(const char *path, const char *fallback) {
  if (strcmp(path, "mode") == 0) return g_mode;
  if (strcmp(path, "shoot.flashMode") == 0) return g_flash_mode;
  if (strcmp(path, "shoot.shutterSound") == 0) return g_shutter_sound;
  if (strcmp(path, "wiggle.recipeId") == 0) return g_look;
  if (strncmp(path, "quad.slots.", 11) == 0 && strstr(path, "colorMode"))
    return g_mono ? "mono" : "recipe";
  /* All four slots answer the same look, so the LOOK screen's ALL target
   * renders its normal state rather than MIXED. The mixed case gets its own
   * shot below, driven by g_look. */
  if (strncmp(path, "quad.slots.", 11) == 0 && strstr(path, "recipeId")) return g_look;
  if (strcmp(path, "device") == 0) return "KD4-D121BC";
  return fallback;
}

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

esp_err_t viewfinder_init(void) { return ESP_OK; }
bool viewfinder_ready(void) { return true; }
void viewfinder_run(bool on) { (void)on; }
const uint16_t *viewfinder_tile(int cam) {
  if (cam < 0 || cam >= 4) return NULL;
  if (!g_vf_filled) fake_viewfinder();
  return g_vf[cam];
}
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

  /* The look picker on a custom-named look, and the QUAD variant with its
   * TARGET row - the only two states the screen has that the default one does
   * not show. QUAD is the taller of the two and the one whose footnotes come
   * closest to the bottom edge. */
  g_look = "flash-digi";
  SHOT(SCR_LOOK, "look_picked");
  g_mode = "quad";
  s_look_target = 2; /* CAM2, so the row is not drawn on its first segment */
  SHOT(SCR_LOOK, "look_quad_target");
  s_look_target = 0;
  g_mode = "wiggle";
  g_look = "party-neg";

  s_focus[SCR_GALLERY] = 0;
  SHOT(SCR_GALLERY, "gallery");
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
  SHOT(SCR_DISPLAY, "settings_display");
  SHOT(SCR_SOUND, "settings_sound");
  /* A custom clip in the picker: the longest name the row has to fit, and the
   * only proof the card's clips reach the built-ins' list at all. */
  g_shutter_sound = "snd-polaroid";
  SHOT(SCR_SOUND, "settings_sound_custom_clip");
  g_shutter_sound = "click";

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

  if (g_write_failed) {
    fprintf(stderr, "one or more screens were not written\n");
    return 1;
  }
  return 0;
}
