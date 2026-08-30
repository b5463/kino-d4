#include "meta.h"

#include <stdio.h>
#include <string.h>

#include "cJSON.h"

/* ------------------------------------------------------------------ */
/* META.JSON generation                                                */
/* ------------------------------------------------------------------ */

void meta_build_capture(const capture_report_t *r, const char *device_id, void *meta) {
  cJSON *m = meta;
  if (r == NULL || m == NULL) return;

  cJSON_AddStringToObject(m, "schema", "kino.capture");
  cJSON_AddNumberToObject(m, "version", 1);
  cJSON_AddStringToObject(m, "id", r->id);
  cJSON_AddStringToObject(m, "captureUuid", r->uuid);
  /* The Roll snapshotted at the shutter (capture.c), or null when there was
   * none. Never the Roll active at write or upload time. */
  if (r->roll_id[0] != '\0') {
    cJSON_AddStringToObject(m, "rollId", r->roll_id);
  } else {
    cJSON_AddNullToObject(m, "rollId");
  }
  cJSON_AddStringToObject(m, "deviceId", device_id != NULL ? device_id : "");
  cJSON_AddStringToObject(m, "mode", r->mode);
  cJSON_AddStringToObject(m, "capturedAt", r->captured_at);
  /* The same instant as an epoch, because MEDIA_LIST reports `ts` in epoch
   * milliseconds and parsing ISO 8601 on the device to answer a listing would
   * be work done thousands of times to undo work done once. */
  cJSON_AddNumberToObject(m, "capturedAtMs", (double)r->captured_at_ms);
  cJSON_AddNumberToObject(m, "frameCount", r->stored);
  cJSON_AddStringToObject(m, "resolution", r->resolution);
  /* The looks in force at the shutter (capture.c snapshots them like rollId).
   * Until firmware 0.4.9 nothing filled this and MEDIA_LIST showed every
   * photograph as recipe-less; meta_capture_summary already read the key. */
  cJSON *recipes = cJSON_AddArrayToObject(m, "recipeIds");
  for (int i = 0; i < r->recipe_id_count && i < 4; i++) {
    if (r->recipe_ids[i][0] != '\0')
      cJSON_AddItemToArray(recipes, cJSON_CreateString(r->recipe_ids[i]));
  }
  cJSON_AddStringToObject(m, "status", r->status);
  cJSON_AddBoolToObject(m, "visible", true);

  /* Beyond the schema, and deliberately: a consumer that ignores these still
   * gets a valid kino.capture, and one that reads them knows what the
   * timestamp is worth. */
  cJSON_AddStringToObject(m, "clockSource", r->clock_source);
  cJSON_AddStringToObject(m, "triggeredBy", r->source);

  /* The three skews stay null. See the header: a GPIO edge the nodes ignore
   * measures nothing about exposure, and dispatch spread is not exposure
   * skew. `dispatchSpreadUs` is reported under its own name so the number is
   * available without being mistaken for one of the three. */
  cJSON *t = cJSON_AddObjectToObject(m, "timing");
  cJSON_AddNullToObject(t, "gpioTriggerSkewUs");
  cJSON_AddNullToObject(t, "vsyncPhaseSkewUs");
  cJSON_AddNullToObject(t, "effectiveExposureSkewUs");
  cJSON_AddStringToObject(t, "unavailableReason",
                          "Nodes capture on command arrival, not on the trigger edge; "
                          "rolling shutters free-run, so exposure alignment is unmeasured");
  cJSON_AddNumberToObject(t, "dispatchSpreadUs", r->spread_us);
  /* Phase durations, for first-day diagnosis. Named for the phase they
   * measure; none of them is exposure timing. */
  cJSON_AddNumberToObject(t, "probeMs", r->probe_ms);
  cJSON_AddNumberToObject(t, "thumbnailMs", r->thumbnail_ms);
  cJSON_AddNumberToObject(t, "metaCommitMs", r->meta_commit_ms);
  cJSON_AddNumberToObject(t, "totalMs", r->total_ms);

  cJSON *frames = cJSON_AddArrayToObject(m, "frames");
  for (int i = 0; i < CAPTURE_CAMS; i++) {
    const capture_frame_t *f = &r->cam[i];
    if (!f->attempted) continue;
    cJSON *e = cJSON_CreateObject();
    char cam[8];
    snprintf(cam, sizeof cam, "cam%d", i + 1);
    cJSON_AddStringToObject(e, "cam", cam);
    if (f->ok) {
      char file[12];
      snprintf(file, sizeof file, "C%d.JPG", i + 1);
      cJSON_AddStringToObject(e, "file", file);
      cJSON_AddNumberToObject(e, "bytes", f->bytes);
      char hex[12];
      snprintf(hex, sizeof hex, "%08lx", (unsigned long)f->crc);
      cJSON_AddStringToObject(e, "crc32", hex);
      cJSON_AddNumberToObject(e, "nodeMs", f->node_ms);
      cJSON_AddNumberToObject(e, "transferMs", f->transfer_ms);
      cJSON_AddNumberToObject(e, "writeMs", f->write_ms);
      cJSON_AddNumberToObject(e, "fireOffsetUs", f->fire_us);
      /* The node's own view of its capture, in the NODE's esp_timer domain -
       * comparable only against other figures from the same node. Present so
       * the stale-frame check in the M1 runbook can be done from the card
       * alone, without a live KDP session.
       *
       * frameStartUs is the driver's DMA-arm timestamp. It is frame start, not
       * exposure start or centre, and is never reported as exposure timing. */
      cJSON_AddNumberToObject(e, "nodeFbGetUs", (double)f->node_fb_get_us);
      cJSON_AddNumberToObject(e, "nodeFrameStartUs", (double)f->node_frame_start_us);
      cJSON_AddNumberToObject(e, "nodeFrameAgeUs", (double)f->node_frame_age_us);
    } else {
      cJSON_AddNullToObject(e, "file");
      cJSON_AddStringToObject(e, "error", f->err);
    }
    /*
     * What the sensor was actually set to for this frame, from the node's
     * NL_CMD_SENSOR reply - what it ACCEPTED, never what was asked for. The
     * node clamps and snaps (a look's gainLimit of 12 becomes 8X), so the two
     * differ, and a photograph whose metadata described the request rather
     * than the sensor would be worse than one that said nothing.
     *
     * Written on failed frames as well as successful ones: a frame that never
     * arrived was still exposed at these settings, and on a partial capture
     * that is exactly what someone is trying to work out.
     *
     * Absent, not zeroed, when no setting has ever reached this node's sensor.
     * Every field here has a real zero - aeLevel 0 is the sensor's own
     * metering target, denoise 0 is denoise off - so an all-zero object would
     * read as five deliberate settings.
     */
    const camlink_sensor_t *s = &f->sensor;
    if (s->has_ae_level || s->has_gain_ceiling || s->has_denoise || s->has_sharpness ||
        s->has_quality) {
      cJSON *sensor = cJSON_AddObjectToObject(e, "sensor");
      if (s->has_ae_level) cJSON_AddNumberToObject(sensor, "aeLevel", s->ae_level);
      if (s->has_gain_ceiling) cJSON_AddNumberToObject(sensor, "gainCeiling", s->gain_ceiling);
      if (s->has_denoise) cJSON_AddNumberToObject(sensor, "denoise", s->denoise);
      if (s->has_sharpness) cJSON_AddNumberToObject(sensor, "sharpness", s->sharpness);
      /* The SENSOR scale, 5..63, lower is better - not the 60..95 percentage
       * the look and Studio carry. Named `quality` because that is what the
       * node reported it wrote. */
      if (s->has_quality) cJSON_AddNumberToObject(sensor, "quality", s->quality);
    }
    cJSON_AddItemToArray(frames, e);
  }
}

/* ------------------------------------------------------------------ */
/* META.JSON -> CaptureSummary                                         */
/* ------------------------------------------------------------------ */

void meta_capture_summary(const void *meta_in, void *out_in) {
  const cJSON *meta = meta_in;
  cJSON *item = out_in;
  if (item == NULL) return;

  /*
   * `mode` and `capturedAtMs`, NOT `kind` and `ts`.
   *
   * This read `kind` and `ts`, which META.JSON has never contained - it is a
   * kino.capture document and always was. Every listing therefore reported
   * every capture as a wiggle taken at the epoch, from fallbacks that looked
   * like deliberate defaults. The WIRE names stay as CaptureSummary has them;
   * only the keys read from the file change.
   */
  const cJSON *kind = meta ? cJSON_GetObjectItem(meta, "mode") : NULL;
  cJSON_AddStringToObject(item, "kind",
                          (cJSON_IsString(kind) && kind->valuestring) ? kind->valuestring
                                                                      : "wiggle");
  const cJSON *ts = meta ? cJSON_GetObjectItem(meta, "capturedAtMs") : NULL;
  cJSON_AddNumberToObject(item, "ts", cJSON_IsNumber(ts) ? ts->valuedouble : 0);

  cJSON *recipes = cJSON_AddArrayToObject(item, "recipeIds");
  const cJSON *src = meta ? cJSON_GetObjectItem(meta, "recipeIds") : NULL;
  if (cJSON_IsArray(src)) {
    const cJSON *r = NULL;
    cJSON_ArrayForEach(r, src) {
      if (cJSON_IsString(r)) cJSON_AddItemToArray(recipes, cJSON_CreateString(r->valuestring));
    }
  }

  const cJSON *fav = meta ? cJSON_GetObjectItem(meta, "favorite") : NULL;
  cJSON_AddBoolToObject(item, "favorite", cJSON_IsTrue(fav));
  const cJSON *res = meta ? cJSON_GetObjectItem(meta, "resolution") : NULL;
  cJSON_AddStringToObject(item, "resolution",
                          (cJSON_IsString(res) && res->valuestring) ? res->valuestring
                                                                    : "1600x1200");
  /* Additive: the frame count and status the document already carries, so a
   * listing can show a partial capture as partial rather than a client
   * discovering it on download. */
  const cJSON *fc = meta ? cJSON_GetObjectItem(meta, "frameCount") : NULL;
  cJSON_AddNumberToObject(item, "frameCount", cJSON_IsNumber(fc) ? fc->valuedouble : 0);
  const cJSON *st = meta ? cJSON_GetObjectItem(meta, "status") : NULL;
  cJSON_AddStringToObject(item, "status",
                          (cJSON_IsString(st) && st->valuestring) ? st->valuestring : "unknown");
}

/* ------------------------------------------------------------------ */
/* Config envelope: deep merge and migration                           */
/* ------------------------------------------------------------------ */

void *meta_patch_path(const char *dotted, void *leaf_in) {
  cJSON *leaf = (cJSON *)leaf_in;
  if (leaf == NULL) return NULL;
  if (dotted == NULL || dotted[0] == '\0') {
    cJSON_Delete(leaf);
    return NULL;
  }

  /* Split by hand rather than with strtok_r: this file is compiled by the
   * host tests as strict C99, where strtok_r is not declared, and reaching
   * for a feature-test macro to get one function is worse than a pointer
   * walk. It also leaves `dotted` const, which strtok would not. */
  char buf[96];
  snprintf(buf, sizeof buf, "%s", dotted);

  size_t n = strlen(buf);
  while (n > 0 && buf[n - 1] == '.') buf[--n] = '\0';
  const char *p = buf;
  while (*p == '.') p++;
  if (*p == '\0') {
    cJSON_Delete(leaf);
    return NULL;
  }

  cJSON *root = cJSON_CreateObject();
  if (root == NULL) {
    cJSON_Delete(leaf);
    return NULL;
  }

  cJSON *cur = root;
  for (;;) {
    const char *dot = strchr(p, '.');
    const size_t len = dot ? (size_t)(dot - p) : strlen(p);
    char key[48];
    if (len == 0 || len >= sizeof key) {
      cJSON_Delete(root);
      cJSON_Delete(leaf);
      return NULL;
    }
    memcpy(key, p, len);
    key[len] = '\0';

    if (dot == NULL) {
      cJSON_AddItemToObject(cur, key, leaf);
      return root;
    }

    cJSON *obj = cJSON_CreateObject();
    if (obj == NULL) {
      cJSON_Delete(root);
      cJSON_Delete(leaf);
      return NULL;
    }
    cJSON_AddItemToObject(cur, key, obj);
    cur = obj;

    p = dot + 1;
    while (*p == '.') p++; /* collapse a run of separators */
  }
}

void meta_merge_into(void *dst_in, const void *patch_in) {
  cJSON *dst = dst_in;
  const cJSON *patch = patch_in;
  if (dst == NULL || patch == NULL) return;
  const cJSON *item = NULL;
  cJSON_ArrayForEach(item, patch) {
    if (item->string == NULL) continue;
    cJSON *existing = cJSON_GetObjectItem(dst, item->string);
    if (cJSON_IsObject(item) && cJSON_IsObject(existing)) {
      meta_merge_into(existing, item);
      continue;
    }
    cJSON *copy = cJSON_Duplicate(item, true);
    if (copy == NULL) continue;
    if (existing != NULL) cJSON_ReplaceItemInObject(dst, item->string, copy);
    else cJSON_AddItemToObject(dst, item->string, copy);
  }
}

meta_migrate_result_t meta_migrate_config(void *root_in, void *defaults_in, int target_version) {
  cJSON *root = root_in;
  cJSON *defaults = defaults_in;
  if (root == NULL || defaults == NULL) return META_MIGRATE_UNSUPPORTED;

  const cJSON *ver = cJSON_GetObjectItem(root, "schemaVersion");
  /* Absent means pre-versioning. Treated as v1 rather than as corrupt: the
   * only firmware that ever wrote an unversioned envelope wrote a v1 one. */
  int from = cJSON_IsNumber(ver) ? (int)ver->valuedouble : 1;
  if (from < 1) from = 1;

  if (from > target_version) return META_MIGRATE_FROM_FUTURE;

  while (from < target_version) {
    switch (from) {
      /* case 1: migrate_v1_to_v2(root); break;   <- the shape future steps take */
      default:
        return META_MIGRATE_UNSUPPORTED;
    }
    from++;
  }

  /* Backfill: defaults are the destination, stored values are the patch, so a
   * setting the user changed always wins over its default. */
  cJSON *stored = cJSON_GetObjectItem(root, "config");
  if (cJSON_IsObject(stored)) meta_merge_into(defaults, stored);

  /* Ownership transfers here; the caller must not delete `defaults` after a
   * success. cJSON_ReplaceItemInObject frees the old child. */
  if (stored != NULL) cJSON_ReplaceItemInObject(root, "config", defaults);
  else cJSON_AddItemToObject(root, "config", defaults);

  cJSON *v = cJSON_GetObjectItem(root, "schemaVersion");
  if (cJSON_IsNumber(v)) cJSON_SetNumberValue(v, (double)target_version);
  else cJSON_AddNumberToObject(root, "schemaVersion", target_version);
  return META_MIGRATE_OK;
}
