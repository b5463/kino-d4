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
 * after this. `host` is a time Studio set this session. `network` is an SNTP
 * answer, which the camera can only have in a build with the radio.
 *
 * ## Priority
 *
 * host > network > persisted > unset. A better source may correct the clock in
 * either direction; an automatic source at the same rank may only move it
 * forward. `pure_clock_adopt_action()` is that rule, host-tested, and the
 * reason it is not written twice.
 *
 * The network source exists for one job beyond metadata: TLS. A certificate
 * cannot be validated against a clock that is wrong by years, and disabling
 * verification to get past that is not an option — so
 * `clock_trustworthy_for_tls()` gates the HTTP client and the queue reports
 * the refusal instead of looping.
 */
#ifndef KINO_CLOCK_H
#define KINO_CLOCK_H

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

#include "esp_err.h"

typedef enum {
  CLOCK_UNSET = 0,  /* epoch base is boot; the reading is uptime, not a date */
  CLOCK_PERSISTED,  /* restored across a power cycle; a lower bound that drifts */
  CLOCK_NETWORK,    /* an SNTP server answered this session */
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

/**
 * Adopt a time from SNTP.
 *
 * Subject to the priority rule above, so this cannot overwrite a host-set
 * clock and cannot move an already-network clock backwards. Returns true when
 * the time was taken, which is also the moment TLS becomes permissible.
 *
 * `utc_offset_min` is not a parameter: SNTP carries UTC and no timezone, and
 * inventing one here would print a local time the camera has no basis for.
 * Whatever offset the host or NVS supplied is kept.
 */
bool clock_set_network(int64_t epoch_ms);

/**
 * True when the wall clock is worth validating a certificate against.
 *
 * Only `host` and `network` qualify. `persisted` is a lower bound that drifts
 * with however long the camera sat in a bag, and a certificate checked against
 * it fails or — worse — passes for the wrong reason.
 */
bool clock_trustworthy_for_tls(void);

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
