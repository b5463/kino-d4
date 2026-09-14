#include "ui.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "audio.h"
#include "buttons.h"
#include "cam_link.h"
#include "capture.h"
#include "clock.h"
#include "cJSON.h"
#include "gallery.h"
#include "config_store.h"
#include "display.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "gfx.h"
/* For KDP_PROTOCOL_VERSION, which the About screen reports: the same constant
 * GET_DEVICE_INFO answers as `protocol`, not a second copy of the number. */
#include "kdp/protocol.h"
#include "kdp_recipes.h"

/* A look is shown by its name, or by its id when the name is not on this
 * camera, so any buffer that holds "what we call this look" has to fit the
 * longer of the two. */
#define LOOK_TEXT_MAX (KDP_RECIPE_ID_MAX > KDP_RECIPE_NAME_MAX ? KDP_RECIPE_ID_MAX : KDP_RECIPE_NAME_MAX)
/* For media_favorite_set/get, and for kdp_device_serial() and
 * KDP_HARDWARE_REV, which is what the About screen's Serial and Hardware rows
 * are: the strings GET_DEVICE_INFO already answers. */
#include "kdp_server.h"
#include "kdp_sounds.h"
#include "klog.h"
#include "taskmon.h"
#include "meta.h"
#include "net_link.h"
#include "power.h"
#include "pure.h"
#include "qr.h"
#include "roll_state.h"
#include "storage.h"
#include "upload_queue.h"
#include "wifi_creds.h"
#include "thumb.h"
#include "touch.h"
#include "viewfinder.h"
#include "ui_motion.h"

static const char *TAG = "ui";

#define CAPTURES_DIR "/sdcard/KINO/CAPTURES"

/* Written as real RGB and packed, rather than as opaque hex literals: a
 * palette nobody can read is a palette nobody will adjust. */
#define RGB(r, g, b) ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))

/*
 * The whole palette. Ink on a near-black ground, one dim grey, and three
 * colours that are events rather than paint: yellow for a capture landing,
 * cobalt for something moving or a link coming up, red for a real failure.
 * After the event the screen is ink on ground again. No surface colour, no
 * chrome, nothing shaped - a surface here is type, a picture, or a disc.
 */
#define C_YELLOW RGB(0xf4, 0xc5, 0x42)
#define C_RED RGB(0xc8, 0x3a, 0x3a)
#define C_GROUND RGB(0x0e, 0x10, 0x14) /* the ground under everything that is not a picture */
/* The native UI's inks: off-white type and the one strong colour an event is allowed. */
#define C_INK RGB(0xf2, 0xf2, 0xee)
#define C_COBALT RGB(0x2f, 0x70, 0xc9)

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */



/* Detail screens. */
#define HEAD_H 62
#define BACK_W 84
#define ROW_H 52
#define BODY_Y (HEAD_H + 1)
/* The list well: inset from the window frame, the way a listbox sits inside
 * a dialog rather than bleeding to the edges. */
#define LIST_X 16
#define LIST_W (UI_W - 2 * LIST_X)
#define LIST_Y (BODY_Y + 12)

/* Viewfinder.
 *
 * Four 4:3 previews in a 2x2 on a 5:3 panel leaves a column of dead space
 * down each side no matter what - the block is 4:3 and the screen is not. So
 * the panes take the full height and the three controls live in the columns
 * that were going to be empty anyway. Putting them in strips above and below
 * instead costs 27 px of pane height each, which is 49% of the picture area,
 * to fill margins that stay dark either way. */
/* SHOOT: the four streams, edge to edge.
 *
 * Four panes of exactly a quarter of the screen. No gap, no keyline, no margin
 * between them - a viewfinder is for looking through, and every line drawn
 * across it is a line between you and the room. What is drawn on it (the
 * mode's name, the reading line, the four marks) is type and dots anchored to
 * the edges, and all but the marks let go once read.
 *
 * 400x240 is 5:3 and the sensors are 4:3, so each stream is scaled to fill
 * the width and cropped 24 rows top and bottom - a tenth off each edge. The
 * alternatives were both worse: letterboxing puts a black border round every
 * frame, and stretching to fit makes every face 25% wide. Cropping loses the
 * least and is what a camera does when it changes aspect anyway. */
#define SH_PANE_W (UI_W / 2)                                       /* 400 */
#define SH_PANE_H (UI_H / 2)                                       /* 240 */
/* Rows dropped from each end of the source to make 4:3 into 5:3. */
#define SH_CROP ((VF_H - (VF_W * SH_PANE_H / SH_PANE_W)) / 2)      /* 24 */

/* The single-photograph view decodes at this size rather than scaling the
 * gallery thumbnail: thumb_load takes any target, so there is no reason to
 * show someone a 252 px thumbnail blown up to most of the screen. */
/*
 * The photo screen: the picture on the right, everything else in a column
 * on the left, and nothing on anything else.
 *
 * 600x450 is 1600x1200 at exactly 6/16. thumb_load scales in sixteenths and
 * rounds DOWN so the picture fits the tile, so a well of any other size gets
 * the next step below it and a mat round the picture: the old 464x348 well
 * showed a 400x300 picture (4/16) inside 32 px of white on each side, which
 * is what "the image is so small" meant. At 600x450 a frame fills the well
 * edge to edge, and a quad's quadrants are 300x225 - 3/16, also exact.
 *
 * The 192 px left of the well is what 800 leaves after the well and an 8 px
 * margin, and it takes everything that is not the picture: BACK, the caption
 * as one fact per line, and the three buttons stacked at the foot. They used
 * to be a row under the picture, which spent 62 px of the height on a panel
 * that is short of height and not of width. 4:3 is kept - the sensor's
 * aspect - so the frame is not distorted to make room.
 *
 * The arithmetic is checked below rather than trusted, because every one of
 * these was a loose number in the draw code and the overlap was invisible
 * until someone opened a photograph on the bench.
 */
#define PH_W 600
#define PH_H 450
#define PH_TOP 0
#define PH_X0 ((UI_W - PH_W) / 2)   /* 100: the picture centred, the title over its corner */
#define PH_LINE_Y (PH_H + 6)        /* the one line under it: facts left, actions right */
_Static_assert(PH_W * 3 == PH_H * 4, "photo pane is not 4:3");
_Static_assert(PH_TOP + PH_H + 30 <= UI_H, "no room for the line under the photograph");

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

typedef enum {
  SCR_MENU = 0,
  /* SHOOT is the viewfinder AND the mode picker. They were two screens and
   * that was one too many: the mode is a property of the photograph you are
   * about to take, so it belongs beside the picture you are framing, not
   * behind a separate tile you have to remember to visit. */
  SCR_SHOOT,
  SCR_LOOK,
  SCR_GALLERY,
  SCR_PHOTO,
  SCR_ROLL,
  SCR_SETTINGS,
  SCR_DISPLAY,
  SCR_SOUND,
  SCR_CONNECTION,
  SCR_STORAGE,
  SCR_ABOUT,
  SCR_POWER,
  SCR_COUNT,
} screen_t;


/* Where Back goes. One level, always, and never to a remembered screen. */
static const screen_t SCREEN_PARENT[SCR_COUNT] = {
    [SCR_MENU] = SCR_SHOOT, [SCR_SHOOT] = SCR_SHOOT,
    [SCR_LOOK] = SCR_LOOK, [SCR_GALLERY] = SCR_GALLERY,
    [SCR_PHOTO] = SCR_GALLERY, [SCR_ROLL] = SCR_CONNECTION, [SCR_SETTINGS] = SCR_SETTINGS,
    [SCR_DISPLAY] = SCR_SETTINGS, [SCR_SOUND] = SCR_SETTINGS,
    [SCR_CONNECTION] = SCR_CONNECTION, [SCR_STORAGE] = SCR_SETTINGS,
    [SCR_ABOUT] = SCR_SETTINGS, [SCR_POWER] = SCR_SETTINGS,
};


/* ------------------------------------------------------------------ */
/* Modes                                                               */
/*                                                                     */
/* The camera is always in one of five modes; there is no home screen   */
/* to come back to. Moving between them is horizontal - a swipe, or a   */
/* pick from the mode row the title opens - and the header carries the   */
/* motion (see hdr_* below). Each mode owns a screen tree; Back walks   */
/* the tree and stops at the mode's home.                               */
/* ------------------------------------------------------------------ */

typedef enum { MODE_SHOOT = 0, MODE_ROLL, MODE_FILTER, MODE_CONNECT, MODE_SETUP, MODE_COUNT } kmode_t;

typedef struct {
  const char *jp;
  screen_t home;
} mode_def_t;

static const mode_def_t MODES[MODE_COUNT] = {
    {"撮影", SCR_SHOOT}, {"再生", SCR_GALLERY}, {"色", SCR_LOOK}, {"接続", SCR_CONNECTION}, {"設定", SCR_SETTINGS},
};

/* A child screen's own name, for the header. One script: the Japanese word
 * is the identity, not a caption over an English one. */
static const char *const SCREEN_JP[SCR_COUNT] = {
    [SCR_MENU] = "", [SCR_SHOOT] = "撮影", [SCR_LOOK] = "色", [SCR_GALLERY] = "再生",
    [SCR_PHOTO] = "写真", [SCR_ROLL] = "ロール", [SCR_SETTINGS] = "設定", [SCR_DISPLAY] = "表示",
    [SCR_SOUND] = "音", [SCR_CONNECTION] = "接続", [SCR_STORAGE] = "カード", [SCR_ABOUT] = "情報",
    [SCR_POWER] = "電源",
};

static kmode_t mode_of(screen_t sc) {
  switch (sc) {
    case SCR_GALLERY: case SCR_PHOTO: return MODE_ROLL;
    case SCR_LOOK: return MODE_FILTER;
    case SCR_CONNECTION: case SCR_ROLL: return MODE_CONNECT;
    case SCR_SETTINGS: case SCR_DISPLAY: case SCR_SOUND: case SCR_STORAGE: case SCR_ABOUT: case SCR_POWER:
      return MODE_SETUP;
    default: return MODE_SHOOT;
  }
}

/* Touch items the shell owns, above every screen's own range. */
#define IT_HDR 201        /* the title: Back on a child screen, the mode row on a home */
#define IT_MODE0 210      /* IT_MODE0 + kmode_t: a pick from the mode row */

typedef enum {
  DLG_NONE = 0,
  DLG_SHUTDOWN,
  DLG_RESTART,
  DLG_DELETE,
  DLG_DELETE_ALL,
  DLG_FORMAT
} dialog_t;

static uint16_t *s_cv;
static screen_t s_screen = SCR_SHOOT; /* a camera boots into its finder */
static int s_focus[SCR_COUNT];
/* Whether focus is worth DRAWING.
 *
 * Focus is what a d-pad moves. On a device whose only input is a finger,
 * nothing is focused - you touch the thing you want - and painting a
 * selection on a tile nobody chose is just a highlight that appears on boot
 * and then follows you around. It stays tracked, because the shutter and FN
 * pins will one day have four friends, and it starts being drawn the moment
 * a physical key is actually used. */
static bool s_focus_shown;

static bool foc(screen_t sc, int i) { return s_focus_shown && s_focus[sc] == i; }
static int s_pressed = -1;      /* held item index, -1 for none */
static dialog_t s_dialog = DLG_NONE;
static int s_dlg_focus;          /* 0 = safe action, 1 = the other one */
static int64_t s_shot_seen_us;
/* shoot.displayAfterShotS = -1: the report is up and waiting to be dismissed
 * by a touch or a key rather than by a timer. See shot_hold_ack(). */
static bool s_shot_hold;
static char s_toast[48];
static int64_t s_toast_us;
static uint16_t *s_photo;        /* PH_W * PH_H, decoded on entering SCR_PHOTO */
static bool s_photo_ok;
static char s_photo_id[40];
static char s_photo_label[16];
static char s_photo_mode[12];
static int s_photo_frames;
/* The open photograph's favourite flag. Read from META.JSON when the screen
 * opens and kept here, not re-read on every draw: a draw runs many times a
 * second and this would be an SD read and a JSON parse in each of them. */
static bool s_photo_fav;

/*
 * The wigglegram player (#160).
 *
 * A wiggle is four photographs of one moment from four lenses 19 mm apart,
 * and the parallax between them is the whole of what the camera makes. Shown
 * as C1 for ever, the screen was a picture of one lens - the one thing a
 * wiggle is not. So the frames are decoded in the background (gallery.c owns
 * that; this task must never decode) and, once they are all in, this steps
 * through them.
 *
 * Nothing here allocates. The pixels belong to gallery.c, are never freed and
 * never move, and a frame is read only while its bit is in `s_wig_have` for
 * `s_wig_gen` - which is what makes a torn frame impossible without a lock on
 * the draw path.
 */
static uint32_t s_wig_gen;       /* the gallery job token, 0 when none */
static uint32_t s_wig_have;      /* frames decoded, bit i for C(i+1) */
static bool s_wig_play;          /* stepping */
static bool s_wig_repeat;        /* false for the KDP `sweep` loop: one pass, then hold */
static bool s_wig_oneway;        /* continuous/sweep: the far->near wrap is a snap, not a swing */
static uint8_t s_wig_seq[PURE_WIGGLE_SEQ_MAX];
static int s_wig_len;
static int s_wig_pos;
static int s_wig_period_ms;
static int64_t s_wig_next_us;
/* How many of the four decoded, for the "3 OF 4 FRAMES" note. 0 means there
 * is nothing to say - no job, or not finished yet. */
static int s_wig_count;
/*
 * A quad's detail view is all four looks at once, 2x2 in the well, not a
 * still of one of them. It uses the same background frames job as the swing,
 * at half the well's size; s_quad says the job is a grid and not a swing, and
 * s_quad_ready that all four were tried and the grid may replace the still.
 * Nothing steps: the grid is drawn once when it is ready and then owes no
 * frames, exactly like a still.
 */
static bool s_quad;
static bool s_quad_ready;
_Static_assert(PH_W == GALLERY_FRAME_MAX_W && PH_H == GALLERY_FRAME_MAX_H,
               "the frame buffers are sized to the photograph well");

/*
 * Frames are hard cuts, on purpose (#161, 0.4.21-0.4.23).
 *
 * Two crossfades were tried between them and both taken out. A dissolve across
 * the dwell was smooth and dead - a picture always part-way between two lenses
 * never pops, and the pop is the wigglegram. A 70 ms front-loaded fade kept
 * the pop but was then measured against the reference the camera is meant to
 * match: a reel of another four-lens camera's wigglegrams, at 30 fps, changes
 * picture every third frame with EXACTLY zero difference between changes. No
 * blend, at any weight, for any duration. Its smoothness is alignment (the
 * subject pinned, the background moving) and a constant direction, both of
 * which live elsewhere - gallery_frames_begin()'s per-camera offsets and the
 * continuous loop default. So the player is #160's: one frame per period,
 * from the decoded PSRAM buffer, no composite buffer, no sub-steps.
 */

/* Item index reserved for the header's Back target on every detail screen.
 * Kept out of the 0..N-1 range so a screen's own items can be plain indices. */
#define IT_BACK 200

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

static inline void px_set(int x, int y, uint16_t c) {
  if ((unsigned)x < UI_W && (unsigned)y < UI_H) s_cv[(size_t)y * UI_W + x] = c;
}

static void fill(int x, int y, int w, int h, uint16_t colour) {
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > UI_W) w = UI_W - x;
  if (y + h > UI_H) h = UI_H - y;
  if (w <= 0 || h <= 0) return;
  for (int r = 0; r < h; r++) {
    uint16_t *row = s_cv + (size_t)(y + r) * UI_W + x;
    for (int i = 0; i < w; i++) row[i] = colour;
  }
}

static uint16_t mix(uint16_t a, uint16_t b, int k) {
  const int ar = (a >> 11) & 0x1F, ag = (a >> 5) & 0x3F, ab = a & 0x1F;
  const int br = (b >> 11) & 0x1F, bg = (b >> 5) & 0x3F, bb = b & 0x1F;
  const int r = ar + (((br - ar) * k) >> 8);
  const int g = ag + (((bg - ag) * k) >> 8);
  const int bl = ab + (((bb - ab) * k) >> 8);
  return (uint16_t)((r << 11) | (g << 5) | bl);
}

/**
 * Dim what is behind, in place.
 *
 * The one compositing operation this grammar needs and cannot express with a
 * bevel: a modal has to make the screen under it read as unavailable, and a
 * half-lit list still invites a press. `k` is 0..255 towards `tint`.
 *
 * It is a per-pixel loop and there is no cheaper way to darken pixels that are
 * already on the canvas - but it is named and lives here so there is exactly
 * one of it. It was written out by hand inside draw_dialog(), which is how a
 * second one appeared on the viewfinder to keep MENU legible; that one is gone
 * (a plate does the job for nothing), and this is the only caller left.
 *
 * Only for surfaces that are drawn once and then held. Nothing on a path that
 * repaints at frame rate may call it: 800 x 480 is 384 000 unpack-mix-pack
 * round trips.
 */
static void scrim(int x, int y, int w, int h, uint16_t tint, int k) {
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > UI_W) w = UI_W - x;
  if (y + h > UI_H) h = UI_H - y;
  for (int r = 0; r < h; r++) {
    uint16_t *row = s_cv + (size_t)(y + r) * UI_W + x;
    for (int c = 0; c < w; c++) row[c] = mix(row[c], tint, k);
  }
}

/**
 * A filled disc with a soft edge: the one solid shape the interface draws,
 * for the four-camera marks. Coverage is the distance to the rim clamped to
 * one pixel, which at these radii is all the anti-aliasing a dot needs.
 */
static void disc(float cx, float cy, float r, uint16_t ink, int alpha) {
  if (alpha <= 0 || r <= 0.f) return;
  const int x0 = (int)floorf(cx - r - 1.f), x1 = (int)ceilf(cx + r + 1.f);
  const int y0 = (int)floorf(cy - r - 1.f), y1 = (int)ceilf(cy + r + 1.f);
  for (int y = y0 < 0 ? 0 : y0; y < y1 && y < UI_H; y++) {
    uint16_t *row = s_cv + (size_t)y * UI_W;
    const float dy = (float)y + 0.5f - cy;
    for (int x = x0 < 0 ? 0 : x0; x < x1 && x < UI_W; x++) {
      const float dx = (float)x + 0.5f - cx;
      float k = r + 0.5f - sqrtf(dx * dx + dy * dy);
      if (k <= 0.f) continue;
      if (k > 1.f) k = 1.f;
      const int a = (int)(k * (float)alpha);
      row[x] = a >= 255 ? ink : mix(row[x], ink, a);
    }
  }
}

static void draw_bits(const uint8_t *bits, int w, int h, int stride, int x, int y, int scale,
                      uint16_t ink) {
  for (int row = 0; row < h; row++) {
    const uint8_t *src = bits + (size_t)row * stride;
    for (int col = 0; col < w; col++) {
      if (!(src[col >> 3] & (0x80 >> (col & 7)))) continue;
      if (scale == 1) px_set(x + col, y + row, ink);
      else fill(x + col * scale, y + row * scale, scale, scale, ink);
    }
  }
}

/* The Japanese faces and the transformed display type: needs draw_bits(),
 * px_set(), mix() and s_cv above. */
#include "ui_text_jp.h"
#include "ui_type.h"

/* Uppercase in place, ASCII only.
 *
 * Look and sound names arrive as whoever authored them typed them - "Party
 * Neg", "cheap-digi" - and every control label on this interface is
 * uppercase. Done here rather than in the JSON so the name Studio shows and
 * the name the camera shows are the same string. */
static void upcase(char *s) {
  for (; *s; s++)
    if (*s >= 'a' && *s <= 'z') *s = (char)(*s - 'a' + 'A');
}

/* ------------------------------------------------------------------ */
/* Configuration writes                                                */
/*                                                                     */
/* Every control on every screen goes through one of these. The old UI */
/* had MODE and FLASH mutating statics and never touching the store,   */
/* so the screens did not change what the camera did - and the         */
/* viewfinder, which read the config, visibly disagreed with the       */
/* screen you had just used.                                           */
/* ------------------------------------------------------------------ */

/**
 * Build {"a":{"b":{"c":leaf}}} from "a.b.c" and merge it.
 *
 * config_merge takes a bare config object and deep-merges it, so a patch is
 * exactly the path spelled out as nested objects with the new value at the
 * bottom. Everything the config store does not see stays as it was.
 */
static bool cfg_patch(const char *path, cJSON *leaf) {
  /* The nesting is meta.c's, so it can be host-tested against the real cJSON
   * rather than only exercised by pressing buttons on a bench. */
  cJSON *root = meta_patch_path(path, leaf);
  if (root == NULL) return false;

  const esp_err_t err = config_merge(root);
  cJSON_Delete(root);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "config merge failed for %s: %s", path, esp_err_to_name(err));
    return false;
  }
  config_save();
  return true;
}

static bool cfg_set_str(const char *path, const char *v) {
  return cfg_patch(path, cJSON_CreateString(v));
}
static bool cfg_set_int(const char *path, int v) {
  return cfg_patch(path, cJSON_CreateNumber(v));
}
static bool cfg_set_bool(const char *path, bool v) {
  return cfg_patch(path, cJSON_CreateBool(v));
}

/* power.c reports USB through a snapshot struct rather than a getter. */
static bool usb_attached(void) {
  power_state_t p;
  power_get(&p);
  return p.usb_attached;
}

static void notice_say(const char *text, uint16_t ink, int dur_ms, bool dots);
/* Every remark a screen used to raise as a tooltip is a notice now: the
 * same entrance, the same exit, the same place. The words themselves are
 * still the old English ones and are rewritten screen by screen. */
static void toast(const char *s) {
  snprintf(s_toast, sizeof s_toast, "%s", s);
  s_toast_us = esp_timer_get_time();
  notice_say(s, RGB(0xf2, 0xf2, 0xee), 1500, false);
}

/* ------------------------------------------------------------------ */
/* Flash and mode, the two controls that live on the viewfinder        */
/* ------------------------------------------------------------------ */

static const char *const FLASH_ORDER[3] = {"auto", "on", "off"};
/* The segments read AUTO / ON / OFF left to right, which is the same order
 * the cycle uses, so one table serves both. */
#define FLASH_ORDER_BY_INDEX FLASH_ORDER

static int flash_index(void) {
  const char *v = config_str("shoot.flashMode", "auto");
  for (int i = 0; i < 3; i++) if (strcmp(v, FLASH_ORDER[i]) == 0) return i;
  return 0;
}

/* The flash used to be a control ON the viewfinder, and a quarter-second
 * yellow burn on the bolt was how a change announced itself while you were
 * looking at the picture rather than at the control. The control moved to LOOK
 * in 0.4.15, where the pressed segment says the same thing permanently and the
 * finder is not even on screen - so the timestamp had no reader left and the
 * burn had nothing to burn on. Both are gone. The SHOOT strip states the flash
 * mode instead of flashing about it, which is what a status bar is for. */
static void flash_cycle(void) {
  const int next = (flash_index() + 1) % 3;
  cfg_set_str("shoot.flashMode", FLASH_ORDER[next]);
}

static bool mode_is_quad(void) { return strcmp(config_str("mode", "wiggle"), "quad") == 0; }

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

/**
 * Black, then the name lands.
 *
 * One object, one spring: the word rises the last forty pixels with a little
 * overshoot and settles, held long enough to be read, and the finder
 * dissolves in over it. Nothing here pretends to be a tube or a shutter,
 * and nothing counts to four on a timer - the cameras announce themselves
 * on the finder when they actually answer.
 */
static void splash(void) {
  const int64_t t0 = esp_timer_get_time();
  mo_obj_t w;
  mo_obj_place(&w, UI_W * 0.5f, UI_H * 0.5f + 40.f);
  mo_set(&w.alpha, 0.f);
  mo_to(&w.y, UI_H * 0.5f);
  mo_to(&w.alpha, 255.f);
  w.delay_ms = 120;
  mo_obj_go(&w, t0);
  int64_t last = t0;
  for (;;) {
    const int64_t now = esp_timer_get_time();
    const float dt = (float)(now - last) / 1000.f;
    last = now;
    const bool live = mo_obj_step(&w, now, dt, MO_BOUNCE);
    fill(0, 0, UI_W, UI_H, RGB(0x00, 0x00, 0x00));
    ut_fx(&UT_MB, w.x.v, w.y.v, "KINO D4", 2.f, 0.f, C_INK, (int)w.alpha.v, false);
    gfx_present();
    if (!live && now - t0 > 1100000) break;
    vTaskDelay(pdMS_TO_TICKS(16));
  }
}

/* ------------------------------------------------------------------ */
/* The header: the mode's name, and the motion between modes           */
/* ------------------------------------------------------------------ */

#define HDR_X 24
#define HDR_Y 14
#define HDR_GROUND C_GROUND
#define HDR_INK RGB(0xf2, 0xf2, 0xee)
#define HDR_DIM RGB(0x80, 0x88, 0x94)
/* How far a title travels on the way in or out. Short: the corner is the
 * anchor and a word that crosses the whole screen reads as a scroll. */
#define HDR_TRAVEL 170.f

typedef struct {
  kmode_t mode;   /* what the header names now (the incoming one during a move) */
  kmode_t prev;   /* what it named before the move */
  bool moving;
  mo_obj_t in_t, in_s;   /* incoming title and its secondary word */
  mo_obj_t out_t, out_s; /* outgoing */
  int64_t last_us;
} hdr_t;
static hdr_t s_hdr = {.mode = MODE_SHOOT, .prev = MODE_SHOOT};

/* The mode row: the five names under the header, opened by tapping the
 * title on a mode's home. It drops in, the names arrive staggered, and a
 * pick or a tap outside closes it. */
#define MROW_Y (HEAD_H)
#define MROW_H 72
static bool s_row_open;
static mo_val_t s_row_drop;         /* 0 closed .. 1 open */
static mo_obj_t s_row_item[MODE_COUNT];
static int64_t s_row_last_us;

static void hdr_place_home(mo_obj_t *t, mo_obj_t *sec) {
  mo_obj_place(t, HDR_X, HDR_Y);
  mo_obj_place(sec, HDR_X, HDR_Y);
}

/**
 * Start the move from `from` to `to`. `dir` is the direction of travel on
 * screen: +1 when the new mode is to the right (swipe left), -1 the other way.
 *
 *   outgoing title    leaves at once, toward -dir, fading
 *   outgoing word     follows 60 ms later
 *   incoming title    enters from +dir with momentum, overshoots, settles
 *   incoming word     60 ms behind it, softer
 *
 * A move issued during a move retargets from where things are: the incoming
 * pair becomes the outgoing pair with its velocity intact.
 */
static void hdr_go(kmode_t from, kmode_t to, int dir, int64_t now_us) {
  if (s_hdr.moving) {
    s_hdr.out_t = s_hdr.in_t;
    s_hdr.out_s = s_hdr.in_s;
  } else {
    hdr_place_home(&s_hdr.out_t, &s_hdr.out_s);
  }
  s_hdr.prev = from;
  s_hdr.mode = to;
  s_hdr.moving = true;
  s_hdr.last_us = now_us;

  mo_to(&s_hdr.out_t.x, HDR_X - dir * HDR_TRAVEL);
  mo_to(&s_hdr.out_t.alpha, 0.f);
  s_hdr.out_t.delay_ms = 0;
  mo_obj_go(&s_hdr.out_t, now_us);
  mo_to(&s_hdr.out_s.x, HDR_X - dir * HDR_TRAVEL * 0.8f);
  mo_to(&s_hdr.out_s.alpha, 0.f);
  s_hdr.out_s.delay_ms = 60;
  mo_obj_go(&s_hdr.out_s, now_us);

  hdr_place_home(&s_hdr.in_t, &s_hdr.in_s);
  mo_launch(&s_hdr.in_t.x, HDR_X + dir * HDR_TRAVEL, HDR_X, -dir * 0.45f);
  mo_set(&s_hdr.in_t.alpha, 40.f);
  mo_to(&s_hdr.in_t.alpha, 255.f);
  s_hdr.in_t.delay_ms = 0;
  mo_obj_go(&s_hdr.in_t, now_us);
  mo_launch(&s_hdr.in_s.x, HDR_X + dir * HDR_TRAVEL * 0.7f, HDR_X, -dir * 0.3f);
  mo_set(&s_hdr.in_s.alpha, 0.f);
  mo_to(&s_hdr.in_s.alpha, 255.f);
  s_hdr.in_s.delay_ms = 70;
  mo_obj_go(&s_hdr.in_s, now_us);
}

/** Step the header's objects by the time since the last step. */
static void hdr_step(int64_t now_us) {
  if (!s_hdr.moving) return;
  float dt = (float)(now_us - s_hdr.last_us) / 1000.f;
  s_hdr.last_us = now_us;
  bool live = false;
  live |= mo_obj_step(&s_hdr.out_t, now_us, dt, MO_SNAP);
  live |= mo_obj_step(&s_hdr.out_s, now_us, dt, MO_SNAP);
  live |= mo_obj_step(&s_hdr.in_t, now_us, dt, MO_BOUNCE);
  live |= mo_obj_step(&s_hdr.in_s, now_us, dt, MO_LAZY);
  if (!live) s_hdr.moving = false;
}

/** One title: the mode's word in the bold face, able to move and fade. */
static void hdr_word(const mo_obj_t *t, const char *jp, uint16_t ink, int alpha_mul, bool over_picture) {
  const int a = (int)t->alpha.v * alpha_mul / 255;
  if (a <= 0) return;
  if (a >= 255 && !over_picture) {
    ut_draw(&UT_MB, (int)t->x.v, (int)t->y.v, jp, ink);
    return;
  }
  const float x = t->x.v + (float)ut_w(&UT_MB, jp) / 2.f, y = t->y.v + UT_MB.em / 2.f;
  ut_fx(&UT_MB, x, y, jp, 1.f, 0.f, ink, a, over_picture);
}

/**
 * The header for a screen: on a mode's home its name, on a child screen a
 * mark that means "up" and the child's own name. On the ground colour unless
 * `over_picture`, when it is type alone with a shadow. `alpha` lets a screen
 * let it go - the finder does, once it has been read.
 */
static void draw_header_a(screen_t sc, bool over_picture, int alpha) {
  const int64_t now = esp_timer_get_time();
  hdr_step(now);
  if (!over_picture) fill(0, 0, UI_W, HEAD_H, HDR_GROUND);
  if (alpha <= 0) return;

  const kmode_t m = mode_of(sc);
  const bool home = MODES[m].home == sc;
  if (s_hdr.moving && home) {
    hdr_word(&s_hdr.out_t, MODES[s_hdr.prev].jp, HDR_INK, alpha, over_picture);
    hdr_word(&s_hdr.in_t, MODES[s_hdr.mode].jp, HDR_INK, alpha, over_picture);
    return;
  }
  mo_obj_t t, sec;
  hdr_place_home(&t, &sec);
  if (home) {
    hdr_word(&t, MODES[m].jp, HDR_INK, alpha, over_picture);
    return;
  }
  /* The way up as a mark, then the child's name. Not a path: the mode's
   * own name is one tap away. */
  ut_draw_a(&UT_M, HDR_X, HDR_Y, "←", HDR_DIM, alpha);
  mo_obj_place(&t, HDR_X + 44, HDR_Y);
  hdr_word(&t, SCREEN_JP[sc], HDR_INK, alpha, over_picture);
}
static void draw_header_at(screen_t sc, bool over_picture) { draw_header_a(sc, over_picture, 255); }
static void draw_header(screen_t sc) { draw_header_a(sc, false, 255); }

/* ---- the mode row ---- */

static void row_open(int64_t now_us) {
  s_row_open = true;
  s_row_last_us = now_us;
  mo_to(&s_row_drop, 1.f);
  for (int i = 0; i < MODE_COUNT; i++) {
    mo_obj_place(&s_row_item[i], 0.f, 10.f);
    mo_set(&s_row_item[i].alpha, 0.f);
    mo_to(&s_row_item[i].alpha, 255.f);
    mo_to(&s_row_item[i].y, 0.f);
    s_row_item[i].delay_ms = 30 * i;
    mo_obj_go(&s_row_item[i], now_us);
  }
}

static void row_close(void) {
  s_row_open = false;
  mo_to(&s_row_drop, 0.f);
}

static void row_step(int64_t now_us) {
  float dt = (float)(now_us - s_row_last_us) / 1000.f;
  s_row_last_us = now_us;
  mo_spring(&s_row_drop, dt, MO_SETTLE);
  if (s_row_open)
    for (int i = 0; i < MODE_COUNT; i++) mo_obj_step(&s_row_item[i], now_us, dt, MO_BOUNCE);
}

/* Each name's slot: five equal columns across the width. */
static int row_col_x(int i) { return HDR_X + i * ((UI_W - 2 * HDR_X) / MODE_COUNT); }

static void draw_mode_row(void) {
  const int64_t now = esp_timer_get_time();
  row_step(now);
  const float k = s_row_drop.v;
  if (k <= 0.01f && !s_row_open) return;
  const int h = (int)(MROW_H * k);
  if (h <= 0) return;
  fill(0, MROW_Y, UI_W, h, HDR_GROUND);
  fill(0, MROW_Y + h - 1, UI_W, 1, RGB(0x22, 0x26, 0x2c));
  if (!s_row_open) return;
  const kmode_t cur = mode_of(s_screen);
  for (int i = 0; i < MODE_COUNT; i++) {
    const mo_obj_t *o = &s_row_item[i];
    const int a = (int)(o->alpha.v * k);
    if (a <= 0) continue;
    const int x = row_col_x(i);
    const float y = MROW_Y + 18.f + o->y.v;
    const uint16_t ink = i == cur ? HDR_INK : HDR_DIM;
    ut_fx(&UT_MB, x + ut_w(&UT_MB, MODES[i].jp) / 2.f, y + UT_MB.em / 2.f, MODES[i].jp, 1.f, 0.f, ink, a, false);
  }
}

/* Which mode a point in the open row is on, or -1. */
static int row_hit(int x, int y) {
  if (!s_row_open || y < MROW_Y || y >= MROW_Y + MROW_H) return -1;
  const int cw = (UI_W - 2 * HDR_X) / MODE_COUNT;
  for (int i = 0; i < MODE_COUNT; i++)
    if (x >= row_col_x(i) - 8 && x < row_col_x(i) + cw) return i;
  return -1;
}

static void go(screen_t s, int dissolve_ms);

/** Move to mode `to`, with the header carrying the motion. */
static void mode_go(kmode_t to, int dir) {
  const kmode_t from = mode_of(s_screen);
  if (to == from) return;
  hdr_go(from, to, dir, esp_timer_get_time());
  go(MODES[to].home, 0);
}

/** One step left or right along the row of modes; stops at the ends. */
static void mode_swipe(int dir) {
  const int cur = (int)mode_of(s_screen);
  const int next = cur + dir;
  if (next < 0 || next >= MODE_COUNT) return;
  mode_go((kmode_t)next, dir);
}

/* Where an item index sits inside a band of `count` items starting at `base`,
 * or -1 when it is outside. Every segmented row and every picker on this
 * interface is such a band, and this is the arithmetic each of them used to
 * write out twice - once for pressed, once for focused. */
static int band_rel(int v, int base, int count) {
  return (v >= base && v < base + count) ? v - base : -1;
}

static void human_bytes(char *out, size_t n, uint64_t bytes) {
  if (bytes >= (1024ULL * 1024 * 1024))
    snprintf(out, n, "%llu.%llu GB", bytes / (1024ULL * 1024 * 1024),
             (bytes % (1024ULL * 1024 * 1024)) / (107374182ULL));
  else snprintf(out, n, "%llu MB", bytes / (1024ULL * 1024));
}

/* ------------------------------------------------------------------ */
/* Notices: status that enters the frame, stays long enough to read,    */
/* and leaves. No acknowledgement, no permanent slot.                    */
/*                                                                     */
/* One at a time. A new one replaces the old from where it is - the    */
/* camera does not queue remarks. The words are chosen where the fact  */
/* is noticed (notice_watch, below the capture), so this knows nothing  */
/* about cards or radios: it is given a string, an ink and a duration.  */
/* ------------------------------------------------------------------ */

typedef struct {
  char text[48];
  uint16_t ink;
  int64_t t0_us;   /* 0 = nothing showing */
  int dur_ms;
  bool dots;       /* the four-camera prelude: ● ● ● ● gathering into one */
  mo_val_t x;      /* the word's right edge, springing in from off screen */
  int64_t last_us;
  int cue;         /* NOTICE_CUE_*: the sound that goes with the word */
  bool cued;       /* it has played */
} notice_t;
enum { NOTICE_CUE_NONE = 0, NOTICE_CUE_SYNC, NOTICE_CUE_DONE };
static notice_t s_notice;

#define NOTICE_RIGHT (UI_W - 24)
#define NOTICE_Y 14
#define NOTICE_DOTS_MS 260

static bool notice_live(void) { return s_notice.t0_us != 0; }

static void notice_say(const char *text, uint16_t ink, int dur_ms, bool dots) {
  const int64_t now = esp_timer_get_time();
  snprintf(s_notice.text, sizeof s_notice.text, "%s", text);
  s_notice.ink = ink;
  s_notice.t0_us = now;
  s_notice.dur_ms = dur_ms;
  s_notice.dots = dots;
  s_notice.last_us = now;
  s_notice.cue = NOTICE_CUE_NONE;
  s_notice.cued = false;
  /* From off the right edge, with a push, whatever it was doing before. */
  mo_launch(&s_notice.x, (float)UI_W + ut_w(&UT_MB, text), (float)NOTICE_RIGHT, -0.9f);
  s_mo_live_count++; /* a frame is owed, whichever screen is up */
}

static void notice_play_cue(void) {
  s_notice.cued = true;
  if (s_notice.cue == NOTICE_CUE_SYNC) audio_sync();
  else if (s_notice.cue == NOTICE_CUE_DONE) audio_done();
}

/**
 * Give the notice just said a sound. Designed with the motion, not beside
 * it: a notice with the four-dot prelude plays its cue on the frame the dots
 * meet and the word lands (draw_notice), a plain one plays it now, as the
 * word enters. The sound and the picture are one event either way.
 */
static void notice_cue(int cue) {
  s_notice.cue = cue;
  s_notice.cued = false;
  if (!s_notice.dots) notice_play_cue();
}

/** Draw the notice if there is one; steps its spring. `over_picture` adds the shadow. */
static void draw_notice(bool over_picture) {
  if (!notice_live()) return;
  const int64_t now = esp_timer_get_time();
  const int64_t ms = (now - s_notice.t0_us) / 1000;
  const int total = s_notice.dur_ms + (s_notice.dots ? NOTICE_DOTS_MS : 0);
  if (ms >= total) {
    s_notice.t0_us = 0;
    return;
  }
  s_mo_live_count++;
  const float dt = (float)(now - s_notice.last_us) / 1000.f;
  s_notice.last_us = now;

  if (s_notice.dots && ms < NOTICE_DOTS_MS) {
    /* Four marks, one per camera, closing on one point: the moment they
     * agree. Spacing runs from 34 px to 0 on an ease-out; the word follows. */
    const float k = ease_out_cubic((float)ms / NOTICE_DOTS_MS);
    const float cx = NOTICE_RIGHT - 40.f, cy = NOTICE_Y + UT_MB.em / 2.f;
    const float gap = 34.f * (1.f - k);
    for (int i = 0; i < 4; i++) {
      if (over_picture) disc(cx + (i - 1.5f) * gap + 1.5f, cy + 1.5f, 6.f, 0x0841, 150);
      disc(cx + (i - 1.5f) * gap, cy, 6.f, s_notice.ink, 255);
    }
    return;
  }
  if (s_notice.dots && ms == NOTICE_DOTS_MS) s_notice.last_us = now;
  if (s_notice.cue && !s_notice.cued) notice_play_cue(); /* the dots have met */
  mo_spring(&s_notice.x, dt, MO_BOUNCE);
  const int word_ms = (int)ms - (s_notice.dots ? NOTICE_DOTS_MS : 0);
  const int out_ms = 180;
  float alpha = 255.f, drift = 0.f;
  if (word_ms > s_notice.dur_ms - out_ms) {
    const float k = ease_in_quart((float)(word_ms - (s_notice.dur_ms - out_ms)) / out_ms);
    alpha = 255.f * (1.f - k);
    drift = 24.f * k;
  }
  const float w = (float)ut_w(&UT_MB, s_notice.text);
  ut_fx(&UT_MB, s_notice.x.v - w / 2.f + drift, NOTICE_Y + UT_MB.em / 2.f, s_notice.text, 1.f, 0.f, s_notice.ink,
        (int)alpha, over_picture);
}

/* What the finder counted live on its last draw, for notice_watch. */
static int s_live_cams = -1;

/**
 * Watch the facts that deserve a word when they change, once per pass.
 * Edges only, and never on the first pass: the state the camera boots into
 * is not news. Each fact keeps its own previous value here.
 */
static void notice_watch(void) {
  static bool primed;
  static bool p_mounted, p_usb, p_low, p_online, p_sending;
  static net_state_t p_net;
  static int p_live;
  static int64_t q_last_us;
  static upload_queue_report_t q; /* polled at 2 Hz: it takes the queue's lock */

  storage_status_t sd;
  storage_get_status(&sd);
  power_state_t ps;
  power_get(&ps);
  net_status_t net;
  net_link_status(&net, esp_timer_get_time() / 1000);
  const bool low = sd.mounted && sd.free_bytes < 300ull * 1024 * 1024;
  const bool online = net_link_can_upload(&net);
  const int64_t now = esp_timer_get_time();
  if (!primed || now - q_last_us >= 500000) {
    upload_queue_status(&q);
    q_last_us = now;
  }
  const int waiting = q.pending + q.card_pending;
  const bool sending = online && q.server_state != UPLOAD_SERVER_UNREACHABLE && !q.halted &&
                       (waiting > 0 || q.uploading > 0);

  if (!primed) {
    primed = true;
    p_mounted = sd.mounted;
    p_usb = ps.usb_attached;
    p_net = net.state;
    p_low = low;
    p_live = s_live_cams;
    p_online = online;
    p_sending = sending;
    return;
  }
  if (sd.mounted != p_mounted) {
    notice_say(sd.mounted ? "カード OK" : "カードなし", sd.mounted ? C_INK : C_RED, 1400, false);
    p_mounted = sd.mounted;
  }
  if (ps.usb_attached != p_usb) {
    notice_say(ps.usb_attached ? "USB 接続" : "USB 切断", ps.usb_attached ? C_COBALT : C_INK, 1300, false);
    p_usb = ps.usb_attached;
  }
  /* つながった！ is the link to KINO ROLL coming up - the connection that
   * means something can happen. An address alone is the quieter "WiFi OK",
   * and not both in the same breath. */
  const bool linked_now = online && !p_online;
  if (net.radio_routed && net.state != p_net) {
    if (net.state == NET_IP_READY) { if (!linked_now) notice_say("WiFi OK", C_COBALT, 1400, false); }
    else if (p_net == NET_IP_READY) notice_say("WiFi なし", C_INK, 1400, false);
    p_net = net.state;
  }
  if (online != p_online) {
    if (online) notice_say("つながった！", C_COBALT, 1500, false);
    p_online = online;
  }
  /* A burst that was going out and has all arrived: the four marks meet,
   * the word, the landed cue. A burst interrupted by the link dropping still
   * has pictures waiting and says nothing - that is not a completion. */
  if (p_sending && !sending && waiting == 0 && q.uploading == 0 && !q.halted) {
    notice_say("送信済", C_COBALT, 1300, true);
    notice_cue(NOTICE_CUE_DONE);
  }
  p_sending = sending;
  if (low != p_low) {
    if (low) notice_say("カード残り少", C_YELLOW, 1800, false);
    p_low = low;
  }
  if (s_live_cams != p_live) {
    if (s_live_cams == 4 && p_live >= 0 && p_live < 4) {
      notice_say("同期 OK", C_INK, 1200, true);
      notice_cue(NOTICE_CUE_SYNC);
    }
    p_live = s_live_cams;
  }
}

/* ------------------------------------------------------------------ */
/* The capture, as an event                                            */
/*                                                                     */
/* Driven by what the pipeline reports - capture_stage(), the asked and  */
/* arrived masks, the report - never by a timer standing in for it. The */
/* three phases the brief names: an immediate response, the four-camera */
/* event while frames come back, a result that lands. Then, sometimes,  */
/* a word.                                                              */
/* ------------------------------------------------------------------ */

/* How a word arrives. One lifecycle (cap_say, the timeline), several
 * presentations: a word that is thrown, one that stands still, one that
 * runs down the side, one that is small and says nothing loudly, one that
 * is bigger than the screen and cut by its edge. Consistency here would be
 * a toast component; variation is the personality. */
typedef enum {
  RS_THROW = 0, /* oversized, tilted, lands with a back-ease, drifts out */
  RS_STILL,     /* cut in, cut out, no motion at all */
  RS_VERT,      /* 縦書き down the right side, fading in */
  RS_TINY,      /* small, bottom right, no motion */
  RS_HUGE,      /* four ems tall, cropped by the left edge, slides a little */
} react_style_t;

typedef struct {
  const char *text;
  uint16_t ink;
  int weight;      /* 0 = never by chance: contextual only */
  int dur_ms;      /* time on screen, entry to exit */
  react_style_t style;
} reaction_t;

/* The pool. NONE carries the most weight on purpose: a shutter that
 * celebrates every time is noise, and the rare lines stay rare because most
 * presses say nothing at all. Colour is one idea per event. */
static const reaction_t REACT_NONE = {NULL, 0, 55, 0, RS_STILL};
static const reaction_t REACTIONS[] = {
    {"撮れた！", C_YELLOW, 10, 800, RS_THROW}, {"よし。", C_INK, 10, 600, RS_STILL},
    {"いいね。", C_COBALT, 8, 800, RS_VERT},   {"バッチリ。", C_YELLOW, 5, 800, RS_THROW},
    {"もう一枚？", C_INK, 5, 1000, RS_TINY},   {"4枚！", C_COBALT, 5, 700, RS_HUGE},
    {"完璧。", C_RED, 1, 900, RS_THROW},
};
/* Contextual: chosen by a rule, each at most once per session. */
static const reaction_t REACT_HUNDRED = {"百枚！", C_RED, 0, 1100, RS_HUGE};
static const reaction_t REACT_SYNCED = {"4枚同期", C_COBALT, 0, 900, RS_STILL};
static const reaction_t REACT_LATE = {"まだ撮る？", C_INK, 0, 1100, RS_VERT};
static const reaction_t REACT_FAILED = {"撮れなかった", C_RED, 0, 1600, RS_STILL};

typedef struct {
  bool armed;
  int64_t t0_us;         /* the pass that saw the shutter open */
  int64_t done_us;       /* the pass that saw the report, 0 before */
  uint32_t seen_in;      /* frames_in as of the last pass */
  int64_t arrive_us[4];  /* when each mark lit, 0 = not yet */
  mo_val_t zoom;         /* the landing: panes at 1.06 settling to 1 */
  mo_tl_t hit;           /* luminance hit at the landing */
  const reaction_t *react;
  mo_tl_t react_tl;
  float react_x, react_y, react_rot, react_scale;
  bool failed;
  char fail_why[64];
  bool cue_pending;      /* 4枚同期 owes its sound when the word lands */
} cap_fx_t;
static cap_fx_t s_cap;
static uint32_t s_session_shots;
static bool s_said_hundred, s_said_synced, s_said_late;

static int64_t cap_since_ms(int64_t from_us) { return from_us ? (esp_timer_get_time() - from_us) / 1000 : -1; }

/** Pick the word for this photograph, or NULL. Rules first, then the pool. */
static const reaction_t *cap_pick(const capture_report_t *r) {
  if (!r->ok) return &REACT_FAILED;
  s_session_shots++;
  if (s_session_shots == 100 && !s_said_hundred) { s_said_hundred = true; return &REACT_HUNDRED; }
  if (r->stored == 4 && !s_said_synced) {
    bool synced = true;
    for (int i = 0; i < 4; i++) synced &= r->cam[i].attempted && r->cam[i].ok && r->cam[i].sync_class == PURE_SYNC_OK;
    if (synced) { s_said_synced = true; return &REACT_SYNCED; }
  }
  {
    const int hour = clock_local_hour();
    if (hour >= 0 && hour < 4 && !s_said_late) { s_said_late = true; return &REACT_LATE; }
  }
  int total = REACT_NONE.weight;
  for (size_t i = 0; i < sizeof REACTIONS / sizeof REACTIONS[0]; i++) total += REACTIONS[i].weight;
  int pick = mo_rand_n(total);
  if (pick < REACT_NONE.weight) return NULL;
  pick -= REACT_NONE.weight;
  for (size_t i = 0; i < sizeof REACTIONS / sizeof REACTIONS[0]; i++) {
    if (pick < REACTIONS[i].weight) {
      /* 4枚！ only when there were four. */
      if (REACTIONS[i].text[0] == '4' && r->stored < 4) return NULL;
      return &REACTIONS[i];
    }
    pick -= REACTIONS[i].weight;
  }
  return NULL;
}

/** Place a word: somewhere in the middle third, a little askew, entry faster than exit. */
static void cap_say(const reaction_t *w, int64_t now) {
  s_cap.react = w;
  if (w == NULL) return;
  const int glyphs = ut_w(&UT_MB, w->text) / UT_MB.em;
  switch (w->style) {
    case RS_THROW:
      s_cap.react_scale = glyphs <= 4 ? 2.6f : 2.f;
      s_cap.react_rot = (mo_rand() & 1 ? 1.f : -1.f) * (4.f + mo_rand_pm(4.f) + 4.f);
      s_cap.react_x = UI_W * 0.5f + mo_rand_pm(UI_W * 0.12f);
      s_cap.react_y = UI_H * 0.46f + mo_rand_pm(UI_H * 0.10f);
      break;
    case RS_STILL:
      s_cap.react_scale = 1.8f;
      s_cap.react_rot = 0.f;
      s_cap.react_x = UI_W * 0.5f;
      s_cap.react_y = UI_H * (w == &REACT_FAILED ? 0.42f : 0.5f);
      break;
    case RS_VERT:
      s_cap.react_scale = 1.3f;
      s_cap.react_rot = 0.f;
      s_cap.react_x = UI_W - 70.f;
      s_cap.react_y = 90.f;
      break;
    case RS_TINY:
      s_cap.react_scale = 1.f;
      s_cap.react_rot = 0.f;
      s_cap.react_x = UI_W - 24.f;
      s_cap.react_y = UI_H - 24.f - UT_S.em;
      break;
    case RS_HUGE:
      s_cap.react_scale = 4.4f;
      s_cap.react_rot = 0.f;
      s_cap.react_x = -30.f;
      s_cap.react_y = UI_H * 0.52f;
      break;
  }
  mo_tl_start(&s_cap.react_tl, now, w->dur_ms, w == &REACT_FAILED ? 0 : 140);
  s_cap.cue_pending = w == &REACT_SYNCED;
}

/**
 * Read the pipeline once per pass and move the event along. Called from
 * ui_pass() before anything draws, so the frame that follows already knows
 * which camera just delivered.
 */
static void cap_step(void) {
  const int64_t now = esp_timer_get_time();
  /* The sync cue goes with the word, not with the report: it fires on the
   * pass the reaction's delay runs out and 4枚同期 enters. */
  if (s_cap.cue_pending && s_cap.react_tl.start_us != 0 &&
      now >= s_cap.react_tl.start_us + (int64_t)s_cap.react_tl.delay_ms * 1000) {
    s_cap.cue_pending = false;
    audio_sync();
  }
  const capture_stage_t st = capture_stage();
  if (st == CAPTURE_IDLE) {
    if (s_cap.armed && !mo_tl_running(&s_cap.react_tl, now)) {
      s_cap.armed = false;
      s_cap.react = NULL;
    }
    return;
  }
  if (!s_cap.armed) {
    memset(&s_cap, 0, sizeof s_cap);
    s_cap.armed = true;
    s_cap.t0_us = now;
    mo_set(&s_cap.zoom, 1.f);
  }
  if (st != CAPTURE_DONE) {
    const uint32_t in = capture_frames_in();
    const uint32_t fresh = in & ~s_cap.seen_in;
    for (int i = 0; i < 4; i++)
      if (fresh & (1u << i)) s_cap.arrive_us[i] = now;
    s_cap.seen_in = in;
    return;
  }
  if (s_cap.done_us == 0) {
    s_cap.done_us = now;
    capture_report_t r;
    capture_last(&r);
    s_cap.failed = !r.ok;
    snprintf(s_cap.fail_why, sizeof s_cap.fail_why, "%.60s",
             r.err_msg[0] ? r.err_msg : (r.err_code[0] ? r.err_code : "NO PHOTO"));
    /* Frames the report knows about that no pass happened to catch. */
    for (int i = 0; i < 4; i++)
      if (r.cam[i].ok && s_cap.arrive_us[i] == 0) s_cap.arrive_us[i] = now;
    if (r.ok) {
      mo_set(&s_cap.zoom, 1.06f);
      mo_to(&s_cap.zoom, 1.f);
      mo_tl_start(&s_cap.hit, now, 110, 0);
    }
    cap_say(cap_pick(&r), now);
  }
}

/* The luminance the landing adds to the picture, 0..31 per channel. */
static int cap_lift(void) {
  if (!s_cap.armed || s_cap.done_us == 0 || s_cap.failed) return 0;
  const float t = mo_tl_at(&s_cap.hit, esp_timer_get_time());
  return (int)(11.f * (1.f - ease_out_cubic(t)));
}

/* The panes' zoom this frame: stepped here because the finder is the only
 * screen that draws it, and it draws every frame while it is live. */
static float cap_zoom(void) {
  if (!s_cap.armed || s_cap.done_us == 0) return 1.f;
  static int64_t last_us;
  const int64_t now = esp_timer_get_time();
  const float dt = last_us ? (float)(now - last_us) / 1000.f : 0.f;
  last_us = now;
  mo_spring(&s_cap.zoom, dt, MO_SETTLE);
  return s_cap.zoom.v;
}

/**
 * The four-camera event: 1 → 2 → 3 → 4, each digit dim until its frame is
 * in, bright the moment it lands and settling to the ink. Cameras the capture
 * did not ask stay dim; a failed frame goes red when the report says so.
 * `y` is the line's top; it is drawn wherever a capture is running.
 */
static void draw_cap_marks(int y, bool over_picture) {
  if (!s_cap.armed) return;
  const int64_t now = esp_timer_get_time();
  const uint32_t asked = capture_asked_cams();
  capture_report_t r;
  const bool done = s_cap.done_us != 0;
  if (done) capture_last(&r);
  /* Four marks, one per camera, in the order the lenses sit on the bar. A
   * small dim dot while the frame is owed, a full one the moment it lands -
   * yellow for that moment, then ink - red for a camera that did not. */
  const float step = 36.f, cy = y + 10.f;
  const float x0 = UI_W * 0.5f - 1.5f * step;
  for (int i = 0; i < 4; i++) {
    const float cx = x0 + i * step;
    uint16_t ink = RGB(0x55, 0x5c, 0x66);
    float rad = 3.f;
    if (done && r.cam[i].attempted && !r.cam[i].ok) { ink = C_RED; rad = 7.f; }
    else if (s_cap.arrive_us[i]) {
      const int64_t age = (now - s_cap.arrive_us[i]) / 1000;
      const float k = age < 160 ? (float)age / 160.f : 1.f;
      ink = age < 160 ? C_YELLOW : C_INK;
      rad = 7.f + 3.f * (1.f - ease_out_cubic(k));
      if (age < 160) s_mo_live_count++; /* still changing */
    } else if (asked == 0 || (asked & (1u << i))) {
      ink = RGB(0x80, 0x88, 0x94);
    }
    if (over_picture) disc(cx + 1.5f, cy + 1.5f, rad, 0x0841, 150);
    disc(cx, cy, rad, ink, 255);
  }
  if (!done) s_mo_live_count++; /* a capture in flight owes frames */
}

/** The word, if there is one this time, in its own manner. */
static void draw_cap_reaction(void) {
  const reaction_t *w = s_cap.react;
  if (w == NULL) return;
  const int64_t now = esp_timer_get_time();
  if (!mo_tl_running(&s_cap.react_tl, now) && mo_tl_at(&s_cap.react_tl, now) >= 1.f) return;
  const float t = mo_tl_at(&s_cap.react_tl, now); /* 0..1 over dur */
  const int dur = w->dur_ms;
  const float ms = t * dur;
  float scale = s_cap.react_scale, alpha = 255.f, dx = 0.f, dy = 0.f;
  switch (w->style) {
    case RS_THROW: {
      const float in_ms = 130.f, out_ms = 170.f;
      if (ms < in_ms) {
        const float k = ease_out_back(ms / in_ms);
        scale = s_cap.react_scale * (1.55f - 0.55f * k);
        alpha = 255.f * ease_out_cubic(ms / (in_ms * 0.6f));
      } else if (ms > dur - out_ms) {
        const float k = ease_in_quart((ms - (dur - out_ms)) / out_ms);
        alpha = 255.f * (1.f - k);
        dy = -14.f * k;
      }
      ut_fx(&UT_MB, s_cap.react_x + dx, s_cap.react_y + dy, w->text, scale, s_cap.react_rot, w->ink, (int)alpha, true);
      break;
    }
    case RS_STILL:
      /* There and then not. The only motion is the picture's. */
      ut_fx(&UT_MB, s_cap.react_x, s_cap.react_y, w->text, scale, 0.f, w->ink, 255, true);
      if (w == &REACT_FAILED)
        ut_fx(&UT_S, UI_W * 0.5f, s_cap.react_y + 52.f, s_cap.fail_why, 1.f, 0.f, C_INK, 255, true);
      break;
    case RS_VERT: {
      /* Down the right edge, each glyph a beat after the one above it. */
      const int a_in = 80;
      const float out_ms = 160.f;
      float a_all = 255.f;
      if (ms > dur - out_ms) a_all = 255.f * (1.f - ease_in_quart((ms - (dur - out_ms)) / out_ms));
      const char *p = w->text;
      float ty = s_cap.react_y;
      int i = 0;
      char one[8];
      while (*p) {
        const char *at = p;
        utf8_next(&p);
        memcpy(one, at, (size_t)(p - at));
        one[p - at] = 0;
        const float since = ms - i * 45.f;
        const float a = since <= 0 ? 0.f : (since >= a_in ? 1.f : ease_out_cubic(since / a_in));
        const float rise = 10.f * (1.f - a);
        ut_fx(&UT_MB, s_cap.react_x, ty + UT_MB.em * scale * 0.5f + rise, one, scale, 0.f, w->ink,
              (int)(a * a_all), true);
        ty += UT_MB.em * scale;
        i++;
      }
      break;
    }
    case RS_TINY: {
      /* Small, in the corner, said once. Right-aligned to the margin. */
      const float wdt = (float)ut_w(&UT_S, w->text);
      ut_fx(&UT_S, s_cap.react_x - wdt * 0.5f, s_cap.react_y + UT_S.em * 0.5f, w->text, 1.f, 0.f, w->ink, 255, true);
      break;
    }
    case RS_HUGE: {
      /* Taller than the frame is meant for, and cut by its left edge: the
       * word is bigger than the screen, not fitted to it. Enters a little
       * from the left, leaves by fading. */
      const float in_ms = 160.f, out_ms = 150.f;
      if (ms < in_ms) dx = -40.f * (1.f - ease_out_quint(ms / in_ms));
      else if (ms > dur - out_ms) alpha = 255.f * (1.f - ease_in_quart((ms - (dur - out_ms)) / out_ms));
      const float wdt = (float)ut_w(&UT_MB, w->text) * scale;
      ut_fx(&UT_MB, s_cap.react_x + wdt * 0.5f + dx, s_cap.react_y, w->text, scale, 0.f, w->ink, (int)alpha, true);
      break;
    }
  }
}

/* What can be touched on the finder: the title band (the shell's IT_HDR),
 * and the two words on the reading line that are decisions - while the line
 * is showing. */
#define SH_IT_MODE 1
#define SH_IT_FLASH 2
static int s_sh_mode_x0, s_sh_mode_x1, s_sh_flash_x0, s_sh_flash_x1;

/*
 * The finder at rest is the picture. The mode's name and the reading line -
 * how it will shoot - are shown when there is a reason to read them: on
 * entering the mode, on a touch, on a change; they hold for a moment and let
 * go. Four small marks in the corner stay, one per camera, lit when it is
 * answering: the one persistent thing, because it is the one fact that can
 * change under you without anything else moving.
 */
#define SH_SHOW_FIRST_MS 2600 /* the first time this boot: long enough to learn the line */
#define SH_SHOW_MS 1600       /* after that: a glance */
#define SH_FADE_MS 320
static int64_t s_sh_reveal_us;
static int s_sh_show_ms = SH_SHOW_FIRST_MS;

/** Something happened that deserves the words: show them, from now. */
static void sh_reveal(void) { s_sh_reveal_us = esp_timer_get_time(); }

/** 255 while the words are shown, easing to 0 after; counts as live while fading. */
static int sh_words_alpha(void) {
  if (s_sh_reveal_us == 0) return 0;
  const int64_t ms = (esp_timer_get_time() - s_sh_reveal_us) / 1000;
  if (ms < s_sh_show_ms) return 255;
  if (ms >= s_sh_show_ms + SH_FADE_MS) return 0;
  s_mo_live_count++;
  return (int)(255.f * (1.f - ease_in_quart((float)(ms - s_sh_show_ms) / SH_FADE_MS)));
}

static const char *const FLASH_JP[3] = {"自動", "発光", "なし"};
static void fl_current(char *num, size_t ncap, char *jp, size_t jcap, char *en, size_t ecap, char *id_out,
                       size_t idcap);

static void sh_pane_rect(int cam, int *x, int *y) {
  *x = (cam % 2) * SH_PANE_W;
  *y = (cam / 2) * SH_PANE_H;
}

/* Scaled to fill and cropped, rather than fitted and bordered.
 *
 * The source row and column for every destination pixel are fixed by four
 * compile-time constants, so they are worked out once into a pair of tables
 * instead of a multiply and a divide per pixel. Four panes of 400x240 is
 * 384 000 pixels a frame, and the finder redraws several times a second.
 * The tables are 1280 bytes together and the arithmetic is unchanged, so the
 * output is the same pixels as before, one for one. */
static uint16_t s_sh_xmap[SH_PANE_W];
static uint16_t s_sh_ymap[SH_PANE_H];
static bool s_sh_map_built;

static void sh_build_maps(void) {
  const int span = VF_H - 2 * SH_CROP;
  for (int y = 0; y < SH_PANE_H; y++) s_sh_ymap[y] = (uint16_t)(SH_CROP + y * span / SH_PANE_H);
  for (int x = 0; x < SH_PANE_W; x++) s_sh_xmap[x] = (uint16_t)(x * VF_W / SH_PANE_W);
  s_sh_map_built = true;
}

static void sh_blit(const uint16_t *tile, int px, int py) {
  if (!s_sh_map_built) sh_build_maps();
  for (int y = 0; y < SH_PANE_H; y++) {
    const uint16_t *src = tile + (size_t)s_sh_ymap[y] * VF_W;
    uint16_t *dst = s_cv + (size_t)(py + y) * UI_W + px;
    for (int x = 0; x < SH_PANE_W; x++) dst[x] = src[s_sh_xmap[x]];
  }
}

/**
 * The same blit with the landing on it: a crop-zoom into the pane's centre
 * (zoom >= 1) and a lift added to every channel (0..31) - the result arriving
 * a little large and bright and settling. Two per-frame tables and one
 * saturating add per pixel, so it costs the plain blit plus a few cycles, and
 * it runs only for the ~200 ms the landing lasts.
 */
static void sh_blit_fx(const uint16_t *tile, int px, int py, float zoom, int lift) {
  if (zoom <= 1.001f && lift <= 0) { sh_blit(tile, px, py); return; }
  static uint16_t xm[SH_PANE_W], ym[SH_PANE_H];
  const float span_y = (VF_H - 2 * SH_CROP) / zoom, span_x = VF_W / zoom;
  const float y0 = (VF_H - span_y) * 0.5f, x0 = (VF_W - span_x) * 0.5f;
  for (int y = 0; y < SH_PANE_H; y++) ym[y] = (uint16_t)(y0 + y * span_y / SH_PANE_H);
  for (int x = 0; x < SH_PANE_W; x++) xm[x] = (uint16_t)(x0 + x * span_x / SH_PANE_W);
  const int lr = lift, lg = lift * 2, lb = lift;
  for (int y = 0; y < SH_PANE_H; y++) {
    const uint16_t *src = tile + (size_t)ym[y] * VF_W;
    uint16_t *dst = s_cv + (size_t)(py + y) * UI_W + px;
    for (int x = 0; x < SH_PANE_W; x++) {
      const uint16_t p = src[xm[x]];
      if (lift <= 0) { dst[x] = p; continue; }
      int r = ((p >> 11) & 31) + lr, g = ((p >> 5) & 63) + lg, b = (p & 31) + lb;
      if (r > 31) r = 31;
      if (g > 63) g = 63;
      if (b > 31) b = 31;
      dst[x] = (uint16_t)((r << 11) | (g << 5) | b);
    }
  }
}

/* The finder names the look the way FILTER does, through fl_current(), which
 * lives with the look plumbing below; one lookup, so two screens cannot
 * disagree about which look is loaded. */
static bool look_current_id(char *out, size_t cap);

/**
 * SHOOT: four streams, a way back, and how the next photograph will be taken.
 *
 * The decisions are made on LOOK - mode, flash, which look - because choosing
 * is not part of seeing. But a viewfinder that cannot tell you what it is set
 * to makes you leave it to check, which is worse than a 34 px bar. So the
 * finder states them and changes none of them: everything on the strip is a
 * reading, and the only thing on this screen that can be pressed is the way
 * out.
 *
 * Nothing on the strip is invented. Mode and flash are the config fields LOOK
 * writes, the look is the string LOOK's picker shows, and the count is the
 * panes that decoded a frame this pass - the same fact that decided whether
 * each quarter got a picture or a reason.
 */

static void draw_shoot(void) {
  int live = 0;
  const float zoom = cap_zoom();
  const int lift = cap_lift();
  /* The immediate response: the shutter pass paints white, the next black,
   * before a single byte has come back. Two flat fills, then the frozen
   * finder (viewfinder_hold has the tiles) with the four-camera event on it. */
  const int64_t shut_ms = s_cap.armed ? cap_since_ms(s_cap.t0_us) : -1;
  if (shut_ms >= 0 && shut_ms < 90) {
    fill(0, 0, UI_W, UI_H, shut_ms < 35 ? RGB(0xff, 0xff, 0xff) : RGB(0x00, 0x00, 0x00));
    s_mo_live_count++;
    return;
  }
  bool has[4] = {false, false, false, false};
  for (int i = 0; i < 4; i++) {
    int px, py;
    sh_pane_rect(i, &px, &py);

    const uint16_t *tile = viewfinder_ready() ? viewfinder_tile(i) : NULL;
    vf_status_t st = {0};
    if (viewfinder_ready()) viewfinder_status(i, &st);

    if (tile != NULL) {
      sh_blit_fx(tile, px, py, zoom, lift);
      /* Counted here rather than from viewfinder_status(): what the strip
       * reports is what the screen is showing. A pane with pixels on it is a
       * camera that answered, whatever the status word says a moment later. */
      live++;
      has[i] = true;
      continue;
    }

    /* No pixels. Which camera, and quietly why - a black quarter could mean
     * any of several things, and this is the one state where the screen has
     * nothing better to show. */
    fill(px, py, SH_PANE_W, SH_PANE_H, C_GROUND);
    char n[2] = {(char)('1' + i), 0};
    const char *why = st.state == VF_ERROR ? "画像なし" : st.state == VF_STALLED ? "更新なし" : "カメラなし";
    ut_mid(&UT_M, px + SH_PANE_W / 2, py + SH_PANE_H / 2 - 30, n, RGB(0x3a, 0x42, 0x4c));
    ut_mid(&UT_S, px + SH_PANE_W / 2, py + SH_PANE_H / 2 + 8, why, RGB(0x3a, 0x42, 0x4c));
  }
  s_live_cams = live;

  /* ---- the words, while they are wanted ---- */
  const int wa = sh_words_alpha();
  draw_header_a(SCR_SHOOT, true, wa);
  if (wa > 0) {
    /* How it will shoot: mode, look, flash. Three words on one line, the
     * first and last of them decisions you can take here. */
    char num[16], jp[LOOK_TEXT_MAX + 4], en[LOOK_TEXT_MAX + 4], look[LOOK_TEXT_MAX + 24];
    fl_current(num, sizeof num, jp, sizeof jp, en, sizeof en, NULL, 0);
    snprintf(look, sizeof look, "%s %s", num, jp);
    const char *mode_w = mode_is_quad() ? "QUAD" : "WIGGLE";
    char flash_w[32];
    snprintf(flash_w, sizeof flash_w, "フラッシュ %s", FLASH_JP[flash_index()]);
    const int top = UI_H - 24 - UT_M.em;
    const int gap = 28;
    int x = HDR_X;
    s_sh_mode_x0 = x;
    x = ut_draw_a(&UT_M, x, top, mode_w, HDR_INK, wa);
    s_sh_mode_x1 = x;
    x += gap;
    x = ut_draw_a(&UT_M, x, top, look, HDR_DIM, wa);
    x += gap;
    s_sh_flash_x0 = x;
    x = ut_draw_a(&UT_M, x, top, flash_w, HDR_INK, wa);
    s_sh_flash_x1 = x;
    /* A pressed word takes a line under it, the acknowledgement. */
    if (s_pressed == SH_IT_MODE) fill(s_sh_mode_x0, top + UT_M.em + 2, s_sh_mode_x1 - s_sh_mode_x0, 2, C_INK);
    if (s_pressed == SH_IT_FLASH) fill(s_sh_flash_x0, top + UT_M.em + 2, s_sh_flash_x1 - s_sh_flash_x0, 2, C_INK);
  } else {
    s_sh_mode_x0 = s_sh_mode_x1 = s_sh_flash_x0 = s_sh_flash_x1 = -1000;
  }

  /* ---- the four marks, always ---- */
  if (!s_cap.armed) {
    const float cy = UI_H - 24.f - 5.f, x0 = UI_W - 24.f - 3 * 18.f - 5.f;
    for (int i = 0; i < 4; i++) {
      disc(x0 + i * 18.f + 1.5f, cy + 1.5f, 5.f, 0x0841, 120);
      disc(x0 + i * 18.f, cy, has[i] ? 5.f : 3.f, has[i] ? C_INK : RGB(0x80, 0x88, 0x94), has[i] ? 230 : 200);
    }
  }

  /* ---- the capture, when there is one ---- */
  draw_cap_marks(UI_H - 60, true);
  draw_cap_reaction();
}

/* ------------------------------------------------------------------ */
/* Look                                                                */
/* ------------------------------------------------------------------ */

/* COLOUR and B&W are real: SlotColorMode is 'recipe' | 'mono' in the wire
 * contract, the value persists, and it is stamped into META.JSON. What the
 * camera does NOT do is apply it - there is no grading anywhere in the
 * firmware - so the screen says where it is applied instead of implying the
 * preview will change. */
static bool look_is_mono(void) {
  return strcmp(config_str("quad.slots.cam1.colorMode", "recipe"), "mono") == 0;
}

static void look_set_mono(bool mono) {
  static const char *const CAMS[4] = {"cam1", "cam2", "cam3", "cam4"};
  char path[64];
  for (int i = 0; i < 4; i++) {
    snprintf(path, sizeof path, "quad.slots.%s.colorMode", CAMS[i]);
    cfg_set_str(path, mono ? "mono" : "recipe");
  }
}

/* Which camera the picker writes to, in QUAD. 0 is ALL, 1..4 are cam1..cam4.
 * Not persisted: it is a question about the next press, not a setting. */
static int s_look_target;

static const char *const LK_CAMS[4] = {"cam1", "cam2", "cam3", "cam4"};

static void look_slot_path(char *out, size_t cap, int cam /* 1..4 */) {
  snprintf(out, cap, "quad.slots.%s.recipeId", LK_CAMS[cam - 1]);
}

/**
 * The look id the picker is showing.
 *
 * False means there is no single answer: QUAD with target ALL and four slots
 * that do not agree. Saying MIXED there is the honest reading - claiming
 * cam1's look for all four would misdescribe three cameras.
 */
static bool look_current_id(char *out, size_t cap) {
  if (!mode_is_quad()) {
    config_str_copy("wiggle.recipeId", out, cap);
    return true;
  }
  char path[48];
  if (s_look_target > 0) {
    look_slot_path(path, sizeof path, s_look_target);
    config_str_copy(path, out, cap);
    return true;
  }
  look_slot_path(path, sizeof path, 1);
  config_str_copy(path, out, cap);
  for (int i = 2; i <= 4; i++) {
    char other[KDP_RECIPE_ID_MAX];
    look_slot_path(path, sizeof path, i);
    config_str_copy(path, other, sizeof other);
    if (strcmp(other, out) != 0) return false;
  }
  return true;
}

/* Where a chosen look lands. WIGGLE has one look; QUAD has one per camera,
 * and ALL writes every slot AND the wiggle field so switching back to WIGGLE
 * does not silently revert what was just chosen. */
static void look_apply(const char *id) {
  if (!mode_is_quad()) {
    cfg_set_str("wiggle.recipeId", id);
    return;
  }
  char path[48];
  if (s_look_target > 0) {
    look_slot_path(path, sizeof path, s_look_target);
    cfg_set_str(path, id);
    return;
  }
  for (int i = 1; i <= 4; i++) {
    look_slot_path(path, sizeof path, i);
    cfg_set_str(path, id);
  }
  cfg_set_str("wiggle.recipeId", id);
}

static void look_step(int delta) {
  const int n = kdp_recipes_count();
  if (n <= 0) {
    toast("ルックなし");
    return;
  }
  char cur[KDP_RECIPE_ID_MAX];
  const bool single = look_current_id(cur, sizeof cur);

  int at = -1;
  if (single) {
    for (int i = 0; i < n; i++) {
      char id[KDP_RECIPE_ID_MAX];
      if (kdp_recipes_name(i, id, sizeof id, NULL, 0) && strcmp(id, cur) == 0) {
        at = i;
        break;
      }
    }
  }
  /* MIXED, or a look this camera does not have, enters the list at an end
   * rather than staying put: an arrow that does nothing reads as a dead
   * control. */
  const int next = at < 0 ? (delta > 0 ? 0 : n - 1) : (((at + delta) % n) + n) % n;

  char id[KDP_RECIPE_ID_MAX], name[KDP_RECIPE_NAME_MAX];
  if (!kdp_recipes_name(next, id, sizeof id, name, sizeof name)) return;
  look_apply(id);
}

/* ---- what the selected look actually does -------------------------------
 *
 * The picker used to be `< PARTY NEG >` and nothing else: eleven factory looks
 * plus up to twenty-four custom ones, cycled blind, with a caption underneath
 * saying the choice did not reach the camera at all. Since 0.4.9 it does
 * (contract D19), so the screen shows the five numbers that go to the sensor
 * and where in the list you are - which is also the difference between cycling
 * a list and choosing from one.
 */

/**
 * One column of the detail strip: a value over its label.
 *
 * `set` is the look's `has_` flag, and it is not cosmetic. Every one of these
 * fields has a real zero - denoise 0 is denoise off, sharpness 0 is neutral,
 * 0.0 EV is the metered exposure - so a look that does not set a knob cannot be
 * drawn as a zero without saying something false about the photograph. It says
 * NOT SET, and NOT SET means the mode's own value stays where it was, which is
 * exactly what an absent field means on the wire.
 */
/* ------------------------------------------------------------------ */
/* FILTER (色): the picture, and the preset it will be taken with         */
/*                                                                     */
/* Full-bleed live picture from the finder camera; bottom left, the     */
/* preset's number and name; nothing else unless the mode needs it.    */
/* The left half of the picture steps back, the right half forward, and */
/* each change has a transition of its own kind - a wipe, a flick, a    */
/* hard cut, a moment of RGB separation - short enough to be felt more  */
/* than watched. The preview is not graded on the device (the look's    */
/* five numbers reach the sensor at capture, D19), so the transition is */
/* the honest thing that changes when the preset does.                  */
/* ------------------------------------------------------------------ */

#define FL_IT_PREV 0   /* left half of the picture */
#define FL_IT_NEXT 1   /* right half */
#define FL_IT_MONO 2   /* 白黒 */
#define FL_IT_TARGET 3 /* 3..7: ALL, 1..4 - QUAD only */
#define FL_IT_COUNT 8

/* The factory looks, named in the camera's own language. A custom look
 * keeps the name it was given. */
static const struct { const char *id; const char *jp; } LOOK_JP[] = {
    {"party-neg", "パーティ"}, {"chrome", "クローム"},   {"superia", "スペリア"},  {"vivid", "ビビッド"},
    {"mono", "白黒"},         {"motion", "モーション"}, {"flash-digi", "フラッシュ"}, {"warm-2007", "２００７"},
    {"cold-flash", "コールド"}, {"disposable", "使い捨て"}, {"raw-digi", "生"},
};

typedef enum { FX_NONE = 0, FX_WIPE, FX_FLICK, FX_CUT, FX_RGB } fl_fx_t;

typedef struct {
  fl_fx_t fx;
  int dir;             /* +1 forward, -1 back: the wipe's direction */
  mo_tl_t tl;
  /* The identifier block moving: outgoing and incoming, like the header. */
  bool moving;
  mo_obj_t in_o, out_o;
  char out_num[16], out_jp[LOOK_TEXT_MAX + 4];
  int64_t last_us;
} fl_state_t;
static fl_state_t s_fl;

/* Which transition a look gets. Its character, not a random draw: a hard cut
 * for the ungraded one, a flick for the flash looks, separation for motion,
 * a wipe for the rest (mono's from the top, others in the direction of travel). */
static fl_fx_t fl_fx_for(const char *id) {
  if (strcmp(id, "raw-digi") == 0) return FX_CUT;
  if (strcmp(id, "flash-digi") == 0 || strcmp(id, "cold-flash") == 0) return FX_FLICK;
  if (strcmp(id, "motion") == 0) return FX_RGB;
  return FX_WIPE;
}
static int fl_fx_ms(fl_fx_t fx) {
  switch (fx) {
    case FX_WIPE: return 160;
    case FX_FLICK: return 60;
    case FX_CUT: return 60;
    case FX_RGB: return 110;
    default: return 0;
  }
}

/** The look's number in the list (1-based) and its two names. */
static void fl_current(char *num, size_t ncap, char *jp, size_t jcap, char *en, size_t ecap, char *id_out,
                       size_t idcap) {
  char cur[KDP_RECIPE_ID_MAX];
  const bool single = look_current_id(cur, sizeof cur);
  if (id_out) snprintf(id_out, idcap, "%s", single ? cur : "");
  if (!single) {
    snprintf(num, ncap, "C--");
    snprintf(jp, jcap, "混合");
    snprintf(en, ecap, "MIXED");
    return;
  }
  const int n = kdp_recipes_count();
  int at = -1;
  char name[KDP_RECIPE_NAME_MAX] = "";
  for (int i = 0; i < n; i++) {
    char id[KDP_RECIPE_ID_MAX];
    if (kdp_recipes_name(i, id, sizeof id, name, sizeof name) && strcmp(id, cur) == 0) { at = i; break; }
  }
  snprintf(num, ncap, at >= 0 ? "C%02d" : "C??", at + 1);
  const char *jpn = NULL;
  for (size_t i = 0; i < sizeof LOOK_JP / sizeof LOOK_JP[0]; i++)
    if (strcmp(LOOK_JP[i].id, cur) == 0) jpn = LOOK_JP[i].jp;
  snprintf(jp, jcap, "%s", jpn ? jpn : (name[0] ? name : cur));
  snprintf(en, ecap, "%s", name[0] ? name : cur);
  upcase(en);
}

/** Step the preset and start its transition. */
static void fl_change(int dir) {
  char num[16], jp[LOOK_TEXT_MAX + 4], en[LOOK_TEXT_MAX + 4], id[KDP_RECIPE_ID_MAX];
  fl_current(num, sizeof num, jp, sizeof jp, en, sizeof en, id, sizeof id);
  snprintf(s_fl.out_num, sizeof s_fl.out_num, "%s", num);
  snprintf(s_fl.out_jp, sizeof s_fl.out_jp, "%s", jp);
  look_step(dir);
  fl_current(num, sizeof num, jp, sizeof jp, en, sizeof en, id, sizeof id);
  const int64_t now = esp_timer_get_time();
  s_fl.fx = fl_fx_for(id);
  s_fl.dir = dir;
  mo_tl_start(&s_fl.tl, now, fl_fx_ms(s_fl.fx), 0);
  /* The identifier: the old one leaves against the direction of travel, the
   * new one arrives from it, 26 px of travel - a step, not a slide. */
  if (!s_fl.moving) mo_obj_place(&s_fl.out_o, 0.f, 0.f);
  else s_fl.out_o = s_fl.in_o;
  s_fl.moving = true;
  s_fl.last_us = now;
  mo_to(&s_fl.out_o.x, -dir * 26.f);
  mo_to(&s_fl.out_o.alpha, 0.f);
  mo_obj_go(&s_fl.out_o, now);
  mo_obj_place(&s_fl.in_o, dir * 26.f, 0.f);
  mo_set(&s_fl.in_o.alpha, 0.f);
  mo_to(&s_fl.in_o.x, 0.f);
  mo_to(&s_fl.in_o.alpha, 255.f);
  mo_obj_go(&s_fl.in_o, now);
  s_mo_live_count++;
}

/* The full-screen preview: 320x240 cropped to 5:3 and scaled 2.5x by
 * nearest neighbour, through two tables built once. */
static uint16_t s_fl_xmap[UI_W];
static uint16_t s_fl_ymap[UI_H];
static bool s_fl_maps;
static void fl_build_maps(void) {
  const int crop = (VF_H - (VF_W * UI_H / UI_W)) / 2; /* 24 */
  const int span = VF_H - 2 * crop;
  for (int y = 0; y < UI_H; y++) s_fl_ymap[y] = (uint16_t)(crop + y * span / UI_H);
  for (int x = 0; x < UI_W; x++) s_fl_xmap[x] = (uint16_t)(x * VF_W / UI_W);
  s_fl_maps = true;
}

/** The picture, with whatever the current transition does to it. */
static void fl_blit(const uint16_t *tile) {
  if (!s_fl_maps) fl_build_maps();
  const int64_t now = esp_timer_get_time();
  const bool live = mo_tl_running(&s_fl.tl, now);
  const float t = live ? mo_tl_at(&s_fl.tl, now) : 1.f;
  const fl_fx_t fx = live ? s_fl.fx : FX_NONE;

  if (fx == FX_FLICK && t < 0.6f) { fill(0, 0, UI_W, UI_H, RGB(0xff, 0xff, 0xff)); return; }
  if (fx == FX_CUT && t < 0.7f) { fill(0, 0, UI_W, UI_H, RGB(0x00, 0x00, 0x00)); return; }

  if (tile == NULL) {
    fill(0, 0, UI_W, UI_H, HDR_GROUND);
    return;
  }
  if (fx == FX_RGB) {
    /* Red from a little to one side, blue from the other, closing to zero. */
    const int d = (int)(7.f * (1.f - ease_out_cubic(t)));
    for (int y = 0; y < UI_H; y++) {
      const uint16_t *src = tile + (size_t)s_fl_ymap[y] * VF_W;
      uint16_t *dst = s_cv + (size_t)y * UI_W;
      for (int x = 0; x < UI_W; x++) {
        int xr = x + d, xb = x - d;
        if (xr >= UI_W) xr = UI_W - 1;
        if (xb < 0) xb = 0;
        const uint16_t g = src[s_fl_xmap[x]], r = src[s_fl_xmap[xr]], b = src[s_fl_xmap[xb]];
        dst[x] = (uint16_t)((r & 0xf800) | (g & 0x07e0) | (b & 0x001f));
      }
    }
    return;
  }
  for (int y = 0; y < UI_H; y++) {
    const uint16_t *src = tile + (size_t)s_fl_ymap[y] * VF_W;
    uint16_t *dst = s_cv + (size_t)y * UI_W;
    for (int x = 0; x < UI_W; x++) dst[x] = src[s_fl_xmap[x]];
  }
  if (fx == FX_WIPE) {
    /* A band of light 110 px wide crossing the picture in the direction of
     * travel; a mono look's comes down from the top instead. */
    const bool vertical = strcmp(s_fl.out_jp, "") == 0 ? false : false;
    (void)vertical;
    const float k = ease_out_cubic(t);
    const int band = 110;
    const int x0 = s_fl.dir > 0 ? (int)(-band + (UI_W + band) * k) : (int)(UI_W - (UI_W + band) * k);
    for (int y = 0; y < UI_H; y++) {
      uint16_t *dst = s_cv + (size_t)y * UI_W;
      for (int x = x0 < 0 ? 0 : x0; x < x0 + band && x < UI_W; x++) {
        const uint16_t p = dst[x];
        int r = ((p >> 11) & 31) + 9, g = ((p >> 5) & 63) + 18, b = (p & 31) + 9;
        if (r > 31) r = 31;
        if (g > 63) g = 63;
        if (b > 31) b = 31;
        dst[x] = (uint16_t)((r << 11) | (g << 5) | b);
      }
    }
  }
}

/* The identifier: the number and the name, the bold face at twice its size,
 * bottom left over the picture. Nothing under it - what the preset does is
 * what the picture shows. */
#define FL_ID_X 24
#define FL_ID_SCALE 2.f
#define FL_ID_Y (UI_H - 24 - 68)

static void fl_draw_id_at(float dx, int alpha, uint16_t ink, const char *num, const char *jp) {
  const float y = FL_ID_Y + UT_MB.em * FL_ID_SCALE * 0.5f;
  const float nw = (float)ut_w(&UT_MB, num) * FL_ID_SCALE;
  ut_fx(&UT_MB, FL_ID_X + dx + nw / 2.f, y, num, FL_ID_SCALE, 0.f, ink, alpha, true);
  const float jw = (float)ut_w(&UT_MB, jp) * FL_ID_SCALE;
  ut_fx(&UT_MB, FL_ID_X + dx + nw + 28.f + jw / 2.f, y, jp, FL_ID_SCALE, 0.f, ink, alpha, true);
}

/* The words that act: 白黒 at the foot's right, and in QUAD, on the header's
 * line at the right, which camera the next choice lands on. One layout for
 * the draw and the hit test. */
typedef struct { int x0, x1; } span_t;
#define FL_FOOT_TOP (UI_H - 24 - 34)
#define FL_TARGET_TOP HDR_Y
static void fl_spans(span_t *mono, span_t targets[5]) {
  static const char *const T[5] = {"ALL", "1", "2", "3", "4"};
  mono->x1 = UI_W - 24;
  mono->x0 = mono->x1 - ut_w(&UT_M, "白黒");
  int right = UI_W - 24;
  for (int i = 4; i >= 0; i--) {
    targets[i].x1 = right;
    targets[i].x0 = right - ut_w(&UT_M, T[i]);
    right = targets[i].x0 - 26;
  }
}

static void draw_look(void) {
  const int vcam = 0;
  {
    /* The finder camera, as SHOOT reads it. */
    const char *v = config_str("shoot.viewfinder", "cam2");
    (void)vcam;
    int cam = (v[3] >= '1' && v[3] <= '4') ? v[3] - '1' : 1;
    const uint16_t *tile = viewfinder_ready() ? viewfinder_tile(cam) : NULL;
    fl_blit(tile);
  }
  draw_header_at(SCR_LOOK, true);

  char num[16], jp[LOOK_TEXT_MAX + 4], en[LOOK_TEXT_MAX + 4], id[KDP_RECIPE_ID_MAX];
  fl_current(num, sizeof num, jp, sizeof jp, en, sizeof en, id, sizeof id);

  /* The identifier, moving when it has just changed. */
  if (s_fl.moving) {
    const int64_t now = esp_timer_get_time();
    const float dt = (float)(now - s_fl.last_us) / 1000.f;
    s_fl.last_us = now;
    bool live = false;
    live |= mo_obj_step(&s_fl.out_o, now, dt, MO_SNAP);
    live |= mo_obj_step(&s_fl.in_o, now, dt, MO_BOUNCE);
    if (!live) s_fl.moving = false;
    /* Cobalt while it moves, ink once it has landed: colour as the event. */
    const int k = (int)s_fl.in_o.alpha.v;
    fl_draw_id_at(s_fl.out_o.x.v, (int)s_fl.out_o.alpha.v, C_INK, s_fl.out_num, s_fl.out_jp);
    fl_draw_id_at(s_fl.in_o.x.v, k, mix(C_COBALT, C_INK, k > 255 ? 255 : k), num, jp);
  } else {
    fl_draw_id_at(0.f, 255, C_INK, num, jp);
  }

  (void)en;
  (void)id;

  /* 白黒, and in QUAD which camera the next choice lands on. Words, not
   * boxes: lit when live, dim when not, a line under the live one. */
  {
    span_t mono, tg[5];
    fl_spans(&mono, tg);
    const bool is_mono = look_is_mono();
    ut_fx(&UT_M, (mono.x0 + mono.x1) * 0.5f, FL_FOOT_TOP + UT_M.em * 0.5f, "白黒", 1.f, 0.f, is_mono ? C_INK : HDR_DIM, 255, true);
    if (is_mono) fill(mono.x0, FL_FOOT_TOP + UT_M.em + 2, mono.x1 - mono.x0, 2, C_INK);
    if (mode_is_quad()) {
      static const char *const T[5] = {"ALL", "1", "2", "3", "4"};
      for (int i = 0; i < 5; i++) {
        const bool on = s_look_target == i;
        ut_fx(&UT_M, (tg[i].x0 + tg[i].x1) * 0.5f, FL_TARGET_TOP + UT_M.em * 0.5f, T[i], 1.f, 0.f, on ? C_INK : HDR_DIM, 255, true);
        if (on) fill(tg[i].x0, FL_TARGET_TOP + UT_M.em + 2, tg[i].x1 - tg[i].x0, 2, C_INK);
      }
    }
  }
}

#define G_COLS GALLERY_COLS
#define G_TILE_W GALLERY_TILE_W
#define G_TILE_H GALLERY_TILE_H
#define G_GAP 14
#define G_X0 ((UI_W - (G_COLS * G_TILE_W + (G_COLS - 1) * G_GAP)) / 2)   /* 8 */
#define G_Y0 (BODY_Y + 8)                                               /* 71 */
#define G_PITCH (G_TILE_H + G_GAP)                                      /* 203 */
/* Items 0..5 are the tiles; the pages turn on a vertical swipe. */
_Static_assert(G_Y0 + G_PITCH + G_TILE_H <= UI_H, "the bottom row runs off the screen");

static void gal_origin(int slot, int *x, int *y) {
  *x = G_X0 + (slot % G_COLS) * (G_TILE_W + G_GAP);
  *y = G_Y0 + (slot / G_COLS) * G_PITCH;
}

/* The grid's vertical offset while a page turns: the old page slides out and
 * the new one in along the same spring. */
static mo_val_t s_gal_dy;
static int64_t s_gal_last_us;
static int s_gal_from_page = -1; /* the page that is leaving, -1 when settled */

/** Blit a tile at (x, y), clipped to the client area; `inset` shrinks it by that many px a side (a press). */
static void gal_blit_at(const uint16_t *px, int x, int y, int inset) {
  const int w = G_TILE_W - 2 * inset, h = G_TILE_H - 2 * inset;
  for (int r = 0; r < h; r++) {
    const int dy = y + inset + r;
    if (dy < HEAD_H || dy >= UI_H) continue;
    const uint16_t *src = px + (size_t)(inset ? r * G_TILE_H / h : r) * G_TILE_W;
    uint16_t *dst = s_cv + (size_t)dy * UI_W + x + inset;
    if (inset == 0) {
      memcpy(dst, src, (size_t)w * sizeof(uint16_t));
    } else {
      for (int c = 0; c < w; c++) dst[c] = src[c * G_TILE_W / w];
    }
  }
}

/** Turn the page with the grid sliding: +1 up (next), -1 down (previous). */
static void gal_turn(int dir) {
  const int pages = gallery_pages();
  const int page = gallery_page();
  if ((dir > 0 && page >= pages - 1) || (dir < 0 && page <= 0)) return;
  s_gal_from_page = page;
  gallery_turn(dir);
  mo_launch(&s_gal_dy, (float)(dir * (UI_H - HEAD_H)), 0.f, -dir * 0.6f);
  s_gal_last_us = esp_timer_get_time();
  s_mo_live_count++;
}

/** One tile's marks: a yellow dot for a favourite, the count only when frames are missing. */
static void gal_marks(const gallery_item_t *it, int x, int y) {
  if (it->favorite) {
    disc(x + G_TILE_W - 16.f + 1.5f, y + 16.f + 1.5f, 6.f, 0x0841, 150);
    disc(x + G_TILE_W - 16.f, y + 16.f, 6.f, C_YELLOW, 255);
  }
  if (it->partial) {
    char n[16];
    snprintf(n, sizeof n, "%d/4", it->frames);
    ut_fx(&UT_S, x + 10.f + ut_w(&UT_S, n) / 2.f, y + G_TILE_H - 10.f - UT_S.em / 2.f, n, 1.f, 0.f, C_YELLOW, 255, true);
  }
}

static void draw_gallery(void) {
  fill(0, 0, UI_W, UI_H, HDR_GROUND);
  storage_status_t sd;
  storage_get_status(&sd);
  const int total = gallery_total();

  if (total == 0) {
    const bool counting = sd.mounted && gallery_loading();
    const int walked = gallery_scan_progress();
    char h1[48];
    if (!sd.mounted) snprintf(h1, sizeof h1, "カードなし");
    else if (counting && walked > 0) snprintf(h1, sizeof h1, "読込中 %d", walked);
    else if (counting) snprintf(h1, sizeof h1, "読込中");
    else snprintf(h1, sizeof h1, "写真なし");
    const char *h2 = !sd.mounted ? "カードを入れて" : counting ? "" : "シャッターを押して";
    ut_fx(&UT_MB, UI_W / 2.f, UI_H / 2.f - 12.f, h1, 1.5f, 0.f, C_INK, 255, false);
    if (h2[0]) ut_mid(&UT_S, UI_W / 2, UI_H / 2 + 34, h2, HDR_DIM);
    draw_header(SCR_GALLERY);
    return;
  }

  /* The slide: while a turn is in flight the grid is drawn displaced, and
   * the page it replaces is not redrawn (its tiles are already gone from the
   * slots) - the motion is the new page arriving, which is enough. */
  {
    const int64_t now = esp_timer_get_time();
    const float dt = s_gal_last_us ? (float)(now - s_gal_last_us) / 1000.f : 0.f;
    s_gal_last_us = now;
    if (!mo_spring(&s_gal_dy, dt, MO_SETTLE)) s_gal_from_page = -1;
  }
  const int dy = (int)s_gal_dy.v;

  const gallery_item_t *slots = gallery_slots();
  for (int i = 0; i < GALLERY_PAGE; i++) {
    if (slots[i].state == TILE_EMPTY) continue;
    int x, y;
    gal_origin(i, &x, &y);
    y += dy;
    if (y + G_TILE_H <= HEAD_H || y >= UI_H) continue;
    const bool down = s_pressed == i;
    if (slots[i].state == TILE_READY && slots[i].pixels) {
      gal_blit_at(slots[i].pixels, x, y, down ? 6 : 0);
    } else {
      fill(x, y < HEAD_H ? HEAD_H : y, G_TILE_W, G_TILE_H - (y < HEAD_H ? HEAD_H - y : 0), RGB(0x1a, 0x1e, 0x24));
      if (slots[i].state != TILE_PENDING) ut_mid(&UT_S, x + G_TILE_W / 2, y + G_TILE_H / 2 - UT_S.em / 2, "画像なし", HDR_DIM);
    }
    if (y >= HEAD_H) gal_marks(&slots[i], x, y);
    if (foc(SCR_GALLERY, i)) fill(x, y + G_TILE_H + 3, G_TILE_W, 2, C_INK);
  }

  draw_header(SCR_GALLERY);
  /* Where you are, in the header's right end: page n / N and the count. */
  {
    const int pages = gallery_pages();
    char pos[64];
    if (gallery_loading()) {
      const int walked = gallery_scan_progress();
      if (walked > 0) snprintf(pos, sizeof pos, "読込中 %d", walked);
      else snprintf(pos, sizeof pos, "読込中");
    } else if (pages > 1) {
      snprintf(pos, sizeof pos, "%d / %d   %d枚", gallery_page() + 1, pages, total);
    } else {
      snprintf(pos, sizeof pos, "%d枚", total);
    }
    if (!notice_live()) ut_right(&UT_M, UI_W - 24, HDR_Y, pos, HDR_DIM);
  }
}

#define P_IT_DELETE 0
#define P_IT_FAV 1
#define P_IT_ROLL 2

/*
 * Stop playing and forget the job. Safe to call at any time, from this task.
 *
 * There is no wait in it and there must not be: gallery_frames_cancel() drops
 * the job, and a decode already in flight lands in a buffer this screen has
 * stopped reading (gallery.h, the lifetime rule). A dialog opening, a
 * navigation, a DELETE and a capture all reach this, and a DELETE that took
 * two seconds to acknowledge because a decode was waiting on a busy card
 * would be a worse camera than one that shows a still.
 */
static void wiggle_stop(void) {
  if (s_wig_gen != 0) gallery_frames_cancel();
  s_wig_gen = 0;
  s_wig_have = 0;
  s_wig_play = false;
  s_wig_repeat = false;
  s_wig_oneway = false;
  s_wig_len = 0;
  s_wig_pos = 0;
  s_wig_count = 0;
  s_wig_next_us = 0;
  s_quad = false;
  s_quad_ready = false;
}

static void photo_release(void) {
  wiggle_stop();
  if (s_photo) { free(s_photo); s_photo = NULL; }
  s_photo_ok = false;
  s_photo_fav = false;
}

/* Decoded at PH_W x PH_H rather than by scaling the 252 px gallery tile:
 * thumb_load takes any target size, so there is no reason to show a
 * thumbnail blown up to most of the screen.
 *
 * Takes the card, like every other reader. This runs up to three full-res
 * hardware JPEG decodes off the SD card and it did so without going through
 * the arbiter at all, while gallery.c's scan and its tile loads both hold
 * STORAGE_USER_UI for the same bus. A decode that lands mid-capture shares
 * the SDMMC bus with four frames being written and widens the spread between
 * them, which is the one number the capture pipeline exists to keep small.
 * Same 2 s budget as the gallery.
 *
 * Returns false when the card could not be taken, so the caller can say so
 * and stay where it is. It still returns true for a decode that found no
 * readable file - that is the NO IMAGE state, which is a picture of the
 * photograph screen rather than a reason not to open it. */
static bool photo_open(const gallery_item_t *it) {
  /* The card first, before any state names the new photograph: a refused
   * acquire must leave the module describing whatever it described before,
   * with nothing allocated for a picture that was never decoded. */
  if (!storage_acquire(STORAGE_USER_UI, 2000)) return false;

  photo_release();
  snprintf(s_photo_id, sizeof s_photo_id, "%s", it->id);
  snprintf(s_photo_label, sizeof s_photo_label, "%s", it->label);
  snprintf(s_photo_mode, sizeof s_photo_mode, "%s", it->mode);
  s_photo_frames = it->frames;
  /* The gallery already read META.JSON for this tile, so the flag is taken
   * from the item rather than read off the card a second time. The screen owns
   * its own copy from here on because the toggle below changes it and the
   * gallery's slot is only refreshed on the next scan. */
  s_photo_fav = it->favorite;

  /* 64-byte aligned, because this is a PPA destination and the PPA is a DMA
   * engine: a plain heap_caps_malloc gave 4-byte alignment and every scale
   * returned ESP_ERR_INVALID_ARG, including a 1:1 one, so the gallery drew
   * nothing for every capture ever taken. viewfinder.c allocates its own
   * tiles this way already; this is the same rule, applied where it was
   * missed. */
  s_photo = heap_caps_aligned_calloc(64, 1, THUMB_TILE_BYTES(PH_W, PH_H), MALLOC_CAP_SPIRAM);
  if (s_photo == NULL) {
    storage_release(STORAGE_USER_UI);
    return true;
  }

  static const char *const TRY[3] = {"C1.JPG", "THUMB.JPG", "C2.JPG"};
  for (int i = 0; i < 3; i++) {
    char path[128];
    snprintf(path, sizeof path, "%s/%s/%s", CAPTURES_DIR, it->id, TRY[i]);
    if (thumb_load(path, s_photo, PH_W, PH_H, C_GROUND) == ESP_OK) {
      s_photo_ok = true;
      break;
    }
  }
  storage_release(STORAGE_USER_UI);

  /*
   * The rest of the wiggle, in the background, after the card is back.
   *
   * Only for a wiggle with more than one frame: a quad is four views of four
   * different framings and stepping through them is a slideshow, not a
   * parallax, and a single has nothing to step through. Both stay exactly as
   * they were, which is the requirement.
   *
   * Posted after the release rather than before it so the gallery task is not
   * queued behind a lock this task is still holding for a decode it has
   * already finished.
   *
   * C1 is decoded again by the job even though `s_photo` usually holds it.
   * That is one extra decode on a background task, and it buys the one thing
   * that matters: every frame in the swing came from the same source at the
   * same size. `s_photo` falls back to THUMB.JPG and even to C2, so reusing
   * it would put a 300 px thumbnail, or the wrong lens, into position one of
   * a swing of full-size frames - a visible pop once a cycle.
   */
  const bool wiggle = strcmp(s_photo_mode, "wiggle") == 0;
  const bool quad = strcmp(s_photo_mode, "quad") == 0;
  if ((wiggle || quad) && s_photo_frames > 1) {
    uint32_t gen = 0;
    /* A quad's four looks share the well, so each is decoded at half its size
     * and drawn in its own quadrant; the well stays 4:3 because the quadrant
     * is. No alignment for a quad - four framings of four different looks are
     * meant to differ. */
    s_quad = quad;
    const int fw = quad ? PH_W / 2 : PH_W, fh = quad ? PH_H / 2 : PH_H;
    /*
     * Where the alignment offsets come from (#161), in the order the contract
     * gives (types.ts, MEDIA_INFO `meta.calibration`):
     *
     *   1. the CAPTURE's own META.JSON block - what was true at the shutter
     *      press, which is the only honest answer for a photograph taken
     *      before the lenses were last calibrated. The gallery's single META
     *      parse already carried it here in `it->cal`.
     *   2. failing that, the live device calibration - and this body HAS none:
     *      nothing in the firmware stores per-camera offsets, and nothing
     *      writes that META block either, so every capture on every card today
     *      reaches step 3.
     *   3. all zeros, which is a clean no-op - NULL here, and the frames are
     *      placed exactly as #160 placed them. Never an invented offset: a
     *      guessed correction moves the subject to a place it never was.
     *
     * The day an align editor writes either source, the panel and the Roll's
     * baked WebP crop and shift identically, because both compute it from
     * pure_align_plan().
     */
    const pure_cam_offset_t *off =
        (wiggle && it->cal_present && pure_align_has_offset(it->cal, PURE_WIGGLE_FRAMES_MAX))
            ? it->cal
            : NULL;
    if (gallery_frames_begin(it->id, fw, fh, C_GROUND, off, &gen) == ESP_OK) s_wig_gen = gen;
  }
  return true;
}

/*
 * One pass of the player. True when the picture on screen has to change.
 *
 * Called from ui_task on every pass, which is every 20 ms, and it is the only
 * thing that moves the frame. The panel is paced by that loop rather than by a
 * timer or a spin: a 20 ms pass lands within one pass of every 66..200 ms
 * frame deadline, and the deadline is advanced by whole periods rather than
 * set from `now`, so the swing does not drift.
 *
 * Rejected: a present loop of its own, the way SCR_SHOOT presents
 * unconditionally at 60 ms. That would make the photograph screen a painter
 * whether or not anything moved - a still photograph would repaint 12 times a
 * second for as long as someone looked at it, on a battery.
 */
static bool wiggle_tick(void) {
  if (s_wig_gen == 0) return false;
  /* A quad grid that has been drawn is finished: it neither loads nor plays. */
  if (s_quad_ready) return false;

  /* Not while a dialog is up, not while a capture is running.
   *
   * The dialog is the plain one: DELETE asks a question over the picture, and
   * a picture that keeps moving under a modal is a screen that has not
   * stopped to ask. The capture is the important one: the shutter owns the
   * camera for a second or two and this is a decoration. Both PAUSE - the
   * position and the deadline are kept - so dismissing a dialog carries on
   * mid-swing rather than snapping back to frame one. */
  if (s_dialog != DLG_NONE || capture_stage() != CAPTURE_IDLE) {
    s_wig_next_us = 0;
    return false;
  }

  if (s_wig_len == 0) {
    /* Still loading. Nothing on screen changes until every frame has been
     * tried: a swing that grows from two frames to four while someone watches
     * changes speed and shape twice, which reads as a fault. */
    uint32_t have = 0;
    bool done = false;
    if (!gallery_frames_state(s_wig_gen, &have, &done) || !done) return false;

    s_wig_have = have;
    s_wig_count = 0;
    for (int i = 0; i < GALLERY_FRAME_MAX; i++) {
      if (have & (1u << i)) s_wig_count++;
    }

    if (s_quad) {
      /* A grid, not a swing: no order, no period, nothing to step. One repaint
       * replaces the still with the four looks (or the still stays, when none
       * decoded - the NO IMAGE of a quad is its still). s_wig_gen is kept so
       * photo_release cancels the finished job like any other. */
      s_quad_ready = s_wig_count > 0;
      if (!s_quad_ready) klog("P4", "quad %s: no frame decoded, showing the still", s_photo_id);
      return s_quad_ready;
    }

    /* The camera's own stored preference, not a second one invented here.
     * config_str's result is used on the next line and not kept, which is what
     * that ring is for. */
    const pure_wiggle_loop_t loop = pure_wiggle_loop(config_str("wiggle.loop", "continuous"));
    const bool rtl = pure_wiggle_direction_rtl(config_str("wiggle.direction", "ltr"));
    s_wig_len = pure_wiggle_sequence(loop, rtl, have, s_wig_seq, (int)sizeof s_wig_seq,
                                     &s_wig_repeat);
    s_wig_period_ms = pure_wiggle_period_ms(config_int("wiggle.fps", PURE_WIGGLE_FPS_DEFAULT));
    /* One-way modes snap from the far frame back to the near one, and that snap
     * is the effect; a bounce turns around instead. Kept as state because the
     * note row and future readers need to know which kind of wrap they saw. */
    s_wig_oneway = loop != PURE_WIGGLE_BOUNCE;

    if (s_wig_len < 2) {
      /*
       * Nothing to play: no frame decoded, or one. The still IS the graceful
       * answer, so there is no banner - but it is said once, here, because a
       * wiggle that will not play is either a partly-written capture or a
       * codec that stopped, and neither is visible from the outside.
       * Once per photograph, never per frame: s_wig_gen is cleared below, so
       * this branch cannot be re-entered for the same open.
       */
      klog("P4", "wiggle %s will not play: %d of 4 frames decoded", s_photo_id, s_wig_count);
      wiggle_stop();
      return false;
    }
    /* An order exists from here on, and `s_wig_len` is what says so. It stays
     * set for as long as the photograph is open, through a pause and past the
     * end of a sweep, because it is also what tells the draw to keep showing
     * the frame the swing rests on rather than snapping back to the still. */

    s_wig_play = true;
    s_wig_pos = 0;
    s_wig_next_us = esp_timer_get_time() + (int64_t)s_wig_period_ms * 1000;
    klog("P4", "wiggle %s playing %d frames at %d ms", s_photo_id, s_wig_len, s_wig_period_ms);
    /* Repaint now: the first frame of the order is not necessarily what the
     * still showed (rtl starts at C4), and the frame note appears with it. */
    return true;
  }

  /* A sweep that has run its one pass, holding its last frame. */
  if (!s_wig_play) return false;

  const int64_t now = esp_timer_get_time();
  const int64_t period_us = (int64_t)s_wig_period_ms * 1000;
  if (s_wig_next_us == 0) {
    /* Resuming from a pause. Give the frame on screen a full period rather
     * than firing immediately, or dismissing a dialog would jump the swing. */
    s_wig_next_us = now + period_us;
    return false;
  }
  if (now < s_wig_next_us) return false;

  if (s_wig_pos + 1 >= s_wig_len && !s_wig_repeat) {
    /* KDP `sweep` is media's `once` (packages/media/src/playback.ts): one pass,
     * then hold the last frame. Holding rather than snapping back to C1,
     * because the end of the sweep is where the photograph was left. */
    s_wig_play = false;
    return false;
  }
  s_wig_pos = (s_wig_pos + 1) % s_wig_len;

  /* By whole periods, so a late pass does not shorten the next frame. A deadline
   * that has fallen more than a period behind - the loop was busy with a toast
   * or a capture banner - is resynced instead of firing several times in a row
   * to catch up, which would be a stutter rather than a wiggle. */
  s_wig_next_us += period_us;
  if (s_wig_next_us < now) s_wig_next_us = now + period_us;
  return true;
}

/** The pixels the photograph screen should draw: the frame of the swing when
 * one is playing, the still otherwise. Never a buffer whose bit is clear. */
static const uint16_t *photo_pixels(void) {
  if (s_wig_len >= 2) {
    const int frame = s_wig_seq[s_wig_pos];
    if (s_wig_have & (1u << frame)) {
      const uint16_t *px = gallery_frame_pixels(frame);
      if (px != NULL) return px;
    }
  }
  return s_photo_ok ? s_photo : NULL;
}

/*
 * Flip the open photograph's favourite flag, on the card.
 *
 * The same META.JSON rewrite MEDIA_FAVORITE performs, through the same
 * function (kdp_server.h) rather than a second copy of it here - the two would
 * otherwise be free to disagree about the document's shape, and the host and
 * the body would then show different flags for the same photograph.
 *
 * Takes the card, like photo_open() and the delete: this is a write to a
 * directory a capture may be writing into. 2 s, and on a refusal nothing is
 * written and the star does not move, which is the only honest answer - a UI
 * that flips the star and loses the write is worse than one that says no.
 */
static void photo_toggle_favourite(void) {
  if (s_photo_id[0] == '\0') return;
  if (!storage_acquire(STORAGE_USER_UI, 2000)) {
    toast("カード使用中");
    audio_warning();
    return;
  }
  const bool want = !s_photo_fav;
  const esp_err_t err = media_favorite_set(s_photo_id, want);
  storage_release(STORAGE_USER_UI);
  if (err != ESP_OK) {
    /* NOT_FOUND is a capture with no META.JSON, which the gallery can show and
     * this cannot mark. One message for all of them: the user's next move is
     * the same whichever it was. */
    toast("保存できない");
    audio_warning();
    return;
  }
  s_photo_fav = want;
  klog("P4", "favourite %s %s", s_photo_id, want ? "on" : "off");
  /* So the tile behind this screen carries the mark when the user goes back.
   * The refresh is a card rescan on the gallery task, not work done here. */
  gallery_refresh();
  toast(want ? "お気に入り" : "解除");
}

static int s_ph_del_x0, s_ph_del_x1, s_ph_fav_x0, s_ph_fav_x1;

static void draw_photo(void) {
  fill(0, 0, UI_W, UI_H, HDR_GROUND);
  const int px = PH_X0, py = PH_TOP;
  const uint16_t *src = s_quad_ready ? NULL : photo_pixels();
  if (s_quad_ready) {
    const int qw = PH_W / 2, qh = PH_H / 2;
    for (int i = 0; i < GALLERY_FRAME_MAX; i++) {
      const int qx = px + (i & 1) * qw, qy = py + (i >> 1) * qh;
      const uint16_t *fp = (s_wig_have & (1u << i)) ? gallery_frame_pixels(i) : NULL;
      if (fp != NULL) {
        for (int r = 0; r < qh; r++)
          memcpy(s_cv + (size_t)(qy + r) * UI_W + qx, fp + (size_t)r * qw, (size_t)qw * sizeof(uint16_t));
      } else {
        char lens[4];
        snprintf(lens, sizeof lens, "%d", i + 1);
        fill(qx, qy, qw, qh, RGB(0x1a, 0x1e, 0x24));
        ut_mid(&UT_M, qx + qw / 2, qy + qh / 2 - UT_M.em / 2, lens, RGB(0x3a, 0x42, 0x4c));
      }
    }
    fill(px + qw - 1, py, 2, PH_H, HDR_GROUND);
    fill(px, py + qh - 1, PH_W, 2, HDR_GROUND);
  } else if (src != NULL) {
    for (int r = 0; r < PH_H; r++)
      memcpy(s_cv + (size_t)(py + r) * UI_W + px, src + (size_t)r * PH_W, (size_t)PH_W * sizeof(uint16_t));
  } else {
    fill(px, py, PH_W, PH_H, RGB(0x1a, 0x1e, 0x24));
    ut_mid(&UT_M, px + PH_W / 2, py + PH_H / 2 - UT_M.em / 2, "画像なし", HDR_DIM);
  }
  draw_header_at(SCR_PHOTO, true);

  /* The line under the picture: what it is on the left, what can be done
   * on the right. Words, lit or dim; a pressed word gets its underline. */
  const int ly = PH_LINE_Y;
  {
    /* Only what is not already in the picture: how many frames it has,
     * when that is fewer than four. The file's name is Studio's business. */
    char facts[24] = "";
    if ((s_wig_len >= 2 || s_quad_ready) && s_wig_count > 0 && s_wig_count < GALLERY_FRAME_MAX)
      snprintf(facts, sizeof facts, "%d/4", s_wig_count);
    else if (s_photo_frames > 0 && s_photo_frames < GALLERY_FRAME_MAX)
      snprintf(facts, sizeof facts, "%d/4", s_photo_frames);
    if (facts[0]) ut_draw(&UT_S, PH_X0, ly, facts, HDR_DIM);
  }
  {
    const char *fav = s_photo_fav ? "★ お気に入り" : "☆ お気に入り";
    const char *del = "削除";
    const int fw = ut_w(&UT_S, fav), dw = ut_w(&UT_S, del);
    s_ph_del_x1 = PH_X0 + PH_W;
    s_ph_del_x0 = s_ph_del_x1 - dw;
    s_ph_fav_x1 = s_ph_del_x0 - 36;
    s_ph_fav_x0 = s_ph_fav_x1 - fw;
    ut_draw(&UT_S, s_ph_fav_x0, ly, fav, s_photo_fav ? C_YELLOW : C_INK);
    ut_draw(&UT_S, s_ph_del_x0, ly, del, C_INK);
    if (s_pressed == P_IT_FAV) fill(s_ph_fav_x0, ly + UT_S.em, fw, 2, C_INK);
    if (s_pressed == P_IT_DELETE) fill(s_ph_del_x0, ly + UT_S.em, dw, 2, C_RED);
  }
}

#define QR_QUIET 4

static int draw_qr_centred(const qr_t *qr, int cx, int top, int box) {
  const int total = qr->size + 2 * QR_QUIET;
  const int pitch = box / total;
  if (pitch < 1) return 0; /* no room ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the caller shows the code as text */

  const int side = total * pitch;
  const int x0 = cx - side / 2;

  /* White ground for the symbol and its quiet zone together: full contrast,
   * whatever the screen around it is doing, because a QR on anything less
   * scans poorly from across a room. */
  fill(x0, top, side, side, RGB(0xff, 0xff, 0xff));

  const int m0 = x0 + QR_QUIET * pitch;
  const int n0 = top + QR_QUIET * pitch;
  for (int y = 0; y < qr->size; y++) {
    for (int x = 0; x < qr->size; x++) {
      if (qr_module(qr, x, y)) {
        fill(m0 + x * pitch, n0 + y * pitch, pitch, pitch, RGB(0x00, 0x00, 0x00));
      }
    }
  }
  return side;
}

/*
 * Only about Roll. The card statistics the old screen carried moved to
 * Settings > Storage, where they belong.
 *
 * Four states, and the difference between them is what a user needs:
 *
 *   no roll   ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â nothing to show, and how to get one
 *   active    ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the QR a guest scans, plus what is waiting
 *   offline   ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the same, but honest that nothing is moving
 *   paused    ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â something is wrong and retrying will not fix it
 *
 * The old screen said "NOT CONNECTED / This body has no radio fitted", which
 * was wrong on both counts: the radio IS fitted, and a Roll assigned from
 * Studio works over USB with no radio at all.
 */
/*
 * Two columns, because the panel is 800 px wide and landscape.
 *
 * The screen used to put the title, a 225 px QR and four lines of statistics
 * down a 220 px strip in the middle, leaving 290 px bare on each side. That is
 * not a stylistic complaint: the QR's module pitch IS the
 * feature. A guest scans this from wherever they happen to be standing, and
 * pitch is what decides whether that works across a room or only at arm's
 * length. Given the whole height the symbol goes from 225 px to 360 px a side -
 * a 5 px module becomes an 8 px one - and the numbers that used to be 18 px
 * grey text get the other column at a size that reads from a step back.
 *
 * Left column is the symbol and nothing else. Right column is what a host
 * wants: the roll's name, the code to type when scanning fails, what is on the
 * card, what has left it, and whether anything is moving.
 */
#define RL_M 16                                /* outer margin */
#define RL_QR_COL_W 400                        /* left column */
#define RL_TOP (BODY_Y + 12)
/* 34 px of the column's height is the SCAN TO JOIN line under the symbol. */
#define RL_QR_BOX (UI_H - RL_TOP - 34)
#define RL_QR_CX (RL_M + RL_QR_COL_W / 2)
#define RL_RX (RL_M + RL_QR_COL_W + 24)        /* right column */
#define RL_RW (UI_W - RL_M - RL_RX)

/* The symbol has to clear the panel with its caption under it. Checked rather
 * than trusted: RL_QR_BOX is the only number here that a change to HEAD_H
 * silently invalidates, and the failure mode is a QR running off the bottom. */
_Static_assert(RL_TOP + RL_QR_BOX + 18 <= UI_H, "the ROLL QR falls off the bottom");
_Static_assert(RL_RW > 300, "the ROLL right column is too narrow for its numbers");

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* SETUP (設定) and CONNECT (接続): facts and settings as rows of words    */
/*                                                                     */
/* A row is a name on the left, its value on the right, on the ground;  */
/* no well, no bevel, no plate, no rule between rows and no mark at the  */
/* end: the words are the row. A press underlines it; a row that cannot  */
/* act right now is dim.                                                 */
/* ------------------------------------------------------------------ */

#define NR_X 24
#define NR_W (UI_W - 2 * NR_X)
#define NR_Y0 (HEAD_H + 12)
#define NR_H 58
#define NR_TITLE_TOP(y) ((y) + (NR_H - 34) / 2)
#define NR_VALUE_TOP(y) ((y) + (NR_H - 22) / 2 + 3)

/* When the screen was entered, and whether for the first time this boot.
 * Set by go(). A first visit's rows arrive one after another from a little
 * to the right; a screen you have been to before is simply there - the
 * camera remembers, which is one of the small ways it is not a web page. */
static int64_t s_enter_us;
static bool s_enter_first;
static bool s_visited[SCR_COUNT];
#define ROW_ARRIVE_MS 220
#define ROW_STAGGER_MS 28

/** Row i's arrival: x offset and alpha for this pass. Settled rows cost nothing. */
static void row_arrive(int i, int *dx, int *alpha) {
  *dx = 0;
  *alpha = 255;
  if (!s_enter_first || s_enter_us == 0) return;
  const int64_t ms = (esp_timer_get_time() - s_enter_us) / 1000 - (int64_t)i * ROW_STAGGER_MS;
  if (ms >= ROW_ARRIVE_MS) return;
  s_mo_live_count++;
  if (ms <= 0) { *alpha = 0; *dx = 18; return; }
  const float k = ease_out_quint((float)ms / ROW_ARRIVE_MS);
  *dx = (int)(18.f * (1.f - k));
  *alpha = (int)(255.f * k);
}

static void nrow(int i, const char *title, const char *value, bool acts, bool enabled, bool pressed) {
  (void)acts;
  const int y = NR_Y0 + i * NR_H;
  int dx, a;
  row_arrive(i, &dx, &a);
  const uint16_t ink = enabled ? C_INK : HDR_DIM;
  ut_draw_a(&UT_M, NR_X + dx, NR_TITLE_TOP(y), title, ink, a);
  if (value && value[0])
    ut_draw_a(&UT_S, NR_X + NR_W - ut_w(&UT_S, value) + dx, NR_VALUE_TOP(y), value,
              enabled ? HDR_DIM : RGB(0x50, 0x56, 0x60), a);
  if (pressed) fill(NR_X, y + NR_H - 4, NR_W, 2, C_INK);
}
static int nrow_hit(int x, int y, int rows) {
  (void)x;
  if (y < NR_Y0 || y >= NR_Y0 + rows * NR_H) return -1;
  return (y - NR_Y0) / NR_H;
}

static const char *const SET_ROWS[5] = {"表示", "音", "カード", "電源", "情報"};
static const screen_t SET_DEST[5] = {SCR_DISPLAY, SCR_SOUND, SCR_STORAGE, SCR_POWER,
                                     SCR_ABOUT};

static void draw_settings(void) {
  fill(0, 0, UI_W, UI_H, HDR_GROUND);
  draw_header(SCR_SETTINGS);
  for (int i = 0; i < 5; i++) nrow(i, SET_ROWS[i], NULL, true, true, s_pressed == i);
}

/* --- Display ------------------------------------------------------ */

/*
 * Four bands, one table.
 *
 * The screen carried two and wrote its geometry and its item arithmetic out
 * twice - once in the draw, once in the hit test, with the band boundaries as
 * bare 3s and 6s in both. Adding two more rows that way is four more places to
 * get an index wrong, so the rows are a table and the draw and the hit test
 * both walk it. A row moved here moves in both.
 *
 * The item indices are the row bases plus the segment: 0..2 DIM, 3..5 SLEEP,
 * 6..10 AFTER SHOT, 11..13 CAM IDLE. DSP_IT_COUNT is what item_count() returns
 * and what the focus clamp in ui_task bounds against.
 */
#define DSP_ROWS 4
#define DSP_IT_DIM 0
#define DSP_IT_SLEEP 3
#define DSP_IT_SHOT 6
#define DSP_IT_IDLE 11
#define DSP_IT_COUNT 14

/* Label, band, and the pitch between rows. The brightness note sits under the
 * fourth band, so all five have to fit BODY_Y..UI_H with room to read. */
#define DSP_Y0 (BODY_Y + 10)
#define DSP_PITCH 70
#define DSP_BAND_H 40
#define DSP_X 24
#define DSP_W (UI_W - 2 * DSP_X)
#define DSP_LABEL_Y(r) (DSP_Y0 + (r) * DSP_PITCH)
#define DSP_BAND_Y(r) (DSP_LABEL_Y(r) + 22)
/* The group box round each band, on the same rule as LOOK's: 8 px wider than
 * the control on each side, starting on the legend's line, 6 px of air under
 * the buttons. */
#define DSP_BOX_X (DSP_X - 8)
#define DSP_BOX_W (DSP_W + 16)
#define DSP_BOX_H (22 + DSP_BAND_H + 6)

_Static_assert(DSP_BOX_H < DSP_PITCH, "the DISPLAY group boxes overlap each other");

static const int DIM_S[3] = {15, 30, 60};
static const int SLEEP_S[3] = {60, 120, 300};
static const char *const SECS_15[3] = {"15秒", "30秒", "60秒"};
static const char *const SECS_60[3] = {"1分", "2分", "5分"};

/* shoot.displayAfterShotS, including the -1 that means HOLD - the result
 * screen stays until it is acknowledged. Written as the contract's own values
 * so the row and the setting cannot drift apart. */
static const int SHOT_S[5] = {0, 1, 2, 3, -1};
static const char *const SHOT_NAMES[5] = {"なし", "1秒", "2秒", "3秒", "保持"};

/* body.camIdleTimeoutS: how long before the camera bank is powered down.
 * 0 is NEVER, which is the contract's own encoding, not a sentinel invented
 * here - so NEVER is a value like the other two and not a missing setting. */
static const int IDLE_S[3] = {60, 300, 0};
static const char *const IDLE_NAMES[3] = {"1分", "5分", "なし"};

static const struct {
  const char *label;
  const char *const *names;
  const int *values;
  int count;
  int base;
} DSP_ROW[DSP_ROWS] = {
    {"DIM AFTER", SECS_15, DIM_S, 3, DSP_IT_DIM},
    {"SLEEP AFTER", SECS_60, SLEEP_S, 3, DSP_IT_SLEEP},
    {"AFTER SHOT", SHOT_NAMES, SHOT_S, 5, DSP_IT_SHOT},
    {"CAM IDLE", IDLE_NAMES, IDLE_S, 3, DSP_IT_IDLE},
};

static int nearest_idx(int v, const int *opts) {
  int best = 0, bd = 1 << 30;
  for (int i = 0; i < 3; i++) {
    const int d = v > opts[i] ? v - opts[i] : opts[i] - v;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/* Exact match, not nearest.
 *
 * nearest_idx() is right for a duration: 45 s stored by a host is honestly
 * shown as the 60 s segment. It is wrong for these two, where the values are
 * not a scale - -1 is further from 3 than 0 is, arithmetically, and 0 means
 * NEVER rather than "the shortest timeout". A value the row does not carry
 * lights nothing, which is what an unrecognised setting should look like. */
static int exact_idx(int v, const int *opts, int count) {
  for (int i = 0; i < count; i++)
    if (opts[i] == v) return i;
  return -1;
}

static int dsp_selected(int row) {
  switch (row) {
    case 0: return nearest_idx(config_int("body.autoDimS", 30), DIM_S);
    case 1: return nearest_idx(config_int("body.sleepS", 120), SLEEP_S);
    case 2: return exact_idx(config_int("shoot.displayAfterShotS", 2), SHOT_S, 5);
    default: return exact_idx(config_int("body.camIdleTimeoutS", 300), IDLE_S, 3);
  }
}

static const char *const DSP_JP[DSP_ROWS] = {"自動減光", "スリープ", "撮影後", "カメラ待機"};
static void draw_display(void) {
  fill(0, 0, UI_W, UI_H, HDR_GROUND);
  draw_header(SCR_DISPLAY);
  for (int r = 0; r < DSP_ROWS; r++) {
    const int sel = dsp_selected(r);
    nrow(r, DSP_JP[r], DSP_ROW[r].names[sel], true, true, band_rel(s_pressed, DSP_ROW[r].base, DSP_ROW[r].count) >= 0);
  }
}

/* --- Sound -------------------------------------------------------- */

/* The five sounds audio.c synthesises, then whatever clips are on the card.
 * The ids are the wire values of shoot.shutterSound; the names are what the
 * row shows. The two lists are separate because a built-in cannot be deleted
 * and a clip cannot be compiled in. */
static const char *const SND_BUILTIN_ID[5] = {"click", "cheap-digi", "tiny-beep", "mechanical",
                                              "silent"};
static const char *const SND_BUILTIN_NAME[5] = {"CLICK", "CHEAP DIGI", "TINY BEEP", "MECHANICAL",
                                                "SILENT"};
#define SND_BUILTINS 5

static int snd_count(void) { return SND_BUILTINS + kdp_sounds_count(); }

/**
 * Clip `index` in the picker's flat order: the five built-ins, then the card's.
 *
 * `id` and `name` may each be NULL, which is what kdp_recipes_name() has always
 * documented and this did not honour - it passed both straight to snprintf and
 * then called upcase() on `name` unconditionally. A caller wanting only the id
 * segfaulted on the first CUSTOM clip, and there was no such caller until
 * snd_position() below, which is how the preview found it: the harness renders
 * with two fake card clips, so the crash was immediate and total rather than
 * latent on a card nobody had.
 */
static bool snd_at(int index, char *id, size_t id_cap, char *name, size_t name_cap) {
  if (id != NULL && id_cap > 0) id[0] = '\0';
  if (name != NULL && name_cap > 0) name[0] = '\0';
  if (index < 0) return false;
  if (index < SND_BUILTINS) {
    if (id != NULL && id_cap > 0) snprintf(id, id_cap, "%s", SND_BUILTIN_ID[index]);
    if (name != NULL && name_cap > 0) snprintf(name, name_cap, "%s", SND_BUILTIN_NAME[index]);
    return true;
  }
  if (!kdp_sounds_info(index - SND_BUILTINS, id, id_cap, name, name_cap)) return false;
  if (name != NULL && name_cap > 0) upcase(name);
  return true;
}

static void snd_display(char *out, size_t cap) {
  char cur[KDP_SOUND_ID_MAX];
  config_str_copy("shoot.shutterSound", cur, sizeof cur);
  for (int i = 0, n = snd_count(); i < n; i++) {
    char id[KDP_SOUND_ID_MAX], name[KDP_SOUND_NAME_MAX];
    if (snd_at(i, id, sizeof id, name, sizeof name) && strcmp(id, cur) == 0) {
      snprintf(out, cap, "%s", name);
      return;
    }
  }
  /* A clip named in the config that is no longer on the card. Its id, for the
   * same reason the LOOK picker shows an unknown look's id. */
  snprintf(out, cap, "%s", cur[0] ? cur : SND_BUILTIN_NAME[0]);
  upcase(out);
}

static void snd_step(int delta) {
  const int n = snd_count();
  char cur[KDP_SOUND_ID_MAX];
  config_str_copy("shoot.shutterSound", cur, sizeof cur);

  int at = -1;
  for (int i = 0; i < n; i++) {
    char id[KDP_SOUND_ID_MAX], name[KDP_SOUND_NAME_MAX];
    if (snd_at(i, id, sizeof id, name, sizeof name) && strcmp(id, cur) == 0) {
      at = i;
      break;
    }
  }
  const int next = at < 0 ? (delta > 0 ? 0 : n - 1) : (((at + delta) % n) + n) % n;

  char id[KDP_SOUND_ID_MAX], name[KDP_SOUND_NAME_MAX];
  if (!snd_at(next, id, sizeof id, name, sizeof name)) return;
  cfg_set_str("shoot.shutterSound", id);
  /* Played, not described. Choosing a shutter sound off a list of names is
   * choosing blind, and this is the one control on the camera whose whole
   * subject is what it sounds like. */
  audio_shutter();
  toast(name);
}

/* Item ranges: the shutter-sound picker 0..1, the two toggles 2 and 3,
 * volume 4..6. */
#define SN_IT_PREV 0
#define SN_IT_NEXT 1
#define SN_IT_SHUTTER 2
#define SN_IT_BUTTON 3
#define SN_IT_VOL 4
#define SN_IT_COUNT 7

#define SN_BTN 36 /* the picker's â€¹ â€º buttons, inside a 52 px row */

static void draw_sound(void) {
  fill(0, 0, UI_W, UI_H, HDR_GROUND);
  draw_header(SCR_SOUND);
  char clip[KDP_SOUND_NAME_MAX];
  snd_display(clip, sizeof clip);
  static const char *const VOL[3] = {"小", "中", "大"};
  static const int VOLV[3] = {3, 6, 9};
  const bool audio = audio_ready();
  nrow(0, "シャッター音", clip, true, audio, s_pressed == SN_IT_NEXT || s_pressed == SN_IT_PREV);
  nrow(1, "保存音", config_bool("body.sounds.save", true) ? "オン" : "オフ", true, audio, s_pressed == SN_IT_SHUTTER);
  nrow(2, "操作音", config_bool("body.sounds.ui", true) ? "オン" : "オフ", true, audio, s_pressed == SN_IT_BUTTON);
  nrow(3, "音量", VOL[nearest_idx(config_int("shoot.volume", 6), VOLV)], true, audio, band_rel(s_pressed, SN_IT_VOL, 3) >= 0);
  if (!audio) ut_draw(&UT_S, NR_X, NR_Y0 + 4 * NR_H + 12, "音声出力なし", RGB(0x50, 0x56, 0x60));
}

/* --- Connection --------------------------------------------------- */

/*
 * The radio's real state, not "Not fitted".
 *
 * "Not fitted" was wrong twice over: the ESP32-C6 IS on the Guition module,
 * and what is missing is the P4's route to it, which is a wiring question
 * rather than an absent part. A user reading "Not fitted" goes looking for a
 * component to add. So the screen reports the two facts separately ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the chip
 * is there, and the firmware cannot reach it ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the same way the capabilities
 * split `flashControl` from `flashHardware`.
 *
 * Every value comes from net_link, so this screen becomes correct on its own
 * once the transport lands. Nothing here is hard-coded to the V1 state.
 */
static void draw_connection(void) {
  fill(0, 0, UI_W, UI_H, HDR_GROUND);
  draw_header(SCR_CONNECTION);
  net_status_t net;
  net_link_status(&net, esp_timer_get_time() / 1000);
  roll_state_t roll;
  const bool active = roll_state_get(&roll);
  upload_queue_report_t q;
  upload_queue_status(&q);
  const bool online = net_link_can_upload(&net);

  /* The facts, as rows down the left: what is connected and how. */
  char wifi[64];
  if (!net.radio_routed) snprintf(wifi, sizeof wifi, "なし");
  else switch (net.state) {
    case NET_IP_READY: snprintf(wifi, sizeof wifi, "%s  %d dBm", net.ssid, net.rssi); break;
    case NET_WIFI_ASSOCIATED: case NET_IP_WAIT: snprintf(wifi, sizeof wifi, "アドレス取得中"); break;
    case NET_WIFI_CONNECTING: snprintf(wifi, sizeof wifi, "接続中"); break;
    case NET_WIFI_SCANNING: snprintf(wifi, sizeof wifi, "検索中"); break;
    default: snprintf(wifi, sizeof wifi, "未接続"); break;
  }
  const int left_w = active ? 440 : NR_W;
  const struct { const char *t; const char *v; bool lit; } ROWS[] = {
      {"USB", usb_attached() ? "接続" : "未接続", usb_attached()},
      {"WiFi", wifi, net.state == NET_IP_READY},
      {"アドレス", net.ip[0] ? net.ip : "-", net.ip[0] != '\0'},
      {"ロール", active ? (roll.name[0] ? roll.name : roll.slug) : "なし", active},
  };
  for (int i = 0; i < 4; i++) {
    const int y = NR_Y0 + i * NR_H;
    int dx, a;
    row_arrive(i, &dx, &a);
    ut_draw_a(&UT_M, NR_X + dx, NR_TITLE_TOP(y), ROWS[i].t, ROWS[i].lit ? C_INK : HDR_DIM, a);
    ut_draw_a(&UT_S, NR_X + left_w - ut_w(&UT_S, ROWS[i].v) + dx, NR_VALUE_TOP(y), ROWS[i].v,
              ROWS[i].lit ? C_INK : HDR_DIM, a);
  }
  if (!net.radio_routed)
    ut_draw(&UT_S, NR_X, NR_Y0 + 4 * NR_H + 12, "無線なし。写真は USB-C で。", RGB(0x50, 0x56, 0x60));

  if (!active) return;

  /* The Roll, on the right: the code a guest scans, and what is going where. */
  static qr_t s_qr;
  static char s_qr_url[ROLL_GUEST_URL_LEN];
  static bool s_qr_ok;
  if (strcmp(s_qr_url, roll.guest_url) != 0) {
    snprintf(s_qr_url, sizeof s_qr_url, "%s", roll.guest_url);
    s_qr_ok = roll.guest_url[0] != '\0' && qr_encode(roll.guest_url, &s_qr);
    if (!s_qr_ok) klog("P4", "roll guest url did not encode as a QR (%u chars)", (unsigned)strlen(roll.guest_url));
  }
  const int qx = 620, qy = NR_Y0, qbox = 230;
  if (s_qr_ok) {
    const int side = draw_qr_centred(&s_qr, qx, qy, qbox);
    ut_mid(&UT_S, qx, qy + side + 14, roll.slug, C_INK);
  } else {
    ut_fx(&UT_MB, (float)qx, qy + qbox / 2.f, roll.slug, 1.6f, 0.f, C_INK, 255, false);
  }

  /* What is going where, under the facts. Real counts, real states. */
  const int waiting = q.pending + q.card_pending;
  const bool server_quiet = online && q.server_state == UPLOAD_SERVER_UNREACHABLE;
  const bool sending = online && !server_quiet && !q.halted && (waiting > 0 || q.uploading > 0);
  char l1[64], l2[64] = "";
  if (q.halted) { snprintf(l1, sizeof l1, "%d枚 待ち  停止中", waiting); snprintf(l2, sizeof l2, "STUDIO で確認"); }
  else if (sending) { snprintf(l1, sizeof l1, "%d枚 送信中", waiting + q.uploading); }
  else if (waiting > 0) { snprintf(l1, sizeof l1, "%d枚 待ち", waiting); snprintf(l2, sizeof l2, "%s", server_quiet ? "KINO ROLL が応答しない" : "WiFi が戻れば送る"); }
  else if (!q.scan_complete) snprintf(l1, sizeof l1, "カード確認中");
  else snprintf(l1, sizeof l1, "全部送信済");
  const int ly = NR_Y0 + 4 * NR_H + 18;
  ut_draw(&UT_MB, NR_X, ly, l1, sending ? C_COBALT : C_INK);
  if (l2[0]) ut_draw(&UT_S, NR_X, ly + 44, l2, HDR_DIM);
  if (sending) {
    /* The four-camera language for the transfer: four marks lit by how far
     * this burst has got, then KINO ROLL. Counted from the queue, not a
     * clock. */
    const int total = q.burst_done + waiting + q.uploading;
    const int lit = total > 0 ? (q.burst_done * 4) / total : 0;
    float x = NR_X + ut_w(&UT_MB, l1) + 34.f;
    const float cy = ly + UT_MB.em * 0.5f;
    for (int i = 0; i < 4; i++) {
      disc(x, cy, i < lit ? 6.f : 3.f, i < lit ? C_COBALT : RGB(0x50, 0x56, 0x60), 255);
      x += 22.f;
    }
    ut_draw(&UT_S, (int)x + 6, ly + 7, "KINO ROLL", HDR_DIM);
    s_mo_live_count++; /* the counts move; keep drawing */
  }
}

/* --- Storage ------------------------------------------------------ */

/* The two live rows on the storage screen, in the order they are drawn. DELETE
 * ALL PHOTOS is above FORMAT CARD because it is the one someone actually
 * wants: it clears the pictures and leaves the sounds, the looks, the config
 * and the upload queue alone, where FORMAT takes everything. */
#define ST_IT_DELETE_ALL 0
#define ST_IT_FORMAT 1
#define ST_IT_COUNT 2

static void draw_storage(void) {
  fill(0, 0, UI_W, UI_H, HDR_GROUND);
  draw_header(SCR_STORAGE);
  storage_status_t sd;
  storage_get_status(&sd);
  char freeb[24], capb[24], cnt[48];
  human_bytes(freeb, sizeof freeb, sd.free_bytes);
  human_bytes(capb, sizeof capb, sd.capacity_bytes);
  const int media = gallery_media_count();
  if (gallery_deleting()) {
    int done = 0, total = 0;
    gallery_delete_progress(&done, &total);
    snprintf(cnt, sizeof cnt, "削除中 %d / %d", done, total);
  } else if (media < 0) snprintf(cnt, sizeof cnt, "-");
  else snprintf(cnt, sizeof cnt, "%d枚", media);
  const bool low = sd.mounted && sd.free_bytes < (512ull << 20);
  char freerow[40];
  snprintf(freerow, sizeof freerow, "%s%s", sd.mounted ? freeb : "-", low ? "  残り少" : "");
  nrow(0, "カード", sd.mounted ? capb : (sd.present ? "未マウント" : "なし"), false, true, false);
  nrow(1, "空き", freerow, false, true, false);
  nrow(2, "写真", cnt, false, true, false);
  nrow(3, "全部削除", "", true, sd.mounted && !gallery_deleting() && media > 0, s_pressed == ST_IT_DELETE_ALL);
  if (sd.mounted) {
    /* How full, as a line: the whole width is the card. */
    const int y = NR_Y0 + 4 * NR_H + 24;
    const int used_w = sd.capacity_bytes ? (int)((uint64_t)NR_W * (sd.capacity_bytes - sd.free_bytes) / sd.capacity_bytes) : 0;
    fill(NR_X, y, NR_W, 2, RGB(0x2a, 0x30, 0x38));
    fill(NR_X, y, used_w, 2, low ? C_YELLOW : C_INK);
  }
}

/* --- About -------------------------------------------------------- */

/*
 * What this unit is and what it is running.
 *
 * The screen used to be three rows and 240 px of face grey, and the third row -
 * Device, the serial - was BLANK on hardware. It read `config_str("device",
 * "-")`, and `device` is a key nothing in this firmware ever writes; the only
 * reason it ever looked right was that the preview harness faked a value. So
 * the row that mattered most was the one that never worked.
 *
 * It now comes from kdp_device_serial(), which is the same string
 * GET_DEVICE_INFO answers as `serial` - so a support question asked from the
 * panel and one asked from Studio name the same camera. Around it goes the rest
 * of what someone on this screen is actually trying to establish, and nothing
 * that is not already a fact the firmware holds.
 *
 * Two columns, because per-camera node firmware cannot fit any other way: eight
 * full-width 52 px rows need 416 px and there are 405 px below the header. The
 * left column is the body, the right column is the four cameras.
 */
#define AB_LX LIST_X
#define AB_LW 470
#define AB_RX (AB_LX + AB_LW + 16)
#define AB_RW (UI_W - AB_RX - LIST_X)
#define AB_ROW 46              /* seven of these fit where six of ROW_H do */
#define AB_CAM_ROW 40

/** "3h 12m", or "4m" under the hour. Boot-relative, which is what uptime is. */
static void about_uptime(char *out, size_t cap) {
  const int64_t s = esp_timer_get_time() / 1000000;
  int h = (int)(s / 3600);
  const int m = (int)((s / 60) % 60);
  /* Clamped so the formatter has a bound the compiler can see. 99999 hours is
   * eleven years of uptime; a board that reaches it has a more interesting
   * problem than a clipped About row. */
  if (h > 99999) h = 99999;
  if (h > 0) snprintf(out, cap, "%dh %dm", h, m);
  else snprintf(out, cap, "%dm", m);
}

static void draw_about(void) {
  fill(0, 0, UI_W, UI_H, HDR_GROUND);
  draw_header(SCR_ABOUT);
  char name[32];
  config_str_copy("body.name", name, sizeof name);
  storage_status_t sd;
  storage_get_status(&sd);
  char card[64], up[16], proto[16];
  if (sd.mounted) {
    char freeb[24], capb[24];
    human_bytes(freeb, sizeof freeb, sd.free_bytes);
    human_bytes(capb, sizeof capb, sd.capacity_bytes);
    snprintf(card, sizeof card, "%s / %s", freeb, capb);
  } else {
    snprintf(card, sizeof card, "%s", sd.present ? "未マウント" : "なし");
  }
  about_uptime(up, sizeof up);
  snprintf(proto, sizeof proto, "KDP %d", KDP_PROTOCOL_VERSION);
  const char *serial = kdp_device_serial();
  const struct { const char *title; const char *value; } ROWS[] = {
      {"機種", name[0] ? name : "KINO D4"}, {"ファーム", KINO_FW_VERSION}, {"シリアル", serial[0] ? serial : "-"},
      {"ハード", KDP_HARDWARE_REV},     {"プロトコル", proto},         {"カード", card},
      {"稼働", up},
  };
  const int n = (int)(sizeof ROWS / sizeof ROWS[0]);
  for (int i = 0; i < n; i++) {
    /* The diagnostic page: denser than the rest, and allowed to be. Seven
     * facts in the small face, none of them a control. */
    const int y = NR_Y0 + i * 44;
    int dx, a;
    row_arrive(i, &dx, &a);
    ut_draw_a(&UT_S, NR_X + dx, y + 10, ROWS[i].title, HDR_DIM, a);
    ut_draw_a(&UT_S, NR_X + NR_W - ut_w(&UT_S, ROWS[i].value) + dx, y + 10, ROWS[i].value, C_INK, a);
  }
}

/* ------------------------------------------------------------------ */
/* Power                                                               */
/* ------------------------------------------------------------------ */

static void draw_power(void) {
  fill(0, 0, UI_W, UI_H, HDR_GROUND);
  draw_header(SCR_POWER);
  nrow(0, "再起動", NULL, true, true, s_pressed == 1);
  ut_draw(&UT_S, NR_X, NR_Y0 + NR_H + 12, "電源は USB-C。抜けば切れる。", RGB(0x50, 0x56, 0x60));
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

typedef struct {
  const char *title;
  const char *body;
  const char *sub;
  const char *go;
  bool destructive;
} dlg_spec_t;

static void dialog_spec(dlg_spec_t *d) {
  static char sub[64];
  const int n = gallery_media_count() < 0 ? 0 : gallery_media_count();
  switch (s_dialog) {
    case DLG_RESTART:
      *d = (dlg_spec_t){"再起動", "再起動する？", "すぐ戻る。", "再起動", false};
      break;
    case DLG_DELETE:
      snprintf(sub, sizeof sub, "%d枚。元に戻せない。", s_photo_frames);
      *d = (dlg_spec_t){"削除", "この写真を削除？", sub, "削除", true};
      break;
    case DLG_DELETE_ALL:
      snprintf(sub, sizeof sub, "%d枚 全部。元に戻せない。", n);
      *d = (dlg_spec_t){"全部削除", "全部削除する？", sub, "全部削除", true};
      break;
    case DLG_FORMAT:
      snprintf(sub, sizeof sub, "%d枚 全部消える。", n);
      *d = (dlg_spec_t){"初期化", "カードを初期化？", sub, "初期化", true};
      break;
    default:
      *d = (dlg_spec_t){"電源", "電源を切る？", "USB-C を抜けば切れる。", "切る", false};
      break;
  }
}

/* The two words' centres and the band they can be pressed in. One
 * definition, used by the draw and the hit test. */
#define DLG_Q_Y (UI_H * 0.40f)
#define DLG_WORD_Y (UI_H * 0.66f)
#define DLG_X1 (UI_W * 0.36f)
#define DLG_X2 (UI_W * 0.64f)
#define DLG_BAND_H 72
#define DLG_HIT_W 200

static void draw_dialog(void) {
  /* The screen under it goes dark, and the question stands on it: no plate,
   * no bar, no buttons drawn as buttons. The two words are the controls, the
   * way words are everywhere else, and the dangerous one is red. */
  scrim(0, 0, UI_W, UI_H, RGB(0x04, 0x05, 0x07), 225);
  dlg_spec_t d;
  dialog_spec(&d);
  ut_fx(&UT_MB, UI_W * 0.5f, DLG_Q_Y, d.body, 1.3f, 0.f, C_INK, 255, false);
  if (d.sub) ut_mid(&UT_S, UI_W / 2, (int)DLG_Q_Y + 40, d.sub, HDR_DIM);
  const uint16_t go_ink = d.destructive ? C_RED : C_INK;
  const int top = (int)DLG_WORD_Y - UT_M.em / 2;
  ut_mid(&UT_M, (int)DLG_X1, top, "キャンセル", s_pressed == 0 ? C_INK : HDR_DIM);
  ut_mid(&UT_M, (int)DLG_X2, top, d.go, go_ink);
  const int w1 = ut_w(&UT_M, "キャンセル"), w2 = ut_w(&UT_M, d.go);
  if (s_pressed == 0) fill((int)DLG_X1 - w1 / 2, top + UT_M.em + 4, w1, 2, C_INK);
  if (s_pressed == 1) fill((int)DLG_X2 - w2 / 2, top + UT_M.em + 4, w2, 2, go_ink);
}

/* ------------------------------------------------------------------ */
/* Capture feedback and toast                                          */
/* ------------------------------------------------------------------ */

/**
 * What the shutter is doing, over whatever screen is up.
 *
 * Deliberately a strip and not a screen: the camera must be ready for the
 * next photograph immediately, and a full review application after every
 * press is what stops that.
 */
/**
 * The capture, told with the four-frame mark.
 *
 * The cells are driven by the capture's real stages rather than by a timer:
 * one lights when the shutter fires, two when the frames are coming back,
 * three while they are going to the card, and all four spark yellow when
 * they are on it. It is honest progress and it happens to have exactly four
 * steps, which is the whole reason the mark works here.
 *
 * The wording is the camera's, not an operating system's: 4/4 SAVED, and a
 * count rather than an apology when a camera missed.
 */
/* A capture seen from any other screen: the four marks in a band at the foot,
 * and the reason when it failed. The finder draws its own fuller version. */
static void draw_capture_banner(void) {
  if (s_screen == SCR_SHOOT || !s_cap.armed) return;
  const int h = 60, y = UI_H - h;
  fill(0, y, UI_W, h, HDR_GROUND);
  draw_cap_marks(y + 14, false);
  if (s_cap.done_us != 0 && s_cap.failed) ut_mid(&UT_S, UI_W / 2, y + 30, s_cap.fail_why, C_RED);
}

static void draw_toast(void) {
  /* Kept as the busy flag's source: s_toast clears itself after the notice
   * has had time to leave. The drawing is draw_notice()'s. */
  if (s_toast[0] != '\0' && esp_timer_get_time() - s_toast_us > 2200000) s_toast[0] = '\0';
}

static void draw_screen(void) {
  switch (s_screen) {
    case SCR_SHOOT: draw_shoot(); break;
    case SCR_LOOK: draw_look(); break;
    case SCR_GALLERY: draw_gallery(); break;
    case SCR_PHOTO: draw_photo(); break;
    case SCR_ROLL: draw_connection(); break;
    case SCR_SETTINGS: draw_settings(); break;
    case SCR_DISPLAY: draw_display(); break;
    case SCR_SOUND: draw_sound(); break;
    case SCR_CONNECTION: draw_connection(); break;
    case SCR_STORAGE: draw_storage(); break;
    case SCR_ABOUT: draw_about(); break;
    case SCR_POWER: draw_power(); break;
    default: break;
  }
  draw_capture_banner();
  draw_toast();
  draw_notice(s_screen == SCR_SHOOT || s_screen == SCR_PHOTO);
  draw_mode_row();
  if (s_dialog != DLG_NONE) draw_dialog();
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

static void fire_shutter(bool long_press);

static void go(screen_t s, int dissolve_ms) {
  const int64_t now = esp_timer_get_time();
  if (s == SCR_GALLERY) gallery_refresh();
  if (s == SCR_SHOOT && s_screen != SCR_SHOOT) {
    s_sh_show_ms = s_visited[SCR_SHOOT] ? SH_SHOW_MS : SH_SHOW_FIRST_MS;
    sh_reveal();
  }
  if (s_screen == SCR_PHOTO && s != SCR_PHOTO) photo_release();
  /* No crossfade between screens: the words that move carry the change, the
   * rest cuts. The one exception is a photograph opening from its tile and
   * closing back to it, where a picture dissolving into pictures is the
   * photographic idiom rather than a transition effect. */
  if (s != SCR_PHOTO && s_screen != SCR_PHOTO) dissolve_ms = 0;
  s_enter_first = !s_visited[s];
  s_visited[s] = true;
  s_enter_us = now;
  s_screen = s;
  s_pressed = -1;
  gfx_snapshot();
  draw_screen();
  gfx_dissolve(dissolve_ms);
}

static void go_back(void) {
  /* One level up, deterministically; a mode's home is where it stops. */
  go(SCREEN_PARENT[s_screen], 180);
}

/* Number of focusable items on a screen. */
static int item_count(screen_t s) {
  switch (s) {
    case SCR_SHOOT: return 3;
    /* The TARGET row is the last band, so WIGGLE simply stops short of it
     * and every index below keeps its meaning in both modes. */
    case SCR_LOOK: return mode_is_quad() ? FL_IT_COUNT : FL_IT_TARGET;
    case SCR_GALLERY: return GALLERY_PAGE;
    case SCR_PHOTO: return 2; /* Send to Roll is not fitted, so not focusable */
    case SCR_SETTINGS: return 5;
    case SCR_DISPLAY: return DSP_IT_COUNT;
    case SCR_SOUND: return SN_IT_COUNT;
    case SCR_STORAGE: return ST_IT_COUNT;
    case SCR_POWER: return 3;
    default: return 0;
  }
}

/* ------------------------------------------------------------------ */
/* Hit testing                                                         */
/* ------------------------------------------------------------------ */

static bool in(int x, int y, int rx, int ry, int rw, int rh) {
  return x >= rx && x < rx + rw && y >= ry && y < ry + rh;
}

static int hit_dialog(int x, int y) {
  const int by = (int)DLG_WORD_Y - DLG_BAND_H / 2;
  if (in(x, y, (int)DLG_X1 - DLG_HIT_W / 2, by, DLG_HIT_W, DLG_BAND_H)) return 0;
  if (in(x, y, (int)DLG_X2 - DLG_HIT_W / 2, by, DLG_HIT_W, DLG_BAND_H)) return 1;
  return -1;
}

static int hit_test(int x, int y) {
  if (s_dialog != DLG_NONE) return hit_dialog(x, y);

  /* The mode row, when it is open, is the only thing on the screen. */
  if (s_row_open) {
    const int m = row_hit(x, y);
    return m >= 0 ? IT_MODE0 + m : IT_HDR;
  }

  switch (s_screen) {
    case SCR_SHOOT:
      /* The title band, and the reading line's two decisions; everything
       * else is picture, and a swipe anywhere changes mode. */
      if (y < HEAD_H) return IT_HDR;
      if (y >= UI_H - 24 - UT_M.em - 14 && sh_words_alpha() > 0) {
        if (x >= s_sh_mode_x0 - 10 && x < s_sh_mode_x1 + 10) return SH_IT_MODE;
        if (x >= s_sh_flash_x0 - 10 && x < s_sh_flash_x1 + 10) return SH_IT_FLASH;
      }
      return -1;

    case SCR_PHOTO: {
      if (y < HEAD_H && x < 260) return IT_HDR;
      /* The two words on the line under the picture, with room around them. */
      if (y >= PH_LINE_Y - 14) {
        if (x >= s_ph_del_x0 - 14 && x < s_ph_del_x1 + 14) return P_IT_DELETE;
        if (x >= s_ph_fav_x0 - 14 && x < s_ph_fav_x1 + 14) return P_IT_FAV;
      }
      return -1;
    }

    default: break;
  }

  /* Every other screen has the standard header, and the whole of it goes
   * back: the mark is a smaller target than a thumb is wide.
   *
   * Except FILTER's right half in QUAD, where the target words share the
   * header's line: the title is the left half there. */
  if (y < HEAD_H && !(s_screen == SCR_LOOK && mode_is_quad() && x >= UI_W / 2)) return IT_HDR;

  switch (s_screen) {
    case SCR_LOOK: {
      /* The foot: 白黒 and, in QUAD, the target words - generous bands
       * round each. Then the picture: left half back, right half forward. */
      {
        span_t mono, tg[5];
        fl_spans(&mono, tg);
        if (y >= FL_FOOT_TOP - 16 && x >= mono.x0 - 16) return FL_IT_MONO;
        if (y < HEAD_H && mode_is_quad())
          for (int i = 0; i < 5; i++)
            if (x >= tg[i].x0 - 12 && x < tg[i].x1 + 12) return FL_IT_TARGET + i;
      }
      return x < UI_W / 2 ? FL_IT_PREV : FL_IT_NEXT;
    }
    case SCR_GALLERY: {
      if (gallery_total() == 0 || s_gal_from_page >= 0) return -1; /* not while a page is sliding */
      for (int i = 0; i < GALLERY_PAGE; i++) {
        int gx, gy;
        gal_origin(i, &gx, &gy);
        if (in(x, y, gx, gy, G_TILE_W, G_TILE_H)) return i;
      }
      return -1;
    }
    case SCR_SETTINGS:
      return nrow_hit(x, y, 5);

    case SCR_DISPLAY: {
      /* A row is its setting; the item is the NEXT value in that row's
       * cycle, so activation stays one table write. */
      const int r = nrow_hit(x, y, DSP_ROWS);
      if (r < 0) return -1;
      return DSP_ROW[r].base + (dsp_selected(r) + 1) % DSP_ROW[r].count;
    }
    case SCR_SOUND: {
      const int r = nrow_hit(x, y, 4);
      if (r == 0) return SN_IT_NEXT;
      if (r == 1) return SN_IT_SHUTTER;
      if (r == 2) return SN_IT_BUTTON;
      if (r == 3) {
        static const int VOLV[3] = {3, 6, 9};
        return SN_IT_VOL + (nearest_idx(config_int("shoot.volume", 6), VOLV) + 1) % 3;
      }
      return -1;
    }
    case SCR_STORAGE:
      /* Rows 0..2 read; row 3 acts. There is no format row any more: a thing
       * the camera cannot do is not offered. */
      return nrow_hit(x, y, 4) == 3 ? ST_IT_DELETE_ALL : -1;

    case SCR_POWER:
      return nrow_hit(x, y, 1) == 0 ? 1 : -1; /* the one row is Restart, item 1 */

    default: return -1;
  }
}

/* ------------------------------------------------------------------ */
/* Activation                                                          */
/* ------------------------------------------------------------------ */

static void dialog_commit(void) {
  const dialog_t d = s_dialog;
  s_dialog = DLG_NONE;
  switch (d) {
    case DLG_RESTART:
      config_save();
      /* What the camera is doing, not a farewell. It said GOOD NIGHT and
       * then came straight back up, which reads as a shutdown that failed. */
      fill(0, 0, UI_W, UI_H, RGB(0x00, 0x00, 0x00));
      ut_mid(&UT_M, UI_W / 2, UI_H / 2 - UT_M.em / 2, "再起動", C_INK);
      gfx_present();
      vTaskDelay(pdMS_TO_TICKS(500));
      esp_restart();
      break;
    case DLG_DELETE: {
      char dir[128];
      snprintf(dir, sizeof dir, "%s/%s", CAPTURES_DIR, s_photo_id);
      /* Unlinking four JPEGs and a META.JSON is a card operation like any
       * other and went through no arbiter at all - so a delete could land in
       * the middle of a capture writing to the same directory tree. Same 2 s
       * budget as the gallery; on a timeout nothing is deleted and the
       * screen does not move, which is the only safe answer for an
       * irreversible operation. */
      if (!storage_acquire(STORAGE_USER_UI, 2000)) {
        toast("カード使用中");
        audio_warning();
        break;
      }
      /* Queue first, files second, as Delete All does: a job left behind
       * re-reads a missing asset to the retry cap and parks FAILED. */
      upload_queue_forget(s_photo_id);
      storage_capture_delete(dir);
      storage_release(STORAGE_USER_UI);
      photo_release();
      /* Told, not discovered, and before the refresh: the gallery's order
       * index still names this capture, and the only other way it would find
       * out is a tile failing to open its META.JSON - which costs a full walk
       * of the card. Non-blocking; the gallery task does the work. */
      gallery_note_removed(s_photo_id);
      gallery_refresh();
      toast("削除した");
      go(SCR_GALLERY, 180);
      return;
    }
    case DLG_DELETE_ALL:
      /* Runs on the gallery task, not here. This handler is the UI task
       * inside a touch handler: deleting 500 folders on it would freeze the
       * screen for the whole minute it takes, and the shutter with it. The
       * gallery task takes the card in bursts and yields per folder, so a
       * photograph taken during the wipe still wins. */
      gallery_delete_all();
      toast("削除中");
      break;
    case DLG_FORMAT:
      /* Not wired: there is no format entry point in storage.c, and calling
       * a delete loop over user captures under the name "format" would be a
       * different operation wearing the label. */
      toast("初期化はできない");
      break;
    default:
      toast("電源は USB-C");
      break;
  }
  draw_screen();
  gfx_present();
}

static void activate(int item) {
  if (s_dialog != DLG_NONE) {
    if (item == 1) dialog_commit();
    else {
      s_dialog = DLG_NONE;
      draw_screen();
      gfx_present();
    }
    return;
  }

  if (item == IT_BACK) { go_back(); return; }

  /* The shell's own items. A tap in the header on a child screen goes up;
   * on a mode's home it opens the mode row (and closes it again). A pick
   * from the row moves - to the left or the right of where we are, so the
   * titles travel the way the row reads. */
  if (item >= IT_MODE0 && item < IT_MODE0 + MODE_COUNT) {
    const kmode_t to = (kmode_t)(item - IT_MODE0);
    const kmode_t from = mode_of(s_screen);
    row_close();
    if (to != from) mode_go(to, to > from ? 1 : -1);
    else { draw_screen(); gfx_present(); }
    return;
  }
  if (item == IT_HDR) {
    if (s_row_open) { row_close(); draw_screen(); gfx_present(); return; }
    if (SCREEN_PARENT[s_screen] != s_screen) { go_back(); return; }
    row_open(esp_timer_get_time());
    draw_screen();
    gfx_present();
    return;
  }

  switch (s_screen) {

    case SCR_LOOK:
      if (item == FL_IT_PREV || item == FL_IT_NEXT) fl_change(item == FL_IT_NEXT ? 1 : -1);
      else if (item == FL_IT_MONO) {
        look_set_mono(!look_is_mono());
        notice_say(look_is_mono() ? "白黒" : "カラー", C_INK, 1000, false);
      } else if (item >= FL_IT_TARGET && item < FL_IT_COUNT) {
        s_look_target = item - FL_IT_TARGET;
      }
      break;

    case SCR_SHOOT:
      /* The reading line's two decisions, cycled in place and announced. */
      if (item == SH_IT_MODE) {
        cfg_set_str("mode", mode_is_quad() ? "wiggle" : "quad");
        sh_reveal();
      } else if (item == SH_IT_FLASH) {
        flash_cycle();
        sh_reveal();
      }
      break;

    case SCR_GALLERY:
      if (item >= 0 && item < GALLERY_PAGE) {
        const gallery_item_t *slots = gallery_slots();
        if (slots[item].state == TILE_EMPTY) break;
        /* The card was busy, so nothing was decoded. Stay on the gallery and
         * say why rather than opening an empty photograph screen that looks
         * like a lost capture. */
        if (!photo_open(&slots[item])) {
          toast("カード使用中");
          audio_warning();
          break;
        }
        s_focus[SCR_PHOTO] = P_IT_DELETE;
        go(SCR_PHOTO, 200);
        return;
      }
      break;

    case SCR_PHOTO:
      if (item == P_IT_DELETE) {
        s_dialog = DLG_DELETE;
        s_dlg_focus = 0;
      } else if (item == P_IT_FAV) {
        photo_toggle_favourite();
      }
      break;

    case SCR_SETTINGS:
      if (item >= 0 && item < 5) { go(SET_DEST[item], 200); return; }
      break;

    case SCR_DISPLAY: {
      /* One table again, and one write. The setting each row owns is named
       * beside the row rather than in a chain of index ranges here, so the
       * four cannot get out of step with the four bands that were drawn. */
      static const char *const DSP_PATH[DSP_ROWS] = {"body.autoDimS", "body.sleepS",
                                                     "shoot.displayAfterShotS",
                                                     "body.camIdleTimeoutS"};
      for (int r = 0; r < DSP_ROWS; r++) {
        const int rel = band_rel(item, DSP_ROW[r].base, DSP_ROW[r].count);
        if (rel < 0) continue;
        cfg_set_int(DSP_PATH[r], DSP_ROW[r].values[rel]);
        break;
      }
      break;
    }

    case SCR_SOUND:
      if (item == SN_IT_PREV || item == SN_IT_NEXT) snd_step(item == SN_IT_NEXT ? 1 : -1);
      else if (item == SN_IT_SHUTTER)
        cfg_set_bool("body.sounds.save", !config_bool("body.sounds.save", true));
      else if (item == SN_IT_BUTTON)
        cfg_set_bool("body.sounds.ui", !config_bool("body.sounds.ui", true));
      else if (item >= SN_IT_VOL && item < SN_IT_COUNT) {
        static const int VOLV[3] = {3, 6, 9};
        cfg_set_int("shoot.volume", VOLV[item - SN_IT_VOL]);
      }
      break;

    case SCR_STORAGE:
      /* Both go through the same confirm as FORMAT and RESTART: focus starts
       * on CANCEL, and the go button is the destructive one. A wipe already
       * running takes neither press - there is nothing useful a second
       * DELETE ALL could mean. */
      if (gallery_deleting()) break;
      if (item == ST_IT_DELETE_ALL) {
        if (gallery_media_count() <= 0) {
          toast("写真なし");
          break;
        }
        s_dialog = DLG_DELETE_ALL;
        s_dlg_focus = 0;
      } else if (item == ST_IT_FORMAT) {
        /* Dimmed row; a press still lands here from the hit test. Say so
         * without a confirm dialog for a thing that cannot happen. */
        toast("初期化はできない");
      }
      break;

    case SCR_POWER:
      if (item == 0) { toast("電源は USB-C"); break; }
      if (item == 1) { s_dialog = DLG_RESTART; s_dlg_focus = 0; break; }
      go_back();
      return;

    default: break;
  }

  s_pressed = -1;
  draw_screen();
  gfx_present();
}

/* ------------------------------------------------------------------ */
/* The shutter                                                         */
/* ------------------------------------------------------------------ */

/**
 * One shutter, whichever thing pressed it.
 *
 * The physical key fires from any screen. That is not a convenience: it is
 * what makes this a camera rather than an appliance with a camera mode. The
 * capture runs, the strip reports it over whatever was on screen, and the
 * screen does not change underneath you.
 */
static void fire_shutter(bool long_press) {
  if (config_bool("body.sounds.save", true)) audio_shutter();
  if (!capture_request(long_press ? "shutter-hold" : "shutter")) {
    klog("P4", "shutter ignored - a capture is already running");
  }
}

/**
 * Acknowledge a held capture report.
 *
 * shoot.displayAfterShotS = -1 means the report stays until a person dismisses
 * it, so a touch or a key press is the acknowledgement and does nothing else -
 * the same rule the wake gesture follows, for the same reason: the input that
 * clears something off the screen must not also act on what was under it.
 *
 * Returns true when there was a held report, so the caller can swallow the
 * press it just consumed.
 */
static bool shot_hold_ack(void) {
  if (!s_shot_hold) return false;
  s_shot_hold = false;
  capture_ack();
  s_shot_seen_us = 0;
  if (s_screen == SCR_GALLERY) gallery_refresh();
  draw_screen();
  gfx_present();
  return true;
}

/* ------------------------------------------------------------------ */
/* Physical keys, handed to the UI task rather than acted on            */
/*                                                                      */
/* buttons.c calls the handler from its own task - priority 5, no core   */
/* affinity. Everything a press does touches state the UI task owns: go()*/
/* redraws s_cv, takes a gfx_snapshot() and runs a gfx_dissolve(), all of*/
/* which the ui task is doing at the same moment on CPU1. Two writers on */
/* one canvas and two callers into the compositor is a torn frame at     */
/* best and a PPA transaction started from under another one at worst.   */
/*                                                                      */
/* It has never been seen because board_d4v1.h assigns no button pins, so*/
/* buttons.c reads nothing and the handler is never called. But that     */
/* header promises the opposite: "assign a real pin and the control comes*/
/* alive with no other change". So the fault ships armed, and the first  */
/* harness with a shutter wired to it is what fires it. A queue is the   */
/* whole fix - the press is recorded on the buttons task and acted on by */
/* the task that owns the screen.                                        */
/* ------------------------------------------------------------------ */

typedef struct {
  button_id_t id;
  bool long_press;
} btn_event_t;

/* Length 4: a finger cannot outrun the UI loop's 20 ms period by more than
 * that, and a backlog of stale presses is worse than a dropped one. */
static QueueHandle_t s_btn_q;

/* Runs on the buttons task. Records and returns - no drawing, no capture,
 * no config, nothing that reaches the canvas. */
static void on_button(button_id_t id, bool long_press) {
  if (s_btn_q == NULL) return;
  const btn_event_t ev = {.id = id, .long_press = long_press};
  /* Never blocks. The buttons task is above the UI in priority, so waiting
   * here would hold the debouncer off the pins for as long as the UI is busy
   * presenting a frame. */
  (void)xQueueSend(s_btn_q, &ev, 0);
}

/* Away from the finder, the shutter opens the finder rather than taking a
 * photograph of the inside of a bag. On the finder it captures. That is the
 * safest camera-like reading of a single-stage button.
 *
 * Called only from ui_task, via the queue above. */
static void handle_button(const btn_event_t *ev) {
  /* A physical key was used: from here on the focus ring is drawn. This is
   * the only place that flips it, matching the contract at s_focus_shown. */
  s_focus_shown = true;
  /* A held report is dismissed by the next key, and that key does nothing
   * else. Before the FN and shutter branches, so a press cannot both clear the
   * report and fire the next photograph. */
  if (shot_hold_ack()) return;
  if (ev->id == BTN_FN) {
    flash_cycle();
    return;
  }
  if (ev->id != BTN_SHUTTER) return;
  if (s_screen != SCR_SHOOT) {
    go(SCR_SHOOT, 160);
    gfx_present();
    return;
  }
  fire_shutter(ev->long_press);
}

/* Drained once per loop iteration, before anything reads the touch panel: a
 * key press and a tap in the same 20 ms should resolve in the order they
 * arrived, and the key got there first. */
static void drain_buttons(void) {
  if (s_btn_q == NULL) return;
  btn_event_t ev;
  while (xQueueReceive(s_btn_q, &ev, 0) == pdTRUE) handle_button(&ev);
}

/* ------------------------------------------------------------------ */
/* Task                                                                */
/* ------------------------------------------------------------------ */

/*
 * The UI task's own pulse. See ui_liveness() in ui.h for why it exists at all.
 *
 * uint32 milliseconds, not the int64 microseconds everything else in this file
 * uses: the reader is another task, a 32-bit aligned load is one instruction on
 * RV32 and an int64 is two, and a torn read of the high word would report an
 * age of days on a perfectly healthy camera. Wraps at 49.7 days of uptime; a
 * body up that long has other problems and other diagnostics.
 *
 * Single writer (ui_task), many readers, no lock. volatile is enough: the only
 * hazard a lock would remove is a reader seeing the pass counter one newer than
 * the timestamp, which changes an age by one loop period.
 */
static volatile uint32_t s_ui_pass;
static volatile uint32_t s_ui_pass_ms;
static volatile bool s_ui_stalled;

void ui_liveness(uint32_t *passes, uint32_t *age_ms, bool *stalled) {
  const uint32_t stamp = s_ui_pass_ms;
  if (passes != NULL) *passes = s_ui_pass;
  if (stalled != NULL) *stalled = s_ui_stalled;
  if (age_ms != NULL) {
    /* 0 rather than the whole uptime before the first pass: a camera whose UI
     * has not started yet must not read as a UI that has been gone since boot. */
    *age_ms = stamp == 0 ? 0 : (uint32_t)(esp_timer_get_time() / 1000) - stamp;
  }
}

/* The boot sequence, once: the splash, then the first screen dissolving in. */
static void ui_boot(void) {
  mo_seed((uint32_t)esp_timer_get_time() ^ (capture_count() * 2654435761u));
  splash();
  s_visited[SCR_SHOOT] = true;
  sh_reveal();

  /* A finger held on the glass through the splash boots into 情報, the
   * diagnostic page - serial, build, uptime, the cameras - without a menu to
   * find it in. The press is swallowed the way a wake press is: nothing on
   * that page acts, so there is nothing for it to hit. */
  {
    uint16_t bx, by;
    if (touch_ready() && touch_get(&bx, &by)) {
      s_screen = SCR_ABOUT;
      klog("P4", "boot: finger on the glass - opening the diagnostic page");
    }
  }

  gfx_snapshot();
  draw_screen();
  uint32_t f0 = 0, f1 = 0, ms = 0;
  gfx_stats(&f0, NULL);
  gfx_dissolve(420);
  gfx_stats(&f1, &ms);
  ESP_LOGI(TAG, "boot dissolve: %lu frames in %lu ms (%lu fps)", (unsigned long)(f1 - f0),
           (unsigned long)ms, (unsigned long)(ms ? (f1 - f0) * 1000 / ms : 0));
}

/*
 * The loop's carry-over state, which used to be ui_task's locals.
 *
 * One pass of the loop is a function, ui_pass(), and the task below is the
 * trivial `for (;;) vTaskDelay(ui_pass())`. That is what lets a host drive the
 * same pass from its own scheduler: KINO Twin runs this file's real screens in
 * a browser (firmware/p4/twin_ui) the way host_preview renders them, and a
 * task that never returns cannot be stepped. Nothing about the camera changed:
 * the body, its ordering and its sleeps are exactly what they were, and every
 * `continue` became `return <the delay it used to sleep>`. The names are kept
 * so the body reads as it did.
 */
static int held = -1;
static int64_t s_ui_report_us = 0;
static uint32_t s_ui_last_frames = 0;
static ui_health_t health = {0};
static int64_t wake_since_us = 0;
static bool was_asleep = false;
static int64_t s_slept_us = 0; /* when the panel went dark, for 続けよう。 */
#define LONG_SLEEP_US (20LL * 60 * 1000000)
/* True from the touch that dismissed a held report until that finger lifts,
 * so the dismissal does not also press whatever was underneath it. */
static bool swallow_touch = false;
/* The gesture recogniser's carry-over: where the finger landed and when,
 * where it was last seen, and whether it has travelled. */
static bool g_prev_down = false;
static bool g_moved = false;
static int g_down_x, g_down_y, g_last_x, g_last_y;
static int64_t g_down_us;
#define GEST_SLOP 24   /* px of travel before a press becomes a gesture */
#define GEST_SWIPE 90  /* px of horizontal travel that is a swipe */
#define GEST_RISE 90   /* px of vertical travel that makes it not one */

/** One pass of the UI loop. Returns how long the task sleeps before the next. */
static uint32_t ui_pass(void) {
  /* The pulse, first thing and unconditionally. Several branches below
   * `continue`, and a stamp that some passes skip reads as a wedge on a loop
   * that is merely swallowing a wake press. */
  s_ui_pass++;
  s_ui_pass_ms = (uint32_t)(esp_timer_get_time() / 1000);
  /* Motion is stepped where it is drawn; this only clears the "anything
   * still moving" tally the tail reads to pick the next pass delay. */
  mo_begin_pass();
  cap_step();
  notice_watch();

  /* Physical keys first: they were recorded on the buttons task and this
   * is the task that owns the canvas and the compositor. */
  drain_buttons();

  uint16_t tx = 0, ty = 0;
  int region = -1;
  const bool down = touch_ready() && touch_get(&tx, &ty);

  /* A touch that wakes a sleeping screen wakes it and does nothing else.
   * Reaching into a bag for a camera whose backlight has timed out and
   * having it fire whatever tile the thumb landed on is the worst possible
   * answer, and it is what the naive version does. */
  /* Repaint the moment the panel comes back, before anything else.
   *
   * Nothing else in the loop presents a frame while the screen is idle - it
   * has no reason to, the picture has not changed - so after a sleep the
   * screen depends entirely on the framebuffer having survived with the
   * backlight off. If it did not, for any reason, the camera comes back
   * showing nothing and every press lands on a screen the user cannot
   * read, which is indistinguishable from a device that has stopped
   * responding. One redraw makes that impossible. */
  power_state_t pst;
  power_get(&pst);
  const bool asleep_now = pst.stage == POWER_ASLEEP;
  if (!was_asleep && asleep_now) s_slept_us = esp_timer_get_time();
  if (was_asleep && !asleep_now) {
    ESP_LOGI(TAG, "woke: repainting");
    klog("P4", "woke, repainting");
    /* Picked up again after a while: one line, and back to work. A short
     * doze says nothing - the screen just comes back. */
    if (s_slept_us != 0 && esp_timer_get_time() - s_slept_us >= LONG_SLEEP_US)
      notice_say("続けよう。", C_INK, 1600, false);
    s_slept_us = 0;
    draw_screen();
    gfx_present();
  }
  was_asleep = asleep_now;

  if (!down) {
    power_end_wake_gesture();
    wake_since_us = 0;
  }
  if (power_wake_gesture()) {
    /* Swallow the press that woke the screen - but only for as long as a
     * press can plausibly last.
     *
     * The flag is cleared by the finger lifting, which is normally the
     * next thing that happens. If anything stops that being seen - a
     * dropped read on the bus the codec shares, or a stage that got put
     * back to sleep underneath the wake - the UI would go permanently
     * deaf, which is the worst failure this screen has. A ceiling costs
     * nothing and makes that impossible. */
    const int64_t now = esp_timer_get_time();
    if (wake_since_us == 0) wake_since_us = now;
    if (now - wake_since_us < 1200000) return 20;
    power_end_wake_gesture();
    wake_since_us = 0;
    klog("P4", "wake gesture outlived a press - releasing the UI");
  }

  /*
   * A held report is dismissed by the touch that lands on it, wherever it
   * lands, and that touch does nothing else.
   *
   * Handled at the DOWN edge and swallowed until the finger lifts, rather
   * than at the release, because a tap on empty screen never reaches the
   * release path at all - hit_test() returns -1, `held` stays -1, and the
   * branch below is skipped. A report on the SHOOT screen covers nothing but
   * picture, so "tap anywhere" is the only gesture that always works.
   */
  if (!down) swallow_touch = false;
  if (down && s_shot_hold) {
    shot_hold_ack();
    swallow_touch = true;
  }
  if (swallow_touch) return 20;

  int lx = 0, ly = 0;
  if (down) {
    /* Touch reports in panel space, so the same quarter turn applies in
     * reverse: touch y is the logical x. */
    lx = ty;
    ly = DISPLAY_H_RES - 1 - tx;
    region = hit_test(lx, ly);
  }

  /*
   * A swipe is a press that travelled. The finger's landing point is kept;
   * once it has moved more than GEST_SLOP the press underneath is cancelled
   * (the control un-paints, nothing fires on release) and the lift decides
   * whether the travel was a horizontal swipe: enough distance, not much
   * height, not too slow. A swipe changes mode; nothing else on the shell
   * reads travel yet.
   */
  {
    const int64_t now = esp_timer_get_time();
    if (down && !g_prev_down) {
      g_down_x = lx;
      g_down_y = ly;
      g_down_us = now;
      g_moved = false;
      if (s_screen == SCR_SHOOT && s_dialog == DLG_NONE && !s_row_open) sh_reveal();
    }
    if (down && !g_moved) {
      const int dx = lx - g_down_x, dy = ly - g_down_y;
      if (dx * dx + dy * dy > GEST_SLOP * GEST_SLOP) {
        g_moved = true;
        if (held != -1 || s_pressed != -1) {
          s_pressed = -1;
          held = -1;
          draw_screen();
          gfx_present();
        }
      }
    }
    if (down && g_moved) region = -1; /* a travelling finger presses nothing */
    if (!down && g_prev_down && g_moved) {
      const int dx = g_last_x - g_down_x, dy = g_last_y - g_down_y;
      const bool quick = now - g_down_us < 600000;
      if (quick && (dx > GEST_SWIPE || dx < -GEST_SWIPE) && dy < GEST_RISE && dy > -GEST_RISE &&
          s_dialog == DLG_NONE) {
        klog("P4", "swipe %d px in %d ms", dx, (int)((now - g_down_us) / 1000));
        if (s_row_open) row_close();
        mode_swipe(dx < 0 ? 1 : -1);
      } else if (quick && (dy > GEST_SWIPE || dy < -GEST_SWIPE) && dx < GEST_RISE && dx > -GEST_RISE &&
                 s_dialog == DLG_NONE && !s_row_open) {
        /* Up and down is the screen's own: the gallery turns its pages. */
        if (s_screen == SCR_GALLERY) gal_turn(dy < 0 ? 1 : -1);
      }
      g_moved = false;
    }
    if (down) {
      g_last_x = lx;
      g_last_y = ly;
    }
    g_prev_down = down;
  }

  if (down && region != s_pressed) {
    /* Press paints; activation waits for the release, so a finger that
     * lands on the wrong thing can be slid off it. */
    s_pressed = region;
    held = region;
    if (region >= 0 && config_bool("body.sounds.ui", true)) audio_tick();
    draw_screen();
    gfx_present();
  } else if (!down && held != -1) {
    const int fired = (s_pressed == held) ? held : -1;
    s_pressed = -1;
    held = -1;
    if (fired != -1) {
      /* Touch sets focus as well as acting, so the two input models never
       * disagree about what is selected. */
      if (s_dialog != DLG_NONE) s_dlg_focus = fired;
      else if (fired != IT_BACK && fired < item_count(s_screen)) s_focus[s_screen] = fired;
      activate(fired);
    } else {
      draw_screen();
      gfx_present();
    }
  }

  /* The nodes are only asked for frames while the viewfinder is up. Left
   * running behind a menu it would be four sensors and four UARTs burning
   * battery to fill a buffer nobody reads. */
  viewfinder_run(s_screen == SCR_SHOOT || s_screen == SCR_LOOK);

  const capture_stage_t cstage = capture_stage();
  if (cstage == CAPTURE_DONE) {
    if (s_shot_seen_us == 0) {
      /* The first pass on which the report exists, which is the only place
       * the UI learns that a capture failed or came back short. The strip
       * has said so since draw_capture_banner() was written; a strip in the
       * corner of a viewfinder someone has already lowered says it to
       * nobody. */
      s_shot_seen_us = esp_timer_get_time();
      capture_report_t r;
      capture_last(&r);
      /* A full or absent card arrives here too - it is a failed report with
       * a STORAGE err_code, not a separate path - so this one call covers
       * both halves of the requirement. */
      if (!r.ok || r.stored < r.online) audio_warning();
    }
    /*
     * -1 is HOLD: keep the report up until someone acknowledges it.
     *
     * It used to be multiplied straight into the deadline, so -1 gave a
     * deadline one second in the PAST and the report was acknowledged on the
     * first pass - hold behaved exactly like 0, which is the one value it
     * is supposed to be the opposite of. 0 still means no hold at all: the
     * comparison below is > 0 microseconds elapsed, which the next pass
     * satisfies.
     */
    const int hold_s = config_int("shoot.displayAfterShotS", 2);
    if (hold_s < 0) {
      s_shot_hold = true;
    } else if (esp_timer_get_time() - s_shot_seen_us > (int64_t)hold_s * 1000000) {
      capture_ack();
      s_shot_seen_us = 0;
      if (s_screen == SCR_GALLERY) gallery_refresh();
      draw_screen();
      gfx_present();
    }
  } else if (cstage == CAPTURE_IDLE) {
    s_shot_seen_us = 0;
    s_shot_hold = false;
  }

  /* A capture in progress, a gallery still decoding, and a toast on its way
   * out all change the screen without anyone touching anything. */
  /* The wipe is the fourth: DELETE ALL PHOTOS runs on the gallery task for
   * up to a minute on a full card, and the DELETING n OF m line on the
   * storage screen is the only thing that says it is still going. */
  const bool busy = cstage != CAPTURE_IDLE ||
                    (s_screen == SCR_GALLERY && gallery_loading()) ||
                    (s_screen == SCR_STORAGE && gallery_deleting()) || s_toast[0] != '\0';

  /*
   * The wigglegram advances here, above the busy branch rather than in the
   * tail, so that a toast or a capture banner over the photograph does not
   * freeze the picture underneath it. It is a state step and not a draw: it
   * moves the frame index and says whether the screen owes a repaint.
   *
   * It is asked only on the screen that has one, and only with no finger
   * down - a press repaints on its own edge, and stepping a frame under a
   * held button would fight it for the canvas.
   */
  const bool wig_moved = (s_screen == SCR_PHOTO && held == -1) ? wiggle_tick() : false;

  if (held == -1 && s_screen != SCR_SHOOT && (busy || wig_moved)) {
    draw_screen();
    gfx_present();
    /*
     * 90 ms is the busy cadence; a wiggle frame that is only waiting for its
     * own deadline goes back round at the loop's own 20 ms so the next
     * deadline is not missed by 70.
     *
     * A PLAYING wigglegram keeps the 20 ms pass even while something is busy.
     * #160 could take the 90 ms here because its deadline was a whole frame
     * period, 66..200 ms; a crossfade sub-step is ~33 ms, so 90 ms would make
     * the swing run at a third speed for as long as a toast was up - and a
     * toast is exactly what FAVOURITE raises on this screen.
     */
    const bool wig_pacing = s_screen == SCR_PHOTO && s_wig_play;
    if (mo_any_live()) return MO_FRAME_MS;
    return (busy && !wig_pacing) ? 90 : 20;
  }

  /*
   * Once a second: was a frame DUE, and did one come out?
   *
   * A stuck preview has three quite different causes and they are
   * indistinguishable from the outside. The pump is known to keep running -
   * measured at 5-6.7 fps while the screen looked frozen - so the question is
   * what the UI is doing. If frames advance, the compositor is running and
   * the panel is stale; if they stop while a frame was owed, the UI is
   * looping without presenting; if the loop stops entirely, ui_liveness()
   * says so to a host, because nothing running on this task can.
   *
   * "Was a frame due" is the whole of issue #140. The test used to be "did a
   * frame come out", which an idle screen legitimately fails - it presents
   * only when something changes - so the line fired every second forever and
   * emptied the klog ring of the boot evidence someone needed. The decision
   * lives in ui_health_step() (pure.c, host-tested) together with the
   * reasoning and the rejected alternatives; this block supplies the two
   * facts and prints the edges.
   *
   * `present_due` is the tail of this pass, below: the SHOOT screen with
   * nothing latched is the one path that presents unconditionally. The busy
   * path presents and `continue`s before reaching here, and a latched press
   * means no repaint is owed - which is why the latch is watched separately
   * rather than folded into the stall.
   */
  {
    const int64_t ui_now_us = esp_timer_get_time();
    if (ui_now_us - s_ui_report_us >= 1000000) {
      s_ui_report_us = ui_now_us;
      uint32_t ui_frames = 0;
      gfx_stats(&ui_frames, NULL);
      const bool frames_advanced = ui_frames != s_ui_last_frames;
      /* A playing wigglegram is the second screen that owes frames, and it
       * has to be counted or a photograph that stopped moving would read as
       * a settled screen. It is stated as "playback is running" rather than
       * "a frame is due on THIS pass", which is the only truthful form at
       * this resolution: the check is once a second, a frame falls every
       * 66-200 ms, and sampling the deadline would answer false on five
       * passes out of six while the screen was in fact painting eight times
       * a second. A photograph that is NOT playing - still loading, one
       * frame, a quad - owes nothing and says so. */
      /* A playing wigglegram owes frames only while it is actually stepping.
       * Under a DELETE dialog or an in-flight capture wiggle_tick() pauses -
       * s_wig_play stays set so the swing resumes in place, but nothing is due
       * and nothing comes out, so a paused photo must read as owing nothing or
       * the health watch calls the pause a stall (#161: paused owes none). */
      const bool wig_presenting = s_screen == SCR_PHOTO && s_wig_play &&
                                  s_dialog == DLG_NONE && cstage == CAPTURE_IDLE;
      const bool present_due = held == -1 && (s_screen == SCR_SHOOT || wig_presenting);
      const bool latched = held != -1 || s_pressed != -1;
      switch (ui_health_step(&health, present_due, frames_advanced, latched)) {
        case UI_HEALTH_STALLED:
          klog("P4", "ui STALLED on screen %d - a frame was due, frames stuck at %lu",
               (int)s_screen, (unsigned long)ui_frames);
          break;
        case UI_HEALTH_PRESENTING:
          klog("P4", "ui presenting again on screen %d, frames %lu", (int)s_screen,
               (unsigned long)ui_frames);
          break;
        case UI_HEALTH_STALL_ENDED:
          klog("P4", "ui stall over on screen %d without a frame - nothing owed now",
               (int)s_screen);
          break;
        case UI_HEALTH_LATCH_STUCK:
          klog("P4", "ui press latched %d s on screen %d (held %d pressed %d) - no lift",
               PURE_UI_LATCH_TICKS, (int)s_screen, held, s_pressed);
          break;
        case UI_HEALTH_LATCH_CLEARED:
          klog("P4", "ui press released on screen %d", (int)s_screen);
          break;
        case UI_HEALTH_QUIET:
          break;
      }
      /* Published for ui_liveness(), so a host reading GET_RUNTIME_STATS gets
       * the same latched answer as the klog rather than having to find the
       * line in a ring that may already have rolled past it. */
      s_ui_stalled = health.stalled;
      s_ui_last_frames = ui_frames;
    }
  }

  if (s_screen == SCR_SHOOT && held == -1) {
    draw_screen();
    gfx_present();
    /* Paced against the link, not the panel: new frames arrive a few times
     * a second at best - unless something on the picture is moving. */
    return mo_any_live() ? MO_FRAME_MS : 60;
  }
  /* An animation in flight owes a frame at the motion cadence; the redraw
   * that steps it happens on the next pass, from the same place a busy
   * screen repaints. */
  if (mo_any_live()) {
    draw_screen();
    gfx_present();
    return MO_FRAME_MS;
  }
  return 20;
}

static void ui_task(void *arg) {
  (void)arg;
  ui_boot();
  for (;;) vTaskDelay(pdMS_TO_TICKS(ui_pass()));
}

esp_err_t ui_start(void) {
  if (!display_ready()) return ESP_ERR_INVALID_STATE;

  esp_err_t err = gfx_init();
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "compositor unavailable: %s", esp_err_to_name(err));
    return err;
  }
  s_cv = gfx_canvas();

  /* The queue exists before the handler is registered, or a press arriving
   * between the two would be dropped by on_button's NULL guard. */
  s_btn_q = xQueueCreate(4, sizeof(btn_event_t));
  if (s_btn_q == NULL) {
    /* Not fatal: the touch panel is the primary input and a camera with no
     * physical keys is what this body already is. Said out loud because a
     * silently dead shutter pin is exactly the ambiguity this fix removes. */
    ESP_LOGE(TAG, "no room for the button queue - physical keys will do nothing");
  }
  buttons_on_press(on_button);

  ESP_LOGI(TAG, "UI_READY %dx%d landscape via PPA", UI_W, UI_H);
  TaskHandle_t ui_h = NULL;
  /* 8192, not 6144. The ROLL screen calls qr_encode(), which puts roughly
   * 1.4 KB of bitfields and codeword buffers on this stack ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â two 456-byte
   * module grids plus 562 bytes of codewords ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â on top of whatever the draw
   * path already uses. That figure is CALCULATED from the sizes in qr.c, not
   * measured on a board, so the margin is deliberate: an overflow here would
   * land on a repaint and read as a display or touch fault rather than as a
   * QR encoder. Confirm against GET_RUNTIME_STATS on the first bench run that
   * opens the ROLL screen with a Roll assigned ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â that is what the per-task
   * high-water figure is for. */
  /*
   * Pinned to CPU1, away from the link interrupts.
   *
   * gfx_present() does a blocking PPA rotate and a DPI handoff over two
   * 768 KB PSRAM framebuffers, and the cache maintenance underneath runs
   * inside a critical section - interrupts off on the running core for 1-2 ms
   * while it writes back up to 256 KB of L2. The UART RX FIFO is 128 bytes,
   * which at 921600 baud is 1.39 ms, so a present that lands on the core
   * owning the link ISRs overruns the FIFO and the frame in flight is lost.
   *
   * That is what made captures fail while CAMERA_TEST passed over the same
   * wire: capture_fire sets s_stage, the loop below treats a capture as
   * "busy" and presents every 60-90 ms for the whole transfer, and
   * CAMERA_TEST - which never touches s_stage - presents nothing at all. The
   * arithmetic matches what the bench saw: 14-73 bytes lost past a 128-byte
   * FIFO is a 1.5-2.2 ms window, far too short for a flash erase and exactly
   * a cache writeback.
   *
   * camlink_init() runs from app_main on CPU0, so the link ISRs are there.
   * Keeping the compositor on CPU1 lets both run at full rate instead of
   * trading the preview against the shutter.
   */
  /* Checked, like capture.c does. A UI task that was never created leaves a
   * board that boots, logs UI_READY and then shows a splash for ever - which
   * reads as a display or touch fault rather than as an out-of-memory. */
  if (xTaskCreatePinnedToCore(ui_task, "ui", 8192, NULL, 4, &ui_h, 1) != pdPASS) {
    ESP_LOGE(TAG, "no room for the ui task");
    return ESP_ERR_NO_MEM;
  }
  taskmon_register("ui", ui_h);

  return ESP_OK;
}
