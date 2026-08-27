// The menu icons, as sprites.
//
// They are Windows 98 shell icons, baked at their native 48 or 32 px by
// scripts/bake-w98-icons.mjs and scaled here by an integer factor with
// NEAREST NEIGHBOUR. That last part is the whole design: these are pixel art
// with hand-placed dither, and any resampler that interpolates averages the
// dither into flat mush and throws away the reason for using the originals
// instead of redrawing them.
//
// A light display emulation goes on top - scanlines at the source-row pitch,
// a faint aperture-grille triad, a small bloom. Much lighter than the pass
// the XP set used, because that one was compensating for a smooth upscale;
// here the pixels are already hard and the treatment only has to keep them
// from looking like a PNG pasted on a modern panel.
#ifndef P4_ICONS_H
#define P4_ICONS_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "icons_w98.h"

/** The tile art box. Every menu icon is drawn centred inside this. */
#define ICON_BOX W98_BOX

/** Build every sprite. Costs one pass over each icon; see icons.c. */
esp_err_t icons_build(void);

/** True once the sprites exist. */
bool icons_ready(void);

/** Drawn edge of sprite `i` in device pixels - native size times its factor. */
int icons_edge(int i);

/**
 * Composite sprite `i` with its top-left at (x, y), over whatever is already
 * there. The ICO mask is one bit, so edges are hard by construction; only the
 * bloom carries partial coverage.
 */
void icons_blit(uint16_t *canvas, int cw, int ch, int i, int x, int y);

/** Composite sprite `i` centred on (cx, cy). */
void icons_blit_centred(uint16_t *canvas, int cw, int ch, int i, int cx, int cy);

#endif
