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

#endif
