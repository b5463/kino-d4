/*
 * Host tests for firmware/p4/main/meta.c — META.JSON generation, the
 * META.JSON -> CaptureSummary mapping, and config-envelope migration.
 *
 * These exercise the REAL production functions against the REAL cJSON the
 * firmware links (ESP-IDF's copy, supplied by the Makefile). Nothing here
 * reimplements the mapping: a test that duplicated the algorithm would agree
 * with a wrong algorithm.
 *
 *   make -C firmware/p4/host_tests test-meta      # needs cJSON
 *
 * Two of the three mappings below have already shipped a defect. Those two
 * defects are the reason this file exists, and each has a test named for it.
 */
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "meta.h"

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

/* ---- small readers, so the assertions stay about meaning ---- */

static const char *str_of(const cJSON *o, const char *key) {
  const cJSON *v = cJSON_GetObjectItem(o, key);
  return (cJSON_IsString(v) && v->valuestring) ? v->valuestring : NULL;
}
static double num_of(const cJSON *o, const char *key) {
  const cJSON *v = cJSON_GetObjectItem(o, key);
  return cJSON_IsNumber(v) ? v->valuedouble : -1.0;
}
static bool is_null(const cJSON *o, const char *key) {
  return cJSON_IsNull(cJSON_GetObjectItem(o, key));
}
static bool has(const cJSON *o, const char *key) {
  return cJSON_GetObjectItem(o, key) != NULL;
}

/* ------------------------------------------------------------------ */
/* meta_build_capture                                                  */
/* ------------------------------------------------------------------ */

static capture_report_t sample_report(void) {
  capture_report_t r;
  memset(&r, 0, sizeof r);
  r.ok = true;
  snprintf(r.id, sizeof r.id, "CAP_000042");
  snprintf(r.uuid, sizeof r.uuid, "3f2b9c11-4d8e-4a71-9f02-77c1de40ab55");
  snprintf(r.dir, sizeof r.dir, "/sdcard/KINO/CAPTURES/3f2b9c11-4d8e-4a71-9f02-77c1de40ab55");
  snprintf(r.mode, sizeof r.mode, "wiggle");
  snprintf(r.resolution, sizeof r.resolution, "1600x1200");
  snprintf(r.captured_at, sizeof r.captured_at, "2026-08-27T14:02:11+02:00");
  r.captured_at_ms = 1787839331000LL;
  r.clock_source = "host";
  r.status = "complete";
  snprintf(r.source, sizeof r.source, "shutter");
  r.online = 4;
  r.stored = 4;
  r.bytes = 1043 * 1024;
  r.total_ms = 3120;
  r.spread_us = 812;
  r.request_us = 5000000;
  r.probe_ms = 4;
  r.thumbnail_ms = 11;
  r.meta_commit_ms = 7;
  for (int i = 0; i < CAPTURE_CAMS; i++) {
    r.cam[i].attempted = true;
    r.cam[i].ok = true;
    r.cam[i].bytes = 260000 + i * 1000;
    r.cam[i].node_ms = 430 + i;
    r.cam[i].transfer_ms = 2800 + i * 10;
    r.cam[i].write_ms = 40 + i;
    r.cam[i].fire_us = 100 + i * 200;
    r.cam[i].crc = 0xdeadbeefu + (uint32_t)i;
    r.cam[i].crc_match = true;
    r.cam[i].dispatch_us = 5000100 + i * 200;
    r.cam[i].node_fb_get_us = 445000 + i;
    r.cam[i].node_frame_start_us = 990000 + i;
    r.cam[i].node_frame_age_us = 1200 + i;
  }
  return r;
}

static void test_meta_schema(void) {
  capture_report_t r = sample_report();
  cJSON *m = cJSON_CreateObject();
  meta_build_capture(&r, "kino-d121bc", m);

  /* kino.capture v1 required fields (packages/schemas/src/media.ts). */
  CHECK(strcmp(str_of(m, "schema") ? str_of(m, "schema") : "", "kino.capture") == 0,
        "schema -> '%s'", str_of(m, "schema"));
  CHECK(num_of(m, "version") == 1, "version -> %g", num_of(m, "version"));
  CHECK(strcmp(str_of(m, "id") ? str_of(m, "id") : "", "CAP_000042") == 0, "id -> '%s'",
        str_of(m, "id"));
  CHECK(strcmp(str_of(m, "captureUuid") ? str_of(m, "captureUuid") : "",
               "3f2b9c11-4d8e-4a71-9f02-77c1de40ab55") == 0,
        "captureUuid -> '%s'", str_of(m, "captureUuid"));
  CHECK(strcmp(str_of(m, "deviceId") ? str_of(m, "deviceId") : "", "kino-d121bc") == 0,
        "deviceId -> '%s'", str_of(m, "deviceId"));
  CHECK(strcmp(str_of(m, "mode") ? str_of(m, "mode") : "", "wiggle") == 0, "mode -> '%s'",
        str_of(m, "mode"));
  CHECK(strcmp(str_of(m, "capturedAt") ? str_of(m, "capturedAt") : "",
               "2026-08-27T14:02:11+02:00") == 0,
        "capturedAt -> '%s'", str_of(m, "capturedAt"));
  CHECK(num_of(m, "frameCount") == 4, "frameCount -> %g", num_of(m, "frameCount"));
  CHECK(strcmp(str_of(m, "resolution") ? str_of(m, "resolution") : "", "1600x1200") == 0,
        "resolution -> '%s'", str_of(m, "resolution"));
  CHECK(strcmp(str_of(m, "status") ? str_of(m, "status") : "", "complete") == 0,
        "status -> '%s'", str_of(m, "status"));
  CHECK(cJSON_IsTrue(cJSON_GetObjectItem(m, "visible")), "visible should be true");
  /* rollId is null until the capture is filed into a roll - null, not absent. */
  CHECK(is_null(m, "rollId"), "rollId should be null, not absent");

  /* The two fields that make a timestamp trustworthy. capturedAtMs is what
   * MEDIA_LIST sorts on and its absence was half of the historical bug. */
  CHECK(num_of(m, "capturedAtMs") == 1787839331000.0, "capturedAtMs -> %.0f",
        num_of(m, "capturedAtMs"));
  CHECK(strcmp(str_of(m, "clockSource") ? str_of(m, "clockSource") : "", "host") == 0,
        "clockSource -> '%s'", str_of(m, "clockSource"));
  CHECK(strcmp(str_of(m, "triggeredBy") ? str_of(m, "triggeredBy") : "", "shutter") == 0,
        "triggeredBy -> '%s'", str_of(m, "triggeredBy"));

  cJSON_Delete(m);
}

static void test_meta_timing_honesty(void) {
  capture_report_t r = sample_report();
  cJSON *m = cJSON_CreateObject();
  meta_build_capture(&r, "kino-d121bc", m);

  const cJSON *t = cJSON_GetObjectItem(m, "timing");
  CHECK(cJSON_IsObject(t), "timing must be an object");

  /*
   * THE assertion this file exists for.
   *
   * All three contract skews must be null. This firmware cannot observe
   * exposure alignment at all: the nodes expose when their command arrives
   * rather than on the trigger edge, and their rolling shutters free-run
   * (firmware/SYNC_FEASIBILITY.md). A number in any of these fields means
   * either new hardware appeared or somebody wrote a dispatch figure into a
   * synchronization field - and only one of those may happen quietly.
   */
  CHECK(is_null(t, "gpioTriggerSkewUs"), "gpioTriggerSkewUs MUST be null");
  CHECK(is_null(t, "vsyncPhaseSkewUs"), "vsyncPhaseSkewUs MUST be null");
  CHECK(is_null(t, "effectiveExposureSkewUs"), "effectiveExposureSkewUs MUST be null");

  /* Null without a reason is indistinguishable from "this build has no such
   * concept", which is the wrong message: it was measured-and-unavailable. */
  const char *why = str_of(t, "unavailableReason");
  CHECK(why != NULL && strlen(why) > 20, "unavailableReason must explain, got '%s'",
        why ? why : "(absent)");

  /* Dispatch spread is reported, under its own name, as a real number - and
   * must not have leaked into any of the three above. */
  CHECK(num_of(t, "dispatchSpreadUs") == 812, "dispatchSpreadUs -> %g",
        num_of(t, "dispatchSpreadUs"));
  CHECK(!has(t, "skewUs"), "there must be no bare 'skewUs' field");
  CHECK(!has(t, "exposureSkewUs"), "there must be no 'exposureSkewUs' field");

  /* Phase durations for bring-up. */
  CHECK(num_of(t, "probeMs") == 4, "probeMs -> %g", num_of(t, "probeMs"));
  CHECK(num_of(t, "thumbnailMs") == 11, "thumbnailMs -> %g", num_of(t, "thumbnailMs"));
  CHECK(num_of(t, "metaCommitMs") == 7, "metaCommitMs -> %g", num_of(t, "metaCommitMs"));
  CHECK(num_of(t, "totalMs") == 3120, "totalMs -> %g", num_of(t, "totalMs"));

  cJSON_Delete(m);
}

static void test_meta_frames(void) {
  capture_report_t r = sample_report();
  cJSON *m = cJSON_CreateObject();
  meta_build_capture(&r, "dev", m);

  const cJSON *frames = cJSON_GetObjectItem(m, "frames");
  CHECK(cJSON_IsArray(frames), "frames must be an array");
  CHECK(cJSON_GetArraySize(frames) == 4, "frames -> %d entries", cJSON_GetArraySize(frames));

  const cJSON *f0 = cJSON_GetArrayItem(frames, 0);
  CHECK(strcmp(str_of(f0, "cam") ? str_of(f0, "cam") : "", "cam1") == 0, "frames[0].cam -> '%s'",
        str_of(f0, "cam"));
  CHECK(strcmp(str_of(f0, "file") ? str_of(f0, "file") : "", "C1.JPG") == 0,
        "frames[0].file -> '%s'", str_of(f0, "file"));
  CHECK(num_of(f0, "bytes") == 260000, "frames[0].bytes -> %g", num_of(f0, "bytes"));
  /* CRC as lowercase 8-hex, the same convention the capture path uses. */
  const char *crc = str_of(f0, "crc32");
  CHECK(crc != NULL && strlen(crc) == 8, "frames[0].crc32 -> '%s' (want 8 hex chars)",
        crc ? crc : "(absent)");
  CHECK(crc != NULL && strcmp(crc, "deadbeef") == 0, "frames[0].crc32 -> '%s'", crc ? crc : "");
  /* Node timing, present so the stale-frame check can be done from the card
   * alone with no live KDP session. */
  CHECK(num_of(f0, "nodeFbGetUs") == 445000, "frames[0].nodeFbGetUs -> %g",
        num_of(f0, "nodeFbGetUs"));
  CHECK(num_of(f0, "nodeFrameStartUs") == 990000, "frames[0].nodeFrameStartUs -> %g",
        num_of(f0, "nodeFrameStartUs"));
  CHECK(num_of(f0, "nodeFrameAgeUs") == 1200, "frames[0].nodeFrameAgeUs -> %g",
        num_of(f0, "nodeFrameAgeUs"));
  /* Node timing must not be named as exposure anything. */
  CHECK(!has(f0, "exposureUs"), "frames[0] must not claim an exposure time");

  cJSON_Delete(m);
}

static void test_meta_partial(void) {
  /* A partial capture: cam3 failed. The frame must be present with a null
   * file and a reason, not omitted - a consumer that sees three entries and
   * no fourth cannot tell "not fitted" from "failed". */
  capture_report_t r = sample_report();
  r.stored = 3;
  r.status = "partial";
  r.cam[2].ok = false;
  r.cam[2].crc_match = false;
  snprintf(r.cam[2].err, sizeof r.cam[2].err, "link died at 41%% of 260000 B");

  cJSON *m = cJSON_CreateObject();
  meta_build_capture(&r, "dev", m);

  CHECK(num_of(m, "frameCount") == 3, "partial frameCount -> %g", num_of(m, "frameCount"));
  CHECK(strcmp(str_of(m, "status") ? str_of(m, "status") : "", "partial") == 0,
        "partial status -> '%s'", str_of(m, "status"));

  const cJSON *frames = cJSON_GetObjectItem(m, "frames");
  CHECK(cJSON_GetArraySize(frames) == 4, "a partial capture still lists 4 attempted frames");
  const cJSON *f2 = cJSON_GetArrayItem(frames, 2);
  CHECK(is_null(f2, "file"), "failed frame's file must be null");
  const char *err = str_of(f2, "error");
  CHECK(err != NULL && strlen(err) > 0, "failed frame must carry a reason");
  CHECK(!has(f2, "crc32"), "failed frame must not report a checksum it does not have");

  cJSON_Delete(m);
}

static void test_meta_not_attempted(void) {
  /* Cameras that were never asked are omitted entirely: an unfitted socket is
   * not a failure and listing it as one would make every bench capture look
   * broken. */
  capture_report_t r = sample_report();
  r.online = 1;
  r.stored = 1;
  for (int i = 1; i < CAPTURE_CAMS; i++) {
    r.cam[i].attempted = false;
    r.cam[i].ok = false;
  }
  cJSON *m = cJSON_CreateObject();
  meta_build_capture(&r, "dev", m);
  CHECK(cJSON_GetArraySize(cJSON_GetObjectItem(m, "frames")) == 1,
        "only attempted cameras appear -> %d",
        cJSON_GetArraySize(cJSON_GetObjectItem(m, "frames")));
  cJSON_Delete(m);
}

static void test_meta_unset_clock(void) {
  capture_report_t r = sample_report();
  r.clock_source = "unset";
  r.captured_at_ms = 12345000;
  snprintf(r.captured_at, sizeof r.captured_at, "1970-01-01T03:25:45+00:00");
  cJSON *m = cJSON_CreateObject();
  meta_build_capture(&r, "dev", m);
  /* An unset clock still writes a syntactically valid timestamp AND says it is
   * unset. Both halves matter: the schema requires capturedAt, and a consumer
   * needs to know not to trust it. */
  CHECK(strcmp(str_of(m, "clockSource") ? str_of(m, "clockSource") : "", "unset") == 0,
        "clockSource -> '%s'", str_of(m, "clockSource"));
  CHECK(str_of(m, "capturedAt") != NULL && strlen(str_of(m, "capturedAt")) == 25,
        "capturedAt must still be a valid 25-char timestamp");
  cJSON_Delete(m);
}

static void test_meta_survives_null(void) {
  /* Defensive: neither argument may crash the builder. */
  cJSON *m = cJSON_CreateObject();
  meta_build_capture(NULL, "dev", m);
  CHECK(cJSON_GetArraySize(m) == 0, "NULL report should write nothing");
  cJSON_Delete(m);
  capture_report_t r = sample_report();
  meta_build_capture(&r, "dev", NULL); /* must not crash */
  meta_build_capture(&r, NULL, NULL);  /* must not crash */
  CHECK(true, "NULL arguments handled");
}

/* ------------------------------------------------------------------ */
/* meta_capture_summary — the historical bug                           */
/* ------------------------------------------------------------------ */

static void test_summary_reads_real_keys(void) {
  /*
   * THE regression test for the shipped defect.
   *
   * The reader looked for `kind` and `ts`. META.JSON has never contained
   * either - it is a kino.capture document carrying `mode` and `capturedAtMs`.
   * Every listing therefore reported every capture as a wiggle taken at the
   * epoch, and the fallbacks made it look deliberate.
   *
   * A document with the RIGHT keys must produce the right summary...
   */
  cJSON *meta = cJSON_Parse(
      "{\"schema\":\"kino.capture\",\"version\":1,\"mode\":\"quad\","
      "\"capturedAtMs\":1787839331000,\"resolution\":\"2048x1536\","
      "\"frameCount\":4,\"status\":\"complete\",\"favorite\":true}");
  CHECK(meta != NULL, "fixture should parse");
  cJSON *out = cJSON_CreateObject();
  meta_capture_summary(meta, out);

  CHECK(strcmp(str_of(out, "kind") ? str_of(out, "kind") : "", "quad") == 0,
        "kind must come from `mode` -> '%s'", str_of(out, "kind"));
  CHECK(num_of(out, "ts") == 1787839331000.0, "ts must come from `capturedAtMs` -> %.0f",
        num_of(out, "ts"));
  CHECK(strcmp(str_of(out, "resolution") ? str_of(out, "resolution") : "", "2048x1536") == 0,
        "resolution -> '%s'", str_of(out, "resolution"));
  CHECK(cJSON_IsTrue(cJSON_GetObjectItem(out, "favorite")), "favorite -> true");
  CHECK(num_of(out, "frameCount") == 4, "frameCount -> %g", num_of(out, "frameCount"));
  CHECK(strcmp(str_of(out, "status") ? str_of(out, "status") : "", "complete") == 0,
        "status -> '%s'", str_of(out, "status"));
  cJSON_Delete(out);
  cJSON_Delete(meta);
}

static void test_summary_ignores_wrong_keys(void) {
  /* ...and a document carrying ONLY the old wrong keys must NOT be believed.
   * If the reader ever regresses to `kind`/`ts` this fails, which is the
   * point: the previous bug was invisible precisely because the fallbacks
   * looked like intended defaults. */
  cJSON *meta = cJSON_Parse("{\"kind\":\"quad\",\"ts\":1787839331000}");
  CHECK(meta != NULL, "fixture should parse");
  cJSON *out = cJSON_CreateObject();
  meta_capture_summary(meta, out);
  CHECK(strcmp(str_of(out, "kind") ? str_of(out, "kind") : "", "wiggle") == 0,
        "a doc with only the OLD keys must fall back, not be trusted -> '%s'",
        str_of(out, "kind"));
  CHECK(num_of(out, "ts") == 0, "ts from the old key must not be believed -> %g",
        num_of(out, "ts"));
  cJSON_Delete(out);
  cJSON_Delete(meta);
}

static void test_summary_degrades(void) {
  /* A capture whose metadata is gone is still listed, with less to say. */
  cJSON *out = cJSON_CreateObject();
  meta_capture_summary(NULL, out);
  CHECK(strcmp(str_of(out, "kind") ? str_of(out, "kind") : "", "wiggle") == 0,
        "NULL meta -> default kind");
  CHECK(num_of(out, "ts") == 0, "NULL meta -> ts 0");
  CHECK(cJSON_IsArray(cJSON_GetObjectItem(out, "recipeIds")),
        "recipeIds must be an array even with no metadata");
  CHECK(cJSON_IsFalse(cJSON_GetObjectItem(out, "favorite")), "NULL meta -> favorite false");
  CHECK(str_of(out, "resolution") != NULL, "NULL meta -> a resolution string, not absent");
  cJSON_Delete(out);

  /* Wrong TYPES must not be trusted either - a string where a number belongs
   * is a corrupt file, not a value. */
  cJSON *bad = cJSON_Parse("{\"mode\":42,\"capturedAtMs\":\"nope\",\"favorite\":\"yes\"}");
  CHECK(bad != NULL, "fixture should parse");
  cJSON *out2 = cJSON_CreateObject();
  meta_capture_summary(bad, out2);
  CHECK(strcmp(str_of(out2, "kind") ? str_of(out2, "kind") : "", "wiggle") == 0,
        "numeric mode must not be used as a string");
  CHECK(num_of(out2, "ts") == 0, "string capturedAtMs must not be used as a number");
  CHECK(cJSON_IsFalse(cJSON_GetObjectItem(out2, "favorite")),
        "string favorite must not be truthy");
  cJSON_Delete(out2);
  cJSON_Delete(bad);

  /* Empty object: every field present with its default. */
  cJSON *empty = cJSON_Parse("{}");
  cJSON *out3 = cJSON_CreateObject();
  meta_capture_summary(empty, out3);
  CHECK(has(out3, "kind") && has(out3, "ts") && has(out3, "resolution") &&
            has(out3, "favorite") && has(out3, "recipeIds"),
        "an empty document still yields a complete summary");
  cJSON_Delete(out3);
  cJSON_Delete(empty);
}

static void test_summary_recipes(void) {
  cJSON *meta = cJSON_Parse("{\"recipeIds\":[\"a\",\"b\",7,null,\"c\"]}");
  cJSON *out = cJSON_CreateObject();
  meta_capture_summary(meta, out);
  const cJSON *ids = cJSON_GetObjectItem(out, "recipeIds");
  /* Non-strings are dropped rather than coerced: a recipe id is a string and
   * a 7 in that array is a corrupt file. */
  CHECK(cJSON_GetArraySize(ids) == 3, "only string recipe ids survive -> %d",
        cJSON_GetArraySize(ids));
  cJSON_Delete(out);
  cJSON_Delete(meta);
}

/* ------------------------------------------------------------------ */
/* meta_merge_into                                                     */
/* ------------------------------------------------------------------ */

static void test_merge(void) {
  /* Deep merge: nested objects recurse, scalars replace. */
  cJSON *dst = cJSON_Parse("{\"a\":1,\"n\":{\"x\":1,\"y\":2},\"keep\":\"me\"}");
  cJSON *patch = cJSON_Parse("{\"a\":2,\"n\":{\"y\":9,\"z\":3}}");
  meta_merge_into(dst, patch);
  CHECK(num_of(dst, "a") == 2, "scalar replaced -> %g", num_of(dst, "a"));
  const cJSON *n = cJSON_GetObjectItem(dst, "n");
  CHECK(num_of(n, "x") == 1, "sibling preserved through a nested merge -> %g", num_of(n, "x"));
  CHECK(num_of(n, "y") == 9, "nested scalar replaced -> %g", num_of(n, "y"));
  CHECK(num_of(n, "z") == 3, "nested key added -> %g", num_of(n, "z"));
  CHECK(str_of(dst, "keep") != NULL, "untouched key preserved");
  cJSON_Delete(dst);
  cJSON_Delete(patch);

  /* Arrays replace whole - there is no key to match elements on, and a
   * half-merged array is worse than either outcome. */
  cJSON *d2 = cJSON_Parse("{\"arr\":[1,2,3]}");
  cJSON *p2 = cJSON_Parse("{\"arr\":[9]}");
  meta_merge_into(d2, p2);
  CHECK(cJSON_GetArraySize(cJSON_GetObjectItem(d2, "arr")) == 1,
        "array replaced whole -> %d", cJSON_GetArraySize(cJSON_GetObjectItem(d2, "arr")));
  cJSON_Delete(d2);
  cJSON_Delete(p2);

  /* An object replacing a scalar, and vice versa - type changes must not
   * silently merge into nonsense. */
  cJSON *d3 = cJSON_Parse("{\"v\":1}");
  cJSON *p3 = cJSON_Parse("{\"v\":{\"deep\":1}}");
  meta_merge_into(d3, p3);
  CHECK(cJSON_IsObject(cJSON_GetObjectItem(d3, "v")), "scalar becomes object");
  cJSON_Delete(d3);
  cJSON_Delete(p3);

  meta_merge_into(NULL, NULL); /* must not crash */
  CHECK(true, "NULL merge handled");
}

/* ------------------------------------------------------------------ */
/* meta_migrate_config                                                 */
/* ------------------------------------------------------------------ */

static cJSON *defaults_v1(void) {
  return cJSON_Parse(
      "{\"mode\":\"wiggle\",\"wiggle\":{\"resolution\":\"1600x1200\",\"jpegQuality\":85},"
      "\"body\":{\"sleepS\":120,\"autoDimS\":30}}");
}

static void test_migrate_current(void) {
  /* Current schema loads unchanged, and user values survive. */
  cJSON *root = cJSON_Parse(
      "{\"schemaVersion\":1,\"device\":\"kino-x\",\"configRevision\":7,"
      "\"config\":{\"mode\":\"quad\",\"body\":{\"sleepS\":300}}}");
  const meta_migrate_result_t res = meta_migrate_config(root, defaults_v1(), 1);
  CHECK(res == META_MIGRATE_OK, "current schema -> %d", res);

  const cJSON *cfg = cJSON_GetObjectItem(root, "config");
  CHECK(strcmp(str_of(cfg, "mode") ? str_of(cfg, "mode") : "", "quad") == 0,
        "the USER's mode must win over the default -> '%s'", str_of(cfg, "mode"));
  const cJSON *body = cJSON_GetObjectItem(cfg, "body");
  CHECK(num_of(body, "sleepS") == 300, "the user's sleepS must win -> %g",
        num_of(body, "sleepS"));
  /* Backfill: a key the stored envelope never had appears from defaults. */
  CHECK(num_of(body, "autoDimS") == 30, "missing key backfilled -> %g",
        num_of(body, "autoDimS"));
  const cJSON *wig = cJSON_GetObjectItem(cfg, "wiggle");
  CHECK(wig != NULL && num_of(wig, "jpegQuality") == 85,
        "a whole missing subtree is backfilled");
  CHECK(num_of(root, "schemaVersion") == 1, "schemaVersion stamped -> %g",
        num_of(root, "schemaVersion"));
  cJSON_Delete(root);
}

static void test_migrate_unversioned(void) {
  /* No schemaVersion means pre-versioning, which only ever meant v1. Treated
   * as v1 rather than as corrupt, so an early unit keeps its settings. */
  cJSON *root = cJSON_Parse("{\"config\":{\"mode\":\"single\"}}");
  const meta_migrate_result_t res = meta_migrate_config(root, defaults_v1(), 1);
  CHECK(res == META_MIGRATE_OK, "unversioned -> %d", res);
  const cJSON *cfg = cJSON_GetObjectItem(root, "config");
  CHECK(strcmp(str_of(cfg, "mode") ? str_of(cfg, "mode") : "", "single") == 0,
        "unversioned user value preserved -> '%s'", str_of(cfg, "mode"));
  CHECK(num_of(root, "schemaVersion") == 1, "schemaVersion added -> %g",
        num_of(root, "schemaVersion"));
  cJSON_Delete(root);
}

static void test_migrate_from_future(void) {
  /* A newer firmware's envelope is neither downgraded nor discarded: it is
   * likelier to be recovered by reflashing forward than by being overwritten.
   * Caller still owns `defaults` on this path. */
  cJSON *root = cJSON_Parse("{\"schemaVersion\":9,\"config\":{\"mode\":\"future\"}}");
  cJSON *d = defaults_v1();
  const meta_migrate_result_t res = meta_migrate_config(root, d, 1);
  CHECK(res == META_MIGRATE_FROM_FUTURE, "future schema -> %d", res);
  const cJSON *cfg = cJSON_GetObjectItem(root, "config");
  CHECK(strcmp(str_of(cfg, "mode") ? str_of(cfg, "mode") : "", "future") == 0,
        "future envelope must be left untouched -> '%s'", str_of(cfg, "mode"));
  CHECK(num_of(root, "schemaVersion") == 9, "future version must NOT be rewritten -> %g",
        num_of(root, "schemaVersion"));
  cJSON_Delete(d); /* caller still owns it on this path */
  cJSON_Delete(root);
}

static void test_migrate_unsupported(void) {
  /* A version below the target with no step defined must refuse rather than
   * silently serving a half-migrated envelope. Simulated by asking to migrate
   * v1 -> v2 while no v1->v2 step exists. */
  cJSON *root = cJSON_Parse("{\"schemaVersion\":1,\"config\":{\"mode\":\"wiggle\"}}");
  cJSON *d = defaults_v1();
  const meta_migrate_result_t res = meta_migrate_config(root, d, 2);
  CHECK(res == META_MIGRATE_UNSUPPORTED, "no path to v2 -> %d", res);
  CHECK(num_of(root, "schemaVersion") == 1,
        "a refused migration must not stamp the new version -> %g",
        num_of(root, "schemaVersion"));
  /* And it must not have half-applied the backfill. */
  const cJSON *cfg = cJSON_GetObjectItem(root, "config");
  CHECK(!has(cfg, "body"), "a refused migration must not backfill");
  cJSON_Delete(d);
  cJSON_Delete(root);
}

static void test_migrate_malformed(void) {
  /* No config member at all: the migration adds one from defaults rather than
   * failing, because an envelope with a version and no settings is still
   * recoverable. */
  cJSON *root = cJSON_Parse("{\"schemaVersion\":1}");
  const meta_migrate_result_t res = meta_migrate_config(root, defaults_v1(), 1);
  CHECK(res == META_MIGRATE_OK, "versioned but config-less -> %d", res);
  const cJSON *cfg = cJSON_GetObjectItem(root, "config");
  CHECK(cfg != NULL && str_of(cfg, "mode") != NULL, "config built from defaults");
  cJSON_Delete(root);

  /* NULL arguments refuse rather than crash. */
  CHECK(meta_migrate_config(NULL, NULL, 1) == META_MIGRATE_UNSUPPORTED,
        "NULL args must refuse");
  cJSON *d = defaults_v1();
  CHECK(meta_migrate_config(NULL, d, 1) == META_MIGRATE_UNSUPPORTED, "NULL root must refuse");
  cJSON_Delete(d);
  cJSON *r2 = cJSON_Parse("{\"schemaVersion\":1}");
  CHECK(meta_migrate_config(r2, NULL, 1) == META_MIGRATE_UNSUPPORTED,
        "NULL defaults must refuse");
  cJSON_Delete(r2);
}

int main(void) {
  test_meta_schema();
  test_meta_timing_honesty();
  test_meta_frames();
  test_meta_partial();
  test_meta_not_attempted();
  test_meta_unset_clock();
  test_meta_survives_null();

  test_summary_reads_real_keys();
  test_summary_ignores_wrong_keys();
  test_summary_degrades();
  test_summary_recipes();

  test_merge();

  test_migrate_current();
  test_migrate_unversioned();
  test_migrate_from_future();
  test_migrate_unsupported();
  test_migrate_malformed();

  if (failures != 0) {
    printf("p4 meta tests: %d of %d checks FAILED\n", failures, checks);
    return 1;
  }
  printf("p4 meta tests: %d checks passed\n", checks);
  return 0;
}
