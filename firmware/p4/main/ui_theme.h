/*
 * The on-glass theme: every colour and type role ui.c draws with.
 *
 * ui.c asks for a colour by what it is for (K_INK, K_SELECT, K_FAULT), never
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

/*
 * Type roles. The six faces in ui_font.h by what they set. Smallest first;
 * the number is the face's line height in px.
 *
 *   CAPTION  T   18  captions, group labels, the toast, dialog titles
 *   BODY     S   24  a row's value and note, a screen's sentences
 *   BODY_L   R   27  a two-line row's name, a photograph's name
 *   LABEL    M   32  a one-line row's name, segments, menu row labels
 *   TITLE    L   41  a screen's title, a full-screen word
 *   HERO     XL  75  SHOOT on the card, and nothing else
 *
 * Expanded where used, so this header needs no ui_font.h of its own. ui.c
 * still names the faces directly; moving its call sites onto these roles is a
 * separate change.
 */
#define K_TYPE_CAPTION (&UI_FONT_T)
#define K_TYPE_BODY (&UI_FONT_S)
#define K_TYPE_BODY_L (&UI_FONT_R)
#define K_TYPE_LABEL (&UI_FONT_M)
#define K_TYPE_TITLE (&UI_FONT_L)
#define K_TYPE_HERO (&UI_FONT_XL)

/*
 * K_PAIRS: every ink-on-fill pair ui.c draws, with the contrast it must clear
 * in tenths (45 = 4.5:1 for text, 30 = 3.0:1 for edges, marks and the one face
 * over 18 pt). The theme test expands it as
 *
 *   #define X(ink, fill, min10, where) { ink, fill, min10, where },
 *   static const pair_t pairs[] = { K_PAIRS(X) };
 *
 * and measures each with ui.c's rel_lum() on the RGB565 codes. At these
 * values four pairs are under their floor, the #176 list: K_INK on K_SELECT
 * 2.40, K_SELECT_INK on K_FAULT 3.52, K_INK on K_FAULT 4.03, K_INK_QUIET on
 * K_ROW 4.41. host_preview's audit reports the same four from the pixels. A
 * pair is added here in the same change that first draws it.
 */
#define K_PAIRS(X)                                                                     \
  /* the light inks on the dark grounds */                                             \
  X(K_INK, K_GROUND, 45, "a photograph's name, the sleep line")                        \
  X(K_INK, K_FACE, 45, "a detail screen's text")                                       \
  X(K_INK, K_SURFACE, 45, "a value in a window, a dialog's text")                      \
  X(K_INK, K_ROW, 45, "a row's label")                                                 \
  X(K_INK, K_OFF, 45, "a neutral press, a toggle that is off, Cancel")                 \
  X(K_INK_QUIET, K_GROUND, 45, "a photograph's second line")                           \
  X(K_INK_QUIET, K_FACE, 45, "a caption on a detail screen")                           \
  X(K_INK_QUIET, K_SURFACE, 45, "a note in a window")                                  \
  X(K_INK_QUIET, K_ROW, 45, "the ROLL guest address, a NOTE row")                      \
  X(K_TITLE, K_FACE, 45, "a screen's title")                                           \
  X(K_TITLE, K_SURFACE, 45, "a dialog's title")                                        \
  X(K_ACCENT, K_ROW, 45, "a CHECK row's severity word")                                \
  X(K_FAULT_INK, K_ROW, 45, "a PROBLEM row's severity word")                           \
  X(K_FAULT_INK, K_SURFACE, 45, "DELETE at rest, a destructive dialog's title")        \
  X(K_LIVE, K_GROUND, 45, "SENT under a photograph")                                   \
  /* inks on the accent, the card and the live colour */                               \
  X(K_SELECT_INK, K_SELECT, 45, "a pressed or selected control's label")               \
  X(K_INK, K_SELECT, 45, "a dialog's action at rest (RESTART, OK)")                    \
  X(K_ACCENT_INK, K_ACCENT, 45, "TAP TO OPEN and the status line on the SHOOT card")     \
  X(K_ACCENT_INK, K_ACCENT_DOWN, 45, "the SHOOT card's words, pressed")                  \
  X(K_GROUND, K_ACCENT, 45, "a menu row's label, pressed")                             \
  X(K_LIVE, K_MENU_ROW[0], 45, "a menu row's label, top row")                          \
  X(K_LIVE, K_MENU_ROW[K_MENU_ROW_N - 1], 45, "a menu row's label, bottom row")        \
  X(K_GROUND, K_LIVE, 45, "SENT on a gallery tile")                                    \
  X(K_TOAST_INK, K_TOAST, 45, "a toast")                                               \
  /* inks on red */                                                                    \
  X(K_INK, K_FAULT, 45, "the lens hint, a destructive dialog's action")                \
  X(K_SELECT_INK, K_FAULT, 45, "DELETE, pressed")                                      \
  /* edges and marks, 3:1 */                                                           \
  X(K_EDGE, K_FACE, 30, "a control's edge on a detail screen")                         \
  X(K_EDGE, K_SURFACE, 30, "a control's edge in a window")                             \
  X(K_ACCENT_INK, K_ACCENT, 30, "SHOOT, the XL word on the card")                        \
  X(K_LIVE, K_GROUND, 30, "a four-mark cell whose camera answered")                    \
  X(K_FAULT, K_GROUND, 30, "a four-mark cell whose camera was lost")                   \
  X(K_ACCENT, K_SURFACE, 30, "the storage gauge's fill")
