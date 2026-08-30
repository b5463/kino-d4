#include "recipe_rules.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

/* The five capture keys that must be finite numbers. `resolution` is checked
 * separately because it is a string with two legal values. Same list, same
 * order as CAPTURE_NUMERIC in packages/test-fixtures/src/recipes.ts, so the
 * key named in a rejection is the same key on both sides. */
static const char *const CAPTURE_NUMERIC[] = {"jpegQuality", "exposureBias", "gainLimit",
                                              "denoise", "sharpness"};

static void fail(char *err, size_t err_cap, const char *msg) {
  if (err && err_cap) snprintf(err, err_cap, "%s", msg);
}

/* cJSON parses NaN and Infinity as nothing, so a cJSON number is normally
 * finite - but a document built in RAM (the UI, a future import path) can
 * carry one, and Number.isFinite() rejects it on the other two sides. */
static bool finite_number(const cJSON *v) { return cJSON_IsNumber(v) && isfinite(v->valuedouble); }

bool recipe_rules_id_ok(const char *id) {
  if (id == NULL) return false;
  const size_t n = strlen(id);
  if (n == 0 || n > RECIPE_ID_MAX) return false;
  /* First character: lowercase letter or digit. A leading dash is out, which
   * is what keeps an id from sorting or globbing like an option. */
  if (!((id[0] >= 'a' && id[0] <= 'z') || (id[0] >= '0' && id[0] <= '9'))) return false;
  for (size_t i = 1; i < n; i++) {
    const char c = id[i];
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') continue;
    return false;
  }
  return true;
}

bool recipe_rules_check(const cJSON *recipe, char *err, size_t err_cap) {
  if (err && err_cap) err[0] = '\0';

  if (!cJSON_IsObject(recipe)) {
    fail(err, err_cap, "Look must be a JSON object");
    return false;
  }

  const cJSON *schema = cJSON_GetObjectItem(recipe, "schema");
  if (!cJSON_IsNumber(schema) || schema->valuedouble != (double)RECIPE_SCHEMA) {
    /* The expected number is interpolated rather than written out, for the
     * same reason it is on the TypeScript side: the message and the constant
     * cannot disagree. */
    char msg[64];
    snprintf(msg, sizeof msg, "Unsupported look schema (expected %d)", RECIPE_SCHEMA);
    fail(err, err_cap, msg);
    return false;
  }

  const cJSON *id = cJSON_GetObjectItem(recipe, "id");
  if (!cJSON_IsString(id) || !recipe_rules_id_ok(id->valuestring)) {
    fail(err, err_cap, "Look id must be lowercase letters, digits and dashes");
    return false;
  }

  const cJSON *name = cJSON_GetObjectItem(recipe, "name");
  if (!cJSON_IsString(name) || name->valuestring == NULL) {
    fail(err, err_cap, "Look name must be 1-40 characters");
    return false;
  }
  {
    /* Blank means blank after trimming, so a name of four spaces is refused
     * the way String.prototype.trim() refuses it. The length limit is on the
     * UNTRIMMED string, again matching validateDeviceRecipe: r.name.length. */
    const char *s = name->valuestring;
    const size_t len = strlen(s);
    size_t trimmed = 0;
    for (size_t i = 0; i < len; i++) {
      const unsigned char c = (unsigned char)s[i];
      if (c != ' ' && c != '\t' && c != '\n' && c != '\r' && c != '\f' && c != '\v') trimmed++;
    }
    if (trimmed == 0 || len > RECIPE_NAME_MAX) {
      fail(err, err_cap, "Look name must be 1-40 characters");
      return false;
    }
  }

  const cJSON *capture = cJSON_GetObjectItem(recipe, "capture");
  if (!cJSON_IsObject(capture)) {
    fail(err, err_cap, "Look is missing the capture block");
    return false;
  }

  const cJSON *look = cJSON_GetObjectItem(recipe, "look");
  if (!cJSON_IsObject(look)) {
    fail(err, err_cap, "Look is missing the look block");
    return false;
  }

  const cJSON *res = cJSON_GetObjectItem(capture, "resolution");
  if (!cJSON_IsString(res) || res->valuestring == NULL ||
      (strcmp(res->valuestring, "1600x1200") != 0 && strcmp(res->valuestring, "2048x1536") != 0)) {
    fail(err, err_cap, "capture.resolution must be 1600x1200 or 2048x1536");
    return false;
  }

  for (size_t i = 0; i < sizeof CAPTURE_NUMERIC / sizeof CAPTURE_NUMERIC[0]; i++) {
    if (!finite_number(cJSON_GetObjectItem(capture, CAPTURE_NUMERIC[i]))) {
      char msg[64];
      snprintf(msg, sizeof msg, "capture.%s must be a number", CAPTURE_NUMERIC[i]);
      fail(err, err_cap, msg);
      return false;
    }
  }

  /* Present keys only, and that laxity is deliberate - see the note over
   * validateDeviceRecipe. A document missing look.grain is stored and the
   * firmware defaults it, because Studio's authoring validator accepts it and
   * a camera stricter than the client refuses a file the client just wrote. */
  for (const cJSON *k = look->child; k != NULL; k = k->next) {
    if (!finite_number(k)) {
      char msg[80];
      snprintf(msg, sizeof msg, "look.%s must be a number", k->string ? k->string : "");
      fail(err, err_cap, msg);
      return false;
    }
  }

  const cJSON *advanced = cJSON_GetObjectItem(recipe, "advanced");
  if (cJSON_IsObject(advanced)) {
    const cJSON *m = cJSON_GetObjectItem(advanced, "rgbMatrix");
    /* `r.advanced?.rgbMatrix &&` on the other side, so the guard is JavaScript
     * truthiness, not presence: absent, null, false, 0 and "" all skip the
     * length check. Everything else is measured, and a non-array reaches
     * cJSON_GetArraySize() as 0 - not 9, so it is refused there too. */
    const bool truthy = m != NULL && !cJSON_IsNull(m) && !cJSON_IsFalse(m) &&
                        !(cJSON_IsNumber(m) && m->valuedouble == 0.0) &&
                        !(cJSON_IsString(m) && m->valuestring && m->valuestring[0] == '\0');
    if (truthy && cJSON_GetArraySize(m) != 9) {
      fail(err, err_cap, "advanced.rgbMatrix must contain 9 values");
      return false;
    }
  }

  return true;
}
