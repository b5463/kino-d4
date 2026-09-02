#include "ui.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "audio.h"
#include "buttons.h"
#include "cam_link.h"
#include "capture.h"
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
/* For media_favorite_set/get, and for kdp_device_serial() and
 * KDP_HARDWARE_REV, which is what the About screen's Serial and Hardware rows
 * are: the strings GET_DEVICE_INFO already answers. */
#include "kdp_server.h"
#include "kdp_sounds.h"
#include "klog.h"
#include "taskmon.h"
#include "icons.h"
#include "logo_kino_d4.h"
#include "meta.h"
#include "mesh3d.h"
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
#include "ui_font.h"
#include "ui_labels.h"

static const char *TAG = "ui";

#define CAPTURES_DIR "/sdcard/KINO/CAPTURES"

/* Written as real RGB and packed, rather than as opaque hex literals: a
 * palette nobody can read is a palette nobody will adjust. */
#define RGB(r, g, b) ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))

/*
 * What is left of packages/design-system/tokens.css, which is the single
 * Studio + Roll design system: the ACCENTS, and nothing structural.
 *
 * The file used to carry the whole of it - two dozen silver-blue chrome
 * tokens, four-stop control gradients, one-pixel borders - alongside the
 * Windows 98 system colours below, and drew some things with one set and some
 * with the other. That is what "half-way into a Windows 98 look" meant in
 * practice: two grammars in one file, and no rule saying which surface got
 * which. The chrome is now entirely W_*, and the tokens that described chrome
 * went with the code that used them.
 *
 * These five stayed because they are not chrome. They are the product's own
 * colours, used where a state has to be named rather than where a surface has
 * to be shaped: the four-frame mark, the capture strip's accent rule, the
 * favourite star, and the dark ground a thumbnail that will not decode sits
 * on. Those read the same in either grammar.
 */
#define C_CANVAS RGB(0xf7, 0xf8, 0xfa)  /* the icon sheet's ground, host preview only */
#define C_BLUE RGB(0x2f, 0x70, 0xc9)
#define C_GREEN RGB(0x48, 0xa8, 0x3e)
#define C_YELLOW RGB(0xf4, 0xc5, 0x42)
#define C_RED RGB(0xc8, 0x3a, 0x3a)
#define C_WELL RGB(0x26, 0x2e, 0x38)
#define C_OK C_GREEN
#define C_BAD C_RED

/* ------------------------------------------------------------------ */
/* Windows 98 system colours                                           */
/*                                                                     */
/* The device chrome is the 1998 desktop, not the silver-blue of        */
/* tokens.css. That is a deliberate divergence from the shared design   */
/* system - Studio and Roll stay as they are - and it is the point:     */
/* the camera is the object from the alternate 2001, and the software   */
/* that drives it is modern. These are the real system colours, not an  */
/* interpretation of them.                                             */
/* ------------------------------------------------------------------ */
#define W_FACE RGB(0xc0, 0xc0, 0xc0)    /* 3D face - the ground for everything */
#define W_HILITE RGB(0xff, 0xff, 0xff)  /* 3D highlight - outer top/left */
#define W_LIGHT RGB(0xdf, 0xdf, 0xdf)   /* 3D light - inner top/left */
#define W_SHADOW RGB(0x80, 0x80, 0x80)  /* 3D shadow - inner bottom/right */
#define W_DKSHAD RGB(0x0a, 0x0a, 0x0a)  /* 3D dark shadow - outer bottom/right */
#define W_WINDOW RGB(0xff, 0xff, 0xff)  /* window/list ground */
#define W_TEXT RGB(0x00, 0x00, 0x00)
#define W_GRAYTEXT RGB(0x80, 0x80, 0x80)
#define W_SEL RGB(0x00, 0x00, 0x80)     /* selection navy */
#define W_SELTEXT RGB(0xff, 0xff, 0xff)
#define W_TITLE_L RGB(0x00, 0x00, 0x80) /* active title bar, left stop */
#define W_TITLE_R RGB(0x10, 0x84, 0xd0) /* active title bar, right stop */
/* Tooltip ground - the system's INFOBK, which is what a transient message sat
 * on in 1998: pale yellow, one black hairline, black text. Not a bevel and not
 * a window, because a tooltip is neither. */
#define W_INFO RGB(0xff, 0xff, 0xe1)
/* The selection navy with an edge on it, for the one raised surface on the
 * interface that is not face grey: the storage gauge's fill. A raised edge
 * needs a lighter and a darker tone of its own face, and mixing them at the
 * call site would put two magic numbers in a draw path. */
#define W_SEL_LT RGB(0x40, 0x40, 0xa8)
#define W_SEL_DK RGB(0x00, 0x00, 0x40)

/* Dark chrome, for the shoot and photograph views. */
#define D_GROUND RGB(0x14, 0x18, 0x1e)
#define D_PANE RGB(0x22, 0x26, 0x2c)
#define D_EDGE RGB(0x3a, 0x42, 0x4c)
#define D_TEXT RGB(0xd7, 0xdd, 0xe2)
#define D_DIM RGB(0x6a, 0x74, 0x82)

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

/* Main menu: a launcher of six bevelled tiles over a status bar.
 *
 * The two lines at the foot - the wordmark and where the power is coming from -
 * were floating silkscreen in the margin, which is what an unfinished theme
 * looks like. They are the same two facts, in the window-bottom strip the era
 * put exactly this kind of passive reading in, with a sunken panel round each
 * so the pair reads as a status bar rather than as two stray captions. Nothing
 * was added: there is still no battery percentage, because there is still no
 * gauge on this body to read one from.
 *
 * The strip costs 36 px of grid height, which came out of the margins rather
 * than the tiles - 24 px of outer margin and 16 px of gap was a grid designed
 * to hold six loose objects apart, and tiles need the opposite. 13 and 12
 * divide 800 exactly three ways at 250 px, so the row is symmetric to the pixel
 * instead of one short on the right.
 *
 * tile_rect() and hit_test()'s SCR_MENU branch both derive from these, so the
 * touch rectangles move with the tiles by construction.
 */
#define M_STATUS_H 34
#define M_STATUS_Y (UI_H - 2 - M_STATUS_H) /* clear of the window frame */
#define M_MARGIN 13
#define M_GAP 12
#define M_COLS 3
#define M_ROWS 2
#define M_TILE_W ((UI_W - 2 * M_MARGIN - (M_COLS - 1) * M_GAP) / M_COLS)  /* 250 */
#define M_TILE_H ((M_STATUS_Y - 2 * M_MARGIN - (M_ROWS - 1) * M_GAP) / M_ROWS)  /* 205 */
#define M_LABEL_H 24
#define M_STACK (ICON_BOX + 10 + M_LABEL_H)  /* icon, air, label */

/* The artwork cache is captured over bare face grey and blitted back onto the
 * tile face, which is the same colour - so the block has to stay clear of the
 * tile's own bevel or the blit would paint face grey over it. Checked here
 * rather than noticed on a panel: MT_H is 156 and the stack is centred, so the
 * clearance is (M_TILE_H - M_STACK) / 2 + ICON_BOX / 2 - MT_H / 2 px at the
 * top, and a pressed tile spends one of them. */
_Static_assert((M_TILE_H - M_STACK) / 2 + ICON_BOX / 2 - (ICON_BOX + 12) / 2 >= 4,
               "the cached menu artwork overlaps the tile bevel");
_Static_assert(M_MARGIN + M_ROWS * M_TILE_H + (M_ROWS - 1) * M_GAP < M_STATUS_Y,
               "the menu grid runs into the status bar");

/* The filtered artwork, kept between repaints.
 *
 * The composite filter is horizontal-only, and the menu ground is neutral
 * #C0C0C0 where I and Q are zero. So filtering "icon composited on grey" as
 * a block gives bit-for-bit the same pixels as filtering that region of the
 * whole screen - there is nothing either side of it that could bleed in.
 * Which means it can be done once and kept, instead of on every press.
 *
 * Measured: 78 ms per repaint before, and a tap repaints twice. */
#define MT_W (ICON_BOX + 20)
#define MT_H (ICON_BOX + 12)
static uint16_t *s_mcache[6];
static bool s_mcached;

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
/* SHOOT: the four streams, edge to edge, one way out, and one strip of facts.
 *
 * Four panes of exactly a quarter of the screen. No gap, no keyline, no margin
 * between them - a viewfinder is for looking through, and every line drawn
 * across it is a line between you and the room.
 *
 * The two things that ARE drawn on it are anchored to the edges and to
 * nothing else: the MENU button in the top-left corner, and a 34 px status bar
 * along the foot: 27 200 px of bar and 5104 of button, 8% of the panel between
 * them, and none of it in the middle.
 * That is the price of a finder that can say how it is set, and it was worth
 * paying: the version that drew nothing sent you to another screen to find out
 * whether the flash was on.
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
 * show someone a 208 px thumbnail blown up to half the screen. */
/*
 * The photo screen, laid out so nothing lands on anything else.
 *
 * It used to overlap: a 390 px image at y=22 ended at 412, the caption sat at
 * 422 and the DELETE / SEND TO ROLL row started at 434, so the caption ran
 * into the buttons and the picture crowded them from above. 4:3 is kept - the
 * sensor's aspect - so the frame is not distorted to make room.
 *
 * The arithmetic is checked below rather than trusted, because every one of
 * these was a loose number in the draw code and the overlap was invisible
 * until someone opened a photograph on the bench.
 */
#define PH_W 464
#define PH_H 348
#define PH_TOP 40       /* clear of the BACK chevron at y=14 */
#define PH_BTN_H 34
#define PH_BTN_GAP 18   /* below the buttons, to the bottom edge */
#define PH_BTN_Y (UI_H - PH_BTN_H - PH_BTN_GAP)
#define PH_CAP_Y (PH_TOP + PH_H + 12) /* caption, between picture and buttons */
/* Three controls now, evenly across the width of the picture. Written as
 * arithmetic rather than three literals because draw_photo() and hit_test()
 * both walk it, and the two used to carry different widths - 150 drawn
 * against 150 tested only by luck. */
#define PH_X0 ((UI_W - PH_W) / 2)
#define PH_BTN_SP 14
#define PH_BTN_W ((PH_W - 2 * PH_BTN_SP) / 3)
#define PH_BTN_X(i) (PH_X0 + (i) * (PH_BTN_W + PH_BTN_SP))

_Static_assert(PH_TOP + PH_H < PH_CAP_Y, "photo overlaps its caption");
_Static_assert(PH_CAP_Y + 16 <= PH_BTN_Y, "caption overlaps the buttons");
_Static_assert(PH_BTN_Y + PH_BTN_H < UI_H, "buttons fall off the bottom");
_Static_assert(PH_W * 3 == PH_H * 4, "photo pane is not 4:3");

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

/* Index into UI_LABELS, whose order is fixed by tools/mktext.mjs. */
typedef enum {
  T_LOOK = 0, T_GALLERY, T_ROLL, T_SETTINGS, T_POWER,
  T_PHOTO, T_DISPLAY, T_SOUND, T_CONNECTION, T_STORAGE, T_ABOUT,
} title_t;

static const int SCREEN_TITLE[SCR_COUNT] = {
    [SCR_MENU] = -1, [SCR_SHOOT] = -1,
    [SCR_LOOK] = T_LOOK, [SCR_GALLERY] = T_GALLERY,
    [SCR_PHOTO] = T_PHOTO, [SCR_ROLL] = T_ROLL, [SCR_SETTINGS] = T_SETTINGS,
    [SCR_DISPLAY] = T_DISPLAY, [SCR_SOUND] = T_SOUND, [SCR_CONNECTION] = T_CONNECTION,
    [SCR_STORAGE] = T_STORAGE, [SCR_ABOUT] = T_ABOUT, [SCR_POWER] = T_POWER,
};

/* Where Back goes. One level, always, and never to a remembered screen. */
static const screen_t SCREEN_PARENT[SCR_COUNT] = {
    [SCR_MENU] = SCR_MENU, [SCR_SHOOT] = SCR_MENU,
    [SCR_LOOK] = SCR_MENU, [SCR_GALLERY] = SCR_MENU,
    [SCR_PHOTO] = SCR_GALLERY, [SCR_ROLL] = SCR_MENU, [SCR_SETTINGS] = SCR_MENU,
    [SCR_DISPLAY] = SCR_SETTINGS, [SCR_SOUND] = SCR_SETTINGS,
    [SCR_CONNECTION] = SCR_SETTINGS, [SCR_STORAGE] = SCR_SETTINGS,
    [SCR_ABOUT] = SCR_SETTINGS, [SCR_POWER] = SCR_MENU,
};

/* The six menu tiles, in grid order, and where each one goes. */
static const screen_t MENU_DEST[6] = {
    SCR_SHOOT, SCR_LOOK, SCR_GALLERY, SCR_ROLL, SCR_SETTINGS, SCR_POWER,
};
static const char *const MENU_LABEL[6] = {
    "SHOOT", "LOOK", "GALLERY", "ROLL", "SETTINGS", "POWER",
};

typedef enum {
  DLG_NONE = 0,
  DLG_SHUTDOWN,
  DLG_RESTART,
  DLG_DELETE,
  DLG_DELETE_ALL,
  DLG_FORMAT
} dialog_t;

static uint16_t *s_cv;
static screen_t s_screen = SCR_MENU;
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

static void outline(int x, int y, int w, int h, uint16_t c) {
  fill(x, y, w, 1, c);
  fill(x, y + h - 1, w, 1, c);
  fill(x, y, 1, h, c);
  fill(x + w - 1, y, 1, h, c);
}

/* ------------------------------------------------------------------ */
/* Windows 98 chrome                                                   */
/*                                                                     */
/* One geometry, three faces, and everything raised, sunken or etched   */
/* on this interface goes through it.                                   */
/*                                                                     */
/* The two-pixel 3D edge is the whole language. Raised: white outside   */
/* and #DFDFDF inside on the top and left, near-black outside and       */
/* #808080 inside on the bottom and right. Sunken swaps them. Etched -  */
/* what a group box and a status panel divider are - is sunken outside  */
/* and raised inside, which is a groove rather than a step: one dark    */
/* line and one light line offset by a pixel.                           */
/*                                                                     */
/* Four colours, two pixels, no gradient anywhere. It is why a 1998     */
/* control reads as a physical thing while a single-pixel outline reads  */
/* as a diagram - and why writing it out by hand at each call site,     */
/* which is how this file arrived, produced surfaces that disagreed     */
/* with each other by a pixel.                                          */
/* ------------------------------------------------------------------ */

/**
 * The two-pixel edge, with its four tones given explicitly.
 *
 * Only the three wrappers below should call this. It exists as a separate
 * function because the dark chrome on the photograph view needs the same
 * geometry in its own tones, and the alternative was a fourth copy of the
 * eight fills.
 */
static void bevel4(int x, int y, int w, int h, uint16_t o_tl, uint16_t i_tl, uint16_t o_br,
                   uint16_t i_br) {
  fill(x, y, w, 1, o_tl);
  fill(x, y, 1, h, o_tl);
  fill(x, y + h - 1, w, 1, o_br);
  fill(x + w - 1, y, 1, h, o_br);
  fill(x + 1, y + 1, w - 2, 1, i_tl);
  fill(x + 1, y + 1, 1, h - 2, i_tl);
  fill(x + 1, y + h - 2, w - 2, 1, i_br);
  fill(x + w - 2, y + 1, 1, h - 2, i_br);
}

/** A surface standing off the ground: a button, a tile, a window, a bar. */
static void bevel_raised(int x, int y, int w, int h) {
  bevel4(x, y, w, h, W_HILITE, W_LIGHT, W_DKSHAD, W_SHADOW);
}

/** A surface set into the ground: a well, a trough, a pressed control. */
static void bevel_sunken(int x, int y, int w, int h) {
  bevel4(x, y, w, h, W_SHADOW, W_DKSHAD, W_HILITE, W_LIGHT);
}

/** Sunken, in the dark chrome's tones. The photograph sits in a well too. */
static void bevel_sunken_dark(int x, int y, int w, int h) {
  bevel4(x, y, w, h, RGB(0x08, 0x0a, 0x0d), D_GROUND, D_EDGE, RGB(0x2c, 0x33, 0x3c));
}

/**
 * A groove: sunken outside, raised inside.
 *
 * `gap_x`/`gap_w` cut a hole in the TOP pair only, which is where a group
 * box's legend goes - the frame runs behind the words on both sides of them
 * and the ground shows through between. Pass a zero width for a plain groove,
 * which is what a status bar divider is.
 */
static void bevel_etched(int x, int y, int w, int h, int gap_x, int gap_w) {
  /* Left and right first, so the top pair can be drawn as up to two runs
   * without either of them having to know where the sides are. */
  fill(x, y, 1, h, W_SHADOW);
  fill(x + 1, y + 1, 1, h - 2, W_HILITE);
  fill(x + w - 1, y, 1, h, W_HILITE);
  fill(x + w - 2, y + 1, 1, h - 2, W_SHADOW);
  fill(x, y + h - 1, w, 1, W_HILITE);
  fill(x + 1, y + h - 2, w - 2, 1, W_SHADOW);

  const int gl = gap_w > 0 ? gap_x - x : w;         /* the run left of the gap */
  const int gr = gap_w > 0 ? (x + w) - (gap_x + gap_w) : 0;
  if (gl > 0) {
    fill(x, y, gl, 1, W_SHADOW);
    fill(x + 1, y + 1, gl > 1 ? gl - 1 : 0, 1, W_HILITE);
  }
  if (gr > 0) {
    fill(gap_x + gap_w, y, gr, 1, W_SHADOW);
    fill(gap_x + gap_w, y + 1, gr - 1, 1, W_HILITE);
  }
}

/** A push button: face fill, raised edge, and the whole face pushed in when
 * held. The label shifts a pixel down and right with it, which is most of
 * what makes a press feel mechanical. */
static void button(int x, int y, int w, int h, bool down) {
  fill(x, y, w, h, W_FACE);
  if (down) bevel_sunken(x, y, w, h);
  else bevel_raised(x, y, w, h);
}

/** A white well: what everything that is read rather than pressed sits in. */
static void well(int x, int y, int w, int h) {
  fill(x, y, w, h, W_WINDOW);
  bevel_sunken(x, y, w, h);
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
 * The dotted focus rectangle, inset inside the control it belongs to.
 *
 * On the odd pixels, because the alternating dots are what say "keyboard
 * focus" rather than "selected" - and the ink is a parameter because half the
 * focusable things on this interface are white type on the selection navy,
 * where a black dotted rectangle is invisible.
 */
static void focus_rect(int x, int y, int w, int h, uint16_t ink) {
  for (int i = 0; i < w; i += 2) {
    px_set(x + i, y, ink);
    px_set(x + i, y + h - 1, ink);
  }
  for (int i = 0; i < h; i += 2) {
    px_set(x, y + i, ink);
    px_set(x + w - 1, y + i, ink);
  }
}

/** The standard focus mark: 3 px inside the control, in whichever ink reads. */
static void focus_inset(int x, int y, int w, int h, uint16_t ink) {
  focus_rect(x + 3, y + 3, w - 6, h - 6, ink);
}

/**
 * The title bar's left-to-right ramp, ordered-dithered.
 *
 * The bar used to be one fill() per column through mix(), which interpolates
 * inside RGB565 - so navy to #1084D0 across 790 px got 10 distinct blues and
 * 3 reds, and the result was a dozen visible vertical bands rather than a
 * ramp. At 4x magnification it reads as a staircase, which is the one thing a
 * title bar must not do: it is the largest flat area on every screen.
 *
 * Dithering, not a wider palette, because the panel has no wider palette. A
 * 4x4 Bayer threshold added to each channel before the 5/6/5 truncation
 * scatters the quantisation error over a 4 px cell, and at this viewing
 * distance the eye integrates it into the intermediate colour that does not
 * exist. It is also exactly what the era did - every gradient on a 256-colour
 * display in 1998 was a dither pattern, and the artefact is period-correct
 * rather than merely tolerable.
 *
 * Cost: it writes the same 790 x 54 = 42 660 pixels the old per-column fill()
 * loop wrote, and clips the rectangle once rather than bounds-testing every
 * pixel, so the extra work is a table lookup, three adds and a pack per pixel
 * over what was there before. That is about a ninth of what crt_rect() already
 * does on the menu's labels on every single repaint, and it happens once per
 * draw on screens that only repaint at 20 ms while a finger is down. Nothing
 * is allocated and nothing but four ints goes on the stack.
 */
static void grad_h(int x, int y, int w, int h, uint16_t left, uint16_t right) {
  static const uint8_t BAYER[4][4] = {
      {0, 8, 2, 10}, {12, 4, 14, 6}, {3, 11, 1, 9}, {15, 7, 13, 5},
  };
  /* Clipped like fill(), and the ramp is measured on the ORIGINAL rectangle:
   * a bar half off the left edge has to show the second half of its gradient,
   * not a fresh one squeezed into what is left. No caller does that today; the
   * alternative is a helper that is only correct for the callers it has. */
  const int span = w;
  int skip = 0;
  if (x < 0) { w += x; skip = -x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > UI_W) w = UI_W - x;
  if (y + h > UI_H) h = UI_H - y;
  if (w <= 0 || h <= 0 || span <= 0) return;

  /* Unpacked to 8 bits once, so the per-pixel work is an add and a pack. */
  const int lr = ((left >> 11) & 0x1F) << 3, lg = ((left >> 5) & 0x3F) << 2, lb = (left & 0x1F) << 3;
  const int rr = ((right >> 11) & 0x1F) << 3, rg = ((right >> 5) & 0x3F) << 2,
            rb = (right & 0x1F) << 3;

  for (int col = 0; col < w; col++) {
    const int k = (col + skip) * 256 / span;
    const int r = lr + (((rr - lr) * k) >> 8);
    const int g = lg + (((rg - lg) * k) >> 8);
    const int b = lb + (((rb - lb) * k) >> 8);
    uint16_t *p = s_cv + (size_t)y * UI_W + x + col;
    for (int row = 0; row < h; row++, p += UI_W) {
      /* The threshold is scaled to the quantisation step of each channel:
       * eight levels for red and blue, four for green. Adding the same value
       * to all three would over-dither green and under-dither the other two. */
      const int t = BAYER[(y + row) & 3][(x + col) & 3];
      int dr = r + (t >> 1), dg = g + (t >> 2), db = b + (t >> 1);
      if (dr > 255) dr = 255;
      if (dg > 255) dg = 255;
      if (db > 255) db = 255;
      *p = RGB(dr, dg, db);
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

static int text_w(const ui_font_t *f, const char *s) {
  int w = 0;
  for (; *s; s++) {
    const int i = (unsigned char)*s - f->first;
    if (i < 0 || i >= f->count) continue;
    w += f->glyphs[i].adv;
  }
  return w;
}

static void text(const ui_font_t *f, int x, int y, const char *s, uint16_t ink) {
  for (; *s; s++) {
    const int i = (unsigned char)*s - f->first;
    if (i < 0 || i >= f->count) continue;
    const ui_glyph_t *g = &f->glyphs[i];
    draw_bits(g->bits, g->w, f->line_h, g->stride, x, y, 1, ink);
    x += g->adv;
  }
}

static void text_right(const ui_font_t *f, int x, int y, const char *s, uint16_t ink) {
  text(f, x - text_w(f, s), y, s, ink);
}

/*
 * The same face at an integer multiple.
 *
 * There are two faces in the build - UI_FONT_S at 18 rows and UI_FONT_M at 24 -
 * and neither is legible from across a room. Adding a third at 48 rows would
 * cost about 40 KB of flash for glyphs used by two screens, so the M face is
 * pixel-doubled instead: draw_bits() already takes a scale, it was simply never
 * passed anything but 1. Doubled bitmap type is blocky, which on a panel
 * imitating a 2001 device is the right kind of wrong - and it is what the ROLL
 * screen needs, where the number of photos waiting has to be readable at the
 * distance someone stands to hold the camera up.
 *
 * Integer scale only. A fractional one would need filtering, and a filtered
 * 1-bit glyph at this size reads as a smudge.
 */
static void text_scaled(const ui_font_t *f, int x, int y, const char *s, int scale,
                        uint16_t ink) {
  if (scale < 1) scale = 1;
  for (; *s; s++) {
    const int i = (unsigned char)*s - f->first;
    if (i < 0 || i >= f->count) continue;
    const ui_glyph_t *g = &f->glyphs[i];
    draw_bits(g->bits, g->w, f->line_h, g->stride, x, y, scale, ink);
    x += g->adv * scale;
  }
}

static void text_scaled_mid(const ui_font_t *f, int cx, int y, const char *s, int scale,
                            uint16_t ink) {
  text_scaled(f, cx - text_w(f, s) * scale / 2, y, s, scale, ink);
}

/**
 * The largest scale at which `s` fits `w` pixels, 1 or 2.
 *
 * Every string these screens set at scale 2 is user data - a roll name, a look
 * name - so none of them can be sized by eye at build time. Falling back to
 * scale 1 keeps a long name readable and inside its column; clipping it at
 * scale 2 would put half a word against a hard edge and look like a bug.
 */
static int fit_scale(const ui_font_t *f, const char *s, int w) {
  return text_w(f, s) * 2 <= w ? 2 : 1;
}

/**
 * `s` into `out`, cut to `w` pixels with an ellipsis when it did not fit.
 *
 * fit_scale() is the other half of this problem and only works where the
 * container can afford two type sizes. A status panel cannot: it is 18 rows
 * tall and the string in it is a look's name, which the wire contract allows
 * to be 40 characters - about 440 px, wider than the panel will ever be.
 *
 * Three dots rather than a hard cut, because a name that simply stops reads as
 * a truncated write rather than as a label too long for its box; and three
 * ASCII dots rather than a single ellipsis glyph, because the face is ASCII
 * 32..126. Both are what the era did.
 *
 * The chop is by character and re-measures each time - the face is
 * proportional, so there is no character width to divide by. At most 40
 * iterations over a string of at most 40 glyphs, and only when the name is
 * actually too long.
 */
static void text_fit(char *out, size_t cap, const ui_font_t *f, const char *s, int w) {
  snprintf(out, cap, "%s", s);
  if (text_w(f, out) <= w) return;
  const int budget = w - text_w(f, "...");
  size_t n = strlen(out);
  while (n > 0) {
    out[--n] = '\0';
    if (text_w(f, out) <= budget) break;
  }
  snprintf(out + n, cap - n, "...");
}

static void text_mid(const ui_font_t *f, int cx, int y, const char *s, uint16_t ink) {
  text(f, cx - text_w(f, s) / 2, y, s, ink);
}

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

/**
 * A lightning bolt, as row spans.
 *
 * The one glyph in the whole interface that had to be drawn rather than
 * sourced: the font is ASCII 32..126 and has no such character, and the
 * Windows 98 archive - which every other icon comes from - has no flash or
 * lightning asset at all. Everything else on screen is either type or an
 * original 1998 icon.
 */
static void bolt(int x, int y, int scale, uint16_t c) {
  static const uint8_t SPAN[14][2] = {
      {4, 4}, {3, 4}, {3, 4}, {2, 4}, {2, 4}, {1, 5}, {1, 7},
      {0, 6}, {0, 4}, {3, 3}, {2, 3}, {2, 2}, {1, 2}, {1, 1},
  };
  for (int r = 0; r < 14; r++)
    fill(x + SPAN[r][0] * scale, y + r * scale, SPAN[r][1] * scale, scale, c);
}

/* ------------------------------------------------------------------ */
/* The four-frame mark                                                 */
/*                                                                     */
/* The product's own glyph, and the one piece of the interface that is  */
/* neither Windows nor generic. Four cells, one per camera, in the      */
/* order the lenses sit on the bar.                                     */
/*                                                                     */
/* It appears wherever four frames are the subject: filling one by one  */
/* at boot, as the progress of a capture, and beside a capture in the   */
/* gallery. Always the same four cells, always left to right, so it     */
/* reads as one mark rather than four decorations.                      */
/* ------------------------------------------------------------------ */

typedef enum {
  FM_OFF = 0,  /* an empty cell - a frame not yet taken */
  FM_ON,       /* a frame in hand */
  FM_SPARK,    /* the moment it lands. KINO yellow, and only ever a moment */
  FM_LOST,     /* a camera that did not answer */
} fm_cell_t;

#define FM_GAP 6

/** Four cells of `cell` px, left to right, with `st[4]` their states. */
static void four_mark(int x, int y, int cell, const fm_cell_t *st, bool dark) {
  for (int i = 0; i < 4; i++) {
    const int cx = x + i * (cell + FM_GAP);
    uint16_t fill_c;
    switch (st[i]) {
      case FM_ON: fill_c = C_BLUE; break;
      case FM_SPARK: fill_c = C_YELLOW; break;
      case FM_LOST: fill_c = dark ? RGB(0x5a, 0x1e, 0x1e) : RGB(0xc8, 0x3a, 0x3a); break;
      default: fill_c = dark ? RGB(0x24, 0x2a, 0x32) : W_LIGHT; break;
    }
    fill(cx, y, cell, cell, fill_c);
    /* A one-pixel keyline, so an empty cell is still a cell rather than a
     * hole in the background. */
    outline(cx, y, cell, cell, dark ? RGB(0x60, 0x6a, 0x78) : W_SHADOW);
  }
}

/* A small solid chevron, ‹ or ›.
 *
 * chevron() below is the dark chrome's, 26 px and left-only. The font is ASCII
 * 32..126 and carries neither character, so the picker buttons, the header's
 * back button and a row that opens a screen get their own: six 2 px steps, one
 * shape, so all three read as one family. */
static void picker_arrow(int cx, int cy, bool right, uint16_t ink) {
  for (int i = 0; i < 6; i++) {
    const int x = right ? cx - 4 + i : cx + 3 - i;
    fill(x, cy - 5 + i, 2, 2, ink);
    fill(x, cy + 5 - i, 2, 2, ink);
  }
}

/**
 * The back mark on the header's system button.
 *
 * picker_arrow()'s shape at double the step and twice the thickness: 14x24
 * rather than 7x12. The small one was tried in the 44 px button first and
 * reads as a glyph that got lost in it - a system button's mark fills about a
 * third of its face, and at 7 px this filled a sixth. The header's old
 * chevron() was the opposite error at 26x28 in a 46 px box, which left 9 px of
 * air and looked like artwork that had not been sized for the button.
 *
 * Centred on (cx, cy) properly, unlike picker_arrow, because at a 4 px block
 * the 2 px of bottom-right overhang it ignores becomes visible.
 */
static void back_glyph(int cx, int cy, uint16_t ink) {
  const int n = 11, t = 4;
  for (int i = 0; i < n; i++) {
    const int x = cx - t / 2 + (n - 1) / 2 - i;
    fill(x, cy - t / 2 - (n - 1) + i, t, t, ink);
    fill(x, cy - t / 2 + (n - 1) - i, t, t, ink);
  }
}

/* A left-pointing chevron, drawn rather than set as a glyph: the font is ASCII
 * 32..126 and carries no such character. One caller left - the photograph -
 * where there is no button to put a small mark in and the glyph has to carry
 * the target on its own. The viewfinder used it for the same reason until it
 * got a real button; that leaves this shape on one screen, and if the
 * photograph ever gets a plate too it goes with it. */
static void chevron(int x, int cy, uint16_t ink) {
  for (int i = 0; i <= 12; i++) {
    fill(x + i, cy - i - 2, 3, 3, ink);
    fill(x + i, cy + i - 2, 3, 3, ink);
  }
}

/* ------------------------------------------------------------------ */
/* The glass                                                           */
/* ------------------------------------------------------------------ */

/**
 * Composite video, not a shadow mask.
 *
 * The first version of this drew scanlines and RGB phosphor stripes, which
 * are artefacts of an RGB monitor and the wrong ones entirely. What made a
 * period screen look the way it did - and what artists of the era actually
 * composed against - is the bandwidth split in the composite/RF signal
 * itself:
 *
 *   luma    Y     ~4.5 MHz    edges stay sharp
 *   chroma  I, Q  ~0.5 MHz    colour smears sideways, about 9x wider
 *
 * That asymmetry is the whole effect. A dithered checkerboard of two colours
 * has a large CHROMA delta and a small LUMA delta, so the colours average
 * into a third colour that is not in the palette while the shape stays
 * crisp. A black keyline against a light face has a large LUMA delta, so it
 * survives untouched. Artists used exactly this: luma deltas for detail,
 * chroma deltas for blending.
 *
 * Which is why it belongs on these icons in particular. Windows 98 shell
 * artwork is full of hand-placed two-colour dither, drawn for 256-colour
 * displays. Run it through a real chroma bandwidth limit and that dither
 * does what it was always meant to do: resolve into shading.
 *
 * Implemented as a horizontal-only separable filter in YIQ, per row, in
 * integer arithmetic. Vertical is deliberately untouched - composite
 * band-limits along the scan line, not across lines.
 */

/* One active line is about 52.6 us. Mapping the 800 px canvas onto it, the
 * smallest feature each band can carry is:
 *
 *   luma    1 / (2 * 4.5 MHz) = 111 ns  ->  ~1.7 px
 *   chroma  1 / (2 * 0.5 MHz) = 1.0 us  ->  ~15.2 px
 *
 * So chroma is CARRIED at one sample per eight pixels and interpolated back
 * up, which is what an encoder does rather than a trick to go faster - the
 * information is not in the signal to begin with. Averaging eight pixels
 * into one sample is itself a box filter of the right width; a [1 2 1] pass
 * over those samples rounds the roll-off off into a triangle about 24 px
 * wide at full resolution.
 *
 * The first version filtered chroma at full resolution with two nine-tap box
 * passes and a divide per tap. It measured 293 ms for one screen, which on a
 * menu that repaints when a tile is pressed is half a second of lag on every
 * touch. Same output, none of the divides. */
/* Chroma carried at one sample per four pixels. Averaging four is a box of
 * 4, and the [1 2 1] over those samples convolves it into a triangle about
 * 12 px wide - the right order for a 15 px chroma feature. Eight was tried
 * first and bleeds visibly too far: a navy plate smeared twenty pixels into
 * the grey, which is a fault, not a period effect. */
#define CH_SUB 4
#define CH_N (UI_W / CH_SUB)

static int16_t s_cy[UI_W];
/* Two guard samples each side so the interpolation and the [1 2 1] never
 * index off the end, and the edge value simply repeats. */
static int16_t s_ci[CH_N + 4], s_cq[CH_N + 4];
static int16_t s_ci2[CH_N + 4], s_cq2[CH_N + 4];

/**
 * Band-limit one rectangle of the canvas the way a composite encoder does.
 *
 * Only the parts of a screen that carry colour need this: on a neutral grey
 * ground I and Q are zero and luma is flat, so the filter is arithmetically
 * the identity and running it there is work for nothing.
 *
 * Built at -O2 against the project's -Og. This is the only function in the
 * firmware that touches every pixel of a region on a user action, and -Og
 * costs it a factor of three - the difference between a menu that answers a
 * press and one that thinks about it first. The rest of the build stays
 * debuggable, which is what -Og is for.
 */
__attribute__((optimize("O2"))) static void crt_rect(int rx, int ry, int rw, int rh) {
  if (rx < 0) { rw += rx; rx = 0; }
  if (ry < 0) { rh += ry; ry = 0; }
  if (rx + rw > UI_W) rw = UI_W - rx;
  if (ry + rh > UI_H) rh = UI_H - ry;
  if (rw <= 0 || rh <= 0) return;

  const int cn = (rw + CH_SUB - 1) / CH_SUB;

  for (int y = ry; y < ry + rh; y++) {
    uint16_t *row = s_cv + (size_t)y * UI_W + rx;

    /* Luma at full resolution, chroma accumulated in blocks of eight. */
    int rs = 0, gs = 0, bs = 0, k = 0;
    for (int x = 0; x < rw; x++) {
      const uint16_t p = row[x];
      const int r = ((p >> 11) & 0x1F) << 3;
      const int g = ((p >> 5) & 0x3F) << 2;
      const int b = (p & 0x1F) << 3;
      s_cy[x] = (int16_t)((306 * r + 601 * g + 117 * b) >> 10);
      rs += r;
      gs += g;
      bs += b;
      if ((x & (CH_SUB - 1)) == CH_SUB - 1 || x == rw - 1) {
        /* >>10 rather than >>8: four samples summed, and I and Q are kept
         * at 4x so the low-pass has something left below the shift. */
        s_ci[k + 2] = (int16_t)((610 * rs - 281 * gs - 329 * bs) >> 10);
        s_cq[k + 2] = (int16_t)((216 * rs - 535 * gs + 319 * bs) >> 10);
        rs = gs = bs = 0;
        k++;
      }
    }
    /* Luma at 4.5 MHz: about 1.7 px, which is a [1 2 1] and nothing more.
     * Leaving it out entirely was wrong - a one-pixel dither has a luma
     * component as well as a chroma one, and without this the checkerboard
     * stays visible as texture even after its colour has blended away. */
    int prev = s_cy[0];
    for (int x = 0; x < rw - 1; x++) {
      const int cur = s_cy[x];
      s_cy[x] = (int16_t)((prev + 2 * cur + s_cy[x + 1]) >> 2);
      prev = cur;
    }

    /* Repeat the edges into the guards. */
    s_ci[0] = s_ci[1] = s_ci[2];
    s_cq[0] = s_cq[1] = s_cq[2];
    s_ci[cn + 2] = s_ci[cn + 3] = s_ci[cn + 1];
    s_cq[cn + 2] = s_cq[cn + 3] = s_cq[cn + 1];

    for (int i = 1; i <= cn + 2; i++) {
      s_ci2[i] = (int16_t)((s_ci[i - 1] + 2 * s_ci[i] + s_ci[i + 1]) >> 2);
      s_cq2[i] = (int16_t)((s_cq[i - 1] + 2 * s_cq[i] + s_cq[i + 1]) >> 2);
    }

    /* Back to RGB, interpolating chroma between block centres. A block
     * covers four pixels, so its centre sits at 1.5 - close enough to 2
     * that the half-pixel is not worth a second term. */
    for (int x = 0; x < rw; x++) {
      const int c = (x >> 2) + 2;
      const int f = x & 3;
      const int ii = (s_ci2[c] * (4 - f) + s_ci2[c + 1] * f) >> 2;
      const int qq = (s_cq2[c] * (4 - f) + s_cq2[c + 1] * f) >> 2;
      const int yy = s_cy[x];
      int r = yy + ((979 * ii + 636 * qq) >> 12);
      int g = yy + ((-278 * ii - 662 * qq) >> 12);
      int b = yy + ((-1133 * ii + 1744 * qq) >> 12);
      if (r < 0) r = 0; else if (r > 255) r = 255;
      if (g < 0) g = 0; else if (g > 255) g = 255;
      if (b < 0) b = 0; else if (b > 255) b = 255;
      row[x] = RGB(r, g, b);
    }
  }
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

static void toast(const char *s) {
  snprintf(s_toast, sizeof s_toast, "%s", s);
  s_toast_us = esp_timer_get_time();
}

/* ------------------------------------------------------------------ */
/* Flash and mode, the two controls that live on the viewfinder        */
/* ------------------------------------------------------------------ */

static const char *const FLASH_ORDER[3] = {"auto", "on", "off"};
/* The segments read AUTO / ON / OFF left to right, which is the same order
 * the cycle uses, so one table serves both. */
#define FLASH_ORDER_BY_INDEX FLASH_ORDER

/* The same three, as they are set on screen. Two screens show them now - LOOK's
 * segmented band and the finder's status bar - and two copies of three strings
 * is how one of them ends up saying something the other does not. */
static const char *const FLASH_NAMES[3] = {"AUTO", "ON", "OFF"};

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
/* Boot splash                                                         */
/* ------------------------------------------------------------------ */

#define SPL_BLACK RGB(0x08, 0x09, 0x0b)

/**
 * One frame of the boot screen.
 *
 * `lit` is how many cells of the four-frame mark have come up. `dim` draws
 * the whole thing on a darker ground, which is how the flicker is done - a
 * second pass over 384000 pixels to knock the brightness down would cost
 * more than the frame it is trying to spoil.
 */
static void splash_frame(int lit, bool dim) {
  const uint16_t ground = dim ? RGB(0x6e, 0x6e, 0x6e) : W_FACE;
  const uint16_t ink = dim ? RGB(0x44, 0x44, 0x44) : W_TEXT;
  fill(0, 0, UI_W, UI_H, ground);

  const int lx = (UI_W - KINO_D4_LOGO_W) / 2;
  const int ly = (UI_H - KINO_D4_LOGO_H) / 2 - 26;
  draw_bits(KINO_D4_LOGO, KINO_D4_LOGO_W, KINO_D4_LOGO_H, KINO_D4_LOGO_STRIDE, lx, ly, 1, ink);

  /* The mark, filling one cell per camera. This is the first thing the
   * camera ever shows about itself: four frames, in the order the lenses sit
   * on the bar. */
  const int cell = 16;
  const int mw = 4 * cell + 3 * FM_GAP;
  fm_cell_t st[4];
  for (int i = 0; i < 4; i++) st[i] = i < lit ? (i == lit - 1 ? FM_SPARK : FM_ON) : FM_OFF;
  if (!dim) four_mark((UI_W - mw) / 2, ly + KINO_D4_LOGO_H + 28, cell, st, false);
}

/** Black out everything outside a horizontal band centred on the screen. */
static void band_mask(int band_h) {
  if (band_h >= UI_H) return;
  const int y0 = (UI_H - band_h) / 2;
  fill(0, 0, UI_W, y0, SPL_BLACK);
  fill(0, y0 + band_h, UI_W, UI_H - y0 - band_h, SPL_BLACK);
}

/**
 * Boot: a tube coming on.
 *
 * The old sequence was a camera iris opening onto the wordmark - a good idea
 * that reads as modern, because an iris is a smooth continuous shape and
 * nothing on a cathode ray tube ever did anything smoothly. What a CRT
 * actually does is strike a bright line across the middle, bloom outward,
 * overshoot, and settle - and the whole event is over in under a second.
 *
 * Then the mark fills, one cell at a time, and the camera has introduced
 * itself before it has shown a single menu.
 */
static void splash(void) {
  const int OPEN_MS = 260, HOLD_MS = 300, CELL_MS = 120;

  fill(0, 0, UI_W, UI_H, SPL_BLACK);
  gfx_present();
  vTaskDelay(pdMS_TO_TICKS(90));

  /* Strike: a hard bright line, one frame, before anything else exists. */
  fill(0, UI_H / 2 - 2, UI_W, 5, RGB(0xff, 0xff, 0xff));
  gfx_present();
  vTaskDelay(pdMS_TO_TICKS(40));

  /* Bloom outward. Eased so it leaves the line quickly and arrives slowly,
   * which is what the phosphor does. */
  const int64_t t0 = esp_timer_get_time();
  for (;;) {
    const int64_t el = (esp_timer_get_time() - t0) / 1000;
    if (el >= OPEN_MS) break;
    const float t = (float)el / (float)OPEN_MS;
    const float e = 1.0f - (1.0f - t) * (1.0f - t);
    splash_frame(0, false);
    band_mask(6 + (int)(e * (float)(UI_H - 6)));
    gfx_present();
  }

  /* Overshoot and settle: two frames dim, one bright, which at 60 Hz is a
   * flicker rather than an animation. */
  splash_frame(0, true);
  gfx_present();
  vTaskDelay(pdMS_TO_TICKS(45));
  splash_frame(0, false);
  gfx_present();
  vTaskDelay(pdMS_TO_TICKS(70));
  splash_frame(0, true);
  gfx_present();
  vTaskDelay(pdMS_TO_TICKS(30));

  /* Four cells, one per camera. */
  for (int i = 1; i <= 4; i++) {
    splash_frame(i, false);
    gfx_present();
    vTaskDelay(pdMS_TO_TICKS(CELL_MS));
  }

  splash_frame(4, false);
  gfx_present();
  vTaskDelay(pdMS_TO_TICKS(HOLD_MS));
}

/**
 * Power off: the tube collapsing.
 *
 * The inverse of the boot, and the same physics: the picture is squeezed
 * into a line, the line holds for a moment because the phosphor is still
 * lit, then it shrinks to a point and goes. Drawn over whatever is already
 * on the canvas, so it is the screen you were looking at that collapses
 * rather than a black frame pretending to.
 */
static void crt_collapse(void) {
  for (int f = 1; f <= 10; f++) {
    band_mask(UI_H - (UI_H - 5) * f / 10);
    gfx_present();
    vTaskDelay(pdMS_TO_TICKS(22));
  }

  fill(0, 0, UI_W, UI_H, SPL_BLACK);
  fill(0, UI_H / 2 - 2, UI_W, 5, RGB(0xff, 0xff, 0xff));
  gfx_present();
  vTaskDelay(pdMS_TO_TICKS(160));

  /* The line pulls in to a point. */
  for (int f = 1; f <= 6; f++) {
    const int w = UI_W - (UI_W - 8) * f / 6;
    fill(0, 0, UI_W, UI_H, SPL_BLACK);
    fill((UI_W - w) / 2, UI_H / 2 - 2, w, 5, RGB(0xff, 0xff, 0xff));
    gfx_present();
    vTaskDelay(pdMS_TO_TICKS(26));
  }

  fill(0, 0, UI_W, UI_H, SPL_BLACK);
  gfx_present();
  vTaskDelay(pdMS_TO_TICKS(120));
}

/* ------------------------------------------------------------------ */
/* Shared chrome                                                       */
/* ------------------------------------------------------------------ */

/*
 * The title bar, and the three surfaces it is made of.
 *
 * It was a navy plate floating in the 4 px gap inside the window frame, with a
 * chevron drawn nearly edge to edge in a box that was almost square. Three
 * things were wrong with that and all three are geometry: a caption bar in this
 * grammar sits ON a raised bar rather than in a hole, a system button carries a
 * glyph with air round it, and the caption is inset from the left of the plate
 * rather than starting at it.
 *
 * HEAD_H is unchanged at 62 px on purpose. hit_test() sends the whole band back
 * with `y < HEAD_H` and that is the right target - a 44 px button is smaller
 * than a thumb - so the drawing had to fit the existing rectangle rather than
 * the other way round.
 */
#define HD_BAR_X 2
#define HD_BAR_Y 2
#define HD_BAR_W (UI_W - 4)
#define HD_BAR_H (HEAD_H - 4)
#define HD_BTN 44
#define HD_BTN_X (HD_BAR_X + 5)
#define HD_BTN_Y (HD_BAR_Y + (HD_BAR_H - HD_BTN) / 2)
#define HD_CAP_X (HD_BTN_X + HD_BTN + 5)
#define HD_CAP_Y (HD_BAR_Y + 6)
#define HD_CAP_W (UI_W - HD_BAR_X - 5 - HD_CAP_X)
#define HD_CAP_H (HD_BAR_H - 12)
/* The caption's own inset. A title that starts on the plate's first pixel is
 * the detail that makes a bar read as a coloured rectangle rather than a
 * caption bar; the system used 2 px and this panel is 800 px wide. */
#define HD_CAP_PAD 10

_Static_assert(HD_BTN + 10 <= HD_BAR_H, "the header system button does not fit its bar");

static void draw_header(screen_t s) {
  /* The screen is one window: raised frame, raised bar inside it, caption
   * plate on the bar. Three surfaces, each one step further forward. */
  fill(0, 0, UI_W, HEAD_H, W_FACE);
  bevel_raised(0, 0, UI_W, UI_H);
  bevel_raised(HD_BAR_X, HD_BAR_Y, HD_BAR_W, HD_BAR_H);

  grad_h(HD_CAP_X, HD_CAP_Y, HD_CAP_W, HD_CAP_H, W_TITLE_L, W_TITLE_R);

  /* Back, as a system button. The mark is back_glyph(), which is the same
   * chevron a row that opens a screen carries, at the scale a 44 px button
   * wants and pointing the other way - so the two read as one family. */
  const bool down = s_pressed == IT_BACK;
  const int d = down ? 1 : 0;
  button(HD_BTN_X, HD_BTN_Y, HD_BTN, HD_BTN, down);
  back_glyph(HD_BTN_X + HD_BTN / 2 + d, HD_BTN_Y + HD_BTN / 2 + d, W_TEXT);
  /* Nothing sets focus to IT_BACK today - touch deliberately does not, and
   * there are no direction keys on this body - but the button is a focusable
   * control the moment there are, and a header that cannot show focus is the
   * one place a d-pad would strand a user. Two comparisons per header. */
  if (foc(s, IT_BACK)) focus_inset(HD_BTN_X, HD_BTN_Y, HD_BTN, HD_BTN, W_TEXT);

  const int t = SCREEN_TITLE[s];
  if (t >= 0 && t < UI_LABEL_COUNT) {
    const ui_label_t *l = &UI_LABELS[t];
    draw_bits(l->bits, l->w, l->h, l->stride, HD_CAP_X + HD_CAP_PAD,
              HD_CAP_Y + (HD_CAP_H - l->h) / 2, 1, W_SELTEXT);
  }
}

/**
 * A group box: an etched frame with its legend sitting in the top edge.
 *
 * This is the single change that stops content floating in grey. The screens
 * carried bare captions - MODE, FLASH, VOLUME, CAM IDLE - set above controls
 * that had no container at all, which is the half-finished look: the words
 * belong to the control under them and nothing on screen said so.
 *
 * `note` is the right-hand half of the same edge, and it exists because these
 * screens already put a sentence there - "Both modes capture four frames", a
 * list position, a caption about where grading happens. Left as plain text it
 * would be struck through by the frame's top line. It gets the same treatment
 * as the legend, drawn in grey because it is a remark rather than a name.
 *
 * Both strings are UI_FONT_S: a legend names, it does not speak, and every
 * legend on this interface is the small role.
 *
 * `ink` is the legend's, and it is a parameter for exactly one caller: the
 * BRIGHTNESS box on the DISPLAY screen names a setting this body does not
 * have, and it has said so in grey since it was written. A black legend over a
 * grey sentence would put the two halves of that statement in different
 * voices.
 */
static void group_box(int x, int y, int w, int h, const char *legend, uint16_t ink,
                      const char *note) {
  /* Neither string: a plain groove from the top of the rectangle, with no line
   * of type to make room for. No caller does this today, and without the guard
   * the arithmetic below would open a 6 px hole in the top edge for a legend
   * that is not there. */
  if (legend == NULL && note == NULL) {
    bevel_etched(x, y, w, h, 0, 0);
    return;
  }

  const int fy = y + UI_FONT_S.line_h / 2; /* the top edge runs through the type */
  const int lw = legend != NULL ? text_w(&UI_FONT_S, legend) : 0;
  const int nw = note != NULL ? text_w(&UI_FONT_S, note) : 0;

  /* One gap, from the start of the legend to the end of the note. Two holes
   * would leave a stub of frame between two pieces of text on a line that has
   * nothing else on it, which reads as a mistake rather than as structure. */
  const int gx = legend != NULL ? x + 9 : x + w - 9 - nw;
  const int gw = nw > 0 ? (x + w - 9) - gx : lw + 6;

  bevel_etched(x, fy, w, h - (fy - y), gx - 3, gw + 6);
  if (legend != NULL) text(&UI_FONT_S, x + 9, y, legend, ink);
  if (note != NULL) text_right(&UI_FONT_S, x + w - 9, y, note, W_GRAYTEXT);
}

/**
 * A sunken status panel, and the ground it sits on.
 *
 * The window-bottom strip: a face-grey band across the client area with each
 * reading in its own recess. Drawn as two calls rather than one so the caller
 * decides how many panels there are and how wide each is - the menu wants a
 * wide one and a narrow one, and a fixed split would put the wordmark and the
 * power source in boxes sized by nothing.
 */
static void status_bar(int x, int y, int w, int h) {
  fill(x, y, w, h, W_FACE);
}

static void status_panel(int x, int y, int w, int h) {
  bevel_etched(x, y, w, h, 0, 0);
}

/* One list row at an arbitrary x, width and height. `value` may be NULL;
 * `arrow` adds the "opens a screen" mark, which a row that acts in place must
 * never have.
 *
 * Every screen but About uses one full-width column, which is why draw_row()
 * below is still the one almost everything calls. About needs two columns to
 * carry per-camera firmware at all, and a second copy of the row idiom is how
 * the two would drift apart - so the idiom moved here and draw_row() became a
 * call to it with the standard geometry. */
static void draw_row_at(int x, int w, int y, int h, bool focused, bool pressed, bool enabled,
                        const char *title, const char *value, bool arrow) {
  /* A list row on a white well with a navy selection: the 1998 listbox,
   * which is also the clearest thing to read in a dark room.
   *
   * A row has no bevel to invert, so a press is the selection plate plus the
   * one-pixel shift every other control on this interface makes - the same
   * gesture in the only two terms a flat row has. Without it, pressing
   * "Restart" or "Delete all photos" put nothing at all on screen between the
   * finger landing and the dialog appearing, which on a slow card read like a
   * touch that had been missed. */
  const bool lit = focused || pressed;
  fill(x, y, w, h, lit ? W_SEL : W_WINDOW);
  const int d = pressed ? 1 : 0;

  const uint16_t ti = lit ? W_SELTEXT : (enabled ? W_TEXT : W_GRAYTEXT);
  const uint16_t vi = lit ? W_SELTEXT : (enabled ? RGB(0x40, 0x40, 0x40) : W_GRAYTEXT);
  text(&UI_FONT_M, x + 14 + d, y + (h - UI_FONT_M.line_h) / 2 + d, title, ti);

  int right = x + w - 14 + d;
  if (arrow) {
    picker_arrow(right - 4, y + h / 2 + d, true, ti);
    right -= 20;
  }
  if (value) text_right(&UI_FONT_M, right, y + (h - UI_FONT_M.line_h) / 2 + d, value, vi);

  /* Inside the row, in white: the plate under it is navy whenever a row can be
   * focused at all, and a black dotted rectangle on navy is not a mark. */
  if (focused) focus_inset(x, y, w, h, W_SELTEXT);
}

/* The standard full-width row, which is what every screen but About draws.
 *
 * The dead `value_ink` parameter eleven call sites were passing is gone, and
 * `pressed` took its place: the row picks its own inks from `focused` and
 * `enabled` and always did, but it had no way at all to know a finger was on
 * it. Same arity, and every call site had to be visited to say which item
 * index it draws - which is the point, because that is the line where a row's
 * drawing and its hit rectangle agree or do not. */
static void draw_row(int y, bool focused, bool pressed, bool enabled, const char *title,
                     const char *value, bool arrow) {
  draw_row_at(LIST_X, LIST_W, y, ROW_H, focused, pressed, enabled, title, value, arrow);
}

/* The window a list sits in: face ground, sunken white well. */
static void draw_list_frame(int rows) {
  fill(0, BODY_Y, UI_W, UI_H - BODY_Y, W_FACE);
  well(LIST_X - 2, LIST_Y - 2, LIST_W + 4, rows * ROW_H + 4);
}

/* An on/off pill, the era's answer to a toggle: a recessed well with the live
 * state written in it, not a sliding lozenge. */
static void draw_toggle(int x, int y, bool on, bool focused) {
  /* A checkbox, not a pill. 1998 had no sliding lozenge, and a tick in a
   * sunken box is unambiguous at a glance in a way a slider is not. */
  const int box = 26;
  well(x, y, box, box);
  if (on) {
    /* A hand-set tick: three rising pixels then five falling, the shape the
     * system font's checkmark actually had. */
    for (int i = 0; i < 3; i++) fill(x + 6 + i, y + 12 + i, 2, 3, W_TEXT);
    for (int i = 0; i < 5; i++) fill(x + 9 + i, y + 15 - i, 2, 3, W_TEXT);
  }
  if (focused) focus_rect(x - 3, y - 3, box + 6, box + 6, W_TEXT);
}

/* A segmented selector: every option visible, the live one filled. */
static void draw_segments(int x, int y, int w, int h, const char *const *names, int count,
                          int selected, int pressed_idx, int focus_idx) {
  const int cw = w / count;
  for (int i = 0; i < count; i++) {
    const int bx = x + i * cw;
    const bool on = i == selected;
    /* The live option is drawn pushed in and stays pushed in - a radio
     * button as a toggled button, which is how a 1998 toolbar showed state. */
    button(bx, y, cw - 2, h, on || pressed_idx == i);
    if (on) fill(bx + 2, y + 2, cw - 6, h - 4, W_LIGHT);
    const int d = (on || pressed_idx == i) ? 1 : 0;
    text_mid(&UI_FONT_M, bx + (cw - 2) / 2 + d, y + (h - UI_FONT_M.line_h) / 2 + d, names[i],
             W_TEXT);
    if (focus_idx == i) focus_inset(bx, y, cw - 2, h, W_TEXT);
  }
}

/* Where an item index sits inside a band of `count` items starting at `base`,
 * or -1 when it is outside. Every segmented row and every picker on this
 * interface is such a band, and this is the arithmetic each of them used to
 * write out twice - once for pressed, once for focused. */
static int band_rel(int v, int base, int count) {
  return (v >= base && v < base + count) ? v - base : -1;
}

/**
 * A list too long for segments: the live value in a sunken well, a button at
 * each end.
 *
 * Looks and shutter sounds are open-ended - eleven factory looks plus whatever
 * is on the card - so they cannot be a row of segments the way MODE and FLASH
 * are. Cycling one at a time is slow with twenty entries and it is the only
 * control a touchscreen with no scroll list can offer honestly.
 *
 * `pressed` and `focus` are 0 for the left button, 1 for the right, -1 for
 * neither.
 */
static void draw_picker(int x, int y, int w, int h, int btn, const char *value, bool enabled,
                        int pressed, int focus) {
  const uint16_t ink = enabled ? W_TEXT : W_GRAYTEXT;
  const int nx = x + w - btn;

  button(x, y, btn, h, pressed == 0);
  picker_arrow(x + btn / 2 + (pressed == 0 ? 1 : 0), y + h / 2 + (pressed == 0 ? 1 : 0), false, ink);
  button(nx, y, btn, h, pressed == 1);
  picker_arrow(nx + btn / 2 + (pressed == 1 ? 1 : 0), y + h / 2 + (pressed == 1 ? 1 : 0), true, ink);

  const int wx = x + btn + 6, ww = w - 2 * (btn + 6);
  well(wx, y, ww, h);
  text_mid(&UI_FONT_M, wx + ww / 2, y + (h - UI_FONT_M.line_h) / 2, value, ink);

  if (focus == 0) focus_inset(x, y, btn, h, W_TEXT);
  if (focus == 1) focus_inset(nx, y, btn, h, W_TEXT);
}

static void human_bytes(char *out, size_t n, uint64_t bytes) {
  if (bytes >= (1024ULL * 1024 * 1024))
    snprintf(out, n, "%llu.%llu GB", bytes / (1024ULL * 1024 * 1024),
             (bytes % (1024ULL * 1024 * 1024)) / (107374182ULL));
  else snprintf(out, n, "%llu MB", bytes / (1024ULL * 1024));
}

/* ------------------------------------------------------------------ */
/* Main menu                                                           */
/* ------------------------------------------------------------------ */

static void tile_rect(int i, int *x, int *y) {
  *x = M_MARGIN + (i % M_COLS) * (M_TILE_W + M_GAP);
  *y = M_MARGIN + (i / M_COLS) * (M_TILE_H + M_GAP);
}

/**
 * Six targets on a light screen, and a strip that says where the power is.
 *
 * They were six loose objects: artwork and a word, floating on face grey, with
 * nothing round either. That reads as a desktop, and this is not a desktop -
 * every one of the six is a button, and a launcher whose targets have no edges
 * makes a user aim at a picture and hope. Each entry is now a raised tile that
 * pushes in, which is the only thing on this screen that had to change for it
 * to stop looking unfinished.
 *
 * Still no status bar across the TOP: a permanent strip of SD/WIFI/ROLL is
 * what a miniature PC looks like, and none of it is glanceable on a camera.
 * The strip at the FOOT carries the two things that were already down there.
 *
 * Selection stays quiet inside the tile. The label goes into a cobalt chip and
 * a dotted rectangle goes round the stack; the artwork is left alone - no
 * plate behind it, no tint over it - which is the whole reason for using these
 * icons instead of redrawing them.
 */
/**
 * Fill the artwork cache, once, from a screen with nothing on it but icons.
 *
 * This has to happen before any selection is drawn. It did not, and the
 * consequence was the dotted focus rectangle being captured INTO the cached
 * tile and then blitted back on every repaint for the rest of the session -
 * an outline round SHOOT that survived leaving the menu, coming back, and
 * choosing something else. A cache of a screen is only safe if the screen it
 * caches has no state in it.
 *
 * Nor has it any artwork in it before icons_build() finishes. ui_task waits
 * 2 s for the sprites and then draws regardless; if the builder is still
 * running at that point, priming here captured six tiles of bare #C0C0C0 and
 * s_mcached latched true, so the menu stayed blank for the rest of the
 * session even though the icons arrived a moment later. Nothing invalidates
 * the cache, so the only fix is not to fill it from a blank blit.
 */
static void menu_prime(void) {
  if (s_mcached) return;
  if (!icons_ready()) return;

  fill(0, 0, UI_W, UI_H, W_FACE);
  for (int i = 0; i < 6; i++) {
    int tx, ty;
    tile_rect(i, &tx, &ty);
    const int top = ty + (M_TILE_H - M_STACK) / 2;
    icons_blit_centred(s_cv, UI_W, UI_H, i, tx + M_TILE_W / 2, top + ICON_BOX / 2);
  }

  const int64_t t0 = esp_timer_get_time();
  bool all = true;
  for (int i = 0; i < 6; i++) {
    int tx, ty;
    tile_rect(i, &tx, &ty);
    const int top = ty + (M_TILE_H - M_STACK) / 2;
    const int icx = tx + M_TILE_W / 2;
    const int bx = icx - MT_W / 2, by = top + ICON_BOX / 2 - MT_H / 2;
    crt_rect(bx, by, MT_W, MT_H);

    if (s_mcache[i] == NULL) {
      s_mcache[i] = heap_caps_malloc((size_t)MT_W * MT_H * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    }
    if (s_mcache[i] == NULL) {
      all = false;
      continue;
    }
    for (int r = 0; r < MT_H; r++) {
      memcpy(s_mcache[i] + (size_t)r * MT_W, s_cv + (size_t)(by + r) * UI_W + bx,
             (size_t)MT_W * sizeof(uint16_t));
    }
  }
  s_mcached = all;
  ESP_LOGI(TAG, "composite: six tiles filtered in %lu ms, cached %s",
           (unsigned long)((esp_timer_get_time() - t0) / 1000), all ? "yes" : "no");
}

static void draw_menu(void) {
  menu_prime();
  /* The 1998 3D face, not a near-white canvas. It is the colour every window
   * in that era sat on, it makes the saturated icons pop instead of glowing,
   * and on a panel used in a dark room it is far kinder than white. */
  fill(0, 0, UI_W, UI_H, W_FACE);
  /* The screen is one window. */
  bevel_raised(0, 0, UI_W, UI_H);

  for (int i = 0; i < 6; i++) {
    int tx, ty;
    tile_rect(i, &tx, &ty);
    const bool sel = (foc(SCR_MENU, i));
    const bool down = (s_pressed == i);

    /* The tile. Raised, and sunken while it is held - the same two states as
     * every other button on the camera, at 250x205. The lift the icon used to
     * do on focus is gone with it: a tile that moves is a tile whose edges
     * move, and an edge that moves 2 px on selection reads as a rendering
     * fault rather than as a highlight. Focus is the chip and the dots. */
    button(tx, ty, M_TILE_W, M_TILE_H, down);

    const int top = ty + (M_TILE_H - M_STACK) / 2;
    const int icx = tx + M_TILE_W / 2;
    const int icy = top + ICON_BOX / 2;

    /* Everything inside a held tile moves with its face. */
    const int lift = down ? 1 : 0;

    const int bx = icx - MT_W / 2 + lift, by2 = icy - MT_H / 2 + lift;
    if (s_mcache[i] != NULL) {
      for (int r = 0; r < MT_H; r++) {
        const int gy = by2 + r;
        if (gy < 0 || gy >= UI_H) continue;
        memcpy(s_cv + (size_t)gy * UI_W + bx, s_mcache[i] + (size_t)r * MT_W,
               (size_t)MT_W * sizeof(uint16_t));
      }
    } else {
      /* No room for the cache. Slower and unfiltered, but still a menu. */
      icons_blit_centred(s_cv, UI_W, UI_H, i, icx + lift, icy + lift);
    }

    const int lw = text_w(&UI_FONT_M, MENU_LABEL[i]);
    const int ly = top + ICON_BOX + 10 + lift;
    const int px = icx - lw / 2 - 6 + lift, pw = lw + 12;

    if (sel || down) {
      fill(px, ly, pw, M_LABEL_H, W_SEL);
      /* The spark. Cobalt is the structure; a two-pixel rule of KINO yellow
       * under the selected word is the only warm thing on the screen, and it
       * is what stops the selection reading as a plain system highlight. */
      fill(px, ly + M_LABEL_H - 2, pw, 2, C_YELLOW);
      text(&UI_FONT_M, icx - lw / 2 + lift, ly + (M_LABEL_H - UI_FONT_M.line_h) / 2, MENU_LABEL[i],
           W_SELTEXT);
    } else {
      text(&UI_FONT_M, icx - lw / 2, ly + (M_LABEL_H - UI_FONT_M.line_h) / 2, MENU_LABEL[i],
           W_TEXT);
    }
    /* Inside the tile, not round the stack: 3 px in from the tile's own edge
     * is where a focus rectangle goes in this grammar, and it also stops the
     * dots landing on the icon artwork. */
    if (sel) focus_inset(tx, ty, M_TILE_W, M_TILE_H, W_TEXT);
  }

  /*
   * The status bar: the wordmark and where the power is coming from, each in
   * its own recess, divided by the 2 px of face grey between the two panels.
   *
   * Both readings are exactly what they were. There is no battery gauge on
   * this body, so the right panel says where the power comes from and nothing
   * about how much is left - a percentage here would be invented.
   */
  {
    const int sy = M_STATUS_Y, sh = M_STATUS_H;
    const int bi = W98_BATTERY_IDX;
    const int be = icons_edge(bi);
    /* Wide enough for BATTERY, the icon and the air round both. The left
     * panel takes the rest, which is the Win98 split: one elastic panel and
     * one sized to its contents. */
    const int rw = text_w(&UI_FONT_S, "BATTERY") + be + 26;
    const int rx = UI_W - 2 - rw;
    const int ty = sy + (sh - UI_FONT_S.line_h) / 2;

    status_bar(2, sy, UI_W - 4, sh);
    status_panel(2, sy, rx - 4, sh);
    status_panel(rx, sy, rw, sh);

    text(&UI_FONT_S, 12, ty, "kino D4", W_TEXT);
    /* The sprite is a 32 px box with a much smaller glyph in it, so centring
     * the box on a 34 px panel puts two transparent rows over each groove
     * rather than any artwork. */
    icons_blit(s_cv, UI_W, UI_H, bi, UI_W - 10 - be, sy + (sh - be) / 2);
    text_right(&UI_FONT_S, UI_W - 16 - be, ty, usb_attached() ? "USB" : "BATTERY", W_TEXT);
  }

  /* ---- the glass ---- */

  /* The labels, every repaint. Only the selected one carries chroma - the
   * rest are black on neutral grey, where I and Q are zero - but the LUMA
   * limit is not the identity on any of them: it is what softens a hard type
   * edge, and filtering only the selected label would leave the other five
   * visibly crisper than it. Cheap enough at six rows of 32.
   *
   * Inset 3 px from the tile now, not run to its full width. The luma pass is
   * a [1 2 1] and a bevel is a one-pixel line: taking the tile's edges into
   * the filter turned every highlight and shadow into a two-pixel smear, which
   * is the one thing a 2 px bevel cannot survive. The label is the only thing
   * in this band that wants the glass. */
  static bool warm_timed;
  const int64_t tl = warm_timed ? 0 : esp_timer_get_time();
  for (int i = 0; i < 6; i++) {
    int tx, ty;
    tile_rect(i, &tx, &ty);
    const int top = ty + (M_TILE_H - M_STACK) / 2;
    crt_rect(tx + 3, top + ICON_BOX + 6, M_TILE_W - 6, M_LABEL_H + 8);
  }
  if (s_mcached && !warm_timed) {
    warm_timed = true;
    /* What every repaint after the first actually costs, which is what a
     * press pays. Reported once so the number is measured rather than
     * derived from the cold one. */
    ESP_LOGI(TAG, "composite: labels only in %lu ms",
             (unsigned long)((esp_timer_get_time() - tl) / 1000));
  }
}

/* ------------------------------------------------------------------ */
/* Viewfinder                                                          */
/* ------------------------------------------------------------------ */

/* One thing you can touch on this screen. */
#define SH_IT_BACK 0

/*
 * The two markings, and the only two.
 *
 * The way out is a system button, not a glyph on a fade. What was here was a
 * 92x34 per-pixel darkening ramp with a chevron and the word MENU laid into
 * the corner: no margin, no plate, no bevel, and a press that changed the ink
 * and nothing else. It was the last hand-rolled chrome in this file. A plate
 * does everything the ramp was for - it is opaque, so the type on it is legible
 * over any room - and it costs 116 x 44 fills instead of 3128 unpack-mix-pack
 * round trips a frame.
 *
 * The facts go in a status bar at the foot of the picture, which is the menu's
 * status bar in the same tones at the same 34 px: one band, panels sized to
 * their contents with one elastic panel, 2 px of face grey between them. The
 * screen used to say nothing at all about how it was going to shoot - not the
 * mode, not the flash, not the look, not how many cameras were answering - so
 * every one of those decisions was made on another screen and then taken on
 * trust while framing.
 *
 * Bottom rather than top: it is where a status bar goes, it is where the
 * capture banner already lands (the banner is 40 px and covers this exactly,
 * so a capture replaces the strip rather than stacking on it), and a bar under
 * the picture cuts the two bottom panes rather than the two the horizon
 * usually sits in.
 *
 * 34 px of 480 is 7% of the picture. Everything else is room.
 */
#define SH_BACK_X 10
#define SH_BACK_Y 10
#define SH_BACK_W 116
#define SH_BACK_H 44   /* the header's system button height, and the touch floor */
#define SH_BAR_H 34    /* == M_STATUS_H: this is the menu's status bar */
#define SH_BAR_Y (UI_H - SH_BAR_H)
#define SH_PN_Y (SH_BAR_Y + 3)
#define SH_PN_H (SH_BAR_H - 6)
#define SH_PN_GAP 2    /* the face grey a Win98 status bar divides panels with */
#define SH_PN_PAD 10   /* text to panel edge, as on the menu's bar */

_Static_assert(SH_BAR_H == M_STATUS_H, "the viewfinder's status bar is not the menu's");
_Static_assert(SH_BACK_Y + SH_BACK_H < SH_BAR_Y, "the back button runs into the status bar");

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

/* look_display() lives with the LOOK screen's other look plumbing, 200 lines
 * below. The finder needs the same string - the same look, spelled the same
 * way - and a second copy of that lookup is how two screens start disagreeing
 * about which look is loaded. */
static bool look_current_id(char *out, size_t cap);
static void look_display(char *out, size_t cap);

/**
 * The look's name for the status bar, remembered between frames.
 *
 * look_display() walks the recipe list to turn an id into a name:
 * kdp_recipes_name() is a cJSON_GetArrayItem per entry - O(n^2) over up to 35
 * looks - and it takes a critical section for every custom one, which disables
 * interrupts. That is fine on LOOK, which repaints when a finger lands. On the
 * finder it would run about seventeen times a second for an answer that
 * changes when someone visits another screen.
 *
 * So the walk happens only when the id under it changes. The id itself is
 * cheap: one config read in WIGGLE, up to four in QUAD with target ALL.
 *
 * Keyed on the id, which means a look RENAMED in Studio while the finder is
 * open keeps its old name here until the id changes or the screen is left.
 * Worth it: the alternative is the walk, and a rename mid-frame is not a thing
 * anyone does with the camera held up.
 */
static const char *shoot_look_name(void) {
  static char s_id[KDP_RECIPE_ID_MAX];
  static char s_name[KDP_RECIPE_NAME_MAX];
  static bool s_have;

  char cur[KDP_RECIPE_ID_MAX];
  /* False is QUAD/ALL with four slots that disagree, where look_current_id
   * leaves cam1's id in the buffer - a legal id, and the wrong cache key. \x01
   * cannot appear in one (^[a-z0-9][a-z0-9-]*$), so it is the key for MIXED. */
  if (!look_current_id(cur, sizeof cur)) snprintf(cur, sizeof cur, "\x01");
  if (!s_have || strcmp(cur, s_id) != 0) {
    snprintf(s_id, sizeof s_id, "%s", cur);
    look_display(s_name, sizeof s_name);
    s_have = true;
  }
  return s_name;
}

/** One panel of the status bar: the recess, and its reading inside it. */
static int sh_panel(int x, int w, const char *s) {
  status_panel(x, SH_PN_Y, w, SH_PN_H);
  text(&UI_FONT_S, x + SH_PN_PAD, SH_PN_Y + (SH_PN_H - UI_FONT_S.line_h) / 2, s, W_TEXT);
  return x + w + SH_PN_GAP;
}

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
  static const char *const NAMES[4] = {"CAM1", "CAM2", "CAM3", "CAM4"};
  int live = 0;
  for (int i = 0; i < 4; i++) {
    int px, py;
    sh_pane_rect(i, &px, &py);

    const uint16_t *tile = viewfinder_ready() ? viewfinder_tile(i) : NULL;
    vf_status_t st = {0};
    if (viewfinder_ready()) viewfinder_status(i, &st);

    if (tile != NULL) {
      sh_blit(tile, px, py);
      /* Counted here rather than from viewfinder_status(): what the strip
       * reports is what the screen is showing. A pane with pixels on it is a
       * camera that answered, whatever the status word says a moment later. */
      live++;
      continue;
    }

    /* No pixels. Say which of the several reasons it is - a black quarter
     * could mean any of them - and say it quietly, because this is the one
     * state where the screen has nothing better to show. */
    fill(px, py, SH_PANE_W, SH_PANE_H, D_GROUND);
    const char *why = st.state == VF_ERROR     ? "NO PICTURE"
                      : st.state == VF_STALLED ? "NO RECENT FRAME"
                                               : "NO CAMERA";
    text_mid(&UI_FONT_S, px + SH_PANE_W / 2, py + SH_PANE_H / 2 - 14, why,
             RGB(0x4a, 0x52, 0x5e));
    text_mid(&UI_FONT_S, px + SH_PANE_W / 2, py + SH_PANE_H / 2 + 6, NAMES[i],
             RGB(0x32, 0x38, 0x42));
  }

  /* ---- the way out ---- */

  /* A system button, pressed the way every other button on this interface is:
   * the bevel inverts and the face goes in a pixel, taking the mark and the
   * word with it. The glyph and the label are centred as one group, so the
   * plate is padded evenly whatever the face measures the word at. */
  const bool down = s_pressed == SH_IT_BACK;
  const int d = down ? 1 : 0;
  button(SH_BACK_X, SH_BACK_Y, SH_BACK_W, SH_BACK_H, down);
  {
    const int gw = 24, gap = 8;
    const int tw = text_w(&UI_FONT_S, "MENU");
    const int gx = SH_BACK_X + (SH_BACK_W - (gw + gap + tw)) / 2 + d;
    back_glyph(gx + gw / 2, SH_BACK_Y + SH_BACK_H / 2 + d, W_TEXT);
    text(&UI_FONT_S, gx + gw + gap, SH_BACK_Y + (SH_BACK_H - UI_FONT_S.line_h) / 2 + d, "MENU",
         W_TEXT);
  }
  if (foc(SCR_SHOOT, SH_IT_BACK))
    focus_inset(SH_BACK_X, SH_BACK_Y, SH_BACK_W, SH_BACK_H, W_TEXT);

  /* ---- how it will shoot ---- */

  const char *const flash = FLASH_NAMES[flash_index()];
  /* `live` counts the four panes, so this is nine characters. The buffer is
   * sized for a full int anyway: the compiler cannot see the bound and
   * -Werror=format-truncation is right to insist, and a buffer that only fits
   * the value the code happens to produce is one refactor from a cut string. */
  char cams[24];
  snprintf(cams, sizeof cams, "%d/4 LIVE", live);

  /* The bolt labels the flash panel so the word does not have to. It is the
   * one drawn glyph in the build - the face is ASCII 32..126 and the Windows
   * 98 archive has no flash asset - and it was drawn for the flash control
   * that used to sit on this screen. This is where it went. */
  const int bolt_w = 8, bolt_gap = 8;
  const char *const mode = mode_is_quad() ? "QUAD" : "WIGGLE";
  const int w_mode = text_w(&UI_FONT_S, mode) + 2 * SH_PN_PAD;
  const int w_flash = bolt_w + bolt_gap + text_w(&UI_FONT_S, flash) + 2 * SH_PN_PAD;
  const int w_cams = text_w(&UI_FONT_S, cams) + 2 * SH_PN_PAD;

  fill(0, SH_BAR_Y, UI_W, SH_BAR_H, W_FACE);
  /* Raised, unlike the menu's, which sits inside a window frame that supplies
   * the edge. This screen has no frame - the panes run to all four sides - so
   * the bar draws its own, and the white top line is what separates it from
   * the picture rather than a keyline that belongs to neither. */
  bevel_raised(0, SH_BAR_Y, UI_W, SH_BAR_H);

  int x = 3;
  x = sh_panel(x, w_mode, mode);
  {
    /* The flash panel by hand, because it is the one with a glyph in it. */
    status_panel(x, SH_PN_Y, w_flash, SH_PN_H);
    bolt(x + SH_PN_PAD, SH_PN_Y + (SH_PN_H - 14) / 2, 1, W_TEXT);
    text(&UI_FONT_S, x + SH_PN_PAD + bolt_w + bolt_gap,
         SH_PN_Y + (SH_PN_H - UI_FONT_S.line_h) / 2, flash, W_TEXT);
    x += w_flash + SH_PN_GAP;
  }

  /* The look takes what is left, and the camera count is flush right: one
   * elastic panel and the rest sized to their contents, which is the split the
   * menu's status bar uses. A look's name may be 40 characters by the wire
   * contract, so it is the one reading that can outgrow its panel - and the
   * elastic panel is the one that can afford to cut it. */
  const int cams_x = UI_W - 3 - w_cams;
  const int w_look = cams_x - SH_PN_GAP - x;
  if (w_look > 2 * SH_PN_PAD + 24) {
    char look[KDP_RECIPE_ID_MAX + 4];
    text_fit(look, sizeof look, &UI_FONT_S, shoot_look_name(), w_look - 2 * SH_PN_PAD);
    sh_panel(x, w_look, look);
  }
  sh_panel(cams_x, w_cams, cams);
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

/* Five decisions about the photograph, in one place.
 *
 * Mode and flash used to live on the viewfinder, which put two pickers in
 * front of the thing they are meant to be describing. They are not part of
 * seeing the room, they are part of deciding what to do with it - the same
 * kind of decision as the look - so they are here, and the viewfinder is
 * only the room.
 *
 * Rows are a label, a 40 px control and 8 px of air, at a 68 px pitch. The
 * old 84 px pitch fitted three rows and there are now five, of which the
 * fifth exists in QUAD only. */
#define LK_X 24
#define LK_W (UI_W - 2 * LK_X)
#define LK_Y0 (BODY_Y + 8)
#define LK_ROW 68
#define LK_CTL_H 40
#define LK_PICK_BTN 56
#define lk_label_y(r) (LK_Y0 + (r) * LK_ROW)
#define lk_ctl_y(r) (lk_label_y(r) + 20)

/* The group box round each row. It reaches 8 px wider than the control on
 * each side and starts on the legend's own line, so the etched top edge runs
 * through the middle of MODE, FLASH, LOOK, COLOUR and TARGET rather than above
 * them. 6 px of air under the control is what stops the bottom groove touching
 * a button's shadow. */
#define LK_BOX_X (LK_X - 8)
#define LK_BOX_W (LK_W + 16)
#define LK_BOX_H (20 + LK_CTL_H + 6) /* legend line, control, air */

_Static_assert(LK_X - 8 >= 2, "the LOOK group boxes run into the window frame");

/* Rows in draw order: 0 MODE, 1 FLASH, 2 the look picker, 3 COLOUR/B&W,
 * 4 TARGET (QUAD only). The two footnotes follow the last drawn row. */
#define LK_ROW_TARGET 4

/* Item ranges. The target row is last so the item indices below it are the
 * same in both modes, which is what lets item_count() simply drop it. */
#define LK_IT_MODE 0    /* 0..1  WIGGLE / QUAD */
#define LK_IT_FLASH 2   /* 2..4  AUTO / ON / OFF */
#define LK_IT_PREV 5    /* the look picker's left button */
#define LK_IT_NEXT 6    /* and its right one */
#define LK_IT_COLOR 7   /* 7..8  COLOUR / B&W */
#define LK_IT_TARGET 9  /* 9..13 ALL / CAM1..CAM4, QUAD only */
#define LK_IT_COUNT 14

/* The detail strip under the last control row. Its height is here rather than
 * beside its drawing code so the assert below can see it. */
#define LK_DET_H 52
/* 14, not the 10 it was. The control rows are group boxes now, so the last one
 * has an etched bottom edge 6 px under its buttons; at a 10 px gap that groove
 * and the detail strip's sunken top edge landed 4 px apart and read as one
 * doubled line. There is room: the QUAD assert below still passes with 11 px
 * to spare. */
#define LK_DET_GAP 14

/* Five rows plus the detail strip is the tightest screen on the camera, and the
 * overflow would only show on a panel in QUAD - which is why the two lines of
 * footnote this replaced were checked the same way. */
_Static_assert(lk_ctl_y(LK_ROW_TARGET) + LK_CTL_H + LK_DET_GAP + LK_DET_H <= UI_H,
               "the LOOK detail strip falls off the bottom in QUAD");

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

/** What the picker's well says: the look's name, uppercased. */
static void look_display(char *out, size_t cap) {
  char cur[KDP_RECIPE_ID_MAX];
  if (!look_current_id(cur, sizeof cur)) {
    snprintf(out, cap, "MIXED");
    return;
  }
  for (int i = 0, n = kdp_recipes_count(); i < n; i++) {
    char id[KDP_RECIPE_ID_MAX], name[KDP_RECIPE_NAME_MAX];
    if (kdp_recipes_name(i, id, sizeof id, name, sizeof name) && strcmp(id, cur) == 0) {
      snprintf(out, cap, "%s", name);
      upcase(out);
      return;
    }
  }
  /* A look named in the config that is not on this camera - a card pulled, a
   * look deleted in Studio. Its id, not a blank: a setting you cannot read is
   * a setting you cannot decide to change. */
  snprintf(out, cap, "%s", cur[0] ? cur : "NONE");
  upcase(out);
}

static void look_step(int delta) {
  const int n = kdp_recipes_count();
  if (n <= 0) {
    toast("No looks on this camera");
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
  upcase(name);
  toast(name);
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
#define LK_DET_COLS 5

/**
 * The look's capture block, cached on its id.
 *
 * Cached for a harder reason than the ROLL screen's QR is: for a CUSTOM look
 * kdp_recipes_capture_block() takes the card (`storage_acquire_unless_held`),
 * and a draw runs every 90 ms while anything is busy. Per frame that would put
 * the SD arbiter in the repaint path, which is the one place a draw must never
 * block - the capture task holds the card for the length of a capture.
 *
 * The cost of the cache: a look edited in Studio under the SAME id keeps
 * showing its old numbers until the picker steps off it and back. That is the
 * right trade. The alternative is a screen that can stall behind a shutter.
 *
 * `s_lk_have` distinguishes "read it, there is no capture block" from "not read
 * yet", so a look that genuinely sets nothing is not re-read every frame.
 */
static bool look_capture(const char *id, recipe_capture_t *out) {
  static char s_lk_id[KDP_RECIPE_ID_MAX];
  static recipe_capture_t s_lk_cap;
  static bool s_lk_have;

  if (strcmp(s_lk_id, id) != 0) {
    snprintf(s_lk_id, sizeof s_lk_id, "%s", id);
    s_lk_have = kdp_recipes_capture_block(id, &s_lk_cap);
  }
  *out = s_lk_cap;
  return s_lk_have;
}

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
static void look_detail_col(int x, int w, int y, const char *value, bool set,
                            const char *label) {
  if (set) {
    text_mid(&UI_FONT_M, x + w / 2, y, value, W_TEXT);
  } else {
    text_mid(&UI_FONT_S, x + w / 2, y + 4, "NOT SET", W_GRAYTEXT);
  }
  text_mid(&UI_FONT_S, x + w / 2, y + UI_FONT_M.line_h + 4, label, W_GRAYTEXT);
}

/** The detail strip, under the last control row. */
static void draw_look_detail(int y) {
  /* A well: five readings, no press. */
  well(LK_X, y, LK_W, LK_DET_H);

  char id[KDP_RECIPE_ID_MAX];
  if (!look_current_id(id, sizeof id)) {
    /* QUAD, target ALL, four slots that disagree. Showing cam1's numbers for
     * all four would misdescribe three cameras, which is the same reason
     * look_display() says MIXED rather than guessing. */
    text_mid(&UI_FONT_S, UI_W / 2, y + (LK_DET_H - UI_FONT_S.line_h) / 2,
             "The four cameras are on different looks. Pick one camera to see its settings.",
             W_GRAYTEXT);
    return;
  }

  recipe_capture_t cap;
  if (!look_capture(id, &cap)) {
    text_mid(&UI_FONT_S, UI_W / 2, y + (LK_DET_H - UI_FONT_S.line_h) / 2,
             "This look sets nothing on the sensor.", W_GRAYTEXT);
    return;
  }

  const int cw = LK_W / LK_DET_COLS;
  const int ty = y + 5;
  char v[16];

  /*
   * Exposure bias in tenths of an EV, formatted by integer arithmetic.
   *
   * `%f` is deliberately avoided: the value is a double in the recipe struct,
   * but printing one pulls the full formatter in, and the contract's precision
   * is one decimal anyway (D19: an EV in -2..+2 with one decimal, which the
   * node then rounds to an integer AE step). Tenths is the whole range.
   */
  const double b = cap.exposure_bias;
  const int t10 = (int)(b * 10.0 + (b >= 0 ? 0.5 : -0.5));
  const int mag = t10 < 0 ? -t10 : t10;
  snprintf(v, sizeof v, "%s%d.%d EV", t10 < 0 ? "-" : "+", mag / 10, mag % 10);
  look_detail_col(LK_X, cw, ty, v, cap.has_exposure_bias, "EXPOSURE");

  snprintf(v, sizeof v, "x%d", cap.gain_limit);
  look_detail_col(LK_X + cw, cw, ty, v, cap.has_gain_limit, "GAIN CEILING");

  snprintf(v, sizeof v, "%d%%", cap.jpeg_quality_percent);
  look_detail_col(LK_X + 2 * cw, cw, ty, v, cap.has_jpeg_quality, "QUALITY");

  snprintf(v, sizeof v, "%d", cap.denoise);
  look_detail_col(LK_X + 3 * cw, cw, ty, v, cap.has_denoise, "DENOISE");

  snprintf(v, sizeof v, "%d", cap.sharpness);
  look_detail_col(LK_X + 4 * cw, cw, ty, v, cap.has_sharpness, "SHARPNESS");
}

/**
 * Where the selected look sits in the list, as "4 / 11".
 *
 * Written into `out` empty when there is no single answer - MIXED, or a look
 * the camera does not have - because a position in a list the look is not in is
 * a number that means nothing.
 *
 * Factory-or-custom is deliberately NOT shown. The boundary is
 * kdp_recipes.c's own `cJSON_GetArraySize(s_factory)` and no accessor publishes
 * it; hardcoding 11 here would be a second copy of an invariant that breaks
 * silently the first time a factory look is added.
 */
static void look_position(char *out, size_t cap) {
  out[0] = '\0';
  char cur[KDP_RECIPE_ID_MAX];
  if (!look_current_id(cur, sizeof cur)) return;
  const int n = kdp_recipes_count();
  for (int i = 0; i < n; i++) {
    char id[KDP_RECIPE_ID_MAX];
    if (kdp_recipes_name(i, id, sizeof id, NULL, 0) && strcmp(id, cur) == 0) {
      snprintf(out, cap, "%d / %d", i + 1, n);
      return;
    }
  }
}

static void draw_look(void) {
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_LOOK);

  static const char *const MODE_NAMES[2] = {"WIGGLE", "QUAD"};
  static const char *const COLOR_NAMES[2] = {"COLOUR", "B&W"};
  static const char *const TARGET_NAMES[5] = {"ALL", "CAM1", "CAM2", "CAM3", "CAM4"};

  const int p0 = s_pressed;
  const int f0 = s_focus_shown ? s_focus[SCR_LOOK] : -1;
  const bool quad = mode_is_quad();

  /* The label lines are 752 px wide with one short word on the left, so the
   * notes that used to be stacked at the foot of the screen live on them
   * instead - beside the control each one is actually about, and costing no
   * vertical room at all. That is what freed the bottom of the screen for the
   * detail strip.
   *
   * Both the word and the note are now IN the group box's top edge, which is
   * what they always wanted to be: the label names the control under it and
   * the note remarks on it, and until now nothing on screen tied either of
   * them to the row of buttons below. Note that the frame is what carries the
   * association - the strings are unchanged, every one of them. */
  group_box(LK_BOX_X, lk_label_y(0), LK_BOX_W, LK_BOX_H, "MODE", W_TEXT,
            "Both modes capture four frames. The difference is playback.");
  draw_segments(LK_X, lk_ctl_y(0), LK_W, LK_CTL_H, MODE_NAMES, 2, quad ? 1 : 0,
                band_rel(p0, LK_IT_MODE, 2), band_rel(f0, LK_IT_MODE, 2));

  group_box(LK_BOX_X, lk_label_y(1), LK_BOX_W, LK_BOX_H, "FLASH", W_TEXT, NULL);
  draw_segments(LK_X, lk_ctl_y(1), LK_W, LK_CTL_H, FLASH_NAMES, 3, flash_index(),
                band_rel(p0, LK_IT_FLASH, 3), band_rel(f0, LK_IT_FLASH, 3));

  /* Sized by the id, not the name: look_display() falls back to the id when
   * the look is not on this camera, and an id may be longer than a name. */
  char look[KDP_RECIPE_ID_MAX];
  look_display(look, sizeof look);
  /* Where you are in the list. Cycling one at a time through up to 35 entries
   * with no idea how many there are or how far round you have come is the
   * complaint the picker earned; this is the cheapest honest answer to it. */
  char pos[24];
  look_position(pos, sizeof pos);
  group_box(LK_BOX_X, lk_label_y(2), LK_BOX_W, LK_BOX_H, "LOOK", W_TEXT,
            pos[0] != '\0' ? pos : NULL);
  draw_picker(LK_X, lk_ctl_y(2), LK_W, LK_CTL_H, LK_PICK_BTN, look, kdp_recipes_count() > 0,
              band_rel(p0, LK_IT_PREV, 2), band_rel(f0, LK_IT_PREV, 2));

  /* COLOUR and B&W are a different field from the look - SlotColorMode is
   * 'recipe' | 'mono' in the wire contract - so they stay their own row
   * rather than becoming two more entries in the picker. */
  /*
   * The caption that replaces "Looks are applied when you import. The preview
   * does not change."
   *
   * That was true of 0.4.8 and false from 0.4.9 on. Contract D19: the look's
   * capture block goes to each node over NL_CMD_SENSOR before the trigger -
   * exposure bias, gain ceiling, denoise, sharpness and quality - the node
   * clamps each one and reports what it set, and META records it. So the look
   * does reach the camera, and a caption saying otherwise tells someone their
   * choice is decoration.
   *
   * What is NOT claimed: the look's colour science. Contrast, saturation and
   * temperature are still applied at import and there is no grading anywhere in
   * this firmware, so "grading is still at import" stays. Nor is the PREVIEW
   * claimed - the viewfinder stream does not carry these settings, only the
   * capture does, which is why the wording is "at capture" and not "now".
   */
  group_box(LK_BOX_X, lk_label_y(3), LK_BOX_W, LK_BOX_H, "COLOUR", W_TEXT,
            "These reach the sensor at capture. Grading is still at import.");
  draw_segments(LK_X, lk_ctl_y(3), LK_W, LK_CTL_H, COLOR_NAMES, 2, look_is_mono() ? 1 : 0,
                band_rel(p0, LK_IT_COLOR, 2), band_rel(f0, LK_IT_COLOR, 2));

  /* QUAD only, because it is the only mode with four independent slots. In
   * WIGGLE there is one look and a target row would be a control with one
   * legal value. */
  if (quad) {
    group_box(LK_BOX_X, lk_label_y(LK_ROW_TARGET), LK_BOX_W, LK_BOX_H, "TARGET", W_TEXT, NULL);
    draw_segments(LK_X, lk_ctl_y(LK_ROW_TARGET), LK_W, LK_CTL_H, TARGET_NAMES, 5, s_look_target,
                  band_rel(p0, LK_IT_TARGET, 5), band_rel(f0, LK_IT_TARGET, 5));
  }

  /* The bottom of the screen, which used to be 90 px of bare face grey in
   * WIGGLE and two lines of small print in QUAD. The strip follows the last
   * control row, so it sits at two different heights in the two modes and in
   * both cases immediately under the thing it describes. */
  draw_look_detail(lk_ctl_y(quad ? LK_ROW_TARGET : 3) + LK_CTL_H + LK_DET_GAP);
}

/* ------------------------------------------------------------------ */
/* Gallery                                                             */
/* ------------------------------------------------------------------ */

#define G_COLS GALLERY_COLS
#define G_TILE_W GALLERY_TILE_W
#define G_TILE_H GALLERY_TILE_H
#define G_GAP 14
#define G_CAP 20   /* the one-line caption under each tile */
#define G_X0 ((UI_W - (G_COLS * G_TILE_W + (G_COLS - 1) * G_GAP)) / 2)
#define G_Y0 (BODY_Y + 8)
#define G_PITCH (G_TILE_H + G_CAP + 12)
#define G_FOOT 40

/* Items 0..5 are tiles, 6 is page-back, 7 is page-forward. */
#define G_IT_PREV 6
#define G_IT_NEXT 7

/* Each tile is a well with a 2 px white mat, so the block round a photograph
 * is 6 px wider on every side than the photograph: 2 of selection plate, 2 of
 * sunken edge, 2 of mat. That is 3 px more than the old keyline had, in every
 * direction, and it is spent out of gaps nothing measured before. Checked here
 * because the caption's offsets are literals in the draw loop below and the
 * pitch is arithmetic up here - the two only agreed by luck. */
#define G_BLOCK 6
#define G_CAP_TOP 5   /* the caption's offset below the picture, as drawn */
_Static_assert(G_GAP >= 2 * G_BLOCK, "the gallery tile wells touch across a column gap");
_Static_assert(G_X0 >= G_BLOCK, "the leftmost tile well runs off the screen");
_Static_assert(G_Y0 >= BODY_Y + G_BLOCK, "the top row's well runs into the header");
_Static_assert(G_CAP_TOP > 4, "the caption sits on the well's bottom edge");
_Static_assert(G_PITCH - G_BLOCK >= G_TILE_H + G_CAP_TOP + 18,
               "the caption runs into the next row's tile well");
_Static_assert(G_Y0 + G_PITCH + G_TILE_H + G_CAP_TOP + 18 <= UI_H - G_FOOT,
               "the bottom row's caption runs into the footer");

static void gal_origin(int slot, int *x, int *y) {
  *x = G_X0 + (slot % G_COLS) * (G_TILE_W + G_GAP);
  *y = G_Y0 + (slot / G_COLS) * G_PITCH;
}

/* ------------------------------------------------------------------ */
/* The favourite mark                                                  */
/*                                                                     */
/* A bitmap, not a scan-converted polygon. The mark has to be legible   */
/* at 11 px in the corner of a 208 px tile, and at that size a computed */
/* five-point star is a blob with three of its points lost to rounding. */
/* The font is ASCII 32..126 and carries no star glyph, so this is the  */
/* only way to draw one at all.                                        */
/*                                                                     */
/* One silhouette, two inks. An outline form was tried first and does   */
/* not survive: at 11 px a hollow star is six disconnected 1 px runs and */
/* reads as noise beside the word next to it - checked in the host       */
/* preview, which is what that tool is for. Gold means it is a           */
/* favourite, grey means the control would make it one, and the shape    */
/* stays the same so the tile mark and the button are one thing.         */
/* ------------------------------------------------------------------ */
#define STAR_W 11
#define STAR_H 10

static const char *const STAR_ROWS[STAR_H] = {
    ".....#.....", "....###....", "....###....", "###########", ".#########.",
    "..#######..", "..#######..", ".###...###.", ".##.....##.", "#.........#",
};

static void star(int x, int y, uint16_t ink) {
  for (int r = 0; r < STAR_H; r++) {
    for (int c = 0; c < STAR_W; c++) {
      if (STAR_ROWS[r][c] == '#') fill(x + c, y + r, 1, 1, ink);
    }
  }
}

static void gal_blit(const uint16_t *px, int x, int y) {
  for (int r = 0; r < G_TILE_H; r++)
    memcpy(s_cv + (size_t)(y + r) * UI_W + x, px + (size_t)r * G_TILE_W,
           (size_t)G_TILE_W * sizeof(uint16_t));
}

static void draw_gallery(void) {
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_GALLERY);

  storage_status_t sd;
  storage_get_status(&sd);
  const int total = gallery_total();

  if (total == 0) {
    /* "READING CARD" while the scan is still running, because the scan now
     * happens on the gallery task rather than inside this touch handler: the
     * first entry arrives here with a total of zero and would otherwise say
     * "NO PHOTOS YET" for the second it takes to count them. */
    const bool counting = sd.mounted && gallery_loading();
    /* The count matters most here: this is the first open on a card with no
     * order index yet, which is the one case that still walks every capture
     * folder. Without a number the screen says the same thing for seven
     * seconds and reads as a hang. */
    char h1buf[24];
    const int walked = gallery_scan_progress();
    if (counting && walked > 0) snprintf(h1buf, sizeof h1buf, "READING CARD %d", walked);
    else snprintf(h1buf, sizeof h1buf, "READING CARD");
    const char *h1 = !sd.mounted ? "NO CARD" : counting ? h1buf : "NO PHOTOS YET";
    const char *h2 = !sd.mounted   ? "Insert a microSD card to store photos."
                     : counting    ? "Looking through the captures on the card."
                                   : "Press the shutter to take one.";
    text_mid(&UI_FONT_M, UI_W / 2, UI_H / 2 - 26, h1, W_TEXT);
    text_mid(&UI_FONT_S, UI_W / 2, UI_H / 2 + 8, h2, W_GRAYTEXT);
    return;
  }

  const gallery_item_t *slots = gallery_slots();
  for (int i = 0; i < GALLERY_PAGE; i++) {
    if (slots[i].state == TILE_EMPTY) continue;
    int x, y;
    gal_origin(i, &x, &y);
    const bool selected = foc(SCR_GALLERY, i);
    const bool down = s_pressed == i;

    /* Every photograph sits in a sunken well; the focused one gets the navy
     * plate a selected thumbnail had.
     *
     * A press lights the same plate, shifts the caption a pixel, and drops a
     * second sunken edge INSIDE the picture - the well getting deeper, which is
     * this grammar's press applied to the one surface that cannot invert. A
     * recess that turned raised would read as the frame popping off the screen,
     * and the picture itself cannot move: the blit is exactly G_TILE_W wide, so
     * a pixel of travel would put its last column on the frame's shadow.
     *
     * The plate alone was tried and is not enough - it is 3 px of navy behind a
     * bright photograph, invisible next to the focused tile. What the press
     * used to be was a dotted rectangle over the photograph, which says
     * "keyboard focus" and not "your finger is here". */
    /* The frame was a bevel drawn tight against the picture: 2 px of shadow
     * with the photograph's own edge immediately inside it, which is a keyline
     * that happens to be bevelled rather than a well. Every other reading
     * surface on this interface - a list, the roll's figures, the storage
     * bar - is white ground inside a sunken edge, and the grid was the last
     * place a picture sat straight on the face.
     *
     * So: a well, with 2 px of its white ground showing all the way round the
     * photograph as a mat. The picture does not move and does not change size -
     * the blit is exactly G_TILE_W wide and a pixel of travel would put its
     * last column on the frame's shadow - the frame moves outwards instead.
     * The selection plate moves out with it and reads 2 px wide now rather
     * than 1, which is the only other visible difference. */
    fill(x - 6, y - 6, G_TILE_W + 12, G_TILE_H + 12, (selected || down) ? W_SEL : W_FACE);
    well(x - 4, y - 4, G_TILE_W + 8, G_TILE_H + 8);
    const int d = down ? 1 : 0;
    if (slots[i].state == TILE_READY && slots[i].pixels) {
      gal_blit(slots[i].pixels, x, y);
    } else {
      fill(x, y, G_TILE_W, G_TILE_H, C_WELL);
      text_mid(&UI_FONT_S, x + G_TILE_W / 2 + d, y + G_TILE_H / 2 - 9 + d,
               slots[i].state == TILE_PENDING ? "LOADING" : "NO IMAGE", D_DIM);
    }
    if (down) bevel_sunken(x, y, G_TILE_W, G_TILE_H);
    if (selected) focus_inset(x, y, G_TILE_W, G_TILE_H, W_SELTEXT);

    /* A favourite is marked in the corner of the picture, not in the caption
     * strip below it. The caption already carries the frame mark and the mode
     * and is the busiest 22 px on the screen; the top-right corner of a tile
     * is the one place that is empty on every photograph.
     *
     * On its own dark plate, because the mark sits over a photograph and a
     * white star on a bright sky is not a mark. */
    if (slots[i].favorite) {
      const int sx = x + G_TILE_W - STAR_W - 6, sy = y + 5;
      fill(sx - 3, sy - 3, STAR_W + 6, STAR_H + 6, RGB(0x12, 0x16, 0x1c));
      star(sx, sy, C_YELLOW);
    }

    /* One short caption. No filename, no size, no path: the picture is the
     * content and the rest is file management. */
    /* The mark instead of a sentence: four cells, lit for the frames that
     * are actually in the folder. A full capture reads as four filled cells
     * at a glance and a partial one is obvious without counting.
     *
     * An empty cell is only LOST when the capture actually lost something.
     * This used to paint every unfilled cell red, so a one-camera body showed
     * three "camera did not answer" marks under every photograph it had ever
     * taken correctly - damage reported where there was none. META.JSON says
     * `partial` when frames were asked for and did not arrive; that is the
     * only case worth colouring as a fault. */
    fm_cell_t st[4];
    for (int k = 0; k < 4; k++) {
      st[k] = k < slots[i].frames ? FM_ON : (slots[i].partial ? FM_LOST : FM_OFF);
    }
    /* The mark is 8 px against 18 rows of type, so it sits 2 px lower to share
     * the line's middle. Both offsets are from G_CAP_TOP, which is what the
     * clearance assertions above are written against. */
    four_mark(x + 2 + d, y + G_TILE_H + G_CAP_TOP + 2 + d, 8, st, false);
    text_right(&UI_FONT_S, x + G_TILE_W - 2 + d, y + G_TILE_H + G_CAP_TOP + d, slots[i].mode,
               W_TEXT);
  }

  /*
   * The footer says one thing at a time, in the middle.
   *
   * "READING CARD" used to be drawn at x=24 - the same place as the PREV
   * button - so while the card was being read the two sat on top of each
   * other and the screen showed a boxed "REPRE#NG|CARD". The state and the
   * page position are the same piece of information at different moments, so
   * they share the one slot instead of fighting for it.
   */
  const int pages = gallery_pages();
  const int fy = UI_H - G_FOOT;
  const int ty = fy + (G_FOOT - UI_FONT_S.line_h) / 2;
  const bool loading = gallery_loading();

  char mid[48];
  if (loading) {
    /* The count while a full rebuild is walking the card, nothing while the
     * order came out of the index - which is the honest distinction: an index
     * hit reads no capture folders at all, so there is no number, and it is
     * over before anyone reads the line anyway. A rebuild on a 500-capture
     * card takes seconds and a screen that says only READING CARD for that
     * long is indistinguishable from one that has hung. */
    const int walked = gallery_scan_progress();
    if (walked > 0) snprintf(mid, sizeof mid, "READING CARD %d", walked);
    else snprintf(mid, sizeof mid, "READING CARD");
  } else if (pages > 1) {
    /* Both numbers: which page you are on, and how much there is. Without the
     * total, "3 of 8" says nothing about whether that is 18 photographs or 48. */
    snprintf(mid, sizeof mid, "%d of %d      %d photos", gallery_page() + 1, pages, total);
  } else {
    snprintf(mid, sizeof mid, "%d photo%s", total, total == 1 ? "" : "s");
  }
  /* The count in its own recess, so the one reading on this footer reads as a
   * status panel rather than as a caption adrift between two buttons. Sized to
   * the space between them whether or not they are drawn, which is what keeps
   * the panel from moving when a one-page card becomes a three-page one. */
  {
    const int pw = pages > 1 ? 78 + 12 : 0;
    const int sx = 24 + pw, sw = UI_W - 48 - 2 * pw;
    status_panel(sx, fy + 4, sw, G_FOOT - 8);
    text_mid(&UI_FONT_S, UI_W / 2, ty, mid, loading ? W_GRAYTEXT : W_TEXT);
  }

  if (pages > 1) {
    const int bw = 78, bh = 32, by = fy + (G_FOOT - bh) / 2;
    const int pd = s_pressed == G_IT_PREV ? 1 : 0, nd = s_pressed == G_IT_NEXT ? 1 : 0;
    /* Greyed at the ends rather than hidden. A control that disappears moves
     * the other one and teaches nothing; a dead one shows you where you are. */
    const bool has_prev = gallery_page() > 0;
    const bool has_next = gallery_page() < pages - 1;
    button(24, by, bw, bh, pd);
    text_mid(&UI_FONT_M, 24 + bw / 2 + pd, by + (bh - UI_FONT_M.line_h) / 2 + pd, "PREV",
             has_prev ? W_TEXT : W_GRAYTEXT);
    button(UI_W - 24 - bw, by, bw, bh, nd);
    text_mid(&UI_FONT_M, UI_W - 24 - bw / 2 + nd, by + (bh - UI_FONT_M.line_h) / 2 + nd, "NEXT",
             has_next ? W_TEXT : W_GRAYTEXT);
    if (foc(SCR_GALLERY, G_IT_PREV)) focus_inset(24, by, bw, bh, W_TEXT);
    if (foc(SCR_GALLERY, G_IT_NEXT)) focus_inset(UI_W - 24 - bw, by, bw, bh, W_TEXT);
  }
}

/* ------------------------------------------------------------------ */
/* One photograph                                                      */
/* ------------------------------------------------------------------ */

/*
 * The photograph screen's three controls, left to right as they are drawn.
 *
 * FAVOURITE was inserted between DELETE and SEND TO ROLL, which moved
 * P_IT_ROLL from 1 to 2. Nothing reads P_IT_ROLL - the control is drawn dead
 * because there is no radio on this body - but the number is kept in step with
 * the layout so it is right on the day one is fitted.
 *
 * item_count(SCR_PHOTO) is 2, not 3: DELETE and FAVOURITE both do something,
 * SEND TO ROLL does not, and a focus ring is a promise that pressing will act.
 */
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
}

static void photo_release(void) {
  wiggle_stop();
  if (s_photo) { free(s_photo); s_photo = NULL; }
  s_photo_ok = false;
  s_photo_fav = false;
}

/* Decoded at PH_W x PH_H rather than by scaling the 208 px gallery tile:
 * thumb_load takes any target size, so there is no reason to show a
 * thumbnail blown up to half the screen.
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
    if (thumb_load(path, s_photo, PH_W, PH_H, C_WELL) == ESP_OK) {
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
  if (strcmp(s_photo_mode, "wiggle") == 0 && s_photo_frames > 1) {
    uint32_t gen = 0;
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
        (it->cal_present && pure_align_has_offset(it->cal, PURE_WIGGLE_FRAMES_MAX)) ? it->cal
                                                                                    : NULL;
    if (gallery_frames_begin(it->id, PH_W, PH_H, C_WELL, off, &gen) == ESP_OK) s_wig_gen = gen;
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
    toast("Card busy");
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
    toast("Could not save");
    audio_warning();
    return;
  }
  s_photo_fav = want;
  klog("P4", "favourite %s %s", s_photo_id, want ? "on" : "off");
  /* So the tile behind this screen carries the mark when the user goes back.
   * The refresh is a card rescan on the gallery task, not work done here. */
  gallery_refresh();
  toast(want ? "Favourite" : "Not favourite");
}

static void draw_photo(void) {
  fill(0, 0, UI_W, UI_H, D_GROUND);

  const int px = PH_X0, py = PH_TOP;
  /* The frame of the swing while one is playing, the still otherwise. Same
   * size, same well, same everything else: the picture moves and no pixel of
   * the chrome around it does. */
  const uint16_t *src = photo_pixels();
  if (src != NULL) {
    for (int r = 0; r < PH_H; r++)
      memcpy(s_cv + (size_t)(py + r) * UI_W + px, src + (size_t)r * PH_W,
             (size_t)PH_W * sizeof(uint16_t));
  } else {
    fill(px, py, PH_W, PH_H, D_PANE);
    text_mid(&UI_FONT_M, UI_W / 2, py + PH_H / 2 - 12, "NO IMAGE", D_DIM);
  }
  /* The picture in a well, in the dark chrome's own tones. It was a 1 px
   * keyline, which is the one thing this grammar has no word for: a frame is
   * either raised or sunken, and a photograph is set into the body. */
  bevel_sunken_dark(px - 2, py - 2, PH_W + 4, PH_H + 4);

  /* Back, top left, matching the viewfinder so the gesture is the same. */
  const uint16_t bink = (s_pressed == IT_BACK) ? C_BLUE : D_TEXT;
  chevron(14, 14, bink);
  text(&UI_FONT_S, 32, 14 - UI_FONT_S.line_h / 2, "BACK", bink);

  char info[72];
  snprintf(info, sizeof info, "%s   %s   %d frames", s_photo_label, s_photo_mode, s_photo_frames);
  text(&UI_FONT_S, px, PH_CAP_Y, info, D_DIM);

  /*
   * A wiggle that is swinging fewer than four frames says so, at the right
   * end of the caption row it already has.
   *
   * The count is what DECODED, not META's frameCount: a partial capture may
   * be missing any one of the four and the document only records how many
   * were stored, so the denominator is the four lenses and the numerator is
   * what is actually on the card. Said only when it is short - a complete
   * wiggle needs no note, and "4 OF 4 FRAMES" on every photograph is a label
   * that teaches nothing and dilutes the one that does.
   *
   * On the caption's own baseline rather than over the picture: the well is a
   * photograph and nothing this firmware has to say belongs inside it.
   */
  if (s_wig_len >= 2 && s_wig_count > 0 && s_wig_count < GALLERY_FRAME_MAX) {
    char note[24];
    snprintf(note, sizeof note, "%d OF %d FRAMES", s_wig_count, GALLERY_FRAME_MAX);
    text_right(&UI_FONT_S, px + PH_W, PH_CAP_Y, note, D_DIM);
  }

  const int bh = PH_BTN_H, by = PH_BTN_Y, bw = PH_BTN_W;
  const int ty = by + (bh - UI_FONT_S.line_h) / 2;

  const int dx = PH_BTN_X(0);
  const int dd = s_pressed == P_IT_DELETE ? 1 : 0;
  button(dx, by, bw, bh, dd);
  text_mid(&UI_FONT_S, dx + bw / 2 + dd, ty + dd, "DELETE", W_TEXT);
  /* Through foc(), not the raw array. P_IT_DELETE is 0 and s_focus[] starts
   * zeroed, so reading it directly put a focus ring on DELETE the first time
   * any photograph was opened, on a body whose only input is a finger. */
  if (foc(SCR_PHOTO, P_IT_DELETE)) focus_inset(dx, by, bw, bh, W_TEXT);

  /* The star carries the state and the word carries the action, which is why
   * the label does not change between them: a button reading "UNFAVOURITE" on
   * a photograph that IS one, next to a lit star, says the same thing twice
   * and in two different grammars. Gold star, it is a favourite; grey star, it
   * is not. The button always toggles. It is also drawn pushed in while it is
   * one, the same way a live segment is on every other screen here. */
  const int fx = PH_BTN_X(1);
  const int fd = s_pressed == P_IT_FAV ? 1 : 0;
  const int fpush = (fd || s_photo_fav) ? 1 : 0;
  button(fx, by, bw, bh, fd || s_photo_fav);
  star(fx + 14 + fpush, by + (bh - STAR_H) / 2 + fpush,
       s_photo_fav ? RGB(0xd0, 0x9c, 0x00) : W_SHADOW);
  text_mid(&UI_FONT_S, fx + bw / 2 + 10 + fpush, ty + fpush, "FAVOURITE", W_TEXT);
  if (foc(SCR_PHOTO, P_IT_FAV)) focus_inset(fx, by, bw, bh, W_TEXT);

  /* No radio on this body, so Roll cannot take it. Dimmed with the reason
   * rather than hidden - a control that vanishes teaches nothing. */
  const int rx = PH_BTN_X(2);
  button(rx, by, bw, bh, false);
  text_mid(&UI_FONT_S, rx + bw / 2, ty, "SEND TO ROLL", W_GRAYTEXT);
}

/* ------------------------------------------------------------------ */
/* Roll                                                                */
/* ------------------------------------------------------------------ */

/*
 * Draw a QR centred at `cx`, scaled to the largest whole module pitch that
 * fits `box` pixels, with the 4-module quiet zone the spec requires.
 *
 * The quiet zone is not optional and not decoration: without it a phone
 * cannot find the symbol's edges against the surrounding UI, and the failure
 * looks like a camera whose screen "does not scan" rather than a missing
 * margin. Drawn as an explicit white block for the same reason.
 */
#define QR_QUIET 4

static int draw_qr_centred(const qr_t *qr, int cx, int top, int box) {
  const int total = qr->size + 2 * QR_QUIET;
  const int pitch = box / total;
  if (pitch < 1) return 0; /* no room Ã¢â‚¬â€ the caller shows the code as text */

  const int side = total * pitch;
  const int x0 = cx - side / 2;

  /* White ground for the symbol and its quiet zone together. W_WINDOW is
   * 0xffffff and W_TEXT is 0x000000, so the symbol gets full contrast rather
   * than the 0xc0 face grey Ã¢â‚¬â€ a QR drawn on the face ground scans poorly. */
  fill(x0, top, side, side, W_WINDOW);

  const int m0 = x0 + QR_QUIET * pitch;
  const int n0 = top + QR_QUIET * pitch;
  for (int y = 0; y < qr->size; y++) {
    for (int x = 0; x < qr->size; x++) {
      if (qr_module(qr, x, y)) {
        fill(m0 + x * pitch, n0 + y * pitch, pitch, pitch, W_TEXT);
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
 *   no roll   Ã¢â‚¬â€ nothing to show, and how to get one
 *   active    Ã¢â‚¬â€ the QR a guest scans, plus what is waiting
 *   offline   Ã¢â‚¬â€ the same, but honest that nothing is moving
 *   paused    Ã¢â‚¬â€ something is wrong and retrying will not fix it
 *
 * The old screen said "NOT CONNECTED / This body has no radio fitted", which
 * was wrong on both counts: the radio IS fitted, and a Roll assigned from
 * Studio works over USB with no radio at all.
 */
/*
 * Two columns, because the panel is 800 px wide and landscape.
 *
 * The screen used to put the title, a 225 px QR and four lines of statistics
 * down a 220 px strip in the middle, leaving 290 px of bare face grey on each
 * side. That is not a stylistic complaint: the QR's module pitch IS the
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

/**
 * One statistic in the right column: a big number and a small label under it.
 *
 * Returns the y to carry on from. The number is pixel-doubled M and the label
 * is S - the value is the thing being read across the room, and the label only
 * says which value it is.
 */
static int roll_stat(int y, const char *value, const char *label) {
  text_scaled(&UI_FONT_M, RL_RX, y, value, 2, W_TEXT);
  y += UI_FONT_M.line_h * 2 + 2;
  text(&UI_FONT_S, RL_RX, y, label, W_GRAYTEXT);
  /* 26 rather than the 12 that first looked right on paper: two of these plus
   * the name and the code left a 90 px hole above the status plate, which read
   * as the column having run out of things to say rather than as spacing. */
  return y + UI_FONT_S.line_h + 26;
}

static void draw_roll(void) {
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_ROLL);

  roll_state_t roll;
  const bool active = roll_state_get(&roll);

  upload_queue_report_t q;
  upload_queue_status(&q);

  net_status_t net;
  net_link_status(&net, esp_timer_get_time() / 1000);
  const bool online = net_link_can_upload(&net);

  if (!active) {
    /* No Roll. Say how to get one rather than only that there isn't one Ã¢â‚¬â€ and
     * do not offer a CREATE button, because ROLL_CREATE is an HTTP POST this
     * body cannot make. A control that cannot work is the same defect as a
     * shutter that logs instead of capturing. */
    /* This state's whole job is telling someone how to start a roll, so it
     * gets the panel rather than three lines in the top third. */
    /* The heading and its two lines are one block, centred in the space above
     * the card well rather than pinned under the header - pinned, it left a
     * 150 px hole in the middle of the panel with the well at the foot. */
    const int wy = UI_H - 92, wh = 76;
    const int block_h = UI_FONT_M.line_h * 2 + 24 + 32 + UI_FONT_M.line_h;
    const int hy = BODY_Y + (wy - BODY_Y - block_h) / 2;
    text_scaled_mid(&UI_FONT_M, UI_W / 2, hy, "NO ACTIVE ROLL", 2, W_TEXT);

    const int cy = hy + UI_FONT_M.line_h * 2 + 24;
    text_mid(&UI_FONT_M, UI_W / 2, cy, "Make a roll in Studio over USB-C.", W_TEXT);
    text_mid(&UI_FONT_M, UI_W / 2, cy + 32, "It appears here with a code guests scan.", W_TEXT);

    /* The card line, in a well at the foot, and made to mean something. The
     * count alone answers "how many" but not the question someone on this
     * screen is actually asking, which is what becomes of them. Photos on the
     * card are not stranded for want of a roll - they import over USB-C either
     * way - and saying so is the difference between a number and an answer. */
    const int n = gallery_total();
    well(RL_M, wy, UI_W - 2 * RL_M, wh);
    if (n > 0) {
      char line[56];
      snprintf(line, sizeof line, "%d photo%s on the card", n, n == 1 ? "" : "s");
      text_mid(&UI_FONT_M, UI_W / 2, wy + 14, line, W_TEXT);
      text_mid(&UI_FONT_S, UI_W / 2, wy + 44,
               "They import over USB-C, and upload if a roll is assigned later.", W_GRAYTEXT);
    } else {
      text_mid(&UI_FONT_M, UI_W / 2, wy + 14, "No photos on the card", W_TEXT);
      text_mid(&UI_FONT_S, UI_W / 2, wy + 44, "Press the shutter to take one.", W_GRAYTEXT);
    }
    return;
  }

  /*
   * The QR. This is the point of the screen: a guest scans the camera and is
   * on the Roll, with no laptop involved.
   *
   * Encoded once per Roll and cached, not once per repaint. Two reasons, and
   * the second is the one that matters: the screen repaints every 90 ms while
   * anything is busy, and qr_encode() puts about 1.4 KB of bitfields and
   * codeword buffers on the caller's stack Ã¢â‚¬â€ which here is the UI task's. Nine
   * mask evaluations of a 57x57 grid on every frame would also be pure waste
   * for a symbol that changes only when the Roll does.
   *
   * The cache is keyed on the URL, so a ROLL_LEAVE followed by a new
   * assignment re-encodes and a repaint never does.
   */
  static qr_t s_qr;
  static char s_qr_url[ROLL_GUEST_URL_LEN];
  static bool s_qr_ok;
  if (strcmp(s_qr_url, roll.guest_url) != 0) {
    snprintf(s_qr_url, sizeof s_qr_url, "%s", roll.guest_url);
    s_qr_ok = roll.guest_url[0] != '\0' && qr_encode(roll.guest_url, &s_qr);
    if (!s_qr_ok) {
      klog("P4", "roll guest url did not encode as a QR (%u chars)",
           (unsigned)strlen(roll.guest_url));
    }
  }

  /* ---- left column: the symbol, at whatever pitch the height allows ---- */
  if (s_qr_ok) {
    const int side = draw_qr_centred(&s_qr, RL_QR_CX, RL_TOP, RL_QR_BOX);
    if (side > 0) {
      /* The plate the symbol sits on, as a well - a white square floating on
       * face grey was the last piece of bare chrome on this screen.
       *
       * The bevel is drawn OUTSIDE the white block, not over its edge. The
       * outer 4 modules of that block are the quiet zone the QR spec requires,
       * and at this pitch that is 40 px: eating 2 of them for a frame would
       * take the margin a phone needs to find the symbol's edges down to 3.8
       * modules to buy a border. The screen grows 2 px instead. */
      bevel_sunken(RL_QR_CX - side / 2 - 2, RL_TOP - 2, side + 4, side + 4);
      text_mid(&UI_FONT_S, RL_QR_CX, RL_TOP + side + 8, "SCAN TO JOIN", W_GRAYTEXT);
    }
  } else {
    /* The URL did not encode, so the column shows the code itself, big. A
     * guest can still type it, which is worth more than a QR-shaped block no
     * phone reads - and at this size it is legible from where the QR would
     * have been scanned from, which is the point of giving it the column. */
    const int cy = RL_TOP + RL_QR_BOX / 2 - UI_FONT_M.line_h * 2;
    text_scaled_mid(&UI_FONT_M, RL_QR_CX, cy, roll.slug,
                    fit_scale(&UI_FONT_M, roll.slug, RL_QR_COL_W - 20), W_TEXT);
    text_mid(&UI_FONT_S, RL_QR_CX, cy + UI_FONT_M.line_h * 2 + 16, "Enter this code to join",
             W_GRAYTEXT);
    text_mid(&UI_FONT_S, RL_QR_CX, cy + UI_FONT_M.line_h * 2 + 38,
             "The join link is too long to encode.", W_GRAYTEXT);
  }

  /* ---- right column: the roll, and what is happening to it ---- */

  /* The Roll's name, or its code when it has no name. Sized to the column
   * rather than assumed to fit: ROLL_NAME is host-supplied text. */
  const char *title = roll.name[0] != '\0' ? roll.name : roll.slug;
  int y = RL_TOP;
  text_scaled(&UI_FONT_M, RL_RX, y, title, fit_scale(&UI_FONT_M, title, RL_RW), W_TEXT);
  y += UI_FONT_M.line_h * 2 + 6;

  /* The code, next to the QR that encodes it. A guest whose phone will not
   * scan - a cracked lens, a camera permission refused - can type this, and
   * until now it was only ever shown when the QR itself failed. */
  if (s_qr_ok) {
    /* Sized off the field, not off the six-character slugs Roll issues today:
     * roll.slug is host data and ROLL_SLUG_LEN is what bounds it. */
    char code[sizeof roll.slug + 8];
    snprintf(code, sizeof code, "CODE  %s", roll.slug);
    text(&UI_FONT_M, RL_RX, y, code, W_TEXT);
  }
  y += UI_FONT_M.line_h + 18;

  /* Counts, as big numerals. `pending` is what has not reached the Roll yet,
   * and it is the number a host actually wants at a party. */
  char num[16];
  const int total = gallery_total();
  snprintf(num, sizeof num, "%d", total);
  y = roll_stat(y, num, total == 1 ? "PHOTO ON THE CARD" : "PHOTOS ON THE CARD");

  if (q.uploading > 0) {
    snprintf(num, sizeof num, "%d", q.uploading);
    y = roll_stat(y, num, "UPLOADING NOW");
  } else if (q.pending > 0) {
    snprintf(num, sizeof num, "%d", q.pending);
    y = roll_stat(y, num, "WAITING TO UPLOAD");
  } else {
    snprintf(num, sizeof num, "%d", q.uploaded);
    y = roll_stat(y, num, "UPLOADED TO THE ROLL");
  }

  /*
   * The link state, in a well at the foot of the column.
   *
   * It was 18 px grey text under three other lines of 18 px grey text, which
   * made the one word that says whether anything is moving the least visible
   * thing on the screen. A plate at the bottom of the column is where a status
   * line belongs, and the halted case gets the same plate because "paused" and
   * "offline" are answers to the same question.
   */
  const int py = UI_H - 78;
  well(RL_RX, py, RL_RW, 62);

  if (q.halted) {
    /* Distinct from failed: the jobs are fine, the credential or the
     * association is not, and retrying the queue is the wrong instinct. */
    text(&UI_FONT_M, RL_RX + 12, py + 8, "UPLOAD PAUSED", W_TEXT);
    text(&UI_FONT_S, RL_RX + 12, py + 36,
         q.last_error[0] != '\0' ? q.last_error : "Check the roll in Studio", W_GRAYTEXT);
    return;
  }

  /* One phrase for whether anything is actually moving. "OFFLINE" with photos
   * waiting is a complete and honest description of this body today. */
  const char *link, *why;
  if (online) {
    link = "ONLINE";
    why = "Captures upload as they are taken.";
  } else if (!net.radio_routed) {
    /* Not "offline": there is no radio route to be offline from. The
     * Connection screen carries the detail. */
    link = "NO RADIO LINK";
    why = "Photos leave over USB-C.";
  } else {
    link = "OFFLINE";
    why = "Uploads resume when Wi-Fi returns.";
  }
  text(&UI_FONT_M, RL_RX + 12, py + 8, link, W_TEXT);
  text(&UI_FONT_S, RL_RX + 12, py + 36, why, W_GRAYTEXT);
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

static const char *const SET_ROWS[5] = {"Display", "Sound", "Connection", "Storage", "About"};
static const screen_t SET_DEST[5] = {SCR_DISPLAY, SCR_SOUND, SCR_CONNECTION, SCR_STORAGE,
                                     SCR_ABOUT};

static void draw_settings(void) {
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_SETTINGS);
  draw_list_frame(5);
  for (int i = 0; i < 5; i++)
    draw_row(LIST_Y + i * ROW_H, foc(SCR_SETTINGS, i), s_pressed == i, true, SET_ROWS[i], NULL,
             true);
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
static const char *const SECS_15[3] = {"15 s", "30 s", "60 s"};
static const char *const SECS_60[3] = {"1 min", "2 min", "5 min"};

/* shoot.displayAfterShotS, including the -1 that means HOLD - the result
 * screen stays until it is acknowledged. Written as the contract's own values
 * so the row and the setting cannot drift apart. */
static const int SHOT_S[5] = {0, 1, 2, 3, -1};
static const char *const SHOT_NAMES[5] = {"OFF", "1 S", "2 S", "3 S", "HOLD"};

/* body.camIdleTimeoutS: how long before the camera bank is powered down.
 * 0 is NEVER, which is the contract's own encoding, not a sentinel invented
 * here - so NEVER is a value like the other two and not a missing setting. */
static const int IDLE_S[3] = {60, 300, 0};
static const char *const IDLE_NAMES[3] = {"1 MIN", "5 MIN", "NEVER"};

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

static void draw_display(void) {
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_DISPLAY);

  const int f0 = s_focus_shown ? s_focus[SCR_DISPLAY] : -1;
  for (int r = 0; r < DSP_ROWS; r++) {
    /* Four bands that used to sit under four bare words. The frame is what
     * says which band each word names; the words are unchanged. */
    group_box(DSP_BOX_X, DSP_LABEL_Y(r), DSP_BOX_W, DSP_BOX_H, DSP_ROW[r].label, W_TEXT, NULL);
    draw_segments(DSP_X, DSP_BAND_Y(r), DSP_W, DSP_BAND_H, DSP_ROW[r].names, DSP_ROW[r].count,
                  dsp_selected(r), band_rel(s_pressed, DSP_ROW[r].base, DSP_ROW[r].count),
                  band_rel(f0, DSP_ROW[r].base, DSP_ROW[r].count));
  }

  /* The backlight is a plain GPIO, on or off. A brightness control here would
   * be a slider that moves and changes nothing, so it is greyed-out text on
   * the dialog face - which is exactly how 1998 said "this does not apply".
   * GET_CAPABILITIES says the same thing to Studio as brightnessControl.
   *
   * In a group box like the four live rows, because it is the fifth setting on
   * this screen and not a footnote about the other four. An empty box with one
   * grey sentence in it is also the clearest possible statement that there is
   * nothing here to press. */
  const int ny = DSP_BAND_Y(DSP_ROWS - 1) + DSP_BAND_H + 18;
  group_box(DSP_BOX_X, ny, DSP_BOX_W, 22 + UI_FONT_S.line_h + 10, "BRIGHTNESS", W_GRAYTEXT, NULL);
  text(&UI_FONT_S, DSP_X, ny + 22, "Not adjustable - the backlight on this body is on or off.",
       W_GRAYTEXT);
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

/**
 * Where the selected clip sits in the list, as "3 / 7". Empty when the config
 * names a clip the camera does not have, for the same reason look_position()
 * is: a position in a list you are not in is a number that means nothing.
 *
 * The same treatment as the LOOK picker, because it is the same control with
 * the same complaint - cycling one at a time with no idea how long the list is.
 */
static void snd_position(char *out, size_t cap) {
  out[0] = '\0';
  char cur[KDP_SOUND_ID_MAX];
  config_str_copy("shoot.shutterSound", cur, sizeof cur);
  for (int i = 0, n = snd_count(); i < n; i++) {
    char id[KDP_SOUND_ID_MAX];
    if (snd_at(i, id, sizeof id, NULL, 0) && strcmp(id, cur) == 0) {
      snprintf(out, cap, "%d / %d", i + 1, n);
      return;
    }
  }
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

#define SN_BTN 36 /* the picker's ‹ › buttons, inside a 52 px row */

/* The picker's two buttons and the value beside them, right-aligned in the
 * row the same way a toggle is. */
static int sn_next_x(void) { return LIST_X + LIST_W - 14 - SN_BTN; }
static int sn_prev_x(void) { return sn_next_x() - 6 - SN_BTN; }
static int sn_btn_y(void) { return LIST_Y + (ROW_H - SN_BTN) / 2; }

static void draw_sound(void) {
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_SOUND);

  const bool shut = config_bool("body.sounds.save", true);
  const bool ui = config_bool("body.sounds.ui", true);

  draw_list_frame(3);

  /* Which sound the shutter makes, above the two rows that decide whether a
   * sound is made at all. Those two used to be titled "Shutter sound" and
   * "Button sound", which now collides with the picker - they are renamed to
   * what they actually do, which is switch a sound on and off. */
  char clip[KDP_SOUND_NAME_MAX];
  snd_display(clip, sizeof clip);
  draw_row(LIST_Y, false, false, true, "Shutter sound", NULL, false);
  {
    const int by = sn_btn_y(), nx = sn_next_x(), px = sn_prev_x();
    text_right(&UI_FONT_M, px - 12, LIST_Y + (ROW_H - UI_FONT_M.line_h) / 2, clip, W_TEXT);
    const int pd = s_pressed == SN_IT_PREV ? 1 : 0, nd = s_pressed == SN_IT_NEXT ? 1 : 0;
    button(px, by, SN_BTN, SN_BTN, pd);
    picker_arrow(px + SN_BTN / 2 + pd, by + SN_BTN / 2 + pd, false, W_TEXT);
    button(nx, by, SN_BTN, SN_BTN, nd);
    picker_arrow(nx + SN_BTN / 2 + nd, by + SN_BTN / 2 + nd, true, W_TEXT);
    if (foc(SCR_SOUND, SN_IT_PREV)) focus_inset(px, by, SN_BTN, SN_BTN, W_TEXT);
    if (foc(SCR_SOUND, SN_IT_NEXT)) focus_inset(nx, by, SN_BTN, SN_BTN, W_TEXT);

    /* The position, under the row's title rather than beside the clip name -
     * the right half of the row is already the name and two buttons. Same
     * "3 / 7" the LOOK picker now carries. */
    char pos[24];
    snd_position(pos, sizeof pos);
    if (pos[0] != '\0') {
      text(&UI_FONT_S, LIST_X + 14 + text_w(&UI_FONT_M, "Shutter sound") + 16,
           LIST_Y + (ROW_H - UI_FONT_S.line_h) / 2 + 2, pos, W_GRAYTEXT);
    }
  }

  draw_row(LIST_Y + ROW_H, foc(SCR_SOUND, SN_IT_SHUTTER), s_pressed == SN_IT_SHUTTER, true,
           "Play shutter sound", NULL, false);
  draw_toggle(LIST_X + LIST_W - 14 - 26, LIST_Y + ROW_H + (ROW_H - 26) / 2, shut, false);
  draw_row(LIST_Y + 2 * ROW_H, foc(SCR_SOUND, SN_IT_BUTTON), s_pressed == SN_IT_BUTTON, true,
           "Play button sound", NULL, false);
  draw_toggle(LIST_X + LIST_W - 14 - 26, LIST_Y + 2 * ROW_H + (ROW_H - 26) / 2, ui, false);

  const int y = LIST_Y + 3 * ROW_H + 26;
  /* The one control on this screen that sat outside the list well, under a
   * bare word. Same treatment as every other band on the camera, and the box
   * reaches to the window margin the list well uses rather than to the band
   * the band happens to be drawn at. */
  group_box(LIST_X, y, LIST_W, 24 + 44 + 6, "VOLUME", W_TEXT, NULL);
  static const char *const VOL[3] = {"LOW", "MEDIUM", "HIGH"};
  static const int VOLV[3] = {3, 6, 9};
  draw_segments(24, y + 24, UI_W - 48, 44, VOL, 3, nearest_idx(config_int("shoot.volume", 6), VOLV),
                band_rel(s_pressed, SN_IT_VOL, 3),
                band_rel(s_focus_shown ? s_focus[SCR_SOUND] : -1, SN_IT_VOL, 3));

  /*
   * The 155 px below the volume band.
   *
   * Two things the screen had no way to say. First, where the list the picker
   * cycles comes from: five built-ins are compiled in and the rest are on the
   * card, so a picker that gains three entries after a card swap is explained
   * rather than mysterious, and a picker with none of them says the card is
   * why. Second, and more important, whether the audio hardware came up at
   * all - this screen offered a volume band and two toggles without ever
   * consulting audio_ready(), so on a body whose I2S did not start it was three
   * live-looking controls over silence.
   *
   * Below the volume band on purpose: the band is hit-tested at
   * LIST_Y + 3 * ROW_H + 26 + 24 for 44 px, so everything here is clear of the
   * only touch targets on the lower half of the screen.
   */
  const int ny = y + 24 + 44 + 30;
  char line[72];

  if (!audio_ready()) {
    /* Named as hardware, not as a setting. "Muted" would read as something a
     * user did and can undo from this screen, and it is not. */
    text(&UI_FONT_M, 24, ny, "No audio output on this body", W_TEXT);
    text(&UI_FONT_S, 24, ny + 30,
         "The settings above are stored, and nothing plays until the amplifier starts.",
         W_GRAYTEXT);
    return;
  }

  const int custom = kdp_sounds_count();
  if (custom > 0) {
    snprintf(line, sizeof line, "%d built-in sounds, and %d clip%s from the card.", SND_BUILTINS,
             custom, custom == 1 ? "" : "s");
  } else {
    snprintf(line, sizeof line, "%d built-in sounds. No clips on the card.", SND_BUILTINS);
  }
  text(&UI_FONT_S, 24, ny, line, W_GRAYTEXT);
  text(&UI_FONT_S, 24, ny + 20, "Upload your own in Studio over USB-C.", W_GRAYTEXT);
}

/* --- Connection --------------------------------------------------- */

/*
 * The radio's real state, not "Not fitted".
 *
 * "Not fitted" was wrong twice over: the ESP32-C6 IS on the Guition module,
 * and what is missing is the P4's route to it, which is a wiring question
 * rather than an absent part. A user reading "Not fitted" goes looking for a
 * component to add. So the screen reports the two facts separately Ã¢â‚¬â€ the chip
 * is there, and the firmware cannot reach it Ã¢â‚¬â€ the same way the capabilities
 * split `flashControl` from `flashHardware`.
 *
 * Every value comes from net_link, so this screen becomes correct on its own
 * once the transport lands. Nothing here is hard-coded to the V1 state.
 */
static void draw_connection(void) {
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_CONNECTION);

  net_status_t net;
  net_link_status(&net, esp_timer_get_time() / 1000);

  /* Radio: is the part there at all. */
  const char *radio = net.radio_fitted ? "ESP32-C6" : "None";

  /* Link: can this firmware reach it. The distinction the old screen lost. */
  const char *link;
  switch (net.state) {
    case NET_C6_NOT_ROUTED: link = "Not routed"; break;
    case NET_C6_ABSENT: link = "No response"; break;
    case NET_C6_BOOTING: link = "Starting"; break;
    case NET_C6_LINK_READY: link = "Ready"; break;
    case NET_ERROR: link = "Error"; break;
    default: link = "Ready"; break; /* anything past LINK_READY implies it */
  }

  /* Wi-Fi: the SSID and signal when there is one, and otherwise a state a
   * user can act on. Association without an address says "Getting address"
   * rather than "Connected" Ã¢â‚¬â€ claiming connected there is how a camera
   * insists it is online while nothing resolves. */
  char wifi[64];
  switch (net.state) {
    case NET_IP_READY:
      /* The channel goes on this row rather than getting one of its own: it is
       * a property of the association, and net_status_t has carried it since
       * the transport work without anything ever drawing it. */
      snprintf(wifi, sizeof wifi, "%s  ch %d  %d dBm", net.ssid, net.channel, net.rssi);
      break;
    case NET_WIFI_ASSOCIATED:
    case NET_IP_WAIT:
      snprintf(wifi, sizeof wifi, "Getting address");
      break;
    case NET_WIFI_CONNECTING:
      snprintf(wifi, sizeof wifi, "Connecting");
      break;
    case NET_WIFI_SCANNING:
      snprintf(wifi, sizeof wifi, "Scanning");
      break;
    case NET_WIFI_IDLE:
      snprintf(wifi, sizeof wifi, "Disconnected");
      break;
    default:
      /* No radio route: the honest word is unavailable, not disconnected.
       * "Disconnected" implies a connection is available to make. */
      snprintf(wifi, sizeof wifi, "Unavailable");
      break;
  }

  char saved[16];
  snprintf(saved, sizeof saved, "%u", (unsigned)wifi_creds_count());

  /*
   * Seven readings at a 46 px pitch rather than five at 52.
   *
   * The screen showed five rows and 85 px of face grey while net_status_t
   * carried three facts nothing drew: the address, the channel, and the
   * coprocessor's firmware version. The address in particular is the first
   * thing anyone asks at a bench, and "Online" without one is the state this
   * firmware is careful everywhere else NOT to claim.
   *
   * The tighter pitch is legitimate HERE and would not be on Settings or
   * Power: this screen has no touch items at all - item_count() falls to 0 and
   * hit_test() to -1, and only the header band goes anywhere - so no row here
   * is a target that has to stay 52 px tall.
   */
  const char *addr = net.ip[0] != '\0' ? net.ip : "-";
  /* Empty until a version exchange has happened, which on this body never
   * happens - so a dash, not a blank. */
  const char *c6fw = net.c6_version[0] != '\0' ? net.c6_version : "-";

  const struct {
    const char *title;
    const char *value;
    bool enabled;
  } ROWS[] = {
      {"Radio", radio, net.radio_fitted},
      {"Radio firmware", c6fw, net.c6_version[0] != '\0'},
      {"Link", link, net.radio_routed},
      {"Wi-Fi", wifi, net.radio_routed},
      {"Address", addr, net.ip[0] != '\0'},
      {"Saved networks", saved, true},
      {"USB", usb_attached() ? "Connected" : "Not connected", true},
  };
  const int n = (int)(sizeof ROWS / sizeof ROWS[0]);
  const int pitch = 46;

  fill(0, BODY_Y, UI_W, UI_H - BODY_Y, W_FACE);
  const int lh = n * pitch + 4;
  well(LIST_X - 2, LIST_Y - 2, LIST_W + 4, lh);
  for (int i = 0; i < n; i++) {
    draw_row_at(LIST_X, LIST_W, LIST_Y + i * pitch, pitch, false, false, ROWS[i].enabled,
                ROWS[i].title, ROWS[i].value, false);
  }

  /* One line, and it has to say which of the two things is wrong. There is no
   * on-screen keyboard on purpose: a passphrase entered on a 480x800 panel
   * with no physical keys is worse than the USB path, and building a bad one
   * to claim independence from Studio would be the wrong trade. */
  const int y = LIST_Y + lh + 14;
  if (!net.radio_fitted) {
    text(&UI_FONT_S, 24, y, "No radio on this body. Photos leave over USB-C.", W_GRAYTEXT);
  } else if (!net.radio_routed) {
    text(&UI_FONT_S, 24, y, "The C6 radio is fitted, but this firmware has no", W_GRAYTEXT);
    text(&UI_FONT_S, 24, y + 20, "route to it. Photos leave over USB-C.", W_GRAYTEXT);
  } else if (net.state != NET_IP_READY) {
    text(&UI_FONT_S, 24, y, "Set up Wi-Fi in Studio over USB-C.", W_GRAYTEXT);
  } else {
    text(&UI_FONT_S, 24, y, "Captures upload to the active roll.", W_GRAYTEXT);
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
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_STORAGE);

  storage_status_t sd;
  storage_get_status(&sd);
  char freeb[24], capb[24], cnt[16];
  human_bytes(freeb, sizeof freeb, sd.free_bytes);
  human_bytes(capb, sizeof capb, sd.capacity_bytes);
  snprintf(cnt, sizeof cnt, "%d", gallery_total());

  /* While the wipe runs, the Photos row counts down instead of the label
   * saying nothing for the minute a card of 500 captures takes. One line, in
   * the row that owns the number, because the alternative is a progress dialog
   * that has to be dismissed before the camera is usable again. */
  char busy[24] = "";
  if (gallery_deleting()) {
    int done = 0, total = 0;
    gallery_delete_progress(&done, &total);
    snprintf(busy, sizeof busy, "DELETING %d OF %d", done, total);
  }
  const bool wiping = busy[0] != '\0';

  draw_list_frame(5);
  draw_row(LIST_Y, false, false, true, "Card", sd.mounted ? capb : "None", false);
  draw_row(LIST_Y + ROW_H, false, false, true, "Free space", sd.mounted ? freeb : "-", false);
  draw_row(LIST_Y + 2 * ROW_H, false, false, true, "Photos", wiping ? busy : cnt, false);
  /* Both destructive rows are live only with a card mounted, and neither is
   * live while the other is running: a FORMAT pressed into a running wipe
   * would be two things deleting the same directory. */
  draw_row(LIST_Y + 3 * ROW_H, foc(SCR_STORAGE, ST_IT_DELETE_ALL),
           s_pressed == ST_IT_DELETE_ALL, sd.mounted && !wiping && gallery_total() > 0,
           "Delete all photos", NULL, true);
  draw_row(LIST_Y + 4 * ROW_H, foc(SCR_STORAGE, ST_IT_FORMAT), s_pressed == ST_IT_FORMAT,
           sd.mounted && !wiping, "Format card", NULL, true);

  /*
   * The 145 px under the list.
   *
   * Everything here was already in storage_status_t and none of it was drawn:
   * the filesystem, the write test, the mount attempt count and the last error.
   * The bar is not decoration either - it is the used/capacity ratio, which is
   * the one thing "28.5 GB free" does not tell you at a glance, and the
   * question this screen exists to answer is whether there is room for tonight.
   *
   * Strictly BELOW the five rows. The two destructive rows are hit-tested at
   * LIST_Y + (3 + i) * ROW_H, so a row added above them would move both
   * rectangles away from what is drawn and put FORMAT CARD under the finger
   * aiming at DELETE ALL. Nothing here is a target and nothing here moved the
   * list.
   */
  const int by = LIST_Y + 5 * ROW_H + 28;

  if (!sd.mounted) {
    /* Why, not just that. mount_attempts separates "no card in the slot" from
     * "a card the driver has tried and failed to mount", which are different
     * problems and the screen used to show the same "None" for both. */
    text(&UI_FONT_M, 24, by, sd.present ? "Card present, not mounted" : "No card in the slot",
         W_TEXT);
    char detail[80];
    if (sd.last_error != NULL && sd.last_error[0] != '\0') {
      snprintf(detail, sizeof detail, "%s, after %u mount attempt%s", sd.last_error,
               (unsigned)sd.mount_attempts, sd.mount_attempts == 1 ? "" : "s");
    } else {
      snprintf(detail, sizeof detail, "%u mount attempt%s since boot",
               (unsigned)sd.mount_attempts, sd.mount_attempts == 1 ? "" : "s");
    }
    text(&UI_FONT_S, 24, by + 30, detail, W_GRAYTEXT);
    return;
  }

  /* The gauge: a sunken trough with a raised navy bar standing in it.
   *
   * The trough was already a well. What it held was a flat navy rectangle,
   * which is the one surface on the interface with no edge on it at all - and
   * on a gauge that is exactly the wrong thing to leave flat, because the
   * boundary between full and empty IS the reading. A 2 px raised edge in two
   * tones of the selection navy puts it where the eye already looks.
   *
   * Below 5 px of fill there is no room for a raised edge, so a nearly-empty
   * card shows the flat sliver instead: a bevel wider than the thing it is
   * bevelling is a solid block of highlight, which reads as MORE used space
   * rather than less. */
  const int bx = 24, bw = UI_W - 48, bh = 26;
  const uint64_t total_b = sd.capacity_bytes;
  const uint64_t used = total_b > sd.free_bytes ? total_b - sd.free_bytes : 0;
  well(bx, by, bw, bh);
  if (total_b > 0) {
    /* 64-bit before the divide: a 32 GB card times bw overflows 32 bits. */
    int fw = (int)((used * (uint64_t)(bw - 4)) / total_b);
    /* A card with anything at all on it shows at least one pixel: a bar that
     * is empty at 40 MB used looks like a bar that is not working. */
    if (fw == 0 && used > 0) fw = 1;
    fill(bx + 2, by + 2, fw, bh - 4, W_SEL);
    if (fw >= 5) bevel4(bx + 2, by + 2, fw, bh - 4, W_SEL_LT, W_SEL, W_SEL_DK, W_SEL);
  }

  char usedb[24];
  human_bytes(usedb, sizeof usedb, used);
  char line[80];
  snprintf(line, sizeof line, "%s used", usedb);
  text(&UI_FONT_S, bx, by + bh + 8, line, W_GRAYTEXT);
  /* The write test is the only thing here that says the card can be WRITTEN
   * to, which is the property a capture depends on and free space is not. */
  snprintf(line, sizeof line, "%s, write test %s", sd.filesystem != NULL ? sd.filesystem : "-",
           sd.write_test != NULL ? sd.write_test : "none");
  text_right(&UI_FONT_S, bx + bw, by + bh + 8, line, W_GRAYTEXT);
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

/**
 * The four cameras, cached, refreshed at most every two seconds.
 *
 * camlink_get_info_ch() bounds its wait at 20 ms per channel and then reads
 * unlocked anyway (cam_link.c), so four channels is up to 80 ms of contention
 * on the channel locks - INSIDE a draw. That matters because the hardware
 * shutter fires from any screen: request() holds a channel lock across a whole
 * round trip, and an information screen does not get to compete with a capture
 * for it once per repaint.
 *
 * Two seconds because nothing on this row moves faster than that. Node firmware
 * and the sensor model do not change while someone reads a screen, and `online`
 * going stale by two seconds is still news by the time it is shown.
 *
 * Returns the static array rather than filling the caller's - four
 * camlink_info_t is about 512 bytes, and this task has 8 KB and a history of
 * canary panics over exactly that kind of local.
 */
static const camlink_info_t *about_cameras(void) {
  static camlink_info_t s_cam[4];
  static int64_t s_when_us;
  const int64_t now = esp_timer_get_time();
  if (s_when_us == 0 || now - s_when_us > 2000000) {
    s_when_us = now;
    for (int i = 0; i < 4; i++) camlink_get_info_ch(i, &s_cam[i]);
  }
  return s_cam;
}

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
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_ABOUT);

  /* body.name, and only when someone has set one.
   *
   * Copied rather than held: config_str() hands back a slot in a four-deep
   * ring shared by every task, and any second read is free to land in the same
   * slot. 24 characters is the limit SET_CONFIG enforces; 32 is room for it and
   * the NUL with margin. */
  char name[32];
  config_str_copy("body.name", name, sizeof name);
  const bool named = name[0] != '\0';

  storage_status_t sd;
  storage_get_status(&sd);

  /* card is sized off human_bytes's two 24-byte outputs plus the joining
   * words, not off what a 32 GB card happens to format to. */
  char card[64], up[16], proto[16];
  if (sd.mounted) {
    char freeb[24], capb[24];
    human_bytes(freeb, sizeof freeb, sd.free_bytes);
    human_bytes(capb, sizeof capb, sd.capacity_bytes);
    snprintf(card, sizeof card, "%s free of %s", freeb, capb);
  } else {
    snprintf(card, sizeof card, "%s", sd.present ? "Not mounted" : "None");
  }
  about_uptime(up, sizeof up);
  snprintf(proto, sizeof proto, "KDP %d", KDP_PROTOCOL_VERSION);

  /* The serial. Still shown when a name is set: the name is what a person
   * calls the camera, the serial is what a support question needs, and neither
   * substitutes for the other. Empty only if the KDP server has not started,
   * which cannot happen from this screen - app_main() starts it long before
   * ui_start() - so a dash here would be a state nobody can reach. */
  const char *serial = kdp_device_serial();

  /* ---- left column: the body ---- */
  const struct {
    const char *title;
    const char *value;
  } ROWS[] = {
      {"Model", "KINO D4"},
      {"Hardware", KDP_HARDWARE_REV},
      {"Firmware", KINO_FW_VERSION},
      {"Serial", serial[0] != '\0' ? serial : "-"},
      {"Protocol", proto},
      {"Card", card},
      {"Uptime", up},
  };
  const int n = (int)(sizeof ROWS / sizeof ROWS[0]);

  const int lh = n * AB_ROW + 4;
  well(AB_LX - 2, LIST_Y - 2, AB_LW + 4, lh);
  for (int i = 0; i < n; i++) {
    draw_row_at(AB_LX, AB_LW, LIST_Y + i * AB_ROW, AB_ROW, false, false, true, ROWS[i].title,
                ROWS[i].value, false);
  }

  /* The name under the list rather than in it: it is the only row here a
   * person sets, so it is not the same kind of fact as the seven above. */
  if (named) {
    const int ny = LIST_Y + lh + 12;
    /* NAME as a group-box legend, on the same rule as CAMERAS across the
     * gutter: it was the last bare word on this screen, and a caption over a
     * value with nothing round either is what the whole rework is removing. */
    group_box(AB_LX - 8, ny, AB_LW + 16, 20 + UI_FONT_M.line_h + 8, "NAME", W_TEXT, NULL);
    text(&UI_FONT_M, AB_LX, ny + 20, name, W_TEXT);
  }

  /* ---- right column: the four cameras ----
   *
   * CAMERAS was a bare grey word sitting above a well, which on a two-column
   * screen is ambiguous about which column it names. It is the legend of a
   * group box now, and the box encloses the well AND the two lines of note
   * under it - the note is about these four rows and nothing else, and there
   * was no mark on the screen that said so. */
  const int cy0 = LIST_Y + 20;
  const int ch = 4 * AB_CAM_ROW + 4;
  group_box(AB_RX - 8, LIST_Y - 2, AB_RW + 16,
            (cy0 + ch + 30 + UI_FONT_S.line_h + 8) - (LIST_Y - 2), "CAMERAS", W_TEXT, NULL);
  well(AB_RX - 2, cy0 - 2, AB_RW + 4, ch);

  const camlink_info_t *cams = about_cameras();
  for (int i = 0; i < 4; i++) {
    /* By pointer, not by value: the struct is about 128 bytes and this loop
     * runs four times in a draw path with 8 KB of stack. */
    const camlink_info_t *info = &cams[i];

    char label[8];
    snprintf(label, sizeof label, "CAM%d", i + 1);

    /* Firmware and sensor when the node answered; "No answer" when it did not.
     * NOT "not fitted": camlink cannot tell an empty header from a node that
     * is wedged, and the two want different things done about them. */
    char val[40]; /* firmware[16] + sensor[16] + the two spaces */
    if (info->online) {
      snprintf(val, sizeof val, "%s  %s", info->firmware,
               info->sensor[0] != '\0' ? info->sensor : "no sensor");
    } else {
      snprintf(val, sizeof val, "No answer");
    }
    draw_row_at(AB_RX, AB_RW, cy0 + i * AB_CAM_ROW, AB_CAM_ROW, false, false, info->online, label,
                val, false);
  }

  /* Node firmware is per camera and the four can differ - a node reflashed on
   * its own is the normal way that happens - which is the whole reason this is
   * four rows and not one summary line. */
  text(&UI_FONT_S, AB_RX, cy0 + ch + 10, "Node firmware, then the sensor", W_GRAYTEXT);
  text(&UI_FONT_S, AB_RX, cy0 + ch + 30, "each node reports.", W_GRAYTEXT);
}

/* ------------------------------------------------------------------ */
/* Power                                                               */
/* ------------------------------------------------------------------ */

static void draw_power(void) {
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_POWER);
  /* Shut down is drawn disabled: power.c controls the backlight and the
   * camera bank and has no power-off at all, and there is no soft latch in
   * the pin map for one. Restart is real. */
  /*
   * In the list well every other list on this camera sits in, at LIST_Y.
   *
   * It was three bare rows drawn from BODY_Y with no frame at all, and the
   * frame was not the only thing missing: hit_test() has always tested this
   * screen at LIST_Y + i * ROW_H, which is 12 px BELOW where the rows were
   * drawn. So the bottom 12 px of "Cancel" did nothing and the 12 px of face
   * grey above "Shut down" quietly armed it. Moving the drawing to where the
   * rectangles already are fixes both, and gives the screen the well.
   */
  draw_list_frame(3);
  draw_row(LIST_Y, foc(SCR_POWER, 0), s_pressed == 0, false, "Shut down", "Hold the power slide",
           false);
  draw_row(LIST_Y + ROW_H, foc(SCR_POWER, 1), s_pressed == 1, true, "Restart", NULL, true);
  draw_row(LIST_Y + 2 * ROW_H, foc(SCR_POWER, 2), s_pressed == 2, true, "Cancel", NULL, false);
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
  switch (s_dialog) {
    case DLG_RESTART:
      *d = (dlg_spec_t){"RESTART", "Restart KINO D4?", NULL, "RESTART", false};
      break;
    case DLG_DELETE:
      snprintf(sub, sizeof sub, "%d frames. This cannot be undone.", s_photo_frames);
      *d = (dlg_spec_t){"DELETE", "Delete this photo?", sub, "DELETE", true};
      break;
    case DLG_DELETE_ALL:
      snprintf(sub, sizeof sub, "%d photos. This cannot be undone.", gallery_total());
      /* "photos", and the sub line says how many, because that is the number a
       * person checks before pressing this. It says nothing about sounds,
       * looks or settings on purpose: they are not touched, and listing what
       * survives a destructive action reads as a warning about them. */
      *d = (dlg_spec_t){"DELETE ALL", "Delete every photo?", sub, "DELETE ALL", true};
      break;
    case DLG_FORMAT:
      snprintf(sub, sizeof sub, "All %d photos will be deleted.", gallery_total());
      *d = (dlg_spec_t){"FORMAT CARD", "Erase the card?", sub, "FORMAT", true};
      break;
    default:
      *d = (dlg_spec_t){"SHUT DOWN", "Shut down KINO D4?", NULL, "SHUT DOWN", false};
      break;
  }
}

#define DLG_W 430
#define DLG_X ((UI_W - DLG_W) / 2)
#define DLG_Y 132
#define DLG_BTN_W 148
#define DLG_BTN_H 44
/* One definition of where the two buttons are, because there were two and
 * they disagreed: the draw used a 16 px inset and the hit test used 18, so
 * both rects were 2 px off the pixels they belonged to and a press on the
 * outer edge of CANCEL or the confirm landed on nothing. The gap between the
 * pair is 10 px. `h` is the dialog height, which depends on whether the spec
 * carries a subtitle, so the baseline has to be passed it. */
#define DLG_BTN_INSET 16
#define DLG_BTN_GAP 10
#define DLG_BTN_Y(h) (DLG_Y + (h) - DLG_BTN_H - DLG_BTN_INSET)
#define DLG_BTN_X2 (DLG_X + DLG_W - DLG_BTN_INSET - DLG_BTN_W)
#define DLG_BTN_X1 (DLG_BTN_X2 - DLG_BTN_GAP - DLG_BTN_W)

static void draw_dialog(void) {
  /* Scrim over whatever is behind, so the decision is the only live thing.
   * Heavy enough that the screen underneath reads as unavailable rather than
   * merely tinted - a half-lit list still invites a press. */
  scrim(0, 0, UI_W, UI_H, RGB(0x10, 0x16, 0x1e), 190);

  dlg_spec_t d;
  dialog_spec(&d);
  const int h = d.sub ? 196 : 168;

  /* A dialog window: raised face, a title bar in the same blue as a screen
   * header, and buttons on the baseline. No minimise, no maximise, no drag -
   * this is a camera, not a window manager. */
  fill(DLG_X, DLG_Y, DLG_W, h, W_FACE);
  bevel_raised(DLG_X, DLG_Y, DLG_W, h);

  /* The same three surfaces as a screen header, at dialog scale: a raised bar
   * inside the raised window, the caption plate on the bar, and the caption
   * inset from the plate by the header's own padding. Dithered like the
   * header - a 422 px ramp through RGB565 bands harder than a 790 px one, not
   * less. */
  const int bx = DLG_X + 3, by = DLG_Y + 3, bw = DLG_W - 6, bh = 32;
  bevel_raised(bx, by, bw, bh);
  grad_h(bx + 2, by + 2, bw - 4, bh - 4,
         d.destructive ? RGB(0x80, 0x00, 0x00) : W_TITLE_L,
         d.destructive ? RGB(0xd0, 0x40, 0x10) : W_TITLE_R);
  text(&UI_FONT_S, bx + 2 + HD_CAP_PAD, by + (bh - UI_FONT_S.line_h) / 2, d.title, W_SELTEXT);

  text(&UI_FONT_M, DLG_X + 20, DLG_Y + 56, d.body, W_TEXT);
  if (d.sub) text(&UI_FONT_S, DLG_X + 20, DLG_Y + 90, d.sub, RGB(0x40, 0x40, 0x40));

  const int fy = DLG_BTN_Y(h);
  const int b2 = DLG_BTN_X2;
  const int b1 = DLG_BTN_X1;

  button(b1, fy, DLG_BTN_W, DLG_BTN_H, s_pressed == 0);
  text_mid(&UI_FONT_M, b1 + DLG_BTN_W / 2 + (s_pressed == 0 ? 1 : 0),
           fy + (DLG_BTN_H - UI_FONT_M.line_h) / 2 + (s_pressed == 0 ? 1 : 0), "CANCEL", W_TEXT);
  if (s_dlg_focus == 0) focus_inset(b1, fy, DLG_BTN_W, DLG_BTN_H, W_TEXT);

  button(b2, fy, DLG_BTN_W, DLG_BTN_H, s_pressed == 1);
  text_mid(&UI_FONT_M, b2 + DLG_BTN_W / 2 + (s_pressed == 1 ? 1 : 0),
           fy + (DLG_BTN_H - UI_FONT_M.line_h) / 2 + (s_pressed == 1 ? 1 : 0), d.go,
           d.destructive ? RGB(0x90, 0x00, 0x00) : W_TEXT);
  if (s_dlg_focus == 1) focus_inset(b2, fy, DLG_BTN_W, DLG_BTN_H, W_TEXT);
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
static void draw_capture_banner(void) {
  const capture_stage_t cs = capture_stage();
  if (cs == CAPTURE_IDLE) return;

  capture_report_t r;
  capture_last(&r);

  fm_cell_t st[4] = {FM_OFF, FM_OFF, FM_OFF, FM_OFF};
  char line[64];
  uint16_t accent = C_BLUE;
  switch (cs) {
    case CAPTURE_TRIGGERING:
      st[0] = FM_ON;
      snprintf(line, sizeof line, "SHOOTING");
      break;
    case CAPTURE_READING:
      st[0] = st[1] = FM_ON;
      snprintf(line, sizeof line, "READING");
      break;
    case CAPTURE_WRITING:
      st[0] = st[1] = st[2] = FM_ON;
      snprintf(line, sizeof line, "SAVING");
      break;
    default:
      if (!r.ok) {
        for (int i = 0; i < 4; i++) st[i] = FM_LOST;
        snprintf(line, sizeof line, "%s", r.err_code[0] ? r.err_code : "NO PHOTO");
        accent = C_BAD;
      } else {
        /* One cell per camera that actually delivered, and the rest marked
         * lost. A partial capture says which, because "3/4" with three lit
         * cells is a fact and "SAVED" alone is not. */
        for (int i = 0; i < 4; i++) st[i] = i < r.stored ? FM_SPARK : FM_LOST;
        snprintf(line, sizeof line, "%d/%d SAVED", r.stored, r.online);
        accent = r.stored == r.online ? C_OK : C_BAD;
      }
      break;
  }

  /* Full width everywhere now. There is nothing in the bottom of the shoot
   * screen to protect - it is all picture, and a report about the photograph
   * is allowed to sit over the photograph for a moment. */
  const int h = 40, y = UI_H - h;
  const int w = UI_W;
  fill(0, y, w, h, RGB(0x12, 0x16, 0x1c));
  fill(0, y, w, 1, accent);
  fill(0, y + 1, 5, h - 1, accent);

  const int cell = 12;
  four_mark(18, y + (h - cell) / 2, cell, st, true);
  text(&UI_FONT_S, 18 + 4 * (cell + FM_GAP) + 10, y + (h - UI_FONT_S.line_h) / 2, line,
       RGB(0xe4, 0xe9, 0xee));
}

static void draw_toast(void) {
  if (s_toast[0] == '\0') return;
  if (esp_timer_get_time() - s_toast_us > 2200000) { s_toast[0] = '\0'; return; }
  /*
   * A tooltip, not a lozenge.
   *
   * It was a rounded dark gradient plate with a soft grey keyline - a modern
   * toast, and the single most out-of-period object on the screen: nothing in
   * 1998 had a rounded corner, and the two things this interface uses to say
   * "surface" are a bevel and a groove, neither of which a rounded rectangle
   * can carry. The system already had a word for a transient message that is
   * not a window: INFOBK, one black hairline, black text, square corners. That
   * is what this is now, and it is also more legible - the old plate put
   * near-white 18 px type on a dark ground over whatever screen it covered.
   */
  /*
   * Where it rests.
   *
   * It floated 44 px off the bottom on every screen, which on the menu put it
   * across the SETTINGS tile's label - a tooltip covering the control it was
   * raised by. "Mode: Quad" over the word SETTINGS is the exact failure: the
   * message explains a press and hides what was pressed.
   *
   * So the strip is the bottom band, the height of the menu's status bar and
   * flush with it, and on the menu that IS the status bar - which is where a
   * windowed system has always put a transient message. On the gallery it
   * lands between PREV and NEXT, inside the footer's own panel, because every
   * gallery message ("Card busy") is narrower than the gap between them. On
   * the list screens the band is bare face grey.
   *
   * Two screens keep controls down there and get the band above instead: the
   * photograph, whose DELETE / FAVOURITE row is 34 px off the bottom, and the
   * finder, whose status bar and capture banner both own the foot. On both,
   * what it covers instead is the picture - which is content, and content is
   * what a tooltip is allowed to float over.
   */
  const int w = text_w(&UI_FONT_S, s_toast) + 32, h = 34;
  int y = UI_H - 2 - h;
  if (s_screen == SCR_PHOTO) y = PH_CAP_Y - h - 8;
  else if (s_screen == SCR_SHOOT) y = SH_BAR_Y - h - 8;
  const int x = (UI_W - w) / 2;
  fill(x, y, w, h, W_INFO);
  outline(x, y, w, h, W_TEXT);
  text_mid(&UI_FONT_S, UI_W / 2, y + (h - UI_FONT_S.line_h) / 2, s_toast, W_TEXT);
}

static void draw_screen(void) {
  switch (s_screen) {
    case SCR_MENU: draw_menu(); break;
    case SCR_SHOOT: draw_shoot(); break;
    case SCR_LOOK: draw_look(); break;
    case SCR_GALLERY: draw_gallery(); break;
    case SCR_PHOTO: draw_photo(); break;
    case SCR_ROLL: draw_roll(); break;
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
  if (s_dialog != DLG_NONE) draw_dialog();
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

static void fire_shutter(bool long_press);

static void go(screen_t s, int dissolve_ms) {
  if (s == SCR_GALLERY) gallery_refresh();
  if (s_screen == SCR_PHOTO && s != SCR_PHOTO) photo_release();
  s_screen = s;
  s_pressed = -1;
  gfx_snapshot();
  draw_screen();
  gfx_dissolve(dissolve_ms);
}

static void go_back(void) {
  /* One level up, deterministically. Back on the viewfinder and back on the
   * menu both land on the menu, which is the camera's home. */
  go(SCREEN_PARENT[s_screen], 180);
}

/* Number of focusable items on a screen. */
static int item_count(screen_t s) {
  switch (s) {
    case SCR_MENU: return 6;
    case SCR_SHOOT: return 1;
    /* The TARGET row is the last band, so WIGGLE simply stops short of it
     * and every index below keeps its meaning in both modes. */
    case SCR_LOOK: return mode_is_quad() ? LK_IT_COUNT : LK_IT_TARGET;
    case SCR_GALLERY: return gallery_pages() > 1 ? 8 : GALLERY_PAGE;
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
  dlg_spec_t d;
  dialog_spec(&d);
  const int h = d.sub ? 196 : 168;
  const int by = DLG_BTN_Y(h);
  const int bx2 = DLG_BTN_X2;
  const int bx1 = DLG_BTN_X1;
  if (in(x, y, bx1, by, DLG_BTN_W, DLG_BTN_H)) return 0;
  if (in(x, y, bx2, by, DLG_BTN_W, DLG_BTN_H)) return 1;
  return -1;
}

static int hit_test(int x, int y) {
  if (s_dialog != DLG_NONE) return hit_dialog(x, y);

  switch (s_screen) {
    case SCR_MENU:
      for (int i = 0; i < 6; i++) {
        int tx, ty;
        tile_rect(i, &tx, &ty);
        if (in(x, y, tx, ty, M_TILE_W, M_TILE_H)) return i;
      }
      return -1;

    case SCR_SHOOT:
      /* The plate, plus 8 px of slop on every side. It was a bare 150x70 box
       * in the corner, drawn from 0,0 - which was the only honest thing to do
       * when the marking had no edges, and which meant a third of the target
       * was over picture with nothing on it. Now the target is the button
       * with a margin: 132x60 around a 116x44 plate, well over the 44 px
       * floor, and every part of it looks pressable because it is. */
      if (in(x, y, SH_BACK_X - 8, SH_BACK_Y - 8, SH_BACK_W + 16, SH_BACK_H + 16))
        return SH_IT_BACK;
      return -1;

    case SCR_PHOTO: {
      if (in(x, y, 0, 0, 150, 40)) return IT_BACK;
      /* The same PH_BTN_X/PH_BTN_W the draw uses. SEND TO ROLL is deliberately
       * not a target: it is drawn dead, and a press that lands on it should do
       * nothing rather than raise a toast about a radio that is not there. */
      if (in(x, y, PH_BTN_X(0), PH_BTN_Y, PH_BTN_W, PH_BTN_H)) return P_IT_DELETE;
      if (in(x, y, PH_BTN_X(1), PH_BTN_Y, PH_BTN_W, PH_BTN_H)) return P_IT_FAV;
      return -1;
    }

    default: break;
  }

  /* Every other screen has the standard header, and the whole of it goes
   * back: a 26 px chevron is a smaller target than a thumb is wide. */
  if (y < HEAD_H) return IT_BACK;

  switch (s_screen) {
    case SCR_LOOK: {
      /* The picker first: its two buttons sit inside row 2, which no
       * segmented band covers, so the order costs nothing and keeps the
       * segment loop uniform. */
      const int pry = lk_ctl_y(2);
      if (in(x, y, LK_X, pry, LK_PICK_BTN, LK_CTL_H)) return LK_IT_PREV;
      if (in(x, y, LK_X + LK_W - LK_PICK_BTN, pry, LK_PICK_BTN, LK_CTL_H)) return LK_IT_NEXT;

      /* Row, base item, and how many segments - the same table the drawing
       * walks, so a row moved there moves here. */
      static const int ROW[4] = {0, 1, 3, LK_ROW_TARGET};
      static const int BASE[4] = {LK_IT_MODE, LK_IT_FLASH, LK_IT_COLOR, LK_IT_TARGET};
      static const int COUNT[4] = {2, 3, 2, 5};
      const int rows = mode_is_quad() ? 4 : 3; /* no TARGET row in WIGGLE */
      for (int r = 0; r < rows; r++) {
        const int ry = lk_ctl_y(ROW[r]);
        if (y < ry || y >= ry + LK_CTL_H) continue;
        const int cw = LK_W / COUNT[r];
        for (int i = 0; i < COUNT[r]; i++) {
          if (in(x, y, LK_X + i * cw, ry, cw, LK_CTL_H)) return BASE[r] + i;
        }
      }
      return -1;
    }
    case SCR_GALLERY: {
      if (gallery_total() == 0) return -1;
      for (int i = 0; i < GALLERY_PAGE; i++) {
        int gx, gy;
        gal_origin(i, &gx, &gy);
        if (in(x, y, gx, gy, G_TILE_W, G_TILE_H + 22)) return i;
      }
      if (gallery_pages() > 1) {
        /* 78, which is what the buttons are drawn at. It was 74, so the outer
         * 4 px of both PREV and NEXT looked pressable and were not. */
        const int fy = UI_H - G_FOOT, bw = 78, bh = 32, by = fy + (G_FOOT - bh) / 2;
        if (in(x, y, 24, by, bw, bh)) return G_IT_PREV;
        if (in(x, y, UI_W - 24 - bw, by, bw, bh)) return G_IT_NEXT;
      }
      return -1;
    }
    case SCR_SETTINGS:
      for (int i = 0; i < 5; i++)
        if (in(x, y, LIST_X, LIST_Y + i * ROW_H, LIST_W, ROW_H)) return i;
      return -1;

    case SCR_DISPLAY: {
      /* The same table the draw walks, and the same cw arithmetic
       * draw_segments() uses, so a band with five segments is tested at five
       * segments rather than at the three the old literal assumed. */
      for (int r = 0; r < DSP_ROWS; r++) {
        const int by = DSP_BAND_Y(r);
        if (y < by || y >= by + DSP_BAND_H) continue;
        const int cw = DSP_W / DSP_ROW[r].count;
        for (int i = 0; i < DSP_ROW[r].count; i++) {
          if (in(x, y, DSP_X + i * cw, by, cw, DSP_BAND_H)) return DSP_ROW[r].base + i;
        }
      }
      return -1;
    }
    case SCR_SOUND: {
      /* The picker's buttons before the row they sit in, or the row would
       * swallow them. The rest of row 0 is not a target - the row is a label
       * and a value, and only the arrows do anything. */
      const int by = sn_btn_y();
      if (in(x, y, sn_prev_x(), by, SN_BTN, SN_BTN)) return SN_IT_PREV;
      if (in(x, y, sn_next_x(), by, SN_BTN, SN_BTN)) return SN_IT_NEXT;
      if (in(x, y, LIST_X, LIST_Y + ROW_H, LIST_W, ROW_H)) return SN_IT_SHUTTER;
      if (in(x, y, LIST_X, LIST_Y + 2 * ROW_H, LIST_W, ROW_H)) return SN_IT_BUTTON;
      const int y0 = LIST_Y + 3 * ROW_H + 26, sw = (UI_W - 48) / 3;
      for (int i = 0; i < 3; i++)
        if (in(x, y, 24 + i * sw, y0 + 24, sw, 44)) return SN_IT_VOL + i;
      return -1;
    }
    case SCR_STORAGE:
      /* Rows 0..2 are readings and take no press. The two that act are drawn
       * at 3 and 4, so the item number is the row minus three - one place, so
       * the draw and the hit test cannot disagree about which of two
       * destructive rows was pressed. */
      for (int i = 0; i < ST_IT_COUNT; i++)
        if (in(x, y, LIST_X, LIST_Y + (3 + i) * ROW_H, LIST_W, ROW_H)) return i;
      return -1;

    case SCR_POWER:
      for (int i = 0; i < 3; i++)
        if (in(x, y, LIST_X, LIST_Y + i * ROW_H, LIST_W, ROW_H)) return i;
      return -1;

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
      fill(0, 0, UI_W, UI_H, W_FACE);
      text_mid(&UI_FONT_M, UI_W / 2, UI_H / 2 - UI_FONT_M.line_h / 2, "RESTARTING", W_TEXT);
      gfx_present();
      vTaskDelay(pdMS_TO_TICKS(420));
      crt_collapse();
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
        toast("Card busy");
        audio_warning();
        break;
      }
      storage_capture_delete(dir);
      storage_release(STORAGE_USER_UI);
      photo_release();
      /* Told, not discovered, and before the refresh: the gallery's order
       * index still names this capture, and the only other way it would find
       * out is a tile failing to open its META.JSON - which costs a full walk
       * of the card. Non-blocking; the gallery task does the work. */
      gallery_note_removed(s_photo_id);
      gallery_refresh();
      toast("Deleted");
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
      toast("Deleting photos");
      break;
    case DLG_FORMAT:
      /* Not wired: there is no format entry point in storage.c, and calling
       * a delete loop over user captures under the name "format" would be a
       * different operation wearing the label. */
      toast("Format is not available yet");
      break;
    default:
      toast("Hold the power slide to switch off");
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

  switch (s_screen) {
    case SCR_MENU:
      if (item >= 0 && item < 6) {
        s_focus[SCR_MENU] = item;
        go(MENU_DEST[item], 220);
      }
      return;

    case SCR_SHOOT:
      if (item == SH_IT_BACK) { go_back(); return; }
      break;

    case SCR_LOOK:
      if (item < LK_IT_FLASH) {
        cfg_set_str("mode", item == 1 ? "quad" : "wiggle");
        toast(item == 1 ? "QUAD" : "WIGGLE");
        /* WIGGLE has fewer items than QUAD, so a focus parked on the TARGET
         * row has just stopped existing. Left alone it draws nowhere and the
         * next key press acts on nothing. */
        if (s_focus[SCR_LOOK] >= item_count(SCR_LOOK)) s_focus[SCR_LOOK] = 0;
      } else if (item < LK_IT_PREV) {
        cfg_set_str("shoot.flashMode", FLASH_ORDER_BY_INDEX[item - LK_IT_FLASH]);
      } else if (item <= LK_IT_NEXT) {
        look_step(item == LK_IT_NEXT ? 1 : -1);
      } else if (item < LK_IT_TARGET) {
        look_set_mono(item == LK_IT_COLOR + 1);
        toast(item == LK_IT_COLOR + 1 ? "B&W" : "COLOUR");
      } else if (item < LK_IT_COUNT) {
        /* Which camera the next look lands on. Nothing is written here: it
         * changes what the picker above is describing, and pressing it must
         * not overwrite four slots by itself. */
        s_look_target = item - LK_IT_TARGET;
      }
      break;

    case SCR_GALLERY:
      if (item == G_IT_PREV) { gallery_turn(-1); break; }
      if (item == G_IT_NEXT) { gallery_turn(1); break; }
      if (item >= 0 && item < GALLERY_PAGE) {
        const gallery_item_t *slots = gallery_slots();
        if (slots[item].state == TILE_EMPTY) break;
        /* The card was busy, so nothing was decoded. Stay on the gallery and
         * say why rather than opening an empty photograph screen that looks
         * like a lost capture. */
        if (!photo_open(&slots[item])) {
          toast("Card busy");
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
        if (gallery_total() <= 0) {
          toast("No photos on the card");
          break;
        }
        s_dialog = DLG_DELETE_ALL;
        s_dlg_focus = 0;
      } else if (item == ST_IT_FORMAT) {
        s_dialog = DLG_FORMAT;
        s_dlg_focus = 0;
      }
      break;

    case SCR_POWER:
      if (item == 0) { toast("Hold the power slide to switch off"); break; }
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

/* From the menu, the shutter opens the viewfinder rather than taking a
 * photograph of the inside of a bag. From the viewfinder it captures. That is
 * the safest camera-like reading of a single-stage button.
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

static void icons_task(void *arg) {
  (void)arg;
  const int64_t t0 = esp_timer_get_time();
  if (icons_build() != ESP_OK) ESP_LOGW(TAG, "icons unavailable - the menu will be empty");
  else ESP_LOGI(TAG, "icons ready in %lu ms",
                (unsigned long)((esp_timer_get_time() - t0) / 1000));
  /* Hand the registry a last reading while this stack still exists. Without
   * it the registry keeps querying a freed TCB for the life of the device. */
  taskmon_task_done("icons");
  vTaskDelete(NULL);
}

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

static void ui_task(void *arg) {
  (void)arg;
  splash();

  for (int i = 0; i < 200 && !icons_ready(); i++) vTaskDelay(pdMS_TO_TICKS(10));

  gfx_snapshot();
  draw_screen();
  uint32_t f0 = 0, f1 = 0, ms = 0;
  gfx_stats(&f0, NULL);
  gfx_dissolve(420);
  gfx_stats(&f1, &ms);
  ESP_LOGI(TAG, "boot dissolve: %lu frames in %lu ms (%lu fps)", (unsigned long)(f1 - f0),
           (unsigned long)ms, (unsigned long)(ms ? (f1 - f0) * 1000 / ms : 0));

  int held = -1;
  int64_t s_ui_report_us = 0;
  uint32_t s_ui_last_frames = 0;
  ui_health_t health = {0};
  int64_t wake_since_us = 0;
  bool was_asleep = false;
  /* True from the touch that dismissed a held report until that finger lifts,
   * so the dismissal does not also press whatever was underneath it. */
  bool swallow_touch = false;

  for (;;) {
    /* The pulse, first thing and unconditionally. Several branches below
     * `continue`, and a stamp that some passes skip reads as a wedge on a loop
     * that is merely swallowing a wake press. */
    s_ui_pass++;
    s_ui_pass_ms = (uint32_t)(esp_timer_get_time() / 1000);

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
     * Nothing else in the loop presents a frame while the menu is idle - it
     * has no reason to, the picture has not changed - so after a sleep the
     * screen depends entirely on the framebuffer having survived with the
     * backlight off. If it did not, for any reason, the camera comes back
     * showing nothing and every press lands on a screen the user cannot
     * read, which is indistinguishable from a device that has stopped
     * responding. One redraw makes that impossible. */
    power_state_t pst;
    power_get(&pst);
    const bool asleep_now = pst.stage == POWER_ASLEEP;
    if (was_asleep && !asleep_now) {
      ESP_LOGI(TAG, "woke: repainting");
      klog("P4", "woke, repainting");
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
      if (now - wake_since_us < 1200000) {
        vTaskDelay(pdMS_TO_TICKS(20));
        continue;
      }
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
    if (swallow_touch) {
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }

    if (down) {
      /* Touch reports in panel space, so the same quarter turn applies in
       * reverse: touch y is the logical x. */
      const int lx = ty;
      const int ly = DISPLAY_H_RES - 1 - tx;
      region = hit_test(lx, ly);
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
    viewfinder_run(s_screen == SCR_SHOOT);

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
      vTaskDelay(pdMS_TO_TICKS((busy && !wig_pacing) ? 90 : 20));
      continue;
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
       * a second at best. */
      vTaskDelay(pdMS_TO_TICKS(60));
    } else {
      vTaskDelay(pdMS_TO_TICKS(20));
    }
  }
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

  ESP_LOGI(TAG, "UI_READY %dx%d landscape via PPA, tiles %dx%d", UI_W, UI_H, M_TILE_W, M_TILE_H);
  TaskHandle_t ui_h = NULL;
  /* 8192, not 6144. The ROLL screen calls qr_encode(), which puts roughly
   * 1.4 KB of bitfields and codeword buffers on this stack Ã¢â‚¬â€ two 456-byte
   * module grids plus 562 bytes of codewords Ã¢â‚¬â€ on top of whatever the draw
   * path already uses. That figure is CALCULATED from the sizes in qr.c, not
   * measured on a board, so the margin is deliberate: an overflow here would
   * land on a repaint and read as a display or touch fault rather than as a
   * QR encoder. Confirm against GET_RUNTIME_STATS on the first bench run that
   * opens the ROLL screen with a Roll assigned Ã¢â‚¬â€ that is what the per-task
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

  /* The icon builder starts AFTER the UI. Created first it would simply run
   * to completion before the splash existed, because it outranks the task
   * calling ui_start(); created second, the UI task is already animating and
   * blocking on frame timing and the builder fills exactly those gaps. */
  TaskHandle_t ic_h = NULL;
  /* Not fatal, and not silent either: without it icons_ready() never comes
   * true, ui_task waits its 2 s and draws a menu of six labels with no
   * artwork. That is a working camera, but the reason has to be in the log
   * or it looks like the icon baker produced nothing. */
  if (xTaskCreate(icons_task, "icons", 4096, NULL, 3, &ic_h) != pdPASS) {
    ESP_LOGE(TAG, "no room for the icon builder - the menu will have no artwork");
    return ESP_OK;
  }
  taskmon_register("icons", ic_h);
  return ESP_OK;
}
