/**
 * Measuring the four cameras against each other, once, on the first
 * photograph.
 *
 * ui.c has carried this comment since the wigglegram player was written:
 *
 *     2. failing that, the live device calibration - and this body HAS none:
 *        nothing in the firmware stores per-camera offsets [...] so every
 *        capture on every card today reaches step 3.
 *
 * This is step 2. The four sensors sit about 19 mm apart on their own mounts,
 * and nothing puts them on a common optical axis to better than a few sensor
 * pixels of yaw and mounting slop. Played straight off the card the subject
 * lurches between frames; corrected, only the parallax moves - which is the
 * photograph this camera exists to take.
 *
 * ## It measures. It never guesses.
 *
 * pure.h's rule is absolute and it is the reason this file is arithmetic on
 * real pixels rather than a table of plausible numbers: a guessed correction
 * moves the subject to a place it never was, and it does it silently, on
 * every photograph, forever. So the offsets come out of the first capture's
 * own four frames by translation search, or they do not exist and the player
 * takes the untouched path it takes today.
 *
 * Rotation is not measured and is stored as zero. A translation search cannot
 * see it, and writing a number this code did not measure into a field that
 * says `rot` is the same failure as inventing the offsets.
 *
 * ## Why the first photograph
 *
 * Because it is the only moment the camera is guaranteed to be pointed at
 * something with structure in it, at a distance someone chose, with the
 * exposure they wanted. A calibration screen asking the user to point at a
 * flat lit wall is a screen most people will skip and some will do wrong; the
 * first frame they actually take is better data and costs them nothing.
 */
#ifndef KINO_CALIBRATE_H
#define KINO_CALIBRATE_H

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "config_store.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "pure.h"
#include "thumb.h"

/* The working resolution. 160x120 is a 4:3 tile the JPEG scaler reaches in
 * whole sixteenths, it is small enough that a full search is milliseconds,
 * and one working pixel is ten sensor pixels at the 1600-wide base the stored
 * offsets are measured against - which is finer than the mounting tolerance
 * this is correcting for. */
#define CAL_W 160
#define CAL_H 120
#define CAL_SCALE (PURE_ALIGN_SENSOR_BASE_W / CAL_W) /* 10 */

/* How far a camera can be out, in working pixels, and how the search gets
 * there: a stride-3 sweep of the whole window, then +-2 around the best of
 * it. The full window is 625 positions per camera and the two-stage is 105,
 * for the same answer on any surface whose SAD is not pathological. */
#define CAL_RANGE 12
#define CAL_COARSE 3

/* The measurement is taken on the middle of the frame. The edges of four
 * cameras 19 mm apart do not see the same scene at all, so matching there is
 * matching on content only one of them has. */
#define CAL_MARGIN_X (CAL_W / 5)
#define CAL_MARGIN_Y (CAL_H / 5)
/* Every second pixel on both axes: a quarter of the reads for a SAD surface
 * that is identical at this scale. */
#define CAL_STEP 2

/** Read the stored calibration. False when the body has never been measured,
 *  and then `out` is all zeros and the caller must take the untouched path. */
static bool calib_load(pure_cam_offset_t *out) {
  for (int i = 0; i < PURE_WIGGLE_FRAMES_MAX; i++) out[i] = (pure_cam_offset_t){0, 0, 0};
  if (!config_bool("body.calibration.done", false)) return false;
  for (int i = 0; i < 4 && i < PURE_WIGGLE_FRAMES_MAX; i++) {
    char kx[40], ky[40];
    snprintf(kx, sizeof kx, "body.calibration.cam%d.x", i + 1);
    snprintf(ky, sizeof ky, "body.calibration.cam%d.y", i + 1);
    out[i].x = config_int(kx, 0);
    out[i].y = config_int(ky, 0);
    out[i].rot = 0;
  }
  return true;
}

/** RGB565 to 8-bit luma, in place into `y`. */
static void cal_luma(const uint16_t *px, uint8_t *y) {
  for (int i = 0; i < CAL_W * CAL_H; i++) {
    const uint16_t p = px[i];
    const int r = ((p >> 11) & 31) << 3, g = ((p >> 5) & 63) << 2, b = (p & 31) << 3;
    /* 2/4/1 rather than 601's weights: this is a matching surface, not a
     * picture, and the shift is one instruction. */
    y[i] = (uint8_t)((2 * r + 4 * g + b) >> 3);
  }
}

/** Sum of absolute differences between `a` and `b` shifted by (dx, dy). */
static uint32_t cal_sad(const uint8_t *a, const uint8_t *b, int dx, int dy) {
  uint32_t sum = 0;
  for (int y = CAL_MARGIN_Y; y < CAL_H - CAL_MARGIN_Y; y += CAL_STEP) {
    const uint8_t *ra = a + y * CAL_W;
    const uint8_t *rb = b + (y + dy) * CAL_W + dx;
    for (int x = CAL_MARGIN_X; x < CAL_W - CAL_MARGIN_X; x += CAL_STEP) {
      const int d = (int)ra[x] - (int)rb[x];
      sum += (uint32_t)(d < 0 ? -d : d);
    }
  }
  return sum;
}

/** The (dx, dy) at which `b` best matches `a`. Coarse sweep, then refine. */
static void cal_search(const uint8_t *a, const uint8_t *b, int *out_dx, int *out_dy) {
  int bx = 0, by = 0;
  uint32_t best = 0xFFFFFFFFu;
  for (int dy = -CAL_RANGE; dy <= CAL_RANGE; dy += CAL_COARSE)
    for (int dx = -CAL_RANGE; dx <= CAL_RANGE; dx += CAL_COARSE) {
      const uint32_t s = cal_sad(a, b, dx, dy);
      if (s < best) { best = s; bx = dx; by = dy; }
    }
  const int cx = bx, cy = by;
  for (int dy = cy - CAL_COARSE + 1; dy <= cy + CAL_COARSE - 1; dy++)
    for (int dx = cx - CAL_COARSE + 1; dx <= cx + CAL_COARSE - 1; dx++) {
      if (dx < -CAL_RANGE || dx > CAL_RANGE || dy < -CAL_RANGE || dy > CAL_RANGE) continue;
      const uint32_t s = cal_sad(a, b, dx, dy);
      if (s < best) { best = s; bx = dx; by = dy; }
    }
  *out_dx = bx;
  *out_dy = by;
}

/**
 * Measure one capture's frames.
 *
 * `dir` is the capture folder, `ref` the camera everything is measured
 * against - the one the user aims with, so the corrected photograph sits
 * where they framed it rather than halfway between two lenses.
 *
 * Returns how many cameras were measured against the reference, 0 when it
 * could not be done. A frame that will not decode is skipped and left at zero
 * rather than guessed; a body with one lens fitted measures nothing and stays
 * honestly uncalibrated.
 *
 * SIGN: the search finds the (dx, dy) at which frame i sampled at (x+dx,
 * y+dy) matches the reference at (x, y) - so frame i's content sits +dx to
 * the right of where the reference has it, and the correction that brings it
 * back is -dx. Stored at the 1600-wide sensor base, which is what
 * pure_align_plan() scales from.
 */
static int calib_measure(const char *dir, int ref, pure_cam_offset_t *out) {
  for (int i = 0; i < PURE_WIGGLE_FRAMES_MAX; i++) out[i] = (pure_cam_offset_t){0, 0, 0};
  if (dir == NULL || dir[0] == '\0') return 0;

  uint16_t *tile = heap_caps_malloc((size_t)CAL_W * CAL_H * sizeof(uint16_t),
                                    MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (tile == NULL) tile = malloc((size_t)CAL_W * CAL_H * sizeof(uint16_t));
  uint8_t *luma[4] = {0};
  bool have[4] = {0};
  int n = 0;
  if (tile == NULL) return 0;

  for (int i = 0; i < 4; i++) {
    char path[160];
    snprintf(path, sizeof path, "%s/C%d.JPG", dir, i + 1);
    if (thumb_load(path, tile, CAL_W, CAL_H, 0) != ESP_OK) continue;
    luma[i] = heap_caps_malloc((size_t)CAL_W * CAL_H, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (luma[i] == NULL) luma[i] = malloc((size_t)CAL_W * CAL_H);
    if (luma[i] == NULL) continue;
    cal_luma(tile, luma[i]);
    have[i] = true;
  }
  free(tile);

  if (!have[ref & 3]) {
    /* The aiming lens did not decode. Everything is measured against it, so
     * there is nothing to measure against and the body stays uncalibrated
     * rather than calibrated to whichever lens happened to answer. */
    for (int i = 0; i < 4; i++) free(luma[i]);
    return 0;
  }
  for (int i = 0; i < 4; i++) {
    if (!have[i] || i == (ref & 3)) continue;
    int dx = 0, dy = 0;
    cal_search(luma[ref & 3], luma[i], &dx, &dy);
    out[i].x = -(double)dx * CAL_SCALE;
    out[i].y = -(double)dy * CAL_SCALE;
    out[i].rot = 0;
    n++;
  }
  for (int i = 0; i < 4; i++) free(luma[i]);
  return n;
}

/**
 * Write it to the config, so the next boot has it.
 *
 * Built with cJSON_CreateObject/AddItemToObject only. The Add*ToObject
 * convenience wrappers are not in the host preview's cJSON shim, and a
 * calibration that cannot be rendered by the tool the screens are judged in
 * is a calibration nobody will look at.
 */
static esp_err_t calib_store(const pure_cam_offset_t *off, const char *from) {
  cJSON *root = cJSON_CreateObject();
  cJSON *body = cJSON_CreateObject();
  cJSON *cal = cJSON_CreateObject();
  if (root == NULL || body == NULL || cal == NULL) {
    cJSON_Delete(root);
    cJSON_Delete(body);
    cJSON_Delete(cal);
    return ESP_ERR_NO_MEM;
  }
  cJSON_AddItemToObject(cal, "done", cJSON_CreateBool(true));
  /* Which capture it came from. A calibration with no provenance cannot be
   * argued with later, and the first question about a bad one is always
   * "measured off what". */
  if (from != NULL && from[0]) cJSON_AddItemToObject(cal, "from", cJSON_CreateString(from));
  for (int i = 0; i < 4; i++) {
    char key[8];
    snprintf(key, sizeof key, "cam%d", i + 1);
    cJSON *c = cJSON_CreateObject();
    if (c == NULL) continue;
    cJSON_AddItemToObject(c, "x", cJSON_CreateNumber((int)off[i].x));
    cJSON_AddItemToObject(c, "y", cJSON_CreateNumber((int)off[i].y));
    cJSON_AddItemToObject(cal, key, c);
  }
  cJSON_AddItemToObject(body, "calibration", cal);
  cJSON_AddItemToObject(root, "body", body);
  const esp_err_t err = config_merge(root);
  cJSON_Delete(root);
  if (err != ESP_OK) return err;
  return config_save();
}

#endif /* KINO_CALIBRATE_H */
