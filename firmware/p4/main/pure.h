/**
 * The parts of the P4 firmware that are arithmetic and string handling, with
 * no ESP-IDF dependency — so they can be compiled and tested on a workstation.
 *
 * Everything here was previously inline in `capture.c`, `storage.c`,
 * `thumb.c` or `clock.c`, where it could not be reached by a test: those files
 * pull in FreeRTOS, the JPEG codec, the PPA, SDMMC and NVS, and compiling any
 * of them on a host means shimming a driver stack to test a division.
 *
 * The two worst defects this firmware has shipped both lived in functions of
 * exactly this shape:
 *
 *   - `capture_quality_to_sensor()` mapped a 60..95 percentage onto a sensor
 *     scale where lower is better, and for a while did not: asking for the
 *     best quality produced the worst JPEG the sensor can make. Both numbers
 *     were in range for the other scale, so nothing could detect it.
 *   - `media_summary()` read META.JSON keys that had never existed, so every
 *     gallery listing reported every capture as a wiggle taken at the epoch,
 *     from fallbacks that looked like deliberate defaults.
 *
 * Neither is a hardware problem, neither needs a camera, and neither was
 * catchable by any test the repository had. That is what this module is for.
 * The callers keep their public APIs and delegate here, so there is exactly
 * one implementation of each rule.
 *
 * Rules for this file: C99, no ESP-IDF headers, no allocation, no I/O, no
 * globals. If something here needs any of those, it belongs in its own module.
 */
#ifndef P4_PURE_H
#define P4_PURE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

/**
 * Convert the host-facing quality percentage to the OV3660's scale.
 *
 * `jpegQuality` is documented 60..95 across the KDP contract and Studio's
 * sliders, where **higher is better**. `esp32-camera`'s `set_quality()` takes
 * **5..63, where lower is better**, and the camera node clamps to that.
 *
 * 60..95 maps onto 20..5. Both ends are deliberate: 5 is the best the driver
 * accepts, and quality numerically above 20 on this sensor produces visible
 * blocking on skin — the one subject this camera exists for.
 *
 * Returns 0 for "not specified", which the node reads as "keep your own".
 */
int pure_quality_to_sensor(int percent);

/**
 * Parse a "WIDTHxHEIGHT" resolution string.
 *
 * Strict: the whole string must be consumed, both dimensions must be present
 * and non-zero, and neither may exceed 4096. Returns false and leaves the
 * outputs untouched otherwise, so a caller can distinguish "did not
 * understand" from "understood as zero" — a zero would size a space
 * reservation to nothing, which is the one wrong answer here.
 */
bool pure_parse_resolution(const char *s, uint32_t *width, uint32_t *height);

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

/** Fixed costs a capture folder carries beyond its frames. */
#define PURE_RESERVE_THUMB_BYTES (64u * 1024u)
#define PURE_RESERVE_META_BYTES (8u * 1024u)
#define PURE_RESERVE_MARGIN_BYTES (1024u * 1024u)

/**
 * A conservative upper BOUND on what one capture will occupy — not an
 * estimate.
 *
 * An estimate that is usually right still lets a capture start that cannot
 * finish, and a capture that dies at frame three has already written frames
 * one and two. The bound is struck at 0.5 bytes per pixel per frame: observed
 * VGA q12 frames were 0.025-0.1 bpp, so this is several times the expected
 * size. It only ever matters on a nearly-full card, where being generous costs
 * nothing.
 *
 * `frames` is clamped to 1..4. A zero width or height reserves for the largest
 * frame the firmware advertises (2048x1536) rather than for nothing.
 */
uint64_t pure_capture_reserve_bytes(int frames, uint32_t width, uint32_t height);

/**
 * True when `name` is unmistakably a KINO capture directory name: an RFC 4122
 * v4 UUID in lowercase hex — 36 characters, dashes at 8/13/18/23.
 *
 * The orphan sweep deletes things, so this is a shape match on the entire
 * string rather than anything looser. A folder someone put on the card by hand
 * will not match, which is the intent.
 */
bool pure_is_capture_dirname(const char *name);

/* ------------------------------------------------------------------ */
/* Thumbnails                                                          */
/* ------------------------------------------------------------------ */

/**
 * The largest sixteenth that keeps a `w` x `h` picture inside `box_w` x
 * `box_h`.
 *
 * The PPA scales by n/16, so a 1600-wide frame reduces into a 320-wide box by
 * 3/16 and not by the 0.2 that would land on exactly 320 — it comes out 300
 * wide. Always rounds DOWN: rounding to nearest would overflow the box by a
 * few pixels, and the PPA would then write outside the destination.
 *
 * Returns 0 when the picture cannot fit even at 1/16, and when any dimension
 * is zero. 0 means "refuse" — it is NOT a ratio. Returning 1 in that case
 * (which an earlier version did) yields an output larger than the
 * destination, and the PPA writes outside the buffer it was handed.
 * Callers must treat 0 as "no thumbnail", which both current callers already
 * do by rejecting a zero output size.
 */
int pure_scale_sixteenths(uint32_t w, uint32_t h, uint32_t box_w, uint32_t box_h);

/* ------------------------------------------------------------------ */
/* Clock                                                              */
/* ------------------------------------------------------------------ */

/** The window a host-supplied epoch must fall in: 2020-01-01 .. 2100-01-01,
 * in milliseconds. Outside it, the value is a unit mix-up — seconds sent where
 * milliseconds were meant is the classic — and taking it would date every
 * later capture wrongly and persist that across boots. */
#define PURE_EPOCH_MS_MIN 1577836800000LL
#define PURE_EPOCH_MS_MAX 4102444800000LL

/** True when a host-supplied epoch is plausible enough to adopt. */
bool pure_epoch_plausible(int64_t epoch_ms);

/** Clamp a UTC offset to +/- 14 h, returning 0 for anything outside — the
 * device writes "+00:00" rather than guessing a timezone. */
int pure_clamp_utc_offset_min(int offset_min);

/** What clock_init() should do with the time it found. */
typedef enum {
  /** Neither source is usable. Captures are dated from boot until a host says
   * otherwise, and `clockSource` says `unset` so nothing downstream trusts it. */
  PURE_CLOCK_UNSET = 0,
  /** The system clock already holds the better time — leave it alone. */
  PURE_CLOCK_KEEP_SYSTEM,
  /** Push the persisted value into the system clock. */
  PURE_CLOCK_RESTORE_SAVED,
} pure_clock_action_t;

/**
 * Decide between a persisted time and whatever the system clock already reads.
 *
 * Split out here because it is the part worth testing and the only part with no
 * ESP-IDF in it. Two rules, and the second is the one that costs a bench cycle
 * if it is missing:
 *
 *   - A value outside 2020..2100 is not a time. It is a unit mix-up or a stale
 *     key, and adopting one now writes it into the *system* clock, where FAT
 *     timestamps and every capturedAt read it.
 *   - The system clock must never be moved backwards by a persisted value that
 *     is older than what it already reads. The RTC keeps running across a soft
 *     reset, so after a host has set the time, the system clock is the fresher
 *     of the two and NVS holds a snapshot from before the reboot.
 */
pure_clock_action_t pure_clock_restore_action(bool have_saved, int64_t saved_ms,
                                             int64_t system_now_ms);

/**
 * Format an instant as ISO 8601 with an explicit offset, e.g.
 * "2026-08-27T14:02:11+02:00".
 *
 * `epoch_ms` is UTC; `offset_min` is added before formatting so the printed
 * wall time is local, and the offset is appended so the instant stays
 * unambiguous. Always writes a syntactically valid timestamp — whether it
 * means anything is what `clockSource` is for.
 *
 * Self-contained civil-time arithmetic rather than gmtime_r, so the same code
 * runs on the host test and the device with no libc or timezone dependence.
 */
void pure_format_iso8601(int64_t epoch_ms, int offset_min, char *out, size_t cap);

/* ------------------------------------------------------------------ */
/* Wi-Fi credentials                                                  */
/* ------------------------------------------------------------------ */

/** 802.11 caps an SSID at 32 octets. */
#define PURE_SSID_MAX 32
/** WPA-PSK's own floor. Shorter is not a weak passphrase, it is not a
 * passphrase — wpa_supplicant will refuse it. */
#define PURE_WPA_PASSPHRASE_MIN 8
/** WPA-PSK's ceiling for the ASCII form. */
#define PURE_WPA_PASSPHRASE_MAX 63

/**
 * True when `ssid` is a usable SSID: 1..32 octets, no control characters.
 *
 * Control characters are rejected rather than sanitised. An SSID is compared
 * byte-for-byte against scan results and used as an NVS key suffix; silently
 * rewriting one produces a saved network that can never match the AP it was
 * saved for. Anything else — including invalid UTF-8 and emoji — is accepted,
 * because APs really are named that and the camera's job is to join them, not
 * to have opinions.
 */
bool pure_wifi_ssid_valid(const char *ssid);

/**
 * Whether a `NETWORK_SET` may be accepted, given what the host sent and what
 * is already stored.
 *
 * `keeps_stored` is the case that matters and the one an obvious
 * implementation gets wrong. `NETWORK_LIST` only ever hands the host a mask,
 * never the passphrase, so a host editing a saved network's `autoJoin` has
 * nothing to send back in `password`. An empty passphrase against a network
 * that already has one therefore means "keep it", not "set it to empty" —
 * and checking the length rule before that case makes the keep path
 * unreachable. The reference device has the same ordering, deliberately
 * (packages/test-fixtures/src/MockKinoDevice.ts, NETWORK_SET).
 *
 * `open` networks take no passphrase at all.
 */
bool pure_wifi_passphrase_ok(const char *passphrase, bool is_open, bool keeps_stored);

#endif
