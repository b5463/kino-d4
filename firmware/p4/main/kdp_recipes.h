/*
 * Looks (recipes) on the camera: GET_RECIPES, SET_RECIPE, UPLOAD_RECIPE,
 * DELETE_RECIPE. Factory looks are compiled in; custom looks live on the card.
 *
 * The eleven factory looks are the embedded factory_recipes.json, which is
 * held byte-identical to FACTORY_RECIPES in packages/test-fixtures by a vitest
 * parity check. They are parsed once at boot and never written, so they list
 * with no card in the slot; custom looks are /sdcard/KINO/RECIPES/<id>.json
 * and are simply absent when the card is.
 *
 * The camera stores and reports a look. It does not apply one - there is no
 * grading anywhere in this firmware - so a look is a label on a capture that
 * the host acts on at import. The LOOK screen says so.
 */
#ifndef P4_KDP_RECIPES_H
#define P4_KDP_RECIPES_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cJSON.h"
#include "esp_err.h"
#include "kdp_module.h"
#include "recipe_rules.h"

/** Once at boot, after the card is mounted. Failure is logged, never fatal. */
esp_err_t kdp_recipes_init(void);

/** What GET_CAPABILITIES reports as `recipes`. */
bool kdp_recipes_capable(void);

/** One of the four recipe commands. `req` may be NULL. Takes the card lock
 * itself for the commands that touch it. */
kdp_module_reply_t kdp_recipes_handle(uint8_t cmd, const cJSON *req);

/* For the LOOK screen: the looks the picker cycles through, factory first and
 * then custom, in one flat 0..count-1 order. The UI gets them from here rather
 * than opening /sdcard/KINO/RECIPES itself, because the card is arbitrated and
 * a draw must never block on it. */

#define KDP_RECIPE_NAME_MAX (RECIPE_NAME_MAX + 1)
#define KDP_RECIPE_ID_MAX (RECIPE_ID_MAX + 1)

/** Factory looks plus the custom looks currently on the card. */
int kdp_recipes_count(void);

/** Look `index` (0-based). False past the end; `id` and `name` may be NULL. */
bool kdp_recipes_name(int index, char *id, size_t id_cap, char *name, size_t name_cap);

/**
 * One look's `capture` block, for the shutter.
 *
 * This is the half of a look the camera DOES act on. The `look` block
 * (contrast, saturation, temperature, ...) stays Studio's business at import -
 * there is no grading anywhere in this firmware - but the capture block names
 * sensor knobs, and capture.c now puts them into the sensor before the
 * trigger.
 *
 * A `has_` flag per field rather than a sentinel, because every one of these
 * has a real zero: exposureBias 0 is the metered exposure, denoise 0 is
 * denoise off, sharpness 0 is neutral. recipe_rules_check() requires all five
 * numbers plus the resolution on a look that reaches the card, so a full block
 * is the normal case - the flags are for the document that got there another
 * way, and for the fields a future look version adds or drops.
 *
 * `jpeg_quality_percent` is the 60..95 contract percentage, HIGHER is better.
 * It is NOT the sensor scale; pure_quality_to_sensor() converts.
 * `gain_limit` is a gain-ceiling x-factor as the look document writes it -
 * an arbitrary number (the factory looks carry 12 and 16), snapped to a real
 * gainceiling_t step by the node.
 */
typedef struct {
  char resolution[16];
  int jpeg_quality_percent; /* 60..95, higher is better */
  double exposure_bias;     /* EV */
  int gain_limit;           /* gain-ceiling x-factor, pre-snap */
  int denoise;
  int sharpness;
  bool has_resolution;
  bool has_jpeg_quality;
  bool has_exposure_bias;
  bool has_gain_limit;
  bool has_denoise;
  bool has_sharpness;
} recipe_capture_t;

/**
 * Fill `out` with look `id`'s capture block. False when there is no such look,
 * when the card could not be taken, or when the document has no capture block.
 *
 * Factory looks come from the embedded array and need no card at all. Custom
 * looks come from the RAM mirror plus one read off the card, under the same
 * lock discipline as every other card read here (`storage_acquire_unless_held`
 * with RECIPES_CARD_WAIT_MS) - so the shutter, which already holds the card,
 * does not deadlock against itself, and a page load mid-capture still gets a
 * BUSY rather than the card.
 */
bool kdp_recipes_capture_block(const char *id, recipe_capture_t *out);

#endif
