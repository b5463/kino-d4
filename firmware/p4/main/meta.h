/**
 * The JSON documents the camera writes and reads, isolated so they can be
 * host-tested against the real cJSON.
 *
 * Three mappings live here, and two of them have already shipped a defect:
 *
 *   - `META.JSON` generation. The document that makes a folder of JPEGs a
 *     capture, and the only description of a photograph that leaves the
 *     device on the card. It must satisfy `kino.capture` v1
 *     (`packages/schemas/src/media.ts`).
 *   - `META.JSON` → `CaptureSummary` for MEDIA_LIST. This read `kind` and
 *     `ts`, keys the document has never contained, so every gallery listing
 *     reported every capture as a wiggle taken at the epoch — from fallbacks
 *     that looked like deliberate defaults.
 *   - Config envelope migration and deep merge. `schemaVersion` was written
 *     and never read.
 *
 * All three were unreachable by any test, because the files they lived in pull
 * in FreeRTOS, SDMMC, the JPEG codec and NVS. This module needs only cJSON,
 * `capture.h` (a plain struct) and libc, so `firmware/p4/host_tests` compiles
 * it natively and exercises the real production path rather than a copy.
 *
 * Rules: no ESP-IDF headers beyond `esp_err.h`, no allocation the caller does
 * not own, no I/O, no globals. Anything needing those belongs to its caller.
 */
#ifndef P4_META_H
#define P4_META_H

#include <stdbool.h>
#include <stdint.h>

#include "capture.h"
#include "pure.h" /* pure_cam_offset_t, for the calibration reader */

/* cJSON objects are passed as void* so callers that do not use cJSON — and
 * the public capture.h surface — need not include it. */

/**
 * Read a `calibration.cams.camN` block out of a parsed META.JSON into four
 * offsets in camera order (cam1..cam4). Returns true when the document carried
 * a calibration block at all; false leaves `out` all-zero.
 *
 * This is the capture's OWN truth about where its lenses sat - preferred over
 * live device calibration because it is what was true at the shutter press
 * (types.ts, MEDIA_INFO `meta.calibration`). Current firmware writes no such
 * block, so this returns false on every capture on any card today, and the
 * playback path then aligns nothing. A camera absent from the block, or a field
 * missing, is a zero for that camera - never a guess. `out` must hold at least
 * PURE_WIGGLE_FRAMES_MAX entries.
 */
bool meta_read_calibration(const void *meta, pure_cam_offset_t *out);

/**
 * Write a `kino.capture` v1 document for `r` into `meta` (a cJSON object).
 *
 * `device_id` is stamped in so a card in the wrong bag still says which body
 * took the pictures.
 *
 * The three `timing` skews are ALWAYS null with an `unavailableReason`. That
 * is not a placeholder: the nodes expose on command arrival rather than on the
 * trigger edge and their rolling shutters free-run, so this firmware cannot
 * observe exposure alignment at all. `dispatchSpreadUs` is reported under its
 * own name precisely so it can never be mistaken for one of them.
 */
void meta_build_capture(const capture_report_t *r, const char *device_id, void *meta);

/**
 * Map a parsed `META.JSON` onto the fields `CaptureSummary` needs.
 *
 * `meta` may be NULL or a document missing anything — a capture whose metadata
 * is gone is still listed, with less to say about it. Fills `out` with `kind`,
 * `ts`, `resolution`, `favorite` and `recipeIds`, reading the keys the
 * document actually contains (`mode`, `capturedAtMs`) rather than keys that
 * only ever existed in the reader.
 */
void meta_capture_summary(const void *meta, void *out);

/**
 * Recursively merge `patch` into `dst`.
 *
 * Objects recurse; everything else replaces. An array is replaced whole rather
 * than merged element-wise, because there is no key to match elements on and a
 * half-merged array is worse than either outcome.
 */
void meta_merge_into(void *dst, const void *patch);

typedef enum {
  META_CRED_NONE = 0, /* no roll.credentials.deviceToken in the patch */
  META_CRED_OK,       /* deviceId + deviceToken taken out; token blanked in the patch */
  META_CRED_INVALID   /* a token was there but no id, or one did not fit; blanked anyway */
} meta_credential_t;

/**
 * Take `roll.credentials.{deviceId, deviceToken}` OUT of a config patch.
 *
 * deviceToken is write-only by contract and must never sit in the config
 * document: Studio provisions through SET_CONFIG (rollOps.ts
 * registerRollDevice -> applyConfig) and until 0.4.23 the pair was merged into
 * config where nothing read it - roll_http takes its bearer from roll_state.
 * On OK the pair is copied out for roll_state_set_credential() and the
 * patch's deviceToken is replaced by "" so what gets merged and saved carries
 * no secret; on INVALID the token is blanked all the same. `patch` is a cJSON
 * object; caps are the destination sizes including the terminator.
 */
meta_credential_t meta_take_roll_credential(void *patch, char *device_id, size_t id_cap,
                                            char *token, size_t token_cap);

/**
 * Wrap `leaf` in the nested objects named by a dotted path.
 *
 * `"body.sounds.ui"` with a `true` leaf returns
 * `{"body":{"sounds":{"ui":true}}}` — the shape `config_merge` deep-merges, so
 * every other setting under `body` survives untouched. Returns a new cJSON
 * object the caller owns, or NULL on allocation failure or an empty path (in
 * which case `leaf` is deleted, so no caller has to unwind a partial build).
 *
 * This is how every control on the device writes its setting. It lives here
 * rather than in ui.c because the first version dropped the FIRST path
 * segment — `"body.sounds.ui"` built `{"sounds":{"ui":...}}` — which merges
 * perfectly happily into the config root and silently writes a setting nobody
 * reads. Nothing about the screen would have looked wrong.
 */
void *meta_patch_path(const char *dotted, void *leaf);

/** What a migration attempt concluded. */
typedef enum {
  META_MIGRATE_OK = 0,       /* at target version, defaults backfilled */
  META_MIGRATE_FROM_FUTURE,  /* newer than we understand; left untouched */
  META_MIGRATE_UNSUPPORTED,  /* no path from the stored version; discard it */
} meta_migrate_result_t;

/**
 * Bring a stored config envelope up to `target_version`.
 *
 * `root` is the envelope (`{schemaVersion, device, configRevision, config}`).
 * `defaults` is a freshly-built default `config` object which this function
 * TAKES OWNERSHIP of on success — it becomes the envelope's `config` after the
 * stored values are merged over it. On any non-OK result the caller still owns
 * `defaults` and must delete it.
 *
 * Direction is deliberate: defaults are the destination and the stored values
 * are the patch, so a setting the user changed always beats its default. The
 * reverse would silently reset the camera on every upgrade.
 *
 * A FUTURE envelope is neither migrated downward nor discarded: a newer
 * firmware's settings are likelier to be recovered by reflashing forward than
 * by being overwritten.
 */
meta_migrate_result_t meta_migrate_config(void *root, void *defaults, int target_version);

#endif
