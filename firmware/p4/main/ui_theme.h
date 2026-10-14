/*
 * The on-glass theme: every colour and type role ui.c draws with.
 *
 * ui.c asks for a colour by what it is for (K_INK, K_PRESS, K_FAULT), never
 * by a value. The values live in one place,
 * packages/design-system/kino-device-palette.json, and reach C through the
 * generated ui_palette.h (npm run palette:gen; npm run palette:check fails
 * when the header is stale). This file adds what is not a value: RGB(), the
 * type roles and K_PAIRS.
 *
 * Header only, no state. The arrays in ui_palette.h are static const and land
 * in flash. Nothing here may touch NVS or the filesystem: the Twin compiles
 * ui.c to wasm with this header.
 */
#pragma once
#include <stdint.h>

/* Written as real RGB and packed, rather than as opaque hex literals: a
 * palette nobody can read is a palette nobody will adjust. The panel is
 * RGB565, so the low 3 bits of red and blue and the low 2 of green go. */
#define RGB(r, g, b) ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))

#include "ui_palette.h"

/*
 * The launch shade, the one colour.
 *
 * Not a constant. ui.c takes row boot_count % K_LAUNCH_N of K_LAUNCH and
 * K_LAUNCH_DOWN once per start (ui_set_launch_index) and holds the two in
 * statics named s_accent and s_accent_down; these names read them. Any other
 * file that uses K_ACCENT, K_ACCENT_DOWN or K_PAIRS declares the same two
 * names first (the theme test sets them to each row in turn).
 */
#define K_ACCENT s_accent
#define K_ACCENT_DOWN s_accent_down

/* A control under a finger: the launch shade with the dark ink on it. The
 * one place colour appears at the touch of a finger; a selection that stays
 * (a segment, a toggle that is on) is K_ON, in ink. */
#define K_PRESS K_ACCENT
#define K_PRESS_INK K_ACCENT_INK

/*
 * Type roles. The six faces in ui_font.h by what they set, and the family
 * each one is cut from. Smallest first; the number is the line height in px.
 *
 *   CAPTION  T   18  Oxanium  captions, readings, group labels, the toast
 *   BODY     S   24  Inter    a screen's sentences, a value in words
 *   LABEL    R   27  Oxanium  a row's name, segments, a caps value on a row
 *   BODY_L   M   32  Inter    a fact's value, a sentence that must carry
 *   TITLE    L   41  Oxanium  a screen's title, a menu row, a look's name
 *   HERO     XL  75  Oxanium  SHOOT on the card, and nothing else
 *
 * HERO carries S, H, O and T and no other letter (tools/subset-font.mjs): the
 * other 90 glyphs were 159 KB of flash. A new HERO word with another letter
 * needs that letter added to the cut; host_preview fails until it is.
 *
 * Caps go in Oxanium and sentences in Inter, and nothing switches family to
 * make a string fit: fit_face() falls back TITLE -> LABEL and then cuts at
 * LABEL with text_fit(). A value that arrives as data takes its face from
 * what it is - text_face() sets a caps reading in the Oxanium role of the
 * same weight - and host_preview's audit fails any caps string set in Inter.
 *
 * Expanded where used, so this header needs no ui_font.h of its own. ui.c
 * names faces by these roles only; UI_FONT_* appears in it nowhere else.
 */
#define K_TYPE_CAPTION (&UI_FONT_T)
#define K_TYPE_BODY (&UI_FONT_S)
#define K_TYPE_LABEL (&UI_FONT_R)
#define K_TYPE_BODY_L (&UI_FONT_M)
#define K_TYPE_TITLE (&UI_FONT_L)
#define K_TYPE_HERO (&UI_FONT_XL)

/*
 * K_PAIRS: every ink-on-fill pair ui.c draws, with the contrast it must clear
 * in tenths (45 = 4.5:1 for text, 30 = 3.0:1 for edges, marks and the one face
 * over 18 pt). host_tests/test_theme.c expands it as
 *
 *   #define X(ink, fill, min10, where) { ink, fill, min10, #ink " on " #fill, where },
 *
 * once per launch shade (K_ACCENT and K_ACCENT_DOWN set to each row of
 * K_LAUNCH / K_LAUNCH_DOWN), and measures each with ui.c's rel_lum() on the
 * RGB565 codes. host_preview's audit measures the same strings from the
 * pixels. A pair is added here in the same change that first draws it.
 */
#define K_PAIRS(X)                                                                      \
  /* the light inks on the dark grounds */                                              \
  X(K_INK, K_GROUND, 45, "every screen's text, a photograph's name, the sleep line")    \
  X(K_INK, K_SURFACE, 45, "a value in a window, a dialog's text, a status panel")       \
  X(K_INK, K_ROW, 45, "a row's label, a menu row, a dialog's action at rest")           \
  X(K_INK, K_OFF, 45, "a toggle that is off, Cancel, a neutral press")                  \
  X(K_INK, K_TOAST, 45, "a toast")                                                      \
  X(K_INK_QUIET, K_GROUND, 45, "a caption, a photograph's second line")                 \
  X(K_INK_QUIET, K_SURFACE, 45, "a note in a window")                                   \
  X(K_INK_QUIET, K_ROW, 45, "a NOTE row's severity word")                               \
  X(K_TITLE, K_FACE, 45, "a screen's title")                                            \
  X(K_TITLE, K_SURFACE, 45, "a dialog's title")                                         \
  X(K_FAULT_INK, K_GROUND, 45, "red words on a screen")                                 \
  X(K_FAULT_INK, K_SURFACE, 45, "DELETE at rest, a destructive dialog's title")         \
  X(K_FAULT_INK, K_ROW, 45, "a PROBLEM row, a destructive dialog action at rest")       \
  /* inks on the fills */                                                               \
  X(K_ON_INK, K_ON, 45, "the live segment, a toggle's knob, a set favourite")           \
  X(K_GROUND, K_INK, 45, "SENT on a gallery tile, a QR module, the first-use pill")     \
  X(K_PRESS_INK, K_PRESS, 45, "a pressed control's label")                              \
  X(K_ACCENT_INK, K_ACCENT, 45, "TAP TO OPEN and the status line on the SHOOT card")    \
  X(K_ACCENT_INK, K_ACCENT_DOWN, 45, "the SHOOT card's words, pressed")                 \
  X(K_GROUND, K_FAULT, 45, "the lens hint, a destructive press, DELETE pressed")        \
  /* edges and marks, 3:1 */                                                            \
  X(K_EDGE, K_GROUND, 30, "a control's edge on a screen")                               \
  X(K_EDGE, K_SURFACE, 30, "a control's edge in a window")                              \
  X(K_EDGE, K_ROW, 30, "a toggle's edge on a row")                                      \
  X(K_EDGE, K_OFF, 31, "a toggle that is off: 3:1 and a margin for panel gamma")         \
  X(K_ACCENT_INK, K_ACCENT, 30, "SHOOT, the XL word on the card")                       \
  X(K_INK, K_GROUND, 30, "a four-mark cell in hand, the star, a lamp")                  \
  X(K_INK, K_RULE, 30, "a bar's fill on its track")                                     \
  X(K_INK_QUIET, K_GROUND, 30, "the offline ROLL lamp's ring")                          \
  X(K_FAULT, K_GROUND, 30, "a lost four-mark cell, a red lamp")                         \
  X(K_FAULT, K_SURFACE, 30, "a failed capture strip's bar")                             \
  X(K_ACCENT, K_GROUND, 30, "a landed four-mark cell")                                  \
  X(K_ACCENT, K_SURFACE, 30, "a landed capture strip's bar")
