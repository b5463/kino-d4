/*
 * Custom sounds on the camera: GET_SOUNDS, SOUND_BEGIN, SOUND_CHUNK,
 * SOUND_END, SOUND_READ, SOUND_DELETE. Clips are 16 kHz mono 16-bit WAV,
 * stored on the card, selectable as the shutter sound.
 *
 * The store is /sdcard/KINO/SOUNDS/<id>.WAV plus an <id>.JSON sidecar
 * carrying the name and duration a WAV header cannot. An upload writes
 * <id>.TMP and is renamed on SOUND_END, so a power cut mid-transfer leaves a
 * temp file the next boot deletes rather than a half-written clip that
 * SOUND_READ would serve as if it were whole.
 */
#ifndef P4_KDP_SOUNDS_H
#define P4_KDP_SOUNDS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cJSON.h"
#include "esp_err.h"
#include "kdp_module.h"

/** Once at boot, after the card is mounted. Failure is logged, never fatal. */
esp_err_t kdp_sounds_init(void);

/** What GET_CAPABILITIES reports as `customSounds`. */
bool kdp_sounds_capable(void);

/** One of the six sound commands. `req` is the parsed JSON body, or NULL;
 * `payload`/`payload_len` are the raw frame bytes, which SOUND_CHUNK needs
 * because its body is binary (u32 sessionId, u32 offset, data). Takes the
 * card lock itself for the commands that touch it. */
kdp_module_reply_t kdp_sounds_handle(uint8_t cmd, const cJSON *req, const uint8_t *payload,
                                     size_t payload_len);

/* For the SOUND settings screen: the custom clips on the card, in a stable
 * order, without the UI opening the directory itself. Built-in shutter sounds
 * are not listed here; the UI knows those five by name. */
#define KDP_SOUND_ID_MAX 24  /* "snd-" + slug, NUL included */
#define KDP_SOUND_NAME_MAX 33

/** Custom clips currently stored, 0..8. */
int kdp_sounds_count(void);

/** Clip `index` (0-based). False past the end. */
bool kdp_sounds_info(int index, char *id, size_t id_cap, char *name, size_t name_cap);

/**
 * Where `id`'s WAV lives on the card, for audio.c to open.
 *
 * False when the id is not a stored clip, so a shutterSound naming a deleted
 * or never-uploaded clip is answered here rather than by a failed fopen()
 * inside the playback path. Reads the in-RAM index only - no card access, no
 * lock, safe from the audio task. The caller still takes the card lock for
 * the read itself, and the file can be gone by then.
 */
bool kdp_sounds_path(const char *id, char *path, size_t cap);

#endif
