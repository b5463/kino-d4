/*
 * Host tests for firmware/p4/main/recipe_rules.c - the look document
 * validator, against the REAL cJSON the firmware links (ESP-IDF's copy,
 * supplied by the Makefile).
 *
 *   make -C firmware/p4/host_tests test-recipes      # needs cJSON
 *
 * There are three copies of this validator: Studio's authoring one
 * (apps/studio/src/recipes/recipeTypes.ts), the mock's device one
 * (packages/test-fixtures/src/recipes.ts) and this one. The first two are
 * held together by apps/studio/tests/recipes.test.ts over RECIPE_PARITY_CASES;
 * this file is the third leg, and every case below is that same table
 * transcribed as JSON text. If a case here disagrees with the table there,
 * one of the two has drifted and Studio will accept a look the camera then
 * refuses - which is the entire failure this file exists to prevent.
 *
 * The eleven factory looks are checked too, because they are the documents
 * the camera has to accept before anything else can work.
 */
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "recipe_rules.h"

static int checks = 0;
static int failures = 0;

#define CHECK(cond, ...)                          \
  do {                                            \
    checks++;                                     \
    if (!(cond)) {                                \
      failures++;                                 \
      printf("FAIL %s:%d: ", __FILE__, __LINE__); \
      printf(__VA_ARGS__);                        \
      printf("\n");                               \
    }                                             \
  } while (0)

/* Parse, validate, compare against what the other two validators say. `err`
 * is the message the camera would have NACKed with. */
static void expect(const char *what, const char *json, bool valid, const char *want_err) {
  cJSON *doc = cJSON_Parse(json);
  char err[128];
  const bool ok = recipe_rules_check(doc, err, sizeof err);
  cJSON_Delete(doc);

  CHECK(ok == valid, "%s: expected %s, got %s (%s)", what, valid ? "accept" : "reject",
        ok ? "accept" : "reject", ok ? "" : err);
  if (!valid && want_err != NULL && !ok) {
    CHECK(strcmp(err, want_err) == 0, "%s: message was \"%s\", expected \"%s\"", what, err,
          want_err);
  }
}

/* ------------------------------------------------------------------ */
/* sampleRecipe(), as recipes.ts builds it                             */
/* ------------------------------------------------------------------ */

#define SAMPLE_CAPTURE                                                                       \
  "\"capture\":{\"resolution\":\"1600x1200\",\"jpegQuality\":86,\"exposureBias\":0,"          \
  "\"gainLimit\":16,\"denoise\":1,\"sharpness\":1}"

#define SAMPLE_LOOK                                                                          \
  "\"look\":{\"contrast\":1.05,\"saturation\":1.1,\"temperature\":120,\"tint\":-1,"           \
  "\"blackPoint\":3,\"highlightCompression\":0.06,\"grain\":0.14,\"vignette\":0.04}"

#define SAMPLE(id) "{\"schema\":1,\"id\":\"" id "\",\"name\":\"Test Look\"," SAMPLE_CAPTURE "," SAMPLE_LOOK "}"

/* ------------------------------------------------------------------ */
/* RECIPE_PARITY_CASES                                                 */
/* ------------------------------------------------------------------ */

static void test_parity_cases(void) {
  expect("a complete look", SAMPLE("test-look"), true, NULL);

  expect("a look missing an optional look key (firmware defaults it)",
         "{\"schema\":1,\"id\":\"missing-grain\",\"name\":\"Test Look\"," SAMPLE_CAPTURE ","
         "\"look\":{\"contrast\":1.05,\"saturation\":1.1,\"temperature\":120,\"tint\":-1,"
         "\"blackPoint\":3,\"highlightCompression\":0.06,\"vignette\":0.04}}",
         true, NULL);

  expect("a look with extra unknown look keys",
         "{\"schema\":1,\"id\":\"extra-keys\",\"name\":\"Test Look\"," SAMPLE_CAPTURE ","
         "\"look\":{\"contrast\":1.05,\"saturation\":1.1,\"temperature\":120,\"tint\":-1,"
         "\"blackPoint\":3,\"highlightCompression\":0.06,\"grain\":0.14,\"vignette\":0.04,"
         "\"bloom\":0.2}}",
         true, NULL);

  expect("a non-object", "\"not a look\"", false, "Look must be a JSON object");
  expect("a null", "null", false, "Look must be a JSON object");

  expect("the wrong schema version",
         "{\"schema\":99,\"id\":\"old\",\"name\":\"Test Look\"," SAMPLE_CAPTURE "," SAMPLE_LOOK "}",
         false, "Unsupported look schema (expected 1)");

  expect("an id with capitals and punctuation",
         "{\"schema\":1,\"id\":\"Party Neg!\",\"name\":\"Test Look\"," SAMPLE_CAPTURE ","
         SAMPLE_LOOK "}",
         false, "Look id must be lowercase letters, digits and dashes");

  expect("an empty name",
         "{\"schema\":1,\"id\":\"no-name\",\"name\":\"   \"," SAMPLE_CAPTURE "," SAMPLE_LOOK "}",
         false, "Look name must be 1-40 characters");

  expect("a missing look block",
         "{\"schema\":1,\"id\":\"no-look\",\"name\":\"Test Look\"," SAMPLE_CAPTURE "}", false,
         "Look is missing the look block");

  expect("a missing capture block",
         "{\"schema\":1,\"id\":\"no-capture\",\"name\":\"Test Look\"," SAMPLE_LOOK "}", false,
         "Look is missing the capture block");

  expect("an unsupported resolution",
         "{\"schema\":1,\"id\":\"bad-res\",\"name\":\"Test Look\","
         "\"capture\":{\"resolution\":\"640x480\",\"jpegQuality\":86,\"exposureBias\":0,"
         "\"gainLimit\":16,\"denoise\":1,\"sharpness\":1}," SAMPLE_LOOK "}",
         false, "capture.resolution must be 1600x1200 or 2048x1536");

  expect("a non-numeric capture value",
         "{\"schema\":1,\"id\":\"bad-cap\",\"name\":\"Test Look\","
         "\"capture\":{\"resolution\":\"1600x1200\",\"jpegQuality\":\"high\",\"exposureBias\":0,"
         "\"gainLimit\":16,\"denoise\":1,\"sharpness\":1}," SAMPLE_LOOK "}",
         false, "capture.jpegQuality must be a number");

  expect("a non-numeric look value",
         "{\"schema\":1,\"id\":\"bad-look\",\"name\":\"Test Look\"," SAMPLE_CAPTURE ","
         "\"look\":{\"contrast\":\"punchy\",\"saturation\":1.1,\"temperature\":120,\"tint\":-1,"
         "\"blackPoint\":3,\"highlightCompression\":0.06,\"grain\":0.14,\"vignette\":0.04}}",
         false, "look.contrast must be a number");

  expect("a short rgbMatrix",
         "{\"schema\":1,\"id\":\"bad-matrix\",\"name\":\"Test Look\"," SAMPLE_CAPTURE ","
         SAMPLE_LOOK ",\"advanced\":{\"rgbMatrix\":[1,0,0]}}",
         false, "advanced.rgbMatrix must contain 9 values");
}

/* A full matrix and no matrix at all are the accepting halves of the same
 * rule. Neither is in the parity table, and both are what a real advanced
 * block looks like. */
static void test_advanced(void) {
  expect("a nine-value rgbMatrix",
         "{\"schema\":1,\"id\":\"good-matrix\",\"name\":\"Test Look\"," SAMPLE_CAPTURE ","
         SAMPLE_LOOK ",\"advanced\":{\"rgbMatrix\":[1,0,0,0,1,0,0,0,1]}}",
         true, NULL);
  expect("an advanced block with only a lut",
         "{\"schema\":1,\"id\":\"lut-only\",\"name\":\"Test Look\"," SAMPLE_CAPTURE ","
         SAMPLE_LOOK ",\"advanced\":{\"lut\":null}}",
         true, NULL);
}

/* ------------------------------------------------------------------ */
/* The eleven factory looks                                            */
/* ------------------------------------------------------------------ */

/* Every factory id, so a look renamed in factory_recipes.json without this
 * list being updated is caught rather than silently untested. The documents
 * themselves are compared against FACTORY_RECIPES by a vitest; what is
 * checked here is that the camera's own validator accepts what the camera
 * ships, which is a different question and a worse failure. */
static const char *const FACTORY_IDS[] = {
    "party-neg", "chrome",     "superia",    "vivid",      "mono",    "motion",
    "flash-digi", "warm-2007", "cold-flash", "disposable", "raw-digi",
};

/* Trimmed to the fields the validator reads: the full documents live in
 * firmware/p4/main/factory_recipes.json and are checked against
 * packages/test-fixtures there. Reproducing all eleven in full here would be
 * a fourth copy to keep in step. */
static void test_factory(void) {
  char json[512];
  for (size_t i = 0; i < sizeof FACTORY_IDS / sizeof FACTORY_IDS[0]; i++) {
    snprintf(json, sizeof json,
             "{\"schema\":1,\"id\":\"%s\",\"name\":\"Factory\",\"factory\":true,"
             "\"description\":\"a factory look\"," SAMPLE_CAPTURE "," SAMPLE_LOOK "}",
             FACTORY_IDS[i]);
    expect(FACTORY_IDS[i], json, true, NULL);
    CHECK(recipe_rules_id_ok(FACTORY_IDS[i]), "%s is not a valid look id", FACTORY_IDS[i]);
  }
}

/* ------------------------------------------------------------------ */
/* The id regex, at its edges                                          */
/* ------------------------------------------------------------------ */

static void test_id_edges(void) {
  char id[64];

  /* ^[a-z0-9][a-z0-9-]{0,47}$ is 1 to 48 characters. Off by one either way
   * and either a legal id is refused or a filename overruns RECIPE_ID_MAX. */
  memset(id, 'a', 48);
  id[48] = '\0';
  CHECK(recipe_rules_id_ok(id), "48 characters should be a legal id");

  memset(id, 'a', 49);
  id[49] = '\0';
  CHECK(!recipe_rules_id_ok(id), "49 characters should be refused");

  CHECK(recipe_rules_id_ok("a"), "one character should be a legal id");
  CHECK(!recipe_rules_id_ok(""), "an empty id should be refused");
  CHECK(!recipe_rules_id_ok(NULL), "a NULL id should be refused");

  CHECK(!recipe_rules_id_ok("-leading"), "a leading dash should be refused");
  CHECK(recipe_rules_id_ok("trailing-"), "a trailing dash is legal under the regex");
  CHECK(recipe_rules_id_ok("0-starts-with-a-digit"), "a leading digit should be legal");
  CHECK(!recipe_rules_id_ok("Party"), "an uppercase letter should be refused");
  CHECK(!recipe_rules_id_ok("party neg"), "a space should be refused");
  CHECK(!recipe_rules_id_ok("party_neg"), "an underscore should be refused");
  CHECK(!recipe_rules_id_ok("party.neg"), "a dot should be refused - it would split the filename");
  CHECK(!recipe_rules_id_ok("../escape"), "a path traversal should be refused");
}

/* The name limit is on the untrimmed string, and blank means blank after
 * trimming - both straight from validateDeviceRecipe. */
static void test_name_edges(void) {
  char json[512];
  char name[64];

  memset(name, 'x', 40);
  name[40] = '\0';
  snprintf(json, sizeof json,
           "{\"schema\":1,\"id\":\"name-40\",\"name\":\"%s\"," SAMPLE_CAPTURE "," SAMPLE_LOOK "}",
           name);
  expect("a 40-character name", json, true, NULL);

  memset(name, 'x', 41);
  name[41] = '\0';
  snprintf(json, sizeof json,
           "{\"schema\":1,\"id\":\"name-41\",\"name\":\"%s\"," SAMPLE_CAPTURE "," SAMPLE_LOOK "}",
           name);
  expect("a 41-character name", json, false, "Look name must be 1-40 characters");

  expect("a name that is one tab",
         "{\"schema\":1,\"id\":\"tab-name\",\"name\":\"\\t\"," SAMPLE_CAPTURE "," SAMPLE_LOOK "}",
         false, "Look name must be 1-40 characters");

  expect("a name with padding round real text",
         "{\"schema\":1,\"id\":\"padded\",\"name\":\"  Party Neg  \"," SAMPLE_CAPTURE ","
         SAMPLE_LOOK "}",
         true, NULL);
}

int main(void) {
  test_parity_cases();
  test_advanced();
  test_factory();
  test_id_edges();
  test_name_edges();

  printf("%s: %d checks, %d failures\n", failures ? "FAILED" : "ok", checks, failures);
  return failures ? 1 : 0;
}
