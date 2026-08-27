/**
 * What the camera believes the time is, and how much that belief is worth.
 *
 * The D4 V1 has no RTC, no battery-backed clock and no network. It boots
 * knowing nothing about when it is. `kino.capture` requires `capturedAt`, so
 * every capture has to carry a timestamp — and a camera that has never been
 * told the time must not invent a plausible one, because a plausible wrong
 * timestamp is worse than an obviously wrong one. It survives import, sorts
 * into the wrong place in someone's roll, and is never questioned again.
 *
 * So the timestamp always travels with its source. `unset` means the epoch
 * base is this boot: the reading is 1970 plus uptime, which no consumer can
 * mistake for a real date. `persisted` is the last time the camera was told,
 * carried across a power cycle as a lower bound — the shot happened at or
 * after this. `host` is a time Studio set this session.
 */
#ifndef KINO_CLOCK_H
#define KINO_CLOCK_H

#include <stdint.h>
#include <stddef.h>

#include "esp_err.h"

typedef enum {
  CLOCK_UNSET = 0,  /* epoch base is boot; the reading is uptime, not a date */
  CLOCK_PERSISTED,  /* restored across a power cycle; a lower bound that drifts */
  CLOCK_HOST,       /* an attached host set it this session */
} clock_source_t;

/** Restores the persisted lower bound, if any. Safe to call before NVS data
 * exists; the clock then reports CLOCK_UNSET. */
esp_err_t clock_init(void);

/**
 * Adopt a host's wall clock.
 *
 * `utc_offset_min` is the host's offset from UTC so the camera can write a
 * local-time ISO string; pass 0 when the host did not say, which yields
 * "+00:00" — honest rather than a guessed timezone.
 */
void clock_set(int64_t epoch_ms, int utc_offset_min);

/** Milliseconds since the Unix epoch under the current belief. */
int64_t clock_now_ms(void);

clock_source_t clock_source(void);
const char *clock_source_str(void);

/** ISO 8601 with offset, e.g. "2026-08-27T14:02:11+02:00". Always writes a
 * syntactically valid timestamp; `clock_source_str()` says what it is worth. */
void clock_iso8601(char *out, size_t cap);

/**
 * Write the current reading to NVS so the next boot starts from it.
 *
 * Called when a capture is committed rather than on a timer: the useful
 * guarantee is "no capture is dated before an earlier one", and that only
 * needs a write when a capture actually happens. Skipped entirely while the
 * clock is UNSET — persisting uptime-since-1970 would turn a visibly wrong
 * clock into a persistently wrong one.
 */
void clock_persist(void);

#endif
