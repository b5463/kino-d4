#include "ui.h"

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>

#include "audio.h"
#include "buttons.h"
#include "cam_link.h"
#include "capture.h"
#include "cJSON.h"
#include "gallery.h"
#include "calibrate.h"
#include "conditions.h"
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
#include "logo_kino_d4.h"
#include "logo_odd_jobs.h"
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
#define C_YELLOW RGB(0xf4, 0xc5, 0x42)
#define C_RED RGB(0xc8, 0x3a, 0x3a)
/* Red as TYPE, on the dark grounds. C_RED is a mark colour: as a fill or a
 * dot it reads, but as 18 px text on W_WINDOW it measures 3.5:1, under the
 * 4.5:1 the small face needs, and the two places that set it that way were
 * the DELETE label and a destructive dialog's title - the two words on the
 * interface that most need reading. This one measures 5.9:1 there. */
#define C_RED_INK RGB(0xf2, 0x6a, 0x60)
#define C_OK MZ_MINT
#define C_BAD C_RED

/* ------------------------------------------------------------------ */
/* The system palette                                                  */
/*                                                                     */
/* These names are the Windows 98 system colours and the drawing code   */
/* still asks for them by those names, because the *structure* of that  */
/* interface was never the problem: a face, a window, a selection, two  */
/* steps of light and two of shadow is a complete and honest set of     */
/* tokens, and every screen in this firmware is built out of it.        */
/*                                                                     */
/* What changed is what they are worth. The camera is a dark object     */
/* used in dark rooms, and 1998's silver is a value scheme for a lit    */
/* desk - it puts the brightest thing on the panel behind the least     */
/* important thing on it, which is the chrome. So the face went to      */
/* near-black, the text inverted, and the four bevel steps collapsed to */
/* within a few values of the ground: a raised edge is now a hairline   */
/* you can find when you look for it rather than a moulding.            */
/*                                                                     */
/* The selection and the title plate are the two warm colours, and they */
/* are the same two the menu card uses, so a highlight anywhere in the  */
/* product is the same event. One accent, one family, and the chrome    */
/* out of the way of the photographs.                                  */
/* ------------------------------------------------------------------ */
/* The five. Everything on the panel is one of these or the ground.
 *
 * Read off the object this interface is being built to look like rather than
 * mixed: a near-black green ground, one warm card, one warm accent, one cool
 * mint for anything cool, and an ink dark enough to read on the warm two. */
#define MZ_GROUND RGB(0x0b, 0x0d, 0x0c)
#define MZ_CARD RGB(0xe8, 0xa1, 0x83)
#define MZ_CARD_INK RGB(0x2a, 0x14, 0x0c)
#define MZ_MINT RGB(0x86, 0xd6, 0xb4)
#define MZ_ACCENT RGB(0xe8, 0x73, 0x4a)
#define MZ_CARD_DOWN RGB(0xd0, 0x8b, 0x6f) /* the card, pressed */

#define W_FACE RGB(0x0e, 0x12, 0x10)    /* 3D face - the ground for everything */
#define W_HILITE RGB(0x22, 0x2a, 0x26)  /* 3D highlight - outer top/left */
/* The edge of a thing you can press. W_HILITE is a hairline for surfaces that
 * only need to be surfaces - an empty cell of the four-mark, a track under a
 * bar. A control's edge has a job: it is how a thumb finds the control, and
 * WCAG 1.4.11 asks 3:1 against what it sits on for exactly that reason.
 * W_HILITE measured 1.3:1 on the face; this measures 3.4:1 on the face and
 * 3.2:1 on a window. Still one line, still the same hue. */
#define W_KEYLINE RGB(0x5c, 0x6c, 0x64)
#define W_SHADOW RGB(0x07, 0x09, 0x08)  /* 3D shadow - inner bottom/right */
#define W_DKSHAD RGB(0x00, 0x00, 0x00)  /* 3D dark shadow - outer bottom/right */
#define W_WINDOW RGB(0x15, 0x1a, 0x17)  /* window/list ground */
#define W_TEXT RGB(0xed, 0xe7, 0xdd)
/* 5.2:1 on the face, 4.8:1 on a window, 5.4:1 on the ground: the small face
 * is 18 px and needs 4.5. The value before this (6e7d74) measured 4.4 and
 * 4.1, and every caption on LOOK and every note under a list was set in it. */
#define W_GRAYTEXT RGB(0x7a, 0x8a, 0x80)
#define W_SEL RGB(0xe8, 0x73, 0x4a)     /* selection - the accent */
#define W_SELTEXT RGB(0x2a, 0x14, 0x0c)
/* A row you can press: one flat tone for every row of every list. The rows
 * used to step down a warm ramp by position, which tied every screen to the
 * same heat-map and made a screen's top row its loudest object whether or
 * not it mattered; the accent now marks only the row that is pressed. */
#define W_ROW RGB(0x1c, 0x24, 0x1f)
/* The hairline between two facts in a table. */
#define W_RULE RGB(0x27, 0x30, 0x2b)
/* The screen's name, in the menu card's own colour, set straight on the
 * ground. It sat on a plate of that colour before, and a full-width plate
 * of the brightest tone on the panel was the first thing every screen said. */
#define W_TITLE RGB(0xe8, 0xa1, 0x83)
/* A transient message, on the one cool colour in the set. It is a plate and
 * not a bevel, because a tooltip is neither a window nor a control, and it is
 * mint rather than warm so that a remark is never mistaken for a selection. */
#define W_INFO RGB(0x86, 0xd6, 0xb4)
#define W_INFOTEXT RGB(0x0d, 0x22, 0x1a)

/* Dark chrome, for the shoot and photograph views. The same world as the
 * face now, one step apart rather than two palettes. */
#define D_GROUND RGB(0x0b, 0x0d, 0x0c)
#define D_PANE RGB(0x15, 0x1a, 0x17)
#define D_EDGE RGB(0x27, 0x30, 0x2b)
#define D_TEXT RGB(0xed, 0xe7, 0xdd)
#define D_DIM W_GRAYTEXT

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
/* The menu's own geometry lives with draw_menu(); nothing else needs it. */

/* Detail screens. */
#define HEAD_H 62
#define BACK_W 84
#define ROW_H 64
#define ROW_GAP 8   /* the rows are separate cards, not a list in a box */
#define BODY_Y (HEAD_H + 1)

/* The header bar's geometry.
 *
 * Up here with the rest of the layout rather than beside draw_header(),
 * because the back button's origin is now every screen's back button origin -
 * the viewfinder's and the photograph's included, and both of those are
 * declared long before the header is.
 */
/*
 * The header, on the page's own margins.
 *
 * It used to run 7..792 while every page body ran 16..784, so a screen had
 * four left edges and four right ones - measured, on LOOK: 7, 16, 19, 24 and
 * 775, 780, 783, 792. Nothing lined up with anything, and that misalignment
 * down both sides of every detail screen is the single loudest thing on this
 * interface that says nobody drew it.
 *
 * One margin now, PAGE_M, shared by the header plate, the back button, the
 * list cards, the group fields and the gallery's page buttons. The top inset
 * stays tighter than the sides on purpose: a title bar is flush to the top of
 * a screen, and 480 px of panel cannot spare a 16 px band above it.
 */
#define PAGE_M 16
#define HD_BAR_X PAGE_M
#define HD_BAR_Y 2
#define HD_BAR_W (UI_W - 2 * PAGE_M)
#define HD_BAR_H (HEAD_H - 4)
/*
 * The system button, and the size a thumb actually needs on this glass.
 *
 * The panel's active area is 93.6 x 56.2 mm for 800 x 480 px - 8.5 px/mm -
 * so the 44 px square this file called "the floor a thumb needs" was 5.2 mm,
 * a figure carried over from phone density. 64 x 52 is 7.5 x 6.1 mm, the
 * most the 58 px bar can hold. The hit target is bigger still: the whole
 * band on a list screen, the button plus 12 px and out to the edge on the
 * two screens that have no band.
 */
#define HD_BTN 52     /* height */
#define HD_BTN_W 64   /* width */
#define HD_BTN_Y (HD_BAR_Y + (HD_BAR_H - HD_BTN) / 2)
#define HD_BTN_GAP 8  /* between the button cluster and the plate, and back and the pair */
#define G_PG_GAP 4    /* between PREV and NEXT, so they read as one control with two ends */
#define HD_CAP_Y (HD_BAR_Y + 6)
#define HD_CAP_H (HD_BAR_H - 12)
/* The caption's own inset. A title that starts on the plate's first pixel is
 * the detail that makes a bar read as a coloured rectangle rather than a
 * caption bar; the system used 2 px and this panel is 800 px wide. */
#define HD_CAP_PAD 10
/* The touch target reaches this far past a drawn button on the two screens
 * whose chrome sits on picture rather than in a band. */
#define HIT_SLOP 12

_Static_assert(HD_BTN + 6 <= HD_BAR_H, "the header system button does not fit its bar");

/* ------------------------------------------------------------------ */
/* The hand                                                            */
/*                                                                     */
/* The shutter is at X 115 on the body's top wall (hardware/cad/          */
/* KINO_FIELD_BODY): the right hand wraps the +X end, the index finger  */
/* is on the shutter, the palm covers that wall, and the only digit     */
/* free for the glass is the right thumb, pivoting at the panel's right */
/* edge. From there it reaches about 45 mm - the right 400 px - and the */
/* top-left corner, where every screen's Back used to be, is a second   */
/* hand's job.                                                          */
/*                                                                     */
/* So the chrome lives on the hand's side, and "the hand's side" is one */
/* flag read once per frame from body.hand. Every rectangle that has a  */
/* side is written as an inset from the hand's edge and passed through  */
/* from_hand(); a left-handed shooter, or a body with the shutter moved, */
/* is a config write and not a layout.                                  */
/* ------------------------------------------------------------------ */
static bool s_right_hand = true;

/** A rectangle `w` wide whose near edge is `inset` from the hand's edge. */
static int from_hand(int inset, int w) { return s_right_hand ? UI_W - inset - w : inset; }

/** The hand's edge, for a palm that rests on the glass. */
#define HAND_EDGE 6
static bool at_hand_edge(int x) { return s_right_hand ? x >= UI_W - HAND_EDGE : x < HAND_EDGE; }

/* The header cluster: Back at the hand's edge, and on the gallery the two
 * page buttons inward of it. PREV is always the left of the pair whichever
 * hand holds the body - reading order does not mirror. */
static int hd_btn_x(void) { return from_hand(PAGE_M, HD_BTN_W); }
static int hd_pair_inner_x(void) { return from_hand(PAGE_M + HD_BTN_W + HD_BTN_GAP, HD_BTN_W); }
static int hd_pair_outer_x(void) {
  return from_hand(PAGE_M + 2 * HD_BTN_W + HD_BTN_GAP + G_PG_GAP, HD_BTN_W);
}
static int hd_prev_x(void) { return s_right_hand ? hd_pair_outer_x() : hd_pair_inner_x(); }
static int hd_next_x(void) { return s_right_hand ? hd_pair_inner_x() : hd_pair_outer_x(); }
/* The list well: inset from the window frame, the way a listbox sits inside
 * a dialog rather than bleeding to the edges. */
#define LIST_X PAGE_M
#define LIST_W (UI_W - 2 * LIST_X)
/*
 * Where a screen's body starts, and why it is not a constant.
 *
 * It was BODY_Y + 12 on every screen, so a list hung from the top of the
 * panel whatever its length: POWER put three rows in the top half and left
 * 54% of the panel bare, and SOUND, DISPLAY, CONNECTION and the roll's empty
 * state were between 45 and 71% black below their content. A screen that
 * stops halfway down reads as unfinished whatever is on it - the eye takes
 * the void as something that failed to load.
 *
 * So a body that does not fill the page is centred in it, and one that fills
 * starts at the top and runs. Set by each screen before it draws, and read by
 * the hit test afterwards, the way s_head_state_left already works - which is
 * also why it MUST be set in the draw rather than computed twice: a layout
 * the touch map derives separately is the one bug this file keeps finding.
 */
#define LIST_TOP_DEFAULT (BODY_Y + 12)
static int s_list_top = LIST_TOP_DEFAULT;
#define LIST_Y s_list_top

/** Centre `content_h` in the body, or start at the top when it will not fit. */
static int body_top(int content_h) {
  const int room = UI_H - BODY_Y - PAGE_M;
  if (content_h >= room) return LIST_TOP_DEFAULT;
  return BODY_Y + (room - content_h) / 2;
}

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
 * The column left of the well is what 800 leaves after the well and the page
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
#define PH_TOP PAGE_M
/*
 * The picture on the far side, the column on the hand's side.
 *
 * It was the other way round - picture right, controls left - which put the
 * thumb on the photograph and the three controls a second hand away. Both
 * rectangles are placed through the hand: the column is an inset from the
 * hand's edge and the well fills what is left.
 */
#define PH_COL_W 162
static int ph_col_x(void) { return from_hand(PAGE_M, PH_COL_W); }
static int ph_well_x(void) { return s_right_hand ? PAGE_M : UI_W - PAGE_M - PH_W; }
/* The facts well runs on the column's own rail, flush with the three buttons
 * under it, so the column has one left edge and one right edge rather than a
 * container 8 px proud of its own contents and 8 px over the page margin.
 * Its type is inset instead. */
#define PH_FPAD 10
#define PH_CAP_Y (HD_BTN_Y + HD_BTN + 12) /* the first caption line, under the back button */
/* UI_FONT_S.line_h, which _Static_assert cannot read. It said 18 - the bitmap
 * face's line - for as long as the assert below has existed, so the one check
 * standing between the caption and the buttons was measuring a column a third
 * shorter than the one being drawn. */
#define PH_LINE 24
#define PH_CAP_LINES 4    /* label, mode, frame count, and the short-wiggle note */
/* Three buttons, full column width, top to bottom: DELETE, SEND TO ROLL,
 * FAVOURITE - the harmless one nearest the thumb's rest at the foot of the
 * column and the one that deletes a photograph furthest from it. Written as
 * arithmetic rather than three literals because draw_photo() and hit_test()
 * both walk it, and the two used to carry different widths - 150 drawn
 * against 150 tested only by luck. */
/* 52, not 44: 6.1 mm on this glass, and the most the column has room for
 * with the two page buttons above the stack. */
#define PH_BTN_H 52
#define PH_BTN_W PH_COL_W
#define PH_BTN_GAP 10     /* between buttons */
#define PH_BTN_BOT PAGE_M /* below the last button, to the bottom edge */
#define PH_BTN_Y(i) (UI_H - PH_BTN_BOT - (3 - (i)) * PH_BTN_H - (2 - (i)) * PH_BTN_GAP)
/* The previous and next photograph, side by side above the stack. Reviewing
 * the roll used to be gallery, tile, back, tile: the thumb can reach one tile
 * in the near column and then walk from there. */
#define PH_PN_H 52
#define PH_PN_W ((PH_COL_W - PH_BTN_GAP) / 2)
#define PH_PN_Y (PH_BTN_Y(0) - PH_BTN_GAP - PH_PN_H)

_Static_assert(PH_W * 3 == PH_H * 4, "photo pane is not 4:3");
_Static_assert(PH_TOP >= 2 && PH_TOP + PH_H + 2 <= UI_H, "the photo well's bevel runs off the screen");
_Static_assert(2 * PAGE_M + PH_W + 6 + PH_COL_W <= UI_W, "the control column runs into the well");
_Static_assert(PH_CAP_Y + PH_CAP_LINES * PH_LINE + 8 <= PH_PN_Y,
               "the caption runs into the page buttons");
_Static_assert(PH_BTN_Y(0) < PH_BTN_Y(1) && PH_BTN_Y(1) < PH_BTN_Y(2) &&
                   PH_BTN_Y(2) + PH_BTN_H < UI_H,
               "the buttons are out of order or fall off the bottom");

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
  SCR_STATUS,
  SCR_POWER,
  SCR_COUNT,
} screen_t;

/* What each screen calls itself. Typeset at draw time out of the same face
 * as everything else, rather than baked to bitmaps by a tool that needs a
 * browser to run: a screen title is one word in the interface's own voice and
 * there was never a reason for it to be a different kind of object. */
static const char *const SCREEN_NAME[SCR_COUNT] = {
    [SCR_MENU] = NULL,          [SCR_SHOOT] = NULL,
    [SCR_LOOK] = "LOOK",        [SCR_GALLERY] = "GALLERY",
    [SCR_PHOTO] = "PHOTO",      [SCR_ROLL] = "ROLL",
    [SCR_SETTINGS] = "SETTINGS", [SCR_DISPLAY] = "DISPLAY",
    [SCR_SOUND] = "SOUND",      [SCR_CONNECTION] = "CONNECTION",
    [SCR_STORAGE] = "STORAGE",  [SCR_ABOUT] = "ABOUT",
    [SCR_STATUS] = "STATUS",
    [SCR_POWER] = "POWER",
};

/* Where Back goes. One level, always, and never to a remembered screen. */
static const screen_t SCREEN_PARENT[SCR_COUNT] = {
    [SCR_MENU] = SCR_MENU, [SCR_SHOOT] = SCR_MENU,
    [SCR_LOOK] = SCR_MENU, [SCR_GALLERY] = SCR_MENU,
    [SCR_PHOTO] = SCR_GALLERY, [SCR_ROLL] = SCR_MENU, [SCR_SETTINGS] = SCR_MENU,
    [SCR_DISPLAY] = SCR_SETTINGS, [SCR_SOUND] = SCR_SETTINGS,
    [SCR_CONNECTION] = SCR_SETTINGS, [SCR_STORAGE] = SCR_SETTINGS,
    [SCR_ABOUT] = SCR_SETTINGS, [SCR_STATUS] = SCR_SETTINGS, [SCR_POWER] = SCR_MENU,
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
  DLG_WELCOME, /* the first boot's one note */
} dialog_t;

/*
 * The drawing target, fetched on every use rather than cached at start-up.
 *
 * It is a window onto the logical screen (gfx_target_t): most of the time
 * the whole canvas, and inside a render pass one tile of it in internal
 * SRAM. Every primitive below clips to the window and addresses pixels
 * through cv_ptr(), so the same drawing code draws a whole frame or one band
 * of it without knowing which. A call per access costs nothing next to the
 * memory write it precedes.
 */
#define TG (gfx_target())

/** Whether logical (x, y) is inside the target's window. */
static inline bool cv_in(const gfx_target_t *t, int x, int y) {
  return x >= t->x0 && y >= t->y0 && x < t->x0 + t->w && y < t->y0 + t->h;
}

/** The pixel at logical (x, y), which the caller has checked is inside. */
static inline uint16_t *cv_ptr(const gfx_target_t *t, int x, int y) {
  return t->px + (size_t)(y - t->y0) * (size_t)t->stride + (size_t)(x - t->x0);
}

/* The window's edges, for clamping a loop before it starts. */
#define CV_X1(t) ((t)->x0 + (t)->w)
#define CV_Y1(t) ((t)->y0 + (t)->h)
/*
 * State the screens read while drawing, gathered once per frame.
 *
 * A tile frame calls the screen's drawing code once per tile - about seventy
 * times - and every call ran storage_get_status() (a FatFs free-space query
 * behind its mutex) and net_link_status() (another lock) again. On the panel
 * that was most of a 34 ms frame during a move into GALLERY or SETTINGS. The
 * facts do not change inside a frame, so they are fetched on the first call
 * of a pass and handed back from here for the rest of it.
 */
static const storage_status_t *sd_status(void) {
  static storage_status_t sd;
  static uint32_t pass = UINT32_MAX;
  if (pass != gfx_pass_id()) {
    storage_get_status(&sd);
    pass = gfx_pass_id();
  }
  return &sd;
}
static const net_status_t *net_status(void) {
  static net_status_t net;
  static uint32_t pass = UINT32_MAX;
  if (pass != gfx_pass_id()) {
    net_link_status(&net, esp_timer_get_time() / 1000);
    pass = gfx_pass_id();
  }
  return &net;
}

/*
 * The display list: a frame's drawing, recorded once and replayed per tile.
 *
 * The tile renderer calls a frame's drawing code once per tile - about
 * seventy times - and the screens' drawing code is not free to call: it
 * formats strings, measures text, reads state and lays rows out before it
 * touches a pixel. Measured on the panel (0.4.58, #177) with every primitive
 * clipping perfectly, a static screen still cost 12-30 ms to draw through the
 * tiles against 8 ms for the splash, and a move into LOOK cost 35 ms a frame:
 * the fixed cost of the code, seventy times over.
 *
 * So the frame is drawn once, into a list of primitives, and the tile pass
 * replays the list: for each tile, the primitives whose box touches it, in
 * order, clipped by the primitive itself as before. The fixed cost is paid
 * once; the per-tile cost is the pixels plus one rectangle test per command.
 *
 * The commands live in PSRAM and are read once per tile they touch; their
 * boxes live in internal SRAM, because the test against every command runs
 * seventy times a frame and must not go over the bus. A view (draw_placed)
 * is recorded onto each command as its shift and clip, so a move records the
 * menu's columns and the destination screen exactly as it drew them.
 *
 * If the list fills, the frame is drawn the old way; nothing is lost.
 */
#ifndef UI_DRAW_PROFILE
#define UI_DRAW_PROFILE 0
#endif
enum {
  DL_FILL, DL_RRECT, DL_ROUTLINE, DL_CUT, DL_DISC, DL_STROKE, DL_SCRIM, DL_TEXT,
  DL_ODD, DL_FIELD, DL_SHBLIT, DL_BLIT, DL_BITS, DL_FOCUS, DL_RING,
};
#define DL_OPS (DL_RING + 1)
/* What the per-tile pass needs about a command without touching PSRAM:
 * its box, and whether it paints every pixel of that box (a fill, a blit)
 * or every pixel but its corners (a rounded rectangle, radius r). */
typedef struct {
  int16_t x0, y0, x1, y1;
  uint8_t r;
  uint8_t opaque; /* bit 0: paints its whole box (but the corners when r > 0) */
} dl_bb_t; /* 10 bytes; DL_MAX of them live in internal SRAM */
typedef struct {
  uint8_t op;
  int16_t sx, sy;             /* the view's shift: logical -> canvas */
  int16_t cx0, cy0, cx1, cy1; /* the view's clip, canvas coordinates */
  uint16_t col;
  int32_t a, b, c, d, e, g;
  float f0, f1, f2, f3, f4;
  const void *p;
} dl_cmd_t;
/* 384 x 10 bytes of internal SRAM for the boxes. The busiest frame seen is
 * an open move at about 230 commands; a fuller one draws direct. */
#define DL_MAX 384
#define DL_STR 8192
static struct {
  bool rec;        /* primitives record instead of drawing */
  bool full;       /* the list or the string arena ran out this frame */
  bool play;       /* inside dl_replay(): primitives are being drawn from the list */
  int n;
  int str_n;
  int16_t sx, sy;
  int16_t cx0, cy0, cx1, cy1;
  dl_cmd_t *cmd;   /* DL_MAX, PSRAM */
  char *str;       /* DL_STR, PSRAM */
  dl_bb_t bb[DL_MAX];    /* canvas-space box of each command; internal */
#if UI_DRAW_PROFILE
  bool prof;       /* bench: time each op type in dl_replay() */
  uint32_t prof_us[DL_OPS];
  uint32_t prof_n[DL_OPS];
#endif
} s_dl;

static void dl_begin(void) {
  if (s_dl.cmd == NULL) {
    s_dl.cmd = heap_caps_aligned_calloc(64, DL_MAX, sizeof(dl_cmd_t), MALLOC_CAP_SPIRAM);
    s_dl.str = heap_caps_aligned_calloc(64, 1, DL_STR, MALLOC_CAP_SPIRAM);
  }
  s_dl.n = 0;
  s_dl.str_n = 0;
  s_dl.full = s_dl.cmd == NULL || s_dl.str == NULL;
  s_dl.sx = s_dl.sy = 0;
  s_dl.cx0 = s_dl.cy0 = 0;
  s_dl.cx1 = UI_W;
  s_dl.cy1 = UI_H;
  s_dl.rec = !s_dl.full;
}
/** Stop recording. True when the whole frame fitted. */
static bool dl_end(void) {
  s_dl.rec = false;
  return !s_dl.full;
}
/**
 * Append a command whose logical-space box is [x0,x1) x [y0,y1). Returns NULL
 * when it lands wholly outside the view's clip (and is dropped) or the list
 * is full (and the frame falls back to direct drawing).
 */
static dl_cmd_t *dl_push(uint8_t op, int x0, int y0, int x1, int y1) {
  x0 += s_dl.sx; x1 += s_dl.sx;
  y0 += s_dl.sy; y1 += s_dl.sy;
  if (x0 < s_dl.cx0) x0 = s_dl.cx0;
  if (y0 < s_dl.cy0) y0 = s_dl.cy0;
  if (x1 > s_dl.cx1) x1 = s_dl.cx1;
  if (y1 > s_dl.cy1) y1 = s_dl.cy1;
  if (x0 >= x1 || y0 >= y1) return NULL;
  if (s_dl.n >= DL_MAX) {
    s_dl.full = true;
    return NULL;
  }
  dl_cmd_t *c = &s_dl.cmd[s_dl.n];
  dl_bb_t *b = &s_dl.bb[s_dl.n];
  b->x0 = (int16_t)x0;
  b->y0 = (int16_t)y0;
  b->x1 = (int16_t)x1;
  b->y1 = (int16_t)y1;
  b->r = 0;
  b->opaque = op == DL_FILL || op == DL_BLIT || op == DL_SHBLIT;
  s_dl.n++;
  c->op = op;
  c->sx = s_dl.sx; c->sy = s_dl.sy;
  c->cx0 = s_dl.cx0; c->cy0 = s_dl.cy0; c->cx1 = s_dl.cx1; c->cy1 = s_dl.cy1;
  return c;
}
/** A copy of `str` in the arena, as an offset; -1 when it does not fit. */
static int dl_str(const char *str) {
  const size_t n = strlen(str) + 1;
  if ((size_t)s_dl.str_n + n > DL_STR) {
    s_dl.full = true;
    return -1;
  }
  memcpy(s_dl.str + s_dl.str_n, str, n);
  const int at = s_dl.str_n;
  s_dl.str_n += (int)n;
  return at;
}
static void dl_replay(void *ctx);

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
  const gfx_target_t *t = TG;
  if (cv_in(t, x, y)) *cv_ptr(t, x, y) = c;
}

/*
 * A run of one colour, two pixels per store.
 *
 * The canvas is 800x480 RGB565 in PSRAM (gfx.c allocates it MALLOC_CAP_SPIRAM),
 * and this used to write it one uint16_t at a time. A full-screen fill is
 * 384,000 of those, over the MSPI bus, and every screen in the product starts
 * with one - nineteen call sites of fill(0, 0, UI_W, UI_H, ...). Pairing them
 * into 32-bit stores halves the transaction count on the bus that is the
 * bottleneck, and the compiler cannot do it for us: it cannot prove the row
 * pointer is aligned or that the span does not alias.
 *
 * Aligned first, because an unaligned 32-bit store to PSRAM is worse than the
 * two 16-bit ones it replaces.
 */
/*
 * Pixel traffic, counted.
 *
 * "Choppy" is a symptom and the cause is a number nobody had: how much of the
 * canvas a frame touches. On this board that number IS the frame time - the
 * canvas lives in PSRAM at roughly 160 MB/s, so one full-screen opaque pass
 * (800 x 480 x 2 bytes = 768 KB) costs about 4.8 ms before a single shape is
 * drawn, and a blended pass costs twice that because it reads before it
 * writes. A frame that touches the screen three times over cannot be smooth
 * on any clock this chip has.
 *
 * Renderer only. Two counters because the two are not the same cost.
 */
#if KINO_UI_AUDIT
uint64_t g_px_write;
uint64_t g_px_blend;
#define PX_WRITE(n) (g_px_write += (uint64_t)(n))
#define PX_BLEND(n) (g_px_blend += (uint64_t)(n))
#else
#define PX_WRITE(n) ((void)0)
#define PX_BLEND(n) ((void)0)
#endif

static inline void fill_run(uint16_t *p, size_t n, uint16_t colour) {
  if (n == 0) return;
  PX_WRITE(n);
  if (((uintptr_t)p & 2u) != 0) { /* odd address: one pixel to reach a word */
    *p++ = colour;
    if (--n == 0) return;
  }
  const uint32_t pair = ((uint32_t)colour << 16) | colour;
  uint32_t *q = (uint32_t *)(void *)p;
  for (size_t i = n >> 1; i != 0; i--) *q++ = pair;
  if ((n & 1u) != 0) *(uint16_t *)(void *)q = colour;
}

static void fill(int x, int y, int w, int h, uint16_t colour) {
  if (s_dl.rec) {
    dl_cmd_t *c = dl_push(DL_FILL, x, y, x + w, y + h);
    if (c) { c->a = x; c->b = y; c->c = w; c->d = h; c->col = colour; }
    return;
  }
  const gfx_target_t *t = TG;
  if (x < t->x0) { w += x - t->x0; x = t->x0; }
  if (y < t->y0) { h += y - t->y0; y = t->y0; }
  if (x + w > CV_X1(t)) w = CV_X1(t) - x;
  if (y + h > CV_Y1(t)) h = CV_Y1(t) - y;
  if (w <= 0 || h <= 0) return;
  /* A rectangle the full width of the window is one contiguous run: the
   * target is row-major, so the rows join and the per-row loop and its
   * pointer arithmetic go away. This is the shape of the fill every screen
   * opens with. */
  if (x == t->x0 && w == t->w && t->stride == t->w) {
    fill_run(cv_ptr(t, x, y), (size_t)h * (size_t)w, colour);
    return;
  }
  for (int r = 0; r < h; r++) fill_run(cv_ptr(t, x, y + r), (size_t)w, colour);
}

static uint16_t mix(uint16_t a, uint16_t b, int k) {
  const int ar = (a >> 11) & 0x1F, ag = (a >> 5) & 0x3F, ab = a & 0x1F;
  const int br = (b >> 11) & 0x1F, bg = (b >> 5) & 0x3F, bb = b & 0x1F;
  const int r = ar + (((br - ar) * k) >> 8);
  const int g = ag + (((bg - ag) * k) >> 8);
  const int bl = ab + (((bb - ab) * k) >> 8);
  return (uint16_t)((r << 11) | (g << 5) | bl);
}

/*
 * The quiet voice, at a legible distance from its ground.
 *
 * A row's second line and its position number were `mix(ink, face, 110)`: the
 * title pulled 43% of the way into the row. That is one number for six rows
 * of different tone, and measured it was 2.6:1 on the top row and 5.1:1 on
 * the bottom one - the same "2 min" legible at the foot of a list and not at
 * its head. WCAG wants 4.5:1 for text this size, and the only way one rule
 * gives that on every ground is to measure the ground.
 *
 * So: relative luminance (sRGB, the WCAG formula) and a search for the
 * largest pull toward the face that still clears the target. Called a handful
 * of times a frame with a handful of distinct faces, so the last eight
 * answers are kept; the search itself is at most 32 steps of arithmetic.
 */
static float rel_lum(uint16_t c) {
  const float r = (float)(((c >> 11) & 0x1F) * 255 / 31) / 255.0f;
  const float g = (float)(((c >> 5) & 0x3F) * 255 / 63) / 255.0f;
  const float b = (float)((c & 0x1F) * 255 / 31) / 255.0f;
  const float lr = r <= 0.03928f ? r / 12.92f : powf((r + 0.055f) / 1.055f, 2.4f);
  const float lg = g <= 0.03928f ? g / 12.92f : powf((g + 0.055f) / 1.055f, 2.4f);
  const float lb = b <= 0.03928f ? b / 12.92f : powf((b + 0.055f) / 1.055f, 2.4f);
  return 0.2126f * lr + 0.7152f * lg + 0.0722f * lb;
}

static float contrast(uint16_t a, uint16_t b) {
  const float la = rel_lum(a) + 0.05f, lb = rel_lum(b) + 0.05f;
  return la > lb ? la / lb : lb / la;
}

#define DIM_TARGET 4.6f

typedef struct {
  uint16_t ink, face, out;
  bool set;
} dim_entry_t;

static uint16_t dim_ink(uint16_t ink, uint16_t face) {
  static dim_entry_t cache[8];
  static int next;
  for (int i = 0; i < 8; i++) {
    if (cache[i].set && cache[i].ink == ink && cache[i].face == face) return cache[i].out;
  }
  /* The quietest mix that still reads. Steps of 8 out of 256; if even the ink
   * itself does not clear the target, the ink is the answer. */
  uint16_t out = ink;
  for (int k = 128; k >= 0; k -= 8) {
    const uint16_t c = mix(ink, face, k);
    if (contrast(c, face) >= DIM_TARGET) {
      out = c;
      break;
    }
  }
  cache[next] = (dim_entry_t){ink, face, out, true};
  next = (next + 1) & 7;
  return out;
}

/* A condition's severity, as the word the mark's colour stood for alone. */
static const char *sev_word(cond_sev_t sev) {
  return sev == COND_FAULT ? "FAULT" : sev == COND_WARN ? "WARN" : "NOTE";
}
/* The severity's colour: the interface's red for a fault, its accent for a
 * warning, the quiet ink for a note. Used with the word, never instead of it. */
static uint16_t sev_ink(cond_sev_t sev) {
  return sev == COND_FAULT ? C_RED_INK : sev == COND_WARN ? W_SEL : W_GRAYTEXT;
}

static void outline(int x, int y, int w, int h, uint16_t c) {
  fill(x, y, w, 1, c);
  fill(x, y + h - 1, w, 1, c);
  fill(x, y, 1, h, c);
  fill(x + w - 1, y, 1, h, c);
}

/**
 * A filled rectangle with its corners taken off, and the corners are smooth.
 *
 * The first version searched for each row's inset with integer arithmetic and
 * filled a hard run, so every corner was a little flight of stairs - four of
 * them on every row of the menu, which is the one thing on the screen the eye
 * runs along. A 14 px radius drawn in whole pixels has about five visible
 * steps in it, and five steps is a corner that looks drawn rather than made.
 *
 * So the corner is sampled rather than searched. For every pixel inside the
 * corner's box, the distance from the arc's centre gives the fraction of that
 * pixel the shape covers, and the fraction is a blend into whatever is behind
 * it. One square root per corner pixel - 4 x 14 x 14 of them, under 800 for a
 * menu row - and the rest of the rectangle is still whole-row fills.
 *
 * Nothing behind a corner is assumed: it reads the canvas and mixes into it,
 * so a card over a photograph is as correct as a card over the ground.
 */
/*
 * Coverage of a rounded corner of radius r, r*r bytes, (dx, dy) counted
 * inward from the corner's outer edges: 255 inside the arc, 0 outside, the
 * ramp across the one pixel the edge crosses. Kept for the last few radii;
 * this interface uses two or three.
 */
#define CORNER_R_MAX 32
static const uint8_t *corner_cov(int r) {
  /* In PSRAM: a corner reads r*r bytes of it per tile, through the cache,
   * and internal SRAM is the pool this board runs out of first. */
  static int cache_r[4];
  static uint8_t *cache[4];
  static int next;
  if (r > CORNER_R_MAX) r = CORNER_R_MAX;
  for (int i = 0; i < 4; i++) {
    if (cache[i] != NULL && cache_r[i] == r) return cache[i];
  }
  const int slot = next++ & 3;
  if (cache[slot] == NULL) {
    cache[slot] = heap_caps_aligned_calloc(64, 1, CORNER_R_MAX * CORNER_R_MAX, MALLOC_CAP_SPIRAM);
    if (cache[slot] == NULL) return NULL; /* out of PSRAM: square corners */
  }
  cache_r[slot] = r;
  const float rf = (float)r;
  for (int dy = 0; dy < r; dy++) {
    for (int dx = 0; dx < r; dx++) {
      const float ox = (float)(r - dx) - 0.5f;
      const float oy = (float)(r - dy) - 0.5f;
      float cov = rf - sqrtf(ox * ox + oy * oy) + 0.5f;
      if (cov <= 0.0f) cov = 0.0f;
      if (cov > 1.0f) cov = 1.0f;
      cache[slot][dy * r + dx] = (uint8_t)(int)(cov * 255.0f + 0.5f);
    }
  }
  return cache[slot];
}

static void round_rect(int x, int y, int w, int h, int r, uint16_t c) {
  if (r * 2 > w) r = w / 2;
  if (r * 2 > h) r = h / 2;
  if (r < 1) {
    fill(x, y, w, h, c);
    return;
  }
  if (r > CORNER_R_MAX) r = CORNER_R_MAX;
  if (s_dl.rec) {
    dl_cmd_t *k = dl_push(DL_RRECT, x, y, x + w, y + h);
    if (k) {
      k->a = x; k->b = y; k->c = w; k->d = h; k->e = r; k->col = c;
      /* Opaque everywhere but its corners; the per-tile pass knows the radius. */
      s_dl.bb[s_dl.n - 1].r = (uint8_t)r;
      s_dl.bb[s_dl.n - 1].opaque = 1;
    }
    return;
  }

  /* The middle: every row that no corner reaches. */
  fill(x, y + r, w, h - 2 * r, c);
  /* The straight parts of the top and bottom edges. */
  fill(x + r, y, w - 2 * r, r, c);
  fill(x + r, y + h - r, w - 2 * r, r, c);

  /*
   * The four corners, sampled from a coverage table.
   *
   * Coverage at (dx, dy) inside a corner of radius r depends on r alone, so
   * it is computed once per radius and kept: a corner is then r*r byte
   * reads and blends, not r*r square roots. And each corner is tested
   * against the window on its own before any of that - a card that spans
   * forty tiles has a corner in four of them, and the other thirty-six used
   * to pay for all four corners every frame. Profiled on the panel (0.4.58,
   * #177) at 4.6 ms of a 13 ms menu frame; this is most of that back.
   */
  const uint8_t *cov = corner_cov(r);
  if (cov == NULL) {
    fill(x, y, w, r, c);
    fill(x, y + h - r, w, r, c);
    return;
  }
  const gfx_target_t *t = TG;
  const int cx[2] = {x, x + w - r};         /* left corners start, right corners start */
  const int cy[2] = {y, y + h - r};
  for (int a = 0; a < 2; a++) {
    for (int b = 0; b < 2; b++) {
      /* This corner's box, clipped to the window. */
      int bx0 = cx[a] > t->x0 ? cx[a] : t->x0, by0 = cy[b] > t->y0 ? cy[b] : t->y0;
      int bx1 = cx[a] + r < CV_X1(t) ? cx[a] + r : CV_X1(t);
      int by1 = cy[b] + r < CV_Y1(t) ? cy[b] + r : CV_Y1(t);
      if (bx0 >= bx1 || by0 >= by1) continue;
      for (int py = by0; py < by1; py++) {
        /* Distance index from the corner's outer edge: dy counts inward. */
        const int dy = b == 0 ? py - cy[0] : (cy[1] + r - 1) - py;
        const uint8_t *row = cov + (size_t)dy * (size_t)r;
        uint16_t *dst = cv_ptr(t, bx0, py);
        for (int px = bx0; px < bx1; px++, dst++) {
          const int dx = a == 0 ? px - cx[0] : (cx[1] + r - 1) - px;
          const int k = row[dx];
          if (k == 0) continue;
          *dst = k >= 254 ? c : mix(*dst, c, k);
        }
      }
    }
  }
}

/** A one-pixel rounded outline, on the shape round_rect() would fill. */
static void round_outline(int x, int y, int w, int h, int r, uint16_t c) {
  if (s_dl.rec) {
    dl_cmd_t *k = dl_push(DL_ROUTLINE, x, y, x + w, y + h);
    if (k) { k->a = x; k->b = y; k->c = w; k->d = h; k->e = r; k->col = c; }
    return;
  }
  if (r * 2 > w) r = w / 2;
  if (r * 2 > h) r = h / 2;
  fill(x + r, y, w - 2 * r, 1, c);
  fill(x + r, y + h - 1, w - 2 * r, 1, c);
  fill(x, y + r, 1, h - 2 * r, c);
  fill(x + w - 1, y + r, 1, h - 2 * r, c);
  const gfx_target_t *t = TG;
  if (x + w <= t->x0 || y + h <= t->y0 || x >= CV_X1(t) || y >= CV_Y1(t)) return;
  const float rf = (float)r;
  for (int dy = 0; dy < r; dy++) {
    for (int dx = 0; dx < r; dx++) {
      const float ox = (float)(r - dx) - 0.5f, oy = (float)(r - dy) - 0.5f;
      const float d = sqrtf(ox * ox + oy * oy);
      float cov = 1.0f - (d - rf + 1.0f > 0.0f ? d - rf + 1.0f : 0.0f);
      if (d > rf || cov <= 0.0f || rf - d > 1.0f) continue;
      const int k = (int)(cov * 255.0f + 0.5f);
      const int xs[2] = {x + dx, x + w - 1 - dx};
      const int ys[2] = {y + dy, y + h - 1 - dy};
      for (int a = 0; a < 2; a++)
        for (int b = 0; b < 2; b++) {
          if (!cv_in(t, xs[a], ys[b])) continue;
          uint16_t *p = cv_ptr(t, xs[a], ys[b]);
          *p = mix(*p, c, k);
        }
    }
  }
}

/**
 * The inverse: put the corners back to the colour behind them.
 *
 * For a rectangle whose fill is already on the canvas - a blit of another
 * frame, say - where the shape still has to be the product's shape. Sampled
 * like round_rect() so the radius can be fractional, which it has to be: a
 * corner that steps through 14, 13, 12 in whole pixels while a card grows
 * flickers along its edge.
 */
static void cut_corners(int x, int y, int w, int h, float rad, uint16_t behind) {
  if (rad < 0.4f) return;
  if (s_dl.rec) {
    dl_cmd_t *k = dl_push(DL_CUT, x, y, x + w, y + h);
    if (k) { k->a = x; k->b = y; k->c = w; k->d = h; k->f0 = rad; k->col = behind; }
    return;
  }
  const gfx_target_t *t = TG;
  if (x + w <= t->x0 || y + h <= t->y0 || x >= CV_X1(t) || y >= CV_Y1(t)) return;
  const int r = (int)rad + 1;
  for (int dy = 0; dy < r; dy++) {
    for (int dx = 0; dx < r; dx++) {
      const float ox = rad - (float)dx - 0.5f;
      const float oy = rad - (float)dy - 0.5f;
      if (ox < 0.0f || oy < 0.0f) continue;
      float cov = sqrtf(ox * ox + oy * oy) - rad + 0.5f;
      if (cov <= 0.0f) continue;
      if (cov > 1.0f) cov = 1.0f;
      const int k = (int)(cov * 255.0f + 0.5f);
      const int xs[2] = {x + dx, x + w - 1 - dx};
      const int ys[2] = {y + dy, y + h - 1 - dy};
      for (int a = 0; a < 2; a++) {
        for (int b = 0; b < 2; b++) {
          if (!cv_in(t, xs[a], ys[b])) continue;
          uint16_t *d = cv_ptr(t, xs[a], ys[b]);
          *d = k >= 254 ? behind : mix(*d, behind, k);
        }
      }
    }
  }
}

/**
 * A disc, and a ring, both sampled the same way as the corners above.
 *
 * Every round thing on the interface goes through these two, so there is one
 * answer to "what does an edge look like" rather than one per glyph.
 */
static void disc(int cx, int cy, float r, uint16_t c) {
  if (s_dl.rec) {
    const int e = (int)r + 2;
    dl_cmd_t *k = dl_push(DL_DISC, cx - e, cy - e, cx + e + 1, cy + e + 1);
    if (k) { k->a = cx; k->b = cy; k->f0 = r; k->col = c; }
    return;
  }
  PX_BLEND((size_t)((2.0f * r + 2.0f) * (2.0f * r + 2.0f)));

  const gfx_target_t *t = TG;
  int x0 = (int)(cx - r) - 1, x1 = (int)(cx + r) + 1;
  int y0 = (int)(cy - r) - 1, y1 = (int)(cy + r) + 1;
  if (x0 < t->x0) x0 = t->x0;
  if (y0 < t->y0) y0 = t->y0;
  if (x1 >= CV_X1(t)) x1 = CV_X1(t) - 1;
  if (y1 >= CV_Y1(t)) y1 = CV_Y1(t) - 1;
  for (int py = y0; py <= y1; py++) {
    uint16_t *row = cv_ptr(t, t->x0, py) - t->x0;
    for (int px = x0; px <= x1; px++) {
      const float ox = (float)px + 0.5f - (float)cx;
      const float oy = (float)py + 0.5f - (float)cy;
      float cov = r - sqrtf(ox * ox + oy * oy) + 0.5f;
      if (cov <= 0.0f) continue;
      if (cov > 1.0f) cov = 1.0f;
      const int k = (int)(cov * 255.0f + 0.5f);
      row[px] = k >= 254 ? c : mix(row[px], c, k);
    }
  }
}

/**
 * A ring: the annulus of radius `r` and width `width`, both edges
 * antialiased. The two icons that used to be sixty short strokes each round
 * a circle are this; the strokes cost 2 ms of every menu frame and overlapped
 * unevenly where they met.
 */
static void ring(int cx, int cy, float r, float width, uint16_t c) {
  const float hw = width * 0.5f;
  const int e = (int)(r + hw) + 2;
  if (s_dl.rec) {
    dl_cmd_t *k = dl_push(DL_RING, cx - e, cy - e, cx + e + 1, cy + e + 1);
    if (k) { k->a = cx; k->b = cy; k->f0 = r; k->f1 = width; k->col = c; }
    return;
  }
  const gfx_target_t *t = TG;
  int x0 = cx - e, x1 = cx + e, y0 = cy - e, y1 = cy + e;
  if (x0 < t->x0) x0 = t->x0;
  if (y0 < t->y0) y0 = t->y0;
  if (x1 >= CV_X1(t)) x1 = CV_X1(t) - 1;
  if (y1 >= CV_Y1(t)) y1 = CV_Y1(t) - 1;
  /* No square root outside the band the ring can touch. */
  const float far2 = (r + hw + 0.5f) * (r + hw + 0.5f);
  const float near = r - hw - 0.5f;
  const float near2 = near > 0.0f ? near * near : 0.0f;
  for (int py = y0; py <= y1; py++) {
    uint16_t *row = cv_ptr(t, t->x0, py) - t->x0;
    for (int px = x0; px <= x1; px++) {
      const float ox = (float)px + 0.5f - (float)cx;
      const float oy = (float)py + 0.5f - (float)cy;
      const float d2 = ox * ox + oy * oy;
      if (d2 >= far2 || d2 < near2) continue;
      const float dist = sqrtf(d2) - r;
      float cov = hw - (dist < 0.0f ? -dist : dist) + 0.5f;
      if (cov <= 0.0f) continue;
      if (cov > 1.0f) cov = 1.0f;
      const int k = (int)(cov * 255.0f + 0.5f);
      row[px] = k >= 254 ? c : mix(row[px], c, k);
    }
  }
}

/** A line of some width, with both ends and both sides antialiased. */
static void stroke(float x0, float y0, float x1, float y1, float width, uint16_t c) {
  const float hw = width * 0.5f;
  if (s_dl.rec) {
    dl_cmd_t *k = dl_push(DL_STROKE, (int)floorf((x0 < x1 ? x0 : x1) - hw - 1),
                          (int)floorf((y0 < y1 ? y0 : y1) - hw - 1),
                          (int)ceilf((x0 > x1 ? x0 : x1) + hw + 1) + 1,
                          (int)ceilf((y0 > y1 ? y0 : y1) + hw + 1) + 1);
    if (k) { k->f0 = x0; k->f1 = y0; k->f2 = x1; k->f3 = y1; k->f4 = width; k->col = c; }
    return;
  }
  const float vx = x1 - x0, vy = y1 - y0;
  const float len2 = vx * vx + vy * vy;
  int bx0 = (int)floorf((x0 < x1 ? x0 : x1) - hw - 1);
  int bx1 = (int)ceilf((x0 > x1 ? x0 : x1) + hw + 1);
  int by0 = (int)floorf((y0 < y1 ? y0 : y1) - hw - 1);
  int by1 = (int)ceilf((y0 > y1 ? y0 : y1) + hw + 1);
  const gfx_target_t *t = TG;
  if (bx0 < t->x0) bx0 = t->x0;
  if (by0 < t->y0) by0 = t->y0;
  if (bx1 >= CV_X1(t)) bx1 = CV_X1(t) - 1;
  if (by1 >= CV_Y1(t)) by1 = CV_Y1(t) - 1;
  /* The square root is only needed across the one-pixel edge band: a pixel
   * whose squared distance is inside (hw - 0.5)^2 is solid and one outside
   * (hw + 0.5)^2 is untouched. Most of a stroke's box is one or the other. */
  const float in2 = hw > 0.5f ? (hw - 0.5f) * (hw - 0.5f) : -1.0f;
  const float out2 = (hw + 0.5f) * (hw + 0.5f);
  for (int py = by0; py <= by1; py++) {
    uint16_t *row = cv_ptr(t, t->x0, py) - t->x0;
    for (int px = bx0; px <= bx1; px++) {
      const float qx = (float)px + 0.5f - x0, qy = (float)py + 0.5f - y0;
      float t = len2 > 0.0f ? (qx * vx + qy * vy) / len2 : 0.0f;
      if (t < 0.0f) t = 0.0f;
      if (t > 1.0f) t = 1.0f;
      const float dx = qx - t * vx, dy = qy - t * vy;
      const float d2 = dx * dx + dy * dy;
      if (d2 >= out2) continue;
      if (d2 <= in2) {
        row[px] = c;
        continue;
      }
      float cov = hw - sqrtf(d2) + 0.5f;
      if (cov <= 0.0f) continue;
      if (cov > 1.0f) cov = 1.0f;
      const int k = (int)(cov * 255.0f + 0.5f);
      row[px] = k >= 254 ? c : mix(row[px], c, k);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/*                                                                     */
/* Two surfaces, one corner, one focus ring. What stood here was the   */
/* Windows 98 bevel - four tones of grey, two pixels, raised, sunken   */
/* and etched - and a paragraph explaining why that reads as a         */
/* physical control. It did. It is also gone, along with the last of   */
/* its call sites, and a comment describing a grammar the file no      */
/* longer speaks is worse than no comment at all.                      */
/* ------------------------------------------------------------------ */

/*
 * The surfaces, and there are two of them.
 *
 * A thing you press and a thing you read. Both are a flat fill with the
 * corners taken off; neither has an edge, a highlight or a shadow, because
 * the 1998 grammar those came from said "this is a physical control" with
 * four tones of grey and this one says it with a shape and a value.
 *
 * The corner is the product's one radius. It is on the menu card, on the
 * rows, on every button and every field, and it is the single thing holding
 * the interface together now that the bevels are gone - which is why it is a
 * constant and not an argument.
 */
/*
 * One radius, and one rule for anything drawn inside something else.
 *
 * A surface's corner is UI_R whatever its size - a 50 px row and a 168 px
 * card have the same corner, the way a system does it, rather than a radius
 * scaled to each box. Anything inset by n px uses UI_R - n so the two curves
 * stay concentric; that is geometry, not a second radius, and it is the only
 * reason a number other than UI_R may appear in a round_rect().
 *
 * There were three before this: 10 here, 14 on the menu, and 14 again on the
 * dialog, in a file whose comment claimed "the product's one radius".
 */
#define UI_R 10
#define W_PRESS RGB(0x26, 0x2f, 0x2a)

/**
 * A thing you press.
 *
 * It was byte-identical to well() below - same fill, same corner - so a
 * control and a readout were the same object until you touched one. A press
 * still darkens the whole face, but the resting state now carries a keyline
 * one step lighter than the ground it sits on: enough to say "this is a
 * surface standing up" at arm's length, and not so much that a screen of them
 * becomes a screen of outlines.
 */
static void button(int x, int y, int w, int h, bool down) {
  round_rect(x, y, w, h, UI_R, down ? W_PRESS : W_WINDOW);
  if (!down) round_outline(x, y, w, h, UI_R, W_KEYLINE);
}

static uint16_t dim_ink(uint16_t ink, uint16_t face);
static float contrast(uint16_t a, uint16_t b);

/*
 * The edge of a control, for the ground it stands on.
 *
 * W_KEYLINE was tuned for the dark face and the dark window, where it is
 * 3.3-3.5:1. The same line on a terracotta row measures 1.1:1 - a grey
 * halfway between the dark control and the warm card is invisible against
 * both. On a ground where the keyline does not reach 3:1 the edge is drawn in
 * the row's own quiet ink: the same mix its value text is set in, so a row
 * has two inks, not three, and the control reads as a cut-out in the card.
 */
static uint16_t edge_ink(uint16_t ground) {
  return contrast(W_KEYLINE, ground) >= 3.0f ? W_KEYLINE : dim_ink(W_TEXT, ground);
}

/* A small control with its own face - a picker's arrow button, a toggle's
 * track - drawn resting or pressed, with the edge that says it is one.
 * `ground` is what it stands on, which decides the edge's ink. */
static void control(int x, int y, int w, int h, int r, bool down, uint16_t ground) {
  round_rect(x, y, w, h, r, down ? W_SEL : W_PRESS);
  if (!down) round_outline(x, y, w, h, r, edge_ink(ground));
}

/** A thing you read. Flat, and no edge - it is not going anywhere. */
static void well(int x, int y, int w, int h) {
  round_rect(x, y, w, h, UI_R, W_WINDOW);
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
  if (s_dl.rec) {
    dl_cmd_t *c = dl_push(DL_SCRIM, x, y, x + w, y + h);
    if (c) { c->a = x; c->b = y; c->c = w; c->d = h; c->e = k; c->col = tint; }
    return;
  }
  const gfx_target_t *t = TG;
  if (x < t->x0) { w += x - t->x0; x = t->x0; }
  if (y < t->y0) { h += y - t->y0; y = t->y0; }
  if (x + w > CV_X1(t)) w = CV_X1(t) - x;
  if (y + h > CV_Y1(t)) h = CV_Y1(t) - y;
  if (w <= 0 || h <= 0) return;
  PX_BLEND((size_t)w * h);
  for (int r = 0; r < h; r++) {
    uint16_t *row = cv_ptr(t, x, y + r);
    for (int c = 0; c < w; c++) row[c] = mix(row[c], tint, k);
  }
}

/**
 * The focus ring: a rounded outline, inset inside the control it belongs to.
 *
 * It was a rectangle drawn on alternating pixels - the Windows 98 keyboard
 * focus mark, and the last piece of that grammar left in the file. A dotted
 * rectangle around a rounded card is two shapes disagreeing about what the
 * control is, and on a 480 px panel at arm's length the dots read as an
 * artefact rather than as a state.
 *
 * Two pixels, rounded to the product's corner, in whichever ink reads against
 * what it is drawn on - half the focusable things here are dark type on a warm
 * plate and half are light type on a dark one.
 */
/*
 * Whether anything on this body can move the focus.
 *
 * Nothing can. The shutter fires, and the touch panel acts on what it lands
 * on; there is no direction key, because BTN_FN has no pin until the I2C
 * expander ECN-0003 deferred arrives. A ring that marks a position no input
 * can move is not a focus indicator - it is a decoration that looks like a
 * selection, and on a list it says "this one" about a row the user has no
 * reason to think is special. It was showing on the last row anyone touched.
 *
 * The ring, the focus array and every call site stay exactly as they are, so
 * the day that pin exists this is one line. Drawing it before then is not.
 */
#if defined(BOARD_BTN_FN) && BOARD_BTN_FN != BOARD_BTN_NONE
#define UI_FOCUS_VISIBLE 1
#else
#define UI_FOCUS_VISIBLE 0
#endif

static void focus_ring(int x, int y, int w, int h, int r, uint16_t ink) {
  if (s_dl.rec) {
    dl_cmd_t *k = dl_push(DL_FOCUS, x - 6, y - 6, x + w + 6, y + h + 6);
    if (k) { k->a = x; k->b = y; k->c = w; k->d = h; k->e = r; k->col = ink; }
    return;
  }
  if (!UI_FOCUS_VISIBLE) return;
  for (int e = 0; e < 2; e++) {
    const int ox = x + e, oy = y + e, ow = w - 2 * e, oh = h - 2 * e;
    const int rr = r - e > 0 ? r - e : 0;
    /* The ring, as the difference between two rounded rectangles: the outline
     * is what one covers and the next one in does not. */
    for (int py = oy; py < oy + oh; py++) {
      for (int px = ox; px < ox + ow; px++) {
        const bool edge = px == ox || px == ox + ow - 1 || py == oy || py == oy + oh - 1;
        if (!edge) continue;
        /* Skip the corner squares the radius has taken off. */
        const int dx = px < ox + rr ? ox + rr - px : (px >= ox + ow - rr ? px - (ox + ow - rr) + 1 : 0);
        const int dy = py < oy + rr ? oy + rr - py : (py >= oy + oh - rr ? py - (oy + oh - rr) + 1 : 0);
        if (dx > 0 && dy > 0) continue;
        px_set(px, py, ink);
      }
    }
    /* And the corners themselves, as arcs. */
    for (int a = 0; a <= 90; a += 3) {
      const float t = (float)a * 3.14159265f / 180.0f;
      const float cx = (float)rr - 0.5f, cy = (float)rr - 0.5f;
      const int ax = (int)(cx - cosf(t) * (float)rr + 0.5f);
      const int ay = (int)(cy - sinf(t) * (float)rr + 0.5f);
      px_set(ox + ax, oy + ay, ink);
      px_set(ox + ow - 1 - ax, oy + ay, ink);
      px_set(ox + ax, oy + oh - 1 - ay, ink);
      px_set(ox + ow - 1 - ax, oy + oh - 1 - ay, ink);
    }
  }
}

/** The standard focus mark: 3 px inside the control, in whichever ink reads. */
static void focus_inset(int x, int y, int w, int h, uint16_t ink) {
  focus_ring(x + 3, y + 3, w - 6, h - 6, UI_R - 3 > 0 ? UI_R - 3 : 0, ink);
}


static void draw_bits(const uint8_t *bits, int w, int h, int stride, int x, int y, int scale,
                      uint16_t ink) {
  if (s_dl.rec) {
    dl_cmd_t *k = dl_push(DL_BITS, x, y, x + w * scale, y + h * scale);
    if (k) { k->p = bits; k->a = w; k->b = h; k->c = stride; k->d = x; k->e = y; k->g = scale; k->col = ink; }
    return;
  }
  for (int row = 0; row < h; row++) {
    const uint8_t *src = bits + (size_t)row * stride;
    for (int col = 0; col < w; col++) {
      if (!(src[col >> 3] & (0x80 >> (col & 7)))) continue;
      if (scale == 1) px_set(x + col, y + row, ink);
      else fill(x + col * scale, y + row * scale, scale, scale, ink);
    }
  }
}

/**
 * Type, blended rather than stamped.
 *
 * Every glyph is a box of coverage - 0 where the page shows through, 255
 * where the ink is solid, and the real numbers in between along every curve
 * and diagonal. So a letter is a run of mixes into whatever is already on the
 * canvas, which is why it can sit on a terracotta card and a near-black
 * ground and look like the same letter on both.
 *
 * The header before this one was one bit per pixel, thresholded out of a
 * headless browser, and every diagonal on the panel was a staircase. That is
 * not a small-type look, it is a worse typeface: at 19 px the difference
 * between a stem that is 1.4 px wide and one rounded to 1 or 2 is most of
 * what makes a face legible.
 *
 * `y` is the top of the line, as it always was, so nothing that positions
 * text had to move.
 */
static int text_w(const ui_font_t *f, const char *s) {
  int w = 0;
  for (; *s; s++) {
    const int i = (unsigned char)*s - f->first;
    if (i < 0 || i >= f->count) continue;
    w += f->glyphs[i].adv;
  }
  return w;
}

/* Off everywhere but the host renderer; see text(). */
#ifndef KINO_UI_AUDIT
#define KINO_UI_AUDIT 0
#endif
#if KINO_UI_AUDIT
void ui_audit_text(int x, int y, int w, int h, const char *s);
/* Set while drawing a band that paints its own ground edge to edge - the
 * viewfinder's status bar, which is the one piece of chrome on a screen with
 * no frame. Inside a band the page's top and bottom margins do not apply,
 * because the band is not on the page; the side margins still do, and that is
 * the bound that catches a status word running into the corner. */
static bool s_audit_chrome;
#define AUDIT_CHROME(v) (s_audit_chrome = (v))
#else
#define AUDIT_CHROME(v) ((void)0)
#endif

static void glyph_blend(const ui_glyph_t *g, int pen, int baseline, uint16_t ink) {
  if (g->cov == NULL) return;
  PX_BLEND((size_t)g->w * g->h);
  const int gx = pen + g->bx;
  const int gy = baseline - g->by;
  const gfx_target_t *t = TG;
  /* A glyph wholly outside the window costs nothing: in a tile pass the same
   * text is set once per tile and most of it lands in other tiles. */
  if (gx + g->w <= t->x0 || gy + g->h <= t->y0 || gx >= CV_X1(t) || gy >= CV_Y1(t)) return;
  const int c0 = gx < t->x0 ? t->x0 - gx : 0;
  const int c1 = gx + g->w > CV_X1(t) ? CV_X1(t) - gx : g->w;
  for (int r = 0; r < g->h; r++) {
    const int py = gy + r;
    if (py < t->y0 || py >= CV_Y1(t)) continue;
    const uint8_t *src = g->cov + (size_t)r * g->w;
    uint16_t *dst = cv_ptr(t, gx, py);
    for (int c = c0; c < c1; c++) {
      const int a = src[c];
      if (a == 0) continue;
      dst[c] = a >= 254 ? ink : mix(dst[c], ink, a);
    }
  }
}

static void text(const ui_font_t *f, int x, int y, const char *s, uint16_t ink) {
#if KINO_UI_AUDIT
  /* Every string this shell sets is either a literal broken by hand or a
   * snprintf of somebody's data, and both run out of room silently:
   * glyph_blend() clips at the canvas edge, so a line that does not fit just
   * stops looking wrong on the screenshot nobody took. The About note had
   * been over the bezel since the type changed.
   *
   * Renderer only. It reports rather than asserts, because a long roll name
   * genuinely can outgrow its column and the answer there is fit_face() or
   * ellipsis(), not a crash on the bench. */
  /* Once per string, at the recording call: a replay is the same string
   * again, after the chrome flag has moved on. */
  if (!s_dl.play) {
    /* The bound is the page margin, not the canvas edge. Clipping is the
     * obvious fault and the audit was built for it, but a sentence that ends
     * 2 px from the bezel is the fault the interface actually has - it does
     * not look broken, it looks cheap, and that is harder to find by eye than
     * a missing word. Everything on these screens sits inside PAGE_M except
     * the header plate and the viewfinder's own status bar, and both of those
     * are chrome that draws its own ground to the edge. */
    const int w = text_w(f, s);
    const bool over_side = x < PAGE_M || x + w > UI_W - PAGE_M;
    const bool over_end =
        !s_audit_chrome && (y < BODY_Y - HEAD_H || y + f->line_h > UI_H - PAGE_M);
    if (over_side || over_end) {
      ui_audit_text(x, y, w, f->line_h, s);
    }
  }
#endif
  const int baseline = y + f->ascent;
  if (s_dl.rec) {
    /* The exact box of the set glyphs, so a string in another tile costs
     * that tile nothing at all. */
    int bx0 = INT32_MAX, by0 = INT32_MAX, bx1 = INT32_MIN, by1 = INT32_MIN, pen = x;
    for (const char *q = s; *q; q++) {
      const int i = (unsigned char)*q - f->first;
      if (i < 0 || i >= f->count) continue;
      const ui_glyph_t *g = &f->glyphs[i];
      if (g->cov != NULL) {
        const int gx = pen + g->bx, gy = baseline - g->by;
        if (gx < bx0) bx0 = gx;
        if (gy < by0) by0 = gy;
        if (gx + g->w > bx1) bx1 = gx + g->w;
        if (gy + g->h > by1) by1 = gy + g->h;
      }
      pen += g->adv;
    }
    if (bx0 >= bx1 || by0 >= by1) return;
    dl_cmd_t *k = dl_push(DL_TEXT, bx0, by0, bx1, by1);
    if (k) {
      const int at = dl_str(s);
      if (at < 0) { s_dl.n--; return; }
      k->p = f; k->a = x; k->b = y; k->g = at; k->col = ink;
    }
    return;
  }
  for (; *s; s++) {
    const int i = (unsigned char)*s - f->first;
    if (i < 0 || i >= f->count) continue;
    const ui_glyph_t *g = &f->glyphs[i];
    glyph_blend(g, x, baseline, ink);
    x += g->adv;
  }
}

static void text_right(const ui_font_t *f, int x, int y, const char *s, uint16_t ink) {
  text(f, x - text_w(f, s), y, s, ink);
}

/**
 * `s` set into `w` pixels, broken between words, returning the height used.
 *
 * Every note on these screens used to be two `text()` calls with the break
 * chosen by eye against whatever face was current. That survives exactly as
 * long as the face does: the About note was written for the old bitmap type
 * and, once Inter went in, its first line ran off the right of the panel and
 * out over the bezel. A line break is a measurement, not a literary decision,
 * so it belongs here where the widths are.
 *
 * Greedy, no hyphenation, no justification - these blocks are two or three
 * short lines of plain English. A single word wider than `w` is set anyway
 * rather than dropped: overflowing is bad, vanishing is worse.
 */
static int text_wrap(const ui_font_t *f, int x, int y, int w, const char *s, uint16_t ink,
                     bool draw) {
  const int lead = f->line_h + 3;
  int lines = 0;

  while (*s) {
    while (*s == ' ') s++;
    if (*s == '\0') break;

    /* Walk word by word, keeping the last break that still fit. */
    const char *end = s;
    const char *fits = NULL;
    int used = 0;

    for (;;) {
      const char *word = end;
      while (*word == ' ') word++;
      if (*word == '\0') break;
      const char *stop = word;
      while (*stop != '\0' && *stop != ' ') stop++;

      int adv = 0;
      for (const char *c = end; c < stop; c++) {
        const int i = (unsigned char)*c - f->first;
        if (i >= 0 && i < f->count) adv += f->glyphs[i].adv;
      }
      if (used + adv > w && fits != NULL) break;
      used += adv;
      end = stop;
      fits = stop;
    }
    if (fits == NULL) fits = end; /* one word, too wide: set it regardless */

    if (draw) {
      char line[96];
      size_t len = (size_t)(fits - s);
      if (len >= sizeof line) len = sizeof line - 1;
      memcpy(line, s, len);
      line[len] = '\0';
      text(f, x, y + lines * lead, line, ink);
    }

    lines++;
    s = fits;
  }
  return lines > 0 ? (lines - 1) * lead + f->line_h : 0;
}

static int text_block(const ui_font_t *f, int x, int y, int w, const char *s, uint16_t ink) {
  return text_wrap(f, x, y, w, s, ink, true);
}

/* The same measurement without the ink, so a box can be sized to the note it
 * is about to contain rather than to a guess about how the note will break. */
static int text_block_h(const ui_font_t *f, int w, const char *s) {
  return text_wrap(f, 0, 0, w, s, 0, false);
}

/**
 * The largest scale at which `s` fits `w` pixels, 1 or 2.
 *
 * Every string these screens set at scale 2 is user data - a roll name, a look
 * name - so none of them can be sized by eye at build time. Falling back to
 * scale 1 keeps a long name readable and inside its column; clipping it at
 * scale 2 would put half a word against a hard edge and look like a bug.
 */
static const ui_font_t *fit_face(const char *s, int w) {
  return text_w(&UI_FONT_L, s) <= w ? &UI_FONT_L : &UI_FONT_M;
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

/**
 * Text whose INK starts at x, rather than whose pen does.
 *
 * A glyph carries a left side bearing, and it scales with the type: at 17 px
 * Oxanium's S starts about a pixel in, at 74 px about five. So a caps line and
 * a headline set from the same x do not share a left edge - the big one sits
 * further right by the difference, which on the menu card was four pixels of
 * wobble between three pieces of type that are meant to hang off one rule.
 *
 * Only worth it where two different sizes have to align down a common edge,
 * which is the card and the screen titles. Everywhere else the pen is fine.
 */
static void text_ink(const ui_font_t *f, int x, int y, const char *s, uint16_t ink) {
  const int i = (unsigned char)*s - f->first;
  const int bx = (i >= 0 && i < f->count) ? f->glyphs[i].bx : 0;
  text(f, x - bx, y, s, ink);
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
 * The font is ASCII 32..126 and has no such character, and there is no
 * artwork left in this interface to take one from. Everything else on screen
 * is type or a shape this file draws.
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

/**
 * Four cells of `cell` px, left to right, with `st[4]` their states.
 *
 * This is the product's mark. It is on the gallery tiles, the viewfinder's
 * status bar, the photograph's column, the capture banner and the boot
 * screen - and it was drawn in BLUE, with a yellow cell for the one just
 * taken, in a camera whose palette is a near-black ground, one terracotta and
 * one mint. Blue appeared nowhere else in the product, which made the one
 * shape that says "this is a KINO" the one shape that did not look like it.
 *
 * The palette's own two now carry it: mint for a frame in hand, the accent
 * for the one that just arrived, red when a lens lost it, and the pressed
 * tone for a cell that is empty. `dark` no longer selects a second set of
 * tones - the tones read on both grounds, which is what a palette is for.
 */
static void four_mark(int x, int y, int cell, const fm_cell_t *st, bool dark) {
  for (int i = 0; i < 4; i++) {
    const int cx = x + i * (cell + FM_GAP);
    uint16_t fill_c;
    switch (st[i]) {
      case FM_ON: fill_c = MZ_MINT; break;
      case FM_SPARK: fill_c = MZ_ACCENT; break;
      case FM_LOST: fill_c = C_RED; break;
      default: fill_c = W_PRESS; break;
    }
    fill(cx, y, cell, cell, fill_c);
    /* A one-pixel keyline, so an empty cell is still a cell rather than a
     * hole in the background. */
    outline(cx, y, cell, cell, W_HILITE);
  }
}

/*
 * The chevron, at two sizes, and it is one shape.
 *
 * The font is ASCII 32..126 and carries neither character, so the picker
 * buttons, the header's back button and a row that opens a screen get their
 * own. Two strokes meeting at a point, drawn with the same antialiased line
 * as everything else that is not a rectangle - the version before this was a
 * staircase of little filled squares, which is what a chevron looks like when
 * the renderer can only put down whole pixels and is the single most visible
 * piece of pixelation left on the interface.
 *
 * `reach` is the half-height, `weight` the stroke. The small one is the
 * picker's, the large one fills about a third of a 44 px system button, which
 * is what a system button's mark should do.
 */
static void chevron(float cx, float cy, bool right, float reach, float weight, uint16_t ink) {
  const float dir = right ? 1.0f : -1.0f;
  const float tipx = cx + dir * reach * 0.52f;
  const float backx = cx - dir * reach * 0.52f;
  stroke(backx, cy - reach, tipx, cy, weight, ink);
  stroke(backx, cy + reach, tipx, cy, weight, ink);
}

static void picker_arrow(int cx, int cy, bool right, uint16_t ink) {
  chevron((float)cx, (float)cy, right, 6.0f, 2.6f, ink);
}

static void arrow_glyph(int cx, int cy, bool right, uint16_t ink) {
  chevron((float)cx, (float)cy, right, 11.0f, 4.0f, ink);
}

static void back_glyph(int cx, int cy, uint16_t ink) { arrow_glyph(cx, cy, false, ink); }

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

/* Smootherstep: no speed and no acceleration at either end. The same curve
 * gfx.c eases on, because a product whose transitions ease three ways reads
 * as three products. */
static float ease_ui(float t) {
  if (t <= 0.0f) return 0.0f;
  if (t >= 1.0f) return 1.0f;
  return t * t * t * (t * (t * 6.0f - 15.0f) + 10.0f);
}

static float span01(float t, float from, float to) {
  if (to <= from) return t >= to ? 1.0f : 0.0f;
  return ease_ui((t - from) / (to - from));
}

static int lerpi(int a, int b, float e) { return a + (int)((float)(b - a) * e + 0.5f); }

/**
 * The Odd Jobs mark, from the studio's own artwork.
 *
 * It was drawn procedurally first - four discs unioned, four subtracted to
 * pinch the waists, one for the hole - on the theory that a logo made of
 * circles can be described as geometry. It cannot: the real mark is not
 * fourfold symmetric, its lobes are different sizes and its curvature varies,
 * and every parameter I tuned by eye moved it further from the thing rather
 * than closer. A logo is somebody's drawing. You trace it.
 *
 * So `tools/mklogo.swift` bakes the 2048 px master's alpha down to a 160 px
 * coverage map, trimmed to the mark's own bounding box, and this samples it
 * bilinearly at whatever size the caller wants. One map is sharp at the boot
 * screen's 124 px and at the ABOUT row's 34, because a bilinear sample of a
 * coverage field is exactly what an antialiased scale-down is.
 */
static void oddjobs_mark(int cx, int cy, float r, uint16_t ink) {
  if (s_dl.rec) {
    const int e = (int)r + 3;
    dl_cmd_t *k = dl_push(DL_ODD, cx - e, cy - e, cx + e + 1, cy + e + 1);
    if (k) { k->a = cx; k->b = cy; k->f0 = r; k->col = ink; }
    return;
  }
  PX_BLEND((size_t)((2.0f * r + 2.0f) * (2.0f * r + 2.0f)));

  const int span = (int)r + 1;
  const float scale = (float)ODD_JOBS_MARK_N / (2.0f * r);
  const gfx_target_t *t = TG;
  int y0 = cy - span, y1 = cy + span, x0 = cx - span, x1 = cx + span;
  if (x0 < t->x0) x0 = t->x0;
  if (y0 < t->y0) y0 = t->y0;
  if (x1 >= CV_X1(t)) x1 = CV_X1(t) - 1;
  if (y1 >= CV_Y1(t)) y1 = CV_Y1(t) - 1;
  for (int py = y0; py <= y1; py++) {
    uint16_t *row = cv_ptr(t, t->x0, py) - t->x0;
    for (int px = x0; px <= x1; px++) {
      /* Into the map's own pixels, at its centre. */
      const float u = ((float)px + 0.5f - (float)cx) * scale + (float)ODD_JOBS_MARK_N / 2.0f;
      const float v = ((float)py + 0.5f - (float)cy) * scale + (float)ODD_JOBS_MARK_N / 2.0f;
      if (u < 0.0f || v < 0.0f || u >= (float)ODD_JOBS_MARK_N - 1.0f ||
          v >= (float)ODD_JOBS_MARK_N - 1.0f) {
        continue;
      }
      const int iu = (int)u, iv = (int)v;
      const float fu = u - (float)iu, fv = v - (float)iv;
      const uint8_t *m = ODD_JOBS_MARK + (size_t)iv * ODD_JOBS_MARK_N + iu;
      const float a = (float)m[0] * (1.0f - fu) + (float)m[1] * fu;
      const float b = (float)m[ODD_JOBS_MARK_N] * (1.0f - fu) +
                      (float)m[ODD_JOBS_MARK_N + 1] * fu;
      const int k = (int)(a * (1.0f - fv) + b * fv + 0.5f);
      if (k <= 0) continue;
      row[px] = k >= 254 ? ink : mix(row[px], ink, k);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

/*
 * The camera waking up: rings of cells radiating out of the maker's mark.
 *
 * The first attempt at this was a square grid of ASCII-ish glyphs blooming
 * outward, and it was wrong in the way a misread reference usually is - it
 * copied the texture and missed the structure. The reference is not a grid.
 * It is CONCENTRIC RINGS: a warm disc at the centre with an aim mark in it,
 * and around it band after band of cells, each band with its own shape and
 * its own size, large and warm near the middle, finer and cooler as they go
 * out, thinning to specks at the rim.
 *
 * Which is a much better thing for a camera to open with, because the centre
 * of that composition is a lens: the studio's mark has a hole through the
 * middle of it and sits exactly where the aim disc does.
 *
 * Every ring's cells are evenly spaced around it, offset from the ring inside
 * so nothing lines up radially, and a few are dropped on a hash so the bands
 * are not perfect. The whole thing grows ring by ring and then retreats the
 * same way, uncovering the wordmark as it goes.
 */
/*
 * The field.
 *
 * Traced off the reference clip frame by frame, and it is not the concentric
 * bloom the round device shows - it is a square lattice of small glyphs that
 * grows out of a seed at the centre, fills the screen, and draws back in.
 * What makes it read the way it does, in the order the eye notices:
 *
 *   - a SQUARE grid. Cells sit on a regular pitch, rows and columns, not on
 *     rings at angle steps. The diagonals you see are the lattice, not
 *     something drawn diagonally.
 *   - an ALPHABET, not a dot. Each cell holds one of a handful of small
 *     marks, and the mix is what stops a field of 900 cells reading as noise
 *     or as wallpaper.
 *   - WEIGHT falls with distance. The middle is solid glyphs - hashes, discs,
 *     squares - and the rim is single dots and short runs. That gradient is
 *     the whole reason it looks like something radiating rather than a
 *     texture someone tiled.
 *   - colour is per CELL, not per band: cream, amber, bright green, dim
 *     green, mixed all through, with the cool ones commoner further out.
 *
 * The glyphs are the reference's own, read off the sharpest frame in the clip
 * (a 5x5 bitmap drawn three pixels to the bit). The hash, the discs, the
 * solid square, the plus, the double bar and the dotted run are unambiguous
 * at that resolution. The ring-with-a-dot is the one I am reading through
 * video compression rather than seeing exactly: a square ring broken at one
 * corner with a dot inside it, which is what it resolves to on every instance
 * in the frame, and it is the glyph to check first against the real artwork.
 */
#define BF_PITCH 20 /* between cell centres */
#define BF_BIT 3    /* pixels per bit of a glyph's 5x5 */
#define BF_CX (UI_W / 2)
/* The middle of the panel. It sat at 208 to leave room for a wordmark that
 * is no longer on this screen, and 32 px off centre is exactly the kind of
 * thing that reads as unfinished without anyone being able to say why. */
#define BF_CY (UI_H / 2)
/*
 * The radius the field STARTS at, so its first frame is a handful of cells
 * rather than nothing.
 *
 * smootherstep is very flat at its start - a fifth of the way through the
 * growth it has moved six per cent - so beginning at zero meant four hundred
 * milliseconds of black before anything was visible at all. The reference's
 * first frame already has cells in it; this is that cluster.
 */
#define BF_SEED 52.0f
#define BF_CELL_MS 260 /* how long a cell holds its mark before re-rolling */
/*
 * The frontier is soft and it is not a circle.
 *
 * A cell either was or was not inside `reach`, which made the edge of the
 * field a perfect expanding circle with a hard rim - and a hard geometric
 * edge sweeping across a screen is the single thing that made this read as a
 * loading bar rather than as something growing. Two changes fix it, and both
 * are per cell so they cost nothing:
 *
 *   BF_JITTER  each cell arrives at its own radius, up to this much late, so
 *              the frontier is ragged the way a spreading thing is
 *   BF_FADE    and it arrives over this many pixels of travel rather than at
 *              once, coming up out of the ground instead of appearing
 */
#define BF_JITTER 74.0f
#define BF_FADE 66.0f
#define BF_REACH 590.0f /* past the corner, and past the jitter, so the field fills */

/*
 * The alphabet, 5x5, one byte per row, bit 4 is the left-hand column.
 *
 * Nine marks, and they are the reference's nine. The first read of it had a
 * plus and a pair of HORIZONTAL bars in place of the reference's vertical
 * ones - a glyph turned ninety degrees is a different glyph - and folded the
 * asterisk into the hash, which are the two commonest marks on the screen and
 * are not the same shape: the hash has a dark centre and dark corners, the
 * asterisk is solid through the middle with its four diagonal points detached.
 * The pair of short vertical bars is what most of the rim is made of.
 */
enum {
  GL_HASH = 0, /* #   the commonest mark, and the one that carries the field */
  GL_STAR,     /* ✳   solid centre, four detached diagonal points */
  GL_NOTCH,    /* ▣   a square ring, broken at one corner, a dot inside */
  GL_DISC,     /* ●   a stepped circle: corners off, nothing else */
  GL_SQUARE,   /* ■   and the same block with its corners on */
  GL_BAR2,     /* ‖   two short uprights - most of the rim */
  GL_BAR1,     /* |   one upright */
  GL_RUN,      /* ⋯   a short run of dots */
  GL_DOT,      /* ·   and a single dot */
  GL_N,
};

/*
 * Every mark is a bitmap. There is no drawn shape in this field.
 *
 * The disc and the square were going through disc() and round_rect(), which
 * put the one antialiased curve in the whole picture - a smooth circle among
 * nine pixel forms, which is exactly as wrong as a smooth letter in a bitmap
 * font. Blown up twenty times, the reference's own circles step: a flat top a
 * few pixels wide, out one, out again. It is drawing a pixel circle, so this
 * draws a pixel circle, and the two differ only by whether the corners are
 * set - which at three pixels to the bit is the whole difference between a
 * round thing and a square one.
 */
static const uint8_t BF_GLYPH[GL_N][5] = {
    {0x0A, 0x1F, 0x0A, 0x1F, 0x0A}, /* # */
    {0x15, 0x0E, 0x1F, 0x0E, 0x15}, /* ✳ */
    {0x0F, 0x11, 0x15, 0x11, 0x1F}, /* ▣ */
    {0x0E, 0x1F, 0x1F, 0x1F, 0x0E}, /* ● */
    {0x1F, 0x1F, 0x1F, 0x1F, 0x1F}, /* ■ */
    {0x00, 0x0A, 0x0A, 0x0A, 0x00}, /* ‖ */
    {0x00, 0x04, 0x04, 0x04, 0x00}, /* | */
    {0x00, 0x00, 0x15, 0x00, 0x00}, /* ⋯ */
    {0x00, 0x00, 0x04, 0x00, 0x00}, /* · */
};

/*
 * The colours, and what they mean here.
 *
 * The reference is a light remote, and both quantities in its display are
 * facts about a lamp: the field's size is how bright the light is, and its
 * colour is the colour the light is being set to under your finger. It is not
 * decoration - it is the instrument's read-out, and that is why it holds
 * attention.
 *
 * A D4 is the opposite instrument. It does not emit light, it gathers it,
 * through four lenses. So the two quantities carry the two facts that are
 * actually true about this machine while it wakes up:
 *
 *   how far the field reaches   the boot's own clock: it fills the panel
 *   what colour it is           which look the camera is going to shoot with,
 *                               and, per quadrant, whether that camera answered
 *
 * The colour is read off the real device state, not animated on a timer. A
 * body whose third camera never answers boots with a cold grey quadrant where
 * that camera's pictures would come from, and says so without a word of type
 * on the screen - in the product's own mark, which is four. (The reach used
 * to carry that fact and was changed: see boot_field().)
 *
 * The palettes are the camera's, not the lamp's. Sampled hues from the
 * reference where they fit the product and dropped where they did not: a
 * camera that boots violet is a camera pretending to be somebody else's
 * object. A look is picked by hashing its id, so a given look always brings
 * the same colour up and changing look in Studio changes what the camera
 * looks like when it starts.
 */
#define BF_PAL_N 4
static const uint16_t BF_PAL[BF_PAL_N][4] = {
    /* the standard look: amber and green, the reference's own warm pair */
    {RGB(0xf0, 0xea, 0xd8), RGB(0xe8, 0xc0, 0x70), RGB(0x2e, 0xa1, 0x44), RGB(0x1a, 0x5e, 0x31)},
    /* a warm look: the product's terracotta against its card colour */
    {RGB(0xf2, 0xe8, 0xdc), RGB(0xe8, 0x73, 0x4a), RGB(0xe8, 0xa1, 0x83), RGB(0x6e, 0x3a, 0x33)},
    /* a cool look: mint, which is what this interface says "live" in */
    {RGB(0xe8, 0xf2, 0xec), RGB(0x86, 0xd6, 0xb4), RGB(0x2e, 0xa1, 0x44), RGB(0x1a, 0x4e, 0x3e)},
    /* and a neutral one, for a look that is not grading much at all */
    {RGB(0xf0, 0xee, 0xe4), RGB(0xc8, 0xc0, 0xa8), RGB(0x8a, 0x94, 0x8c), RGB(0x33, 0x3b, 0x36)},
};

/* Cold: the instrument before it knows what it is shooting. The field comes
 * up in this and travels to the look's own colours as the cameras answer. */
static const uint16_t BF_COLD[4] = {
    RGB(0x9a, 0xa2, 0x9e), RGB(0x6c, 0x76, 0x72), RGB(0x45, 0x4e, 0x4a), RGB(0x23, 0x29, 0x27),
};

/** Slot `i` of the palette, `warm` of the way from cold to the look's own. */
static uint16_t bf_ink(int i, int pal, float warm) {
  const int k = warm <= 0.0f ? 0 : (warm >= 1.0f ? 255 : (int)(warm * 255.0f));
  return mix(BF_COLD[i], BF_PAL[pal][i], k);
}

static uint32_t br_hash(int a, int b) {
  uint32_t h = ((uint32_t)a * 374761393u) ^ ((uint32_t)b * 668265263u);
  h = (h ^ (h >> 13)) * 1274126177u;
  return h ^ (h >> 16);
}

/** One glyph, its top-left at (x, y), three pixels to the bit. */
static void bf_glyph(int x, int y, int g, uint16_t ink) {
  const uint8_t *rows = BF_GLYPH[g];
  for (int r = 0; r < 5; r++) {
    const uint8_t bits = rows[r];
    /* A run of set bits is one fill, not one per bit: a full row of the
     * glyph is a 15 px span rather than five 3 px squares, and at ~900 cells
     * a frame the call count and the partial cache lines were most of what
     * the splash spent drawing. */
    int c = 0;
    while (c < 5) {
      if ((bits & (0x10u >> c)) == 0) {
        c++;
        continue;
      }
      int n = 1;
      while (c + n < 5 && (bits & (0x10u >> (c + n))) != 0) n++;
      fill(x + c * BF_BIT, y + r * BF_BIT, n * BF_BIT, BF_BIT, ink);
      c += n;
    }
  }
}

/**
 * The field out to `reach` pixels from the middle.
 *
 * Every cell is decided by a hash of its own coordinates, so a cell looks the
 * same on every frame and the field grows rather than churns - which is the
 * difference between something arriving and something flickering.
 */
/*
 * How far the field has come up in each quadrant, one per camera.
 *
 * Cam 1 is top left and they run across then down, which is how the four sit
 * on the viewfinder, in the gallery's mark and on the body. A camera that has
 * not answered holds its quarter at BF_DARK, which boot_field() reads as
 * cold: the quarter keeps the greys the field came up in while the others
 * warm to the look. The shape is the whole field either way.
 */
#define BF_DARK 0.42f
static float s_bf_cam[4];

static void boot_field(float reach, int32_t ms, int pal, float warm) {
  if (reach <= 0.0f) return;
  if (s_dl.rec) {
    dl_cmd_t *k = dl_push(DL_FIELD, 0, 0, UI_W, UI_H);
    if (k) { k->f0 = reach; k->a = ms; k->b = pal; k->f1 = warm; }
    return;
  }

  /* The furthest a cell can be and still be on the panel. */
  const float far = 470.0f;
  const int half = (5 * BF_BIT) / 2;
  const gfx_target_t *tg = TG;

  for (int gy = -(UI_H / 2) / BF_PITCH - 1; gy <= (UI_H / 2) / BF_PITCH + 1; gy++) {
    for (int gx = -(UI_W / 2) / BF_PITCH - 1; gx <= (UI_W / 2) / BF_PITCH + 1; gx++) {
      const int cx = BF_CX + gx * BF_PITCH;
      const int cy = BF_CY + gy * BF_PITCH;
      /* A cell whose glyph box misses the target's window costs nothing:
       * in a tile pass the field is drawn once per tile and most of its 900
       * cells land in other tiles. */
      if (cx + half < tg->x0 || cy + half < tg->y0 || cx - half >= CV_X1(tg) ||
          cy - half >= CV_Y1(tg)) {
        continue;
      }
      const float dx = (float)(cx - BF_CX), dy = (float)(cy - BF_CY);
      const float dist = sqrtf(dx * dx + dy * dy);

      /*
       * When this cell's turn comes, and how far through it is.
       *
       * The jitter grows with distance rather than being full strength
       * everywhere. At the middle that meant the few cells nearest the centre
       * could each be held back by up to 74 px of travel, so the seed could
       * not form and the first half-second was an empty screen. It is also
       * simply truer: a thing spreading out is tight at its origin and ragged
       * at its edge, not equally ragged all through.
       */
      /*
       * Which cameras this cell belongs to, and how far up they are.
       *
       * Blended across the two axes rather than snapped to a quadrant: a hard
       * quarter boundary draws a cross through the middle of the field, and
       * the field has no cross in it. Within a cell of an axis a cell reads
       * from both sides of it.
       */
      const float bx = dx < -(float)BF_PITCH   ? 0.0f
                       : dx > (float)BF_PITCH  ? 1.0f
                                               : (dx + (float)BF_PITCH) / (2.0f * (float)BF_PITCH);
      const float by = dy < -(float)BF_PITCH   ? 0.0f
                       : dy > (float)BF_PITCH  ? 1.0f
                                               : (dy + (float)BF_PITCH) / (2.0f * (float)BF_PITCH);
      const float cam = (s_bf_cam[0] * (1.0f - bx) + s_bf_cam[1] * bx) * (1.0f - by) +
                        (s_bf_cam[2] * (1.0f - bx) + s_bf_cam[3] * bx) * by;

      const float jit = (float)(br_hash(gx + 31, gy - 17) % 1024u) / 1024.0f;
      const float spread = BF_JITTER * (0.18f + 0.82f * (dist / far));
      /*
       * The reach is the clock's; the camera is the colour.
       *
       * The reach used to be scaled by `cam`, so a body whose cameras had not
       * answered booted with a field that stopped at 42 percent of the panel
       * - which is what the first bench with four silent nodes showed, and it
       * read as a boot that had failed, not as four cameras that were quiet.
       * The field fills the screen now whatever the cameras are doing, and a
       * quadrant whose camera has not answered stays in the cold greys while
       * the others take the look's colours. Same fact, said with the one
       * quantity that cannot be mistaken for a fault in the drawing.
       */
      const float k = (reach - (dist + jit * spread)) / BF_FADE;
      if (k <= 0.0f) continue;
      const float grow = k < 1.0f ? k : 1.0f;
      float cam_w = (cam - BF_DARK) / (1.0f - BF_DARK);
      if (cam_w < 0.0f) cam_w = 0.0f;
      if (cam_w > 1.0f) cam_w = 1.0f;

      /*
       * The cell re-rolls over time, and the cells do not re-roll together.
       *
       * In the reference a cell holds a mark for a moment and then is a
       * different mark - the field shimmers rather than sits. Rolling every
       * cell off one global counter makes the whole screen blink at once,
       * which reads as a glitch; so each cell's clock is offset by a hash of
       * its own position, and the changes scatter.
       *
       * Position is still in the hash, so a cell keeps its own character
       * across a re-roll and the field grows rather than boils.
       */
      const uint32_t phase = br_hash(gx + 977, gy - 613) % (uint32_t)BF_CELL_MS;
      const uint32_t gen = (uint32_t)(ms + (int32_t)phase) / (uint32_t)BF_CELL_MS;
      const uint32_t h = br_hash(gx, (int)((uint32_t)gy + gen * 7919u));
      const float d = dist / far; /* 0 in the middle, 1 at the corner */

      /* Thinning outward. The rim is mostly empty, which is what lets the
       * middle read as dense without the whole screen filling in. */
      /* Whether a cell is lit at all is fixed by position, NOT re-rolled:
       * a field whose cells appear and vanish twinkles, and the reference's
       * does not - its cells stay put and change what they are. */
      const uint32_t here = br_hash(gx, gy);
      const uint32_t drop = (uint32_t)(6.0f + 74.0f * d * d);
      if ((here >> 3) % 100u < drop) continue;

      /*
       * Weight falls with distance, and the alphabet sorts itself by weight:
       * hashes, asterisks, discs and squares hold the middle, the notched
       * ring sits between, and the rim is uprights, short runs and dots. That
       * is the reference's own distribution - its centre is solid marks and
       * its edge is almost entirely pairs of short vertical bars.
       */
      int g;
      const uint32_t pick = (h >> 11) % 100u;
      if (d < 0.30f) {
        g = pick < 34 ? GL_HASH : pick < 52 ? GL_STAR : pick < 66 ? GL_DISC
            : pick < 78 ? GL_NOTCH : pick < 88 ? GL_SQUARE : pick < 95 ? GL_BAR2 : GL_DOT;
      } else if (d < 0.62f) {
        g = pick < 28 ? GL_HASH : pick < 42 ? GL_STAR : pick < 54 ? GL_NOTCH
            : pick < 63 ? GL_DISC : pick < 70 ? GL_SQUARE : pick < 86 ? GL_BAR2
            : pick < 94 ? GL_BAR1 : GL_DOT;
      } else {
        g = pick < 38 ? GL_BAR2 : pick < 56 ? GL_DOT : pick < 72 ? GL_RUN
            : pick < 86 ? GL_BAR1 : pick < 94 ? GL_HASH : GL_STAR;
      }

      /* Cream leads in every band: most of the panel's AREA is the outer
       * band, so a mix that only favours cream in the middle comes out the
       * colour of the rim. */
      const uint32_t ci = (h >> 19) % 100u;
      int ink;
      if (d < 0.34f) ink = ci < 54 ? 0 : ci < 76 ? 1 : ci < 94 ? 2 : 3;
      else if (d < 0.66f) ink = ci < 48 ? 0 : ci < 66 ? 1 : ci < 88 ? 2 : 3;
      else ink = ci < 36 ? 0 : ci < 50 ? 1 : ci < 76 ? 2 : 3;

      /* Up out of the ground, not switched on: at 900 cells the difference
       * between a fade and a pop is the whole character of the thing. */
      const uint16_t base = bf_ink(ink, pal, warm * cam_w);
      const uint16_t lit =
          grow >= 0.995f ? base : mix(MZ_GROUND, base, (int)(grow * 255.0f));
      bf_glyph(cx - half, cy - half, g, lit);
    }
  }
}

/**
 * The camera's own mark, in the middle of the screen.
 *
 * Not part of the boot any more - the boot is the field and nothing else.
 * This is what the camera shows while it is going away: shutting down or
 * restarting, one mark, centred, until the screen does. A machine that is
 * leaving should say which machine is leaving and nothing else.
 */
static void boot_mark(void) {
  const int lx = (UI_W - KINO_D4_LOGO_W) / 2;
  const int ly = (UI_H - KINO_D4_LOGO_H) / 2;
  draw_bits(KINO_D4_LOGO, KINO_D4_LOGO_W, KINO_D4_LOGO_H, KINO_D4_LOGO_STRIDE, lx, ly, 1, MZ_CARD);
}

/* ------------------------------------------------------------------ */
/* The animation driver                                                */
/* ------------------------------------------------------------------ */
/*
 * One frame per UI pass, rather than a loop that runs a move to completion.
 *
 * Every animation here used to be a `for(;;)` that read the clock, drew, and
 * presented until its time was up - which is the obvious way to write it and
 * has two faults that only show up off the bench.
 *
 * The first is the Twin. It runs this same code compiled to WebAssembly, and
 * a pass is ONE blocking call: whatever a pass presents is copied into a ring
 * of 40 frames and played back afterwards. The boot sequence presents about
 * 119 frames. Seventy-nine of them were landing in the same slot, so the
 * splash played its first third and then snapped to its end - which is
 * exactly what it looked like, and no amount of easing was ever going to fix
 * it, because the frames were being computed and thrown away.
 *
 * The second is the camera. A blocking move owns the UI task for its whole
 * duration, so nothing else on that task - the conditions scan, a shutter
 * press, a wake - can be serviced until it ends.
 *
 * So a move is state, and `anim_tick()` advances it by one frame. The loop
 * that owns the clock is the UI loop, which is the one loop that should.
 */
/* Drawn later in the file; the driver only needs to be able to call them. */
static void draw_screen(void);
static void open_frame(int row, float t);
static void go(screen_t s, int ms);
static void boot_mark(void);
static void boot_field(float reach, int32_t ms, int pal, float warm);

/*
 * The frames, as functions the compositor can call.
 *
 * gfx_render() decides where a frame is drawn - the whole canvas, or a band
 * of it at a time - and calls the drawing back once per place. So every
 * frame this file shows is one of these: a function of the UI's state and
 * its context, drawing the whole logical screen, and nothing after it that
 * draws. `render_screen` is the current screen; the others are the moves and
 * the marks.
 */
static void ui_render(gfx_draw_fn draw, void *ctx);
static void render_cascade(void *ctx);
static void boot_bench(void);
static void first_start_note(void);

static void render_screen(void *ctx) {
  (void)ctx;
  draw_screen();
}

typedef struct {
  float reach;
  int32_t ms;
  int pal;
  float warm;
} field_frame_t;

static void render_field(void *ctx) {
  const field_frame_t *f = ctx;
  fill(0, 0, UI_W, UI_H, MZ_GROUND);
  boot_field(f->reach, f->ms, f->pal, f->warm);
}

/* render_open() is with the animation state it reads, below. */

/* The camera's mark on the ground, and the same mark fading to black. */
static void render_mark(void *ctx) {
  (void)ctx;
  fill(0, 0, UI_W, UI_H, MZ_GROUND);
  boot_mark();
}

static void render_mark_fade(void *ctx) {
  const int *k = ctx;
  fill(0, 0, UI_W, UI_H, MZ_GROUND);
  boot_mark();
  scrim(0, 0, UI_W, UI_H, W_DKSHAD, *k);
}

static void render_black(void *ctx) {
  (void)ctx;
  fill(0, 0, UI_W, UI_H, W_DKSHAD);
}

static void render_restarting(void *ctx) {
  (void)ctx;
  fill(0, 0, UI_W, UI_H, W_FACE);
  text_mid(&UI_FONT_L, UI_W / 2, UI_H / 2 - UI_FONT_L.line_h / 2, "RESTARTING", W_TEXT);
}

/*
 * How long a move takes.
 *
 * Three numbers, in one place, because a product whose transitions are all
 * slightly different lengths reads as a product nobody timed. They are longer
 * than they were: the first cut ran at 160-220 ms, which is the length of a
 * transition you are meant to feel and not to watch, and on a screen the size
 * of a postcard held at arm's length it was over before the eye had found the
 * thing that moved. These are long enough to read and short enough that
 * nobody waits for them.
 *
 * Going back is quicker than going in. Opening something is the interesting
 * direction - it is where you are arriving - and a return trip that takes as
 * long as the outbound one feels like being made to sit through it.
 */
#define NAV_OPEN_MS 420
#define NAV_BACK_MS 340
#define NAV_CASCADE_MS 700
static void boot_handoff(void);
static bool look_current_id(char *out, size_t cap);
static const camlink_info_t *about_cameras(void);

typedef enum {
  ANIM_NONE = 0,
  ANIM_SPLASH,
  ANIM_OPEN,
  ANIM_CASCADE, /* the menu's rows arriving, after the splash */
} anim_kind_t;

/*
 * The splash, as the beats it is made of - and there are three, not five.
 *
 * It had the growth split in two, a seed beat easing out to a stop at 132 px
 * and a bloom beat easing back in from rest to carry on. Both curves are
 * smootherstep, which has zero velocity at each end, so the field visibly
 * stalled a third of the way out and then set off again. Two eases glued
 * end to end are not one motion however well each is chosen.
 *
 * And it ended on a beat of black before the menu arrived, which is the
 * second place it snapped: the field left, nothing was there, and then the
 * menu cut in. The retreat runs straight into the handover now.
 */
enum {
  SPL_GROW = 0, /* out of nothing to the whole panel, one motion */
  SPL_HELD,     /* full, and alive: the cells go on re-rolling */
  SPL_BACK,     /* and away again */
  SPL_DONE,
};
/*
 * Slower, and weighted toward the two beats that are worth watching.
 *
 * It ran 2.14 s and most of that was the field arriving and leaving at a
 * speed that read as a progress bar being filled. The bloom and the retreat
 * are where the motion is, so they get the time; the hold is long enough for
 * the cells to re-roll twice, which is the beat that says the field is alive
 * rather than a picture.
 */
static const int32_t SPL_MS[] = {1820, 860, 1080};

static struct {
  anim_kind_t kind;
  int phase;
  int64_t t0_us;   /* when THIS phase began */
  int64_t start_us; /* when the whole move began */
  uint32_t f0;      /* frames the compositor had presented when it began */
  uint64_t draw0_us, xpose0_us, vsync0_us; /* gfx_pass_split() when it began */
  int32_t span_ms;
  int row;
  int pal;          /* which look's colours the boot field is wearing */
  bool opening;
  screen_t card;    /* the screen drawn inside the card: arriving when opening, leaving when not */
  bool snap;        /* the card is blitted from the stash, drawn there once at the start */
} s_anim;

static bool anim_active(void) { return s_anim.kind != ANIM_NONE; }

/* One frame of the open move at phase *ctx, as a frame the compositor calls. */
static void render_open(void *ctx) {
  const float *p = ctx;
  open_frame(s_anim.row, *p);
}

static void anim_phase(int phase, int32_t span_ms) {
  s_anim.phase = phase;
  s_anim.span_ms = span_ms;
  s_anim.t0_us = esp_timer_get_time();
}

/*
 * What a move actually ran at, on this panel, in the log ring.
 *
 * The Twin steps one virtual frame per pass and cannot look choppy, so the
 * only frame rate that means anything is the camera's own, and until now
 * nobody could read it: the one figure - the boot cascade - went to ESP_LOGI,
 * which does not reach the host. Every move reports here now, so GET_LOGS
 * after a tap says what the eye saw.
 */
static void anim_report(const char *what) {
  uint32_t f1 = 0;
  gfx_stats(&f1, NULL);
  const uint32_t ms = (uint32_t)((esp_timer_get_time() - s_anim.start_us) / 1000);
  const uint32_t frames = f1 - s_anim.f0;
  uint64_t d1 = 0, x1 = 0, v1 = 0;
  gfx_pass_split(&d1, &x1, &v1);
  const uint32_t draw_ms = (uint32_t)((d1 - s_anim.draw0_us) / 1000);
  const uint32_t xpose_ms = (uint32_t)((x1 - s_anim.xpose0_us) / 1000);
  const uint32_t vsync_ms = (uint32_t)((v1 - s_anim.vsync0_us) / 1000);
  const char *const card = s_anim.kind == ANIM_OPEN ? SCREEN_NAME[s_anim.card] : NULL;
  klog("P4",
       "%s%s%s: %lu frames in %lu ms (%lu fps); per frame %lu ms drawing, %lu ms writing out, %lu ms "
       "waiting for the panel",
       what, card ? " " : "", card ? card : "", (unsigned long)frames, (unsigned long)ms, (unsigned long)(ms ? frames * 1000 / ms : 0),
       (unsigned long)(frames ? draw_ms / frames : 0), (unsigned long)(frames ? xpose_ms / frames : 0),
       (unsigned long)(frames ? vsync_ms / frames : 0));
}

static void anim_start_splash(void) {
  s_anim.kind = ANIM_SPLASH;
  s_anim.start_us = esp_timer_get_time();
  gfx_stats(&s_anim.f0, NULL);
  gfx_pass_split(&s_anim.draw0_us, &s_anim.xpose0_us, &s_anim.vsync0_us);

  /*
   * The look decides the colour, and it is decided once: a look cannot change
   * while the camera is starting up, and re-reading it per frame would be a
   * config lookup on a draw path for an answer that cannot move.
   *
   * Hashed rather than tabulated because looks are the operator's, not ours -
   * they are created in Studio and there is no list here to colour by hand.
   * What matters is that it is STABLE: the same look brings the same colour
   * up every time, so the way the camera starts becomes something you know
   * about your own camera.
   */
  char id[KDP_RECIPE_ID_MAX];
  if (!look_current_id(id, sizeof id)) id[0] = '\0';
  uint32_t h = 2166136261u;
  for (const char *c = id; *c != '\0'; c++) h = (h ^ (uint32_t)(unsigned char)*c) * 16777619u;
  s_anim.pal = (int)(h % BF_PAL_N);

  /* The four start cold and come up with their cameras. */
  for (int i = 0; i < 4; i++) s_bf_cam[i] = 0.0f;

  anim_phase(SPL_GROW, SPL_MS[SPL_GROW]);
}

static void anim_start_open(int row, bool opening, screen_t card, int ms) {
  s_anim.kind = ANIM_OPEN;
  s_anim.row = row;
  s_anim.opening = opening;
  s_anim.card = card;
  /*
   * Two screens are too costly to draw on every frame of a move: SHOOT, whose
   * four panes are remapped pixel by pixel from the finder's tiles (18 ms a
   * frame, the one move still at 30 fps), and GALLERY, whose thumbnails are
   * half a megabyte of PSRAM reads (25 fps). Each is drawn once, here, into
   * the stash, and the move blits the card from that - a frozen finder for
   * 400 ms, which is what the review hold already shows after a shot, and a
   * page of pictures that travels as a picture.
   */
  s_anim.snap = card == SCR_SHOOT || card == SCR_GALLERY;
  if (s_anim.snap) {
    const screen_t keep = s_screen;
    s_screen = card;
    gfx_render_stash(render_screen, NULL);
    s_screen = keep;
  }
  s_anim.start_us = esp_timer_get_time();
  gfx_stats(&s_anim.f0, NULL);
  gfx_pass_split(&s_anim.draw0_us, &s_anim.xpose0_us, &s_anim.vsync0_us);
  anim_phase(0, ms);
}

/* The menu arriving after the splash, on the same clock and the same report
 * as a move. It was a compositor loop of its own (gfx_cascade) at 40 fps; it
 * is drawn from the menu now like everything else, and it is the last thing
 * that went to the panel any other way. */
static void anim_start_cascade(int ms) {
  s_anim.kind = ANIM_CASCADE;
  s_anim.start_us = esp_timer_get_time();
  gfx_stats(&s_anim.f0, NULL);
  gfx_pass_split(&s_anim.draw0_us, &s_anim.xpose0_us, &s_anim.vsync0_us);
  anim_phase(0, ms);
}

/** How far through the whole move, in seconds - the colour travels on this
 *  rather than on the phase, for the reason the re-roll clock does. */
static float t_all(void) {
  return (float)(esp_timer_get_time() - s_anim.start_us) / 1000000.0f;
}

/** How far through the current phase, 0..1, clamped. */
static float anim_t(void) {
  if (s_anim.span_ms <= 0) return 1.0f;
  const float t = (float)(esp_timer_get_time() - s_anim.t0_us) / ((float)s_anim.span_ms * 1000.0f);
  return t < 0.0f ? 0.0f : (t > 1.0f ? 1.0f : t);
}

/**
 * One frame of whatever is running. Returns the ms to wait before the next.
 *
 * Zero means "as soon as the compositor will take one", which on the camera
 * is the panel's own refresh - gfx_present() blocks on it - and in the Twin
 * is one virtual frame. A hold returns real milliseconds, because there is
 * nothing to draw and the only thing being waited for is the clock.
 */
static uint32_t anim_tick(void) {
  const float t = anim_t();
  const bool done = t >= 1.0f;

  switch (s_anim.kind) {
    case ANIM_SPLASH: {
      /*
       * The field, and nothing else on the screen.
       *
       * It carried the studio's disc at its middle and the camera's wordmark
       * under it, and the reference's startup carries neither - it is one
       * thing happening, which is why it holds attention for two seconds.
       * Both marks have a place on this camera: the studio signs the ABOUT
       * screen, and the wordmark is what the camera shows when it is going
       * away. Neither of them is the boot screen.
       */
      /*
       * The re-roll clock runs from the START of the splash, not from the
       * start of the current phase.
       *
       * This was the two snaps. Every cell picks its mark from a generation
       * counter derived from this number, staggered by a per-cell offset so
       * the changes scatter - but anim_phase() resets the phase clock, so at
       * each of the two phase boundaries the counter went back to zero and
       * EVERY cell re-rolled on the same frame. Three phases, two internal
       * boundaries, two whole-field flashes, in exactly the places the
       * geometry was provably continuous. The motion was never the problem.
       */
      const int32_t ms = (int32_t)((esp_timer_get_time() - s_anim.start_us) / 1000);

      /*
       * The two facts the field is drawing, read off the camera each frame.
       *
       * about_cameras() is cached for two seconds by the thing that owns the
       * channel locks, so this is a struct read however often it is called -
       * and two seconds is the right grain anyway: a node either answered or
       * it has not, and it does not change between two frames.
       *
       * Each quadrant EASES toward its camera's state rather than snapping to
       * it, so a node answering part-way through the boot opens its quarter
       * out instead of making it appear. That is the moment worth having on
       * this screen: the camera assembling itself while you watch.
       */
      {
        const camlink_info_t *cams = about_cameras();
        for (int i = 0; i < 4; i++) {
          const float want = cams[i].online ? 1.0f : BF_DARK;
          s_bf_cam[i] += (want - s_bf_cam[i]) * 0.10f;
        }
      }
      /* The colour travels over most of the growth, not the first half
       * second of it: the camera is finding its look while it wakes, and
       * arriving at it before the field is half out wastes the journey. */
      const float warm = span01(t_all(), 0.35f, 2.30f);
      switch (s_anim.phase) {
        case SPL_GROW:
          /* One motion, nothing to nearly the corner. smootherstep starts
           * from rest, so the opening cells still creep out of the middle
           * the way the reference's do - that beat was never a separate
           * phase, it is just the front of this curve. */
          {
            field_frame_t f = {BF_SEED + ease_ui(t) * (BF_REACH - BF_SEED), ms, s_anim.pal, warm};
            ui_render(render_field, &f);
          }
          if (done) anim_phase(SPL_HELD, SPL_MS[SPL_HELD]);
          return 0;

        case SPL_HELD:
          /* Full, and still changing: the cells go on re-rolling, which is
           * the beat that says the field is alive rather than a picture. */
          {
            field_frame_t f = {BF_REACH, ms, s_anim.pal, warm};
            ui_render(render_field, &f);
          }
          if (done) anim_phase(SPL_BACK, SPL_MS[SPL_BACK]);
          return 0;

        case SPL_BACK:
          /*
           * Accelerating away, not easing to a stop.
           *
           * `1 - smootherstep` flattens as it finishes, so the last of the
           * field crept off over a third of a second and then the panel sat
           * empty waiting for the phase to end - a dead beat, and then the
           * menu cut into it. Something leaving should gather speed and be
           * gone: this hits zero exactly as the phase does, and the menu
           * arrives on the frame after.
           */
          {
            field_frame_t f = {(1.0f - t * t) * BF_REACH, ms, s_anim.pal, warm};
            ui_render(render_field, &f);
          }
          if (done) {
            anim_report("splash");
            s_anim.kind = ANIM_NONE;
            /* Straight into the menu. The retreat's own tail is the pause -
             * the last cells are already fading as the first rows land, so
             * there is no moment where the panel is holding nothing. */
            boot_handoff();
          }
          return 0;

        default:
          s_anim.kind = ANIM_NONE;
          return 0;
      }
    }

    case ANIM_OPEN: {
      float p = t;
      if (!s_anim.opening) p = 1.0f - p;
      ui_render(render_open, &p);
      if (done) {
        /* The exact end: the destination drawn as itself. The last composited
         * frame is a pixel short of it - the ease does not land on 1.0 to the
         * pixel - and going back the destination has never been drawn at all. */
        ui_render(render_screen, NULL);
        anim_report(s_anim.opening ? "open move" : "back move");
        s_anim.kind = ANIM_NONE;
      }
      return 0;
    }

    case ANIM_CASCADE: {
      float p = t;
      ui_render(render_cascade, &p);
      if (done) {
        ui_render(render_screen, NULL);
        anim_report("menu cascade");
        s_anim.kind = ANIM_NONE;
        boot_bench();
        first_start_note();
      }
      return 0;
    }

    default:
      s_anim.kind = ANIM_NONE;
      return 0;
  }
}

/**
 * The boot sequence: the disc, the bloom, the name.
 *
 * Starts it; anim_tick() runs it. It used to run here, in three loops that
 * owned the UI task for 2.1 seconds and presented 119 frames into a Twin that
 * can hold 40 of them.
 */
static void splash(void) { anim_start_splash(); }

/**
 * Power off: the screen letting go.
 *
 * The four go out one at a time, in the order they came up, and then the
 * panel does. The inverse of the boot in the same vocabulary, which is the
 * only thing a shutdown owes anybody.
 */
static void power_down_anim(void) {
  /*
   * The mark, and then the screen letting go of it.
   *
   * It used to put the four-cell mark up and take the cells out one at a
   * time, which is a sentence about the four cameras - the right thing to say
   * while a capture is happening and the wrong thing to say while the camera
   * is switching off. What is leaving is the camera, so the camera's own mark
   * is what is on the screen, and then it is not.
   */
  ui_render(render_mark, NULL);
  vTaskDelay(pdMS_TO_TICKS(520));

  /* Out through the ground rather than to black in one step: the panel's
   * backlight is still on for a moment after this returns, and a hard cut
   * leaves it showing an empty lit rectangle. */
  for (int i = 1; i <= 7; i++) {
    int k = i * 255 / 7;
    ui_render(render_mark_fade, &k);
    vTaskDelay(pdMS_TO_TICKS(55));
  }
  ui_render(render_black, NULL);
  vTaskDelay(pdMS_TO_TICKS(140));
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

/* PREV and NEXT are header system buttons in the cluster beside Back, on the
 * hand's side of the bar - hd_prev_x() and hd_next_x(), declared with the
 * rest of the header geometry, because draw_header() has to keep its own
 * readings clear of them and a constant two thousand lines away is one
 * nobody checks. */

/** Whether this screen's header carries the page pair. */
static bool hd_paging(screen_t s) { return s == SCR_GALLERY && gallery_pages() > 1; }

/** How much of the bar the button cluster takes, plate gap included. */
static int hd_cluster_w(screen_t s) {
  return HD_BTN_W + HD_BTN_GAP + (hd_paging(s) ? 2 * HD_BTN_W + G_PG_GAP + HD_BTN_GAP : 0);
}

/*
 * What the camera is running on and what it has left, at the right end of
 * whatever bar the screen has.
 *
 * This used to be on two screens out of six - the menu's status bar, and half
 * of it on the viewfinder's. A body whose power source and remaining card are
 * invisible for as long as someone is browsing photographs is a body they
 * cannot plan around, and both readings cost a snprintf, so they belong on
 * every screen rather than on the two that happened to have a bar for them.
 *
 * There is no fuel gauge on this board. This says where the power is coming
 * from and never how much is left: a percentage here would be invented, which
 * is the same rule the menu's status bar has always followed.
 *
 * Returns the left edge of what it drew, so a caller with something else on
 * the same line can end before it.
 */
/*
 * The header bar's rhythm, and why it is two numbers and not four.
 *
 * Measured on the gallery, the bar held six readings separated by gaps of 14,
 * 34, 39 and 22 px - while the gap between two WORDS of one reading is 10.
 * A 14 px separator is four pixels wider than a word space, so "GALLERY" and
 * "2 OF 3" read as one phrase and the whole bar collapsed into a single run
 * of type nobody could parse.
 *
 * Two gaps, and they have to be far enough apart to be told apart at arm's
 * length: readings inside a group are one space, groups are another, and
 * nothing else on the bar is spaced by eye.
 */
#define BAR_READ_GAP 26 /* between two readings of the same group */
#define BAR_GROUP_GAP 40 /* between the title and the readings */

/**
 * The readout: everything on the right of the header bar, laid by one
 * function at one rhythm.
 *
 * Five readings can want this space - the screen's own (the gallery's count),
 * a condition chip, how much card is left, where the power comes from, and
 * whatever the screen wants nearest its right edge (the gallery's page
 * position) - and on a 622 px plate beside a 170 px title they do not all
 * fit. Two things follow, and neither is optional.
 *
 * **They are laid on one rhythm.** Measured before this existed, the bar's
 * separators were 14, 34, 39 and 22 px while the gap between two WORDS of one
 * reading is 10. A 14 px separator is four pixels wider than a word space, so
 * the title and the reading beside it read as a single phrase and the whole
 * bar collapsed into a run of type nobody could parse.
 *
 * **They are dropped by importance, not by position.** The first version laid
 * them right to left and dropped whatever it reached when it ran out of room,
 * which meant the gallery lost its photograph count - the one reading that
 * screen exists to show - because the count happened to be laid last, and by
 * two pixels. Everything is measured first, kept in priority order, and only
 * then placed:
 *
 *   1 the condition chip   the only reading a person has to act on
 *   2 the screen's own     what you came to this screen to see
 *   3 the card             how many photographs are left
 *   4 the page position    where you are in what you are looking at
 *   5 the power source     true, and the least urgent thing on the bar
 *
 * Returns the group's left edge, so the screen can keep its title clear of it.
 */
static int chrome_state(int left, int right, int y, uint16_t ink, const char *first,
                        const char *last) {
  storage_status_t sd;
  storage_get_status(&sd);
  char card[24];
  if (!sd.mounted) snprintf(card, sizeof card, "NO CARD");
  else snprintf(card, sizeof card, "%d LEFT", (int)(sd.free_bytes / (6ull * 1024 * 1024)));
  const char *const pwr = usb_attached() ? "USB" : "BATTERY";

  /* The chip exists only when a condition does, so an unmarked bar means a
   * camera with nothing to say - which is the reading that has to be
   * trustworthy for the mark to be worth anything. It is not a target: the
   * whole band goes back on every screen that has one, and a control inside a
   * band that does something else is how a user learns to trust neither. The
   * route is SETTINGS, which lists them. */
  /* The severity as a word, then the count: "WARN 2". It was a coloured dot
   * beside the count, and on the title plate the yellow dot measured 1.3:1 -
   * a warning nobody could see, saying which kind it was in a colour alone.
   * The word is set in the plate's own ink like everything else on it. */
  const int cond_n = conditions_count();
  char cnt[16];
  snprintf(cnt, sizeof cnt, "%s %d", sev_word(conditions_worst()), cond_n);

  /* Spatial order, left to right, with the priority each one is kept by. */
  struct {
    const char *s;
    int prio;
    bool keep;
    int w;
  } it[5] = {
      {last, 2, false, 0},  {NULL, 1, false, 0}, {card, 3, false, 0},
      {pwr, 5, false, 0},   {first, 4, false, 0},
  };
  it[1].s = cond_n > 0 ? cnt : NULL;

  for (int i = 0; i < 5; i++) {
    if (it[i].s == NULL || it[i].s[0] == '\0') continue;
    it[i].w = text_w(&UI_FONT_T, it[i].s);
  }

  /* Keep what fits, most important first. */
  int used = 0, kept = 0;
  for (int p = 1; p <= 5; p++) {
    for (int i = 0; i < 5; i++) {
      if (it[i].prio != p || it[i].w == 0) continue;
      const int need = it[i].w + (kept > 0 ? BAR_READ_GAP : 0);
      if (used + need > right - left) continue;
      used += need;
      kept++;
      it[i].keep = true;
    }
  }

  /* And place them, right to left, in spatial order. */
  int x = right;
  for (int i = 4; i >= 0; i--) {
    if (!it[i].keep) continue;
    x -= it[i].w;
    text(&UI_FONT_T, x, y, it[i].s, ink);
    x -= BAR_READ_GAP;
  }
  return kept > 0 ? x + BAR_READ_GAP : right;
}

/**
 * Where the caption plate ends.
 *
 * The gallery puts two page buttons at the bar's right end, so on that screen
 * the plate stops short of them. It used to be drawn full width and then have
 * a rectangle of the page's own colour painted back over its right end - a
 * square patch cut into a rounded plate, which left the one surface on every
 * screen with a hard-cut edge in a product where every other surface has the
 * same corner. Patching a shape to the size you wanted is a habit from an
 * interface made of rectangles; here the plate is simply drawn at the width
 * it needs.
 */
/* The plate takes whatever the button cluster leaves, on the far side. */
static int hd_plate_x(screen_t s) { return s_right_hand ? PAGE_M : PAGE_M + hd_cluster_w(s); }
static int hd_plate_right(screen_t s) {
  return s_right_hand ? UI_W - PAGE_M - hd_cluster_w(s) : UI_W - PAGE_M;
}

/** Where chrome_state() ends on a header screen: just short of the buttons. */
static int head_state_right(screen_t s) { return hd_plate_right(s) - 4; }

/* Where the header's state reading starts, for a screen with its own line of
 * text on the same plate. Set by every draw_header(); read by the gallery. */
static int s_head_state_left;
/* What the screen wants at the two ends of the readout group, set before
 * draw_header() runs - it lays the whole group and nothing else may. */
static char s_head_first[24];
static char s_head_last[32];


static void draw_header(screen_t s) {
  fill(0, 0, UI_W, HEAD_H, W_FACE);

  /* No plate. The screen's name sits on the ground in the menu card's
   * colour, the readings beside it in the quiet ink, and one hairline under
   * the whole band separates the header from the page. The plate was the
   * brightest object on every screen and it carried one word. */
  const int cap_x = hd_plate_x(s);
  fill(PAGE_M, HEAD_H - 2, UI_W - 2 * PAGE_M, 1, W_RULE);

  /* Back, as a system button on the hand's side. The mark is back_glyph(),
   * which is the same chevron a row that opens a screen carries, at the scale
   * a system button wants and pointing the other way - so the two read as one
   * family. */
  const bool down = s_pressed == IT_BACK;
  const int d = down ? 1 : 0;
  const int bx = hd_btn_x();
  button(bx, HD_BTN_Y, HD_BTN_W, HD_BTN, down);
  back_glyph(bx + HD_BTN_W / 2 + d, HD_BTN_Y + HD_BTN / 2 + d, W_TEXT);
  /* Nothing sets focus to IT_BACK today - touch deliberately does not, and
   * there are no direction keys on this body - but the button is a focusable
   * control the moment there are, and a header that cannot show focus is the
   * one place a d-pad would strand a user. Two comparisons per header. */
  if (foc(s, IT_BACK)) focus_inset(bx, HD_BTN_Y, HD_BTN_W, HD_BTN, W_TEXT);

  const char *name = SCREEN_NAME[s];
  if (name != NULL) {
    text(&UI_FONT_L, cap_x + 2, HD_CAP_Y + (HD_CAP_H - UI_FONT_L.line_h) / 2, name, W_TITLE);
  }
  s_head_state_left = chrome_state(
      cap_x + 2 + (name != NULL ? text_w(&UI_FONT_L, name) : 0) + BAR_GROUP_GAP,
      head_state_right(s), HD_CAP_Y + (HD_CAP_H - UI_FONT_T.line_h) / 2, W_GRAYTEXT,
      s == SCR_GALLERY ? s_head_first : NULL, s == SCR_GALLERY ? s_head_last : NULL);
}

/** A reading, set into the page. Flat: a recess is a darker field now, not a
 *  groove, because there are no grooves left anywhere else. */
static void status_panel(int x, int y, int w, int h) {
  round_rect(x, y, w, h, UI_R, W_WINDOW);
}

/**
 * A group: a caption, and the field it names.
 *
 * The screens carried bare captions - MODE, FLASH, VOLUME, CAM IDLE - set
 * above controls with no container at all, which is the half-finished look:
 * the words belong to the control under them and nothing said so. This was an
 * etched frame with the legend cut into its top edge, which is the 1998
 * answer and a good one; with no bevels left in the product the frame has
 * nothing to be etched into, so the caption sits above a flat field instead.
 *
 * The caption is the technical role and is set in the face that carries every
 * technical role on the interface. `note` is the right-hand half of the same
 * line - "Both modes capture four frames", a list position - and stays in the
 * reading face, because it is a remark and not a name.
 *
 * `ink` is the caption's, for exactly one caller: the BRIGHTNESS group on
 * DISPLAY names a setting this body does not have and has said so in grey
 * since it was written. A full-strength caption over a grey sentence would
 * put the two halves of that statement in different voices.
 */
static void group_box(int x, int y, int w, int h, const char *legend, uint16_t ink,
                      const char *note) {
  const int cap_h = (legend != NULL || note != NULL) ? UI_FONT_T.line_h + 4 : 0;
  round_rect(x, y + cap_h, w, h - cap_h, UI_R, W_WINDOW);
  if (legend != NULL) text(&UI_FONT_T, x + 10, y, legend, ink);
  if (note != NULL) text_right(&UI_FONT_S, x + w - 10, y - 2, note, W_GRAYTEXT);
}


/**
 * A row of a list, and every list on the product is made of these.
 *
 *   01   DISPLAY
 *        2 min                                                            >
 *
 * Three pieces of information in three voices: a position, a name, and what
 * the name is currently set to. The version before this was one line with the
 * name at the left and the value pushed to the right edge, half a screen
 * away, which is a table of two columns rather than a list of things - at
 * arm's length the eye had to cross the panel and come back to read one
 * setting. It is also the layout that collided the moment the typeface
 * changed, because "does the value reach the title" was never checked, only
 * observed to be true of the face it was drawn in.
 *
 * `idx` is the row's position, which chooses its tone: the rows step darker
 * down the list, so a list has a top. `numbered` prints that position as
 * well - a settings list is a set of destinations and the number helps; a
 * read-only table has positions but nobody counts them.
 *
 * A row shorter than two lines falls back to one, with the value measured
 * against the title and truncated rather than drawn through it. That is the
 * narrow second column on ABOUT, and the fallback exists so that a layout
 * this primitive cannot honour degrades to a legible row instead of an
 * illegible one.
 */
static void draw_row_face(int x, int w, int y, int h, int idx, bool numbered, bool focused,
                          bool pressed, bool enabled, const char *title, const char *value,
                          bool arrow, uint16_t override) {
  /*
   * A press changes the face; focus only adds the ring.
   *
   * They were the same thing - `focused || pressed` filled the row with the
   * accent - which meant the confirm dialog opened with CANCEL painted as the
   * brightest object on the panel, because focus starts there. A row that is
   * merely where the keyboard is must not look like the row that is about to
   * happen, and on a destructive question that is not a style point.
   */
  const uint16_t face = pressed ? W_SEL : (override != 0 ? override : W_ROW);
  const bool lit = pressed;
  round_rect(x, y, w, h, UI_R, face);

  /* The second voice, measured against the row's OWN tone rather than set to
   * a fixed grey. The ramp runs from a light terracotta to a near-black one
   * and one grey cannot be the quiet version of both: at the top of the list
   * it disappeared into the card. dim_ink() finds the quietest mix that still
   * clears 4.5:1 on this face, so the value on row one reads like the value
   * on row six.
   *
   * A disabled row is set entirely in that voice. It was W_GRAYTEXT, a grey
   * chosen for the dark face, and on the terracotta of the top row it measured
   * 1.5:1 - SHUT DOWN's "Hold the power slide" was the one instruction on the
   * POWER screen and nobody could read it. Quieter than a live row, legible,
   * and still without the chevron a live row carries. */
  const uint16_t dim = lit ? W_SELTEXT : dim_ink(W_TEXT, face);
  const uint16_t ink = lit ? W_SELTEXT : (enabled ? W_TEXT : dim);

  int tx = x + 18;
  /* The position, only where a key could address it. There is no keypad on
   * this body - BTN_FN has no pin - and the segmented rows already dropped
   * their numbers for that reason (draw_segments); the lists kept theirs, in
   * a dim ink that failed contrast on four rows of six. Same gate, same day
   * they come back. */
  if (numbered && UI_FOCUS_VISIBLE) {
    char n[8];
    snprintf(n, sizeof n, "%02d", idx + 1);
    text(&UI_FONT_T, tx, y + 12, n, dim);
    tx += 34;
  }

  const bool has_value = value != NULL && value[0] != '\0';
  const int right = x + w - 18 - (arrow ? 26 : 0);

  char name[48];
  snprintf(name, sizeof name, "%s", title);
  upcase(name);

  if (h >= 50) {
    /* Two lines: the name, and under it what it is set to. */
    if (has_value) {
      text(&UI_FONT_R, tx, y + 6, name, ink);
      char v[48];
      text_fit(v, sizeof v, &UI_FONT_S, value, right - tx);
      text(&UI_FONT_S, tx, y + 6 + UI_FONT_R.line_h - 4, v, dim);
    } else {
      text(&UI_FONT_R, tx, y + (h - UI_FONT_R.line_h) / 2, name, ink);
    }
  } else {
    /* One line. The value gets whatever the name leaves, and is cut to it. */
    const int ty = y + (h - UI_FONT_M.line_h) / 2;
    text(&UI_FONT_M, tx, ty, name, ink);
    if (has_value) {
      const int room = right - (tx + text_w(&UI_FONT_M, name) + 16);
      if (room > 24) {
        char v[48];
        text_fit(v, sizeof v, &UI_FONT_S, value, room);
        text_right(&UI_FONT_S, right, y + (h - UI_FONT_S.line_h) / 2, v, dim);
      }
    }
  }

  if (arrow) picker_arrow(x + w - 22, y + h / 2, true, ink);
  if (focused) focus_inset(x, y, w, h, W_SELTEXT);
}

/* The common case: a row in its list's own tone. */
static void draw_row_at(int x, int w, int y, int h, int idx, bool numbered, bool focused,
                        bool pressed, bool enabled, const char *title, const char *value,
                        bool arrow) {
  draw_row_face(x, w, y, h, idx, numbered, focused, pressed, enabled, title, value, arrow, 0);
}

/* The standard full-width row, which is what every screen but About draws.
 *
 * The dead `value_ink` parameter eleven call sites were passing is gone, and
 * `pressed` took its place: the row picks its own inks from `focused` and
 * `enabled` and always did, but it had no way at all to know a finger was on
 * it. Same arity, and every call site had to be visited to say which item
 * index it draws - which is the point, because that is the line where a row's
 * drawing and its hit rectangle agree or do not. */
/* The full-width row of a list screen: the common case, at the list's own
 * pitch, numbered by its position. */
static void draw_row(int i, bool focused, bool pressed, bool enabled, const char *title,
                     const char *value, bool arrow) {
  draw_row_at(LIST_X, LIST_W, LIST_Y + i * ROW_H, ROW_H - ROW_GAP, i, true, focused, pressed,
              enabled, title, value, arrow);
}

/**
 * A fact: a name and its value, and no surface under them.
 *
 * ABOUT, CONNECTION and the top of STORAGE are tables of things the camera
 * knows, and they were drawn as the same slabs a settings list is made of -
 * so a value nobody can press looked exactly like a row that opens a screen.
 * A fact is a quiet caption on the left, the value on the right in the
 * reading face, and a hairline to the next one. Nothing about it says press.
 */
static void fact_row(int x, int w, int y, int h, const char *title, const char *value,
                     bool enabled, bool last) {
  char name[48];
  snprintf(name, sizeof name, "%s", title);
  upcase(name);
  text(&UI_FONT_T, x + 4, y + (h - UI_FONT_T.line_h) / 2, name, W_GRAYTEXT);
  if (value != NULL && value[0] != '\0') {
    const int room = w - 8 - text_w(&UI_FONT_T, name) - 16;
    char v[64];
    text_fit(v, sizeof v, &UI_FONT_M, value, room > 24 ? room : 24);
    text_right(&UI_FONT_M, x + w - 4, y + (h - UI_FONT_M.line_h) / 2, v,
               enabled ? W_TEXT : W_GRAYTEXT);
  }
  if (!last) fill(x, y + h - 1, w, 1, W_RULE);
}

/* The window a list sits in: face ground, sunken white well. */
/* The body behind a list. The rows are separate cards and carry their own
 * ground, so there is nothing to put them in any more. */
static void draw_list_frame(int rows) {
  (void)rows;
  fill(0, BODY_Y, UI_W, UI_H - BODY_Y, W_FACE);
}

/* An on/off pill, the era's answer to a toggle: a recessed well with the live
 * state written in it, not a sliding lozenge. */
/**
 * On or off, as a switch.
 *
 * A tick in a sunken box was the 1998 answer and a good one; with no sunken
 * boxes left it has nothing to sit in, and a tick drawn on a terracotta row
 * reads as a mark rather than as a state. A track with the knob at one end is
 * legible at arm's length by its shape alone - which side the knob is on -
 * before the colour is read at all, and colour is the thing a dark room takes
 * away first.
 */
static void draw_toggle(int x, int y, bool on, bool focused, uint16_t ground) {
  const int w = 52, h = 28, r = h / 2;
  round_rect(x, y, w, h, r, on ? W_SEL : W_PRESS);
  /* Off is a dark track on a dark row: 1.4:1 without an edge. The edge is
   * what makes it a control rather than a shadow, in whichever ink the row
   * it sits on can show. */
  if (!on) round_outline(x, y, w, h, r, edge_ink(ground));
  disc(on ? x + w - r : x + r, y + r, (float)r - 4.0f, on ? W_SELTEXT : W_TEXT);
  if (focused) focus_ring(x - 3, y - 3, w + 6, h + 6, (h + 6) / 2, W_TEXT);
}

/* A segmented selector: every option visible, the live one filled. */
/*
 * A row of positions, one of them live.
 *
 * Two things changed here and both of them run through every segmented
 * control the camera has, which is what makes this one function worth
 * touching rather than six screens.
 *
 * THE LIVE ONE IS THE ACCENT. It was drawn pushed in with a lighter face -
 * the 1998 toolbar's toggled button - and on a row of three that is a
 * difference of about ten per cent of a grey. On the DISPLAY screen, four
 * rows of it, you had to hunt for which timeout the camera was actually set
 * to. Selection on this interface already has a colour: every list row on
 * every screen is navy with the type knocked out of it. A row of segments is
 * a list laid sideways, so it gets the same treatment, and the answer to
 * "which one is it" is now the only coloured thing in the group.
 *
 * THE POSITIONS ARE NUMBERED. A small index in each segment's corner, so a
 * setting is a position you learn rather than a word you read: DIM AFTER is
 * 2, AFTER SHOT is 3. It costs eleven pixels in a corner that was empty, it
 * gives the camera the same vocabulary its four lenses already speak in, and
 * it is what a numbered keypad would address the day this body has one.
 */
static void draw_segments(int x, int y, int w, int h, const char *const *names, int count,
                          int selected, int pressed_idx, int focus_idx) {
  /* One track with a pill in it, rather than a row of separate buttons.
   * Three buttons side by side is three things to choose between; a track
   * with one filled position is one setting with three values, which is what
   * every one of these actually is. */
  round_rect(x, y, w, h, UI_R, W_WINDOW);
  /* The track's edge, at the contrast a control's boundary needs: W_WINDOW
   * on W_FACE is 1.07:1, so without it the unselected positions were words
   * floating on the page. */
  round_outline(x, y, w, h, UI_R, W_KEYLINE);

  const int cw = w / count;
  for (int i = 0; i < count; i++) {
    const int bx = x + i * cw;
    const bool on = i == selected;
    if (on) round_rect(bx + 2, y + 2, cw - 4, h - 4, UI_R - 2, W_SEL);
    else if (pressed_idx == i) round_rect(bx + 2, y + 2, cw - 4, h - 4, UI_R - 2, W_PRESS);
    const uint16_t ink = on ? W_SELTEXT : W_TEXT;
    text_mid(&UI_FONT_M, bx + cw / 2, y + (h - UI_FONT_M.line_h) / 2, names[i], ink);
    /*
     * The position number, for the keypad that would jump to it.
     *
     * There is no keypad - BTN_FN has no pin - so the numbers are the focus
     * ring's problem in a second form: a mark for an input nobody has. They
     * also collided outright the moment a segmented track got narrower than
     * the full panel, printing a "1" through the first letter of AUTO. Gated
     * on the same switch the ring is, and back the day that pin exists.
     */
    if (UI_FOCUS_VISIBLE) {
      char idx[16];
      snprintf(idx, sizeof idx, "%d", i + 1);
      text(&UI_FONT_S, bx + 10, y + 5, idx, on ? W_SELTEXT : W_GRAYTEXT);
    }
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


static void human_bytes(char *out, size_t n, uint64_t bytes) {
  if (bytes >= (1024ULL * 1024 * 1024))
    snprintf(out, n, "%llu.%llu GB", bytes / (1024ULL * 1024 * 1024),
             (bytes % (1024ULL * 1024 * 1024)) / (107374182ULL));
  else snprintf(out, n, "%llu MB", bytes / (1024ULL * 1024));
}

/* ------------------------------------------------------------------ */
/* Main menu                                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* The menu as a stack                                                  */
/*
 * One card and five rows, not six equal tiles.
 *
 * Six peers in a grid is a desktop metaphor and it has been wrong since the
 * product split in two: the camera is not a sibling of SETTINGS. The stack
 * says the hierarchy with geometry instead of with navigation - SHOOT is a
 * card four times the height of anything else, and the rest are a list under
 * it. Nothing about where a press goes changed; one tap still opens.
 *
 * The palette and the shapes are a revision, and the only one in the tree:
 * near-black ground, one warm accent carrying the one thing that matters,
 * deep green rows darkening as they descend, and a corner radius. The rest of
 * the interface is still the utility shell.
 */
/*
 * Two columns, and which is which is the hand's.
 *
 * The stack was one card over five rows, all full width, and the card - the
 * one thing on the screen the shooting hand wants - was as far from the thumb
 * as the rows were. Now the card takes the hand's half of the panel at the
 * panel's full height, and the five rows are a column on the far side, 84 px
 * each: 9.9 mm, which is a target the other hand cannot miss either.
 */
#define MZ_M PAGE_M                 /* the margin round the stack */
#define MZ_PAD 24                   /* the one left rule, and the right one */
#define MZ_GAP 7
#define MZ_COL_GAP 12
#define MZ_ROW_W 352
#define MZ_W (UI_W - 2 * MZ_M)
#define MZ_CARD_W (MZ_W - MZ_ROW_W - MZ_COL_GAP)   /* 404 */
#define MZ_CARD_H (UI_H - 2 * MZ_M)                /* 448 */
#define MZ_ROW_H ((MZ_CARD_H - 4 * MZ_GAP) / 5)     /* 84 */
#define MZ_ROW_Y(i) (MZ_M + ((i) - 1) * (MZ_ROW_H + MZ_GAP))
_Static_assert(5 * MZ_ROW_H + 4 * MZ_GAP == MZ_CARD_H, "the five rows do not fill the card's height");

static int mz_card_x(void) { return from_hand(MZ_M, MZ_CARD_W); }
static int mz_rows_x(void) { return s_right_hand ? MZ_M : UI_W - MZ_M - MZ_ROW_W; }

/** Where item `i` of the menu is. One function, so the drawing and the finger
 *  cannot disagree - which they did, the last time this screen moved. */
static void menu_rect(int i, int *x, int *y, int *w, int *h) {
  if (i <= 0) {
    *x = mz_card_x();
    *y = MZ_M;
    *w = MZ_CARD_W;
    *h = MZ_CARD_H;
  } else {
    *x = mz_rows_x();
    *y = MZ_ROW_Y(i);
    *w = MZ_ROW_W;
    *h = MZ_ROW_H;
  }
}

/**
 * The menu arriving.
 *
 * Six rows landing one after another, over a ground that is already there.
 * The difference between this and a fade is that a fade shows you a picture
 * of a menu and this shows you six things being put down, which is what they
 * are - the card is not a heading and the rows are not a texture.
 *
 * Only used where the menu turns up with nothing behind it: after the splash.
 * Coming back from a screen it folds into the row you left from instead, and
 * two answers to the same question would be one too many.
 */



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
/* The face of one menu item, at any rectangle. Drawn from the rect rather
 * than from its home position so the same code paints the menu and paints it
 * mid-move. */
static uint16_t menu_face(int i, bool down) {
  /*
   * Each row a step darker than the one above it: a stack seen edge-on, and
   * the reason the eye starts at the top and not in the middle.
   *
   * The ramp has a floor, and finding it was the point. The first one ran to
   * 0B1A15 against a 0B0D0C ground - measured, that is a summed channel
   * distance of 20 where the top row has 129, so the bottom two rows had
   * essentially no container and the list appeared to fade out through the
   * foot of the panel. A stack of five cards has to still be five cards at
   * the bottom of it; the step is smaller now and it stops well clear of the
   * page.
   */
  static const uint16_t ROW[5] = {
      RGB(0x1e, 0x52, 0x40), RGB(0x1a, 0x49, 0x38), RGB(0x16, 0x40, 0x31),
      RGB(0x13, 0x38, 0x2a), RGB(0x10, 0x30, 0x24),
  };
  if (i == 0) return down ? MZ_CARD_DOWN : MZ_CARD;
  return down ? MZ_ACCENT : ROW[i - 1];
}

/* What the camera has, in the place the reference puts its status. */
static void menu_card_line(char *out, size_t cap) {
  storage_status_t sd;
  storage_get_status(&sd);
  const cond_t *worst = conditions_at(0);
  if (worst != NULL) snprintf(out, cap, "%s", worst->title);
  else if (!sd.mounted) snprintf(out, cap, "NO CARD");
  else snprintf(out, cap, "CAMERA  %d LEFT", (int)(sd.free_bytes / (6ull * 1024 * 1024)));
  upcase(out);
}


/**
 * The six marks, drawn rather than sourced.
 *
 * The reference carries a small pictogram beside each row and this menu had
 * none, because the icons it used to have were Windows 98 tile artwork drawn
 * for a 250 x 205 tile - at a 50 px row they were twice the height of the row,
 * and scaling tile art down is not a pictogram, it is a smaller mess. So they
 * are drawn here out of the same primitives every other shape on the screen
 * uses: a filled rectangle, a disc, a stroke. No file, no licence, nothing to
 * bake, and they inherit the antialiasing the rest of the interface has.
 *
 * One construction rule, which is what makes six drawings read as one set: a
 * 22 px box, a 2.5 px stroke, and every mark built from the product's own
 * vocabulary rather than from a picture of the thing it names. LOOK is the
 * four frames with one of them picked; GALLERY is the four as a grid; ROLL is
 * two rings, the party and its guests; SETTINGS is three tracks with their
 * knobs at different positions, which is what every screen behind that row
 * actually looks like; POWER is the power mark.
 */
#define MZ_ICON 22

static void menu_icon(int i, int cx, int cy, uint16_t ink) {
  const float k = 2.5f;
  const int r = MZ_ICON / 2;
  switch (i) {
    case 1: { /* LOOK: the four, one of them chosen */
      const int c = 9, g = 3;
      for (int n = 0; n < 4; n++) {
        const int bx = cx - c - g / 2 + (n % 2) * (c + g);
        const int by = cy - c - g / 2 + (n / 2) * (c + g);
        if (n == 1) fill(bx, by, c, c, ink);
        else round_outline(bx, by, c, c, 2, ink);
      }
      break;
    }
    case 2: { /* GALLERY: the four, all of them */
      const int c = 9, g = 3;
      for (int n = 0; n < 4; n++) {
        fill(cx - c - g / 2 + (n % 2) * (c + g), cy - c - g / 2 + (n / 2) * (c + g), c, c, ink);
      }
      break;
    }
    case 3: { /* ROLL: two rings, overlapping */
      ring(cx - 4, cy, 7.0f, k - 0.5f, ink);
      ring(cx + 4, cy, 7.0f, k - 0.5f, ink);
      break;
    }
    case 4: { /* SETTINGS: three tracks, three knobs */
      for (int n = 0; n < 3; n++) {
        const int ty = cy - 7 + n * 7;
        stroke((float)(cx - r + 2), (float)ty, (float)(cx + r - 2), (float)ty, k - 0.7f, ink);
        disc(cx - r + 6 + n * 5, ty, 2.6f, ink);
      }
      break;
    }
    default: { /* POWER: the mark everything uses */
      /* The arc ran 60..480 degrees in 6-degree strokes: a full ring, with the
       * first sixty degrees drawn twice. One ring says the same thing. */
      ring(cx, cy + 1, 8.0f, k, ink);
      stroke((float)cx, (float)(cy - 10), (float)cx, (float)(cy + 1), k, ink);
      break;
    }
  }
}

/**
 * Everything on a menu item but its face, in one ink.
 *
 * Split from menu_item() so a move can draw the touched item's words over the
 * growing card in an ink that fades with the wash: the label dissolves into
 * the screen arriving under it instead of vanishing on the first frame.
 */
static void menu_words(int i, int x, int y, int w, int h, uint16_t ink, bool with_word) {
  /* One left rule and one right rule for everything on this screen. Three
   * left edges and two right ones is what it had, and a 10 px disagreement
   * between the card's type and the rows' type is visible at arm's length as
   * a wobble down the page. */
  const int lx = x + MZ_PAD;
  const int rx = x + w - MZ_PAD;

  if (i == 0) {
    char line[64];
    menu_card_line(line, sizeof line);
    /* The state line carries the severity mark the header and the settings
     * list both carry. It was set in the card's own ink beside "TAP TO OPEN",
     * so a fault and an instruction were in identical voices. */
    /* As a word, not a dot: "WARN  THE DATE IS NOT SET". The dot was the
     * severity in colour alone, and yellow on this card measured 1.3:1. */
    const cond_t *worst = conditions_at(0);
    int tx = lx;
    if (worst != NULL) {
      const char *sw = sev_word(worst->sev);
      text(&UI_FONT_T, tx, y + 18, sw, ink);
      tx += text_w(&UI_FONT_T, sw) + 14;
    }
    /* Cut to the card's own right rule. The card is half the panel now, and
     * a condition title is written for a full-width row. */
    char fitted[64];
    text_fit(fitted, sizeof fitted, &UI_FONT_T, line, rx - tx);
    text(&UI_FONT_T, tx, y + 18, fitted, ink);

    /* The four, large, in the card's upper middle: the card is the panel's
     * full height now and the mark is the one thing on it that can carry
     * that much room without becoming a headline. */
    const int cell = 56, gap = 12;
    const int mw = 2 * cell + gap;
    const int mx = x + (w - mw) / 2;
    const int my = y + 18 + UI_FONT_T.line_h + 52;
    for (int k = 0; k < 4; k++) {
      fill(mx + (k % 2) * (cell + gap), my + (k / 2) * (cell + gap), cell, cell, ink);
    }

    text(&UI_FONT_T, lx, y + h - 18 - UI_FONT_T.line_h, "TAP TO OPEN", ink);
  } else {
    menu_icon(i, lx + MZ_ICON / 2, y + h / 2, ink);
    /* A chevron, because every row here opens a screen and a row that opens a
     * screen carries one everywhere else in the product. The menu was the one
     * list without them, which is the inconsistency rather than the
     * restraint. */
    picker_arrow(rx - 3, y + h / 2, true, ink);

    if (MENU_DEST[i] == SCR_GALLERY) {
      /* The count, in the face every other reading on the interface is set
       * in, clear of the chevron. */
      const int n = gallery_media_count();
      if (n >= 0) {
        char c[16];
        snprintf(c, sizeof c, "%d", n);
        text_right(&UI_FONT_T, rx - 26, y + (h - UI_FONT_T.line_h) / 2, c, ink);
      }
    }
  }

  if (!with_word) return;
  /*
   * No artwork beside the word. The reference carries a 16 px pictogram; this
   * body's icons were the old tile artwork, drawn for a 250 x 205 tile, and at
   * a 50 px row they were twice the height of the row. Scaling tile art down
   * is not a pictogram, it is a smaller mess - and it is gone with everything
   * else that was baked. The word is the control.
   */
  /* The word at the card's foot, over TAP TO OPEN: the reference anchors a
   * card's content to its bottom-left and leaves the air above. */
  if (i == 0)
    text_ink(&UI_FONT_XL, lx, y + h - 18 - UI_FONT_T.line_h - 6 - UI_FONT_XL.line_h, MENU_LABEL[0],
             ink);
  else text_ink(&UI_FONT_M, lx + MZ_ICON + 18, y + (h - UI_FONT_M.line_h) / 2, MENU_LABEL[i], ink);
}

/** The ink an item's words are set in, on its face, pressed or not. */
static uint16_t menu_ink(int i, bool down) {
  return i == 0 ? MZ_CARD_INK : (down ? MZ_GROUND : MZ_MINT);
}

static void menu_item(int i, int x, int y, int w, int h, bool down, bool with_word) {
  round_rect(x, y, w, h, UI_R, menu_face(i, down));
  menu_words(i, x, y, w, h, menu_ink(i, down), with_word);
}

static void draw_menu(void) {
  fill(0, 0, UI_W, UI_H, MZ_GROUND);
  for (int i = 0; i < 6; i++) {
    int x, y, w, h;
    menu_rect(i, &x, &y, &w, &h);
    menu_item(i, x, y, w, h, s_pressed == i, true);
  }
}


/* ------------------------------------------------------------------ */
/* Viewfinder                                                          */
/* ------------------------------------------------------------------ */

/* Two things you can touch on this screen: the way out, and the three
 * decisions on the status bar, which open LOOK. */
#define SH_IT_BACK 0
#define SH_IT_LOOK 1
/* Where the decisions group sits on the bar, set by the draw and read by the
 * hit test - the same rule as s_list_top. */
static int s_sh_set_x0, s_sh_set_x1;
/* LOOK opened from the finder goes back to the finder, not to the menu: the
 * hand that changed the flash is still holding the camera up. */
static bool s_look_from_shoot;

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
/*
 * The way out, at the header's own button origin.
 *
 * It used to be a 116x44 plate at 10,10 while every other screen put its back
 * button at HD_BTN_X, HD_BTN_Y as a 44 px square - so the one control that is
 * on every screen was in a different place and a different shape on this one,
 * which is the loudest way an interface says it was assembled rather than
 * designed. Origin and height now come from the header's constants; only the
 * width differs, because this button carries the word as well as the mark and
 * the viewfinder is the one screen with nothing else to say what it does.
 */
#define SH_BACK_Y HD_BTN_Y
#define SH_BACK_W 116
#define SH_BACK_H HD_BTN
static int sh_back_x(void) { return from_hand(PAGE_M, SH_BACK_W); }
#define SH_BAR_H 34    /* == M_STATUS_H: this is the menu's status bar */
#define SH_BAR_Y (UI_H - SH_BAR_H)
#define SH_PN_Y (SH_BAR_Y + 3)
#define SH_PN_H (SH_BAR_H - 6)
#define SH_PN_GAP 2    /* the face grey a Win98 status bar divides panels with */
#define SH_PN_PAD 10   /* text to panel edge, as on the menu's bar */

_Static_assert(SH_BACK_Y + SH_BACK_H < SH_BAR_Y, "the back button runs into the status bar");

/*
 * How long a pane waits before it says why it is empty.
 *
 * The pump starts on the pass that opens SHOOT, and the first frame is a
 * request over the link, a JPEG, and a decode away - several hundred
 * milliseconds on the camera, a few hundred in the Twin. For that long every
 * pane said NO CAMERA on a body whose four cameras were answering, and then
 * all four snapped to pictures at once: a false reading, then a hard cut.
 * A pane that has never had a frame now holds its ground for this long and
 * lets the picture arrive on black, which is what a camera does when it is
 * switched on. Only a pane that is still empty after the grace says why.
 * STALLED and ERROR are not waited out - those are real, and recent.
 */
#define SH_SETTLE_US (1500 * 1000)
static int64_t s_shoot_since_us;

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
  if (s_dl.rec) {
    dl_cmd_t *k = dl_push(DL_SHBLIT, px, py, px + SH_PANE_W, py + SH_PANE_H);
    if (k) { k->p = tile; k->a = px; k->b = py; }
    return;
  }
  if (!s_sh_map_built) sh_build_maps();
  const gfx_target_t *t = TG;
  int y0 = py < t->y0 ? t->y0 - py : 0, y1 = SH_PANE_H;
  if (py + y1 > CV_Y1(t)) y1 = CV_Y1(t) - py;
  int x0 = px < t->x0 ? t->x0 - px : 0, x1 = SH_PANE_W;
  if (px + x1 > CV_X1(t)) x1 = CV_X1(t) - px;
  if (y0 >= y1 || x0 >= x1) return;
  for (int y = y0; y < y1; y++) {
    const uint16_t *src = tile + (size_t)s_sh_ymap[y] * VF_W;
    uint16_t *dst = cv_ptr(t, px + x0, py + y);
    for (int x = x0; x < x1; x++) dst[x - x0] = src[s_sh_xmap[x]];
  }
}

/**
 * Rows of a picture into the target, clipped to its window. Every blit of
 * decoded pixels - a gallery tile, the photograph, a quad's quadrant - goes
 * through this so the clipping is written once.
 */
static void blit_rows(const uint16_t *src, int src_stride, int x, int y, int w, int h) {
  if (s_dl.rec) {
    dl_cmd_t *k = dl_push(DL_BLIT, x, y, x + w, y + h);
    if (k) { k->p = src; k->a = src_stride; k->b = x; k->c = y; k->d = w; k->e = h; }
    return;
  }
  const gfx_target_t *t = TG;
  int sx = 0, sy = 0;
  if (x < t->x0) { sx = t->x0 - x; w -= sx; x = t->x0; }
  if (y < t->y0) { sy = t->y0 - y; h -= sy; y = t->y0; }
  if (x + w > CV_X1(t)) w = CV_X1(t) - x;
  if (y + h > CV_Y1(t)) h = CV_Y1(t) - y;
  if (w <= 0 || h <= 0) return;
  for (int r = 0; r < h; r++) {
    memcpy(cv_ptr(t, x, y + r), src + (size_t)(sy + r) * (size_t)src_stride + sx,
           (size_t)w * sizeof(uint16_t));
  }
}

/* One recorded command, drawn for real through whatever the target is now. */
static void dl_exec(const dl_cmd_t *c) {
  switch (c->op) {
    case DL_FILL: fill(c->a, c->b, c->c, c->d, c->col); break;
    case DL_RRECT: round_rect(c->a, c->b, c->c, c->d, c->e, c->col); break;
    case DL_ROUTLINE: round_outline(c->a, c->b, c->c, c->d, c->e, c->col); break;
    case DL_CUT: cut_corners(c->a, c->b, c->c, c->d, c->f0, c->col); break;
    case DL_DISC: disc(c->a, c->b, c->f0, c->col); break;
    case DL_STROKE: stroke(c->f0, c->f1, c->f2, c->f3, c->f4, c->col); break;
    case DL_SCRIM: scrim(c->a, c->b, c->c, c->d, c->col, c->e); break;
    case DL_TEXT: text((const ui_font_t *)c->p, c->a, c->b, s_dl.str + c->g, c->col); break;
    case DL_ODD: oddjobs_mark(c->a, c->b, c->f0, c->col); break;
    case DL_FIELD: boot_field(c->f0, c->a, c->b, c->f1); break;
    case DL_SHBLIT: sh_blit((const uint16_t *)c->p, c->a, c->b); break;
    case DL_BLIT: blit_rows((const uint16_t *)c->p, c->a, c->b, c->c, c->d, c->e); break;
    case DL_BITS: draw_bits((const uint8_t *)c->p, c->a, c->b, c->c, c->d, c->e, c->g, c->col); break;
    case DL_FOCUS: focus_ring(c->a, c->b, c->c, c->d, c->e, c->col); break;
    case DL_RING: ring(c->a, c->b, c->f0, c->f1, c->col); break;
    default: break;
  }
}

/**
 * The tile pass's drawing function: every command whose box touches the
 * target, in order, through a view that puts the command's shift and clip
 * back the way they were when it was recorded.
 */
static void dl_replay(void *ctx) {
  (void)ctx;
  s_dl.play = true;
  const gfx_target_t *t = gfx_target();
  const int tx0 = t->x0, ty0 = t->y0, tx1 = CV_X1(t), ty1 = CV_Y1(t);
  /*
   * Nothing under the last thing that covers the whole tile is visible, so
   * the replay starts there. The ground every screen opens with, and the
   * ground under every card and well, used to be painted and painted over
   * in every tile: on the panel the fills were 6 ms of a 10 ms GALLERY frame.
   * A rounded rectangle covers the tile when the tile keeps clear of its
   * corner squares.
   */
  int start = 0;
  for (int i = s_dl.n - 1; i > 0; i--) {
    const dl_bb_t *b = &s_dl.bb[i];
    if (!b->opaque || b->x0 > tx0 || b->y0 > ty0 || b->x1 < tx1 || b->y1 < ty1) continue;
    if (b->r > 0 && !((b->x0 + b->r <= tx0 && b->x1 - b->r >= tx1) ||
                      (b->y0 + b->r <= ty0 && b->y1 - b->r >= ty1))) {
      continue;
    }
    start = i;
    break;
  }
  for (int i = start; i < s_dl.n; i++) {
    const dl_bb_t *bb = &s_dl.bb[i];
    if (bb->x1 <= tx0 || bb->x0 >= tx1 || bb->y1 <= ty0 || bb->y0 >= ty1) continue;
    const dl_cmd_t *c = &s_dl.cmd[i];
#if UI_DRAW_PROFILE
    const int64_t p0 = s_dl.prof ? esp_timer_get_time() : 0;
#endif
    if (c->sx == 0 && c->sy == 0 && c->cx0 <= tx0 && c->cy0 <= ty0 && c->cx1 >= tx1 &&
        c->cy1 >= ty1) {
      dl_exec(c);
#if UI_DRAW_PROFILE
      if (s_dl.prof) { s_dl.prof_us[c->op] += (uint32_t)(esp_timer_get_time() - p0); s_dl.prof_n[c->op]++; }
#endif
      continue;
    }
    const int x0 = c->cx0 > tx0 ? c->cx0 : tx0, y0 = c->cy0 > ty0 ? c->cy0 : ty0;
    const int x1 = c->cx1 < tx1 ? c->cx1 : tx1, y1 = c->cy1 < ty1 ? c->cy1 : ty1;
    if (x0 >= x1 || y0 >= y1) continue;
    const gfx_target_t view = {cv_ptr(t, x0, y0), x0 - c->sx, y0 - c->sy, x1 - x0, y1 - y0,
                               t->stride};
    gfx_target_view(&view);
    dl_exec(c);
    gfx_target_view(NULL);
#if UI_DRAW_PROFILE
    if (s_dl.prof) { s_dl.prof_us[c->op] += (uint32_t)(esp_timer_get_time() - p0); s_dl.prof_n[c->op]++; }
#endif
  }
  s_dl.play = false;
}

/*
 * Bench: replay `draw` once through the tiles with every op type timed, and
 * put the totals in the ring. Build with -DUI_DRAW_PROFILE=1 to have boot log
 * the menu, GALLERY, LOOK and an open frame this way; it is how the corner
 * table, the ring primitive and the per-tile occlusion were found (#177).
 */
#if UI_DRAW_PROFILE
static void dl_profile(const char *what, gfx_draw_fn draw, void *ctx) {
  static const char *const OP[DL_OPS] = {"fill", "rrect", "routl", "cut", "disc", "stroke", "scrim", "text", "odd", "field", "shblit", "blit", "bits", "focus", "ring"};
  dl_begin();
  draw(ctx);
  if (!dl_end()) return;
  memset(s_dl.prof_us, 0, sizeof s_dl.prof_us);
  memset(s_dl.prof_n, 0, sizeof s_dl.prof_n);
  s_dl.prof = true;
  const uint32_t total = gfx_measure_draw_us(dl_replay, NULL);
  s_dl.prof = false;
  char line[200];
  int n = snprintf(line, sizeof line, "%s %lu.%lu ms:", what, (unsigned long)(total / 1000), (unsigned long)(total / 100 % 10));
  for (int i = 0; i < DL_OPS && n < (int)sizeof line; i++) {
    if (s_dl.prof_n[i] == 0) continue;
    n += snprintf(line + n, sizeof line - (size_t)n, " %s %lu.%lu/%lu", OP[i], (unsigned long)(s_dl.prof_us[i] / 1000), (unsigned long)(s_dl.prof_us[i] / 100 % 10), (unsigned long)s_dl.prof_n[i]);
  }
  klog("P4", "%s", line);
}
#endif

/**
 * A frame to the panel: recorded once, replayed per tile. Falls back to
 * drawing the frame directly into every tile when the list overflows.
 */
static void ui_render(gfx_draw_fn draw, void *ctx) {
  dl_begin();
  draw(ctx);
  if (dl_end()) {
    gfx_render(dl_replay, NULL);
  } else {
    static uint32_t warned;
    if (warned++ == 0) klog("P4", "display list full at %d commands; frame drawn direct", s_dl.n);
    gfx_render(draw, ctx);
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

/** One panel of the status bar: the recess, and its reading inside it.
 *  `down` is the pressed face, for the panels that are a control. */
static int sh_panel(int x, int w, const char *s, bool down) {
  round_rect(x, SH_PN_Y, w, SH_PN_H, UI_R, down ? W_SEL : W_WINDOW);
  text(&UI_FONT_T, x + SH_PN_PAD, SH_PN_Y + (SH_PN_H - UI_FONT_T.line_h) / 2, s,
       down ? W_SELTEXT : W_TEXT);
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
  /* Which of the four are on screen, as the mark rather than as a sentence.
   * Filled in by the pane loop below, for the same reason `live` is: what the
   * strip reports is what the screen is showing. */
  fm_cell_t cams_st[4] = {FM_OFF, FM_OFF, FM_OFF, FM_OFF};
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
      cams_st[i] = FM_ON;
      continue;
    }

    /* No pixels. Say which of the several reasons it is - a black quarter
     * could mean any of them - and say it quietly, because this is the one
     * state where the screen has nothing better to show. */
    fill(px, py, SH_PANE_W, SH_PANE_H, D_GROUND);
    const bool settling = st.state == VF_NO_LINK &&
                          esp_timer_get_time() - s_shoot_since_us < SH_SETTLE_US;
    if (settling) continue;
    const char *why = st.state == VF_ERROR     ? "NO PICTURE"
                      : st.state == VF_STALLED ? "NO RECENT FRAME"
                                               : "NO CAMERA";
    /* Quiet, and in the palette: two blue-greys lived here that were in no
     * other place on the panel and measured under 2:1 - a reason nobody
     * could read on the one pane that had nothing else to say. */
    text_mid(&UI_FONT_T, px + SH_PANE_W / 2, py + SH_PANE_H / 2 - 14, why, D_DIM);
    text_mid(&UI_FONT_T, px + SH_PANE_W / 2, py + SH_PANE_H / 2 + 6, NAMES[i], D_DIM);
  }

  /* ---- the way out ---- */

  /* A system button, pressed the way every other button on this interface is:
   * the bevel inverts and the face goes in a pixel, taking the mark and the
   * word with it. The glyph and the label are centred as one group, so the
   * plate is padded evenly whatever the face measures the word at. */
  const bool down = s_pressed == SH_IT_BACK;
  const int d = down ? 1 : 0;
  const int sbx = sh_back_x();
  button(sbx, SH_BACK_Y, SH_BACK_W, SH_BACK_H, down);
  {
    const int gw = 24, gap = 8;
    const int tw = text_w(&UI_FONT_T, "MENU");
    const int gx = sbx + (SH_BACK_W - (gw + gap + tw)) / 2 + d;
    back_glyph(gx + gw / 2, SH_BACK_Y + SH_BACK_H / 2 + d, W_TEXT);
    text(&UI_FONT_T, gx + gw + gap, SH_BACK_Y + (SH_BACK_H - UI_FONT_T.line_h) / 2 + d, "MENU",
         W_TEXT);
  }
  if (foc(SCR_SHOOT, SH_IT_BACK)) focus_inset(sbx, SH_BACK_Y, SH_BACK_W, SH_BACK_H, W_TEXT);

  /* ---- how it will shoot ---- */

  const char *const flash = FLASH_NAMES[flash_index()];
  /* `live` counts the four panes, so this is nine characters. The buffer is
   * sized for a full int anyway: the compiler cannot see the bound and
   * -Werror=format-truncation is right to insist, and a buffer that only fits
   * the value the code happens to produce is one refactor from a cut string. */
  char cams[24];
  snprintf(cams, sizeof cams, "%d/4", live);

  /* The bolt labels the flash panel so the word does not have to. It is the
   * one drawn glyph in the build - the face is ASCII 32..126 and the Windows
   * 98 archive has no flash asset - and it was drawn for the flash control
   * that used to sit on this screen. This is where it went. */
  const int bolt_w = 8, bolt_gap = 8;
  const char *const mode = mode_is_quad() ? "QUAD" : "WIGGLE";
  const int w_mode = text_w(&UI_FONT_T, mode) + 2 * SH_PN_PAD;
  const int w_flash = bolt_w + bolt_gap + text_w(&UI_FONT_T, flash) + 2 * SH_PN_PAD;
  /* The mark, then the count. Four 8 px cells and three 6 px gaps. */
#define SH_FM_CELL 8
#define SH_FM_W (4 * SH_FM_CELL + 3 * FM_GAP)
  const int w_cams = SH_FM_W + 10 + text_w(&UI_FONT_T, cams) + 2 * SH_PN_PAD;

  AUDIT_CHROME(true);
  fill(0, SH_BAR_Y, UI_W, SH_BAR_H, W_FACE);
  /* Raised, unlike the menu's, which sits inside a window frame that supplies
   * the edge. This screen has no frame - the panes run to all four sides - so
   * the bar draws its own, and the white top line is what separates it from
   * the picture rather than a keyline that belongs to neither. */

  /* The card and the power source, in their own panels beside the camera
   * count. The viewfinder is where someone stands with the body in their
   * hands deciding whether to keep shooting, and how many photographs are
   * left and what it is running on are the two facts that decision is made
   * of. There is no fuel gauge on this board, so the power panel says where
   * the power comes from and not how much of it there is. */
  const storage_status_t sd_bar = *sd_status();
  char card_bar[24];
  if (!sd_bar.mounted) snprintf(card_bar, sizeof card_bar, "NO CARD");
  else snprintf(card_bar, sizeof card_bar, "%d LEFT",
                (int)(sd_bar.free_bytes / (6ull * 1024 * 1024)));
  const char *const pwr_bar = usb_attached() ? "USB" : "BATTERY";
  const int w_card = text_w(&UI_FONT_T, card_bar) + 2 * SH_PN_PAD;
  const int w_pwr = text_w(&UI_FONT_T, pwr_bar) + 2 * SH_PN_PAD;

  /*
   * Two groups, and the hand decides which end each takes.
   *
   * The three DECISIONS - mode, flash, look - are the group a thumb changes,
   * so they sit at the hand's end of the bar and press as one control that
   * opens LOOK; the three READINGS - cameras, power, card - are the group
   * nobody presses, so they take the far end. The panels start and end on
   * the page margin, which is where the MENU button above them starts.
   *
   * The look takes what is left between the two groups: one elastic panel
   * and the rest sized to their contents, which is the split the menu's
   * status bar used. A look's name may be 40 characters by the wire
   * contract, so it is the one reading that can outgrow its panel - and the
   * elastic panel is the one that can afford to cut it.
   */
  const bool set_down = s_pressed == SH_IT_LOOK;
  const int w_read = w_cams + SH_PN_GAP + w_pwr + SH_PN_GAP + w_card;
  const int read_x0 = s_right_hand ? PAGE_M : UI_W - PAGE_M - w_read;
  const int set_x0 = s_right_hand ? read_x0 + w_read + SH_PN_GAP : PAGE_M;
  const int set_x1 = s_right_hand ? UI_W - PAGE_M : UI_W - PAGE_M - w_read - SH_PN_GAP;
  s_sh_set_x0 = set_x0;
  s_sh_set_x1 = set_x1;

  /* The readings, cameras outermost. */
  int cams_x, pwr_x, card_x;
  if (s_right_hand) {
    cams_x = read_x0;
    pwr_x = cams_x + w_cams + SH_PN_GAP;
    card_x = pwr_x + w_pwr + SH_PN_GAP;
  } else {
    card_x = read_x0;
    pwr_x = card_x + w_card + SH_PN_GAP;
    cams_x = pwr_x + w_pwr + SH_PN_GAP;
  }
  sh_panel(card_x, w_card, card_bar, false);
  sh_panel(pwr_x, w_pwr, pwr_bar, false);

  /* The decisions, mode outermost, look nearest the readings. */
  int mode_x, flash_x, look_x;
  const int w_look = (set_x1 - set_x0) - w_mode - w_flash - 2 * SH_PN_GAP;
  if (s_right_hand) {
    mode_x = set_x1 - w_mode;
    flash_x = mode_x - SH_PN_GAP - w_flash;
    look_x = set_x0;
  } else {
    mode_x = set_x0;
    flash_x = mode_x + w_mode + SH_PN_GAP;
    look_x = flash_x + w_flash + SH_PN_GAP;
  }
  sh_panel(mode_x, w_mode, mode, set_down);
  {
    /* The flash panel by hand, because it is the one with a glyph in it. */
    const uint16_t ink = set_down ? W_SELTEXT : W_TEXT;
    round_rect(flash_x, SH_PN_Y, w_flash, SH_PN_H, UI_R, set_down ? W_SEL : W_WINDOW);
    bolt(flash_x + SH_PN_PAD, SH_PN_Y + (SH_PN_H - 14) / 2, 1, ink);
    text(&UI_FONT_T, flash_x + SH_PN_PAD + bolt_w + bolt_gap,
         SH_PN_Y + (SH_PN_H - UI_FONT_T.line_h) / 2, flash, ink);
  }
  if (w_look > 2 * SH_PN_PAD + 24) {
    char look[KDP_RECIPE_ID_MAX + 4];
    text_fit(look, sizeof look, &UI_FONT_T, shoot_look_name(), w_look - 2 * SH_PN_PAD);
    sh_panel(look_x, w_look, look, set_down);
  }
  if (foc(SCR_SHOOT, SH_IT_LOOK)) focus_inset(set_x0, SH_PN_Y, set_x1 - set_x0, SH_PN_H, W_TEXT);
  /*
   * The four, in the one place the four lenses are actually in front of you.
   *
   * This panel said "4/4 LIVE" in words, on the only screen where the mark
   * that means four-frames-in-hand was missing - it is under every tile in
   * the gallery, across the capture banner, beside an opened photograph and
   * counting up through the boot splash, and not on the viewfinder. The
   * product's own glyph belongs where its subject is.
   */
  {
    status_panel(cams_x, SH_PN_Y, w_cams, SH_PN_H);
    four_mark(cams_x + SH_PN_PAD, SH_PN_Y + (SH_PN_H - SH_FM_CELL) / 2, SH_FM_CELL, cams_st,
              false);
    text(&UI_FONT_T, cams_x + SH_PN_PAD + SH_FM_W + 10,
         SH_PN_Y + (SH_PN_H - UI_FONT_T.line_h) / 2, cams, W_TEXT);
  }
  AUDIT_CHROME(false);
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
/*
 * LOOK, laid out around the thing the screen is named after.
 *
 * It was five identical bands stacked down the panel - MODE, FLASH, the look
 * picker, COLOUR, TARGET - each a caption with a sentence beside it and a
 * segmented track under it, all at one weight. The screen is called LOOK and
 * the look was the third band, indistinguishable from the flash mode. Nothing
 * on it said what it was for.
 *
 * So: the look is a card, and the three things that modify it are three
 * smaller cards in a row under it - the reference's own composition, one
 * large surface and a row of small ones, rather than a stack of equals. The
 * look's own parameters live inside its card, which is where they belong:
 * they describe the look, and they were a separate strip at the foot of the
 * screen under nothing at all.
 *
 * One table below, read by the drawing AND by the hit test. The item indices
 * are unchanged so activate() does not move.
 */
#define LK_CAP_H (UI_FONT_T.line_h + 6) /* a caption line above a card */
#define LK_CTL_H 56                     /* 6.6 mm: a segment a thumb can hit */
/* The card's height with the target row under it; without that row the
 * card takes the row's room, so the screen is full either way rather than
 * a card over a third of empty ground. */
#define LK_HERO_MIN 168
#define LK_GAP 18
#define LK_COL_GAP 12
#define LK_W (UI_W - 2 * PAGE_M)
#define LK_COL_W ((LK_W - 2 * LK_COL_GAP) / 3)
#define LK_PICK_BTN 60

/*
 * The picker's two buttons, at the hero card's foot on the hand's side, and
 * the two x positions the card's type is laid between - the far margin and
 * the picker's near edge.
 */
static int lk_next_x(void) { return from_hand(PAGE_M + 16, LK_PICK_BTN); }
static int lk_prev_x(void) { return from_hand(PAGE_M + 16 + LK_PICK_BTN + 8, LK_PICK_BTN); }
static int lk_text_x0(void) {
  return s_right_hand ? PAGE_M + 24 : lk_prev_x() + LK_PICK_BTN + 24;
}
static int lk_text_x1(void) { return s_right_hand ? lk_prev_x() - 24 : UI_W - PAGE_M - 24; }

/*
 * The three columns under the card, in the order the hand wants them.
 *
 * FLASH is the setting changed most at a party and it sat in the middle;
 * MODE, the one changed least, sat at the far left. The visual column `c`
 * maps to a group through this, so the near column is FLASH whichever hand
 * holds the body.
 */
enum { LK_G_MODE = 0, LK_G_FLASH, LK_G_COLOR };
static int lk_group_of_col(int c) {
  static const int RIGHT[3] = {LK_G_COLOR, LK_G_MODE, LK_G_FLASH};
  static const int LEFT[3] = {LK_G_FLASH, LK_G_MODE, LK_G_COLOR};
  return s_right_hand ? RIGHT[c] : LEFT[c];
}

/* The target row: ALL at the hand's end, the four cameras in order beside it.
 * `seg` is the drawn position, `target` is the value LOOK writes (0 = ALL). */
static int lk_target_of_seg(int seg) {
  if (s_right_hand) return seg == 4 ? 0 : seg + 1;
  return seg == 0 ? 0 : seg;
}
static int lk_seg_of_target(int target) {
  if (s_right_hand) return target == 0 ? 4 : target - 1;
  return target;
}

/** Where the three blocks start, top to bottom. `quad` adds the target row. */
static int lk_hero_h(bool quad) {
  return quad ? LK_HERO_MIN : LK_HERO_MIN + LK_GAP + LK_CAP_H + LK_CTL_H;
}
static int lk_top(bool quad) {
  const int h = lk_hero_h(quad) + LK_GAP + LK_CAP_H + LK_CTL_H +
                (quad ? LK_GAP + LK_CAP_H + LK_CTL_H : 0);
  return body_top(h);
}
static int lk_hero_y(bool quad) { return lk_top(quad); }
static int lk_trio_y(bool quad) { return lk_hero_y(quad) + lk_hero_h(quad) + LK_GAP; }
static int lk_tgt_y(bool quad) { return lk_trio_y(quad) + LK_CAP_H + LK_CTL_H + LK_GAP; }
/** Column `i` of the three-up row. */
static int lk_col_x(int i) { return PAGE_M + i * (LK_COL_W + LK_COL_GAP); }

/* Item ranges. The target row is last so the item indices below it are the
 * same in both modes, which is what lets item_count() simply drop it. */
#define LK_IT_MODE 0    /* 0..1  WIGGLE / QUAD */
#define LK_IT_FLASH 2   /* 2..4  AUTO / ON / OFF */
#define LK_IT_PREV 5    /* the look picker's left button */
#define LK_IT_NEXT 6    /* and its right one */
#define LK_IT_COLOR 7   /* 7..8  COLOUR / B&W */
#define LK_IT_TARGET 9  /* 9..13 ALL / CAM1..CAM4, QUAD only */
#define LK_IT_COUNT 14

/* The look's own numbers, which live inside its card now. */
#define LK_DET_COLS 5

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
 * What the look sets, on one line inside its own card.
 *
 * Five readings - exposure, gain ceiling, quality, denoise, sharpness - and
 * they were a five-column strip at the foot of the screen, under a control
 * they had nothing to do with. They describe the look; they live in the
 * look's card, set small, with the ones the look does not touch left out
 * rather than printed as "NOT SET" five times.
 */
static void lk_detail_row(int x, int y, int w) {
  char id[KDP_RECIPE_ID_MAX];
  if (!look_current_id(id, sizeof id)) {
    /* QUAD, target ALL, four slots that disagree. Showing cam1's numbers for
     * all four would misdescribe three cameras, which is the same reason
     * look_display() says MIXED rather than guessing. */
    text(&UI_FONT_S, x, y + UI_FONT_T.line_h, "Four cameras, four looks. Pick one to see it.",
         W_GRAYTEXT);
    return;
  }
  recipe_capture_t cap;
  if (!look_capture(id, &cap)) {
    text(&UI_FONT_S, x, y + UI_FONT_T.line_h, "Sets nothing on the sensor.", W_GRAYTEXT);
    return;
  }

  char line[96];
  int n = 0;
  line[0] = '\0';
#define LK_ADD(fmt, ...)                                                       \
  do {                                                                         \
    n += snprintf(line + n, sizeof line - (size_t)n, (n ? "   " fmt : fmt), __VA_ARGS__); \
    if (n > (int)sizeof line) n = (int)sizeof line;                            \
  } while (0)

  if (cap.has_exposure_bias) {
    const double b = cap.exposure_bias;
    const int t10 = (int)(b * 10.0 + (b >= 0 ? 0.5 : -0.5));
    const int mag = t10 < 0 ? -t10 : t10;
    LK_ADD("%s%d.%d EV", t10 < 0 ? "-" : "+", mag / 10, mag % 10);
  }
  if (cap.has_gain_limit) LK_ADD("x%d", cap.gain_limit);
  if (cap.has_jpeg_quality) LK_ADD("%d%%", cap.jpeg_quality_percent);
  if (cap.has_denoise) LK_ADD("DENOISE %d", cap.denoise);
  if (cap.has_sharpness) LK_ADD("SHARP %d", cap.sharpness);
#undef LK_ADD

  if (line[0] == '\0') {
    text(&UI_FONT_S, x, y + UI_FONT_T.line_h, "Sets nothing on the sensor.", W_GRAYTEXT);
    return;
  }
  text(&UI_FONT_T, x, y, "AT CAPTURE", W_GRAYTEXT);
  char fitted[96];
  text_fit(fitted, sizeof fitted, &UI_FONT_S, line, w);
  text(&UI_FONT_S, x, y + UI_FONT_T.line_h, fitted, W_TEXT);
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
  static const char *const TARGET_R[5] = {"CAM1", "CAM2", "CAM3", "CAM4", "ALL"};
  static const char *const TARGET_L[5] = {"ALL", "CAM1", "CAM2", "CAM3", "CAM4"};
  const char *const *TARGET_NAMES = s_right_hand ? TARGET_R : TARGET_L;

  const int p0 = s_pressed;
  const int f0 = s_focus_shown ? s_focus[SCR_LOOK] : -1;
  const bool quad = mode_is_quad();

  /* ---- the look itself, as the screen's one large card ---- */
  const int hy = lk_hero_y(quad);
  /* No caption over the card: the header says LOOK, and with the card
   * hung from the header the caption sat on the header's rule. */
  const int hh = lk_hero_h(quad);
  round_rect(PAGE_M, hy, LK_W, hh, UI_R, W_WINDOW);

  char look[KDP_RECIPE_ID_MAX];
  look_display(look, sizeof look);
  upcase(look);
  /* Where you are in the list. Cycling one at a time through up to 35 entries
   * with no idea how many there are is the complaint the picker earned. */
  char pos[24];
  look_position(pos, sizeof pos);

  const bool have = kdp_recipes_count() > 0;
  const uint16_t nink = have ? W_TEXT : W_GRAYTEXT;

  /* The two picker buttons at the card's foot on the hand's side, and the
   * name filling the rest of it - the name is the subject, so it takes the
   * room. */
  const int by = hy + hh - 16 - LK_CTL_H;
  const int nx = lk_next_x();
  const int px2 = lk_prev_x();
  const bool pd = band_rel(p0, LK_IT_PREV, 2) == 0, nd = band_rel(p0, LK_IT_PREV, 2) == 1;
  control(px2, by, LK_PICK_BTN, LK_CTL_H, UI_R, pd, W_WINDOW);
  picker_arrow(px2 + LK_PICK_BTN / 2, by + LK_CTL_H / 2, false, nink);
  control(nx, by, LK_PICK_BTN, LK_CTL_H, UI_R, nd, W_WINDOW);
  picker_arrow(nx + LK_PICK_BTN / 2, by + LK_CTL_H / 2, true, nink);

  /* The name, big, hung off the card's far rule with the position above it -
   * the reference anchors a card's content to one corner and leaves the air
   * at the other, which is where the buttons are. */
  const int tx0 = lk_text_x0(), tw = lk_text_x1() - tx0;
  {
    /* The position and the name at the card's head, the capture line at its
     * foot, whatever the card's height: the air is between the two facts,
     * where it reads as room and not as a gap. */
    const int ny = hy + 52;
    if (pos[0] != '\0') text(&UI_FONT_T, tx0, ny - UI_FONT_T.line_h - 10, pos, W_GRAYTEXT);
    char fitted[KDP_RECIPE_ID_MAX + 4];
    const ui_font_t *nf = fit_face(look, tw);
    text_fit(fitted, sizeof fitted, nf, look, tw);
    text_ink(nf, tx0, ny, fitted, nink);
  }

  /* And what the look actually sets, inside the card it belongs to. It was a
   * strip at the foot of the screen under nothing at all. */
  lk_detail_row(tx0, hy + hh - 16 - UI_FONT_T.line_h - UI_FONT_S.line_h, tw);

  /* ---- the three that modify it ---- */
  const int ty = lk_trio_y(quad);
  static const char *const CAPS[3] = {"MODE", "FLASH", "COLOUR"};
  for (int c = 0; c < 3; c++) {
    const int g = lk_group_of_col(c);
    text(&UI_FONT_T, lk_col_x(c) + 4, ty, CAPS[g], W_GRAYTEXT);
    switch (g) {
      case LK_G_MODE:
        draw_segments(lk_col_x(c), ty + LK_CAP_H, LK_COL_W, LK_CTL_H, MODE_NAMES, 2, quad ? 1 : 0,
                      band_rel(p0, LK_IT_MODE, 2), band_rel(f0, LK_IT_MODE, 2));
        break;
      case LK_G_FLASH:
        draw_segments(lk_col_x(c), ty + LK_CAP_H, LK_COL_W, LK_CTL_H, FLASH_NAMES, 3,
                      flash_index(), band_rel(p0, LK_IT_FLASH, 3), band_rel(f0, LK_IT_FLASH, 3));
        break;
      default:
        draw_segments(lk_col_x(c), ty + LK_CAP_H, LK_COL_W, LK_CTL_H, COLOR_NAMES, 2,
                      look_is_mono() ? 1 : 0, band_rel(p0, LK_IT_COLOR, 2),
                      band_rel(f0, LK_IT_COLOR, 2));
        break;
    }
  }

  /* QUAD only, because it is the only mode with four independent slots. In
   * WIGGLE there is one look and a target row would be a control with one
   * legal value. The pressed and focused positions are item indices, which
   * are drawn positions on this row; the SELECTED one is a value. */
  if (quad) {
    const int gy = lk_tgt_y(quad);
    text(&UI_FONT_T, PAGE_M + 4, gy, "TARGET", W_GRAYTEXT);
    draw_segments(PAGE_M, gy + LK_CAP_H, LK_W, LK_CTL_H, TARGET_NAMES, 5,
                  lk_seg_of_target(s_look_target), band_rel(p0, LK_IT_TARGET, 5),
                  band_rel(f0, LK_IT_TARGET, 5));
  }
}

/* ------------------------------------------------------------------ */
/* Gallery                                                             */
/* ------------------------------------------------------------------ */

/*
 * The grid: 3x2 tiles of 252x189, and nothing else in the body.
 *
 * The body used to hold 208x156 tiles, a 20 px caption strip under each, and
 * a 40 px footer for PREV / NEXT and the count, and the pictures came to 39%
 * of the panel. The footer's three things now live in the header bar, which
 * had 700 px of caption plate for a 150 px word, and the caption strip is an
 * overlay along each tile's bottom edge. What that frees goes to the tiles:
 * 252x189 is the widest 4:3 tile three of which fit across 800 with the 6 px
 * block a well needs at each edge and 14 px between columns, and two rows of
 * it fit the 63..478 body with 8 px above and 9 below. THUMB.JPG is 288x224,
 * so a tile shows it at 13/16 - 234x182 - against 198x154 before.
 */
#define G_COLS GALLERY_COLS
#define G_TILE_W GALLERY_TILE_W
#define G_TILE_H GALLERY_TILE_H
/*
 * The grid, on the page's own margins.
 *
 * It was centred in whatever the tiles left over, which put it 8 px from the
 * sides and 11 from the top on a page whose every other element sits 16 from
 * both - so the one screen that is nothing but content was the one screen
 * whose content did not line up with anything. The tile size is the
 * decoder's and cannot move, so the gutters give way instead: 6 across and 8
 * down, which lands all four margins on 16 exactly. Two pixels between the
 * gutters is invisible; the margins are what the eye reads.
 */
#define G_GAP ((UI_W - 2 * PAGE_M - G_COLS * G_TILE_W) / (G_COLS - 1))  /* 6 */
#define G_GAP_Y 8
#define G_X0 PAGE_M
#define G_Y0 (HEAD_H + PAGE_M)
#define G_PITCH (G_TILE_H + G_GAP_Y)
/* The facts plate along the tile's bottom edge: the frame mark and the mode
 * word, on the same dark tone the favourite star sits on. */
#define G_STRIP 20

/* Items 0..5 are tiles, 6 is page-back, 7 is page-forward. */
#define G_IT_PREV 6
#define G_IT_NEXT 7

/* Each tile is a well with a 2 px white mat, so the block round a photograph
 * is 6 px wider on every side than the photograph: 2 of selection plate, 2 of
 * sunken edge, 2 of mat. The gap between tiles has to hold two of them and the
 * screen edge one, and the bottom row's block has to clear the window frame's
 * 2 px bevel. Checked here because the pitch is arithmetic and the margins are
 * literals - the two only agreed by luck before this was written down. */
#define G_BLOCK 6
_Static_assert(G_GAP >= G_BLOCK, "the gallery tile wells touch across a column gap");
_Static_assert(G_PITCH - G_TILE_H >= G_BLOCK, "the gallery tile wells touch across a row gap");
_Static_assert(G_X0 >= G_BLOCK, "the leftmost tile well runs off the screen");
_Static_assert(UI_H - (G_Y0 + G_PITCH + G_TILE_H) == PAGE_M,
               "the gallery grid does not end on the page margin");
_Static_assert(G_Y0 >= BODY_Y + G_BLOCK, "the top row's well runs into the header");
_Static_assert(G_Y0 + G_PITCH + G_TILE_H + G_BLOCK <= UI_H - 2,
               "the bottom row's well runs into the window frame");
_Static_assert(G_STRIP >= 18 && G_STRIP < G_TILE_H / 4,
               "the facts strip does not hold a line of type, or eats the picture");
_Static_assert(2 * PAGE_M + 3 * HD_BTN_W + 2 * HD_BTN_GAP + G_PG_GAP + HD_CAP_PAD + 320 <= UI_W,
               "the paging buttons run into the GALLERY caption and its count");

static void gal_origin(int slot, int *x, int *y) {
  *x = G_X0 + (slot % G_COLS) * (G_TILE_W + G_GAP);
  *y = G_Y0 + (slot / G_COLS) * G_PITCH;
}

/* ------------------------------------------------------------------ */
/* The favourite mark                                                  */
/*                                                                     */
/* A bitmap, not a scan-converted polygon. The mark has to be legible   */
/* at 11 px in the corner of a 252 px tile, and at that size a computed */
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
  blit_rows(px, G_TILE_W, x, y, G_TILE_W, G_TILE_H);
}

static void draw_gallery(void) {
  fill(0, 0, UI_W, UI_H, W_FACE);
  /* The page position goes at the bar's right end, next to the buttons that
   * change it - not next to the title, which it has nothing to do with. Set
   * before the header draws, because the header lays the whole readout. */
  {
    const int pg = gallery_pages();
    if (pg > 1) snprintf(s_head_first, sizeof s_head_first, "%d/%d", gallery_page() + 1, pg);
    else s_head_first[0] = '\0';

    /* And the count, at the group's other end. While a rebuild walks the card
     * it says so instead: an index hit reads no capture folders at all, so
     * there is no number, and a rebuild on a 500-capture card takes seconds -
     * a bar that says nothing for that long is one that has hung. */
    if (gallery_loading()) {
      const int walked = gallery_scan_progress();
      if (walked > 0) snprintf(s_head_last, sizeof s_head_last, "READING CARD %d", walked);
      else snprintf(s_head_last, sizeof s_head_last, "READING CARD");
    } else {
      const int n = gallery_total();
      snprintf(s_head_last, sizeof s_head_last, "%d PHOTO%s", n, n == 1 ? "" : "S");
    }
  }
  draw_header(SCR_GALLERY);

  const storage_status_t sd = *sd_status();
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
    text_mid(&UI_FONT_L, UI_W / 2, UI_H / 2 - 40, h1, W_TEXT);
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
    } else if (slots[i].state == TILE_PENDING) {
      /* Not yet decoded is not the same state as will not decode, and they
       * used to be drawn identically: the same grey word on the same dark
       * well, so a card still being read looked like a card full of damage.
       * A tile waiting for its picture is the empty frame the picture will
       * arrive into - the well's own white, no word - and the cells in the
       * strip below say how many frames the folder has. */
      /* The well's light grey, not its white. White is the brightest value
       * the panel has, and on a page of six photographs a waiting tile in it
       * is the loudest thing on the screen - which is the opposite of what a
       * tile that has nothing to show yet should be. Seen on a contact sheet
       * of the whole product, where it read as a hole in the grid. */
      fill(x, y, G_TILE_W, G_TILE_H, W_PRESS);
    } else {
      fill(x, y, G_TILE_W, G_TILE_H, W_WINDOW);
      text_mid(&UI_FONT_T, x + G_TILE_W / 2 + d, y + G_TILE_H / 2 - 9 + d, "NO IMAGE", D_DIM);
    }
    /* The facts, on a plate along the picture's bottom edge rather than in a
     * strip under it. No filename, no size, no path: the picture is the
     * content and the rest is file management. The plate is the same dark
     * tone the favourite star already sits on, so a tile carries one kind of
     * mark and not two; it costs the bottom 20 rows of a 189-row picture,
     * which is less than the 32 rows of caption and gap it replaces and is
     * taken from the picture's edge rather than from its size.
     *
     * The mark instead of a sentence: four cells, lit for the frames that
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
    const int sy0 = y + G_TILE_H - G_STRIP;
    fill(x, sy0, G_TILE_W, G_STRIP, D_PANE);
    /* The mark is 8 px in a 20 px strip and the type is 18, so each sits in
     * the strip's middle on its own terms: 6 above the cells, 1 above the
     * line. Dark-ground cells, which is the variant the capture banner uses. */
    four_mark(x + 6 + d, sy0 + (G_STRIP - 8) / 2 + d, 8, st, true);
    /* The mode, only when it is not the one every photograph has. Six tiles
     * that all say `wiggle` is six copies of a word that distinguishes
     * nothing, and a label that never varies stops being read - which is
     * exactly when it fails to be read on the one tile where it differs. */
    if (slots[i].mode[0] && strcmp(slots[i].mode, "wiggle") != 0) {
      /* In caps and in the interface's light ink. It was set in W_SELTEXT,
       * which is the near-black an accent plate is written in, on a near-black
       * strip - so the one word that tells two kinds of photograph apart was
       * the least legible thing on the screen. */
      char mode[16];
      snprintf(mode, sizeof mode, "%s", slots[i].mode);
      upcase(mode);
      text_right(&UI_FONT_T, x + G_TILE_W - 8 + d, sy0 + (G_STRIP - UI_FONT_T.line_h) / 2 + d,
                 mode, W_TEXT);
    }

    /* Drawn after the strip so the press reads as the whole well, strip
     * included, going deeper. */
    if (down) outline(x, y, G_TILE_W, G_TILE_H, W_SEL);
    if (selected) focus_inset(x, y, G_TILE_W, G_TILE_H, W_SELTEXT);

    /* A favourite is marked in the top-right corner of the picture, away from
     * the facts strip along the bottom, which already carries the frame mark
     * and the mode; the top-right corner of a tile is the one place that is
     * empty on every photograph.
     *
     * On its own dark plate, because the mark sits over a photograph and a
     * white star on a bright sky is not a mark. */
    if (slots[i].favorite) {
      const int sx = x + G_TILE_W - STAR_W - 6, sy = y + 5;
      fill(sx - 3, sy - 3, STAR_W + 6, STAR_H + 6, D_PANE);
      star(sx, sy, MZ_ACCENT);
    }
  }

  /*
   * The page buttons, at the bar's right end, mirroring BACK at its left.
   * The two readings that used to be laid here by hand - the count and the
   * page position - are set above and laid by draw_header(), because the
   * readout group has one rhythm and one piece of code that knows it.
   */
  const int pages = gallery_pages();

  if (pages > 1) {
    const int pd = s_pressed == G_IT_PREV ? 1 : 0, nd = s_pressed == G_IT_NEXT ? 1 : 0;
    /* Greyed at the ends rather than hidden. A control that disappears moves
     * the other one and teaches nothing; a dead one shows you where you are. */
    const bool has_prev = gallery_page() > 0;
    const bool has_next = gallery_page() < pages - 1;
    const int px = hd_prev_x(), nx = hd_next_x();
    button(px, HD_BTN_Y, HD_BTN_W, HD_BTN, pd);
    arrow_glyph(px + HD_BTN_W / 2 + pd, HD_BTN_Y + HD_BTN / 2 + pd, false,
                has_prev ? W_TEXT : W_GRAYTEXT);
    button(nx, HD_BTN_Y, HD_BTN_W, HD_BTN, nd);
    arrow_glyph(nx + HD_BTN_W / 2 + nd, HD_BTN_Y + HD_BTN / 2 + nd, true,
                has_next ? W_TEXT : W_GRAYTEXT);
    if (foc(SCR_GALLERY, G_IT_PREV)) focus_inset(px, HD_BTN_Y, HD_BTN_W, HD_BTN, W_TEXT);
    if (foc(SCR_GALLERY, G_IT_NEXT)) focus_inset(nx, HD_BTN_Y, HD_BTN_W, HD_BTN, W_TEXT);
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
 * item_count(SCR_PHOTO) is 3: DELETE, FAVOURITE and SEND TO ROLL all act.
 */
#define P_IT_DELETE 0
#define P_IT_FAV 1
#define P_IT_ROLL 2
/* The previous and next photograph. Above the item_count() range on purpose:
 * they are targets, not focus stops, on a body with no direction keys. */
#define P_IT_PREV 3
#define P_IT_NEXT 4

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
    if (thumb_load(path, s_photo, PH_W, PH_H, W_WINDOW) == ESP_OK) {
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
    static pure_cam_offset_t dev_cal[PURE_WIGGLE_FRAMES_MAX];
    const bool have_dev = wiggle && calib_load(dev_cal) &&
                          pure_align_has_offset(dev_cal, PURE_WIGGLE_FRAMES_MAX);
    const pure_cam_offset_t *off =
        (wiggle && it->cal_present && pure_align_has_offset(it->cal, PURE_WIGGLE_FRAMES_MAX))
            ? it->cal
        : have_dev ? dev_cal
                   : NULL;
    if (gallery_frames_begin(it->id, fw, fh, W_WINDOW, off, &gen) == ESP_OK) s_wig_gen = gen;
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
/*
 * Send this photograph to the active Roll.
 *
 * A photograph taken ON the Roll was queued by the shutter and the queue
 * refuses to queue it twice (upload_queue_enqueue is the same path). One
 * taken off any Roll - before the body joined one, or with the radio down -
 * is a local photograph, and this is the one way to adopt it: queued for the
 * Roll active now, with whichever frames the card actually holds.
 */
static void photo_send_to_roll(void) {
  if (s_photo_id[0] == '\0') return;
  if (!roll_state_active()) {
    toast("No active roll");
    audio_warning();
    return;
  }
  /* What the card holds for this capture: the thumbnail, and which frames.
   * Asked of the gallery, which owns the card's layout; this file never
   * touches the filesystem itself. */
  bool has_thumb = false;
  uint8_t slots[4];
  const int n = gallery_capture_files(s_photo_id, &has_thumb, slots, 4);
  esp_err_t err = upload_queue_enqueue(s_photo_id, has_thumb);
  if (err == ESP_ERR_INVALID_STATE) {
    roll_state_t roll;
    if (!roll_state_get(&roll) || roll.roll_id[0] == '\0') {
      toast("No active roll");
      audio_warning();
      return;
    }
    if (n <= 0) {
      toast("No frames on the card to send");
      audio_warning();
      return;
    }
    err = upload_queue_enqueue_slots(s_photo_id, roll.roll_id, slots, n, has_thumb);
  }
  if (err == ESP_OK) {
    toast("Sent to the roll");
    audio_done();
  } else {
    toast("Could not queue it for the roll");
    audio_warning();
  }
}

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

/*
 * Which slot of the current gallery page the open photograph is, or -1.
 *
 * The page's six slots are what the gallery task has in RAM; the open
 * photograph came from one of them, so this is a string compare per slot and
 * no card. -1 when the page has turned under the screen, or the slot has not
 * been filled yet after a turn.
 */
static int photo_slot(void) {
  if (s_photo_id[0] == '\0') return -1;
  const gallery_item_t *slots = gallery_slots();
  for (int i = 0; i < GALLERY_PAGE; i++) {
    if (slots[i].state != TILE_EMPTY && strcmp(slots[i].id, s_photo_id) == 0) return i;
  }
  return -1;
}

/*
 * The neighbour a step would open: within the page it is a slot, and at the
 * page's ends it is the page beyond. `*slot` is -1 when the step leaves the
 * page. False when there is nothing that way at all.
 */
static bool photo_neighbour(int delta, int *slot) {
  const int at = photo_slot();
  *slot = -1;
  if (at < 0) return false;
  const int want = at + delta;
  const gallery_item_t *slots = gallery_slots();
  if (want >= 0 && want < GALLERY_PAGE && slots[want].state != TILE_EMPTY) {
    *slot = want;
    return true;
  }
  const int pg = gallery_page();
  return delta < 0 ? pg > 0 : pg < gallery_pages() - 1;
}

/*
 * Step to the previous or next photograph.
 *
 * Within the page it opens the neighbour in place, on this screen. Past the
 * page's end it turns the page and returns to the grid: the six new slots
 * are ids the gallery task has not filled yet, so there is nothing here to
 * open, and the grid is where the decoding is shown. Returns true when it
 * navigated, so the caller does not present over a move it started.
 */
static bool photo_step(int delta) {
  int slot;
  if (!photo_neighbour(delta, &slot)) {
    toast(photo_slot() < 0 ? "Still reading the card" : (delta < 0 ? "First photo" : "Last photo"));
    return false;
  }
  if (slot < 0) {
    gallery_turn(delta);
    go(SCR_GALLERY, NAV_BACK_MS);
    return true;
  }
  const gallery_item_t *it = &gallery_slots()[slot];
  if (it->id[0] == '\0') {
    toast("Still reading the card");
    return false;
  }
  if (!photo_open(it)) {
    toast("Card busy");
    audio_warning();
  }
  return false;
}

static void draw_photo(void) {
  fill(0, 0, UI_W, UI_H, D_GROUND);

  const int px = ph_well_x(), py = PH_TOP;
  const int col_x = ph_col_x(), fx = col_x + PH_FPAD;
  /* The frame of the swing while one is playing, the still otherwise. Same
   * size, same well, same everything else: the picture moves and no pixel of
   * the chrome around it does. */
  const uint16_t *src = s_quad_ready ? NULL : photo_pixels();
  if (s_quad_ready) {
    /*
     * The quad: all four looks, 2x2, in reading order - C1 top-left, C2
     * top-right, C3 bottom-left, C4 bottom-right, the same order the gallery
     * tile and META count them. Each quadrant is one frame decoded at exactly
     * this size, so nothing is scaled here. A look that never reached the card
     * is a dark pane with its lens named, in place, so the other three do not
     * move to fill it: a quad with a hole says where the hole is.
     */
    const int qw = PH_W / 2, qh = PH_H / 2;
    for (int i = 0; i < GALLERY_FRAME_MAX; i++) {
      const int qx = px + (i & 1) * qw, qy = py + (i >> 1) * qh;
      const uint16_t *fp = (s_wig_have & (1u << i)) ? gallery_frame_pixels(i) : NULL;
      if (fp != NULL) {
        blit_rows(fp, qw, qx, qy, qw, qh);
      } else {
        char lens[4];
        snprintf(lens, sizeof lens, "C%d", i + 1);
        fill(qx, qy, qw, qh, D_PANE);
        text_mid(&UI_FONT_S, qx + qw / 2, qy + qh / 2 - UI_FONT_S.line_h / 2, lens, D_DIM);
      }
    }
    /* A 2 px seam in the ground colour between the quadrants, over one edge
     * pixel of each: four pictures touching read as one picture with a crease,
     * and the same tone as the surround makes the grid read as four wells. */
    fill(px + qw - 1, py, 2, PH_H, D_GROUND);
    fill(px, py + qh - 1, PH_W, 2, D_GROUND);
  } else if (src != NULL) {
    blit_rows(src, PH_W, px, py, PH_W, PH_H);
  } else {
    fill(px, py, PH_W, PH_H, D_PANE);
    text_mid(&UI_FONT_R, px + PH_W / 2, py + PH_H / 2 - 12, "NO IMAGE", D_DIM);
  }
  /* The picture in a well, in the dark chrome's own tones. It was a 1 px
   * keyline, which is the one thing this grammar has no word for: a frame is
   * either raised or sunken, and a photograph is set into the body. */
  outline(px - 1, py - 1, PH_W + 2, PH_H + 2, D_EDGE);

  /* Back: the system button, at the header's own origin. This screen drew a
   * bare chevron and the word BACK straight on the ground, the viewfinder
   * drew a plate at 10,10 and every other screen a 44 px square at
   * HD_BTN_X - three treatments of the one control that is on every screen.
   * It is the same button in the same place everywhere now. */
  {
    const bool bdown = s_pressed == IT_BACK;
    const int bd = bdown ? 1 : 0;
    const int bx0 = hd_btn_x();
    button(bx0, HD_BTN_Y, HD_BTN_W, HD_BTN, bdown);
    back_glyph(bx0 + HD_BTN_W / 2 + bd, HD_BTN_Y + HD_BTN / 2 + bd, W_TEXT);
    if (foc(SCR_PHOTO, IT_BACK)) focus_inset(bx0, HD_BTN_Y, HD_BTN_W, HD_BTN, W_TEXT);
  }

  /* The caption, one fact per line down the column: what it is called and
   * what kind of capture it is. The frame count was a third line - "4 frames"
   * - and it is the mark below instead: the gallery already says this with
   * four cells and saying it twice in two grammars is how an interface stops
   * having one. */
  /*
   * The facts go in a well, the way every other value on this interface does.
   *
   * This column had two grammars in it: bare type on bare ground at the top,
   * three rounded controls at the foot, and 114 px of nothing between them -
   * which is what makes a screen read as placed rather than composed, and is
   * the reason this one looked unfinished next to LOOK and ABOUT. A well is
   * the container the column never had; it also gives the gap above the
   * buttons an edge to be a gap FROM.
   *
   * The height is computed from the same conditions the drawing below uses,
   * because the well has to be painted before the type that sits on it.
   */
  const bool short_wiggle = (s_wig_len >= 2 || s_quad_ready) && s_wig_count > 0 &&
                            s_wig_count < GALLERY_FRAME_MAX;
  const int blk_pad = 12;
  int blk_h = blk_pad + UI_FONT_R.line_h + UI_FONT_T.line_h;
  if (short_wiggle) blk_h += 6 + UI_FONT_T.line_h;
  blk_h += 18 + UI_FONT_T.line_h + 6 + 14; /* CAMERAS, then the mark */
  blk_h += blk_pad;
  well(col_x, PH_CAP_Y - blk_pad, PH_COL_W, blk_h);

  int cy = PH_CAP_Y;
  {
    /*
     * The number, and then what kind of thing it is.
     *
     * A capture is called CAP_000039 and the whole string will not fit the
     * column at a size worth reading - measured, it is about 165 px in a 158
     * px column at either face. Cutting it to fit produced "CAP_0000...",
     * which throws away the only part that identifies anything: the prefix is
     * the same on every capture this camera has ever taken.
     *
     * So the number gets the billing and the prefix goes on the line below
     * with the mode, where it costs nothing and can still be read back to
     * reconstruct the folder name on the card.
     */
    char raw[32], mode[24];
    snprintf(raw, sizeof raw, "%s", s_photo_label);
    snprintf(mode, sizeof mode, "%s", s_photo_mode);
    upcase(raw);
    upcase(mode);

    char *tail = strrchr(raw, '_');
    const char *num = tail != NULL ? tail + 1 : raw;
    if (tail != NULL) *tail = '\0';

    char fitted[32];
    text_fit(fitted, sizeof fitted, &UI_FONT_R, num, PH_COL_W - 2 * PH_FPAD - 4);
    text(&UI_FONT_R, fx, cy, fitted, D_TEXT);
    cy += UI_FONT_R.line_h;

    /* Sized for both inputs whole. The compiler cannot see that a capture id
     * is ten characters and is right to insist. */
    char sub[64];
    if (tail != NULL && mode[0] != '\0') snprintf(sub, sizeof sub, "%s  %s", raw, mode);
    else if (tail != NULL) snprintf(sub, sizeof sub, "%s", raw);
    else snprintf(sub, sizeof sub, "%s", mode);
    text(&UI_FONT_T, fx, cy, sub, D_DIM);
    cy += UI_FONT_T.line_h;
  }

  /*
   * A wiggle that is swinging fewer than four frames says so, on the caption's
   * fourth line.
   *
   * The count is what DECODED, not META's frameCount: a partial capture may
   * be missing any one of the four and the document only records how many
   * were stored, so the denominator is the four lenses and the numerator is
   * what is actually on the card. Said only when it is short - a complete
   * wiggle needs no note, and "4 OF 4 FRAMES" on every photograph is a label
   * that teaches nothing and dilutes the one that does.
   *
   * In the column rather than over the picture: the well is a photograph and
   * nothing this firmware has to say belongs inside it.
   */
  if (short_wiggle) {
    char note[24];
    snprintf(note, sizeof note, "%d OF %d FRAMES", s_wig_count, GALLERY_FRAME_MAX);
    text(&UI_FONT_T, fx, cy + 6, note, D_DIM);
    cy += 6 + UI_FONT_T.line_h;
  }

  /*
   * Which of the four lenses this photograph has, and what the body is
   * running on - in the middle of the column, which was 250 px of nothing
   * between the facts at the top and the buttons at the foot. Two clumps and
   * a hole is what a screen looks like when its content was placed rather
   * than composed.
   *
   * The mark is the gallery's, at the size a column can afford: the one
   * object in this interface that says four cameras, in the one place the
   * user is looking at what four cameras made.
   */
  {
    fm_cell_t st[4];
    for (int k = 0; k < 4; k++) st[k] = k < s_photo_frames ? FM_ON : FM_OFF;
    /* Flowed from the caption rather than pinned to a constant. PH_FOUR_Y was
     * 132 and the caption grew past it the day the typeface changed, which put
     * "3 OF 4 FRAMES" through the mark. A column reads top to bottom; its
     * geometry should too. */
    /* The word above the mark, not under it. Every other label on this
     * interface sits over the thing it names - CODE over the code, NAME over
     * the name, MODE and FLASH and COLOUR over their values - and this was
     * the one caption written underneath, which is why the column read as
     * two facts and a loose row of squares rather than three labelled
     * things. */
    text(&UI_FONT_T, fx, cy + 18, "CAMERAS", D_DIM);
    const int fy4 = cy + 18 + UI_FONT_T.line_h + 6;
    four_mark(fx, fy4, 14, st, true);
    cy = fy4 + 14;
  }
  /* The card and the power source used to be a line at the foot of this well.
   * The page buttons below took its room; the header carries both readings on
   * every other screen and the finder's bar carries them on SHOOT. */

  /*
   * The previous and next photograph, side by side above the stack. Greyed
   * at the roll's two ends rather than hidden, the way the gallery's page
   * buttons are: a control that disappears moves the other one. Within the
   * page a step opens the neighbour here; at the page's edge it turns the
   * page and returns to the grid, which is where the six new tiles decode.
   */
  const int bh = PH_BTN_H, bx = col_x, bw = PH_BTN_W;
  {
    int ignored;
    const bool has_prev = photo_neighbour(-1, &ignored);
    const bool has_next = photo_neighbour(1, &ignored);
    const int ppd = s_pressed == P_IT_PREV ? 1 : 0, nnd = s_pressed == P_IT_NEXT ? 1 : 0;
    const int nx0 = bx + PH_PN_W + PH_BTN_GAP;
    button(bx, PH_PN_Y, PH_PN_W, PH_PN_H, ppd != 0);
    arrow_glyph(bx + PH_PN_W / 2 + ppd, PH_PN_Y + PH_PN_H / 2 + ppd, false,
                has_prev ? W_TEXT : W_GRAYTEXT);
    button(nx0, PH_PN_Y, PH_PN_W, PH_PN_H, nnd != 0);
    arrow_glyph(nx0 + PH_PN_W / 2 + nnd, PH_PN_Y + PH_PN_H / 2 + nnd, true,
                has_next ? W_TEXT : W_GRAYTEXT);
  }

  /* The three controls, stacked at the foot of the column: DELETE at the top,
   * furthest from where the thumb rests, SEND TO ROLL in the middle and
   * FAVOURITE at the foot. */

  const int dy = PH_BTN_Y(0);
  const bool dd = s_pressed == P_IT_DELETE;
  /* Deleting a photograph is the one destructive thing a finger can reach on
   * this screen, and it is the only red on it. */
  if (dd) round_rect(bx, dy, bw, bh, UI_R, C_RED);
  else button(bx, dy, bw, bh, false);
  text_mid(&UI_FONT_T, bx + bw / 2, dy + (bh - UI_FONT_T.line_h) / 2, "DELETE",
           dd ? W_SELTEXT : C_RED_INK);
  /* Through foc(), not the raw array. P_IT_DELETE is 0 and s_focus[] starts
   * zeroed, so reading it directly put a focus ring on DELETE the first time
   * any photograph was opened, on a body whose only input is a finger. */
  if (foc(SCR_PHOTO, P_IT_DELETE)) focus_inset(bx, dy, bw, bh, W_TEXT);

  /* The star carries the state and the word carries the action, which is why
   * the label does not change between them: a button reading "UNFAVOURITE" on
   * a photograph that IS one, next to a lit star, says the same thing twice
   * and in two different grammars. The chip fills when it is a favourite, the
   * same way a live segment does on every other screen here. */
  const int fy = PH_BTN_Y(2);
  const bool fd = s_pressed == P_IT_FAV;
  const bool on = fd || s_photo_fav;
  if (on) round_rect(bx, fy, bw, bh, UI_R, W_SEL);
  else button(bx, fy, bw, bh, false);
  star(bx + 14, fy + (bh - STAR_H) / 2, on ? W_SELTEXT : W_GRAYTEXT);
  text_mid(&UI_FONT_T, bx + 14 + STAR_W + (bw - 14 - STAR_W) / 2, fy + (bh - UI_FONT_T.line_h) / 2,
           "FAVOURITE", on ? W_SELTEXT : W_TEXT);
  if (foc(SCR_PHOTO, P_IT_FAV)) focus_inset(bx, fy, bw, bh, W_TEXT);

  /* Live while the body is on a Roll; asleep, in the same shape, when it is
   * not - a control that vanishes teaches nothing. */
  const int ry = PH_BTN_Y(1);
  const bool rd = s_pressed == P_IT_ROLL;
  const bool on_roll = roll_state_active();
  if (rd) round_rect(bx, ry, bw, bh, UI_R, W_SEL);
  else if (on_roll) button(bx, ry, bw, bh, false);
  else round_rect(bx, ry, bw, bh, UI_R, W_WINDOW);
  text_mid(&UI_FONT_T, bx + bw / 2, ry + (bh - UI_FONT_T.line_h) / 2, "SEND TO ROLL",
           rd ? W_SELTEXT : on_roll ? W_TEXT : W_GRAYTEXT);
  if (foc(SCR_PHOTO, P_IT_ROLL)) focus_inset(bx, ry, bw, bh, W_TEXT);
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
  if (pitch < 1) return 0; /* no room ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the caller shows the code as text */

  const int side = total * pitch;
  const int x0 = cx - side / 2;

  /* White ground for the symbol and its quiet zone together. W_WINDOW is
   * 0xffffff and W_TEXT is 0x000000, so the symbol gets full contrast rather
   * than the 0xc0 face grey ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a QR drawn on the face ground scans poorly. */
  fill(x0, top, side, side, W_WINDOW);

  const int m0 = x0 + QR_QUIET * pitch;
  const int n0 = top + QR_QUIET * pitch;
  /* The modules are a 1-bit row-major bitmap, most significant bit first,
   * which is draw_bits()'s format - so the symbol is one command in the
   * display list rather than four hundred fills. Same pixels. */
  draw_bits(qr->modules[0], qr->size, qr->size, QR_ROW_BYTES, m0, n0, pitch, W_TEXT);
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
/*
 * The caption under the symbol, and the margin under that.
 *
 * This was 34 - an 8 px gap and an 18 px line, with nothing left for the page
 * margin - which was right for the bitmap face and wrong the moment the type
 * became Inter at 24: the address under the QR ended 13 px past the bottom of
 * the panel. 8 + 24 + PAGE_M is what it actually needs. The safe-area audit
 * in the renderer is what will catch the next drift, since a number written
 * down here cannot see the font.
 */
#define RL_CAP_H (8 + 24 + PAGE_M)
#define RL_QR_BOX (UI_H - RL_TOP - RL_CAP_H)
#define RL_QR_CX (RL_M + RL_QR_COL_W / 2)
#define RL_RX (RL_M + RL_QR_COL_W + 24)        /* right column */
#define RL_RW (UI_W - RL_M - RL_RX)
/*
 * One gap between the groups in the right column.
 *
 * It was 22 after the code, 30 after the connection word and 26 after the
 * count - three numbers for one relationship, each picked by eye against a
 * different neighbour, and together 18 px more than the column had room for.
 * The identity group is four things of the same kind stacked: a name, a code,
 * a state, a count. They get one interval.
 */
#define RL_GROUP 20

/* The symbol has to clear the panel with its caption under it. Checked rather
 * than trusted: RL_QR_BOX is the only number here that a change to HEAD_H
 * silently invalidates, and the failure mode is a QR running off the bottom. */
_Static_assert(RL_TOP + RL_QR_BOX + RL_CAP_H <= UI_H, "the ROLL QR falls off the bottom");
_Static_assert(RL_RW > 300, "the ROLL right column is too narrow for its numbers");


static void draw_roll(void) {
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_ROLL);

  roll_state_t roll;
  const bool active = roll_state_get(&roll);

  upload_queue_report_t q;
  upload_queue_status(&q);

  const net_status_t net = *net_status();
  const bool online = net_link_can_upload(&net);

  if (!active) {
    /* No Roll. Say how to get one rather than only that there isn't one ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â and
     * do not offer a CREATE button, because ROLL_CREATE is an HTTP POST this
     * body cannot make. A control that cannot work is the same defect as a
     * shutter that logs instead of capturing. */
    /* This state's whole job is telling someone how to start a roll, so it
     * gets the panel rather than three lines in the top third. */
    /* The heading and its two lines are one block, centred in the space above
     * the card well rather than pinned under the header - pinned, it left a
     * 150 px hole in the middle of the panel with the well at the foot. */
    /*
     * One block, not three things floating.
     *
     * The heading, its two lines and the card fact were spaced by three
     * separate calculations and left 90 px of nothing above the heading and
     * another 95 between the lines and the well - on a screen that was 71%
     * bare ground, which is the most of any in the product. They are measured
     * as one block now and centred as one, the way every other screen's body
     * is.
     */
    const int wh = 76;
    const int lead = UI_FONT_M.line_h + 4;
    const int block_h = UI_FONT_L.line_h + 22 + 2 * lead + 28 + wh;
    int hy = body_top(block_h);
    text_mid(&UI_FONT_L, UI_W / 2, hy, "NO ACTIVE ROLL", W_TEXT);
    hy += UI_FONT_L.line_h + 22;

    text_mid(&UI_FONT_M, UI_W / 2, hy, "Make a roll in Studio over USB-C.", W_TEXT);
    text_mid(&UI_FONT_M, UI_W / 2, hy + lead, "It appears here with a code guests scan.", W_TEXT);
    const int wy = hy + 2 * lead + 28;

    /* The card line, in a well at the foot, and made to mean something. The
     * count alone answers "how many" but not the question someone on this
     * screen is actually asking, which is what becomes of them. Photos on the
     * card are not stranded for want of a roll - they import over USB-C either
     * way - and saying so is the difference between a number and an answer. */
    /* The index's count, exact and from RAM - gallery_total() is the shown
     * list's length, capped, and 0 before the first walk (gallery.h). */
    const int n = gallery_media_count() < 0 ? 0 : gallery_media_count();
    well(RL_M, wy, UI_W - 2 * RL_M, wh);
    if (n > 0) {
      char line[56];
      snprintf(line, sizeof line, "%d PHOTO%s ON THE CARD", n, n == 1 ? "" : "S");
      text_mid(&UI_FONT_R, UI_W / 2, wy + 12, line, W_TEXT);
      text_mid(&UI_FONT_S, UI_W / 2, wy + 44,
               "They import over USB-C, and upload if a roll is assigned later.", W_GRAYTEXT);
    } else {
      text_mid(&UI_FONT_R, UI_W / 2, wy + 12, "NO PHOTOS ON THE CARD", W_TEXT);
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
   * codeword buffers on the caller's stack ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â which here is the UI task's. Nine
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

      /* The address under the symbol, without its scheme: a guest whose phone
       * will not scan types this. Secondary to the QR by size and colour. */
      const char *addr = roll.guest_url;
      if (strncmp(addr, "https://", 8) == 0) addr += 8;
      else if (strncmp(addr, "http://", 7) == 0) addr += 7;
      if (text_w(&UI_FONT_S, addr) <= RL_QR_COL_W - 8) {
        text_mid(&UI_FONT_S, RL_QR_CX, RL_TOP + side + 8, addr, W_GRAYTEXT);
      } else {
        text_mid(&UI_FONT_T, RL_QR_CX, RL_TOP + side + 8, "SCAN TO JOIN", W_GRAYTEXT);
      }
    }
  } else {
    /* The URL did not encode, so the column shows the code itself, big. A
     * guest can still type it, which is worth more than a QR-shaped block no
     * phone reads - and at this size it is legible from where the QR would
     * have been scanned from, which is the point of giving it the column. */
    const ui_font_t *cf = fit_face(roll.slug, RL_QR_COL_W - 20);
    const int cy = RL_TOP + RL_QR_BOX / 2 - cf->line_h;
    text_mid(cf, RL_QR_CX, cy, roll.slug, W_TEXT);
    text_mid(&UI_FONT_S, RL_QR_CX, cy + cf->line_h + 16, "Enter this code to join", W_GRAYTEXT);
    text_mid(&UI_FONT_S, RL_QR_CX, cy + cf->line_h + 38,
             "The join link is too long to encode.", W_GRAYTEXT);
  }

  /* ---- right column: the roll, and what is happening to it ----
   *
   * Name, code, one word for the connection, one big number for the card,
   * and then only what is useful right now: nothing waiting reads "All
   * uploaded" and when the last one landed; work in flight reads a count, a
   * bar and "Uploading now"; work waiting with no way to send it reads the
   * count and "Saved safely on camera". No queue internals reach a guest at a
   * party. */
  const int64_t now = esp_timer_get_time() / 1000;
  const bool server_quiet = online && q.server_state == UPLOAD_SERVER_UNREACHABLE;
  const bool can_send = online && !server_quiet && !q.halted;
  const int waiting = q.pending + q.card_pending;

  const char *title = roll.name[0] != '\0' ? roll.name : roll.slug;
  int y = RL_TOP;
  const ui_font_t *tf = fit_face(title, RL_RW);
  text(tf, RL_RX, y, title, W_TEXT);
  y += tf->line_h + 10;
  if (roll.name[0] != '\0') {
    /* The code, named, in a well. Only when the name is not already the code.
     *
     * It is the one string on this screen a guest reads out or types when a
     * phone will not scan, and it was the quietest thing in the column: grey,
     * at body size, under a name set twice as large. A value someone copies
     * belongs in a well on this interface - it is where the look's name sits
     * on LOOK and where every reading sits on ABOUT - and that well is also
     * the container this column never had. */
    text(&UI_FONT_T, RL_RX, y, "CODE", W_GRAYTEXT);
    y += UI_FONT_S.line_h + 4;
    well(RL_RX, y, RL_RW, UI_FONT_M.line_h + 12);
    text(&UI_FONT_M, RL_RX + 10, y + 6, roll.slug, W_TEXT);
    y += UI_FONT_M.line_h + 12 + RL_GROUP;
  }

  /* The connection word, with a square lamp in front of it. Green is "your
   * photographs are leaving the camera"; grey is "not right now"; the third
   * colour is the one case a guest can do nothing about and should not be
   * told is their Wi-Fi. */
  {
    const char *word;
    uint16_t lamp;
    if (q.halted) {
      word = "UPLOAD PAUSED";
      lamp = C_BAD;
    } else if (server_quiet) {
      word = "KINO NOT ANSWERING";
      lamp = C_BAD;
    } else if (online) {
      word = "ONLINE";
      lamp = C_OK;
    } else {
      word = "OFFLINE";
      lamp = W_SHADOW;
    }
    const int ly = y + (UI_FONT_M.line_h - 12) / 2;
    fill(RL_RX, ly, 12, 12, W_TEXT);
    fill(RL_RX + 2, ly + 2, 8, 8, lamp);
    text(&UI_FONT_M, RL_RX + 22, y, word, W_TEXT);
    y += UI_FONT_M.line_h + RL_GROUP;
  }

  /* The card, as one big number. gallery_media_count() is the index in RAM,
   * exact, the same figure the Storage screen shows; -1 only before the
   * first index read after boot. */
  {
    const int total = gallery_media_count();
    char big[24];
    if (total < 0) snprintf(big, sizeof big, "- PHOTOS");
    else snprintf(big, sizeof big, "%d %s", total, total == 1 ? "PHOTO" : "PHOTOS");
    const ui_font_t *bf = fit_face(big, RL_RW);
    text(bf, RL_RX, y, big, W_TEXT);
    y += bf->line_h + RL_GROUP;
  }

  /* What is happening to them. Three lines at most. */
  char l1[48] = "", l2[48] = "", l3[48] = "";
  bool bar = false;
  int bar_done = 0, bar_total = 0;
  if (q.halted) {
    snprintf(l1, sizeof l1, "%d waiting to upload", waiting);
    snprintf(l2, sizeof l2, "Saved safely on camera");
    snprintf(l3, sizeof l3, "Check the roll in Studio.");
  } else if (waiting > 0 || q.uploading > 0) {
    snprintf(l1, sizeof l1, "%d waiting to upload", waiting);
    if (can_send) {
      bar = true;
      bar_done = q.burst_done;
      bar_total = q.burst_done + waiting + q.uploading;
      snprintf(l2, sizeof l2, "%s", q.uploading > 0 ? "Uploading now" : "Starting upload");
    } else {
      snprintf(l2, sizeof l2, "Saved safely on camera");
      snprintf(l3, sizeof l3, "%s",
               server_quiet ? "Wi-Fi is up. They go when KINO answers."
                            : "They go when Wi-Fi returns.");
    }
  } else if (!q.scan_complete) {
    /* Nothing waiting that the queue knows of, and it has not seen the
     * whole card since boot. Honest for the seconds it lasts. */
    snprintf(l1, sizeof l1, "COUNTING THE CARD");
  } else if (q.last_upload_ms > 0) {
    snprintf(l1, sizeof l1, "All uploaded");
    const int64_t ago_s = (now - q.last_upload_ms) / 1000;
    if (ago_s < 60) snprintf(l2, sizeof l2, "Last upload %llds ago", (long long)ago_s);
    else if (ago_s < 3600) snprintf(l2, sizeof l2, "Last upload %lldm ago", (long long)(ago_s / 60));
    else snprintf(l2, sizeof l2, "Last upload %lldh ago", (long long)(ago_s / 3600));
  } else if (can_send) {
    snprintf(l1, sizeof l1, "All uploaded");
  } else {
    snprintf(l1, sizeof l1, "Nothing waiting");
    if (!online) snprintf(l2, sizeof l2, "Uploads resume when Wi-Fi returns.");
  }

  /* Straight on from the count: the column is one stack of the roll's facts,
   * top to bottom, with one interval between them. The status block used to
   * be pinned to the page's foot, which left a hole in the middle of the
   * column the size of whatever the camera had to say. The longest state -
   * four lines - still ends 60 px clear of the bottom. */

  if (l1[0]) { text(&UI_FONT_M, RL_RX, y, l1, W_TEXT); y += UI_FONT_M.line_h + 14; }
  if (bar) {
    /* The bar exists only while there is work: a full or empty bar with
     * nothing behind it would be a decoration. */
    const int bw = RL_RW - 4, bh = 14;

    fill(RL_RX + 2, y + 2, bw - 4, bh - 4, W_HILITE);
    if (bar_total > 0) {
      const int fw = (int)((int64_t)(bw - 4) * bar_done / bar_total);
      /* The accent, like the storage gauge. It was 0000A8 - the 1998 desktop's
       * navy, the one colour the redesign was there to remove. */
      if (fw > 0) fill(RL_RX + 2, y + 2, fw, bh - 4, W_SEL);
    }
    y += bh + 14;
  }
  /* The two reading lines wrap. They are sentences, not labels, and the
   * longest of them - "Wi-Fi is up. They go when KINO answers." - is 386 px
   * against a 344 px column, so it had been losing "answers" off the right of
   * the panel on the one screen a guest reads at a party. */
  if (l2[0]) { y += text_block(&UI_FONT_S, RL_RX, y, RL_RW, l2, W_GRAYTEXT) + 10; }
  if (l3[0]) { text_block(&UI_FONT_S, RL_RX, y, RL_RW, l3, W_GRAYTEXT); }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

static const char *const SET_ROWS[6] = {"Display", "Sound",   "Connection",
                                        "Storage", "About",   "Status"};
static const screen_t SET_DEST[6] = {SCR_DISPLAY, SCR_SOUND, SCR_CONNECTION,
                                     SCR_STORAGE, SCR_ABOUT, SCR_STATUS};

/*
 * Six rows when the camera has something to say, five when it does not.
 *
 * The conditions used to be a panel at the foot of this screen, and the panel
 * had room for two of them - so a camera with four things wrong showed two and
 * the words "and 2 more", and there was nowhere in the product to read the
 * rest. D4_INTERACTION.md called that out before it was built: the conditions
 * are a list, and a list belongs on a screen.
 */
static int settings_rows(void) { return conditions_count() > 0 ? 6 : 5; }

/*
 * Five rows, each carrying what it is set to.
 *
 * They were five bare names with a chevron at the far right - five doors, and
 * the only way to learn the camera's state was to open all of them and come
 * back. A settings list that shows its values is the state of the machine on
 * one screen, which is what someone opens SETTINGS to find out: is the sound
 * on, is it on the network, how much card is left.
 *
 * Every value is read the same way its own screen reads it. Nothing here
 * paraphrases a setting or keeps a second copy of one - a summary that drifts
 * from the screen it summarises is worse than no summary.
 */
static void settings_summary(int i, char *out, size_t cap) {
  out[0] = 0;
  if (i == 5) {
    /* The worst one, by name. A count on its own ("3 conditions") is a number
     * a person has to open the screen to understand; the title of the worst
     * of them is the thing they would have opened it to read. */
    const cond_t *w = conditions_at(0);
    const int n = conditions_count();
    if (w == NULL) return;
    if (n > 1) snprintf(out, cap, "%s, and %d more", w->title, n - 1);
    else snprintf(out, cap, "%s", w->title);
    return;
  }
  switch (i) {
    case 0: { /* Display: the sleep timeout, which is the one that changes behaviour */
      const int s_sleep = config_int("body.sleepS", 120);
      if (s_sleep >= 60) snprintf(out, cap, "%d min", s_sleep / 60);
      else snprintf(out, cap, "%d s", s_sleep);
      break;
    }
    case 1: { /* Sound: off when both families are, else the volume it is set to */
      const bool shut = config_bool("body.sounds.save", true);
      const bool ui = config_bool("body.sounds.ui", true);
      if (!shut && !ui) snprintf(out, cap, "Off");
      else snprintf(out, cap, "%d", config_int("shoot.volume", 6));
      break;
    }
    case 2: { /* Connection: the network it is actually on */
      const net_status_t net = *net_status();
      if (net.state == NET_IP_READY && net.ssid[0]) snprintf(out, cap, "%s", net.ssid);
      else snprintf(out, cap, "Not connected");
      break;
    }
    case 3: { /* Storage: what is left, in the unit a photographer counts in */
      const storage_status_t sd = *sd_status();
      if (!sd.mounted) snprintf(out, cap, "No card");
      else snprintf(out, cap, "%d left", (int)(sd.free_bytes / (6ull * 1024 * 1024)));
      break;
    }
    default: snprintf(out, cap, "%s", KINO_FW_VERSION); break;
  }
}

/*
 * What is wrong with the camera, under what it is set to.
 *
 * This is the third of the screen that was empty grey, and conditions are the
 * right thing to put in it: a list of settings is where someone goes to find
 * out about the body, and the body's own state was the one thing they could
 * not find out there. No new screen, because a screen needs a baked title
 * bitmap and the baker is a Playwright job with a hard-coded path on somebody
 * else's desktop - which is its own finding, and why this is in the space the
 * list already had rather than behind a sixth row.
 *
 * When nothing is wrong it says so. A status area that is blank when all is
 * well is indistinguishable from one that is broken.
 */

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

/**
 * Everything the camera has to say about itself, in one list.
 *
 * This was two lines and the words "and 2 more" at the foot of SETTINGS, on a
 * panel that had room for two conditions however many there were - so a body
 * with four things wrong could not be read anywhere in the product. The chip
 * in the header has always carried the true count; this is where the count
 * goes when you touch it.
 *
 * Each condition gets a row in the list grammar, its severity as the tone of
 * its mark rather than of the whole row: a screen of red cards reads as a
 * camera on fire, and three of these six are notes.
 */
/*
 * The one thing a person can DO on STATUS: ask for the cameras to be measured
 * again. Calibration runs once, on the first photograph, and nothing on the
 * camera could ask for it a second time - a lens knocked, a body reassembled,
 * and the offsets stayed. This clears the stored result; the next photograph
 * measures, as the first one did. Drawn at the foot, and only while there is
 * a result to clear and room under the list for the row.
 */
#define STS_IT_REMEASURE 0
static int sts_action_y(int rows) {
  const int y = UI_H - PAGE_M - (ROW_H - ROW_GAP);
  return LIST_TOP_DEFAULT + rows * ROW_H <= y - 8 ? y : -1;
}
static bool sts_has_action(void) { return config_bool("body.calibration.done", false); }
static void draw_status_action(int rows) {
  const int y = sts_action_y(rows);
  if (!sts_has_action() || y < 0) return;
  draw_row_at(LIST_X, LIST_W, y, ROW_H - ROW_GAP, 0, false, foc(SCR_STATUS, STS_IT_REMEASURE),
              s_pressed == STS_IT_REMEASURE, true, "Measure cameras again",
              "The next photograph measures them", true);
}

static void draw_status(void) {
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_STATUS);

  const int n = conditions_count();
  if (n == 0) {
    /* The screen is reachable from the header chip's own count, so it can be
     * opened at the moment the last condition clears. */
    s_list_top = LIST_TOP_DEFAULT;
    text_mid(&UI_FONT_L, UI_W / 2, UI_H / 2 - UI_FONT_L.line_h, "NOTHING TO REPORT", W_TEXT);
    text_mid(&UI_FONT_S, UI_W / 2, UI_H / 2 + 8, "The camera has no complaints.", W_GRAYTEXT);
    draw_status_action(0);
    return;
  }

  const int rows = n < 6 ? n : 6;
  /*
   * From the header, like every other list. Lists used to be centred when
   * they did not fill the page (body_top), which put the first row of POWER
   * and STATUS a third of the way down and the first row of SETTINGS at the
   * top - the same control in a different place on every screen, which is
   * the one thing a thumb cannot learn. A list hangs from the header now,
   * and the room under a short one is room.
   */
  s_list_top = LIST_TOP_DEFAULT;

  for (int i = 0; i < rows; i++) {
    const cond_t *c = conditions_at(i);
    const int y = LIST_Y + i * ROW_H;
    const int h = ROW_H - ROW_GAP;
    round_rect(LIST_X, y, LIST_W, h, UI_R, W_ROW);

    /* The severity twice, in one colour: a bar down the row's edge, which
     * reads across the room, and the word at the right, which reads up
     * close. An alert is not a destination, so no chevron. */
    fill(LIST_X, y + 10, 4, h - 20, sev_ink(c->sev));
    text_right(&UI_FONT_T, LIST_X + LIST_W - 18, y + 12, sev_word(c->sev), sev_ink(c->sev));

    char name[48];
    snprintf(name, sizeof name, "%s", c->title);
    upcase(name);
    const int tx = LIST_X + 18;
    text(&UI_FONT_R, tx, y + 6, name, W_TEXT);
    /* What to do about it, which is the only reason to list a condition at
     * all - a fault a person can do nothing about is a log line. */
    char det[64];
    text_fit(det, sizeof det, &UI_FONT_S, c->detail, LIST_W - 18 - 18 - 70);
    text(&UI_FONT_S, tx, y + 6 + UI_FONT_R.line_h - 4, det, dim_ink(W_TEXT, W_ROW));
  }
  draw_status_action(rows);
}

static void draw_settings(void) {
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_SETTINGS);
  const int rows = settings_rows();
  s_list_top = LIST_TOP_DEFAULT;
  draw_list_frame(5);
  for (int i = 0; i < rows; i++) {
    char v[40];
    settings_summary(i, v, sizeof v);
    draw_row(i, foc(SCR_SETTINGS, i), s_pressed == i, true, SET_ROWS[i],
             v[0] ? v : NULL, true);
  }
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
/* 44, the floor a thumb needs and what every other control here measures;
 * the pitch grew by the same four pixels so the group boxes still clear
 * each other. Four bands and the brightness note end at 433 of 480. */
#define DSP_PITCH 82
#define DSP_BAND_H 52 /* 6.1 mm on this glass; 44 was 5.2 */
#define DSP_X (PAGE_M + 8)
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

/* The picker's two buttons, at the right-hand end of the row. 44, not 36:
 * they were the last two controls on the interface under the thumb floor,
 * and the 58 px row has room for them. */
#define SN_BTN 52 /* 6.1 mm on this glass, the most a 58 px row holds */
#define SN_VOL_H 52 /* the volume band, at the same floor as DISPLAY's */

/* The picker's two buttons and the value beside them, right-aligned in the
 * row the same way a toggle is. */
static int sn_next_x(void) { return LIST_X + LIST_W - 14 - SN_BTN; }
static int sn_prev_x(void) { return sn_next_x() - 6 - SN_BTN; }
static int sn_btn_y(void) { return LIST_Y + (ROW_H - ROW_GAP - SN_BTN) / 2; }

static void draw_sound(void) {
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_SOUND);
  /* Three rows, the volume group below them, and two lines of note. */
  s_list_top = LIST_TOP_DEFAULT;

  const bool shut = config_bool("body.sounds.save", true);
  const bool ui = config_bool("body.sounds.ui", true);

  draw_list_frame(3);

  /* Which sound the shutter makes, above the two rows that decide whether a
   * sound is made at all. Those two used to be titled "Shutter sound" and
   * "Button sound", which now collides with the picker - they are renamed to
   * what they actually do, which is switch a sound on and off. */
  /*
   * The clip is the row's VALUE, not a second thing laid over the row.
   *
   * The two picker buttons used to sit at the row's vertical centre with the
   * clip name right-aligned beside them, which worked while a row was one
   * line with nothing in the middle of it. A row is two lines now - a name
   * and what it is set to - so the buttons were drawn straight through the
   * word SHUTTER SOUND. The row already has a place for the clip; it goes
   * there, and the buttons take the right-hand end that the chevron would
   * have had.
   */
  char clip[KDP_SOUND_NAME_MAX + 32];
  {
    char name[KDP_SOUND_NAME_MAX];
    snd_display(name, sizeof name);
    char pos[24];
    snd_position(pos, sizeof pos);
    if (pos[0] != '\0') snprintf(clip, sizeof clip, "%s   %s", name, pos);
    else snprintf(clip, sizeof clip, "%s", name);
  }
  draw_row(0, false, false, true, "Shutter sound", clip, false);
  {
    const int by = sn_btn_y(), nx = sn_next_x(), px = sn_prev_x();
    const bool pd = s_pressed == SN_IT_PREV, nd = s_pressed == SN_IT_NEXT;
    control(px, by, SN_BTN, SN_BTN, UI_R - 2, pd, W_ROW);
    picker_arrow(px + SN_BTN / 2, by + SN_BTN / 2, false, W_TEXT);
    control(nx, by, SN_BTN, SN_BTN, UI_R - 2, nd, W_ROW);
    picker_arrow(nx + SN_BTN / 2, by + SN_BTN / 2, true, W_TEXT);
    if (foc(SCR_SOUND, SN_IT_PREV)) focus_inset(px, by, SN_BTN, SN_BTN, W_TEXT);
    if (foc(SCR_SOUND, SN_IT_NEXT)) focus_inset(nx, by, SN_BTN, SN_BTN, W_TEXT);
  }

  draw_row(1, foc(SCR_SOUND, SN_IT_SHUTTER), s_pressed == SN_IT_SHUTTER, true,
           "Play shutter sound", NULL, false);
  draw_toggle(LIST_X + LIST_W - 18 - 52, LIST_Y + ROW_H + (ROW_H - ROW_GAP - 28) / 2, shut, false,
              s_pressed == SN_IT_SHUTTER ? W_SEL : W_ROW);
  draw_row(2, foc(SCR_SOUND, SN_IT_BUTTON), s_pressed == SN_IT_BUTTON, true,
           "Play button sound", NULL, false);
  draw_toggle(LIST_X + LIST_W - 18 - 52, LIST_Y + 2 * ROW_H + (ROW_H - ROW_GAP - 28) / 2, ui, false,
              s_pressed == SN_IT_BUTTON ? W_SEL : W_ROW);

  const int y = LIST_Y + 3 * ROW_H + 26;
  /* The one control on this screen that sat outside the list well, under a
   * bare word. Same treatment as every other band on the camera, and the box
   * reaches to the window margin the list well uses rather than to the band
   * the band happens to be drawn at. */
  group_box(LIST_X, y, LIST_W, 24 + SN_VOL_H + 6, "VOLUME", W_TEXT, NULL);
  static const char *const VOL[3] = {"LOW", "MEDIUM", "HIGH"};
  static const int VOLV[3] = {3, 6, 9};
  draw_segments(LIST_X + 8, y + 24, LIST_W - 16, SN_VOL_H, VOL, 3,
                nearest_idx(config_int("shoot.volume", 6), VOLV), band_rel(s_pressed, SN_IT_VOL, 3),
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
  const int ny = y + 24 + SN_VOL_H + 30;
  char line[72];

  if (!audio_ready()) {
    /* Named as hardware, not as a setting. "Muted" would read as something a
     * user did and can undo from this screen, and it is not. */
    text(&UI_FONT_M, PAGE_M, ny, "No audio output on this body", W_TEXT);
    text(&UI_FONT_S, PAGE_M, ny + 30,
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
  /* On the page rule. The notes on this screen, CONNECTION and STORAGE sat
   * at a literal 24 while every card starts at PAGE_M, which put a second
   * left edge 8 px inside the first down the whole lower half of the panel. */
  text(&UI_FONT_S, PAGE_M, ny, line, W_GRAYTEXT);
  text(&UI_FONT_S, PAGE_M, ny + 20, "Upload your own in Studio over USB-C.", W_GRAYTEXT);
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
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_CONNECTION);
  /* Seven rows and the line under them, from the header like every list. */
  s_list_top = LIST_TOP_DEFAULT;

  const net_status_t net = *net_status();

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
   * rather than "Connected" ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â claiming connected there is how a camera
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
  const int lh = n * pitch;
  for (int i = 0; i < n; i++) {
    fact_row(LIST_X, LIST_W, LIST_Y + i * pitch, pitch, ROWS[i].title, ROWS[i].value,
             ROWS[i].enabled, i == n - 1);
  }

  /* One line, and it has to say which of the two things is wrong. There is no
   * on-screen keyboard on purpose: a passphrase entered on a 480x800 panel
   * with no physical keys is worse than the USB path, and building a bad one
   * to claim independence from Studio would be the wrong trade. */
  const int y = LIST_Y + lh + 18;
  if (!net.radio_fitted) {
    text(&UI_FONT_S, PAGE_M, y, "No radio on this body. Photos leave over USB-C.", W_GRAYTEXT);
  } else if (!net.radio_routed) {
    text(&UI_FONT_S, PAGE_M, y, "The C6 radio is fitted, but this firmware has no", W_GRAYTEXT);
    text(&UI_FONT_S, PAGE_M, y + 20, "route to it. Photos leave over USB-C.", W_GRAYTEXT);
  } else if (net.state != NET_IP_READY) {
    text(&UI_FONT_S, PAGE_M, y, "Set up Wi-Fi in Studio over USB-C.", W_GRAYTEXT);
  } else {
    text(&UI_FONT_S, PAGE_M, y, "Captures upload to the active roll.", W_GRAYTEXT);
  }
}

/* --- Storage ------------------------------------------------------ */

/* The two live rows on the storage screen, in the order they are drawn. DELETE
 * ALL PHOTOS is above FORMAT CARD because it is the one someone actually
 * wants: it clears the pictures and leaves the sounds, the looks, the config
 * and the upload queue alone, where FORMAT takes everything. */
#define ST_IT_DELETE_ALL 0
#define ST_IT_COUNT 1

/*
 * Three facts, the gauge with its two readings under them, then the two rows
 * that act. The facts and the gauge are one group - what the card is and how
 * full it is - and the actions are another; the gauge used to sit under the
 * action rows, 150 px from the numbers it illustrated.
 */
#define ST_FACT_H 46
#define ST_GAUGE_H 18  /* the capacity bar */
#define ST_READ_GAP 8  /* gauge to its two readings */
#define ST_GAUGE_Y (LIST_Y + 3 * ST_FACT_H + 14)
/* The action rows, from the readings' baseline down. Draw and hit test both
 * read this. */
#define ST_ACT_Y(i) (ST_GAUGE_Y + ST_GAUGE_H + ST_READ_GAP + UI_FONT_S.line_h + 20 + (i) * ROW_H)

static void draw_storage(void) {
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_STORAGE);
  /*
   * Five rows, then the gauge and its two readings.
   *
   * The three gaps and the gauge height are named because their sum is the
   * only thing keeping the last line off the bottom of the panel, and for a
   * while it was not keeping it off: 320 of rows plus 28 + 26 + 8 + 24 is
   * 406 px of content in a 401 px body, so body_top() gave up on centring,
   * pinned the list to the top, and the two readings ended 1 px past the
   * bottom edge with their descenders in the bezel. Nobody saw it on a
   * screenshot - a clipped descender looks like a font - and the renderer's
   * safe-area audit is what found it.
   *
   * The 5 px came off the gauge and the gaps rather than off the margin: the
   * bar is a capacity ratio, and 18 px reads that as well as 26 did while
   * sitting closer to the rhythm of the rows above it.
   */
  /* This list fills the body, so body_top() always pinned it here anyway; the
   * renderer's safe-area audit is what guards the last line. */
  s_list_top = LIST_TOP_DEFAULT;

  const storage_status_t sd = *sd_status();
  char freeb[24], capb[24], cnt[16];
  human_bytes(freeb, sizeof freeb, sd.free_bytes);
  human_bytes(capb, sizeof capb, sd.capacity_bytes);
  /*
   * The card's own count, not the gallery screen's.
   *
   * gallery_total() is how many captures the gallery LIST holds, capped at
   * MAX_SCAN (240) and zero until the first walk has published. On a card of
   * hundreds it under-reports, and before the walk it reads 0 - which is what
   * put "0" on this row over a card holding a thousand photographs and, worse,
   * disabled Delete All along with it. storage_media_count_cached() counts
   * capture directories holding a committed META.JSON, exhaustively, and
   * remembers the answer so this draw path pays nothing.
   */
  /*
   * From the gallery's index, not a card walk.
   *
   * storage_media_count_cached() walks the card, and calling it from this draw
   * path was the 0.4.39 regression: every shutter invalidates the count, so on
   * a 1,325-directory card the walk ran on every redraw holding the card lock
   * and grouped captures went from 4 s to 75 s. The index answers from RAM.
   * The storage counter remains for reconciliation and recovery.
   */
  const int media = gallery_media_count();
  if (media < 0) snprintf(cnt, sizeof cnt, "-");
  else snprintf(cnt, sizeof cnt, "%d", media);

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
  fact_row(LIST_X, LIST_W, LIST_Y, ST_FACT_H, "Card", sd.mounted ? capb : "None", true, false);
  /* Low space is said where the number is, not discovered at a failed
   * shutter. 512 MB is about 650 four-camera captures at the bench median of
   * 0.77 MB per capture; below it the row appends LOW. */
  char freerow[40];
  const bool low = sd.mounted && sd.free_bytes < (512ull << 20);
  snprintf(freerow, sizeof freerow, "%s%s", sd.mounted ? freeb : "-", low ? "  LOW" : "");
  fact_row(LIST_X, LIST_W, LIST_Y + ST_FACT_H, ST_FACT_H, "Free space", freerow, true, false);
  fact_row(LIST_X, LIST_W, LIST_Y + 2 * ST_FACT_H, ST_FACT_H, "Photos", wiping ? busy : cnt, true,
           true);
  /* Both destructive rows are live only with a card mounted, and neither is
   * live while the other is running: a FORMAT pressed into a running wipe
   * would be two things deleting the same directory. */
  draw_row_at(LIST_X, LIST_W, ST_ACT_Y(0), ROW_H - ROW_GAP, 3, false,
              foc(SCR_STORAGE, ST_IT_DELETE_ALL), s_pressed == ST_IT_DELETE_ALL,
              sd.mounted && !wiping && media > 0, "Delete all photos", NULL, true);
  /* Drawn dimmed: there is no format entry point in storage.c, and a live
   * row that opens a confirm dialog and then says "not available" is a
   * control that lies twice. The row stays so the layout and the hit test
   * (row minus three) do not move. */

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
  const int by = ST_GAUGE_Y;

  if (!sd.mounted) {
    /* Why, not just that. mount_attempts separates "no card in the slot" from
     * "a card the driver has tried and failed to mount", which are different
     * problems and the screen used to show the same "None" for both. */
    text(&UI_FONT_M, PAGE_M, by, sd.present ? "Card present, not mounted" : "No card in the slot",
         W_TEXT);
    char detail[80];
    if (sd.last_error != NULL && sd.last_error[0] != '\0') {
      snprintf(detail, sizeof detail, "%s, after %u mount attempt%s", sd.last_error,
               (unsigned)sd.mount_attempts, sd.mount_attempts == 1 ? "" : "s");
    } else {
      snprintf(detail, sizeof detail, "%u mount attempt%s since boot",
               (unsigned)sd.mount_attempts, sd.mount_attempts == 1 ? "" : "s");
    }
    text(&UI_FONT_S, PAGE_M, by + 30, detail, W_GRAYTEXT);
    return;
  }

  /* The gauge. A track and a fill, both with the product's corner on them; the
   * fill used to carry a bevel of its own in two tones of the selection colour,
   * which was the one raised surface on the interface that was not face grey
   * and is now the one rounded surface that is not a card. */
  const int bx = PAGE_M, bw = UI_W - 2 * PAGE_M, bh = ST_GAUGE_H;
  const uint64_t total_b = sd.capacity_bytes;
  const uint64_t used = total_b > sd.free_bytes ? total_b - sd.free_bytes : 0;
  round_rect(bx, by, bw, bh, bh / 2, W_WINDOW);
  if (total_b > 0) {
    /* 64-bit before the divide: a 32 GB card times bw overflows 32 bits. */
    int fw = (int)((used * (uint64_t)(bw - 6)) / total_b);
    /* A card with anything at all on it shows at least one pixel: a bar that
     * is empty at 40 MB used looks like a bar that is not working. */
    if (fw < bh - 6 && used > 0) fw = bh - 6;
    round_rect(bx + 3, by + 3, fw, bh - 6, (bh - 6) / 2, W_SEL);
  }

  char usedb[24];
  human_bytes(usedb, sizeof usedb, used);
  char line[80];
  snprintf(line, sizeof line, "%s used", usedb);
  text(&UI_FONT_S, bx, by + bh + ST_READ_GAP, line, W_GRAYTEXT);
  /* The write test is the only thing here that says the card can be WRITTEN
   * to, which is the property a capture depends on and free space is not. */
  snprintf(line, sizeof line, "%s, write test %s", sd.filesystem != NULL ? sd.filesystem : "-",
           sd.write_test != NULL ? sd.write_test : "none");
  text_right(&UI_FONT_S, bx + bw, by + bh + ST_READ_GAP, line, W_GRAYTEXT);
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

  const storage_status_t sd = *sd_status();

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

  /* ---- left column: the body ----
   *
   * The name first, when someone has set one: it is the row a person put
   * there, and it goes where a person looks first. It was a box of its own
   * under the table. */
  typedef struct {
    const char *title;
    const char *value;
  } ab_row_t;
  ab_row_t ROWS[8];
  int n = 0;
  if (named) ROWS[n++] = (ab_row_t){"Name", name};
  ROWS[n++] = (ab_row_t){"Model", "KINO D4"};
  ROWS[n++] = (ab_row_t){"Hardware", KDP_HARDWARE_REV};
  ROWS[n++] = (ab_row_t){"Firmware", KINO_FW_VERSION};
  ROWS[n++] = (ab_row_t){"Serial", serial[0] != '\0' ? serial : "-"};
  ROWS[n++] = (ab_row_t){"Protocol", proto};
  ROWS[n++] = (ab_row_t){"Card", card};
  ROWS[n++] = (ab_row_t){"Uptime", up};

  s_list_top = LIST_TOP_DEFAULT;
  for (int i = 0; i < n; i++) {
    fact_row(AB_LX, AB_LW, LIST_Y + i * AB_ROW, AB_ROW, ROWS[i].title, ROWS[i].value, true,
             i == n - 1);
  }

  /* ---- right column: the four cameras ----
   *
   * CAMERAS was a bare grey word sitting above a well, which on a two-column
   * screen is ambiguous about which column it names. It is the legend of a
   * group box now, and the box encloses the well AND the two lines of note
   * under it - the note is about these four rows and nothing else, and there
   * was no mark on the screen that said so. */
  text(&UI_FONT_T, AB_RX + 4, LIST_Y + (AB_ROW - UI_FONT_T.line_h) / 2, "CAMERAS", W_GRAYTEXT);
  fill(AB_RX, LIST_Y + AB_ROW - 1, AB_RW, 1, W_RULE);
  const int cy0 = LIST_Y + AB_ROW;
  const int ch = 4 * AB_CAM_ROW;
  const char *NOTE = "Node firmware, then the sensor each node reports.";
  const int note_y = cy0 + ch + 12;

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
    fact_row(AB_RX, AB_RW, cy0 + i * AB_CAM_ROW, AB_CAM_ROW, label, val, info->online, i == 3);
  }

  /* Node firmware is per camera and the four can differ - a node reflashed on
   * its own is the normal way that happens - which is the whole reason this is
   * four rows and not one summary line. */
  text_block(&UI_FONT_S, AB_RX, note_y, AB_RW, NOTE, W_GRAYTEXT);

  /*
   * Who made it.
   *
   * At the foot of the one screen that says what this object is, with the
   * studio's own mark beside its name - the same mark the camera opens with,
   * drawn by the same function at a twentieth of the size. A maker's plate:
   * every other line on this screen is a fact about the machine, and this is
   * the one about the people.
   */
  {
    /* The plate is as tall as the two lines in it. It was pinned to a flat 34
     * and set two lines of 18 and 24 inside that, so "Studio" hung 12 px below
     * where the plate claimed to end and finished 12 px past the page margin -
     * the mark beside it looked high for the same reason, being centred on a
     * box shorter than its contents. */
    const int plate_h = 4 + UI_FONT_T.line_h + UI_FONT_S.line_h;
    const int py = UI_H - PAGE_M - plate_h;
    const float mr = plate_h / 2.0f;
    oddjobs_mark(AB_RX + (int)mr, py + plate_h / 2, mr, MZ_ACCENT);
    text(&UI_FONT_T, AB_RX + (int)(2 * mr) + 12, py + 4, "ODD JOBS", W_TEXT);
    text(&UI_FONT_S, AB_RX + (int)(2 * mr) + 12, py + 4 + UI_FONT_T.line_h, "Studio",
         W_GRAYTEXT);
  }
}

/* ------------------------------------------------------------------ */
/* Power                                                               */
/* ------------------------------------------------------------------ */

/* The two rows, in item order. */
#define PW_IT_RESTART 0
#define PW_IT_SHUTDOWN 1
#define PW_IT_COUNT 2

/*
 * POWER: the one thing it can do, the one thing it cannot, and what it is
 * running on.
 *
 * It was three rows floating in the middle of the panel: a dead SHUT DOWN
 * row at the top, RESTART under it, and CANCEL - which is Back, already on
 * the header of every screen. The screen had no reading on it at all, on the
 * one screen named POWER. Now the list hangs from the header like every other
 * list, RESTART is first because it is the row that does something, the
 * shut-down instruction keeps its row so the body's one physical control is
 * written down where someone looks for it, and the power source has a group
 * of its own. There is no fuel gauge on this board, so it says where the
 * power comes from and never how much is left.
 */
static void draw_power(void) {
  fill(0, 0, UI_W, UI_H, W_FACE);
  draw_header(SCR_POWER);
  s_list_top = LIST_TOP_DEFAULT;
  draw_list_frame(PW_IT_COUNT);
  draw_row(PW_IT_RESTART, foc(SCR_POWER, PW_IT_RESTART), s_pressed == PW_IT_RESTART, true,
           "Restart", "Back in a moment", true);
  /* Drawn disabled: power.c controls the backlight and the camera bank and
   * has no power-off at all, and there is no soft latch in the pin map for
   * one. The slide is the switch. */
  draw_row(PW_IT_SHUTDOWN, foc(SCR_POWER, PW_IT_SHUTDOWN), s_pressed == PW_IT_SHUTDOWN, false,
           "Shut down", "Hold the power slide", false);

  const int gy = LIST_Y + PW_IT_COUNT * ROW_H + 14;
  const int cap_h = UI_FONT_T.line_h + 4;
  const bool usb = usb_attached();
  group_box(LIST_X, gy, LIST_W, cap_h + 14 + UI_FONT_M.line_h + 6 + UI_FONT_S.line_h + 16,
            "RUNNING ON", W_TEXT, NULL);
  text(&UI_FONT_M, LIST_X + 18, gy + cap_h + 14, usb ? "USB" : "BATTERY", W_TEXT);
  text(&UI_FONT_S, LIST_X + 18, gy + cap_h + 14 + UI_FONT_M.line_h + 6,
       usb ? "Powered from the cable." : "On the cells. This body has no battery gauge.",
       W_GRAYTEXT);
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
      *d = (dlg_spec_t){"RESTART", "Back in a moment?", "KINO restarts and comes back to SHOOT.", "RESTART", false};
      break;
    case DLG_DELETE:
      snprintf(sub, sizeof sub, "%d frames. This cannot be undone.", s_photo_frames);
      *d = (dlg_spec_t){"DELETE", "Delete this photo?", sub, "DELETE", true};
      break;
    case DLG_DELETE_ALL:
      snprintf(sub, sizeof sub, "%d photos. This cannot be undone.", gallery_media_count() < 0 ? 0 : gallery_media_count());
      /* "photos", and the sub line says how many, because that is the number a
       * person checks before pressing this. It says nothing about sounds,
       * looks or settings on purpose: they are not touched, and listing what
       * survives a destructive action reads as a warning about them. */
      *d = (dlg_spec_t){"DELETE ALL", "Delete every photo?", sub, "DELETE ALL", true};
      break;
    case DLG_WELCOME:
      /* Shown once, on a body that has never been through a first boot: what
       * to do first, and where the rest is written down. */
      *d = (dlg_spec_t){"FIRST START", "The first photograph measures the cameras.",
                        "STATUS lists what the body still needs.", "GOT IT", false};
      break;
    default:
      *d = (dlg_spec_t){"SHUT DOWN", "Calling it a night?", "Hold the power slide to wake KINO up again.", "SHUT DOWN", false};
      break;
  }
}

/*
 * A question, and its answers as ROWS.
 *
 * The answers were two chips side by side in a card - which is what a dialog
 * looks like in most interfaces, and which is exactly the problem: nothing
 * else on this camera asks you to choose between two things laid out that
 * way. Every other choice on the product is a list of full-width rows, and a
 * confirm is the most consequential list there is. Giving the card the same
 * corner as everything else made it a rounded outsider; building it out of
 * draw_row_at(), the same function the settings list is made of, makes it a
 * member.
 *
 * Which also fixes the reachability problem two chips had: a 148 px target
 * beside another 148 px target, on a panel held one-handed, against a
 * full-width row.
 */
#define DLG_W 460
/* Centred, like every other device's confirm. It sat on the hand's side for
 * a while and read as a panel that had slid in, not a question. */
static int dlg_x(void) { return (UI_W - DLG_W) / 2; }
#define DLG_PAD 20
#define DLG_ROW_H (ROW_H - ROW_GAP)
#define DLG_ROW_GAP 8
#define DLG_TOP 20
/* Title, question, optional line, then the two rows and the bottom pad. */
#define DLG_H(sub) (DLG_TOP + UI_FONT_T.line_h + 10 + UI_FONT_M.line_h + \
                    ((sub) ? UI_FONT_S.line_h + 6 : 0) + 18 + 2 * DLG_ROW_H + DLG_ROW_GAP + \
                    DLG_PAD)
#define DLG_Y(sub) ((UI_H - DLG_H(sub)) / 2)
#define DLG_ROW_X (dlg_x() + DLG_PAD)
#define DLG_ROW_W (DLG_W - 2 * DLG_PAD)
/* Row POSITION `i`, top to bottom. The item at a position is dlg_item_at(). */
#define DLG_ROW_Y(sub, i) \
  (DLG_Y(sub) + DLG_H(sub) - DLG_PAD - (2 - (i)) * DLG_ROW_H - (1 - (i)) * DLG_ROW_GAP)
/*
 * Cancel is the BOTTOM row. A thumb coming up from its rest at the foot of
 * the panel reaches the bottom row first, and the row it reaches first has to
 * be the one a person who misread the question can press without loss. Item
 * 0 is still Cancel and item 1 the action, so nothing that commits moves.
 */
static int dlg_item_at(int pos) { return pos == 0 ? 1 : 0; }

static void draw_dialog(void) {
  /* Scrim over whatever is behind, so the decision is the only live thing.
   * Heavy enough that the screen underneath reads as unavailable rather than
   * merely tinted - a half-lit list still invites a press. */
  scrim(0, 0, UI_W, UI_H, MZ_GROUND, 205);

  dlg_spec_t d;
  dialog_spec(&d);
  const bool sub = d.sub != NULL;
  const int y0 = DLG_Y(sub);

  const int dx = dlg_x();
  round_rect(dx, y0, DLG_W, DLG_H(sub), UI_R, W_WINDOW);

  /* The title in the technical caps every screen titles things in, coloured
   * by what is about to happen; then the question, then the one line that
   * says what it costs. */
  int ty = y0 + DLG_TOP;
  text(&UI_FONT_T, dx + DLG_PAD, ty, d.title, d.destructive ? C_RED_INK : MZ_CARD);
  ty += UI_FONT_T.line_h + 10;
  text(&UI_FONT_M, dx + DLG_PAD, ty, d.body, W_TEXT);
  ty += UI_FONT_M.line_h;
  if (sub) text(&UI_FONT_S, dx + DLG_PAD, ty + 4, d.sub, W_GRAYTEXT);

  /*
   * The answers, as rows.
   *
   * Same function, same shape and same rhythm as the settings list, because
   * a confirm is a list of two things you can do and there is no reason for
   * it to be a different kind of object. The destructive answer takes the
   * red; the safe one takes the list's own first tone, so the pair reads as
   * "an ordinary choice, and one that is not".
   *
   * The action is the top row and Cancel the bottom one: see dlg_item_at().
   */
  draw_row_face(DLG_ROW_X, DLG_ROW_W, DLG_ROW_Y(sub, 0), DLG_ROW_H, 1, false, s_dlg_focus == 1,
                s_pressed == 1, true, d.go, NULL, true, d.destructive ? C_RED : W_SEL);
  /* One step lighter than a list row: the dialog's own face is close to the
   * row tone, and Cancel has to read as a row on it. */
  draw_row_face(DLG_ROW_X, DLG_ROW_W, DLG_ROW_Y(sub, 1), DLG_ROW_H, 0, false, s_dlg_focus == 0,
                s_pressed == 0, true, "Cancel", NULL, false, W_PRESS);
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
/*
 * The strip: four cells, a word, an accent down the left edge.
 *
 * The camera's one way of saying something is happening. A capture uses it,
 * and so does the first photograph's calibration - one object rather than
 * two, because the two were a dark strip and a centred grey dialog and
 * nothing about the difference between them was a difference in what the
 * camera was doing.
 *
 * Full width everywhere. There is nothing in the bottom of the shoot screen
 * to protect - it is all picture, and a report about the photograph is
 * allowed to sit over the photograph for a moment.
 */
/*
 * The camera working: the four, and one line about what they are doing.
 *
 * A card on the page margin, where the viewfinder's own status panels sit,
 * and it replaces them for as long as it is up. It used to be a full-bleed
 * strip with a square corner, a hairline across the top and a five-pixel tab
 * down its left edge - which is a status bar from an interface made of
 * rectangles, sitting on a screen where everything else is a card with the
 * same corner. The accent stays, as a bar at the card's left end: it is the
 * one thing that says which KIND of work this is, and a colour with no shape
 * to hold it is a stripe.
 */
static void draw_strip(const fm_cell_t *st, const char *line, uint16_t accent) {
  AUDIT_CHROME(true);
  const int h = SH_PN_H, y = SH_PN_Y, x = PAGE_M, w = UI_W - 2 * PAGE_M;
  round_rect(x, y, w, h, UI_R, W_WINDOW);
  round_rect(x, y, 6 + UI_R, h, UI_R, accent);
  fill(x + 6, y, UI_R, h, W_WINDOW);

  const int cell = 12;
  const int mx = x + 18;
  four_mark(mx, y + (h - cell) / 2, cell, st, true);
  text(&UI_FONT_T, mx + 4 * (cell + FM_GAP) + 12, y + (h - UI_FONT_T.line_h) / 2, line, W_TEXT);
  AUDIT_CHROME(false);
}

/** The camera at work on something that is not a capture. All four cells
 *  lit, because this is about the four and not about one of them. */
static void draw_working_banner(const char *line) {
  const fm_cell_t st[4] = {FM_ON, FM_ON, FM_ON, FM_ON};
  draw_strip(st, line, MZ_MINT);
}

static void draw_capture_banner(void) {
  const capture_stage_t cs = capture_stage();
  if (cs == CAPTURE_IDLE) return;

  capture_report_t r;
  capture_last(&r);

  fm_cell_t st[4] = {FM_OFF, FM_OFF, FM_OFF, FM_OFF};
  char line[64];
  uint16_t accent = MZ_MINT;
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
        /* The reason a person can act on, not the contract code. "Needs
         * 4096 KB, 812 KB free" was computed for every failure and never
         * drawn; SD_FULL was. The code stays in the log and the KDP reply. */
        snprintf(line, sizeof line, "%.60s",
                 r.err_msg[0] ? r.err_msg : (r.err_code[0] ? r.err_code : "NO PHOTO"));
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

  draw_strip(st, line, accent);
}

/* How long a toast stays. Expiry is decided in ui_pass, once per pass, and
 * never inside a draw: a draw runs once per tile of a frame, and a toast that
 * expired between two tiles would be half on the screen. */
#define TOAST_MS 2200
static bool toast_expired(void) {
  return s_toast[0] != '\0' && esp_timer_get_time() - s_toast_us > (int64_t)TOAST_MS * 1000;
}

static void draw_toast(void) {
  if (s_toast[0] == '\0' || toast_expired()) return;
  /*
   * A mint chip, floating.
   *
   * Two versions are behind this one and both were about the register they
   * were in rather than the job. It is the one cool colour in the set, which
   * is the whole reason mint is in the set: a transient remark must not be
   * mistakable for a selection, and everything the finger can act on is warm.
   *
   * Where it rests matters more than what it looks like. It floated 44 px off
   * the bottom on every screen, which on the menu put it across the SETTINGS
   * row's label - a message covering the control it was raised by, which is
   * the exact failure. So it sits clear of the last row on a list screen,
   * above the finder's status bar where the controls are, and centred on the
   * photograph's own well rather than the panel, because every message there
   * is about the picture and the panel's centre straddles the button column.
   */
  const int w = text_w(&UI_FONT_T, s_toast) + 40, h = 36;
  int y = UI_H - 14 - h;
  if (s_screen == SCR_SHOOT) y = SH_BAR_Y - h - 10;
  int x = (UI_W - w) / 2;
  /* The menu's rows run to the bottom of the panel, so the bottom band is a
   * control. The card's own air - between the mark and the word - is the
   * empty place on that screen, and the card is on the hand's side. */
  if (s_screen == SCR_MENU) {
    y = MZ_M + MZ_CARD_H / 2 + 50;
    x = mz_card_x() + (MZ_CARD_W - w) / 2;
  }
  if (s_screen == SCR_PHOTO) x = ph_well_x() + (PH_W - w) / 2;
  round_rect(x, y, w, h, UI_R, MZ_MINT);
  text_mid(&UI_FONT_T, x + w / 2, y + (h - UI_FONT_T.line_h) / 2, s_toast, W_INFOTEXT);
}


/*
 * The four being measured against each other, while it happens.
 *
 * The search is a few hundred milliseconds on this task, and a screen that
 * stops without a word for that long is a camera that has hung. This is drawn
 * and presented before the arithmetic starts, so the frame someone is looking
 * at during the wait is one that says what the wait is.
 *
 * IN THE BANNER, NOT IN A MODAL. It was a centred grey dialog, and laid out
 * beside the rest of the product that is the fault: the camera already has an
 * object for "something is happening right now" - the strip along the bottom,
 * four cells and a word, which is what a capture uses and what a toast uses -
 * and this was a second one that blocked the whole screen for a state nobody
 * has to answer. The rule the set now keeps: a strip when the camera is
 * working, a modal only when it is asking, because a modal is a question and
 * this is not one.
 */
static bool s_calibrating;

/*
 * The guest half takes the whole screen and nothing else runs.
 *
 * Not a screen in the shell's sense - it is the other half of the product,
 * and while it is up the shell does not exist. No header, no status bar, no
 * capture banner, no toast, no dialog: a guest cannot act on any of them and
 * every one of them is furniture between a stranger and a photograph.
 */
static void draw_screen(void) {
  /*
   * The body's top, reset before every screen.
   *
   * A screen that wants its content centred says so; one that says nothing
   * gets the default rather than whatever the last screen happened to leave
   * behind. Without this ABOUT, DISPLAY and ROLL - which read the value and
   * never set it - would have drawn at the previous screen's offset, and the
   * hit test with them.
   */
  s_list_top = LIST_TOP_DEFAULT;
  /* The hand, once per frame. The hit test reads the flag the draw used, so
   * the two cannot disagree about a side within one press. */
  s_right_hand = strcmp(config_str("body.hand", "right"), "left") != 0;

  switch (s_screen) {
    case SCR_MENU: draw_menu(); break;
    case SCR_SHOOT: draw_shoot(); break;
    case SCR_LOOK: draw_look(); break;
    case SCR_GALLERY: draw_gallery(); break;
    case SCR_PHOTO: draw_photo(); break;
    case SCR_ROLL: draw_roll(); break;
    case SCR_SETTINGS: draw_settings(); break;
    case SCR_STATUS: draw_status(); break;
    case SCR_DISPLAY: draw_display(); break;
    case SCR_SOUND: draw_sound(); break;
    case SCR_CONNECTION: draw_connection(); break;
    case SCR_STORAGE: draw_storage(); break;
    case SCR_ABOUT: draw_about(); break;
    case SCR_POWER: draw_power(); break;
    default: break;
  }
  draw_capture_banner();
  if (s_calibrating) draw_working_banner("MEASURING THE CAMERAS");
  draw_toast();
  if (s_dialog != DLG_NONE) draw_dialog();
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

static void fire_shutter(bool long_press);

/* NAV_OPEN_MS, NAV_BACK_MS and NAV_CASCADE_MS are declared with the animation
 * state near the top of the file: the photograph screen's page step starts a
 * move and is declared long before this section. */


/**
 * A row becoming a screen.
 *
 * The row IS the screen's header, from the first frame.
 *
 * That sentence is the whole design and it took three wrong answers to find.
 * The first slid two finished frames past each other, which is all a
 * compositor can do, so the word on the card could not grow with it. The
 * second drew the move here and flew the word to where the title would be -
 * better, and still wrong, because for most of the move the screen was a
 * large empty rectangle of the pressed row's orange with a small label in the
 * corner of it, and a big flat field of accent is the loudest thing an
 * interface can put on a panel.
 *
 * What the reference actually does is simpler than either. The destination is
 * revealed INSIDE the growing card, cropped to it and anchored to its top
 * edge - so at the first frame the row's rectangle is filled with the top
 * 50 px of the screen it opens, which is that screen's header, with its title
 * in it. The header then rises and unrolls into the whole page. Nothing has
 * to travel and nothing has to be retypeset: the title was always in the
 * right place, because the card's top edge is where the header lives.
 *
 * Two things sell it:
 *
 *   the row's colour   washes off over the first third, so the card visibly
 *                      starts as the thing that was touched and becomes the
 *                      thing that was opened
 *   the list parts     everything above lifts and everything below drops, as
 *                      two rigid blocks on the card's own curve
 *
 * The blocks were staggered per row once. It tore: a near row starting before
 * a far one overtook it, so the card clipped the menu's own card and the gaps
 * between rows went uneven for the length of the move. A stagger is a
 * flourish and this is a single gesture; it moves as one thing now.
 *
 * The caller stashes the frame the card holds - see go() for why it cannot be
 * stashed here.
 */
/*
 * One frame of the open move, at phase `t` (0 = the row, 1 = the screen).
 *
 * Lifted out of the loop so the renderer can price it. A transition's cost is
 * not one number: this frame draws five sliding cards and a blit-plus-scrim
 * whose area grows from one row to the whole panel, so the last frame does
 * several times the work of the first. Time-based interpolation over a cost
 * curve like that is what "choppy" actually means - the frames are not late
 * on average, they are late at the end, and the end is where the eye is.
 */
/**
 * Draw something through a view: its own (0, 0) lands at canvas (dx, dy), and
 * only the canvas rectangle (cx, cy, cw, ch) is drawn. Nested inside the
 * current target's window, so it works on the whole canvas and on one tile
 * alike, and the drawing code needs to know nothing about either.
 */
static void draw_placed(void (*draw)(void), int dx, int dy, int cx, int cy, int cw, int ch) {
  const gfx_target_t *t = gfx_target();
  int x0 = cx > t->x0 ? cx : t->x0, y0 = cy > t->y0 ? cy : t->y0;
  int x1 = cx + cw < CV_X1(t) ? cx + cw : CV_X1(t);
  int y1 = cy + ch < CV_Y1(t) ? cy + ch : CV_Y1(t);
  if (x0 >= x1 || y0 >= y1) return;
  if (s_dl.rec) {
    /* Recording: the view becomes each command's shift and clip. */
    const int16_t sx = s_dl.sx, sy = s_dl.sy, cx0 = s_dl.cx0, cy0 = s_dl.cy0, cx1 = s_dl.cx1,
                  cy1 = s_dl.cy1;
    s_dl.sx = (int16_t)dx; s_dl.sy = (int16_t)dy;
    s_dl.cx0 = (int16_t)x0; s_dl.cy0 = (int16_t)y0; s_dl.cx1 = (int16_t)x1; s_dl.cy1 = (int16_t)y1;
    draw();
    s_dl.sx = sx; s_dl.sy = sy; s_dl.cx0 = cx0; s_dl.cy0 = cy0; s_dl.cx1 = cx1; s_dl.cy1 = cy1;
    return;
  }
  const gfx_target_t view = {cv_ptr(t, x0, y0), x0 - dx, y0 - dy, x1 - x0, y1 - y0, t->stride};
  gfx_target_view(&view);
  draw();
  gfx_target_view(NULL);
}

/* The screen inside the card, whichever it is, drawn as that screen. */
static void draw_card_screen(void) {
  const screen_t keep = s_screen;
  s_screen = s_anim.card;
  draw_screen();
  s_screen = keep;
}
/* The card as the picture of its screen taken at the start of the move. */
static void draw_stash_copy(void) { blit_rows(gfx_stash_px(), UI_W, 0, 0, UI_W, UI_H); }

/*
 * One frame of a row becoming a screen, or a screen becoming a row again.
 *
 * DRAWN, not composited. This used to blit the two ends of the move out of
 * retained copies in PSRAM - the menu from one, the arriving screen from
 * another - which cost a read of most of the screen on every frame, on the
 * bus that is this board's limit, and two whole renders plus a rotate before
 * the first frame could show. Now the menu's columns and the screen inside
 * the card are drawn with their own screen code through a moved, clipped
 * view (draw_placed), straight into the tile being rendered. Nothing is read
 * back, nothing is prepared, and a frame costs what its pixels cost to draw.
 */
/*
 * The menu's rows arriving, each from its right, staggered.
 *
 * Every row travels the same distance at the same speed and they start at
 * different moments, which is what makes a list that cascades read as a set
 * of objects rather than as a picture of a list fading in. Each row is the
 * menu drawn through a view moved by how far the row still has to come, and
 * clipped to where the row will sit - the same mechanism as a move.
 */
static void render_cascade(void *ctx) {
  const float t = *(const float *)ctx;
  fill(0, 0, UI_W, UI_H, MZ_GROUND);
  const float travel = 0.5f;
  const float step = (1.0f - travel) / 5.0f;
  for (int i = 0; i < 6; i++) {
    float local = (t - step * (float)i) / travel;
    if (local < 0.0f) continue; /* not started: still ground */
    if (local > 1.0f) local = 1.0f;
    int x, y, w, h;
    menu_rect(i, &x, &y, &w, &h);
    int o = (int)((1.0f - ease_ui(local)) * (float)(UI_W - x));
    if (o < 0) o = 0;
    if (o >= w) continue; /* wholly off the panel still */
    draw_placed(draw_menu, o, 0, x + o, y, w - o, h);
  }
}

static void open_frame(int row, float t) {
  int rx, ry, rw, rh;
  menu_rect(row, &rx, &ry, &rw, &rh);
  /* The colour the card wears while the wash is on it: the pressed face on
   * the way in, the RESTING face on the way back - so the last frame of a
   * back move is the row as it will sit, and the settled menu that follows
   * changes nothing. It landed on the pressed colour before, and snapped. */
  const uint16_t tint = menu_face(row, s_anim.opening);

  const float e = ease_ui(t);
  int ox = lerpi(rx, 0, e), oy = lerpi(ry, 0, e);
  int ow = lerpi(rw, UI_W, e), oh = lerpi(rh, UI_H, e);
  if (ox < 0) ox = 0;
  if (oy < 0) oy = 0;
  if (ow > UI_W - ox) ow = UI_W - ox;
  if (oh > UI_H - oy) oh = UI_H - oy;

  /*
   * The ground, only where it will still be ground.
   *
   * This cleared the whole canvas and then drew the growing card over most
   * of it. The card's rectangle is drawn whole by draw_card_screen() below,
   * so only the four bands round it need the ground - nothing at the start
   * of the move, everything but a shrinking frame as it goes.
   */
  fill(0, 0, UI_W, oy, MZ_GROUND);
  fill(0, oy + oh, UI_W, UI_H - oy - oh, MZ_GROUND);
  fill(0, oy, ox, oh, MZ_GROUND);
  fill(ox + ow, oy, UI_W - ox - ow, oh, MZ_GROUND);

  /*
   * The menu, parting - drawn through moved views of the menu's own drawing.
   *
   * Everything that is not the touched item is a rigid block: it translates
   * and nothing about it changes, so each block is the menu drawn with its
   * origin moved and clipped to where the block now is.
   *
   * Two columns, so two kinds of parting. Opening the card, the rows column
   * leaves as one block toward its own edge. Opening a row, the card leaves
   * toward ITS edge while the rows above lift and the rows below drop - the
   * list still parts around the row, and the card gets out of the way
   * sideways, which is the direction it has.
   */
  {
    int cx0, cy0, cw0, ch0;
    menu_rect(0, &cx0, &cy0, &cw0, &ch0);
    int r1x, r1y, r1w, r1h, r5x, r5y, r5w, r5h;
    menu_rect(1, &r1x, &r1y, &r1w, &r1h);
    menu_rect(5, &r5x, &r5y, &r5w, &r5h);
    const int rows_h = (r5y + r5h) - r1y;
    /* Each column leaves toward the edge it is nearer, and it is GONE by the
     * time the growing card reaches where it stood. On one clock the two
     * edges moved at the same rate and the card looked pushed off the panel
     * by the screen behind it, edge to edge for the whole move - two cards
     * racing. The other column takes the first half of the move to leave
     * (and the second half to come back), so the screen unfolds into room
     * that is already empty. */
    const int rows_dir = r1x < cx0 ? -1 : 1;
    const int card_dir = -rows_dir;
    const float ce = ease_ui(span01(t, 0.0f, 0.5f));
    const int rows_travel = (int)(ce * (float)(r1w + MZ_M));
    const int card_travel = (int)(ce * (float)(cw0 + MZ_M));

    if (row == 0) {
      const int sx = rows_dir * rows_travel;
      draw_placed(draw_menu, sx, 0, r1x + sx, r1y, r1w, rows_h);
    } else {
      const int sx = card_dir * card_travel;
      draw_placed(draw_menu, sx, 0, cx0 + sx, cy0, cw0, ch0);
      const int travel = (int)(e * (float)UI_H);
      /* Everything above the touched row, carried up. */
      const int top_h = ry - r1y;
      if (top_h > 0) draw_placed(draw_menu, 0, -travel, r1x, r1y - travel, r1w, top_h);
      /* Everything below it, carried down. */
      const int bot_y = ry + rh;
      const int bot_h = (r5y + r5h) - bot_y;
      if (bot_h > 0) draw_placed(draw_menu, 0, travel, r1x, bot_y + travel, r1w, bot_h);
    }
  }

  /* The screen, drawn into the card and hung from its top edge: its row 0 at
   * the card's row oy, its columns where they are, cut to the card. */
  draw_placed(s_anim.snap ? draw_stash_copy : draw_card_screen, 0, oy, ox, oy, ow, oh);

  /*
   * The row's colour, washing off - and the row's own words with it.
   *
   * The first frame used to paint the card in the pressed colour and the
   * label was simply gone: it had been on the row and now the row was a
   * plate. The words are drawn over the wash in an ink that fades with it,
   * so they dissolve into the screen arriving beneath them. On the way back
   * they condense out of it, in the resting ink, onto the resting face.
   */
  const float wash = 1.0f - span01(t, 0.0f, 0.34f);
  if (wash > 0.01f) {
    const int k = (int)(wash * 255.0f);
    scrim(ox, oy, ow, oh, tint, k);
    menu_words(row, rx, ry, rw, rh, mix(tint, menu_ink(row, s_anim.opening), k), true);
  }

  cut_corners(ox, oy, ow, oh, (float)UI_R * (1.0f - e), MZ_GROUND);
}

static void open_anim(int row, bool opening, screen_t card, int ms) {
  anim_start_open(row, opening, card, ms);
}

/** Which menu row leads to `s`, or -1 if none does. */
static int menu_item_of(screen_t s) {
  for (int i = 0; i < 6; i++) {
    if (MENU_DEST[i] == s) return i;
  }
  return -1;
}

/*
 * Going somewhere, and the motion that says so.
 *
 * Two sentences, and which one is true depends on what you touched:
 *
 *   you opened this row          the screen unfolds out of the row
 *   you went one level deeper    the screen pushes in from the right
 *
 * The first is the better sentence wherever it is available, because the menu
 * is a list of things that open rather than a stack of screens: the row you
 * touched becomes the thing you are looking at, and going back puts it away
 * where you found it. The push is what is left over - the moves between
 * screens with no row behind them - and it carries the tree's one direction,
 * deeper is rightward.
 *
 * A dissolve would say neither. It says "this changed", which is all it can
 * say, and on a device with one screen and no window chrome the thing you
 * most need to know is where you are and how to get back.
 */
static void go(screen_t s, int ms) {
  if (s == SCR_GALLERY) gallery_refresh();
  /* The panes' settling clock: see SH_SETTLE_US. */
  if (s == SCR_SHOOT && s_screen != SCR_SHOOT) s_shoot_since_us = esp_timer_get_time();
  if (s_screen == SCR_PHOTO && s != SCR_PHOTO) photo_release();

  const screen_t from = s_screen;
  /* LOOK opened from the finder returns to the finder: that is a step back
   * too, and the slide has to say so. */
  const bool back = SCREEN_PARENT[from] == s || (from == SCR_LOOK && s == SCR_SHOOT);
  /* The row this move is about: the one being opened, or the one being put
   * back. Either way it is the menu row for whichever end is not the menu. */
  const int row = from == SCR_MENU ? menu_item_of(s) : (back && s == SCR_MENU ? menu_item_of(from) : -1);

  const bool opening = from == SCR_MENU;

  /*
   * A row move is drawn from state and needs nothing prepared: its first
   * frame follows the release by one pass. The push between two screens
   * with no row behind them still composites, so it gets the screen being
   * left into the canvas - while s_screen still names it and the pressed
   * control is still pressed - and the snapshot it starts from.
   */
  if (row < 0) {
    gfx_render_canvas(render_screen, NULL);
    gfx_snapshot();
  }

  if (from == SCR_LOOK && s != SCR_LOOK) s_look_from_shoot = false;
  s_screen = s;
  s_pressed = -1;

  if (row >= 0) {
    /* Inside the card: the screen arriving when a row opens, the screen being
     * left when it closes. */
    open_anim(row, opening, opening ? s : from, ms);
  } else {
    gfx_render_canvas(render_screen, NULL);
    gfx_slide(ms, !back);
  }
}

static void go_back(void) {
  /* One level up, deterministically. Back on the viewfinder and back on the
   * menu both land on the menu, which is the camera's home. The one route
   * that remembers anything is LOOK opened off the finder's own bar, which
   * goes back to the finder - set on that press and on no other. */
  if (s_screen == SCR_LOOK && s_look_from_shoot) {
    go(SCR_SHOOT, NAV_BACK_MS);
    return;
  }
  go(SCREEN_PARENT[s_screen], NAV_BACK_MS);
}

/* Number of focusable items on a screen. */
static int item_count(screen_t s) {
  switch (s) {
    case SCR_MENU: return 6;
    case SCR_SHOOT: return 2;
    /* The TARGET row is the last band, so WIGGLE simply stops short of it
     * and every index below keeps its meaning in both modes. */
    case SCR_LOOK: return mode_is_quad() ? LK_IT_COUNT : LK_IT_TARGET;
    case SCR_GALLERY: return gallery_pages() > 1 ? 8 : GALLERY_PAGE;
    case SCR_PHOTO: return 3;
    case SCR_SETTINGS: return settings_rows();
    case SCR_DISPLAY: return DSP_IT_COUNT;
    case SCR_SOUND: return SN_IT_COUNT;
    case SCR_STORAGE: return ST_IT_COUNT;
    case SCR_POWER: return PW_IT_COUNT;
    case SCR_STATUS: {
      const int n = conditions_count();
      return sts_has_action() && sts_action_y(n < 6 ? n : 6) >= 0 ? 1 : 0;
    }
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
  const bool sub = d.sub != NULL;
  for (int i = 0; i < 2; i++) {
    if (in(x, y, DLG_ROW_X, DLG_ROW_Y(sub, i), DLG_ROW_W, DLG_ROW_H)) return dlg_item_at(i);
  }
  return -1;
}

/*
 * The header band. The whole of it goes back - a band is a bigger target
 * than any button - except the page pair on the gallery, whose targets run
 * the band's full height and split down the gap between them, with half a
 * cluster gap of slop on either side so a thumb landing on a bevel turns the
 * page rather than leaving the screen.
 */
static int hit_header(screen_t s, int x) {
  if (hd_paging(s)) {
    const int px = hd_prev_x(), nx = hd_next_x();
    const int lo = (px < nx ? px : nx), hi = (px < nx ? nx : px) + HD_BTN_W;
    if (x >= lo - HD_BTN_GAP / 2 && x < hi + HD_BTN_GAP / 2) {
      const int split = lo + HD_BTN_W + G_PG_GAP / 2;
      const int left_item = px < nx ? G_IT_PREV : G_IT_NEXT;
      const int right_item = px < nx ? G_IT_NEXT : G_IT_PREV;
      return x < split ? left_item : right_item;
    }
  }
  return IT_BACK;
}

/* A drawn button, its slop, and the run from it to the hand's edge: on the
 * two screens whose chrome sits on picture, the margin outside the button is
 * a target too, because nothing else is there. */
static bool hit_hand_button(int x, int y, int bx, int by, int bw, int bh) {
  if (in(x, y, bx - HIT_SLOP, by - HIT_SLOP, bw + 2 * HIT_SLOP, bh + 2 * HIT_SLOP)) return true;
  if (y < by - HIT_SLOP || y >= by + bh + HIT_SLOP) return false;
  return s_right_hand ? x >= bx + bw : x < bx;
}

static int hit_test(int x, int y) {
  /* In guest mode the panel reaches nothing. Not a region, not a row, not a
   * dialog - the glass is a viewfinder. This is the whole of "nothing a
   * finger touches changes anything", and it is one line here rather than a
   * guard on every control because a guard that has to be remembered on every
   * new control is a guard that will be forgotten on one. */
  if (s_dialog != DLG_NONE) return hit_dialog(x, y);

  switch (s_screen) {
    case SCR_MENU:
      /* From menu_rect(), the same function that drew them: the card and the
       * five rows are different sizes now and a fixed W/H hit map would land
       * a press on the wrong one. */
      for (int i = 0; i < 6; i++) {
        int tx, ty, tw, th;
        menu_rect(i, &tx, &ty, &tw, &th);
        if (in(x, y, tx, ty, tw, th)) return i;
      }
      return -1;

    case SCR_SHOOT:
      /* The plate, its slop, and the corner beyond it to the hand's edge:
       * every part of that looks pressable because it is, and the picture
       * under it is the one part of the finder nobody frames with. */
      if (hit_hand_button(x, y, sh_back_x(), SH_BACK_Y, SH_BACK_W, SH_BACK_H)) return SH_IT_BACK;
      /* The decisions group on the bar, as one control. Its extent was set
       * by the draw. */
      if (y >= SH_BAR_Y && x >= s_sh_set_x0 && x < s_sh_set_x1) return SH_IT_LOOK;
      return -1;

    case SCR_PHOTO: {
      if (hit_hand_button(x, y, hd_btn_x(), HD_BTN_Y, HD_BTN_W, HD_BTN)) return IT_BACK;
      /* The same PH_BTN_Y/PH_BTN_W the draw uses. */
      const int cx = ph_col_x();
      if (in(x, y, cx, PH_BTN_Y(0), PH_BTN_W, PH_BTN_H)) return P_IT_DELETE;
      if (in(x, y, cx, PH_BTN_Y(1), PH_BTN_W, PH_BTN_H)) return P_IT_ROLL;
      if (in(x, y, cx, PH_BTN_Y(2), PH_BTN_W, PH_BTN_H)) return P_IT_FAV;
      if (in(x, y, cx, PH_PN_Y, PH_PN_W, PH_PN_H)) return P_IT_PREV;
      if (in(x, y, cx + PH_PN_W + PH_BTN_GAP, PH_PN_Y, PH_PN_W, PH_PN_H)) return P_IT_NEXT;
      return -1;
    }

    default: break;
  }

  /* Every other screen has the standard header, and the whole of it goes
   * back: a 26 px chevron is a smaller target than a thumb is wide. The
   * gallery's page pair is the exception, and hit_header() carries it. */
  if (y < HEAD_H) return hit_header(s_screen, x);

  switch (s_screen) {
    case SCR_LOOK: {
      /* The same three helpers the drawing uses, so a block moved there moves
       * here. This screen has had a hit map outlive its layout twice. */
      const bool quad = mode_is_quad();

      /* The picker, at the hero card's foot on the hand's side. */
      const int hy = lk_hero_y(quad);
      const int by = hy + lk_hero_h(quad) - 16 - LK_CTL_H;
      if (in(x, y, lk_prev_x(), by, LK_PICK_BTN, LK_CTL_H)) return LK_IT_PREV;
      if (in(x, y, lk_next_x(), by, LK_PICK_BTN, LK_CTL_H)) return LK_IT_NEXT;

      /* The three columns under it, in the order the draw put them. */
      const int ty = lk_trio_y(quad) + LK_CAP_H;
      static const int BASE[3] = {LK_IT_MODE, LK_IT_FLASH, LK_IT_COLOR};
      static const int COUNT[3] = {2, 3, 2};
      if (y >= ty && y < ty + LK_CTL_H) {
        for (int c = 0; c < 3; c++) {
          const int g = lk_group_of_col(c);
          const int cx = lk_col_x(c);
          const int cw = LK_COL_W / COUNT[g];
          for (int i = 0; i < COUNT[g]; i++) {
            if (in(x, y, cx + i * cw, ty, cw, LK_CTL_H)) return BASE[g] + i;
          }
        }
      }

      /* And the target row, in QUAD. */
      if (quad) {
        const int gy = lk_tgt_y(quad) + LK_CAP_H;
        if (y >= gy && y < gy + LK_CTL_H) {
          const int cw = LK_W / 5;
          for (int i = 0; i < 5; i++) {
            if (in(x, y, PAGE_M + i * cw, gy, cw, LK_CTL_H)) return LK_IT_TARGET + i;
          }
        }
      }
      return -1;
    }
    case SCR_GALLERY: {
      if (gallery_total() == 0) return -1;
      for (int i = 0; i < GALLERY_PAGE; i++) {
        int gx, gy;
        gal_origin(i, &gx, &gy);
        /* The tile itself: the facts are on it now, not in a strip under it. */
        if (in(x, y, gx, gy, G_TILE_W, G_TILE_H)) return i;
      }
      /* PREV and NEXT are in the header and were tested above, before the
       * band's own back target. */
      return -1;
    }
    case SCR_SETTINGS: {
      const int rows = settings_rows();
      for (int i = 0; i < rows; i++)
        if (in(x, y, LIST_X, LIST_Y + i * ROW_H, LIST_W, ROW_H)) return i;
      return -1;
    }

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
      const int y0 = LIST_Y + 3 * ROW_H + 26, sw = (LIST_W - 16) / 3;
      for (int i = 0; i < 3; i++)
        if (in(x, y, LIST_X + 8 + i * sw, y0 + 24, sw, SN_VOL_H)) return SN_IT_VOL + i;
      return -1;
    }
    case SCR_STORAGE:
      /* Rows 0..2 are readings and take no press. The two that act are drawn
       * at 3 and 4, so the item number is the row minus three - one place, so
       * the draw and the hit test cannot disagree about which of two
       * destructive rows was pressed. */
      for (int i = 0; i < ST_IT_COUNT; i++)
        if (in(x, y, LIST_X, ST_ACT_Y(i), LIST_W, ROW_H)) return i;
      return -1;

    case SCR_STATUS: {
      if (item_count(SCR_STATUS) == 0) return -1;
      const int n = conditions_count();
      const int ay = sts_action_y(n < 6 ? n : 6);
      return in(x, y, LIST_X, ay, LIST_W, ROW_H - ROW_GAP) ? STS_IT_REMEASURE : -1;
    }

    case SCR_POWER:
      for (int i = 0; i < PW_IT_COUNT; i++)
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
      ui_render(render_restarting, NULL);
      vTaskDelay(pdMS_TO_TICKS(420));
      power_down_anim();
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
      toast("Deleted");
      go(SCR_GALLERY, NAV_BACK_MS);
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
    default:
      toast("Hold the power slide to switch off");
      break;
  }
  ui_render(render_screen, NULL);
}

static void activate(int item) {
  if (s_dialog != DLG_NONE) {
    if (item == 1) dialog_commit();
    else {
      s_dialog = DLG_NONE;
      ui_render(render_screen, NULL);
    }
    return;
  }

  if (item == IT_BACK) { go_back(); return; }

  switch (s_screen) {
    case SCR_MENU:
      if (item >= 0 && item < 6) {
        s_focus[SCR_MENU] = item;
        go(MENU_DEST[item], NAV_OPEN_MS);
      }
      return;

    case SCR_SHOOT:
      if (item == SH_IT_BACK) { go_back(); return; }
      if (item == SH_IT_LOOK) {
        s_look_from_shoot = true;
        go(SCR_LOOK, NAV_OPEN_MS);
        return;
      }
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
         * not overwrite four slots by itself. The item is a drawn position;
         * the value is what that position means for this hand. */
        s_look_target = lk_target_of_seg(item - LK_IT_TARGET);
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
        go(SCR_PHOTO, NAV_OPEN_MS);
        return;
      }
      break;

    case SCR_PHOTO:
      if (item == P_IT_DELETE) {
        s_dialog = DLG_DELETE;
        s_dlg_focus = 0;
      } else if (item == P_IT_FAV) {
        photo_toggle_favourite();
      } else if (item == P_IT_ROLL) {
        photo_send_to_roll();
      } else if (item == P_IT_PREV || item == P_IT_NEXT) {
        /* True when the step turned the page and started a move: nothing
         * below may present over it. */
        if (photo_step(item == P_IT_NEXT ? 1 : -1)) return;
      }
      break;

    case SCR_SETTINGS:
      if (item >= 0 && item < settings_rows()) { go(SET_DEST[item], NAV_OPEN_MS); return; }
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
          toast("No photos on the card");
          break;
        }
        s_dialog = DLG_DELETE_ALL;
        s_dlg_focus = 0;
      }
      break;

    case SCR_STATUS:
      if (item == STS_IT_REMEASURE) {
        /* Clear the result; the next photograph measures, exactly as the first
         * did. The condition comes back on the next scan, which is the
         * screen's own way of saying it took. */
        cfg_set_bool("body.calibration.done", false);
        toast("The next photo measures the cameras");
      }
      break;

    case SCR_POWER:
      if (item == PW_IT_RESTART) { s_dialog = DLG_RESTART; s_dlg_focus = 0; break; }
      if (item == PW_IT_SHUTDOWN) toast("Hold the power slide to switch off");
      break;

    default: break;
  }

  s_pressed = -1;
  ui_render(render_screen, NULL);
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
  ui_render(render_screen, NULL);
  return true;
}

/* ------------------------------------------------------------------ */
/* Physical keys, handed to the UI task rather than acted on            */
/*                                                                      */
/* buttons.c calls the handler from its own task - priority 5, no core   */
/* affinity. Everything a press does touches state the UI task owns: go()*/
/* redraws the canvas, takes a gfx_snapshot() and runs a gfx_dissolve(), */
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
    /* No present here: go() starts the move, it does not run it, and the
     * canvas is holding the destination the move is about to reveal. Pushing
     * it to the panel now would show the end of the transition before its
     * first frame. */
    go(SCR_SHOOT, NAV_OPEN_MS);
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

/* The boot sequence, once: the splash, then the menu arriving. Nothing to
 * wait for any more - there is no artwork to build before the first frame. */
static void ui_boot(void) { splash(); }

/* The first screen, arriving out of the boot sequence. */
static void boot_handoff(void) {
  /* The menu is a list and this is the one time it arrives out of nothing:
   * the cascade runs on the animation clock and reports like a move, and
   * boot_bench() follows it. Any other first screen dissolves in. */
  if (s_screen == SCR_MENU) {
    anim_start_cascade(NAV_CASCADE_MS);
    return;
  }
  gfx_snapshot();
  gfx_render_canvas(render_screen, NULL);
  gfx_dissolve(420);
  boot_bench();
}

/*
 * The one thing a fresh body says on its own: what to do first. A camera out
 * of the box boots to a menu with "Cameras not measured" three screens deep
 * in STATUS; this puts the first step in front of the person holding it,
 * once. `body.firstRunSeen` is a firmware-only config key like `body.hand`.
 */
static void first_start_note(void) {
  if (config_bool("body.firstRunSeen", false)) return;
  cfg_set_bool("body.firstRunSeen", true);
  s_dialog = DLG_WELCOME;
  s_dlg_focus = 0;
  ui_render(render_screen, NULL);
}

/* The figures a boot leaves in the ring for the bench: what internal SRAM is
 * left, and - with UI_BOOT_BENCH - what each screen costs to draw. */
#ifndef UI_BOOT_BENCH
#define UI_BOOT_BENCH 0
#endif
static void boot_bench(void) {
  /* Internal SRAM is the pool this board runs out of first (#162). The
   * recovery reserve's 2/2 says whether it fitted; this says by how much. */
  klog("P4", "internal heap: %lu KB free, %lu KB minimum since boot",
       (unsigned long)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024),
       (unsigned long)(heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL) / 1024));

#if UI_BOOT_BENCH
  /* What each screen costs to draw through the tile pass, for the ring. The
   * moves are drawn from these, so a slow one here is a slow move. Nothing
   * is shown; the menu is already up. */
  {
    const screen_t keep = s_screen;
    char line[160];
    int n = 0;
    for (int i = 0; i < 6; i++) {
      s_screen = MENU_DEST[i];
      const int64_t r0 = esp_timer_get_time();
      dl_begin();
      render_screen(NULL);
      const bool ok = dl_end();
      const uint32_t rec = (uint32_t)(esp_timer_get_time() - r0);
      const uint32_t us = ok ? gfx_measure_draw_us(dl_replay, NULL) : gfx_measure_draw_us(render_screen, NULL);
      if (i == 3) { klog("P4", "tile draw ms (record+replay/cmds): %s", line); n = 0; }
      n += snprintf(line + n, sizeof line - (size_t)n, "%s%s %lu.%lu+%lu.%lu/%d", i && i != 3 ? ", " : "",
                    MENU_LABEL[i], (unsigned long)(rec / 1000), (unsigned long)(rec / 100 % 10),
                    (unsigned long)(us / 1000), (unsigned long)(us / 100 % 10), s_dl.n);
    }
    s_screen = keep;
    klog("P4", "tile draw ms (record+replay/cmds): %s", line);
#if UI_DRAW_PROFILE
    s_screen = SCR_MENU;
    dl_profile("menu", render_screen, NULL);
    s_screen = SCR_GALLERY;
    dl_profile("gallery", render_screen, NULL);
    s_screen = SCR_LOOK;
    dl_profile("look", render_screen, NULL);
    s_screen = keep;
#endif
    s_anim.row = 2;
    s_anim.card = SCR_GALLERY;
    s_anim.opening = true;
    n = 0;
    for (int i = 0; i < 3; i++) {
      float t = i == 0 ? 0.15f : i == 1 ? 0.5f : 0.9f;
      const int64_t r0 = esp_timer_get_time();
      dl_begin();
      render_open(&t);
      const bool ok = dl_end();
      const uint32_t rec = (uint32_t)(esp_timer_get_time() - r0);
      const uint32_t us = ok ? gfx_measure_draw_us(dl_replay, NULL) : gfx_measure_draw_us(render_open, &t);
      n += snprintf(line + n, sizeof line - (size_t)n, "%st=%d.%02d %lu.%lu+%lu.%lu/%d", i ? ", " : "",
                    (int)t, (int)(t * 100) % 100, (unsigned long)(rec / 1000),
                    (unsigned long)(rec / 100 % 10), (unsigned long)(us / 1000),
                    (unsigned long)(us / 100 % 10), s_dl.n);
    }
    klog("P4", "open GALLERY frame draw ms: %s", line);
#if UI_DRAW_PROFILE
    float t15 = 0.15f;
    dl_profile("open t=0.15", render_open, &t15);
#endif
  }
#endif
}

/*
 * The loop's carry-over state, which used to be ui_task's locals.
 *
 * One pass of the loop is a function, ui_pass(), and the task below is the
 * trivial `for (;;) vTaskDelay(ui_pass())`. That is what lets a host drive
 * the same pass from its own scheduler: KINO Twin runs this file's real
 * screens in a browser (firmware/p4/twin_ui) the way host_preview renders
 * them, and a task that never returns cannot be stepped. Nothing about the
 * camera changed: the body, its ordering and its sleeps are exactly what they
 * were, and every `continue` became `return <the delay it used to sleep>`.
 * The names are kept so the body reads as it did.
 */
static int held = -1;
static int64_t s_ui_report_us = 0;
static uint32_t s_ui_last_frames = 0;
static ui_health_t health = {0};
static int64_t wake_since_us = 0;
static bool was_asleep = false;
/* True from the touch that dismissed a held report until that finger lifts,
 * so the dismissal does not also press whatever was underneath it. Also set
 * by the palm rules below, for the same reason. */
static bool swallow_touch = false;
/* Where the current contact landed, for the drift rule. */
static int s_down_x, s_down_y;
#define TOUCH_DRIFT 40
/* The camera's mark is on the panel because sleep is coming (power.c asked).
 * Touches are swallowed while it is, and the screen is redrawn when the sleep
 * is called off or over. */
static bool s_sleep_mark = false;

/** One pass of the UI loop. Returns how long the task sleeps before the next. */
static uint32_t ui_pass(void) {
  {
    /* The pulse, first thing and unconditionally. Several branches below
     * `continue`, and a stamp that some passes skip reads as a wedge on a loop
     * that is merely swallowing a wake press. */
    s_ui_pass++;
    s_ui_pass_ms = (uint32_t)(esp_timer_get_time() / 1000);

    /*
     * A move in flight gets the pass, and nothing else in this function runs.
     *
     * Deliberately before the button drain and the touch read: a transition
     * is short and a press landing in the middle of one is almost always the
     * user pressing again because the first press has not visibly done
     * anything yet. Servicing it would start a second move from inside the
     * first. The press is not swallowed - it stays in its queue and is read
     * on the pass after the move ends.
     *
     * The splash is the exception. It is 3.8 s long, and a finger on the
     * glass or a key going down during it is somebody who wants the camera,
     * not the picture: a shutter press queued behind the field fired when the
     * menu landed, up to 3.8 s after the thumb did. Either input ends the
     * splash on the spot and hands off to the menu; the key stays queued and
     * fires on this same pass, the touch is swallowed until it lifts, because
     * the thing it landed on was drawn after it landed.
     */
    if (anim_active()) {
      if (s_anim.kind == ANIM_SPLASH) {
        uint16_t sx = 0, sy = 0;
        const bool finger = touch_ready() && touch_get(&sx, &sy);
        const bool key = s_btn_q != NULL && uxQueueMessagesWaiting(s_btn_q) > 0;
        if (finger || key) {
          klog("P4", finger ? "splash cut by touch" : "splash cut by key");
          s_anim.kind = ANIM_NONE;
          boot_handoff();
          if (finger) swallow_touch = true;
        } else {
          return anim_tick();
        }
      } else if (s_anim.kind == ANIM_CASCADE && s_btn_q != NULL &&
                 uxQueueMessagesWaiting(s_btn_q) > 0) {
        /* The shutter during the cascade: the menu lands now and the key is
         * handled on this pass, so a body handed over mid-boot shoots when
         * its button is pressed rather than 700 ms later. */
        s_anim.kind = ANIM_NONE;
        ui_render(render_screen, NULL);
        boot_bench();
      } else {
        return anim_tick();
      }
    }

    /* Physical keys first: they were recorded on the buttons task and this
     * is the task that owns the canvas and the compositor. */
    drain_buttons();

    /*
     * The conditions, on a slow schedule of their own.
     *
     * Never in a draw: about_cameras() holds camlink's channel lock across a
     * round trip, is cached for two seconds for exactly that reason, and the
     * chip these feed is on every screen at every repaint. Two seconds is
     * also as fast as any of this changes - a node does not come back, a card
     * does not fill and a clock does not get set between two frames.
     */
    {
      static int64_t scan_us;
      const int64_t now_us = esp_timer_get_time();
      if (scan_us == 0 || now_us - scan_us > 2000000) {
        scan_us = now_us;
        conditions_scan(about_cameras());
      }
    }

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
      s_sleep_mark = false;
      ui_render(render_screen, NULL);
    }
    was_asleep = asleep_now;

    /*
     * Going to sleep: the mark, then the dark.
     *
     * power_task has decided to sleep and is holding the backlight for this
     * (power_sleep_pending). The camera's own mark goes up - the same one a
     * shutdown and a restart leave on the screen - and power.c is told it is
     * there. If the sleep is then called off by a touch, or it is over and
     * the panel is back, the screen underneath is redrawn.
     */
    if (power_sleep_pending() && !s_sleep_mark) {
      ui_render(render_mark, NULL);
      power_sleep_shown();
      s_sleep_mark = true;
      klog("P4", "sleep: mark up on screen %d", (int)s_screen);
    } else if (s_sleep_mark && !power_sleep_pending() && !asleep_now) {
      s_sleep_mark = false;
      ui_render(render_screen, NULL);
    }

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
        return 20;
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
      return 20;
    }

    if (down) {
      /* Touch reports in panel space, so the same quarter turn applies in
       * reverse: touch y is the logical x. */
      const int lx = ty;
      const int ly = DISPLAY_H_RES - 1 - tx;

      /*
       * The palm.
       *
       * With the chrome on the hand's side, the base of the thumb rests where
       * the controls now are. Two rules keep a rest from being a press: a
       * contact that begins on the hand's edge is not a finger, and a contact
       * that travels more than TOUCH_DRIFT px from where it landed is not a
       * tap - it is released with nothing fired and ignored until it lifts.
       * A tap rocks by a millimetre or two; 40 px is 4.7 mm.
       */
      if (held == -1 && (at_hand_edge(lx) || s_sleep_mark)) {
        /* A palm on the edge, or a tap on the going-to-sleep mark: the
         * latter has already called the sleep off through power_activity()
         * and must not also press whatever the mark is covering. */
        swallow_touch = true;
        return 20;
      }
      if (held != -1) {
        const int ddx = lx - s_down_x, ddy = ly - s_down_y;
        if (ddx * ddx + ddy * ddy > TOUCH_DRIFT * TOUCH_DRIFT) {
          klog("P4", "touch drifted %d,%d from %d,%d - not a tap", lx, ly, s_down_x, s_down_y);
          s_pressed = -1;
          held = -1;
          swallow_touch = true;
          ui_render(render_screen, NULL);
          return 20;
        }
      } else {
        s_down_x = lx;
        s_down_y = ly;
      }
      region = hit_test(lx, ly);
    }

    if (down && region != s_pressed) {
      /* Press paints; activation waits for the release, so a finger that
       * lands on the wrong thing can be slid off it. */
      s_pressed = region;
      held = region;
      if (region >= 0 && config_bool("body.sounds.ui", true)) audio_tick();
      ui_render(render_screen, NULL);
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
        ui_render(render_screen, NULL);
      }
    }

    /*
     * A press or a key above may have started a move. Nothing below this line
     * may present while it is pending.
     *
     * Opening SHOOT is the case that showed it: go() drew the viewfinder onto
     * the canvas and stashed it for the card to grow into, and then this same
     * pass reached the SHOOT tail below - `s_screen` was already SCR_SHOOT and
     * nothing was held - which presented the finished screen at full size.
     * The next pass played the open move from the card, and the pass after
     * that arrived at the same screen again. Seen from the glass: the
     * destination flashes, snaps back to a card, and grows. The move owns the
     * panel from the pass that starts it; the viewfinder gets it back when the
     * move has landed.
     */
    if (anim_active()) return 0;

    /* The nodes are only asked for frames while the viewfinder is up. Left
     * running behind a menu it would be four sensors and four UARTs burning
     * battery to fill a buffer nobody reads. */
    /*
     * The guest half IS a viewfinder, so the cameras run for all of it.
     *
     * This read `s_screen == SCR_SHOOT` alone, and in guest mode s_screen is
     * whatever the owner left behind - usually the menu. So every camera
     * stayed off, no tile ever arrived, and the guest half decided all four
     * lenses were down and put up CAMERAS DOWN. A guest would have been
     * handed a camera that says it is broken, on a camera that is fine.
     *
     * Found in the Twin in about a minute, which is the whole argument for
     * the Twin: the host preview draws states it is told to draw, and this
     * one is a state nothing would have thought to ask for.
     */
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
        if (!r.ok || r.stored < r.online) {
          audio_warning();
        } else {
          /*
           * The sound the body has always had for this and has never made.
           *
           * audio.h describes audio_sync() as "two short pitched taps, 45 ms
           * apart, as the four marks on the screen close on a point. The UI
           * fires it at that moment" - and the UI fired it nowhere. Five
           * voices, three used, and the two unused ones were both the ones
           * that mean it worked: the camera warned five ways when something
           * went wrong and was silent when four cameras landed a photograph.
           *
           * This is that moment: the pass on which the report first exists,
           * which is the pass the banner first draws the marks on.
           */
          audio_sync();
        }

        /*
         * The first photograph is the one that measures the four cameras
         * against each other.
         *
         * ui.c has said for as long as the wigglegram player has existed that
         * step 2 of the offset rule - the live device calibration - does not
         * exist on this body, so every capture on every card plays untouched.
         * This is where it starts existing, and the first frame someone
         * actually takes is better data than any calibration card: it is
         * pointed at something with structure in it, at a distance they
         * chose, at the exposure they wanted.
         *
         * On this task, at the one moment the task has nothing else to do -
         * the report is up, the shutter is released, and the screen is about
         * to hold a result for two seconds anyway. Behind a modal that says
         * so, because a few hundred milliseconds of frozen screen with no
         * explanation is indistinguishable from a hang.
         */
        if (r.ok && r.stored >= 2 && !config_bool("body.calibration.done", false)) {
          s_calibrating = true;
          ui_render(render_screen, NULL);
          const char *const v = config_str("shoot.viewfinder", "cam2");
          const int ref = (v[3] >= '1' && v[3] <= '4') ? v[3] - '1' : 1;
          pure_cam_offset_t off[PURE_WIGGLE_FRAMES_MAX];
          const int n = calib_measure(r.dir, ref, off);
          s_calibrating = false;
          if (n > 0 && calib_store(off, r.id) == ESP_OK) {
            klog("P4", "calibrated %d cameras off %s: %+d,%+d %+d,%+d %+d,%+d %+d,%+d", n, r.id,
                 (int)off[0].x, (int)off[0].y, (int)off[1].x, (int)off[1].y, (int)off[2].x,
                 (int)off[2].y, (int)off[3].x, (int)off[3].y);
            /* "Landed: one soft mid tone, for a transfer that finished and
             * anything else that completes." A calibration that only ever
             * finishes once in a body's life is exactly that. */
            audio_done();
            toast("Cameras measured");
          } else {
            /* Not a failure worth a warning sound: the photograph is on the
             * card and plays the way every photograph has played until now.
             * The condition list keeps saying they are unmeasured, and the
             * next first-photograph-shaped moment tries again. */
            klog("P4", "calibration measured nothing off %s", r.id);
            toast("Not measured: aim at something with detail");
          }
          ui_render(render_screen, NULL);
        }
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
        ui_render(render_screen, NULL);
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
    /* A toast that has run its time leaves here, between frames, and the
     * repaint below is what takes it off the screen. */
    if (toast_expired()) s_toast[0] = '\0';
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
      ui_render(render_screen, NULL);
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

    /* The guest half is a live viewfinder and repaints on the same clock the
     * shoot screen does. This branch read `s_screen == SCR_SHOOT` alone, so
     * in guest mode - where s_screen is whatever the owner left behind -
     * nothing ever drew a frame after the first: the module's canvas held the
     * guest half and the panel was never handed one. The picture simply did
     * not move. Second half of the same fault as viewfinder_run() above, and
     * the Twin found both of them inside two minutes. */
    if (s_screen == SCR_SHOOT && held == -1) {
      ui_render(render_screen, NULL);
      /* Paced against the link, not the panel: new frames arrive a few times
       * a second at best. */
      return 60;
    }
    return 20;
  }
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

  /* The icon builder starts AFTER the UI. Created first it would simply run
   * to completion before the splash existed, because it outranks the task
   * calling ui_start(); created second, the UI task is already animating and
   * blocking on frame timing and the builder fills exactly those gaps. */
  return ESP_OK;
}
