// Twin (wasm) stand-in for firmware/p4/main/icons_w98.h.
//
// The camera's menu icons are Microsoft's Windows 98 shell icons, which this
// repository holds no licence to redistribute (THIRD_PARTY_NOTICES.md, #134).
// The operator decision of 2026-09-05 keeps them in firmware built for the
// owner's own units; a module that runs inside a web app is one step closer
// to distribution than a binary flashed onto a private camera, so the Twin's
// committed build does NOT embed them. This header keeps the exact shape
// icons.c compiles against - the same struct, the same seven entries, the
// same box - and points the pixels at buffers the harness fills with plain
// placeholder glyphs at start-up (twin_ui.c, kui_placeholder_icons()).
//
// `make ICONS=w98` builds the private variant against the real header, for a
// local Twin on the owner's machine; nothing in the tree ships that file.
#ifndef P4_ICONS_W98_H
#define P4_ICONS_W98_H

#include <stdint.h>

#define W98_BOX 144
#define W98_COUNT 7
#define W98_MENU_COUNT 6 /* the last entry is the battery */

typedef struct {
  const char *name;     /* source file in the archive */
  uint8_t n;            /* native edge, 32 or 48 */
  uint8_t scale;        /* integer factor up to the tile box */
  const uint16_t *rgb;  /* n*n RGB565 */
  const uint8_t *alpha; /* n*n, 0 or 255 */
} w98_icon_t;

#define KUI_ICON_N 32
extern uint16_t kui_icon_rgb[W98_COUNT][KUI_ICON_N * KUI_ICON_N];
extern uint8_t kui_icon_alpha[W98_COUNT][KUI_ICON_N * KUI_ICON_N];

static const w98_icon_t W98_ICONS[W98_COUNT] = {
    {"placeholder-shoot", KUI_ICON_N, 4, kui_icon_rgb[0], kui_icon_alpha[0]},
    {"placeholder-look", KUI_ICON_N, 4, kui_icon_rgb[1], kui_icon_alpha[1]},
    {"placeholder-gallery", KUI_ICON_N, 4, kui_icon_rgb[2], kui_icon_alpha[2]},
    {"placeholder-roll", KUI_ICON_N, 4, kui_icon_rgb[3], kui_icon_alpha[3]},
    {"placeholder-settings", KUI_ICON_N, 4, kui_icon_rgb[4], kui_icon_alpha[4]},
    {"placeholder-power", KUI_ICON_N, 4, kui_icon_rgb[5], kui_icon_alpha[5]},
    {"placeholder-battery", KUI_ICON_N, 1, kui_icon_rgb[6], kui_icon_alpha[6]},
};

#define W98_BATTERY_IDX 6

#endif
