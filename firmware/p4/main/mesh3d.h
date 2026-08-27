// A small shaded 3D renderer, and the camera's icon set as its models.
//
// Software, not a GPU: the P4 has no 3D hardware, but it has a single
// precision FPU and the canvas is linear, so a few hundred z-buffered
// triangles is affordable. The PPA still does the rotation to the panel, so
// this only ever draws into landscape memory.
//
// The reference camera's home screen gets its character from illustrated
// icons rather than from coloured blocks. Illustration we do not have; a
// renderer we do, and objects modelled and lit here are ours, consistent with
// each other by construction, and correct - the camera icon is the real
// camera bar, four lenses with centres at -33, -11, +11 and +33 mm, which is
// the 22 mm default pitch from docs/HARDWARE.md.
#ifndef P4_MESH3D_H
#define P4_MESH3D_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/* One model, and one only.
 *
 * The camera earns a renderer because it IS the product: four lenses on a
 * rigid bar at their real 22 mm pitch, and a shaded solid is the honest way
 * to show a thing that exists. Every other tile is a symbol, and a symbol
 * drawn flat with a hard outline reads better at 168 px than a shaded solid
 * of the same shape does - which is why the rest live in icons.c as
 * paintings. */
typedef enum {
  M3_CAMERA = 0,
  M3_COUNT,
} m3_model_t;

/** Build every model and allocate a depth buffer for a vw x vh viewport. */
esp_err_t mesh3d_init(int vw, int vh);

/** True once the models and depth buffer exist. */
bool mesh3d_ready(void);

/**
 * Draw one model into a viewport of a landscape RGB565 canvas.
 *
 * Framing is automatic: each model carries its own bounding sphere, and the
 * camera is placed so that sphere fills the viewport times `zoom`. That is
 * what keeps six differently sized objects looking like one icon set instead
 * of six unrelated renders, without six hand-tuned distances to drift.
 *
 * The viewport is cleared to `bg` first and nothing outside it is touched.
 */
void mesh3d_draw(uint16_t *canvas, int cw, int ch, int vx, int vy, int vw, int vh,
                 m3_model_t model, float yaw, float pitch, float zoom, uint16_t bg);

#endif
