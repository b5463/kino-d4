/*
 * The rules a look document must pass before the camera stores it. Pure C
 * over cJSON, no ESP-IDF: host-tested in firmware/p4/host_tests/test_recipe_rules.c
 * against the same cases Studio and the mock run (validateDeviceRecipe in
 * packages/test-fixtures/src/recipes.ts). The three validators must agree, or
 * Studio accepts a look file the camera then refuses.
 */
#ifndef P4_RECIPE_RULES_H
#define P4_RECIPE_RULES_H

#include <stdbool.h>
#include <stddef.h>

#include "cJSON.h"

#define RECIPE_SCHEMA 1
#define RECIPE_ID_MAX 48  /* ^[a-z0-9][a-z0-9-]{0,47}$ */
#define RECIPE_NAME_MAX 40

/** True when `recipe` is a storable look. On failure `err` (cap `err_cap`)
 * receives a one-line reason in the same words the mock uses. */
bool recipe_rules_check(const cJSON *recipe, char *err, size_t err_cap);

/** True for a well-formed look id (the regex above). */
bool recipe_rules_id_ok(const char *id);

#endif
