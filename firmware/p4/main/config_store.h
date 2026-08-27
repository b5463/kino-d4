// The camera's settings, as Studio and Twin read and write them.
//
// The shape is KinoConfig from packages/kdp/src/protocol/types.ts, which is
// normative: mode, wiggle, quad, shoot, body. It always travels inside the
// versioned envelope the contract describes - schemaVersion, device,
// configRevision, config - so a firmware rename becomes a migration rather
// than a broken Studio.
//
// Held as a cJSON document rather than a C struct, deliberately. A struct
// would have to be widened for every field the contract grows, and a field
// this firmware does not understand yet would be silently dropped on the
// first SET_CONFIG round trip - which is worse than not implementing the
// command at all, because Studio would appear to save and then lose the
// setting. A document preserves what it does not understand.
#ifndef P4_CONFIG_STORE_H
#define P4_CONFIG_STORE_H

#include <stdbool.h>
#include <stdint.h>

#include "cJSON.h"
#include "esp_err.h"

/** Load from NVS, or build the defaults when nothing is stored. */
esp_err_t config_init(void);

/** The live config object. Borrowed - never freed or detached by the caller. */
const cJSON *config_get(void);

/** Increments on every accepted write, per the ConfigEnvelope contract. */
uint32_t config_revision(void);

/**
 * Deep-merge a patch into the live config and bump the revision.
 *
 * Merge, not replace: Studio sends the branch it changed, and replacing would
 * make a write to one field clear every other.
 */
esp_err_t config_merge(const cJSON *patch);

/** Persist the live config to NVS. */
esp_err_t config_save(void);

/** Restore the built-in defaults and persist them. */
esp_err_t config_reset(void);

/**
 * Read one integer by dotted path, e.g. "body.autoDimS".
 *
 * Returns `fallback` when the path is missing or not a number, so firmware
 * that reads a setting never has to care whether Studio has ever written it.
 */
int config_int(const char *path, int fallback);

/** Read one boolean by dotted path. */
bool config_bool(const char *path, bool fallback);

/** Read one string by dotted path. Returns `fallback` when absent. */
const char *config_str(const char *path, const char *fallback);

#endif
