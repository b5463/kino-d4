#include "ui.h"

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
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
/* The photograph on its own screen: 600x450 centred, the one line under it. */
#define PH_W 600
#define PH_H 450
#define PH_TOP 0
#define PH_X0 ((UI_W - PH_W) / 2)
#define PH_LINE_Y (PH_H + 6)

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
  screen_t home;
} mode_def_t;

static const mode_def_t MODES[MODE_COUNT] = {
    {SCR_SHOOT}, {SCR_GALLERY}, {SCR_LOOK}, {SCR_CONNECTION}, {SCR_SETTINGS},
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

static int s_pressed = -1;      /* held item index, -1 for none */
static dialog_t s_dialog = DLG_NONE;
static int s_dlg_focus;          /* 0 = safe action, 1 = the other one */
static int64_t s_shot_seen_us;
/* shoot.displayAfterShotS = -1: the report is up and waiting to be dismissed
 * by a touch or a key rather than by a timer. See shot_hold_ack(). */
static bool s_shot_hold;
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

/* The clip rect every primitive honours: the whole screen unless a node's
 * mask has narrowed it for the node being drawn. */
static int s_clip_x0 = 0, s_clip_y0 = 0, s_clip_x1 = UI_W, s_clip_y1 = UI_H;

static inline void px_set(int x, int y, uint16_t c) {
  if ((unsigned)x < UI_W && (unsigned)y < UI_H) s_cv[(size_t)y * UI_W + x] = c;
}

static void fill(int x, int y, int w, int h, uint16_t colour) {
  if (x < s_clip_x0) { w -= s_clip_x0 - x; x = s_clip_x0; }
  if (y < s_clip_y0) { h -= s_clip_y0 - y; y = s_clip_y0; }
  if (x + w > s_clip_x1) w = s_clip_x1 - x;
  if (y + h > s_clip_y1) h = s_clip_y1 - y;
  if (w <= 0 || h <= 0) return;
  for (int r = 0; r < h; r++) {
    uint16_t *row = s_cv + (size_t)(y + r) * UI_W + x;
    for (int i = 0; i < w; i++) row[i] = colour;
  }
}

/**
 * Blend `b` over `a` by k/256.
 *
 * Rounded, not truncated. An arithmetic shift of a negative product floors,
 * so a channel going down moved a whole 5-bit step for any k at all while the
 * same channel going up did not move until k earned it. Every faint blend in
 * the interface was therefore a little darker than it asked for, and a stack
 * of nearly-invisible ones - four fragments and their ghosts, say - left a
 * grey block on the picture. The +128 makes both directions round to nearest,
 * which costs nothing and means alpha 1 of 255 changes nothing at all.
 */
static uint16_t mix(uint16_t a, uint16_t b, int k) {
  const int ar = (a >> 11) & 0x1F, ag = (a >> 5) & 0x3F, ab = a & 0x1F;
  const int br = (b >> 11) & 0x1F, bg = (b >> 5) & 0x3F, bb = b & 0x1F;
  const int r = ar + (((br - ar) * k + 128) >> 8);
  const int g = ag + (((bg - ag) * k + 128) >> 8);
  const int bl = ab + (((bb - ab) * k + 128) >> 8);
  return (uint16_t)((r << 11) | (g << 5) | bl);
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
  for (int y = y0 < s_clip_y0 ? s_clip_y0 : y0; y < y1 && y < s_clip_y1; y++) {
    uint16_t *row = s_cv + (size_t)y * UI_W;
    const float dy = (float)y + 0.5f - cy;
    for (int x = x0 < s_clip_x0 ? s_clip_x0 : x0; x < x1 && x < s_clip_x1; x++) {
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
#include "kmo.h"
#include "kdraw.h"
#include "kscene.h"
#include "kbehave.h"
#include "ksense.h"
#include "kmood.h"

/* Said by the plumbing, defined by the presentation (ui_present.h). */
static void ui_note(const char *text);
static void toast(const char *s);

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

/* The finder names the look the way FILTER does, through fl_current(), which
 * lives with the look plumbing below; one lookup, so two screens cannot
 * disagree about which look is loaded. */
static bool look_current_id(char *out, size_t cap);

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
    ui_note("NO LOOKS");
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


/** The look's number in the list (1-based) and its two names. */
static void fl_current(char *num, size_t ncap, char *jp, size_t jcap, char *en, size_t ecap, char *id_out,
                       size_t idcap) {
  char cur[KDP_RECIPE_ID_MAX];
  const bool single = look_current_id(cur, sizeof cur);
  if (id_out) snprintf(id_out, idcap, "%s", single ? cur : "");
  if (!single) {
    snprintf(num, ncap, "C--");
    snprintf(jp, jcap, "MIXED");
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
  snprintf(jp, jcap, "%s", name[0] ? name : cur);
  snprintf(en, ecap, "%s", name[0] ? name : cur);
  upcase(en);
}

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
    ui_note("CARD BUSY");
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
    ui_note("CANNOT SAVE");
    audio_warning();
    return;
  }
  s_photo_fav = want;
  klog("P4", "favourite %s %s", s_photo_id, want ? "on" : "off");
  /* So the tile behind this screen carries the mark when the user goes back.
   * The refresh is a card rescan on the gallery task, not work done here. */
  gallery_refresh();
  ui_note(want ? "FAVOURITE" : "UNMARKED");
}

static int s_ph_del_x0, s_ph_del_x1, s_ph_fav_x0, s_ph_fav_x1;

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
static const char *const SECS_15[3] = {"15 s", "30 s", "60 s"};
static const char *const SECS_60[3] = {"1 min", "2 min", "5 min"};

/* shoot.displayAfterShotS, including the -1 that means HOLD - the result
 * screen stays until it is acknowledged. Written as the contract's own values
 * so the row and the setting cannot drift apart. */
static const int SHOT_S[5] = {0, 1, 2, 3, -1};
static const char *const SHOT_NAMES[5] = {"OFF", "1 s", "2 s", "3 s", "HOLD"};

/* body.camIdleTimeoutS: how long before the camera bank is powered down.
 * 0 is NEVER, which is the contract's own encoding, not a sentinel invented
 * here - so NEVER is a value like the other two and not a missing setting. */
static const int IDLE_S[3] = {60, 300, 0};
static const char *const IDLE_NAMES[3] = {"1 min", "5 min", "NEVER"};

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

/* --- Storage ------------------------------------------------------ */

/* The two live rows on the storage screen, in the order they are drawn. DELETE
 * ALL PHOTOS is above FORMAT CARD because it is the one someone actually
 * wants: it clears the pictures and leaves the sounds, the looks, the config
 * and the upload queue alone, where FORMAT takes everything. */
#define ST_IT_DELETE_ALL 0
#define ST_IT_FORMAT 1
#define ST_IT_COUNT 2

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

/* ------------------------------------------------------------------ */
/* Power                                                               */
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
      *d = (dlg_spec_t){"RESTART", "RESTART?", "BACK IN A MOMENT.", "RESTART", false};
      break;
    case DLG_DELETE:
      snprintf(sub, sizeof sub, "%d FRAMES. CANNOT BE UNDONE.", s_photo_frames);
      *d = (dlg_spec_t){"DELETE", "DELETE THIS PHOTO?", sub, "DELETE", true};
      break;
    case DLG_DELETE_ALL:
      snprintf(sub, sizeof sub, "ALL %d. CANNOT BE UNDONE.", n);
      *d = (dlg_spec_t){"DELETE ALL", "DELETE EVERYTHING?", sub, "DELETE ALL", true};
      break;
    case DLG_FORMAT:
      snprintf(sub, sizeof sub, "ALL %d WILL GO.", n);
      *d = (dlg_spec_t){"FORMAT", "FORMAT THE CARD?", sub, "FORMAT", true};
      break;
    default:
      *d = (dlg_spec_t){"POWER", "SWITCH OFF?", "UNPLUG USB-C TO SWITCH OFF.", "OFF", false};
      break;
  }
}

/* The D4 interface. While it is being built it is compiled alongside the one
 * it replaces, so the host preview can draw both and the camera keeps
 * working; when the input paths move across, the old one goes. */
#ifdef KINO_D4
#include "d4_style.h"
#include "d4_ui.h"
#endif
#include "ui_present.h"
#ifdef KINO_PLAYGROUND
#include "ui_playground.h"
#endif

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
      if (y >= UI_H - 24 - UT_M.em - 14 && sh_words_showing()) {
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
      if (gallery_total() == 0 || s_gal_turning) return -1; /* not while a page is sliding */
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
  dialog_close();
  switch (d) {
    case DLG_RESTART:
      config_save();
      /* What the camera is doing, not a farewell. It said GOOD NIGHT and
       * then came straight back up, which reads as a shutdown that failed. */
      fill(0, 0, UI_W, UI_H, RGB(0x00, 0x00, 0x00));
      ut_mid(&UT_M, UI_W / 2, UI_H / 2 - UT_M.em / 2, "RESTARTING", C_INK);
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
        ui_note("CARD BUSY");
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
      ui_note("DELETED");
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
      ui_note("DELETING");
      break;
    case DLG_FORMAT:
      /* Not wired: there is no format entry point in storage.c, and calling
       * a delete loop over user captures under the name "format" would be a
       * different operation wearing the label. */
      ui_note("CANNOT FORMAT");
      break;
    default:
      ui_note("POWER IS USB-C");
      break;
  }
  draw_screen();
  gfx_present();
}

static void activate(int item) {
  if (s_dialog != DLG_NONE) {
    if (item == 1) dialog_commit();
    else {
      dialog_close();
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
          ui_note("CARD BUSY");
          audio_warning();
          break;
        }
        s_focus[SCR_PHOTO] = P_IT_DELETE;
        go(SCR_PHOTO, 0);
        return;
      }
      break;

    case SCR_PHOTO:
      if (item == P_IT_DELETE) {
        dialog_open(DLG_DELETE);
      } else if (item == P_IT_FAV) {
        photo_toggle_favourite();
      }
      break;

    case SCR_SETTINGS:
      if (item >= 0 && item < 5) { go(SET_DEST[item], 0); return; }
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
          ui_note("NO PHOTOS");
          break;
        }
        dialog_open(DLG_DELETE_ALL);
      } else if (item == ST_IT_FORMAT) {
        /* Dimmed row; a press still lands here from the hit test. Say so
         * without a confirm dialog for a thing that cannot happen. */
        ui_note("CANNOT FORMAT");
      }
      break;

    case SCR_POWER:
      if (item == 0) { ui_note("POWER IS USB-C"); break; }
      if (item == 1) { dialog_open(DLG_RESTART); break; }
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
#ifdef KINO_D4
  d4_button(ev->id, ev->long_press);
  if (ev->id == BTN_SHUTTER) fire_shutter(ev->long_press);
  draw_screen();
  gfx_present();
  return;
#endif
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
  kb_seed((uint32_t)esp_timer_get_time() ^ (capture_count() * 2654435761u));
  /* Device memory: the first boot ever is set a little more slowly than every
   * boot after it, and the camera remembers which this is. */
  ui_identity();
  s_first_boot = !config_bool("body.booted", false);
  boot_show(s_first_boot);
  if (s_first_boot) cfg_set_bool("body.booted", true);
  s_visited[SCR_SHOOT] = true;
  s_screen = SCR_SHOOT;
  s_sh_show_ms = SH_SHOW_FIRST_MS;
  draw_screen();
  sh_reveal();
  draw_screen();
  gfx_present();
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
static int64_t s_slept_us = 0; /* when the panel went dark, for the long-idle wake */
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
  cap_watch();
  events_watch();

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
    /* Picked up again: a short doze says nothing, the screen just comes
     * back; after a long one the camera acknowledges the return, and the
     * session starts over for the once-per-session behaviours. */
    ksense_reset(); /* the room may be somewhere else entirely now */
    s_idle_before_us = s_slept_us ? esp_timer_get_time() - s_slept_us : 0;
    if (s_slept_us != 0 && s_idle_before_us >= LONG_SLEEP_US) {
      kb_new_session();
      s_session_shots = 0;
      ui_event(KEV_WAKE_LONG_IDLE);
      if (s_screen == SCR_SHOOT) { s_sh_show_ms = SH_SHOW_FIRST_MS; sh_reveal(); }
    } else {
      ui_event(KEV_WAKE);
    }
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
    {
      /* The world follows the finger from the moment the gesture is clearly
       * horizontal, not from the moment it is released. A drag that is mostly
       * vertical, or one on a screen that is not a mode's home, moves
       * nothing sideways. */
      const int dx = lx - g_down_x, dy = ly - g_down_y;
      const bool sideways = down && g_moved && (dx > 0 ? dx : -dx) > (dy > 0 ? dy : -dy) &&
                            s_dialog == DLG_NONE && !s_row_open &&
                            MODES[mode_of(s_screen)].home == s_screen;
      const float was = s_drag_dx;
      s_drag_dx = sideways ? (float)dx : 0.f;
      /* At the ends of the row there is nowhere to go, so the world resists
       * rather than travelling toward a state that does not exist. */
      const int cur = (int)mode_of(s_screen);
      if ((s_drag_dx > 0.f && cur == 0) || (s_drag_dx < 0.f && cur == MODE_COUNT - 1)) s_drag_dx *= 0.25f;
      s_drag_dir = s_drag_dx < 0.f ? 1 : s_drag_dx > 0.f ? -1 : 0;
      if (s_drag_dx != was) {
        draw_screen();
        gfx_present();
      }
    }
    if (!down && g_prev_down && g_moved) {
      const int dx = g_last_x - g_down_x, dy = g_last_y - g_down_y;
      const bool quick = now - g_down_us < 600000;
      const int gest_ms = (int)((now - g_down_us) / 1000);
      const float speed = gest_ms > 0 ? (float)(dx < 0 ? -dx : dx) / (float)gest_ms : 0.f;
      /* Committed either by travelling far enough or by being thrown hard
       * enough. A slow drag most of the way across counts; so does a flick
       * that never got there. */
      const bool committed = (dx > GEST_SWIPE || dx < -GEST_SWIPE) || speed > 1.4f;
      if (quick && committed && dy < GEST_RISE && dy > -GEST_RISE && s_dialog == DLG_NONE) {
        klog("P4", "swipe %d px in %d ms (%d px/s)", dx, gest_ms, (int)(speed * 1000.f));
        /* How fast the finger moved is an input, not a threshold that was
         * crossed: a flick and a drag should not settle identically. */
        kmood_gesture(speed);
        if (s_row_open) row_close();
        /* The world is already where the finger left it; the release only
         * chooses which state it is heading for and lends it the speed. */
        s_drag_dx = 0.f;
        mode_swipe_vel(dx < 0 ? 1 : -1, speed);
      } else if (quick && (dy > GEST_SWIPE || dy < -GEST_SWIPE) && dx < GEST_RISE && dx > -GEST_RISE &&
                 s_dialog == DLG_NONE && !s_row_open) {
        /* Up and down is the screen's own: the gallery turns its pages. */
        if (s_screen == SCR_GALLERY) gal_turn(dy < 0 ? 1 : -1);
      }
      g_moved = false;
      if (s_drag_dx != 0.f) {
        /* Not committed: the world simply comes back, from where it is. */
        s_drag_dx = 0.f;
        draw_screen();
        gfx_present();
      }
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
#ifdef KINO_D4
    /* A tap is a tap: where it landed, and nothing about how it got there. */
    held = -1;
    s_pressed = -1;
    d4_tap(lx, ly);
    draw_screen();
    gfx_present();
    return (int)MO_FRAME_MS;
#endif
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
  {
    /* The grids are a difference against the last look at the room, so they
     * are meaningless across a gap in which the cameras were not looking. */
    static bool vf_was_on;
    const bool vf_on = s_screen == SCR_SHOOT || s_screen == SCR_LOOK;
    if (vf_was_on && !vf_on) ksense_reset();
    vf_was_on = vf_on;
    viewfinder_run(vf_on);
  }

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
                    (s_screen == SCR_STORAGE && gallery_deleting());

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
  ks_init();
  s_kmo_sound = kmo_sound_cb;

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
