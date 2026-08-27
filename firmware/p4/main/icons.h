// The home screen's six objects, as sprites.
//
// They are the Windows XP (Luna) desktop icons, baked into icons_xp.h at the
// 48 px grid they were drawn on and expanded here. Five of the six they
// replaced were polygons this file drew by hand in the same style; a drawn
// imitation of an icon set is worse than the icon set, and the camera's whole
// visual argument is that it belongs to that desktop.
//
// The expansion is not a resize. A 48 px icon scaled cleanly to 168 px on a
// 480x800 panel reads far sharper than it ever did on the ~96 DPI CRT it was
// drawn for, and lands on the screen looking like clip art. So the source
// pixels stay square with a soft edge, and the scanlines, aperture-grille
// triads and bloom of that monitor go on top. See icons.c for the numbers.
//
// No contact shadow is added. XP icons carry their own drop shadow in their
// alpha, and a second one underneath put two light sources on one tile.
#ifndef P4_ICONS_H
#define P4_ICONS_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/* 3.5 source pixels per side. Not an integer multiple, deliberately - see
 * SCALE in icons.c. */
#define ICON_PX 168

/** Expand all six sprites. No longer needs mesh3d(); the set is all raster. */
esp_err_t icons_build(void);

/** True once the sprites exist. */
bool icons_ready(void);

/**
 * Composite one icon at (x, y) into a landscape RGB565 canvas, over whatever
 * is already there, blended by coverage so the edges are smooth on any
 * background.
 */
void icons_blit(uint16_t *canvas, int cw, int chh, int i, int x, int y);

#endif
