// The home screen's six objects, as sprites.
//
// Two kinds, deliberately mixed. Where the object IS the product - the camera
// with its four lenses at their real 22 mm pitch - it is a rendered 3D model,
// because the geometry is the thing being shown and inventing it would be a
// lie. Where the object is a symbol - a bolt, a gear, a stack of prints -
// it is drawn: a Windows XP era icon has bold outlines, a saturated gradient
// and a gloss streak, and a shaded solid of the same shape reads flatter and
// duller than the drawing does. Personality beats simulation for a symbol.
//
// Both kinds are rendered at three times size and boxed down, so the sprites
// carry real coverage rather than a hard 1-bit edge. That anti-aliasing is
// what stops either kind looking like a screenshot of a 1998 3D demo.
#ifndef P4_ICONS_H
#define P4_ICONS_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#define ICON_PX 168

/** Build all six sprites. Requires mesh3d_init() for the rendered ones. */
esp_err_t icons_build(void);

/** True once the sprites exist. */
bool icons_ready(void);

/**
 * Composite one icon at (x, y) into a landscape RGB565 canvas, over whatever
 * is already there: its contact shadow first, then the object itself,
 * blended by coverage so the edges are smooth on any background.
 */
void icons_blit(uint16_t *canvas, int cw, int chh, int i, int x, int y);

#endif
